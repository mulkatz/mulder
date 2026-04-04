---
spec: 33
title: "QA Gate: Pre-Search Verification Checkpoint"
roadmap_step: QA-1 through QA-6
functional_spec: ["§2.1-§2.4", "§2.6", "§3.2", "§3.4", "§4.3", "§4.3.1", "§6.2", "§7.1", "§7.2"]
scope: verification
created: 2026-04-04
issue: https://github.com/mulkatz/mulder/issues/69
---

# Spec 33 — QA Gate: Pre-Search Verification Checkpoint

## 1. Objective

Verify that the 31 completed roadmap steps (M1-M3 + D1-D3) are 100% spec-conformant before building search/retrieval on top. This is a quality gate — the deliverables are test files and a triage document, not production code. If bugs are found, they are fixed in the same PR.

The gate validates five domains: schema conformance, status state machine, cascading resets, cross-step pipeline integration, and error code coverage. A sixth step documents the triage of known issues discovered during exploration.

## 2. Boundaries

### In scope
- Database schema audit (DDL vs TypeScript types vs functional spec §4.3)
- Source and story status transition verification across all implemented steps
- Cascading reset correctness for all 5 reset paths (extract/segment/enrich/embed/graph)
- End-to-end pipeline integration (ingest→extract→segment→enrich→chunk creation)
- Error code completeness audit (defined vs thrown vs reserved)
- Known issues triage document

### Out of scope
- New features or production code changes (unless bugs are found)
- Performance testing or benchmarking
- Prompt quality or LLM output evaluation (that's the eval framework's domain)
- D4+ functionality (embed execute, search, retrieval)
- Security audit

### CLI commands affected
None — this spec produces test code only.

## 3. Dependencies

### Requires (must exist)
- All M1 steps (A1-A11): monorepo, config, errors, logger, CLI, database, migrations, fixtures, services, docker-compose
- All M2 steps (B1-B9): GCP services, source repo, ingest, extract, Vertex AI, prompts, fixtures, golden extraction tests
- All M3 steps (C1-C10): story repo, segment, entities, edges, JSON schema, taxonomy, entity resolution, enrich, cascading reset, golden entity tests
- D1-D3: chunk types, chunk repository, semantic chunker, embedding wrapper
- Docker-compose PostgreSQL running

### Required by (gate must pass before)
- D4: Embed step `execute()` — the first step to build after the gate passes
- All subsequent M4 steps (D5-E6)

## 4. Blueprint

### 4.1 Schema Conformance (QA-1) — `tests/specs/33_qa_schema_conformance.test.ts`

Query PostgreSQL `information_schema.columns` and `pg_indexes` via `docker exec psql`. Compare against TypeScript type definitions and functional spec §4.3.

**Tables to verify:** sources, source_steps, stories, entities, entity_aliases, story_entities, entity_edges, chunks, taxonomy, jobs, pipeline_runs, pipeline_run_sources

**For each table:**
- Column count matches between DDL and TypeScript row type
- Column names (snake_case) map correctly to TypeScript properties (camelCase)
- Data types match: TEXT→string, UUID→string, INTEGER→number, FLOAT→number, BOOLEAN→boolean, TIMESTAMPTZ→Date, JSONB→Record<string,unknown>, TEXT[]→string[], vector(768)→string|number[]
- Nullable columns correspond to `| null` in TypeScript types

**Index verification:**
- HNSW index on `chunks.embedding` with `vector_cosine_ops`, m=16, ef_construction=64
- GIN index on `chunks.fts_vector`
- GIN index on `entities.name` with `gin_trgm_ops`
- GIN index on `taxonomy.canonical_name` with `gin_trgm_ops`
- B-tree indexes on high-cardinality FK columns

**FK cascade verification:**
- `stories.source_id → sources(id)` — NO CASCADE (managed by reset function)
- `entity_aliases.entity_id → entities(id) ON DELETE CASCADE`
- `story_entities.story_id → stories(id) ON DELETE CASCADE`
- `entity_edges.story_id → stories(id) ON DELETE CASCADE`
- `chunks.story_id → stories(id) ON DELETE CASCADE`
- `chunks.parent_chunk_id → chunks(id) ON DELETE CASCADE`
- `source_steps.source_id → sources(id) ON DELETE CASCADE`

**Enum verification:**
- `TaxonomyStatus` ('auto'|'curated'|'merged') at `entity.types.ts:18` — entity-level lifecycle
- `TaxonomyEntryStatus` ('auto'|'confirmed'|'rejected') at `taxonomy.types.ts:16` — taxonomy entry curation lifecycle
- These are intentionally DIFFERENT enums tracking different concepts (verify against §6.2)

