/**
 * `@mulder/retrieval` — hybrid retrieval strategies for the Mulder platform.
 *
 * This package hosts the three search strategies (vector, fulltext, graph),
 * the RRF fusion layer, the LLM re-ranker, and the hybrid orchestrator that
 * composes them into a single `mulder query` entrypoint.
 *
 * @see docs/specs/37_vector_search_retrieval.spec.md
 * @see docs/specs/38_fulltext_search_retrieval.spec.md
 * @see docs/specs/39_graph_traversal_retrieval.spec.md
 * @see docs/specs/40_rrf_fusion.spec.md
 * @see docs/specs/41_llm_reranking.spec.md
 * @see docs/specs/42_hybrid_retrieval_orchestrator.spec.md
 * @see docs/functional-spec.md §5
 */

export { fulltextSearch } from './fulltext.js';
export { rrfFuse } from './fusion.js';
export { graphSearch } from './graph.js';
export { hybridRetrieve } from './orchestrator.js';
export { computeQueryConfidence, extractQueryEntities } from './query-entities.js';
export { rerank } from './reranker.js';
export type {
	FulltextSearchOptions,
	FusedResult,
	FusionOptions,
	GraphSearchOptions,
	HybridRetrievalExplain,
	HybridRetrievalResult,
	HybridRetrieveOptions,
	QueryConfidence,
	RerankedResult,
	RerankOptions,
	RetrievalResult,
	RetrievalStrategy,
	RetrievalStrategyMode,
	StrategyContribution,
	VectorSearchOptions,
} from './types.js';
export { vectorSearch } from './vector.js';
