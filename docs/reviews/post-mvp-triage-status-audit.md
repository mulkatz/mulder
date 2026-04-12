---
date: 2026-04-12
title: "Post-MVP Triage Status Audit"
scope: Follow-up audit of the 44 open findings from `post-mvp-qa-triage.md`
source_triage: "./post-mvp-qa-triage.md"
verdict: PARTIALLY_RESOLVED
---

# Post-MVP Triage Status Audit

## Executive Summary

This document re-checks the findings that were still open in
`docs/reviews/post-mvp-qa-triage.md` as of the Post-MVP QA Gate and classifies
their current repo status into one of five buckets:

- `resolved` — the underlying issue is now fixed and the repo contains clear evidence
- `partial` — meaningful progress landed, but part of the original finding still stands
- `open` — no sufficient fix found in the current repo state
- `unknown` — could not be closed or disproven from local repo inspection alone
- `no_action_needed` — the finding was intentionally by-design and did not require a code/doc change

Current tally across the 44 previously open findings:

| Status | Count |
|--------|-------|
| resolved | 27 |
| partial | 4 |
| open | 10 |
| unknown | 1 |
| no_action_needed | 2 |

**High-level verdict:** the repo has moved substantially since the original gate, and most of the important P1 work has landed. However, the triage is **not fully closed** yet. The biggest remaining follow-ups are:

1. `P6-DOCS-CLAUDE-01` — `CLAUDE.md` still references `terraform/modules/`, but no such directory exists
2. `M4-DIV-008` / `P4-RETRIEVAL-NEGATIVE-QUERY-01` — negative-query behavior improved, but the original storage-layer concern is only partially addressed
3. Several lower-priority hygiene items remain open: duplicate-numbered tests, CLI help examples, some `@reserved` tags, and a few known eval/doc gaps

## Method

This audit is based on:

- direct inspection of the current repository state on 2026-04-12
- comparison against `docs/reviews/post-mvp-qa-triage.md`
- spot checks of the affected code paths, specs, migrations, and docs
- targeted verification runs of the most relevant spec suites:
  - `tests/specs/08_core_schema_migrations.test.ts`
  - `tests/specs/13_gcp_service_implementations.test.ts`
  - `tests/specs/29_enrich_step.test.ts`
  - `tests/specs/35_graph_step.test.ts`
  - `tests/specs/42_hybrid_retrieval_orchestrator.test.ts`

Result of that targeted run:

- `5` test files passed
- `114` tests passed

## Status Matrix

### Phase 1 — Baseline & Coverage Audit

| ID | Current Status | Notes |
|----|----------------|-------|
| `P1-BASELINE-FLAKE-01` | `resolved` | `tests/specs/08_core_schema_migrations.test.ts` now re-migrates in `afterAll`, and downstream DB-backed suites call `ensureSchema()` from `tests/lib/schema.ts`. The original flake mechanism is addressed. |
| `P1-BASELINE-DUPNUM-01` | `open` | Duplicate-numbered test files still exist (`22`, `34`, `35`, `36`, `37`). Historical artifact remains. |
| `P1-BASELINE-PDF-NOISE-01` | `no_action_needed` | Still by design: corrupt-PDF tests intentionally emit warning noise while exercising the error path. |
| `P1-COVERAGE-ERRCODE-01` | `open` | The repo still has ACTIVE/RESERVED auditing, but not a per-error-code "triggered by a test" tracking matrix. |
| `P1-COVERAGE-CONFIG-EDGE-01` | `partial` | Config edge coverage improved: minimal config is tested, `MULDER_CONFIG` env loading is tested, and defaults are exercised. But broader unknown-key / additional edge-case coverage is still not evident from the current suite. |

### Phase 2 — M3 Milestone Review

