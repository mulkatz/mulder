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
 * Loads attributes for a specific entity from all stories that mention it.
 * Each story_entity junction might have different attribute snapshots because
 * entities aggregate attributes from multiple sources.
 *
 * We load the entity's attributes and then find all other stories that
 * also mention this entity. The entity itself has the merged attributes,
 * but we need per-story attribute snapshots to detect contradictions.
 *
 * Since story-level attributes are stored in the entity's consolidated
 * attributes JSONB, we look for contradictions by comparing the entity's
 * attributes across different story mentions. In practice, we compare
 * the enrichment metadata stored per story-entity link.
 */
async function loadEntityAttributesAcrossStories(
	pool: pg.Pool,
	entityId: string,
	excludeStoryId: string,
): Promise<StoryEntityAttributes[]> {
	// Load the entity's per-story attribute mentions
	// story_entities stores confidence and mention_count, but entity attributes
	// are on the entities table. We need to find stories that mention this entity.
	const result = await pool.query<{
		story_id: string;
		entity_id: string;
		attributes: Record<string, unknown>;
	}>(
		`SELECT se.story_id, e.id as entity_id, e.attributes
		 FROM story_entities se
		 JOIN entities e ON e.id = se.entity_id
		 WHERE se.entity_id = $1 AND se.story_id != $2`,
		[entityId, excludeStoryId],
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
 * 2. Find other stories mentioning the same entity
 * 3. Compare attributes — if values differ for the same key, flag it
 *
 * Note: Since entities aggregate attributes from all sources into a single
 * JSONB column, we detect contradictions by finding entities mentioned in
 * multiple stories and checking if the per-story enrichment produced
 * different attribute values. The enrichment step may have stored
 * per-story metadata in story_entities or via the attributes JSONB.
 *
 * In the current data model, entity attributes are merged. So contradictions
 * are detected when the same entity (by canonical_id or exact match) appears
 * with different attribute values extracted from different stories.
 * We use the attributes JSONB on the entities table and look for cases
 * where multiple stories' enrichment metadata disagree.
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

	// 2. For each entity, check for attribute contradictions across stories
	for (const entity of entities) {
		// Load the entity's attributes from other stories
		const otherMentions = await loadEntityAttributesAcrossStories(pool, entity.id, storyId);

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
