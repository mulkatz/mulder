/**
 * `@mulder/retrieval` — hybrid retrieval strategies for the Mulder platform.
 *
 * This package hosts the three search strategies (vector, fulltext, graph)
 * and will host the fusion + re-ranking layer that composes them into the
 * hybrid query pipeline (E6). M4-E1 ships vector search, M4-E2 ships
 * full-text BM25, M4-E3 ships graph traversal.
 *
 * @see docs/specs/37_vector_search_retrieval.spec.md
 * @see docs/specs/38_fulltext_search_retrieval.spec.md
 * @see docs/specs/39_graph_traversal_retrieval.spec.md
 * @see docs/functional-spec.md §5
 */

export { fulltextSearch } from './fulltext.js';
export { graphSearch } from './graph.js';
export type {
	FulltextSearchOptions,
	GraphSearchOptions,
	RetrievalResult,
	RetrievalStrategy,
	VectorSearchOptions,
} from './types.js';
export { vectorSearch } from './vector.js';