| ID | Current Status | Notes |
|----|----------------|-------|
| `M3-DIV-001` | `resolved` | The previous drift around a segment-level `author` field is no longer present as an active mismatch in the current segment surface/specs. |
| `M3-DIV-002` | `resolved` | The spec now explicitly documents that `pages` is intentionally a contiguous range rather than a gap-aware explicit list. |
| `M3-DIV-003` | `resolved` | Enrich now performs the hard token-budget check via `services.llm.countTokens()` instead of the old `chars / 4` heuristic. |
| `M3-DIV-004` | `resolved` | The taxonomy normalization result is now consumed by Enrich and persisted through `taxonomy_id`. |
| `M3-DIV-005` | `open` | The implementation still runs Tier 3 only with Tier-2 near-miss candidates, while the current spec wording allows additional fallback behavior. This remains a documentation/contract mismatch. |
| `M3-DIV-006` | `resolved` | Deadlock-prevention wording is now aligned to `(type, name)`, matching the implementation. |
| `M3-DIV-007` | `open` | Relationship attributes remain permissive (`passthrough` / record-of-unknown), so the limitation still stands. |
| `M3-DIV-008` | `resolved` | `packages/taxonomy/src/bootstrap.ts` and `packages/taxonomy/src/merge.ts` now exist, so this is no longer a placeholder-only layout. |
| `M3-DIV-009` | `resolved` | Same root cause as `M3-DIV-004`; the normalization result now flows into persisted entity state via `taxonomy_id`. |
| `M3-DIV-010` | `resolved` | The suspicious `ExpectedRelationship` import is no longer present in the previously flagged location. |

### Phase 2 — M4 Milestone Review

| ID | Current Status | Notes |
|----|----------------|-------|
| `M4-DIV-001` | `no_action_needed` | Still an implementation-detail note, not a defect. |
| `M4-DIV-002` | `open` | Question chunks still reset `chunkIndex` from `0` in `packages/pipeline/src/embed/index.ts`. This remains harmless but unresolved hygiene debt. |
| `M4-DIV-003` | `resolved` | The `co_occurs_with` fallback is now gated behind `graph.cooccurrence_fallback`, default off. |
| `M4-DIV-004` | `resolved` | The spec and functional spec now document contradiction edges as self-loops attached to the canonical entity, matching the code. |
| `M4-DIV-005` | `open` | The story-level-via-entity-edge shape for `DUPLICATE_OF` remains; no structural follow-up was found. |
| `M4-DIV-006` | `resolved` | The `simple` FTS dictionary is now explicitly documented as an intentional multilingual choice. |
| `M4-DIV-007` | `resolved` | The `confidence.degraded` field is now documented in the functional/spec surfaces. |
| `M4-DIV-008` | `partial` | Retrieval response gating improved, but the original storage-layer concern is not fully closed: `corroboration_score` is still always persisted numerically rather than being nulled below the meaningful threshold. |
| `M4-DIV-009` | `resolved` | The functional spec now explains sparse-graph behavior as an emergent fallback rather than a separate hardcoded branch. |

### Phase 4 — GCP Smoketest

| ID | Current Status | Notes |
|----|----------------|-------|
| `P4-GCP-DOCAI-REGION-01` | `resolved` | `gcp.document_ai.location` is now part of config/service wiring and used for processor/client construction. |
| `P4-EXTRACT-CANVAS-01` | `resolved` | Extract now uses `@napi-rs/canvas` rather than the old `canvas` native module path that failed in the smoketest. |
| `P4-SEGMENT-NO-IMAGES-01` | `resolved` | This was downstream of the canvas problem; with the page-rendering path migrated, the original blocker is addressed. |
| `P4-ENRICH-CROSS-STORY-DEDUP-01` | `resolved` | The cross-story taxonomy link now exists and is tested through `taxonomy_id`, addressing the observed dedup failure mode. |
| `P4-ENRICH-ENTITY-QUALITY-01` | `unknown` | This was a prompt-quality finding. No fresh real-corpus eval in the repo proves it fixed or still reproduces, so it remains unverified from local inspection alone. |
| `P4-RETRIEVAL-NEGATIVE-QUERY-01` | `partial` | A negative-query gate now exists, but it is opt-in via `retrieval.rerank.min_score > 0`. The original finding's "returns topK even for off-corpus queries" behavior still exists under the default config (`min_score = 0.0`). |
| `P4-STORAGE-PATH-UUID-MISMATCH-01` | `resolved` | Ingest now uses `raw/{sourceId}/original.pdf`, and the corresponding test asserts that pattern. |

### Phase 5 — Quality Evaluation

| ID | Current Status | Notes |
|----|----------------|-------|
| `P5-EVAL-DOCUMENT-TYPE-01` | `open` | No follow-up was found that either revises the golden annotation or changes prompt behavior for `document` entities. |
| `P5-EVAL-RETRIEVAL-DEFERRED-01` | `open` | No later fixture-seeded real-GCP retrieval baseline run is recorded in the repo. |

### Phase 6 — Documentation Audit

