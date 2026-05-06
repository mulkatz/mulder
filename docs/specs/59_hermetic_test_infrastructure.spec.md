---
spec: "59"
title: "Hermetic Test Infrastructure: DB State, GCP Lane, and E2E Health Signal"
roadmap_step: ""
functional_spec: []
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/143"
created: 2026-04-12
---

# Spec 59: Hermetic Test Infrastructure: DB State, GCP Lane, and E2E Health Signal

## 1. Objective

Close the remaining test-infrastructure gaps tracked by Issue `#143` after the env-driven DB harness (`#141`) and CLI artifact freshness guard (`#142`) landed. The suite must stop depending on prior spec teardown state, credential-dependent tests must move behind one explicit opt-in switch, and Spec 44 must become a named CI health signal rather than just one test buried inside the full run.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap test-infrastructure follow-up tracked by Issue `#143`
- **Target:** `tests/lib/schema.ts`, selected DB-backed spec suites, `tests/specs/20_fixture_generator.test.ts`, `tests/specs/44_e2e_pipeline_integration.test.ts`, `tests/specs/47_document_ai_extraction.test.ts`, `package.json`, and GitHub Actions workflows under `.github/workflows/`
- **In scope:** defensive DB cleanup helpers, the missing per-suite schema bootstrap needed for independent execution, consistent `MULDER_TEST_GCP` opt-in handling for real-GCP tests, and explicit CI wiring for a deterministic default lane plus a manual/scheduled GCP lane
- **Out of scope:** product runtime behavior under `packages/` or `apps/`, broader test-suite parallelization, or new roadmap work beyond the issue acceptance criteria
- **Constraints:** keep test coverage black-box, preserve the built CLI boundary, do not silently skip genuine failures behind readiness heuristics, and keep the default CI lane credential-free and deterministic

## 3. Dependencies

- **Requires:** Spec 55 (shared env-driven DB harness), Spec 57 (Spec 44 on the shared harness), and Spec 58 (fresh CLI artifacts before black-box tests)
- **Blocks:** closure of Issue `#143` and future attempts to parallelize or promote the suite as a trustworthy CI signal

## 4. Blueprint

### 4.1 Files

1. **`tests/lib/schema.ts`** — extend the shared schema helper with defensive cleanup primitives that can truncate only existing Mulder tables and keep DB-backed suites hermetic when run in isolation
2. **`tests/specs/25_edge_repository.test.ts`** — add the missing schema bootstrap so the suite no longer depends on a prior spec having already migrated the database
3. **`tests/specs/50_taxonomy_export_curate_merge.test.ts`**, **`51_entity_management_cli.test.ts`**, **`52_status_overview.test.ts`**, **`53_export_commands.test.ts`** — replace raw `TRUNCATE TABLE ...` cleanup with the shared defensive helper so missing-schema runs fail less opaquely
4. **`tests/specs/44_e2e_pipeline_integration.test.ts`** — reuse the shared schema bootstrap instead of carrying a local duplicate and keep the suite aligned with the named CI health-lane contract
5. **`tests/specs/20_fixture_generator.test.ts`** — split deterministic fixture-generator checks from real-GCP checks and gate the credential-dependent cases behind `MULDER_TEST_GCP=true`
6. **`tests/specs/47_document_ai_extraction.test.ts`** — normalize the real-GCP gate to `MULDER_TEST_GCP=true` while preserving compatibility with the legacy env name during transition
7. **`package.json`** — add dedicated test scripts for the Spec 44 health lane and the opt-in GCP lane
8. **`.github/workflows/ci.yml`** — run the Spec 44 health check as an explicit CI step before affected DB/schema/heavy lanes, keep milestone-branch pushes on affected testing, and reserve full schema/db/heavy suites for default-branch or manual full gates
9. **`.github/workflows/gcp-tests.yml`** — add a separate manual/scheduled workflow for credentialed GCP black-box tests

