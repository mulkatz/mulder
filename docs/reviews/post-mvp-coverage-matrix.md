---
phase: 1
title: "Post-MVP Test Coverage Matrix"
scope: M1 + M2 + M3 + Pre-Search QA Gate + M4 (48 roadmap steps)
date: 2026-04-08
---

# Post-MVP QA Gate — Phase 1: Coverage Matrix

Maps every roadmap step in M1–M4 (plus the Pre-Search QA Gate) to its corresponding test file in `tests/specs/`. Produces a gap list of:
- Roadmap steps without dedicated tests
- CLI commands without dedicated tests
- Error codes without triggering tests

Legend:
- ✅ — Test file exists and covers step (at least partially)
- ⚠️ — Test exists but coverage is partial / indirect
- ❌ — No dedicated test file
- N/A — Documentation-only step (fixtures, placeholders)

---

## 1. M1 — Foundation (11 steps)

| Step | What | Test file | Status |
|------|------|-----------|--------|
| A1 | Monorepo setup | `02_monorepo_setup.test.ts` | ✅ |
| A2 | Config loader + Zod schemas | `03_config_loader.test.ts` | ✅ |
| A3 | Custom error classes | `04_custom_error_classes.test.ts` | ✅ |
| A4 | Logger setup | `05_logger_setup.test.ts` | ✅ |
| A5 | CLI scaffold | `06_cli_scaffold.test.ts` | ✅ |
| A6 | Database client + migration runner | `07_database_client_migration_runner.test.ts` | ✅ |
| A7 | Core schema migrations (001–008) | `08_core_schema_migrations.test.ts` | ✅ |
| A8 | Job queue + pipeline tracking migrations (012–014) | `09_job_queue_pipeline_tracking_migrations.test.ts` | ✅ |
| A9 | Fixture directory structure | `10_fixture_directory_structure.test.ts` | ✅ |
| A10 | Service abstraction — interfaces, registry, rate-limiter, retry | `11_service_abstraction.test.ts` | ✅ |
| A11 | Docker Compose — pgvector + Firestore emulator | `12_docker_compose.test.ts` | ✅ |

**M1 Coverage: 11/11 = 100% ✅**

---

## 2. M2 — Ingest + Extract (9 steps)

| Step | What | Test file | Status |
|------|------|-----------|--------|
| B1 | GCP + dev service implementations | `13_gcp_service_implementations.test.ts` | ✅ |
| B2 | Source repository | `14_source_repository.test.ts` | ✅ |
| B3 | Native text detection | `15_native_text_detection.test.ts` | ✅ |
| B4 | Ingest step | `16_ingest_step.test.ts` | ✅ |
| B5 | Vertex AI wrapper + dev cache | `17_vertex_ai_wrapper_dev_cache.test.ts` | ✅ |
| B6 | Prompt template engine | `18_prompt_template_engine.test.ts` | ✅ |
| B7 | Extract step | `19_extract_step.test.ts` | ✅ |
| B8 | Fixture generator | `20_fixture_generator.test.ts` | ✅ |
| B9 | Golden test set: extraction | `21_golden_test_set_extraction.test.ts` | ✅ |

**M2 Coverage: 9/9 = 100% ✅**

---

## 3. M3 — Segment + Enrich (10 steps)

| Step | What | Test file | Status |
|------|------|-----------|--------|
| C1 | Story repository | `22_story_repository.test.ts` | ✅ |
| C2 | Segment step | `23_segment_step.test.ts` | ✅ |
| C3 | Entity + alias repositories | `24_entity_alias_repositories.test.ts` | ✅ |
| C4 | Edge repository | `25_edge_repository.test.ts` | ✅ |
| C5 | JSON Schema generator (zod-to-json-schema) | `26_json_schema_generator.test.ts` | ✅ |
| C6 | Taxonomy normalization (pg_trgm) | `27_taxonomy_normalization.test.ts` | ✅ |
| C7 | Cross-lingual entity resolution (3-tier) | `28_cross_lingual_entity_resolution.test.ts` | ✅ |
| C8 | Enrich step | `29_enrich_step.test.ts` | ✅ |
| C9 | Cascading reset function (PL/pgSQL) | `30_cascading_reset_function.test.ts` | ✅ |
| C10 | Golden test set: segmentation + entities | `31_golden_test_set_segmentation_entities.test.ts` | ✅ |

**M3 Coverage: 10/10 = 100% ✅**

