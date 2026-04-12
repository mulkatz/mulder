---
spec: "55"
title: "Portable Env-Driven DB Test Harness Foundation"
roadmap_step: ""
functional_spec: []
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/141"
created: 2026-04-12
---

# Spec 55: Portable Env-Driven DB Test Harness Foundation

## 1. Objective

Replace the hardcoded Docker-container test harness with a shared, environment-driven PostgreSQL access layer for black-box spec tests. Issue `#141` exists because CI exposes Postgres on `localhost:5432`, while many tests still depend on `docker exec mulder-pg-test`, causing silent skips instead of real failures.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap bug fix tracked by Issue `#141`
- **Target:** `tests/lib/db.ts`, `tests/lib/schema.ts`, `.github/workflows/ci.yml`, and any small helper adjustments needed to make DB-backed spec tests consume one shared env-driven access path
- **In scope:** shared `runSql()` and `isPgAvailable()` helpers, canonical PG env defaults for local runs, helper support for `psql` and `pg_isready`, and migration of existing helper code to the shared path
- **Out of scope:** changing product code under `packages/` or `apps/`, changing roadmap state, rewriting spec assertions unrelated to DB portability, and broad documentation cleanup outside what is needed to explain the harness contract
- **Constraints:** preserve black-box testing boundaries, keep local and CI DB access identical, and surface database connectivity problems as test failures or explicit skips with actionable reasons

## 3. Dependencies

- **Requires:** the current CLI build/test flow, GitHub Actions Postgres service env vars, and the existing black-box spec suite layout under `tests/specs/`
- **Blocks:** Spec 56 and Spec 57, which migrate the individual suites to this shared harness

## 4. Blueprint

### 4.1 Files

1. **`tests/lib/db.ts`** — exports the shared PostgreSQL test harness primitives: connection env defaults, `runSql()`, `runSqlSafe()`, `isPgAvailable()`, and any small helpers needed by spec suites without importing product code
2. **`tests/lib/schema.ts`** — aligns the schema bootstrap helper with the shared PG env defaults so migrations and SQL helpers use the same host/port/user/database path
3. **`.github/workflows/ci.yml`** — keeps the CI job on the same env-driven path used locally and removes any remaining assumptions that spec tests must reach Postgres through a fixed container name

### 4.2 Database Changes

None.

### 4.3 Config Changes

None.

### 4.4 Integration Points

- All DB-backed spec suites import the shared helper instead of defining their own container-specific SQL utilities
- CI exports `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` so spec tests and the CLI use the same database endpoint
- Any suite-specific resets or seed helpers continue to issue raw SQL, but through the shared host-based helper

### 4.5 Implementation Phases

**Phase 1: Shared helper extraction**
- add `tests/lib/db.ts`
- move reusable SQL execution and availability checks behind one env-driven API

**Phase 2: Harness alignment**
- update `tests/lib/schema.ts` and any shared call sites to use the same env contract
- confirm CI setup still provisions the required extensions and reachable database endpoint

## 5. QA Contract

1. **QA-01: Shared helper reaches PostgreSQL through environment variables**
   - Given: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` point at a running local PostgreSQL instance
   - When: a DB-backed spec suite uses the shared harness to run a trivial SQL query
   - Then: the query succeeds without requiring `docker exec` or a named container

2. **QA-02: Availability checks use the same path as SQL execution**
   - Given: the same PostgreSQL env vars are configured
   - When: the harness checks database readiness before a suite runs
   - Then: the readiness result matches the actual ability to execute SQL against that database

3. **QA-03: CI and local runs share one database access contract**
   - Given: the repository test workflow on GitHub Actions and a local run both provide PG env vars
   - When: DB-backed spec tests execute
   - Then: both environments connect through the same host/port/user/database settings rather than container-name assumptions

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None — this work changes only local/CI test infrastructure.
