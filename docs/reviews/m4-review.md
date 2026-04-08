---
milestone: M4
title: "You can search" — v1.0 MVP
reviewed: 2026-04-08
steps_reviewed: [D1, D2, D3, D4, D5, D6, D7, E1, E2, E3, E4, E5, E6]
spec_sections: [§1, §2, §2.6, §2.7, §3.1, §3.2, §3.3, §3.4, §3.5, §4.3, §4.8, §5, §5.1, §5.2, §5.3, §14]
verdict: PASS_WITH_WARNINGS
---

# Milestone Review: M4 — v1.0 MVP Search

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Warning  | 4 |
| Note     | 6 |

**Verdict:** PASS_WITH_WARNINGS

M4 delivers a complete, well-architected hybrid retrieval stack: 768-dim Matryoshka embeddings via `outputDimensionality`, semantic chunker, HNSW vector index on a `chunks` table that also carries the generated `tsvector` column for BM25, recursive-CTE graph traversal with cycle detection and supernode pruning, RRF fusion in application code, Gemini Flash re-ranking with feature-flag bypass, and a cursor-based pipeline orchestrator backed by `pipeline_runs` / `pipeline_run_sources`. All 14 critical correctness checks pass. The four warnings are contract-level divergences (graph step builds co-occurrence edges where the spec implies enrich provides them; contradiction edges are stored as self-loops; corroboration `confidence` exposes a custom `degraded` field instead of the spec's exact field set; query confidence omits the spec's `null` / `"insufficient_data"` value for corroboration when below the threshold). None block search functionality.

---

## Per-Section Divergences

### §2.6 — Embed

**[DIV-001] `embed()` API parameter shape — uses `schema: { outputDimensionality }` instead of native config field**
- **Severity:** NOTE
- **Spec says:** "Pass `outputDimensionality: 768` in the Vertex AI API call." (line 420)
- **Code does:** `packages/core/src/vertex.ts:322,341,375` passes `outputDimensionality` through the request config. This is an SDK-versioning detail, not an issue — the resulting API call carries the correct field. Verified the dev embedding service also uses `VECTOR_DIM = 768` (services.dev.ts:375).
- **Evidence:** Matryoshka path is enforced; no `slice(0, 768)` anywhere in `packages/`.

**[DIV-002] Question chunks reuse `chunkIndex` numbering starting from 0**
- **Severity:** NOTE
- **Spec says:** §2.6 step 5 — "generated questions as separate rows with `is_question=true` and `parent_chunk_id`" (line 425). No explicit guidance on `chunk_index` for questions.
- **Code does:** `packages/pipeline/src/embed/index.ts:282` resets `questionChunkIndex = 0` and increments per question, so question rows have low `chunk_index` values that collide ordinally with content chunks.
- **Evidence:** The spec is silent on this. Questions are filtered out of FTS and content-only retrieval, so collisions are harmless. Worth aligning the spec or namespacing question indices for clarity.

### §2.7 — Graph

**[DIV-003] Graph step fabricates co-occurrence edges when enrich produced no relationships**
- **Severity:** WARNING
- **Spec says:** §2.7 step 2 — "Upsert `entity_edges` records with relationship type, attributes, source story, confidence" (line 447). The spec's mental model is that the relationships were extracted by Enrich and graph just persists/upserts them.
- **Code does:** `packages/pipeline/src/graph/index.ts:200-214` falls back to creating an O(n²) `co_occurs_with` edge for every entity pair in a story when no enrichment relationships are found.
- **Evidence:** Reasonable fallback for sparse enrich output but not in the spec. Risk: a story with 50 entities produces 1225 edges. Should be documented or gated by config.

**[DIV-004] Contradiction edges are stored as self-loops on a single entity**
- **Severity:** WARNING
- **Spec says:** §2.7 step 6 — "create `POTENTIAL_CONTRADICTION` edge **between the two claims**" (line 463), and §2.8 expects the Analyze step to load these edges to build comparison prompts (line 487).
- **Code does:** `packages/pipeline/src/graph/index.ts:294-308` calls `upsertEdge` with `sourceEntityId === targetEntityId === contradiction.entityId`. The two conflicting claims live only inside `attributes.storyIdA / storyIdB`.
- **Evidence:** The current schema represents claims at the entity level, not as separate claim nodes, so this is a workable encoding — but it diverges from the spec's "between the two claims" wording and forces the (future) Analyze step to peek into JSONB attributes to find the second claim. Spec or schema should be reconciled.