### 4.2 Database Changes

None.

### 4.3 Config Changes

None in repository config files. CI/workflow env changes only:

- `MULDER_TEST_GCP=true` becomes the canonical opt-in for credential-dependent tests
- Legacy `MULDER_E2E_GCP=true` remains temporarily supported in the spec 47 test to avoid breaking local callers during the transition

### 4.4 Integration Points

- DB-backed suites share one defensive cleanup path from `tests/lib/schema.ts`
- Spec 44 becomes a named, first-class CI health indicator via a dedicated script and workflow step when affected testing selects data-backed lanes
- Milestone-branch pushes use affected planning against the pushed range, including docs-only short-circuiting, so integration commits do not run unrelated full DB/heavy suites
- Credentialed test workflows run separately from the default CI lane and enable the GCP-gated suites with one env variable

### 4.5 Implementation Phases

**Phase 1: Hermetic DB setup and cleanup**
- extend `tests/lib/schema.ts` with defensive truncation helpers
- wire the helper into suites that currently assume the schema already exists
- add the missing schema bootstrap in the edge repository suite

**Phase 2: Credentialed test lane split**
- gate real-GCP fixture/document-AI tests behind `MULDER_TEST_GCP=true`
- keep the default lane deterministic and free of credential-absence assertions

**Phase 3: CI health and opt-in workflow wiring**
- add package scripts for the Spec 44 health lane and GCP lane
- update `ci.yml` to run Spec 44 explicitly before affected data-backed lanes
- keep milestone-branch push CI on affected lanes while full schema/db/heavy suites remain default-branch/manual gates
- add a separate manual/scheduled workflow for the real-GCP suites

## 5. QA Contract

1. **QA-01: Defensive cleanup works when the schema is missing**
   - Given: PostgreSQL is reachable but Mulder tables may not exist yet
   - When: a DB-backed suite uses the shared cleanup helper before or after setup
   - Then: cleanup succeeds without `relation does not exist` failures and without requiring another suite to have migrated first

2. **QA-02: Edge repository suite is independently runnable**
   - Given: a clean PostgreSQL database with no Mulder schema
   - When: `vitest` runs `tests/specs/25_edge_repository.test.ts` by itself
   - Then: the suite bootstraps the schema, seeds its own fixtures, and does not rely on any prior spec execution order

3. **QA-03: Default black-box lane is credential-free**
   - Given: `MULDER_TEST_GCP` is unset
   - When: the fixture-generator and Document AI black-box suites run
   - Then: only deterministic non-GCP checks execute, credential-dependent checks are explicitly skipped, and no assertion depends on “missing credentials” behavior

4. **QA-04: Real-GCP tests share one opt-in switch**
   - Given: `MULDER_TEST_GCP=true` plus valid GCP credentials and config
   - When: the GCP black-box lane runs
   - Then: the credential-dependent cases in the fixture-generator and Document AI suites execute under the same env gate

5. **QA-05: CI separates affected integration feedback from full gates**
   - Given: the default GitHub Actions CI workflow for pull requests and milestone-branch pushes
   - When: the test job reaches the verification phase
   - Then: affected planning runs before DB-backed checks, Spec 44 runs only when affected lanes select schema/db/heavy tests, milestone pushes do not trigger full schema/db/heavy suites, and a separate workflow exists for manual/scheduled GCP tests

## 5b. CLI Test Matrix

N/A — no user-facing CLI commands are introduced or modified in this step.

## 6. Cost Considerations

- **Services called:** optional real-GCP verification uses Document AI and any fixture-generator GCP calls already covered by existing specs
- **Estimated cost per run:** unchanged from the existing GCP-gated specs; default CI remains zero-cost
- **Dev mode alternative:** the default CI lane and local default `pnpm test` path remain credential-free
- **Safety flags:** real-GCP tests execute only when `MULDER_TEST_GCP=true` inside the dedicated workflow or an intentional local run