**Orphan test file:** `22_pdf_metadata_extraction.test.ts` — does not map to a numbered roadmap step. Inferred origin: the DIV-004 fix from M2 Review (PR #45) added `pdf-lib` metadata extraction for PDF bomb protection. The test was added for that fix without a new roadmap step. **Classification: legitimate test for bug-fix behavior, not a gap.**

---

## 4. Pre-Search QA Gate (6 steps)

| Step | What | Test file | Status |
|------|------|-----------|--------|
| QA-1 | Schema conformance (DDL vs TS vs §4.3) | `33_qa_schema_conformance.test.ts` | ✅ |
| QA-2 | Status state machine (source + story transitions) | `34_qa_status_state_machine.test.ts` | ✅ |
| QA-3 | Cascading reset — all 5 paths end-to-end | `35_qa_cascading_reset.test.ts` | ✅ |
| QA-4 | Cross-step pipeline integration (ingest→enrich→chunk) | `36_qa_pipeline_integration.test.ts` | ✅ |
| QA-5 | Error code coverage audit | `37_qa_error_code_coverage.test.ts` | ✅ |
| QA-6 | Known issues triage + documentation | `docs/reviews/qa-gate-triage.md` | N/A (doc-only) |

**QA Gate Coverage: 5/5 testable steps = 100% ✅**

---

## 5. M4 — v1.0 MVP Search (11 steps)

| Step | What | Test file(s) | Status |
|------|------|--------------|--------|
| D1–D3 | Embedding wrapper + semantic chunker + chunk repo | `32_embedding_wrapper_semantic_chunker_chunk_repository.test.ts` | ✅ |
| D4 | Embed step | `34_embed_step.test.ts` | ✅ |
| D5 | Graph step (dedup + corroboration + contradiction flagging) | `35_graph_step.test.ts` | ✅ |
| D6 | Pipeline orchestrator (cursor-based) | `36_pipeline_orchestrator.test.ts` | ✅ |
| D7 | Full-text search (generated tsvector on chunks) | `38_fulltext_search_retrieval.test.ts` | ✅ |
| E1 | Vector search (HNSW, pgvector cosine) | `37_vector_search_retrieval.test.ts` | ✅ |
| E2 | Full-text search wrapper (BM25) | `38_fulltext_search_retrieval.test.ts` | ⚠️ (shared with D7) |
| E3 | Graph traversal (recursive CTE) | `39_graph_traversal_retrieval.test.ts` | ⚠️ (flaky — see baseline §8) |
| E4 | RRF fusion | `40_rrf_fusion.test.ts` | ✅ |
| E5 | LLM re-ranking (Gemini Flash) | `41_llm_reranking.test.ts` | ✅ |
| E6 | Hybrid retrieval orchestrator (`mulder query`) | `42_hybrid_retrieval_orchestrator.test.ts` | ✅ |

**M4 Coverage: 11/11 = 100% ✅ (with flake caveat on E3)**

**Notes:**
- D7 and E2 are covered by the same test file (`38_fulltext_search_retrieval.test.ts`), which exercises both the DDL (D7) and the application layer (E2). Marked as ⚠️ for E2 because the single test file bundles both concerns rather than splitting them.
- E3 has a test file but it is **flaky in full-suite runs** (see baseline report §8). The test logic itself is correct; the infrastructure around it (test-isolation) is fragile.

---

## 6. Overall Roadmap Step Coverage

| Milestone | Steps | Tested | Partial | Missing | Coverage |
|-----------|-------|--------|---------|---------|----------|
| M1 Foundation | 11 | 11 | 0 | 0 | 100% |
| M2 Ingest+Extract | 9 | 9 | 0 | 0 | 100% |
| M3 Segment+Enrich | 10 | 10 | 0 | 0 | 100% |
| Pre-Search QA Gate | 5 (testable) | 5 | 0 | 0 | 100% |
| M4 v1.0 MVP | 11 | 9 | 2 | 0 | 100% (82% clean) |
| **Total (48 steps, 46 testable)** | **46** | **44** | **2** | **0** | **100%** |

---

## 7. CLI command coverage

Twelve CLI commands in `apps/cli/src/commands/`:

| Command | File | Dedicated test? |
|---------|------|-----------------|
| `mulder config {validate\|show}` | `config.ts` | ⚠️ indirect (via `03_config_loader.test.ts` + `06_cli_scaffold.test.ts`) |
| `mulder db {migrate\|status}` | `db.ts` | ✅ (`07_database_client_migration_runner.test.ts`) |
| `mulder cache {clear\|stats}` | `cache.ts` | ✅ (`17_vertex_ai_wrapper_dev_cache.test.ts`) |
| `mulder fixtures {generate\|status}` | `fixtures.ts` | ✅ (`20_fixture_generator.test.ts`) |
| `mulder ingest <path>` | `ingest.ts` | ✅ (`16_ingest_step.test.ts`) |
| `mulder extract --source <id>` | `extract.ts` | ✅ (`19_extract_step.test.ts`) |
| `mulder segment --source <id>` | `segment.ts` | ✅ (`23_segment_step.test.ts`) |
| `mulder enrich --source <id>` | `enrich.ts` | ✅ (`29_enrich_step.test.ts`) |
| `mulder embed --source <id>` | `embed.ts` | ✅ (`34_embed_step.test.ts`) |
| `mulder graph --source <id>` | `graph.ts` | ✅ (`35_graph_step.test.ts`) |
| `mulder pipeline run` | `pipeline.ts` | ✅ (`36_pipeline_orchestrator.test.ts`) |
| `mulder query` | `query.ts` | ✅ (`42_hybrid_retrieval_orchestrator.test.ts`) |
| `mulder cli-smoke` (not a command — smoke test) | — | ✅ (`cli-smoke.test.ts`) |

**CLI Coverage: 11/12 ✅, 1 indirect ⚠️ (`config` command — tests exist but not for the command wrapper specifically).**

**Finding ID:** P1-COVERAGE-CLI-01
**Severity:** NOTE
**Title:** `mulder config` command has no dedicated black-box test
**Classification:** KNOWN LIMITATION — the `config.ts` command is a thin wrapper around `loadConfig()` which is covered extensively. The command-level test (invocation, flag parsing, output formatting) is missing.
**Suggested fix (deferred):** Add a small black-box test that runs `mulder config validate <fixture>` and `mulder config show <fixture>` and asserts on exit code + stdout structure.

---

## 8. Service interface coverage

From `packages/core/src/shared/services.ts`:

| Interface | Dev impl test | GCP impl test |
|-----------|---------------|---------------|
| `StorageService` | ✅ (`11_service_abstraction.test.ts`, `13_gcp_service_implementations.test.ts`) | ✅ |
| `DocumentAiService` | ✅ | ✅ |
| `LlmService` | ✅ (`17_vertex_ai_wrapper_dev_cache.test.ts`) | ✅ |
| `EmbeddingService` | ✅ (via chunker test) | ✅ |
| `FirestoreService` | ✅ | ✅ |

**Service Coverage: 5/5 interfaces ✅**

---

## 9. Error code trigger coverage

From `packages/core/src/shared/errors.ts`:

- **Total error codes defined:** 64
- **Marked `@reserved`:** 20 (future milestones: D6 orchestrator, F1 taxonomy bootstrap, M9 cross-format dedup, real GCP page rendering, etc.)
- **Active codes (currently thrown):** 44

The QA-21 audit test in `tests/specs/37_qa_error_code_coverage.test.ts` verifies that every code is either ACTIVE or RESERVED (no DEAD codes). Per the Pre-Search QA Gate Triage (Issue 4), this was the exit condition for the error code audit.

**Not audited here:** whether every ACTIVE code has a test that *triggers* it. The QA-21 audit verifies declaration and reference, not test-triggered runtime throws.

**Finding ID:** P1-COVERAGE-ERRCODE-01
**Severity:** NOTE
**Title:** 44 active error codes are declared and referenced, but per-code "triggered by a test" status is not tracked
**Classification:** KNOWN LIMITATION
**Suggested fix (deferred):** Add an optional assertion layer that captures `{code, thrown_in_test}` pairs via a test-side error listener, and diffs against the ACTIVE set. Nice-to-have, not required for gate.

---

## 10. Cascading reset path coverage

Per `docs/functional-spec.md` §4.3.1, the `reset_pipeline_step(source_id, step)` PL/pgSQL function has 5 paths:

| Step arg | Target scope | Covered in |
|----------|--------------|------------|
| `'ingest'` | Cascades delete down (all steps) | `30_cascading_reset_function.test.ts` + `35_qa_cascading_reset.test.ts` |
| `'extract'` | Reset stories + dependents | ✅ |
| `'segment'` | Reset enrich+embed+graph of stories | ✅ |
| `'enrich'` | Reset embed+graph of stories | ✅ |
| `'embed'` | Reset only embed + graph | ✅ (with DIV caveat — does NOT update `sources.status`, see QA Gate Triage Issue 2 — BY DESIGN) |
| `'graph'` | Reset only graph | ✅ (same caveat) |

All 5 paths have direct test coverage via QA-3 (`35_qa_cascading_reset.test.ts`). **Coverage: 5/5 ✅**

---

## 11. Config edge case coverage

Tests exist for:
- ✅ Valid config → loads and returns typed object (`03_config_loader.test.ts`)
- ✅ Invalid config → Zod validation error with clear message
- ✅ Missing required fields → specific field path in error

**Not tested:**
- ❌ Absolute-minimum config (only required fields, everything else defaults)
- ❌ Unknown top-level keys (does Zod allow or reject?)
- ❌ Env-var override precedence (if any exists)

**Finding ID:** P1-COVERAGE-CONFIG-EDGE-01
**Severity:** NOTE
**Title:** Config loader edge cases (minimal, unknown keys, env overrides) not tested
**Classification:** KNOWN LIMITATION
**Suggested fix (deferred to Phase 3):** Add 3 small tests in `03_config_loader.test.ts` or a new file.

---

## 12. End-to-End pipeline integration

**Finding ID:** P1-COVERAGE-E2E-01
**Severity:** WARNING
**Title:** No single test file exercises the full pipeline flow `ingest → extract → segment → enrich → embed → graph → query`
**Evidence:**
- `36_qa_pipeline_integration.test.ts` covers the cross-step QA-4 path (ingest→enrich→chunk round-trip) from Pre-Search QA Gate but does NOT include `embed`, `graph`, or `query`.
- `36_pipeline_orchestrator.test.ts` (D6) tests the orchestrator but against mocked or partial data, not a full flow.
- `42_hybrid_retrieval_orchestrator.test.ts` (E6) tests query-time behavior but assumes chunks already exist — it does not ingest a fresh PDF end-to-end.
**Classification:** GAP (legitimate missing test)
**Suggested fix (Phase 3):** Write `tests/specs/43_e2e_pipeline_integration.test.ts` per the plan — this is deliverable D6 of Phase 3.

---

## 13. Retrieval quality (golden set) coverage

**Finding ID:** P1-COVERAGE-RETRIEVAL-GOLDEN-01
**Severity:** WARNING
**Title:** No golden set or quality metrics for retrieval (precision@k, recall@k, MRR, nDCG)
**Evidence:**
- `eval/golden/` has `extraction/`, `segmentation/`, `entities/` directories only. No `retrieval/`.
- `packages/eval/src/` has metric runners for extraction, segmentation, entities. No retrieval runner.
- `eval/metrics/baseline.json` does not include a retrieval section.
**Classification:** GAP (legitimate missing evaluation)
**Suggested fix (Phase 3):** Build golden retrieval set + runner per Phase 3 deliverable D5. This is the most significant QA gap in the MVP — we cannot currently measure whether search results are getting better or worse between code changes.

---

## 14. Summary of Phase 1 findings

| ID | Severity | Title | Phase for fix |
|----|----------|-------|---------------|
| P1-BASELINE-FLAKE-01 | WARNING | Spec 39 flake — 67% fail rate | Post-gate |
| P1-BASELINE-DUPNUM-01 | NOTE | Duplicate-numbered test files (22, 34-37) | Post-gate hygiene |
| P1-BASELINE-PDF-NOISE-01 | NOTE | pdf-parse log noise in spec 15 | Never / logger tweak |
| P1-COVERAGE-CLI-01 | NOTE | `mulder config` command no dedicated test | Post-gate |
| P1-COVERAGE-ERRCODE-01 | NOTE | Per-code test-triggered status not tracked | Nice-to-have |
| P1-COVERAGE-CONFIG-EDGE-01 | NOTE | Config edge cases not tested | Phase 3 |
| P1-COVERAGE-E2E-01 | WARNING | No full-pipeline E2E test | Phase 3 (D6) |
| P1-COVERAGE-RETRIEVAL-GOLDEN-01 | WARNING | No golden set for retrieval quality | Phase 3 (D5) |

**Total findings: 8** — 3 WARNING, 5 NOTE, 0 CRITICAL.

---

## 15. Exit

Phase 1 Coverage audit complete. All 48 roadmap steps have been mapped to test files (46 testable, 2 documentation-only). Coverage is surprisingly thorough — 100% step-level coverage with well-scoped per-spec test files. The three WARNING-level gaps are known and targeted by Phase 3 deliverables (D5 retrieval golden set, D6 E2E test) plus the post-gate flake fix.

**Ready for Phase 2: Milestone Reviews M3 + M4.**
