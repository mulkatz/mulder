/**
 * Eval runner: loads golden annotations, compares against extraction output,
 * and produces aggregate results.
 *
 * @see docs/specs/21_golden_test_set_extraction.spec.md §4.4
 * @see docs/functional-spec.md §15.1
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayoutDocument } from '@mulder/pipeline';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import { computeCER, computeWER, normalizeWhitespace } from './extraction-metrics.js';
import type { DifficultyStats, ExtractionEvalResult, ExtractionGolden, ExtractionMetricResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Golden set loading
// ────────────────────────────────────────────────────────────

/**
 * Validate that a parsed JSON object has the required ExtractionGolden shape.
 * Throws MulderEvalError with GOLDEN_INVALID code if validation fails.
 */
function validateGolden(data: unknown, filePath: string): ExtractionGolden {
	if (typeof data !== 'object' || data === null) {
		throw new MulderEvalError(`Golden file is not a JSON object: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
			context: { filePath },
		});
	}

	const obj = data as Record<string, unknown>;

	const requiredStrings = ['sourceSlug', 'expectedText'] as const;
	for (const field of requiredStrings) {
		if (typeof obj[field] !== 'string') {
			throw new MulderEvalError(
				`Golden file missing or invalid '${field}': ${filePath}`,
				EVAL_ERROR_CODES.GOLDEN_INVALID,
				{ context: { filePath, field } },
			);
		}
	}

	if (typeof obj.pageNumber !== 'number' || obj.pageNumber < 1) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'pageNumber': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	const validDifficulties = ['simple', 'moderate', 'complex'];
	if (typeof obj.difficulty !== 'string' || !validDifficulties.includes(obj.difficulty)) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'difficulty': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath, value: obj.difficulty } },
		);
	}

	if (!Array.isArray(obj.languages) || obj.languages.length === 0) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'languages': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (typeof obj.annotation !== 'object' || obj.annotation === null) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'annotation': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	const annotation = obj.annotation as Record<string, unknown>;
	if (typeof annotation.author !== 'string' || typeof annotation.date !== 'string') {
		throw new MulderEvalError(
			`Golden file 'annotation' missing 'author' or 'date': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	return data as ExtractionGolden;
}

/**
 * Load all golden annotations from a directory.
 *
 * Reads all *.json files, parses and validates structure,
 * returns sorted by sourceSlug + pageNumber.
 */
export function loadGoldenSet(goldenDir: string): ExtractionGolden[] {
	if (!existsSync(goldenDir)) {
		throw new MulderEvalError(`Golden directory does not exist: ${goldenDir}`, EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY, {
			context: { goldenDir },
		});
	}

	const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json'));

	if (files.length === 0) {
		throw new MulderEvalError(
			`Golden directory contains no JSON files: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const goldens: ExtractionGolden[] = [];

	for (const file of files) {
		const filePath = join(goldenDir, file);
		const raw = readFileSync(filePath, 'utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new MulderEvalError(`Failed to parse golden JSON: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
				context: { filePath },
				cause,
			});
		}

		goldens.push(validateGolden(parsed, filePath));
	}

	// Sort by sourceSlug, then pageNumber
	goldens.sort((a, b) => {
		const slugCmp = a.sourceSlug.localeCompare(b.sourceSlug);
		if (slugCmp !== 0) return slugCmp;
		return a.pageNumber - b.pageNumber;
	});

	return goldens;
}

// ────────────────────────────────────────────────────────────
// Layout text extraction
// ────────────────────────────────────────────────────────────

/**
 * Load a layout.json file and extract text for a specific page.
 */
function extractPageText(extractedDir: string, sourceSlug: string, pageNumber: number): string {
	const layoutPath = join(extractedDir, sourceSlug, 'layout.json');

	if (!existsSync(layoutPath)) {
		throw new MulderEvalError(`Fixture layout.json not found: ${layoutPath}`, EVAL_ERROR_CODES.FIXTURE_NOT_FOUND, {
			context: { layoutPath, sourceSlug },
		});
	}

	let layout: LayoutDocument;
	try {
		const raw = readFileSync(layoutPath, 'utf-8');
		layout = JSON.parse(raw) as LayoutDocument;
	} catch (cause) {
		throw new MulderEvalError(`Failed to parse layout.json: ${layoutPath}`, EVAL_ERROR_CODES.LAYOUT_PARSE_ERROR, {
			context: { layoutPath, sourceSlug },
			cause,
		});
	}

	const page = layout.pages.find((p) => p.pageNumber === pageNumber);
	if (!page) {
		throw new MulderEvalError(
			`Page ${pageNumber} not found in layout.json for ${sourceSlug}`,
			EVAL_ERROR_CODES.PAGE_NOT_FOUND,
			{
				context: {
					sourceSlug,
					pageNumber,
					availablePages: layout.pages.map((p) => p.pageNumber),
				},
			},
		);
	}

	return page.text;
}

// ────────────────────────────────────────────────────────────
// Eval runner
// ────────────────────────────────────────────────────────────

/**
 * Run extraction eval: load golden set, compare against extraction output,
 * produce aggregate results.
 *
 * @param goldenDir - Path to eval/golden/extraction/
 * @param extractedDir - Path to fixtures/extracted/
 * @returns Full eval result with per-page metrics and summary
 */
export function runExtractionEval(goldenDir: string, extractedDir: string): ExtractionEvalResult {
	const goldens = loadGoldenSet(goldenDir);
	const pages: ExtractionMetricResult[] = [];

	for (const golden of goldens) {
		const actualText = extractPageText(extractedDir, golden.sourceSlug, golden.pageNumber);
		const expectedNorm = normalizeWhitespace(golden.expectedText);

		const cer = computeCER(golden.expectedText, actualText);
		const wer = computeWER(golden.expectedText, actualText);

		pages.push({
			sourceSlug: golden.sourceSlug,
			pageNumber: golden.pageNumber,
			difficulty: golden.difficulty,
			cer,
			wer,
			charCount: expectedNorm.length,
			wordCount: expectedNorm.length > 0 ? expectedNorm.split(' ').length : 0,
		});
	}

	// Compute summary
	const totalPages = pages.length;
	const avgCer = totalPages > 0 ? pages.reduce((sum, p) => sum + p.cer, 0) / totalPages : 0;
	const avgWer = totalPages > 0 ? pages.reduce((sum, p) => sum + p.wer, 0) / totalPages : 0;
	const maxCer = totalPages > 0 ? Math.max(...pages.map((p) => p.cer)) : 0;
	const maxWer = totalPages > 0 ? Math.max(...pages.map((p) => p.wer)) : 0;

	// Group by difficulty
	const byDifficulty: Record<string, DifficultyStats> = {};
	for (const page of pages) {
		const existing = byDifficulty[page.difficulty];
		if (existing) {
			existing.avgCer += page.cer;
			existing.avgWer += page.wer;
			existing.count += 1;
		} else {
			byDifficulty[page.difficulty] = {
				avgCer: page.cer,
				avgWer: page.wer,
				count: 1,
			};
		}
	}

	// Convert sums to averages
	for (const stats of Object.values(byDifficulty)) {
		stats.avgCer = stats.avgCer / stats.count;
		stats.avgWer = stats.avgWer / stats.count;
	}

	return {
		timestamp: new Date().toISOString(),
		pages,
		summary: {
			totalPages,
			avgCer,
			avgWer,
			maxCer,
			maxWer,
			byDifficulty,
		},
	};
}