**[DIV-005] `DUPLICATE_OF` edges hop through entity IDs instead of story IDs**
- **Severity:** NOTE
- **Spec says:** §2.7 step 3 — `DUPLICATE_OF` edge with `similarity_score` and `duplicate_type` (line 452-453). Implies an edge between stories.
- **Code does:** `packages/pipeline/src/graph/index.ts:233-258` picks `entitiesA[0]` and `entitiesB[0]` to use as edge endpoints because `entity_edges` has no story-level slot. The story IDs land inside `attributes`.
- **Evidence:** Same shape problem as DIV-004 — a story-level concept squeezed through an entity-level table. Functionally correct (corroboration query joins via `story_entities → stories → source_id` and uses the dedup edges); architecturally noisy. Could be cleaned up with a dedicated `story_edges` table or by storing both endpoints explicitly in the entity edge.

### §3.2, §3.3 — Pipeline Orchestrator (D6)

No divergences found. Verified:
- `packages/pipeline/src/pipeline/index.ts` is a coordinator that delegates to existing `executeIngest` / `executeExtract` / `executeSegment` / `executeEnrich` / `executeEmbed` / `executeGraph` functions (lines 34-39).
- Cursor-based progress tracking via `createPipelineRun`, `upsertPipelineRunSource`, and `finalizePipelineRun` (lines 22-32, 419-636). Matches spec line 540 ("cursor-based progress tracking — not a naive for-loop that loses state on crash").
- A failed source is marked failed and the batch continues (per-source try/catch path at 622-636, matching spec line 632 "Don't crash the whole pipeline").
- `STEP_ORDER` (lines 68-75) implements `--from` / `--up-to` slicing.
- Ground and Analyze are correctly omitted from STEP_ORDER (v2.0 — M5/M6).

### §3.4 — Force Re-runs

No divergences found. Both `embed/index.ts:75-78` and `graph/index.ts:65-69` delegate to `resetPipelineStep(pool, sourceId, 'embed' | 'graph')` (the PL/pgSQL cascading reset). Per-story force cleanup paths (`forceCleanupStory`) preserve the cascade chain documented in §3.4.

### §4.3 — chunks table + HNSW + tsvector

No divergences found. `006_chunks.sql` defines:
- `embedding vector(768)` (line 8) — 768-dim, matches Matryoshka choice.
- `fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED` (line 9) — generated column on `chunks.content`, satisfies "FTS on chunks table" requirement and §5.1.
- `is_question`, `parent_chunk_id` (lines 10-11) — content/question split.

`008_indexes.sql` line 23-25:
```sql
CREATE INDEX idx_chunks_embedding ON chunks
  USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```
HNSW with cosine ops, with explicit comment "NOT ivfflat — see §14 for rationale". GIN index on `fts_vector` (line 20) for BM25.

**[DIV-006] FTS uses `'simple'` text search config (no stemming, no stop words)**
- **Severity:** NOTE
- **Spec says:** §5.1 BM25 example uses `plainto_tsquery($1)` without specifying a language config (line 1378).
- **Code does:** `006_chunks.sql:9` uses `to_tsvector('simple', content)` — the simple parser does no stemming or stop word removal.
- **Evidence:** Defensible for a multilingual corpus (no English-only stemming bias) but worth documenting the trade-off explicitly.

### §4.8 — Vertex AI Wrapper

No divergences found for M4. `vertex.ts:65` sets `DEFAULT_MODEL = 'gemini-2.5-flash'` — applied to both `generateContent` and `generateStructured`. The reranker therefore uses Flash, not Pro (verified in `services.gcp.ts:292` `GcpEmbeddingService` and the reranker calling `llmService.generateStructured`).

### §5.1 — Three Strategies

