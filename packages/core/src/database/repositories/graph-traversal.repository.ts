/**
 * Graph traversal repository -- recursive CTE traversal from seed entities
 * through `entity_edges` to connected stories and their chunks.
 *
 * Implements the functional spec section 5.1 graph traversal SQL with:
 *   - Cycle detection via `NOT e2.id = ANY(t.path)`
 *   - Supernode pruning via `e2.source_count < $supernodeThreshold`
 *   - Edge type filter: only RELATIONSHIP edges
 *   - Path confidence decay: `t.path_confidence * ee.confidence`
 *
 * Plain function accepting `pg.Pool` as the first argument (same pattern
 * as all other repositories). No class wrapper.
 *
 * @see docs/specs/39_graph_traversal_retrieval.spec.md §4.2
 * @see docs/functional-spec.md §5.1
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'graph-traversal-repository' });

// ────────────────────────────────────────────────────────────
// Result type
// ────────────────────────────────────────────────────────────

/**
 * A single result from the graph traversal query. Represents a chunk
 * reachable from the seed entities through entity_edges → story_entities → chunks.
 */
export interface GraphTraversalResult {
	chunk: {
		id: string;
		storyId: string;
		content: string;
		isQuestion: boolean;
	};
	entityId: string;
	entityName: string;
	entityType: string;
	depth: number;
	pathConfidence: number;
}

// ────────────────────────────────────────────────────────────
// Row type (snake_case from DB)
// ────────────────────────────────────────────────────────────

interface TraversalRow {
	chunk_id: string;
	story_id: string;
	content: string;
	is_question: boolean;
	entity_id: string;
	entity_name: string;
	entity_type: string;
	depth: number;
	path_confidence: number;
}

function mapTraversalRow(row: TraversalRow): GraphTraversalResult {
	return {
		chunk: {
			id: row.chunk_id,
			storyId: row.story_id,
			content: row.content,
			isQuestion: row.is_question,
		},
		entityId: row.entity_id,
		entityName: row.entity_name,
		entityType: row.entity_type,
		depth: row.depth,
		pathConfidence: Number(row.path_confidence),
	};
}

// ────────────────────────────────────────────────────────────
// Traversal query
// ────────────────────────────────────────────────────────────

/**
 * Recursive CTE graph traversal from seed entities through entity_edges
 * to connected stories and their chunks.
 *
 * The CTE follows functional spec section 5.1 exactly:
 *   - Base case: seed entities (depth 0, path_confidence 1.0)
 *   - Recursive step: join entity_edges (RELATIONSHIP type only),
 *     cycle detection via path array, supernode pruning via source_count
 *   - After traversal: join story_entities to find stories, join chunks
 *     to get content
 *   - DISTINCT ON chunk_id with best path_confidence wins
 *   - Optional storyIds filter
 *   - LIMIT to hard cap
 *
 * @param pool - PostgreSQL connection pool
 * @param seedEntityIds - Entity IDs to start traversal from
 * @param maxHops - Maximum traversal depth (from config, default 2)
 * @param limit - Maximum results to return (from config, default 10)
 * @param supernodeThreshold - Skip entities with source_count >= this (default 100)
 * @param filter - Optional filter: restrict to specific story IDs
 * @returns Chunks connected to traversed entities, ranked by path_confidence DESC
 */
export async function traverseGraph(
	pool: pg.Pool,
	seedEntityIds: string[],
	maxHops: number,
	limit: number,
	supernodeThreshold: number,
	filter?: { storyIds?: string[] },
): Promise<GraphTraversalResult[]> {
	// Build the storyIds filter clause and parameters dynamically.
	const hasStoryFilter = Array.isArray(filter?.storyIds) && filter.storyIds.length > 0;

	// Parameter positions:
	// $1 = seedEntityIds (text[])
	// $2 = maxHops
	// $3 = limit
	// $4 = supernodeThreshold
	// $5 = storyIds (text[], only if filter is present)
	const storyFilterClause = hasStoryFilter ? 'AND c.story_id = ANY($5)' : '';

	const sql = `
    WITH RECURSIVE traversal AS (
      -- Base case: start from seed entities
      SELECT
        e.id,
        e.name,
        e.type,
        0 AS depth,
        ARRAY[e.id] AS path,
        1.0::float AS path_confidence
      FROM entities e
      WHERE e.id = ANY($1)

      UNION ALL

      -- Recursive step with cycle detection and supernode pruning
      SELECT
        e2.id,
        e2.name,
        e2.type,
        t.depth + 1,
        t.path || e2.id,
        t.path_confidence * ee.confidence
      FROM traversal t
      JOIN entity_edges ee ON ee.source_entity_id = t.id
      JOIN entities e2 ON e2.id = ee.target_entity_id
      WHERE t.depth < $2
        AND NOT e2.id = ANY(t.path)
        AND ee.edge_type = 'RELATIONSHIP'
        AND e2.source_count < $4
    ),
    -- Deduplicate traversal: keep best path_confidence per entity
    best_entities AS (
      SELECT DISTINCT ON (id) id, name, type, depth, path_confidence
      FROM traversal
      ORDER BY id, path_confidence DESC
    )
    -- Join to story_entities → chunks, then deduplicate at chunk level
    -- A single chunk can appear via multiple traversed entities; keep the
    -- one with the highest path_confidence (DISTINCT ON + ORDER BY).
    SELECT * FROM (
      SELECT DISTINCT ON (c.id)
        c.id AS chunk_id,
        c.story_id,
        c.content,
        c.is_question,
        be.id AS entity_id,
        be.name AS entity_name,
        be.type AS entity_type,
        be.depth,
        be.path_confidence
      FROM best_entities be
      JOIN story_entities se ON se.entity_id = be.id
      JOIN chunks c ON c.story_id = se.story_id
      WHERE c.is_question = false
        ${storyFilterClause}
      ORDER BY c.id, be.path_confidence DESC
    ) deduped
    ORDER BY deduped.path_confidence DESC, deduped.chunk_id
    LIMIT $3
  `;

	const params: unknown[] = [seedEntityIds, maxHops, limit, supernodeThreshold];
	if (hasStoryFilter && filter?.storyIds) {
		params.push(filter.storyIds);
	}

	try {
		const result = await pool.query<TraversalRow>(sql, params);

		repoLogger.debug(
			{
				seedCount: seedEntityIds.length,
				maxHops,
				supernodeThreshold,
				limit,
				hasStoryFilter,
				resultCount: result.rows.length,
			},
			'graph traversal query complete',
		);

		return result.rows.map(mapTraversalRow);
	} catch (error: unknown) {
		throw new DatabaseError('Graph traversal query failed', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				seedCount: seedEntityIds.length,
				maxHops,
				supernodeThreshold,
				limit,
			},
		});
	}
}
