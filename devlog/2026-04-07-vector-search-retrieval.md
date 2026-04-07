---
date: 2026-04-07
type: implementation
title: Vector search retrieval — first @mulder/retrieval module
tags: [retrieval, pgvector, hnsw, m4]
---

The `@mulder/retrieval` package is now real instead of a stub: `vectorSearch(pool, embeddingService, config, options)` accepts either a text query (which gets embedded via the registry-injected `EmbeddingService`) or a precomputed 768-dim vector, runs a pgvector cosine-similarity query against the HNSW index on `chunks`, and returns the new shared `RetrievalResult[]` shape (`chunkId`, `storyId`, `content`, `score`, `rank`, `strategy: 'vector'`, `metadata`). That shape is the entire point of this step — every future retrieval strategy (E2 BM25, E3 graph traversal) will return the same shape so RRF fusion (E4) can merge them without per-strategy adapters. The hardest design decision was where to live `hnsw.ef_search`: PostgreSQL's `SET` doesn't accept bind parameters, so the new `searchByVectorWithEfSearch` repository function checks out a dedicated client, validates `efSearch` as a positive integer client-side, then `BEGIN; SET LOCAL hnsw.ef_search = <int>; SELECT ...; COMMIT` on the same session — keeping the SQL injection guard explicit and the SQL in the repo where it belongs. The original `searchByVector` is left untouched on purpose so existing callers (the enrich step's embedding-similarity tier) keep paying zero cost for ef_search plumbing. Library-only for now: `mulder query` lands in E6 once all three strategies plus RRF and Gemini re-ranking exist.
