---
phase: 1
title: "Post-MVP Baseline & Health Check"
scope: M1 + M2 + M3 + Pre-Search QA Gate + M4 (48 roadmap steps)
date: 2026-04-08
tester: claude + franz
verdict: PASS_WITH_FINDINGS
---

# Post-MVP QA Gate — Phase 1: Baseline

## Executive Summary

The project is in a healthy state overall. Build, typecheck, and lint are fully green across all 11 workspaces. All 14 core migrations are idempotent. The test suite is predominantly green: **788 tests total, 48 test files**, with 100% of tests passing on clean runs.

**One material finding:** a **flaky test** (`tests/specs/39_graph_traversal_retrieval.test.ts`) that fails ~67% of the time in full-suite runs but passes 100% of the time when run in isolation. Root cause identified: test-isolation bug due to inter-file DB state pollution from `08_core_schema_migrations.test.ts` `afterAll` hook.

**Verdict:** PASS_WITH_FINDINGS — the MVP is healthy, but test reliability is degraded. No production code changes needed to proceed to Phase 2. The flake will be triaged in Phase 7 and fixed after gate verdict.

---

## 1. Environment

| Item | Value |
|------|-------|
| Node | `>=20.0.0` (engine), actual via `pnpm`: 25.5.0 |
| Package manager | pnpm 10.29.3 |
| Workspaces | 11 |
| Build orchestrator | Turbo 2.9.1 |
| Test runner | Vitest 4.1.2 |
| Linter | Biome 2.4.10 |
| TypeScript | 6.0.2 |
| PostgreSQL | 17.9 (Debian) via `mulder-pg-test` container |
| Extensions | `pg_trgm 1.6`, `plpgsql 1.0`, `postgis 3.6.2`, `vector 0.8.2` |

---

## 2. Fresh install

```
pnpm install --frozen-lockfile
# Scope: all 11 workspace projects
# Lockfile is up to date, resolution step is skipped
# Done in 352ms
```

**Result:** ✅ Clean. Lockfile is in sync with `package.json` files across all workspaces.

---

## 3. Build (forced, no cache)

```
pnpm build --force
# Tasks: 9 successful, 9 total
# Cached: 0 cached, 9 total
# Time: 2.165s
```

**Packages built (all from scratch):**
- `@mulder/core`
- `@mulder/evidence`
- `@mulder/taxonomy`
- `@mulder/retrieval`
- `@mulder/pipeline`
- `@mulder/eval`
- `@mulder/worker`
- `@mulder/cli`
- `@mulder/api`

**Result:** ✅ 9/9 green, zero TypeScript errors, 2.165s wall clock.

---

## 4. Typecheck

```
pnpm typecheck
# Tasks: 16 successful, 16 total
# Cached: 16 cached, 16 total (FULL TURBO)
```

**Result:** ✅ 16/16 green. (Cached from most recent successful build — verified non-cached via force build above.)

---

## 5. Lint

```
pnpm lint
# Biome check on 202 files
# No fixes applied
```

**Result:** ✅ 0 findings across 202 files.

---

## 6. Database migrations

### 6.1 State before Phase 1

14 migrations already applied in `mulder-pg-test`:

| # | File | Applied |
|---|------|---------|
| 1 | 001_extensions.sql | 2026-04-08 08:57:42 |
| 2 | 002_sources.sql | 2026-04-08 08:57:42 |
| 3 | 003_stories.sql | 2026-04-08 08:57:42 |
| 4 | 004_entities.sql | 2026-04-08 08:57:42 |
| 5 | 005_relationships.sql | 2026-04-08 08:57:42 |
| 6 | 006_chunks.sql | 2026-04-08 08:57:42 |
| 7 | 007_taxonomy.sql | 2026-04-08 08:57:42 |
| 8 | 008_indexes.sql | 2026-04-08 08:57:42 |
| 9 | 012_job_queue.sql | 2026-04-08 08:57:42 |
| 10 | 013_pipeline_tracking.sql | 2026-04-08 08:57:42 |
| 11 | 014_pipeline_functions.sql | 2026-04-08 08:57:42 |
| 12 | 015_entity_name_type_index.sql | 2026-04-08 08:57:42 |
| 13 | 016_edge_upsert_index.sql | 2026-04-08 08:57:42 |
| 14 | 017_entity_name_embedding.sql | 2026-04-08 08:57:42 |

Note the gap from `008` to `012` — migrations 009, 010, 011 are **reserved for M6 v2.0** (grounding, evidence_chains, clusters tables per roadmap G1).

### 6.2 Idempotency test

```
node apps/cli/dist/index.js db migrate
# {"applied":0,"skipped":14,"total":14,"msg":"Migration run complete"}
# ✔ Database is up to date (14 migrations already applied)
```

