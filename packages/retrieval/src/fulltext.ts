/**
 * Full-text search retrieval strategy.
 *
 * Thin wrapper over `chunks.searchByFts` that:
 *   1. Validates the query string is non-empty.
 *   2. Resolves the result limit from config (`retrieval.top_k`).
 *   3. Excludes generated question chunks by default (functional spec §5.1).
 *   4. Returns the shared `RetrievalResult[]` shape so RRF fusion (E4) can
 *      merge it with vector + graph results uniformly.
 *
 * Errors are wrapped in `RetrievalError`:
 *   - empty / whitespace query → `RETRIEVAL_INVALID_INPUT`
 *   - repository / DB failure → `RETRIEVAL_QUERY_FAILED`
 *
 * An empty result set is NOT an error — returns `[]`.
 *
 * @see docs/specs/38_fulltext_search_retrieval.spec.md §4.3
 * @see docs/functional-spec.md §5.1
 */

import type { FtsSearchResult, MulderConfig } from '@mulder/core';
import { createChildLogger, createLogger, RETRIEVAL_ERROR_CODES, RetrievalError, searchByFts } from '@mulder/core';
import type pg from 'pg';
import type { FulltextSearchOptions, RetrievalResult } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-fulltext' });

/**
 * Full-text search retrieval strategy.
 *
 * Wraps the chunk repository's BM25 search with query validation, config-driven
 * defaults, question-chunk exclusion, and the shared `RetrievalResult` shape.
 *
 * Unlike {@link vectorSearch}, this function takes no embedding service:
 * `plainto_tsquery` operates directly on the literal query string, so no
 * embedding round-trip is needed.
 */
export async function fulltextSearch(
	pool: pg.Pool,
	config: MulderConfig,
	options: FulltextSearchOptions,
): Promise<RetrievalResult[]> {
	const start = Date.now();

	// 1. Validate query — must be a non-empty string after trimming.
	const trimmedQuery = typeof options.query === 'string' ? options.query.trim() : '';
	if (trimmedQuery.length === 0) {
		throw new RetrievalError(
			'fulltextSearch requires a non-empty `query` string',
			RETRIEVAL_ERROR_CODES.RETRIEVAL_INVALID_INPUT,
			{ context: { queryLength: typeof options.query === 'string' ? options.query.length : 0 } },
		);
	}

	// 2. Resolve limit from options or config default.
	const limit = options.limit ?? config.retrieval.top_k;

	// 3. Build repository filter. Retrieval layer defaults to excluding
	//    question chunks per functional spec §5.1; callers can opt back in
	//    via `includeQuestions: true`.
	const excludeQuestions = options.includeQuestions !== true;
	const hasStoryIds = Array.isArray(options.storyIds) && options.storyIds.length > 0;
	const filter: { storyIds?: string[]; excludeQuestions?: boolean } = { excludeQuestions };
	if (hasStoryIds && options.storyIds) {
		filter.storyIds = options.storyIds;
	}

	// 4. Run the FTS query. Repository errors are wrapped in RetrievalError.
	let rawResults: FtsSearchResult[];
	try {
		rawResults = await searchByFts(pool, trimmedQuery, limit, filter);
	} catch (error: unknown) {
		throw new RetrievalError('Full-text search query failed', RETRIEVAL_ERROR_CODES.RETRIEVAL_QUERY_FAILED, {
			cause: error,
			context: { limit, excludeQuestions, hasFilter: hasStoryIds },
		});
	}

	// 5. Map to shared RetrievalResult shape. ts_rank stays strategy-native —
	//    cross-strategy normalization is RRF's job (E4).
	const results: RetrievalResult[] = rawResults.map((result, index) => ({
		chunkId: result.chunk.id,
		storyId: result.chunk.storyId,
		content: result.chunk.content,
		score: result.rank,
		rank: index + 1,
		strategy: 'fulltext',
		metadata: {
			tsRank: result.rank,
			isQuestion: result.chunk.isQuestion,
		},
	}));

	logger.debug(
		{
			queryLength: trimmedQuery.length,
			limit,
			includeQuestions: options.includeQuestions === true,
			hasStoryFilter: hasStoryIds,
			resultCount: results.length,
			elapsedMs: Date.now() - start,
		},
		'fulltext search complete',
	);

	return results;
}
