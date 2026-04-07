/**
 * Shared retrieval-layer types.
 *
 * Every strategy (vector, fulltext, graph) returns the same `RetrievalResult`
 * shape so that RRF fusion (E4) can merge them uniformly without per-strategy
 * adapters. Strategy-native scores stay in `score` and are NOT normalized at
 * this layer — fusion is responsible for cross-strategy normalization.
 *
 * @see docs/specs/37_vector_search_retrieval.spec.md §4.1
 * @see docs/functional-spec.md §5.1
 */

// ────────────────────────────────────────────────────────────
// Strategy identifier
// ────────────────────────────────────────────────────────────

/** Identifies which strategy produced a retrieval result. */
export type RetrievalStrategy = 'vector' | 'fulltext' | 'graph';

// ────────────────────────────────────────────────────────────
// Result shape
// ────────────────────────────────────────────────────────────

/**
 * Normalized retrieval-layer result. Every strategy returns this shape so
 * RRF fusion (E4) can merge them uniformly.
 *
 * - `score` is the strategy-native score (cosine similarity for vector,
 *   ts_rank for fulltext, path confidence for graph). It is NOT normalized
 *   across strategies — that happens in fusion.
 * - `rank` is the 1-based position within this strategy's result list,
 *   used by RRF to compute `1 / (k + rank)`.
 */
export interface RetrievalResult {
	chunkId: string;
	storyId: string;
	content: string;
	score: number;
	rank: number;
	strategy: RetrievalStrategy;
	/** Strategy-specific metadata. For vector: `{ distance, similarity, isQuestion }`. */
	metadata?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────
// Vector search options
// ────────────────────────────────────────────────────────────

/**
 * Options for {@link vectorSearch}. Exactly one of `query` or `embedding`
 * must be provided. When both are present, `embedding` wins and `query` is
 * ignored (no embedding API call is made).
 */
export interface VectorSearchOptions {
	/** Free-text query. If provided, will be embedded via the EmbeddingService. */
	query?: string;
	/** Precomputed query embedding. Overrides `query` when both are provided. */
	embedding?: number[];
	/** Maximum number of results to return. Default: `retrieval.top_k` from config (10). */
	limit?: number;
	/** Optional filter: only search within chunks of these stories. */
	storyIds?: string[];
	/**
	 * Optional: skip generated question chunks (`is_question = true`) so that
	 * vector search only matches content chunks. Default: `false` (include all).
	 * Reserved for future use — content+question matching is the M4 default.
	 */
	contentOnly?: boolean;
}