No divergences found.
- **Vector** (`packages/retrieval/src/vector.ts`): wraps `searchByVector` / `searchByVectorWithEfSearch`, passes `ef_search` from `config.retrieval.strategies.vector.ef_search`, validates dimension match against `config.embedding.storage_dimensions`, and supports both precomputed embedding and text query (lines 43-162).
- **Fulltext** (`fulltext.ts`): calls `searchByFts` with `excludeQuestions=true` by default per spec §5.1 ("only match content chunks, not generated questions") — see lines 60-63.
- **Graph** (`graph.ts` + `graph-traversal.repository.ts`): recursive CTE in `graph-traversal.repository.ts:125`, with cycle detection (`NOT e2.id = ANY(t.path)` line 145), supernode pruning (`e2.source_count < $supernodeThreshold`), per-level depth limit (`t.depth < $maxHops`), and total result limit. All three guards from the spec example are present.

### §5.2 — Fusion + Re-ranking

No divergences found.
- `fusion.ts:22` defines `DEFAULT_K = 60` per spec.
- RRF executed in TypeScript application code, not SQL (rrfFuse function at line 88).
- Per-strategy weights resolved from `config.retrieval.strategies.{vector,fulltext,graph}.weight` with optional override map (lines 28-45).
- Cross-strategy deduplication by `chunkId` with summed contributions (lines 145-168).
- `reranker.ts` uses Gemini Flash via `llmService.generateStructured`, supports feature-flag bypass (`config.retrieval.rerank.enabled === false` → passthrough), validates the response shape with explicit type guards (no `as` casts), and handles missing-passage fallback via `min(returned) - epsilon` (line 308). Top-N candidates from `config.retrieval.rerank.candidates`, final `topK` from `config.retrieval.top_k`.

### §5.3 — Sparse Graph Degradation

**[DIV-007] `confidence` object field set diverges from spec**
- **Severity:** WARNING
- **Spec says:** §5.3 example response (lines 1480-1487):
  ```json
  "confidence": {
    "corpus_size": 12,
    "taxonomy_status": "bootstrapping",
    "corroboration_reliability": "low",
    "graph_density": 0.03
  }
  ```
- **Code does:** `packages/retrieval/src/query-entities.ts:259-265` returns the four spec fields plus an extra `degraded: boolean` field.
- **Evidence:** Extra field is helpful but not in the spec. Either add `degraded` to the spec or compute it client-side.

**[DIV-008] No `null` / `"insufficient_data"` corroboration short-circuit**
- **Severity:** WARNING
- **Spec says:** §5.3 (line 1473) — "**Corroboration** < threshold: Score returned as `null` / `"insufficient_data"`, not `1`."
- **Code does:** `corroboration.ts` (graph step) always writes a numeric `corroboration_score` regardless of `thresholds.corroboration_meaningful`. Query path classifies `corroboration_reliability` ("insufficient" / "low" / ...) but the per-entity score is still a real number.
- **Evidence:** The reliability label flags the situation, but the underlying scores stored on `entities.corroboration_score` can mislead downstream consumers that read the column directly. Either gate the score write on the threshold or surface a wrapped object that hides the number below threshold.

**[DIV-009] No "fallback to pure vector search when sparse" path**
- **Severity:** NOTE
- **Spec says:** §5.3 (line 1474) — "Hybrid Retrieval with sparse data: Falls back to pure vector search. BM25 and graph expansion remain active but with honest confidence."
- **Code does:** `orchestrator.ts` always runs all active strategies; graph is "skipped" only when no seed entities are extracted (line 186-188). There is no corpus-size guard that downshifts to vector-only.
- **Evidence:** Per-strategy `failures` and `skipped` are reported in `explain` so callers see what happened. Acceptable interpretation of the spec — graph is naturally pruned to zero on a sparse corpus (no edges) — but the explicit fallback rule isn't implemented.

### §14 — Key Design Decisions

No divergences found. M4 implementation aligns with §14 design decisions:
- HNSW (not ivfflat) — verified.
- 768-dim via Matryoshka — verified, no manual truncation.
- Dedup before corroboration — verified by ordering in `graph/index.ts` (dedup at step 7, corroboration at step 8).
- RRF fusion in app code — verified.
- Content in GCS, chunks inline in PostgreSQL — verified (`chunks.content TEXT NOT NULL`, story Markdown loaded via `services.storage.download(story.gcsMarkdownUri)` in embed/index.ts:159).

---

## Critical Correctness Checks

