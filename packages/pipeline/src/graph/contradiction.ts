/**
 * Contradiction detection module — fast attribute-diff comparison.
 *
 * Compares entity attributes across stories to flag potential contradictions.
 * No LLM calls — pure string/value comparison. The Analyze step (v2.0)
 * resolves flagged contradictions via Gemini.
 *
 * @see docs/specs/35_graph_step.spec.md §4.4
 * @see docs/functional-spec.md §2.7 (contradiction flagging)
 */

import { findEntitiesByStoryId } from '@mulder/core';
import type pg from 'pg';
import type { ContradictionCandidate } from './types.js';

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

interface StoryEntityAttributes {
	storyId: string;
	entityId: string;
	attributes: Record<string, unknown>;
}

/**
 * Loads attributes for entities in the same canonical group from other stories.
 *
 * A "canonical group" is the set of entity rows that represent the same
 * real-world entity, linked via `canonical_id`. This includes:
 * - The canonical entity itself (where `canonical_id IS NULL` or is the entity)
 * - All entities whose `canonical_id` points to the same canonical entity
 *
 * We compare attributes across entities in the same canonical group that
 * appear in different stories to detect contradictions.
 */
async function loadCanonicalGroupAttributesAcrossStories(
	pool: pg.Pool,
	entityId: string,
	canonicalId: string | null,
	excludeStoryId: string,
): Promise<StoryEntityAttributes[]> {
	// Determine the canonical root: if this entity has a canonical_id, use it;
	// otherwise this entity IS the canonical root.
	const canonicalRoot = canonicalId ?? entityId;

	// Find all entities in the same canonical group that appear in other stories.
	// The group includes:
	// 1. The canonical root entity itself (id = canonicalRoot)
	// 2. All entities whose canonical_id = canonicalRoot
	// We exclude the current story to avoid self-comparison.
	const result = await pool.query<{
		story_id: string;
		entity_id: string;
		attributes: Record<string, unknown>;
	}>(
		`SELECT se.story_id, e.id as entity_id, e.attributes
		 FROM story_entities se
		 JOIN entities e ON e.id = se.entity_id
		 WHERE (e.id = $1 OR e.canonical_id = $1)
		   AND se.story_id != $2`,
		[canonicalRoot, excludeStoryId],
	);

	return result.rows.map((row) => ({
		storyId: row.story_id,
		entityId: row.entity_id,
		attributes: row.attributes ?? {},
	}));
}

/**
 * Normalizes a value for comparison.
 * Returns null for empty/null values (not worth flagging).
 */
function normalizeValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length === 0 ? null : trimmed;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	// For objects/arrays, stringify for comparison
	return JSON.stringify(value);
}

/**
 * Compares two attribute objects and returns differing keys.
 * Only flags keys where both values are non-null and different.
 */
function findAttributeDiffs(
	attrsA: Record<string, unknown>,
	attrsB: Record<string, unknown>,
): Array<{ attribute: string; valueA: string; valueB: string }> {
	const diffs: Array<{ attribute: string; valueA: string; valueB: string }> = [];

	// Check all keys in A against B
	for (const key of Object.keys(attrsA)) {
		const valueA = normalizeValue(attrsA[key]);
		const valueB = normalizeValue(attrsB[key]);

		// Only flag if both non-null and different
		if (valueA !== null && valueB !== null && valueA !== valueB) {
			diffs.push({ attribute: key, valueA, valueB });
		}
	}

	return diffs;
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Detects potential contradictions for entities in the given story.
 *
 * For each entity linked to the story:
 * 1. Load the entity's attributes as seen in this story
 * 2. Find other entities in the same canonical group (linked via canonical_id)
 *    that appear in other stories
 * 3. Compare attributes — if values differ for the same key, flag it
 *
 * Canonical groups are central to contradiction detection: different entity
 * rows with the same canonical_id represent the same real-world entity as
 * observed from different stories. When their attributes conflict, that is
 * a potential contradiction.
 *
 * @param pool - PostgreSQL connection pool
 * @param storyId - The story to check for contradictions
 * @returns Array of contradiction candidates
 */
export async function detectContradictions(pool: pg.Pool, storyId: string): Promise<ContradictionCandidate[]> {
	// 1. Load entities for this story with their attributes
	const entities = await findEntitiesByStoryId(pool, storyId);
	if (entities.length === 0) {
		return [];
	}

	const contradictions: ContradictionCandidate[] = [];

	// 2. For each entity, check for attribute contradictions across stories.
	//    We look for entities in the same canonical group (linked via canonical_id)
	//    that appear in other stories with different attribute values.
	for (const entity of entities) {
		// Load attributes from other entities in the same canonical group
		// that appear in different stories
		const otherMentions = await loadCanonicalGroupAttributesAcrossStories(pool, entity.id, entity.canonicalId, storyId);

		if (otherMentions.length === 0) {
			continue;
		}

		// Current entity attributes (as enriched from this story and merged)
		const currentAttrs = entity.attributes;

		// Compare with each other story's version
		for (const mention of otherMentions) {
			const diffs = findAttributeDiffs(currentAttrs, mention.attributes);

			for (const diff of diffs) {
				contradictions.push({
					entityId: entity.id,
					storyIdA: storyId,
					storyIdB: mention.storyId,
					attribute: diff.attribute,
					valueA: diff.valueA,
					valueB: diff.valueB,
				});
			}
		}
	}

	return contradictions;
}
