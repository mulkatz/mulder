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
// RRF fusion types
// ────────────────────────────────────────────────────────────

/**
 * A result that has been through RRF fusion. Extends the retrieval layer with
 * provenance tracking: which strategies contributed this chunk and their
 * individual ranks/scores.
 *
 * @see docs/specs/40_rrf_fusion.spec.md §4.1
 * @see docs/functional-spec.md §5.2
 */
export interface FusedResult {
	chunkId: string;
	storyId: string;
	content: string;
	/** RRF score: Σ (weight_i / (k + rank_i)) across contributing strategies. */
	score: number;
	/** 1-based rank in the fused result list. */
	rank: number;
	/** Strategies that contributed this chunk, with their individual rank and score. */
	contributions: StrategyContribution[];
	/** Strategy-specific metadata merged from all contributing results. */
	metadata?: Record<string, unknown>;
}

/** Tracks a single strategy's contribution to a fused result. */
export interface StrategyContribution {
	strategy: RetrievalStrategy;
	/** 1-based rank within this strategy's result list. */
	rank: number;
	/** Strategy-native score (cosine sim, ts_rank, path confidence). */
	score: number;
}

/** Options for the RRF fusion function. */
export interface FusionOptions {
	/** RRF constant k. Default: 60. */
	k?: number;
	/** Maximum number of fused results to return. Default: config `retrieval.top_k`. */
	limit?: number;
	/** Per-strategy weights. Default: from config. */
	weights?: Partial<Record<RetrievalStrategy, number>>;
}

// ────────────────────────────────────────────────────────────
// LLM re-ranking types
// ────────────────────────────────────────────────────────────

/**
 * A result that has been re-ranked by Gemini Flash after RRF fusion.
 *
 * - `score` is the original RRF score (preserved for debugging/provenance).
 * - `rerankScore` is the Gemini relevance score (0.0–1.0).
 * - `rank` is the 1-based position in the re-ranked list.
 * - `contributions` is carried over unchanged from the upstream `FusedResult`.
 *
 * @see docs/specs/41_llm_reranking.spec.md §4.1
 * @see docs/functional-spec.md §5.2
 */
export interface RerankedResult {
	chunkId: string;
	storyId: string;
	content: string;
	/** Original RRF fused score, preserved for debugging. */
	score: number;
	/** Gemini relevance score (0.0 to 1.0). */
	rerankScore: number;
	/** 1-based rank in the re-ranked result list. */
	rank: number;
	/** Strategies that contributed this chunk (carried over from RRF fusion). */
	contributions: StrategyContribution[];
	/** Strategy-specific metadata (carried over from RRF fusion). */
	metadata?: Record<string, unknown>;
}

/**
 * Options for the {@link rerank} function.
 *
 * @see docs/specs/41_llm_reranking.spec.md §4.1
 */
export interface RerankOptions {
	/**
	 * Maximum number of candidates to send to Gemini. Defaults to
	 * `config.retrieval.rerank.candidates` (default: 20).
	 * Input results are truncated (by RRF rank) to this count before prompting.
	 */
	candidates?: number;
	/**
	 * Maximum number of results to return after re-ranking. Defaults to
	 * `config.retrieval.top_k` (default: 10).
	 */
	limit?: number;
	/**
	 * Override the template locale. Defaults to `'en'`. Must be a locale that
	 * exists in `packages/core/src/prompts/i18n/`.
	 */
	locale?: string;
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

// ────────────────────────────────────────────────────────────
// Hybrid orchestrator types (E6)
// ────────────────────────────────────────────────────────────

/**
 * Strategy selector for the orchestrator. Maps to the `--strategy` CLI flag.
 *
 * - `vector` — pgvector cosine similarity only
 * - `fulltext` — tsvector BM25 only
 * - `graph` — recursive CTE traversal only (requires seed entities from query)
 * - `hybrid` — all three strategies, fused via RRF
 *
 * @see docs/specs/42_hybrid_retrieval_orchestrator.spec.md §4.3
 * @see docs/functional-spec.md §5
 */
export type RetrievalStrategyMode = 'vector' | 'fulltext' | 'graph' | 'hybrid';

/**
 * Options for {@link hybridRetrieve}. All fields optional; defaults are picked
 * up from the active `MulderConfig`.
 */
export interface HybridRetrieveOptions {
	/** Which strategies to run. Default: `config.retrieval.default_strategy` (usually `hybrid`). */
	strategy?: RetrievalStrategyMode;
	/** Final result count. Default: `config.retrieval.top_k`. */
	topK?: number;
	/** Skip LLM re-ranking even when the feature flag is enabled. */
	noRerank?: boolean;
	/** Populate per-result strategy contributions in the explain block. */
	explain?: boolean;
}

/**
 * Confidence object returned alongside results. Reflects how much to trust
 * the results given the current corpus size and graph density.
 *
 * @see docs/functional-spec.md §5.3
 */
export interface QueryConfidence {
	corpus_size: number;
	taxonomy_status: 'not_started' | 'bootstrapping' | 'active' | 'mature';
	corroboration_reliability: 'insufficient' | 'low' | 'moderate' | 'high';
	graph_density: number;
	degraded: boolean;
}

/**
 * Per-strategy diagnostic breakdown. Always present in the result, but
 * per-result scoring details are only populated when `options.explain === true`.
 */
export interface HybridRetrievalExplain {
	/** Hit count per strategy actually executed (skipped/failed strategies omitted). */
	counts: Partial<Record<RetrievalStrategy, number>>;
	/** Strategies that were skipped with reason (e.g. `graph:no_seeds`). */
	skipped: string[];
	/** Strategies that failed with the error code observed (e.g. `vector: RETRIEVAL_QUERY_FAILED`). */
	failures: Partial<Record<RetrievalStrategy, string>>;
	/** Seed entity IDs used by graph strategy. Empty array when graph was skipped or not active. */
	seedEntityIds: string[];
	/** Per-result contributions, only populated when options.explain === true. */
	contributions?: Array<{
		chunkId: string;
		rerankScore: number;
		rrfScore: number;
		strategies: Array<{ strategy: RetrievalStrategy; rank: number; score: number }>;
	}>;
}

/** Final output of {@link hybridRetrieve}. */
export interface HybridRetrievalResult {
	query: string;
	strategy: RetrievalStrategyMode;
	topK: number;
	results: RerankedResult[];
	confidence: QueryConfidence;
	explain: HybridRetrievalExplain;
}
