/**
 * Graph traversal retrieval strategy.
 *
 * Thin wrapper over `traverseGraph` (recursive CTE) that:
 *   1. Validates seed entity IDs are non-empty.
 *   2. Resolves config defaults (maxHops, supernodeThreshold, limit).
 *   3. Returns the shared `RetrievalResult[]` shape so RRF fusion (E4) can
 *      merge it with vector + fulltext results uniformly.
 *
 * Errors are wrapped in `RetrievalError`:
 *   - empty entityIds → `RETRIEVAL_INVALID_INPUT`
 *   - repository / DB failure → `RETRIEVAL_QUERY_FAILED`
 *
 * An empty result set is NOT an error — returns `[]`. This follows the
 * sparse graph degradation behavior described in functional spec §5.3:
 * graph expansion returning 0 results is honest, not broken.
 *
 * Unlike {@link vectorSearch}, this function takes no embedding service:
 * it operates on entity IDs directly. The orchestrator (E6) is responsible
 * for extracting entities from the user's query text.
 *
 * @see docs/specs/39_graph_traversal_retrieval.spec.md §4.3
 * @see docs/functional-spec.md §5.1
 */

import type { GraphTraversalResult, MulderConfig } from '@mulder/core';
import { createChildLogger, createLogger, RETRIEVAL_ERROR_CODES, RetrievalError, traverseGraph } from '@mulder/core';
import type pg from 'pg';
import type { GraphSearchOptions, RetrievalResult } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-graph' });

/**
 * Graph traversal retrieval strategy.
 *
 * Wraps the graph-traversal repository's recursive CTE with input validation,
 * config-driven defaults, and the shared `RetrievalResult` shape.
 *
 * @param pool - PostgreSQL connection pool
 * @param config - Mulder configuration (for default values)
 * @param options - Graph search options with seed entity IDs
 * @returns Chunks connected to seed entities via RELATIONSHIP edges
 */
export async function graphSearch(
	pool: pg.Pool,
	config: MulderConfig,
	options: GraphSearchOptions,
): Promise<RetrievalResult[]> {
	const start = Date.now();

	// 1. Validate input — entityIds must be a non-empty array.
	if (!Array.isArray(options.entityIds) || options.entityIds.length === 0) {
		throw new RetrievalError(
			'graphSearch requires a non-empty `entityIds` array',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { entityIdsLength: Array.isArray(options.entityIds) ? options.entityIds.length : 0 } },
		);
	}

	// 2. Resolve config defaults.
	const maxHops = options.maxHops ?? config.retrieval.strategies.graph.max_hops;
	const supernodeThreshold = options.supernodeThreshold ?? config.retrieval.strategies.graph.supernode_threshold;
	const limit = options.limit ?? config.retrieval.top_k;

	// 3. Build optional filter.
	const hasStoryFilter = Array.isArray(options.storyIds) && options.storyIds.length > 0;
	const filter = hasStoryFilter ? { storyIds: options.storyIds } : undefined;

	// 4. Execute the recursive CTE traversal via the repository.
	let rawResults: GraphTraversalResult[];
	try {
		rawResults = await traverseGraph(pool, options.entityIds, maxHops, limit, supernodeThreshold, filter);
	} catch (error: unknown) {
		throw new RetrievalError('Graph traversal query failed', RETRIEVAL_ERROR_CODES.RETRIEVAL_QUERY_FAILED, {
			cause: error,
			context: {
				seedCount: options.entityIds.length,
				maxHops,
				supernodeThreshold,
				limit,
				hasFilter: !!filter,
			},
		});
	}

	// 5. Map to shared RetrievalResult shape. Path confidence stays
	//    strategy-native — cross-strategy normalization is RRF's job (E4).
	const results: RetrievalResult[] = rawResults.map((result, index) => ({
		chunkId: result.chunk.id,
		storyId: result.chunk.storyId,
		content: result.chunk.content,
		score: result.pathConfidence,
		rank: index + 1,
		strategy: 'graph',
		metadata: {
			depth: result.depth,
			entityId: result.entityId,
			entityName: result.entityName,
			entityType: result.entityType,
			pathConfidence: result.pathConfidence,
		},
	}));

	logger.debug(
		{
			seedCount: options.entityIds.length,
			maxHops,
			supernodeThreshold,
			limit,
			hasStoryFilter,
			resultCount: results.length,
			elapsedMs: Date.now() - start,
		},
		'graph search complete',
	);

	return results;
}