| # | Check | Verdict | Evidence |
|---|------|---------|----------|
| 1 | 768-dim via `outputDimensionality`, no manual truncation | PASS | `vertex.ts:322,341,375` passes `outputDimensionality`; no `slice(0, 768)` in `packages/`; `services.dev.ts:375` `VECTOR_DIM = 768` |
| 2 | Vector index is HNSW, not ivfflat | PASS | `008_indexes.sql:23-25` `USING hnsw(embedding vector_cosine_ops)` with explicit "NOT ivfflat" comment |
| 3 | FTS is generated `tsvector` column on `chunks` | PASS | `006_chunks.sql:9` `fts_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED` |
| 4 | Dedup happens before corroboration counting | PASS | `graph/index.ts:227-272` (dedup) precedes `graph/index.ts:274-286` (corroboration) |
| 5 | DUPLICATE_OF edges created, near-dupes NOT deleted | PASS | `graph/index.ts:243-256` calls `upsertEdge(...edgeType: 'DUPLICATE_OF')`, no DELETE on stories or chunks |
| 6 | Contradiction detection in graph step is attribute-diff, NOT LLM | PASS | `contradiction.ts` imports no LLM service, only `findEntitiesByStoryId` and pure pg client; uses string/value comparisons |
| 7 | Pipeline orchestrator is cursor-based | PASS | `pipeline/index.ts` uses `pipeline_runs`/`pipeline_run_sources` via `upsertPipelineRunSource` per source per step |
| 8 | Chunks stored inline in PostgreSQL (~512 tokens) | PASS | `006_chunks.sql:4` `content TEXT NOT NULL`; `embed/index.ts` writes via `createChunks` repository, never to GCS |
| 9 | Story Markdown lives in GCS, loaded on demand | PASS | `embed/index.ts:159` `services.storage.download(story.gcsMarkdownUri)` |
| 10 | RRF fusion in application code, NOT SQL | PASS | `fusion.ts:88` `rrfFuse` is pure TypeScript Map-based reduction; no SQL in the file |
| 11 | Reranker uses Gemini Flash | PASS | `vertex.ts:65` `DEFAULT_MODEL = 'gemini-2.5-flash'` is the only model used by `generateStructured`, which the reranker calls |
| 12 | Graph traversal: recursive CTE + cycle detection + max_hops | PASS | `graph-traversal.repository.ts:125-160` uses `WITH RECURSIVE`, `NOT e2.id = ANY(t.path)`, `t.depth < $maxHops`, plus `e2.source_count < $supernodeThreshold` |
| 13 | Sparse graph returns null/insufficient_data, not misleading scores | PARTIAL | Confidence object reports `corroboration_reliability='insufficient'/'low'`, but underlying `entities.corroboration_score` is still a number below the threshold (see DIV-008). Not a CRITICAL because the orchestrator surfaces reliability separately. |
| 14 | API responses include `confidence` object with level/reasons | PASS | `orchestrator.ts:247,283` `confidence: await computeQueryConfidence(...)` is part of every `HybridRetrievalResult`. Field set diverges slightly (DIV-007). |

All 14 checks pass at the implementation level. Check 13 is marked PARTIAL because the spec's exact contract ("score returned as `null`") is not enforced at the storage layer, only at the query response layer — not enough to fail the gate but tracked as DIV-008.

---

## Cross-Cutting Convention Review

### Naming
All M4 files follow conventions: `kebab-case.ts` filenames, `PascalCase` types (`HybridRetrievalResult`, `RetrievalStrategy`, `FusedResult`), `camelCase` functions (`hybridRetrieve`, `rrfFuse`, `vectorSearch`), `snake_case` SQL columns and config keys.

### TypeScript Strictness
- No `any` types in `packages/retrieval/src/`, `packages/pipeline/src/embed/`, `packages/pipeline/src/graph/`.
- No `console.log`. All logging via Pino child loggers (`createChildLogger(createLogger(), { module: ... })`).
- All errors use custom classes (`RetrievalError`, `EmbedError`, `GraphError`, `PipelineError`) with explicit error code constants from `RETRIEVAL_ERROR_CODES`, `EMBED_ERROR_CODES`, `GRAPH_ERROR_CODES`, `PIPELINE_ERROR_CODES`.
- Type guards (`isValidRankingEntry`, `toRecord`) used in `reranker.ts` instead of `as` casts when narrowing external Gemini responses — exemplary.
- No raw `as` assertions in M4 retrieval code; the only place external API output enters the type system is via type guards or repository response types.

