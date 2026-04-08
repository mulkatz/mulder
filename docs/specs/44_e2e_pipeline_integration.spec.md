---
spec: 44
title: End-to-End Pipeline Integration — ingest → extract → segment → enrich → embed → graph → query
roadmap_step: QA-Gate Phase 3 (D6)
functional_spec: §2 (pipeline step conventions), §2.1–§2.7 (step semantics), §3 (pipeline composition), §3.4 (cascading reset), §4.3.1 (source_steps table), §5 (hybrid retrieval)
scope: single
created: 2026-04-09
---

## 1. Objective

Retrospective QA contract for the full M1–M4 MVP pipeline integration test. This is the test that closed the Phase-1 coverage finding `P1-COVERAGE-E2E-01` — before it existed, no single test asserted on the full

```
ingest → extract → segment → enrich → embed → graph → query
```

flow *with status transitions, source_steps bookkeeping, pipeline_runs bookkeeping, and cascading reset*. Other integration tests stopped earlier in the pipeline (`36_qa_pipeline_integration.test.ts` ends at enrich/chunk join) or focused on retrieval quality rather than lifecycle (`42_hybrid_retrieval_orchestrator.test.ts`). This test's job is the **lifecycle assertions** — not retrieval quality.

System boundary: `node apps/cli/dist/index.js` subprocess + `docker exec mulder-pg-test psql` for DB state introspection. No internal source imports.

## 2. Boundaries

### In scope
- `sources.status` transitions at each step boundary: `ingested → extracted → segmented → enriched → embedded → graphed`
- `stories.status` transitions: segmented → enriched → embedded → graphed
- `source_steps` row created with `status='completed'` for every step in the pipeline
- `pipeline_runs` + `pipeline_run_sources` bookkeeping (cursor-based orchestrator contract)
- Chunk storage invariants: 768-dim `embedding` vector column, generated `fts_vector` tsvector column
- Cascading reset via `mulder pipeline reset --force` — downstream state cleared, upstream state preserved, re-runs complete successfully
- Final query state: `mulder query` returns ranked results from the corpus

### Out of scope
- Retrieval quality / re-ranking correctness (specs 37, 38, 39, 41, 42)
- Document AI Layout Parser correctness on scanned PDFs (native-text sample only; scanned PDF path covered separately)
- Entity extraction recall/precision (covered by golden entity eval, spec 31)
- Taxonomy bootstrap flow (M5)
- Analyze step (M6)

### Depends on
- `mulder-pg-test` Postgres container with `pgvector`, `postgis`, `pg_trgm` extensions and schema migrations applied
- Built CLI at `apps/cli/dist/index.js`
- Fixture `fixtures/raw/native-text-sample.pdf` (small native-text PDF, processed via the native path)
- `mulder.config.example.yaml` — used as the run config

## 5. QA Contract

Each `it()` in `tests/specs/44_e2e_pipeline_integration.test.ts` maps 1:1 to a QA condition below. The test shares corpus state across the flow — each condition runs the next pipeline step and verifies the DB transition.

### QA-01: Ingest creates sources row with status=ingested and file hash
**Given** the fixture PDF on disk
**When** `mulder ingest <pdf>` runs
**Then** a row exists in `sources` with `status='ingested'`, a non-null `file_hash`, and a GCS-style `storage_path`

### QA-02: Extract advances sources.status to extracted
**Given** the ingested source from QA-01
**When** `mulder extract <source-id>` runs
**Then** `sources.status` transitions to `'extracted'` and `source_steps` has a completed row for `step_name='extract'`

### QA-03: Segment creates stories with status=segmented
**Given** the extracted source from QA-02
**When** `mulder segment <source-id>` runs
**Then** `stories` has ≥1 row for that source with `status='segmented'`, each row has a GCS URI, and `source_steps` has a completed row for `step_name='segment'`

### QA-04: Enrich produces entities, edges, and story_entities rows
**Given** the segmented stories from QA-03
**When** `mulder enrich <source-id>` runs
**Then** `entities` has ≥1 row, `entity_aliases` links aliases to entities, `story_entities` has the join rows, `entity_edges` may or may not have rows depending on what the fixture yields, and every story advances to `status='enriched'`

### QA-05: Embed populates chunks with 768-dim vectors and fts_vector
**Given** the enriched stories from QA-04
**When** `mulder embed <source-id>` runs
**Then** `chunks` has ≥1 row per story, each with `array_length(embedding, 1) = 768`, `fts_vector` is non-null (generated tsvector column), and `stories.status='embedded'`

### QA-06: Graph step writes entity_edges and advances stories to graphed
**Given** the embedded stories from QA-05
**When** `mulder graph <source-id>` runs
**Then** `entity_edges` has ≥1 row with `edge_type IN ('RELATIONSHIP', 'DUPLICATE_OF', 'POTENTIAL_CONTRADICTION')` (depending on fixture content), and all stories advance to `status='graphed'`

### QA-07: source_steps has completed entries for every run step
**Given** the full pipeline has been run for one source
**When** `source_steps` is queried for that source
**Then** rows exist with `status='completed'` for `step_name` in `{extract, segment, enrich, embed, graph}` (ingest is tracked via `sources.status` directly, not in `source_steps`)

### QA-08: Cascading reset via --force clears downstream state cleanly
**Given** a fully processed source
**When** `mulder pipeline reset <source-id> --force --from enrich` runs
**Then** `source_steps` rows for `enrich`, `embed`, `graph` are removed or reset, downstream DB state (chunks, entity_edges, story_entities) is cleared, the source's extract and segment state is preserved, and `stories.status` is rolled back to `'segmented'`

### QA-09: Re-running full pipeline after --force completes without error
**Given** the source after the cascading reset from QA-08
**When** the full pipeline is re-run from enrich onward
**Then** every step completes with `status='completed'` in `source_steps`, and the final state matches QA-06 — i.e. the pipeline is idempotent under reset + re-run

### QA-10: Final state supports a query returning ranked results
**Given** a fully processed corpus with at least one story from the fixture
**When** `mulder query "<keyword from fixture>"` runs
**Then** the CLI exits 0, stdout contains ranked chunk results, and the result list is non-empty

## 5b. CLI Test Matrix

N/A — this spec exercises the CLI end-to-end but is not a CLI-contract test. Individual command flag combinations are covered by per-step specs (16 ingest, 19 extract, 23 segment, 29 enrich, 34 embed, 35 graph, 36 pipeline orchestrator, 42 query).

## Pass / Fail

- Pass: all 10 `it()` blocks in `tests/specs/44_e2e_pipeline_integration.test.ts` assert green against a clean `mulder-pg-test` container + built CLI
- Fail: any DB state mismatch, any step exits non-zero, or the cascading reset leaves orphaned state

## Out of scope

Entity quality, retrieval quality, and Document AI correctness on scanned PDFs are intentionally excluded from this spec. The goal is lifecycle and bookkeeping — "does every step transition the database as the spec describes" — not "does the content the pipeline produces meet quality bars". Quality is evaluated separately via `npx mulder eval` against golden sets.