### 4.2 Status State Machine (QA-2) — `tests/specs/34_qa_status_state_machine.test.ts`

Run the pipeline via CLI subprocess on a fixture PDF. Verify database state at each checkpoint.

**Pipeline sequence:**
1. `mulder ingest <fixture.pdf>` → `sources.status = 'ingested'`, `source_steps` has 'ingest'='completed'
2. `mulder extract <source-id>` → `sources.status = 'extracted'`, no stories yet
3. `mulder segment <source-id>` → `sources.status = 'segmented'`, stories with `status = 'segmented'`
4. `mulder enrich --source <source-id>` → stories `status = 'enriched'`, BUT `sources.status` REMAINS 'segmented'
5. Verify `source_steps` has entries for ingest, extract, segment, enrich — all with `status = 'completed'`

**Key assertion for step 4:** `sources.status` staying at 'segmented' after enrich is BY DESIGN. The enrich step operates on stories, not sources. The pipeline orchestrator (D6, not yet built) is responsible for advancing source status. This matches §2.4 step 10 ("Update story status to enriched") and §3.2 (orchestrator advances source status).

### 4.3 Cascading Reset (QA-3) — `tests/specs/35_qa_cascading_reset.test.ts`

Seed the database with a complete data chain via SQL INSERTs: source → stories → entities → entity_aliases → story_entities → entity_edges → chunks → source_steps. Then test each reset path.

**For each of the 5 reset types, verify:**

| Reset | Deletes | Resets status to | source_steps removed |
|-------|---------|-----------------|---------------------|
| extract | stories (cascades to chunks, story_entities, edges) + ALL source_steps | sources→'ingested' | ALL |
| segment | stories (cascades) | sources→'extracted' | segment, enrich, embed, graph |
| enrich | story_entities, entity_edges | stories→'segmented', sources→'segmented' | enrich, embed, graph |
| embed | chunks | stories→'enriched' | embed, graph |
| graph | entity_edges | stories→'embedded' | graph |

**Note:** embed and graph resets do NOT update `sources.status`. This matches spec §4.3.1 exactly.

**GC verification:** After enrich reset, entities with zero story_entities links become orphans. `SELECT gc_orphaned_entities()` should return the count of deleted orphans.

### 4.4 Cross-Step Pipeline Integration (QA-4) — `tests/specs/36_qa_pipeline_integration.test.ts`

End-to-end pipeline run on fixture data. Steps 1-4 use CLI subprocess, step 5 imports D1-D3 modules directly (no CLI surface yet).

**Verification chain:**
1. Pipeline produces valid DB records at every stage
2. FK integrity: no orphaned chunks, story_entities, or entity_edges (verified by JOIN queries that must return rows)
3. The retrieval join path works: `SELECT c.id, c.content, s.title, e.name FROM chunks c JOIN stories s ON c.story_id = s.id JOIN story_entities se ON s.id = se.story_id JOIN entities e ON se.entity_id = e.id` returns rows
4. Idempotent re-run: running enrich --source again does not create duplicate entities (verify entity count is unchanged)

### 4.5 Error Code Coverage (QA-5) — `tests/specs/37_qa_error_code_coverage.test.ts`

Static analysis of source files. Parse error codes from `packages/core/src/shared/errors.ts`, then search all `.ts` files for usage.

**Classification:**
- ACTIVE: Code appears in a `throw new` statement or error constructor
- RESERVED: Code has a `@reserved` JSDoc annotation explaining its future purpose
- DEAD: Neither thrown nor annotated — must not exist

**Known reserved codes (6):**
| Code | Reserved for |
|------|-------------|
| `INGEST_DUPLICATE` | M9 cross-format dedup |
| `EXTRACT_PAGE_RENDER_FAILED` | Real GCP page rendering failures |
| `ENRICH_VALIDATION_FAILED` | Gemini structured output validation |
| `EMBED_STORY_NOT_FOUND` | D4 embed step execute() |
| `EMBED_QUESTION_GENERATION_FAILED` | D4 embed step execute() |
| `EMBED_CHUNK_WRITE_FAILED` | D4 embed step execute() |

**Implementation must add `@reserved` annotations** to these 6 codes in `errors.ts` before the test runs.

### 4.6 Known Issues Triage (QA-6) — `docs/reviews/qa-gate-triage.md`

Document classifying each of 5 known issues found during exploration:

