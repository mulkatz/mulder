/**
 * Vector search retrieval strategy.
 *
 * Thin wrapper over `chunks.searchByVector` (and `searchByVectorWithEfSearch`
 * when an `ef_search` value is configured) that:
 *   1. Accepts either a free-text query or a precomputed embedding.
 *   2. Embeds the text via the registry-injected `EmbeddingService` when needed.
 *   3. Returns the shared `RetrievalResult[]` shape that all strategies share,
 *      so RRF fusion (E4) can merge results from vector + fulltext + graph.
 *
 * Errors from the embedding service and the repository are wrapped in
 * `RetrievalError` with distinct codes so callers can distinguish "embedding
 * failed" from "query failed". An empty result set is NOT an error.
 *
 * @see docs/specs/37_vector_search_retrieval.spec.md §4.2
 * @see docs/functional-spec.md §5.1
 */

import type { EmbeddingService, MulderConfig, VectorSearchResult } from '@mulder/core';
import {
	createChildLogger,
	createLogger,
	RETRIEVAL_ERROR_CODES,
	RetrievalError,
	searchByVector,
	searchByVectorWithEfSearch,
} from '@mulder/core';
import type pg from 'pg';
import type { RetrievalResult, VectorSearchOptions } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-vector' });

/**
 * Vector search retrieval strategy.
 *
 * Wraps the chunk repository's vector similarity search with text-query
 * embedding, config-driven defaults, and the shared `RetrievalResult` shape.
 *
 * The HNSW `ef_search` session parameter is set per-query when configured
 * via `retrieval.strategies.vector.ef_search`. Higher values trade speed for
 * recall.
 */
export async function vectorSearch(
	pool: pg.Pool,
	embeddingService: EmbeddingService,
	config: MulderConfig,
	options: VectorSearchOptions,
): Promise<RetrievalResult[]> {
	const start = Date.now();

	// 1. Validate input — at least one of query or embedding required.
	const hasEmbedding = Array.isArray(options.embedding) && options.embedding.length > 0;
	const hasQuery = typeof options.query === 'string' && options.query.trim().length > 0;
	if (!hasEmbedding && !hasQuery) {
		throw new RetrievalError(
			'vectorSearch requires either a non-empty `query` string or a non-empty `embedding` array',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { hasQuery, hasEmbedding } },
		);
	}

	const expectedDimensions = config.embedding.storage_dimensions;

	// 2. Resolve query embedding. If `embedding` is provided, use it directly
	//    and skip the embedding service entirely (critical for QA-02).
	let queryEmbedding: number[];
	let embeddingSource: 'precomputed' | 'text';
	if (hasEmbedding && options.embedding) {
		queryEmbedding = options.embedding;
		embeddingSource = 'precomputed';
	} else {
		// hasQuery is guaranteed true here by the validation above.
		const queryText = (options.query as string).trim();
		try {
			const results = await embeddingService.embed([queryText]);
			if (results.length === 0 || !results[0]?.vector) {
				throw new RetrievalError(
					'EmbeddingService returned no results for query',
					RETRIEVAL_ERROR_CODES.RETRIEVAL_EMBEDDING_FAILED,
					{ context: { queryLength: queryText.length } },
				);
			}
			queryEmbedding = results[0].vector;
		} catch (error: unknown) {
			if (error instanceof RetrievalError) {
				throw error;
			}
			throw new RetrievalError(
				'Failed to embed query text via EmbeddingService',
				RETRIEVAL_ERROR_CODES.RETRIEVAL_EMBEDDING_FAILED,
				{ cause: error, context: { queryLength: queryText.length } },
			);
		}
		embeddingSource = 'text';
	}

	// 3. Validate dimension.
	if (queryEmbedding.length !== expectedDimensions) {
		throw new RetrievalError(
			`Query embedding has ${queryEmbedding.length} dimensions, expected ${expectedDimensions}`,
			RETRIEVAL_ERROR_CODES.RETRIEVAL_DIMENSION_MISMATCH,
			{ context: { actual: queryEmbedding.length, expected: expectedDimensions } },
		);
	}

	// 4. Resolve limit.
	const limit = options.limit ?? config.retrieval.top_k;

	// 5. Run the search via the appropriate repository function.
	//    `ef_search` always has a default now (40) so we always use the
	//    explicit-ef variant. The fallback to `searchByVector` exists for
	//    callers that may pass a config without the field set in some
	//    edge case (e.g., partial test fixtures).
	const efSearch = config.retrieval.strategies.vector.ef_search;
	const filter = options.storyIds && options.storyIds.length > 0 ? { storyIds: options.storyIds } : undefined;

	let rawResults: VectorSearchResult[];
	try {
		if (typeof efSearch === 'number') {
			rawResults = await searchByVectorWithEfSearch(pool, queryEmbedding, limit, efSearch, filter);
		} else {
			rawResults = await searchByVector(pool, queryEmbedding, limit, filter);
		}
	} catch (error: unknown) {
		throw new RetrievalError('Vector search query failed', RETRIEVAL_ERROR_CODES.RETRIEVAL_QUERY_FAILED, {
			cause: error,
			context: { limit, efSearch, hasFilter: !!filter },
		});
	}

	// 6. Optional content-only filter (drop generated question chunks).
	const filtered = options.contentOnly ? rawResults.filter((r) => r.chunk.isQuestion !== true) : rawResults;

	// 7. Map to RetrievalResult shape.
	const results: RetrievalResult[] = filtered.map((result, index) => ({
		chunkId: result.chunk.id,
		storyId: result.chunk.storyId,
		content: result.chunk.content,
		score: result.similarity,
		rank: index + 1,
		strategy: 'vector',
		metadata: {
			distance: result.distance,
			similarity: result.similarity,
			isQuestion: result.chunk.isQuestion,
		},
	}));

	logger.debug(
		{
			embeddingSource,
			queryLength: hasQuery ? options.query?.length : undefined,
			efSearch,
			limit,
			resultCount: results.length,
			elapsedMs: Date.now() - start,
		},
		'vector search complete',
	);

	return results;
}
