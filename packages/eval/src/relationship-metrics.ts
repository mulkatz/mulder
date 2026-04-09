/**
 * Relationship extraction metrics: Precision, Recall, F1.
 *
 * Relationships are matched by `(sourceEntity, targetEntity, relationshipType)`
 * tuple. Entity names are normalized via the same case-insensitive,
 * whitespace-collapsed strategy as the entity metrics.
 *
 * @see docs/specs/31_golden_test_set_segmentation_entities.spec.md §4.4
 * @see docs/functional-spec.md §15.2
 */

import type { ExtractedRelationship } from '@mulder/pipeline';
import { normalizeEntityName } from './entity-metrics.js';
import type { ExpectedRelationship, PRF1 } from './types.js';

/**
 * Compute relationship precision, recall, and F1.
 *
 * Matches by `(sourceEntity, targetEntity, relationshipType)` tuple.
 * Entity names are normalized (case-insensitive, whitespace-collapsed).
 */
export function computeRelationshipPrecisionRecallF1(
	expected: ExpectedRelationship[],
	actual: ExtractedRelationship[],
): PRF1 {
	const normalizeKey = (source: string, target: string, relType: string): string =>
		`${normalizeEntityName(source)}|${normalizeEntityName(target)}|${relType.toLowerCase()}`;

	const expectedKeys = expected.map((r) => normalizeKey(r.sourceEntity, r.targetEntity, r.relationshipType));
	const actualKeys = actual.map((r) => normalizeKey(r.source_entity, r.target_entity, r.relationship_type));

	const matchedActualIndices = new Set<number>();
	let matched = 0;

	for (const expKey of expectedKeys) {
		for (let i = 0; i < actualKeys.length; i++) {
			if (matchedActualIndices.has(i)) continue;
			if (expKey === actualKeys[i]) {
				matched++;
				matchedActualIndices.add(i);
				break;
			}
		}
	}

	const precision = actual.length > 0 ? matched / actual.length : 0;
	const recall = expected.length > 0 ? matched / expected.length : 0;
	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	return { precision, recall, f1 };
}