**Result:** ✅ Migrations are idempotent. Re-running `mulder db migrate` on an already-migrated database applies 0 migrations.

### 6.3 Tables present

```
14 tables (excluding spatial_ref_sys from PostGIS):
chunks, entities, entity_aliases, entity_edges, jobs,
mulder_migrations, pipeline_run_sources, pipeline_runs,
source_steps, sources, stories, story_entities, taxonomy
```

**Result:** ✅ All expected tables present.

---

## 7. Full test suite — 3 passes

Vitest config: `fileParallelism: false`, `testTimeout: 180_000`, `NODE_ENV=test` (blocks real GCP calls).

### Pass 1 — ❌ FAIL (flake)

```
Test Files  1 failed | 47 passed (48)
Tests       774 passed | 14 skipped (788)
Duration    334.43s
```

**Failure:** `tests/specs/39_graph_traversal_retrieval.test.ts`
- Error: `psql failed (exit 1): ERROR: relation "sources" does not exist`
- Location: `seedFixture` in `beforeAll`
- Consequence: all 14 tests in the file skipped

### Pass 2 — ✅ PASS

```
Test Files  48 passed (48)
Tests       788 passed (788)
Duration    338.87s
```

### Pass 3 — ❌ FAIL (flake reproducted)

```
Test Files  1 failed | 47 passed (48)
Tests       774 passed | 14 skipped (788)
Duration    343.92s
```

Same failure as Pass 1, same location.

### Observations

- **Flake rate:** 2/3 = **67%** on spec 39 in full-suite runs
- **Isolation check:** `pnpm test tests/specs/39_graph_traversal_retrieval.test.ts` → **14/14 green, 4.46s** (100% pass in isolation)
- **Deterministic?** Same failure reproduces twice, same error, same location — not random; likely depends on test-file ordering relative to a polluting test
- **Duration per pass:** ~335-345s (≈5.6 min)
- **Test counts:** 48 files, 788 tests, 0 deterministic skips
- **No use of `.skip` / `.only`:** Verified — the 14 skipped tests in failing runs were all from spec 39's `beforeAll` failure cascading to its `it()` blocks (they become "test not executed"), not from intentional `.skip` markers

---

## 8. Root-cause analysis — Spec 39 Flake

### 8.1 Evidence

**Polluting test:** `tests/specs/08_core_schema_migrations.test.ts:157`

```typescript
afterAll(() => {
  // Leave the database in a clean state for other test suites
  if (pgAvailable && extensionsAvailable) {
    resetDatabase();
  }
});
```

`resetDatabase()` (line 93) performs:
- `DROP FUNCTION IF EXISTS reset_pipeline_step/gc_orphaned_entities CASCADE`
- `DROP TABLE IF EXISTS` on all 13 core tables
- `DROP EXTENSION IF EXISTS vector/postgis/pg_trgm CASCADE`

The `afterAll` comment says "Leave the database in a clean state for other test suites" — but "clean" here means "dropped", not "migrated and empty". After spec 08 finishes, the database has **zero tables and zero extensions**.

**Victim test:** `tests/specs/39_graph_traversal_retrieval.test.ts:480`

Spec 39's `beforeAll` → `seedFixture` → `runSql("INSERT INTO sources ...")` assumes the schema exists. It does NOT run migrations in its own setup.

### 8.2 Why it's flaky, not deterministic

Vitest with `fileParallelism: false` still runs files sequentially in what appears to be a non-stable order. In some runs, a schema-owning test (e.g. `14_source_repository`, `33_qa_schema_conformance`) runs between `08` and `39`, re-migrating the database. In other runs, nothing between them touches the schema, and `39` hits the empty DB.

### 8.3 Audit of schema-touching tests

18 test files touch the schema in some way:

```
07_database_client_migration_runner
08_core_schema_migrations             ← afterAll DROPS everything
09_job_queue_pipeline_tracking_migrations
14_source_repository
16_ingest_step
19_extract_step
22_pdf_metadata_extraction
23_segment_step
29_enrich_step
30_cascading_reset_function
33_qa_schema_conformance
34_embed_step
34_qa_status_state_machine
35_graph_step
35_qa_cascading_reset
36_pipeline_orchestrator
36_qa_pipeline_integration
42_hybrid_retrieval_orchestrator
```

Notably missing from this list: **37** (vector search), **38** (fulltext search), **39** (graph traversal), **40** (RRF), **41** (reranker). Retrieval tests assume schema exists but don't set it up — they're downstream consumers of another test's setup.

### 8.4 Classification

**Finding ID:** P1-BASELINE-FLAKE-01
**Severity:** WARNING (not CRITICAL — tests are 100% correct, infrastructure is fragile)
**Classification:** BUG (test infrastructure)
**Suggested fix (deferred to post-gate):**
Two options, choose one:
1. Change spec 08's `afterAll` to `resetDatabase(); runMigrations();` — leave DB re-migrated
2. Add schema-owning `beforeAll` to specs 37/38/39/40/41 that ensures migrations are applied

