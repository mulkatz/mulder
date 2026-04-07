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

// ────────────────────────────────────────────────────────────
// Fulltext search options
// ────────────────────────────────────────────────────────────

/**
 * Options for {@link fulltextSearch}. The query string is required — full-text
 * search has no precomputed-input alternative the way vector search does.
 *
 * By default, generated question chunks (`is_question = true`) are excluded
 * from results because lexical matching against question text is noisy
 * (functional spec §5.1). Set `includeQuestions: true` to opt back in.
 */
export interface FulltextSearchOptions {
	/** Free-text BM25 query. Required. Whitespace-only is rejected. */
	query: string;
	/** Maximum number of results to return. Default: `retrieval.top_k` from config (10). */
	limit?: number;
	/** Optional filter: only search within chunks of these stories. */
	storyIds?: string[];
	/**
	 * Include generated question chunks in the result set. Default: `false`
	 * (content chunks only, per functional spec §5.1). Most callers should
	 * leave this off — `true` exists for diagnostic / debug use.
	 */
	includeQuestions?: boolean;
}

// ────────────────────────────────────────────────────────────
// Graph search options
// ────────────────────────────────────────────────────────────

/**
 * Options for {@link graphSearch}. Requires seed entity IDs — the orchestrator
 * (E6) is responsible for extracting entities from the user's query text.
 *
 * @see docs/specs/39_graph_traversal_retrieval.spec.md §4.1
 * @see docs/functional-spec.md §5.1
 */
export interface GraphSearchOptions {
	/** Seed entity IDs to start traversal from. Required, must be non-empty. */
	entityIds: string[];
	/** Maximum traversal depth. Default: `retrieval.strategies.graph.max_hops` from config (2). */
	maxHops?: number;
	/** Maximum total results. Default: `retrieval.top_k` from config (10). */
	limit?: number;
	/** Skip entities with source_count >= this value. Default: `retrieval.strategies.graph.supernode_threshold` from config (100). */
	supernodeThreshold?: number;
	/** Only return chunks from these stories. Optional filter. */
	storyIds?: string[];
}