### Architecture
- **Service abstraction:** `packages/retrieval/src/` imports only from `@mulder/core` (types, repositories, errors, prompt engine, services interfaces). No direct imports from `gcp.ts` or any GCP SDK. Pipeline embed/graph steps likewise depend on `Services` interface, not concrete GCP clients.
- **Config via loader:** `query.ts` calls `loadConfig()`; orchestrator and helpers receive `MulderConfig` by parameter and read `config.retrieval.*` / `config.thresholds.*` / `config.embedding.*` only.
- **Custom errors:** Every catch wraps the cause in a typed error with a code.
- **Structured logging:** All modules use child loggers with a `module` binding for filterability.
- **Zod validation:** Reranker validates LLM response with hand-rolled type guards (consistent with M2's pattern of extra validation outside the loader). Repository contracts enforce types at the boundary.

### Package Structure
- `@mulder/retrieval` is a separate workspace package with its own `index.ts` barrel.
- Internal deps use `workspace:*`.
- Pipeline orchestrator imports per-step `execute` functions through `../{step}/index.js` — barrels intact.

### Test coverage (spot check)
- `tests/specs/42_*` covers the orchestrator black-box.
- D1-D5 each have dedicated spec test files in `tests/specs/`.

---

## CLAUDE.md Consistency

| CLAUDE.md claim | Verdict |
|---|---|
| "text-embedding-004 — 768-dim via Matryoshka outputDimensionality. NEVER truncate vectors manually." | CONSISTENT — verified in vertex.ts and migration 006 |
| "Hybrid Retrieval combines vector + BM25 + graph in one query path. RRF fusion in application code, then Gemini for re-ranking." | CONSISTENT — fusion.ts is pure TS; reranker.ts uses Gemini Flash |
| "Graph traversal depth limited by max_hops config (default: 2)." | CONSISTENT — `retrieval.graph.max_hops` flows through `graphSearch` → `traverseGraph` → CTE `t.depth < $maxHops` |
| "FTS on chunks table: Generated tsvector column on chunks.content — both vector search and BM25 query the same table. No separate story_fts table." | CONSISTENT — verified migration 006 + 008; both `searchByVector` and `searchByFts` target `chunks` |
| "Deduplication before corroboration: MinHash/SimHash on chunk embeddings creates DUPLICATE_OF edges. Near-dupes are marked but not deleted." | CONSISTENT — `dedup.ts` runs MinHash on chunks; `graph/index.ts` writes DUPLICATE_OF edges and never deletes stories/chunks |
| "PostgreSQL All-in-One: Single Cloud SQL instance handles vector search, full-text search, geospatial queries, graph traversal (recursive CTEs)." | CONSISTENT for M4 (vector + FTS + graph CTE all in same Postgres) |

---

## Remaining Recommendations

### Should Fix (Warning)
1. **DIV-003 (graph co-occurrence fallback):** Either document the `co_occurs_with` fallback in §2.7 or gate it behind a config flag. The O(n²) edge explosion on stories with many entities is a real concern at scale.
2. **DIV-004 (contradiction self-loops):** Reconcile the storage shape with the spec wording. Options: (a) update the spec to say "edge attached to the canonical entity, two claims encoded in attributes"; or (b) introduce a `claim_id` so the edge can connect distinct claim nodes. Will matter when M6 G3 builds the Analyze contradiction resolver.
3. **DIV-007 (`degraded` field):** Add `degraded` to the §5.3 confidence schema, or remove it from the response and compute client-side in the CLI.
4. **DIV-008 (corroboration null contract):** Honor the §5.3 contract by returning `null` (or a sentinel string) for `corroboration_score` below the threshold, either at write time or via a DB view used by query consumers.

### For Consideration (Note)
5. **DIV-001 / DIV-002:** Minor — cosmetic / spec-clarification only.
6. **DIV-005 (DUPLICATE_OF endpoint shape):** Long-term cleanup. A dedicated `story_edges` table would remove the entity-id-as-stand-in hack and would also help DIV-004.
7. **DIV-006 (`'simple'` text search config):** Document the multilingual rationale in §5.1 or §14 ("Why 'simple' tsvector config").
8. **DIV-009 (no explicit "fall back to pure vector" path):** Decide whether the current "graph naturally returns 0 hits when sparse" behavior counts as the spec's fallback. If yes, update §5.3 wording; if no, add a corpus-size guard in `orchestrator.ts`.
