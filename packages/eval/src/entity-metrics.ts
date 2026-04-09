/**
 * Entity extraction metrics: Precision, Recall, F1 per entity type.
 *
 * Entity matching is case-insensitive, whitespace-normalized.
 * Metrics are computed per entity type (micro-average for overall).
 *
 * Relationship metrics live in `relationship-metrics.ts` (a separate
 * module so the entity-only file isn't muddled with relationship types).
 *
 * @see docs/specs/31_golden_test_set_segmentation_entities.spec.md §4.4
 * @see docs/functional-spec.md §15.2
 */

import type { ExtractedEntity } from '@mulder/pipeline';
import type { ExpectedEntity, PRF1 } from './types.js';

// ────────────────────────────────────────────────────────────
// Name normalization
// ────────────────────────────────────────────────────────────

/**
 * Normalize an entity name for comparison.
 * Lowercase, collapse whitespace, trim.
 */
export function normalizeEntityName(name: string): string {
	return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ────────────────────────────────────────────────────────────
// PRF1 computation helpers
// ────────────────────────────────────────────────────────────

/**
 * Compute F1 from precision and recall.
 * Returns 0.0 if both are 0.
 */
function computeF1(precision: number, recall: number): number {
	if (precision + recall === 0) return 0;
	return (2 * precision * recall) / (precision + recall);
}

/**
 * Compute precision, recall, and F1 from match counts.
 */
function computePRF1(matched: number, actualCount: number, expectedCount: number): PRF1 {
	const precision = actualCount > 0 ? matched / actualCount : 0;
	const recall = expectedCount > 0 ? matched / expectedCount : 0;
	const f1 = computeF1(precision, recall);
	return { precision, recall, f1 };
}

// ────────────────────────────────────────────────────────────
// Entity precision / recall / F1
// ────────────────────────────────────────────────────────────

/** Per-type metrics result. */
export interface PerTypeMetrics {
	byType: Record<string, PRF1>;
	overall: PRF1;
}

/**
 * Compute entity precision, recall, and F1 per entity type.
 *
 * Groups expected and actual entities by type, then matches by
 * normalized name (case-insensitive, whitespace-normalized).
 *
 * Overall is micro-averaged across all types.
 */
export function computeEntityPrecisionRecallF1(expected: ExpectedEntity[], actual: ExtractedEntity[]): PerTypeMetrics {
	// Collect all types from both expected and actual
	const allTypes = new Set<string>();
	for (const e of expected) allTypes.add(e.type);
	for (const a of actual) allTypes.add(a.type);

	const byType: Record<string, PRF1> = {};
	let totalMatched = 0;
	let totalActual = 0;
	let totalExpected = 0;

	for (const type of allTypes) {
		const expectedOfType = expected.filter((e) => e.type === type);
		const actualOfType = actual.filter((a) => a.type === type);

		// Normalize expected names
		const expectedNames = expectedOfType.map((e) => normalizeEntityName(e.name));
		// Normalize actual names
		const actualNames = actualOfType.map((a) => normalizeEntityName(a.name));

		// Count matches (each expected name can only match one actual name)
		const matchedActualIndices = new Set<number>();
		let matched = 0;

		for (const expName of expectedNames) {
			for (let i = 0; i < actualNames.length; i++) {
				if (matchedActualIndices.has(i)) continue;
				if (expName === actualNames[i]) {
					matched++;
					matchedActualIndices.add(i);
					break;
				}
			}
		}

		byType[type] = computePRF1(matched, actualOfType.length, expectedOfType.length);
		totalMatched += matched;
		totalActual += actualOfType.length;
		totalExpected += expectedOfType.length;
	}

	const overall = computePRF1(totalMatched, totalActual, totalExpected);

	return { byType, overall };
}