1. **TaxonomyStatus vs TaxonomyEntryStatus** — BY DESIGN: different enums for entity-level vs taxonomy-entry-level lifecycle
2. **Embed/graph resets don't update sources.status** — BY DESIGN: matches spec §4.3.1 exactly
3. **Enrich doesn't advance sources.status** — BY DESIGN: orchestrator (D6) handles source status advancement
4. **6 error codes defined but never thrown** — RESERVED: documented with `@reserved` annotations for future steps
5. **Fixtures disconnected from real PDFs** — KNOWN LIMITATION: not a code correctness concern, to be addressed when `mulder fixtures generate` runs against real GCP

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | All tables have correct column count | Migrations applied | Query information_schema.columns per table | Column count matches TypeScript row type field count |
| QA-02 | Column types match TypeScript | Migrations applied | Query column data types | TEXT→string, UUID→string, INTEGER→number, FLOAT→number, BOOLEAN→boolean, TIMESTAMPTZ→Date |
| QA-03 | FK cascades match spec | Migrations applied | Query referential_constraints | CASCADE on entity_aliases, story_entities, entity_edges.story_id, chunks.story_id, chunks.parent_chunk_id, source_steps |
| QA-04 | HNSW index exists with correct params | Migrations applied | Query pg_indexes for chunks_embedding | HNSW with vector_cosine_ops, m=16, ef_construction=64 |
| QA-05 | GIN indexes exist | Migrations applied | Query pg_indexes | GIN on chunks.fts_vector, entities.name (trgm), taxonomy.canonical_name (trgm) |
| QA-06 | Taxonomy enums intentionally different | Read type definitions | Compare TaxonomyStatus vs TaxonomyEntryStatus | Different values, both valid per spec |
| QA-07 | Ingest sets correct status | Ingest a fixture PDF | Query sources.status | 'ingested' with source_step 'ingest'='completed' |
| QA-08 | Extract advances source status | Extract the source | Query sources.status | 'extracted', no stories yet |
| QA-09 | Segment creates stories | Segment the source | Query sources.status + stories | 'segmented', stories with status='segmented' |
| QA-10 | Enrich updates story not source | Enrich all stories | Query sources.status + stories.status | stories='enriched', sources STILL 'segmented' |
| QA-11 | source_steps tracks all completed steps | Full pipeline run | Query source_steps | Entries for ingest, extract, segment, enrich all 'completed' |
| QA-12 | Extract reset cascades correctly | Seeded data chain | reset_pipeline_step(id, 'extract') | Stories+chunks+edges deleted, source→'ingested', all source_steps deleted |
| QA-13 | Segment reset cascades correctly | Seeded data chain | reset_pipeline_step(id, 'segment') | Stories deleted, source→'extracted', segment/enrich/embed/graph steps deleted |
| QA-14 | Enrich reset cascades correctly | Seeded data chain | reset_pipeline_step(id, 'enrich') | story_entities+edges deleted, stories→'segmented', source→'segmented', enrich/embed/graph steps deleted |
| QA-15 | Embed reset cascades correctly | Seeded data chain | reset_pipeline_step(id, 'embed') | Chunks deleted, stories→'enriched', source status unchanged, embed/graph steps deleted |
| QA-16 | Graph reset cascades correctly | Seeded data chain | reset_pipeline_step(id, 'graph') | Entity edges deleted, stories→'embedded', source status unchanged, graph step deleted |
| QA-17 | GC removes orphaned entities | Enrich reset leaves orphans | gc_orphaned_entities() | Returns count > 0, orphans deleted |
| QA-18 | Pipeline produces FK-consistent state | Full pipeline + chunking | JOIN query across chunks→stories→story_entities→entities | Returns rows, no orphans |
| QA-19 | Retrieval join path works | Chunks with stories and entities exist | Cross-table SELECT | Returns chunk content + story title + entity name |
| QA-20 | Idempotent re-enrich | Enrich run twice on same source | Count entities before and after | Entity count unchanged (upsert, no duplicates) |
| QA-21 | All error codes are ACTIVE or RESERVED | errors.ts parsed | Search all .ts files for usage | No DEAD codes (every code either thrown or @reserved-annotated) |
| QA-22 | Error classes use correct code types | errors.ts parsed | Check constructor calls | IngestError uses only IngestErrorCode, ExtractError uses only ExtractErrorCode, etc. |
| QA-23 | Triage document exists and is complete | QA-6 executed | Read docs/reviews/qa-gate-triage.md | All 5 known issues classified with evidence |

### 5b. CLI Test Matrix

N/A — no CLI commands created in this spec.

## 6. Gate Criteria

**PASS:** All QA-01 through QA-22 pass. QA-23 verified. No CRITICAL/HIGH bugs remain unfixed.

**FAIL:** Schema mismatch, cascade leaves orphans, FK violations, or unclassified error codes.

**After gate passes:** Continue with D4 (Embed step `execute()`).
