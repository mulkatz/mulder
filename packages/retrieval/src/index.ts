/**
 * `@mulder/retrieval` — hybrid retrieval strategies for the Mulder platform.
 *
 * This package hosts the three search strategies (vector, fulltext, graph)
 * and the RRF fusion layer that merges them into a single ranked list.
 * The re-ranking layer (E5) and hybrid orchestrator (E6) compose on top.
 *
 * @see docs/specs/37_vector_search_retrieval.spec.md
 * @see docs/specs/38_fulltext_search_retrieval.spec.md
 * @see docs/specs/39_graph_traversal_retrieval.spec.md
 * @see docs/specs/40_rrf_fusion.spec.md
 * @see docs/functional-spec.md §5
 */

export { fulltextSearch } from './fulltext.js';
export { rrfFuse } from './fusion.js';
export { graphSearch } from './graph.js';
export { rerank } from './reranker.js';
export type {
	FulltextSearchOptions,
	FusedResult,
	FusionOptions,
	GraphSearchOptions,
	RerankedResult,
	RerankOptions,
	RetrievalResult,
	RetrievalStrategy,
	StrategyContribution,
	VectorSearchOptions,
} from './types.js';
export { vectorSearch } from './vector.js';