| ID | Current Status | Notes |
|----|----------------|-------|
| `P6-DOCS-README-01` | `resolved` | README status badge now shows `v1.0_complete`. |
| `P6-DOCS-README-02` | `resolved` | README milestone/status prose has been updated. |
| `P6-DOCS-README-04` | `resolved` | Capabilities 11 and 12 are now explicitly marked `v3.0 / Phase 2`. |
| `P6-DOCS-CLAUDE-01` | `open` | `CLAUDE.md` still references `terraform/modules/` in multiple places, but the directory is absent from the repo. |
| `P6-DOCS-CLAUDE-02` | `partial` | The original "implemented M4 codes still marked reserved" problem is improved, but not fully gone: `PIPELINE_RATE_LIMITED` still carries an `@reserved` tag even though D6 is implemented. |
| `P6-DOCS-CLAUDE-03` | `resolved` | The `functional-spec-addendum.md` filename is now correct in the previously flagged architecture doc reference. |
| `P6-DOCS-CONFIG-01` | `resolved` | `ef_search` is now documented in the example config. |
| `P6-DOCS-ROADMAP-01` | `resolved` | The Post-MVP QA Gate is now represented in `docs/roadmap.md`. |
| `P6-DOCS-CLI-01` | `open` | No `.addHelpText('after', ...)` usage was found in the CLI command definitions, so the examples gap remains. |
| `P6-DOCS-DEVLOG-01` | `resolved` | There is now a dedicated devlog entry for the graph step. |
| `P6-DOCS-SPEC-01` | `resolved` | `docs/specs/43_retrieval_metrics.spec.md`, `44_e2e_pipeline_integration.spec.md`, and `45_cli_config_smoke.spec.md` now exist. |

## Notable Evidence

### Examples of findings that are clearly resolved

- **Schema flake fixed**
  - `tests/specs/08_core_schema_migrations.test.ts`
  - `tests/lib/schema.ts`

- **Token counting moved to the real tokenizer**
  - `packages/pipeline/src/enrich/index.ts`

- **Taxonomy normalization now persists a durable link**
  - `packages/core/src/database/migrations/018_entity_taxonomy_link.sql`
  - `packages/pipeline/src/enrich/index.ts`
  - `tests/specs/29_enrich_step.test.ts`

- **Graph co-occurrence fallback is now opt-in**
  - `packages/pipeline/src/graph/index.ts`
  - `tests/specs/35_graph_step.test.ts`

- **Document AI location mismatch fixed**
  - `packages/core/src/shared/services.gcp.ts`
  - `tests/specs/13_gcp_service_implementations.test.ts`

- **Negative-query gate added**
  - `packages/retrieval/src/orchestrator.ts`
  - `tests/specs/42_hybrid_retrieval_orchestrator.test.ts`

### Examples of findings that are still not fully closed

- **Storage-layer corroboration contract**
  - `packages/pipeline/src/graph/corroboration.ts`
  - current implementation still persists numeric `corroboration_score` values unconditionally

- **Terraform references in contributor docs**
  - `CLAUDE.md`
  - references remain despite the repo lacking a `terraform/` directory

- **CLI usage examples**
  - no `.addHelpText('after', ...)` usage found in `apps/cli/src`

## Recommended Follow-Up Queue

If this audit is used to drive a cleanup pass, the most sensible order is:

1. Close the remaining doc mismatch in `CLAUDE.md` (`P6-DOCS-CLAUDE-01`)
2. Decide whether `M4-DIV-008` should be fully closed by changing storage semantics, or explicitly narrowed to the query-response behavior now implemented
3. Decide whether the negative-query gate should remain opt-in or become the default contract
4. Knock out the remaining hygiene items:
   - duplicate-numbered tests
   - CLI help examples
   - leftover `@reserved` annotations
5. Re-run the deferred eval/document-quality questions when convenient:
   - `P4-ENRICH-ENTITY-QUALITY-01`
   - `P5-EVAL-DOCUMENT-TYPE-01`
   - `P5-EVAL-RETRIEVAL-DEFERRED-01`

## Conclusion

The important takeaway is that the old triage is **substantially but not completely** burned down. Most of the serious implementation issues that would have affected M5/M6 quality have been addressed. What remains is mostly a mix of:

- one still-real contributor-doc bug
- two partially fixed retrieval/corroboration contract questions
- a handful of lower-priority hygiene and evaluation follow-ups

This document should be treated as the current "re-opened items" index rather than the original gate triage itself.
