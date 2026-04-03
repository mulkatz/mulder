/**
 * Segmentation metrics: Boundary Accuracy and Segment Count Accuracy.
 *
 * Boundary Accuracy measures how well actual segment boundaries match
 * expected golden boundaries. Matching uses page range overlap to find
 * the best actual segment for each expected segment.
 *
 * @see docs/specs/31_golden_test_set_segmentation_entities.spec.md §4.3
 * @see docs/functional-spec.md §15.2
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVAL_ERROR_CODES, MulderEvalError } from './errors.js';
import type { ActualSegment, ExpectedSegment } from './types.js';

// ────────────────────────────────────────────────────────────
// Actual segment loading
// ────────────────────────────────────────────────────────────

/**
 * Load actual segments from fixture metadata files.
 *
 * Reads all *.meta.json from segmentsDir/{sourceSlug}/,
 * parses and returns sorted by pageStart.
 */
export function loadActualSegments(segmentsDir: string, sourceSlug: string): ActualSegment[] {
	const slugDir = join(segmentsDir, sourceSlug);

	if (!existsSync(slugDir)) {
		throw new MulderEvalError(`Segment fixture directory not found: ${slugDir}`, EVAL_ERROR_CODES.FIXTURE_NOT_FOUND, {
			context: { slugDir, sourceSlug },
		});
	}

	const metaFiles = readdirSync(slugDir).filter((f) => f.endsWith('.meta.json'));

	if (metaFiles.length === 0) {
		throw new MulderEvalError(
			`No .meta.json files found in segment fixture directory: ${slugDir}`,
			EVAL_ERROR_CODES.FIXTURE_NOT_FOUND,
			{ context: { slugDir, sourceSlug } },
		);
	}

	const segments: ActualSegment[] = [];

	for (const file of metaFiles) {
		const filePath = join(slugDir, file);
		const raw = readFileSync(filePath, 'utf-8');

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new MulderEvalError(
				`Failed to parse segment metadata: ${filePath}`,
				EVAL_ERROR_CODES.SEGMENT_META_PARSE_ERROR,
				{ context: { filePath }, cause },
			);
		}

		const obj = parsed as Record<string, unknown>;
		if (typeof obj.title !== 'string' || typeof obj.pageStart !== 'number' || typeof obj.pageEnd !== 'number') {
			throw new MulderEvalError(
				`Segment metadata missing required fields (title, pageStart, pageEnd): ${filePath}`,
				EVAL_ERROR_CODES.SEGMENT_META_PARSE_ERROR,
				{ context: { filePath } },
			);
		}

		segments.push({
			title: obj.title as string,
			pageStart: obj.pageStart as number,
			pageEnd: obj.pageEnd as number,
			category: typeof obj.category === 'string' ? (obj.category as string) : 'unknown',
		});
	}

	segments.sort((a, b) => a.pageStart - b.pageStart);
	return segments;
}

// ────────────────────────────────────────────────────────────
// Boundary accuracy computation
// ────────────────────────────────────────────────────────────

/**
 * Compute page range overlap between two segments.
 * Returns the number of overlapping pages.
 */
function pageOverlap(a: { pageStart: number; pageEnd: number }, b: { pageStart: number; pageEnd: number }): number {
	const overlapStart = Math.max(a.pageStart, b.pageStart);
	const overlapEnd = Math.min(a.pageEnd, b.pageEnd);
	return Math.max(0, overlapEnd - overlapStart + 1);
}

/**
 * Compute Boundary Accuracy between expected and actual segments.
 *
 * For each expected segment, find the best-matching actual segment
 * by page range overlap. Then score:
 * - 1.0 if both pageStart AND pageEnd match exactly
 * - 0.5 if one of pageStart/pageEnd matches
 * - 0.0 if neither matches
 *
 * Unmatched expected segments score 0.0.
 * If no expected segments, returns 1.0.
 *
 * @returns Average score across all expected segments (0.0 to 1.0)
 */
export function computeBoundaryAccuracy(expected: ExpectedSegment[], actual: ActualSegment[]): number {
	if (expected.length === 0) {
		return 1.0;
	}

	if (actual.length === 0) {
		return 0.0;
	}

	// Track which actual segments have been matched to avoid double-matching
	const matchedActualIndices = new Set<number>();
	let totalScore = 0;

	for (const exp of expected) {
		let bestOverlap = 0;
		let bestIndex = -1;

		for (let i = 0; i < actual.length; i++) {
			if (matchedActualIndices.has(i)) continue;

			const overlap = pageOverlap(exp, actual[i]);
			if (overlap > bestOverlap) {
				bestOverlap = overlap;
				bestIndex = i;
			}
		}

		if (bestIndex === -1) {
			// No matching actual segment — score 0.0
			continue;
		}

		matchedActualIndices.add(bestIndex);
		const matched = actual[bestIndex];

		const startMatch = exp.pageStart === matched.pageStart;
		const endMatch = exp.pageEnd === matched.pageEnd;

		if (startMatch && endMatch) {
			totalScore += 1.0;
		} else if (startMatch || endMatch) {
			totalScore += 0.5;
		}
		// else: neither match → 0.0 (implicit)
	}

	return totalScore / expected.length;
}
