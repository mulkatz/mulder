---
spec: "56"
title: "Portable DB Harness Migration for Core Pipeline Spec Suites"
roadmap_step: ""
functional_spec: []
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/141"
created: 2026-04-12
---

# Spec 56: Portable DB Harness Migration for Core Pipeline Spec Suites

## 1. Objective

Migrate the core database and pipeline black-box suites from hardcoded `mulder-pg-test` access to the shared env-driven harness so the same tests execute both locally and in CI. This covers the foundational and early-pipeline spec tests whose current skip behavior can hide schema, migration, and orchestration regressions.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap bug fix tracked by Issue `#141`
- **Target:** `tests/specs/07_database_client_migration_runner.test.ts`, `08_core_schema_migrations.test.ts`, `09_job_queue_pipeline_tracking_migrations.test.ts`, `12_docker_compose.test.ts`, `14_source_repository.test.ts`, `16_ingest_step.test.ts`, `19_extract_step.test.ts`, `22_pdf_metadata_extraction.test.ts`, `23_segment_step.test.ts`, `29_enrich_step.test.ts`, `30_cascading_reset_function.test.ts`, `33_qa_schema_conformance.test.ts`, `34_embed_step.test.ts`, `34_qa_status_state_machine.test.ts`, `35_graph_step.test.ts`, `35_qa_cascading_reset.test.ts`, and `36_qa_pipeline_integration.test.ts`
- **In scope:** replacing suite-local `docker exec` SQL helpers, removing hardcoded `PG_CONTAINER` checks, updating skip messaging to reference env-driven setup, and keeping each suite’s existing black-box assertions intact
- **Out of scope:** retrieval-era suites covered by Spec 57, product-code behavior changes, and non-DB fixture refactors unless they are required to keep the migrated suites passing
- **Constraints:** preserve suite intent and black-box boundaries, avoid changing asserted behavior except where the old harness caused false skips, and keep fresh-database reset paths working through host-based SQL access

## 3. Dependencies

- **Requires:** Spec 55
- **Blocks:** completion of Issue `#141` because these suites include the migration/schema paths most likely to expose newly visible clean-slate failures

## 4. Blueprint

### 4.1 Files

1. **Core migration suites** — `tests/specs/07_*.test.ts`, `08_*.test.ts`, `09_*.test.ts`, and `33_*.test.ts` must run schema inspection and reset SQL through the shared helper
2. **Repository + pipeline suites** — `tests/specs/14_*.test.ts`, `16_*.test.ts`, `19_*.test.ts`, `22_pdf_metadata_extraction.test.ts`, `23_*.test.ts`, `29_*.test.ts`, `30_*.test.ts`, `34_*.test.ts`, `35_*.test.ts`, and `36_qa_pipeline_integration.test.ts` must consume the shared helper while preserving their existing seed/reset flows
3. **`tests/specs/12_docker_compose.test.ts`** — keep direct Docker orchestration where the spec intentionally tests Docker Compose, but make SQL access itself portable and independent from a fixed test-container name when possible

### 4.2 Database Changes

None.

### 4.3 Config Changes

None.

### 4.4 Integration Points

- Suite-local cleanup/reset helpers now call shared SQL execution
- Fresh-database migration verification still exercises the real CLI and schema, but no longer depends on container discovery
- Any suite that still needs Docker for non-SQL orchestration remains explicit about that boundary

### 4.5 Implementation Phases

**Phase 1: Foundation + migration suites**
- migrate specs `07`, `08`, `09`, and `33`
- confirm reset and schema introspection still work on a clean database

**Phase 2: Core pipeline suites**
- migrate specs `14`, `16`, `19`, `22`, `23`, `29`, `30`, `34`, `35`, and `36`
- normalize skip/setup messaging around env-driven PostgreSQL access

**Phase 3: Docker-compose edge**
- adjust spec `12` only as needed so SQL assertions no longer rely on a hardcoded standalone test container when running in CI

## 5. QA Contract

1. **QA-01: Core migration suites no longer rely on `docker exec`**
   - Given: the migrated core suite files are present in the repository
   - When: their source is inspected
   - Then: they contain no SQL execution path that shells out to `docker exec ... psql`

2. **QA-02: Fresh-database migration tests execute through the shared harness**
   - Given: PostgreSQL is reachable through the standard PG env vars
   - When: the migrated migration/schema suites run
   - Then: they execute their reset, migrate, and schema-inspection checks against that host-based database instead of silently skipping on CI

3. **QA-03: Core pipeline suites exercise the same DB path in local and CI runs**
   - Given: the CLI is built and PostgreSQL env vars point to a running database
   - When: representative pipeline suites from this spec run
   - Then: their setup, seed, and assertion SQL all succeed through the env-driven harness

4. **QA-04: Newly exposed clean-slate failures are explicit**
   - Given: a migrated suite hits a real schema or migration problem on a fresh database
   - When: the suite runs
   - Then: the failure is reported as a real test failure or surfaced follow-up issue, not masked by a false “database unavailable” skip

## 5b. CLI Test Matrix

N/A — this step changes spec-test infrastructure, not CLI surface area.

## 6. Cost Considerations

None — this work changes only local/CI test infrastructure.