Option 1 is simpler and safer (only one test file to fix). Option 2 is more explicit about test dependencies.

---

## 9. Secondary observations (non-blockers)

### 9.1 Duplicate-numbered spec files

Five pairs of test files share the same numeric prefix:

| Number | Files |
|--------|-------|
| 22 | `22_pdf_metadata_extraction.test.ts`, `22_story_repository.test.ts` |
| 34 | `34_embed_step.test.ts`, `34_qa_status_state_machine.test.ts` |
| 35 | `35_graph_step.test.ts`, `35_qa_cascading_reset.test.ts` |
| 36 | `36_pipeline_orchestrator.test.ts`, `36_qa_pipeline_integration.test.ts` |
| 37 | `37_vector_search_retrieval.test.ts`, `37_qa_error_code_coverage.test.ts` |

**Explanation** (inferred from roadmap history): the Pre-Search QA Gate was inserted between M3 and M4 after M3 test numbering was already established. Instead of renumbering the M4 steps, the QA gate tests borrowed existing numbers and the M4 tests kept theirs. The `docs/specs/` directory uses the correct final numbering (`33_qa_checkpoint.spec.md` before `34+`). The test file numbering is a historical artifact, not a correctness issue.

**Classification:** KNOWN LIMITATION (test-file cosmetic)
**Impact:** None functionally. Slight cognitive cost when navigating tests.
**Suggested fix (deferred):** Rename test files to match current `docs/specs/` numbering (e.g., `33_qa_*` tests), or consolidate via renumbering in a separate hygiene PR.

### 9.2 `pdf-parse` noise

Spec 15 (`native_text_detection`) logs `InvalidPDFException: Invalid PDF structure` during test runs. This is expected behavior (test feeds corrupt PDF to verify error handling) but produces verbose stderr output during the suite. Not a failure.

### 9.3 `NODE_ENV=test` protection

Verified via logs: all retrieval tests that would normally call Vertex AI for embeddings log `RETRIEVAL_EMBEDDING_FAILED` and the test framework gracefully treats this as a code path under test (returns empty results with `failures: ['vector']`). The pipeline never actually hits GCP during tests.

### 9.4 Test duration

~335s for the full suite is acceptable but not fast. The spec 39 file alone takes 4.5s in isolation; the remaining ~330s are distributed across 47 other files averaging ~7s each. No single file is a hotspot.

### 9.5 `psql` CLI not installed locally

`which psql` → not found on host. Tests that need SQL access route through `docker exec mulder-pg-test psql ...`. This is working but creates a host-dependency on `docker` being present.

### 9.6 Error codes

`packages/core/src/shared/errors.ts` defines **64 error codes** total, of which **20 are marked `@reserved`** (for future milestones). The QA-21 test (in `37_qa_error_code_coverage.test.ts`) already verifies that all codes are either ACTIVE or RESERVED (no DEAD codes). This is the resolution from the Pre-Search QA Gate Issue 4.

---

## 10. Phase 1 exit criteria

| Criterion | Status |
|-----------|--------|
| `pnpm install --frozen-lockfile` works on fresh state | ✅ |
| `pnpm build --force` fully green (no cache) | ✅ (9/9) |
| `pnpm typecheck` fully green | ✅ (16/16) |
| `pnpm lint` zero findings | ✅ (202 files) |
| Migrations idempotent | ✅ (0 applied on re-run) |
| Full test suite has a known-deterministic outcome | ⚠️ (flake in spec 39 — documented, root-caused, classified) |
| Baseline report written | ✅ (this doc = D1) |
| Coverage matrix written | ✅ (D2 = `post-mvp-coverage-matrix.md`) |

**Verdict: PASS_WITH_FINDINGS.** Ready to proceed to Phase 2 (Milestone Reviews M3 + M4).

---

## 11. Findings summary (to carry into Phase 7 triage)

| ID | Severity | Title | Classification | Fix when |
|----|----------|-------|----------------|----------|
| P1-BASELINE-FLAKE-01 | WARNING | Spec 39 flake — 67% failure rate in full-suite due to spec 08 afterAll dropping schema without re-migrating | BUG | Post-gate |
| P1-BASELINE-DUPNUM-01 | NOTE | 5 pairs of duplicate-numbered test files (22, 34, 35, 36, 37) — historical artifact from QA gate insertion | KNOWN LIMITATION | Post-gate (hygiene) |
| P1-BASELINE-PDF-NOISE-01 | NOTE | pdf-parse InvalidPDFException warnings in spec 15 test output — expected behavior, visual noise only | BY DESIGN | Never (or silence via logger level) |
