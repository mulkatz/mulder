/**
 * Corroboration module — dedup-aware source counting for entities.
 *
 * Calculates corroboration scores for entities affected by the current story.
 * Stories linked by DUPLICATE_OF edges are collapsed to one source for counting.
 *
 * @see docs/specs/35_graph_step.spec.md §4.3
 * @see docs/functional-spec.md §2.7 (corroboration scoring)
 */

import type { DeduplicationConfig } from '@mulder/core';
import { findEntitiesByStoryId, updateEntity } from '@mulder/core';
import type pg from 'pg';
import type { CorroborationResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

interface StorySource {
	storyId: string;
	sourceId: string;
}

/**
 * For a given entity, loads all stories it appears in along with
 * their source_id values from the stories table.
 */
async function loadStorySourcesForEntity(pool: pg.Pool, entityId: string): Promise<StorySource[]> {
	const result = await pool.query<{ story_id: string; source_id: string }>(
		`SELECT se.story_id, s.source_id
		 FROM story_entities se
		 JOIN stories s ON s.id = se.story_id
		 WHERE se.entity_id = $1`,
		[entityId],
	);
	return result.rows.map((row) => ({
		storyId: row.story_id,
		sourceId: row.source_id,
	}));
}

/**
 * Loads DUPLICATE_OF edges that link any of the given story IDs.
 * Returns pairs of story IDs that are duplicates.
 */
async function loadDuplicateEdges(
	pool: pg.Pool,
	storyIds: string[],
): Promise<Array<{ storyIdA: string; storyIdB: string }>> {
	if (storyIds.length === 0) return [];

	// Find DUPLICATE_OF edges where the story_id (origin) or the linked story
	// is within our set. The edge's source_entity_id and target_entity_id are
	// used to link stories via a synthetic entity, but we store duplicate edges
	// with storyIdA/storyIdB in the attributes.
	const result = await pool.query<{ attributes: Record<string, unknown> }>(
		`SELECT attributes FROM entity_edges
		 WHERE edge_type = 'DUPLICATE_OF'
		   AND (
			 attributes->>'storyIdA' = ANY($1)
			 OR attributes->>'storyIdB' = ANY($1)
		   )`,
		[storyIds],
	);

	return result.rows
		.map((row) => ({
			storyIdA: String(row.attributes?.storyIdA ?? ''),
			storyIdB: String(row.attributes?.storyIdB ?? ''),
		}))
		.filter((pair) => pair.storyIdA !== '' && pair.storyIdB !== '');
}

/**
 * Computes the number of independent sources for an entity,
 * collapsing duplicate stories to one source.
 *
 * Algorithm:
 * 1. Group stories by source_id
 * 2. If two stories from different sources are linked by DUPLICATE_OF,
 *    collapse them to one source for counting (union-find)
 * 3. Return count of unique source groups
 */
function computeIndependentSourceCount(
	storySources: StorySource[],
	duplicatePairs: Array<{ storyIdA: string; storyIdB: string }>,
	dedupFilter: boolean,
): number {
	if (storySources.length === 0) return 0;

	// Map each story to its source
	const storyToSource = new Map<string, string>();
	for (const ss of storySources) {
		storyToSource.set(ss.storyId, ss.sourceId);
	}

	// Simple union-find on source IDs
	const parent = new Map<string, string>();
	function find(x: string): string {
		let root = x;
		let nextRoot = parent.get(root);
		while (nextRoot !== undefined && nextRoot !== root) {
			root = nextRoot;
			nextRoot = parent.get(root);
		}
		// Path compression
		let current = x;
		while (current !== root) {
			const next = parent.get(current) ?? current;
			parent.set(current, root);
			current = next;
		}
		return root;
	}
	function union(a: string, b: string): void {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA !== rootB) {
			parent.set(rootA, rootB);
		}
	}

	// Initialize each source as its own root
	const allSources = new Set<string>();
	for (const ss of storySources) {
		allSources.add(ss.sourceId);
		parent.set(ss.sourceId, ss.sourceId);
	}

	// Apply dedup filter: merge sources whose stories are duplicates
	if (dedupFilter) {
		for (const pair of duplicatePairs) {
			const sourceA = storyToSource.get(pair.storyIdA);
			const sourceB = storyToSource.get(pair.storyIdB);
			if (sourceA && sourceB && sourceA !== sourceB) {
				union(sourceA, sourceB);
			}
		}
	}

	// Count unique source groups
	const uniqueRoots = new Set<string>();
	for (const source of allSources) {
		uniqueRoots.add(find(source));
	}

	return uniqueRoots.size;
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Updates corroboration scores for all entities linked to the given story.
 *
 * For each entity:
 * 1. Finds all stories mentioning it
 * 2. Groups by source_id
 * 3. Collapses DUPLICATE_OF-linked stories to one source
 * 4. Computes independent_source_count and corroboration_score
 * 5. Updates the entity record
 *
 * @param pool - PostgreSQL connection pool
 * @param storyId - The story whose entities should be updated
 * @param config - Deduplication config (for min_independent_sources and filter settings)
 * @returns Array of corroboration results per entity
 */
export async function updateCorroborationScores(
	pool: pg.Pool,
	storyId: string,
	config: DeduplicationConfig,
): Promise<CorroborationResult[]> {
	const minIndependentSources = config.min_independent_sources;
	const dedupFilter = config.corroboration_filter.similarity_above_threshold_is_one_source;

	// 1. Load entities linked to this story
	const entities = await findEntitiesByStoryId(pool, storyId);
	if (entities.length === 0) {
		return [];
	}

	const results: CorroborationResult[] = [];

	// 2. For each entity, compute corroboration
	for (const entity of entities) {
		// Load all story-source pairs for this entity
		const storySources = await loadStorySourcesForEntity(pool, entity.id);
		const allStoryIds = storySources.map((ss) => ss.storyId);

		// Load duplicate edges involving these stories
		const duplicatePairs = await loadDuplicateEdges(pool, allStoryIds);

		// Compute independent source count
		const independentSourceCount = computeIndependentSourceCount(storySources, duplicatePairs, dedupFilter);

		// Calculate score: min(count / min_sources, 1.0)
		const corroborationScore = Math.min(independentSourceCount / minIndependentSources, 1.0);

		// Update entity
		await updateEntity(pool, entity.id, {
			sourceCount: independentSourceCount,
			corroborationScore,
		});

		results.push({
			entityId: entity.id,
			independentSourceCount,
			corroborationScore,
		});
	}

	return results;
}
