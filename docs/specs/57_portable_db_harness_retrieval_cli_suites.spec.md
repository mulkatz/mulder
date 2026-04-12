---
spec: "57"
title: "Portable DB Harness Migration for Retrieval and CLI Spec Suites"
roadmap_step: ""
functional_spec: []
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/141"
created: 2026-04-12
---

# Spec 57: Portable DB Harness Migration for Retrieval and CLI Spec Suites

## 1. Objective

Migrate the retrieval-era, taxonomy, export, v2.0 migration, and CLI smoke suites from hardcoded Docker-container assumptions to the shared env-driven database harness. These suites represent the largest remaining false-green surface in CI because many of them currently skip when `mulder-pg-test` is not present.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap bug fix tracked by Issue `#141`
- **Target:** `tests/cli-smoke.test.ts`, `tests/specs/37_vector_search_retrieval.test.ts`, `38_fulltext_search_retrieval.test.ts`, `39_graph_traversal_retrieval.test.ts`, `42_hybrid_retrieval_orchestrator.test.ts`, `44_e2e_pipeline_integration.test.ts`, `46_taxonomy_bootstrap.test.ts`, `47_document_ai_extraction.test.ts`, `48_layout_to_markdown.test.ts`, `49_mulder_show_command.test.ts`, `50_taxonomy_export_curate_merge.test.ts`, `51_entity_management_cli.test.ts`, `52_status_overview.test.ts`, `53_export_commands.test.ts`, and `54_v2_schema_migrations.test.ts`
- **In scope:** removing suite-local container-name assumptions, reusing the shared SQL/availability helpers, keeping retrieval seed/setup logic intact, and updating CLI smoke checks so DB-dependent paths reflect the env-driven contract
- **Out of scope:** core pipeline suites covered by Spec 56, product-code behavior changes, and non-DB smoke scenarios that already work in CI
- **Constraints:** preserve black-box boundaries, keep retrieval suites deterministic, and avoid weakening assertions just to accommodate the harness migration

## 3. Dependencies

- **Requires:** Spec 55
- **Blocks:** completion of Issue `#141` because the retrieval, CLI, export, and v2.0 suites account for the remaining CI blind spots after the core-pipeline migration

## 4. Blueprint

### 4.1 Files

1. **Retrieval suites** — `tests/specs/37_*.test.ts`, `38_*.test.ts`, `39_*.test.ts`, and `42_*.test.ts` must seed/query PostgreSQL through the shared host-based helper
2. **End-to-end + taxonomy/export suites** — `tests/specs/44_*.test.ts`, `46_*.test.ts`, `47_*.test.ts`, `48_*.test.ts`, `49_*.test.ts`, `50_*.test.ts`, `51_*.test.ts`, `52_*.test.ts`, `53_*.test.ts`, and `54_*.test.ts` must replace hardcoded container checks with the shared env-driven readiness path
3. **`tests/cli-smoke.test.ts`** — the global smoke suite must use the same readiness helper as the spec suites for DB-dependent command groups

### 4.2 Database Changes

None.

### 4.3 Config Changes

None.

### 4.4 Integration Points

- Retrieval seeding and cleanup helpers continue to use raw SQL, now through the shared helper
- E2E and export suites still exercise the real CLI and filesystem boundaries, but with portable DB access
- CLI smoke tests align their DB availability gating with the same readiness logic used by the spec suites

### 4.5 Implementation Phases

**Phase 1: Retrieval suites**
- migrate specs `37`, `38`, `39`, and `42`
- preserve deterministic setup and JSON-output assertions

**Phase 2: End-to-end and management suites**
- migrate specs `44`, `46`, `47`, `48`, `49`, `50`, `51`, `52`, `53`, and `54`
- keep their seed/reset logic and user-visible assertions stable

**Phase 3: Global smoke alignment**
- migrate `tests/cli-smoke.test.ts`
- ensure DB-dependent smoke tests skip only when the env-driven database is genuinely unavailable

## 5. QA Contract

1. **QA-01: Retrieval and management suites no longer depend on `mulder-pg-test`**
   - Given: the migrated suite files are present in the repository
   - When: their source is inspected
   - Then: they contain no hardcoded `mulder-pg-test` dependency for SQL execution or readiness gating

2. **QA-02: Retrieval-era suites execute through host-based PostgreSQL access**
   - Given: PostgreSQL is reachable through the standard PG env vars
   - When: representative retrieval suites from this spec run
   - Then: their seed, query, and cleanup SQL executes through the shared env-driven harness

3. **QA-03: CLI smoke DB gating matches the real database path**
   - Given: the CLI is built and the shared PG env vars point at a running database
   - When: DB-dependent smoke tests execute
   - Then: they use the same readiness result as the spec suites instead of a container-name heuristic

4. **QA-04: CI no longer silently skips the remaining DB-backed suites because of container naming**
   - Given: GitHub Actions provisions PostgreSQL as a service container with a dynamic name
   - When: the migrated suites run in CI
   - Then: any failures are real behavior failures, not false skips caused by the missing `mulder-pg-test` container name

## 5b. CLI Test Matrix

N/A — this step changes spec-test infrastructure, not CLI surface area.

## 6. Cost Considerations

None — this work changes only local/CI test infrastructure.
