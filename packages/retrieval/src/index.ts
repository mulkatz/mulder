/**
 * `@mulder/retrieval` — hybrid retrieval strategies for the Mulder platform.
 *
 * This package will host the three search strategies (vector, fulltext, graph)
 * and the fusion + re-ranking layer that compose them into the hybrid query
 * pipeline (E6). M4-E1 ships the vector search wrapper as the first strategy.
 *
 * @see docs/specs/37_vector_search_retrieval.spec.md
 * @see docs/functional-spec.md §5
 */

export type { RetrievalResult, RetrievalStrategy, VectorSearchOptions } from './types.js';
export { vectorSearch } from './vector.js';
