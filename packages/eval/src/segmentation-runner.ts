/**
 * Segmentation eval runner: loads golden segmentation annotations, compares
 * against segment fixture output, and produces aggregate results.
 *
 * @see docs/specs/31_golden_test_set_segmentation_entities.spec.md §4.5
 * @see docs/functional-spec.md §15.1
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import { computeBoundaryAccuracy, loadActualSegments } from './segmentation-metrics.js';
import type { SegmentationEvalResult, SegmentationGolden, SegmentationMetricResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Golden set loading
// ────────────────────────────────────────────────────────────

/**
 * Validate that a parsed JSON object has the required SegmentationGolden shape.
 * Throws MulderEvalError with GOLDEN_INVALID code if validation fails.
 */
function validateSegmentationGolden(data: unknown, filePath: string): SegmentationGolden {
	if (typeof data !== 'object' || data === null) {
		throw new MulderEvalError(`Golden file is not a JSON object: ${filePath}`, EVAL_ERROR_CODES.GOLDEN_INVALID, {
			context: { filePath },
		});
	}

	const obj = data as Record<string, unknown>;

	if (typeof obj.sourceSlug !== 'string') {
		throw new MulderEvalError(
			`Golden file missing or invalid 'sourceSlug': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (typeof obj.totalPages !== 'number' || obj.totalPages < 1) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'totalPages': ${filePath}`,
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

	if (typeof obj.expectedSegmentCount !== 'number' || obj.expectedSegmentCount < 0) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'expectedSegmentCount': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	if (!Array.isArray(obj.expectedSegments)) {
		throw new MulderEvalError(
			`Golden file missing or invalid 'expectedSegments': ${filePath}`,
			EVAL_ERROR_CODES.GOLDEN_INVALID,
			{ context: { filePath } },
		);
	}

	for (const seg of obj.expectedSegments) {
		const s = seg as Record<string, unknown>;
		if (typeof s.title !== 'string' || typeof s.pageStart !== 'number' || typeof s.pageEnd !== 'number') {
			throw new MulderEvalError(
				`Golden file has invalid segment entry (missing title, pageStart, or pageEnd): ${filePath}`,
				EVAL_ERROR_CODES.GOLDEN_INVALID,
				{ context: { filePath, segment: seg } },
			);
		}
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

	return data as SegmentationGolden;
}

/**
 * Load all segmentation golden annotations from a directory.
 *
 * Reads all *.json files, parses and validates structure,
 * returns sorted by sourceSlug.
 */
export function loadSegmentationGoldenSet(goldenDir: string): SegmentationGolden[] {
	if (!existsSync(goldenDir)) {
		throw new MulderEvalError(
			`Segmentation golden directory does not exist: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json'));

	if (files.length === 0) {
		throw new MulderEvalError(
			`Segmentation golden directory contains no JSON files: ${goldenDir}`,
			EVAL_ERROR_CODES.GOLDEN_DIR_EMPTY,
			{ context: { goldenDir } },
		);
	}

	const goldens: SegmentationGolden[] = [];

	for (const file of files) {
		const filePath = join(goldenDir, file);
		const raw = readFileSync(filePath, 'utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new MulderEvalError(
				`Failed to parse segmentation golden JSON: ${filePath}`,
				EVAL_ERROR_CODES.GOLDEN_INVALID,
				{ context: { filePath }, cause },
			);
		}

		goldens.push(validateSegmentationGolden(parsed, filePath));
	}

	goldens.sort((a, b) => a.sourceSlug.localeCompare(b.sourceSlug));
	return goldens;
}

// ────────────────────────────────────────────────────────────
// Eval runner
// ────────────────────────────────────────────────────────────

/**
 * Run segmentation eval: load golden set, compare against segment fixtures,
 * produce aggregate results.
 *
 * @param goldenDir - Path to eval/golden/segmentation/
 * @param segmentsDir - Path to fixtures/segments/
 * @returns Full eval result with per-document metrics and summary
 */
export function runSegmentationEval(goldenDir: string, segmentsDir: string): SegmentationEvalResult {
	const goldens = loadSegmentationGoldenSet(goldenDir);
	const documents: SegmentationMetricResult[] = [];

	for (const golden of goldens) {
		const actual = loadActualSegments(segmentsDir, golden.sourceSlug);
		const boundaryAccuracy = computeBoundaryAccuracy(golden.expectedSegments, actual);
		const segmentCountExact = actual.length === golden.expectedSegmentCount;

		documents.push({
			sourceSlug: golden.sourceSlug,
			difficulty: golden.difficulty,
			boundaryAccuracy,
			segmentCountExact,
			actualSegmentCount: actual.length,
			expectedSegmentCount: golden.expectedSegmentCount,
		});
	}

	// Compute summary
	const totalDocuments = documents.length;
	const avgBoundaryAccuracy =
		totalDocuments > 0 ? documents.reduce((sum, d) => sum + d.boundaryAccuracy, 0) / totalDocuments : 0;
	const segmentCountExactRatio =
		totalDocuments > 0 ? documents.filter((d) => d.segmentCountExact).length / totalDocuments : 0;

	// Group by difficulty
	const byDifficulty: Record<string, { avgBoundaryAccuracy: number; count: number }> = {};
	for (const doc of documents) {
		const existing = byDifficulty[doc.difficulty];
		if (existing) {
			existing.avgBoundaryAccuracy += doc.boundaryAccuracy;
			existing.count += 1;
		} else {
			byDifficulty[doc.difficulty] = {
				avgBoundaryAccuracy: doc.boundaryAccuracy,
				count: 1,
			};
		}
	}

	// Convert sums to averages
	for (const stats of Object.values(byDifficulty)) {
		stats.avgBoundaryAccuracy = stats.avgBoundaryAccuracy / stats.count;
	}

	return {
		timestamp: new Date().toISOString(),
		documents,
		summary: {
			totalDocuments,
			avgBoundaryAccuracy,
			segmentCountExactRatio,
			byDifficulty,
		},
	};
}
