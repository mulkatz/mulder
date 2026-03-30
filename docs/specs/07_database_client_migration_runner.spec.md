---
spec: 7
title: Database Client + Migration Runner
roadmap_step: M1-A6
functional_spec: ["§4.2", "§4.3", "§4.6"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/14
created: 2026-03-30
---

# Spec 07 — Database Client + Migration Runner

## 1. Objective

Provide the foundational database layer for Mulder: a PostgreSQL connection manager with dual connection pools (worker OLTP + query OLAP), a file-based SQL migration runner with tracking, and the CLI commands `mulder db migrate` and `mulder db status`. This step establishes the database infrastructure that all subsequent migrations (M1-A7, M1-A8) and repositories (M2+) build on.

No schema migrations are created in this step — only the runner infrastructure and the `mulder_migrations` tracking table. The actual domain tables (sources, stories, entities, etc.) are added in M1-A7 and M1-A8.

## 2. Boundaries

### In scope

- PostgreSQL connection client with dual pools (`getWorkerPool`, `getQueryPool`)
- Pool configuration from `mulder.config.yaml` (`gcp.cloud_sql` section)
- Connection pool lifecycle management (`closeAllPools`)
- SQL-file-based migration runner with idempotent execution
- Migration tracking table (`mulder_migrations`) auto-created by the runner
- CLI commands: `mulder db migrate` and `mulder db status`
- Structured logging for all database operations
- Custom error classes for database failures (already exist in `shared/errors.ts`)

### Out of scope

- Domain schema migrations (001-014) — M1-A7, M1-A8
- Repository layer — M2+
- GCP connection manager (`gcp.ts`) — M1-A10
- Service abstraction layer — M1-A10
- Docker Compose setup — M1-A11

## 3. Dependencies

### Requires (already done)

- M1-A1: Monorepo setup (pnpm, turbo, tsconfig, biome)
- M1-A2: Config loader + Zod schemas (`loadConfig`, `gcp.cloud_sql` config section)
- M1-A3: Custom error classes (`DatabaseError`, `DATABASE_ERROR_CODES`)
- M1-A4: Logger setup (`createLogger`, `createChildLogger`)
- M1-A5: CLI scaffold (Commander.js, `mulder` binary)

### Required by

- M1-A7: Core schema migrations (uses the migration runner)
- M1-A8: Job queue + pipeline tracking migrations
- M1-A10: Service abstraction (uses the connection pools)

## 4. Blueprint

### 4.1 Files to create

| File | Purpose |
|------|---------|
| `packages/core/src/database/client.ts` | Dual connection pool manager |
| `packages/core/src/database/migrate.ts` | SQL migration runner |
| `packages/core/src/database/index.ts` | Barrel exports for database module |
| `packages/core/src/database/migrations/` | Empty directory for SQL migration files |
| `apps/cli/src/commands/db.ts` | `mulder db migrate` + `mulder db status` commands |

### 4.2 `packages/core/src/database/client.ts`

Connection manager for PostgreSQL with dual pools.

**Exports:**
- `getWorkerPool(config: CloudSqlConfig): Pool` — Small pool (2-3 connections) for OLTP/job queue. No `statement_timeout`.
- `getQueryPool(config: CloudSqlConfig): Pool` — Larger pool (5-10 connections) for OLAP/retrieval. `statement_timeout = 10s`.
- `closeAllPools(): Promise<void>` — Graceful shutdown of all active pools.

**Behavior:**
- Pools are lazy singletons — created on first call, reused thereafter
- Uses `pg` (node-postgres) library
- Pool configuration sourced from `CloudSqlConfig` (host, port, database, user, password/IAM)
- Pool error events logged via pino (don't crash on idle client errors)
- SSL configuration for Cloud SQL connections (when not localhost)

### 4.3 `packages/core/src/database/migrate.ts`

File-based SQL migration runner.

**Exports:**
- `runMigrations(pool: Pool, migrationsDir: string): Promise<MigrationResult>` — Execute pending migrations
- `getMigrationStatus(pool: Pool, migrationsDir: string): Promise<MigrationStatus[]>` — List all migrations with applied/pending status

**Types:**
```typescript
interface MigrationResult {
  applied: string[];  // filenames of newly applied migrations
  skipped: string[];  // already applied
  total: number;
}

interface MigrationStatus {
  filename: string;
  applied: boolean;
  appliedAt: Date | null;
}
```

**Behavior:**
- Auto-creates `mulder_migrations` tracking table if it doesn't exist:
  ```sql
  CREATE TABLE IF NOT EXISTS mulder_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ DEFAULT now()
  );
  ```
- Reads `*.sql` files from the migrations directory, sorted by filename (numeric prefix: `001_`, `002_`, etc.)
- Each migration runs in its own transaction (BEGIN/COMMIT)
- If a migration fails, the transaction rolls back and the runner stops (no partial state)
- Already-applied migrations are skipped (idempotent)
- Logs each migration: starting, applied, skipped, failed

### 4.4 `apps/cli/src/commands/db.ts`

Two subcommands under `mulder db`:

**`mulder db migrate`**
- Loads config via `loadConfig()`
- Connects using `getWorkerPool(config.gcp.cloud_sql)`
- Runs `runMigrations()` against `packages/core/src/database/migrations/`
- Prints applied/skipped summary
- Exits with code 1 on failure
- Calls `closeAllPools()` before exit

**`mulder db status`**
- Loads config, connects
- Runs `getMigrationStatus()`
- Prints table: filename | status (applied/pending) | applied_at
- Calls `closeAllPools()` before exit

### 4.5 Config integration

The `gcp.cloud_sql` section already exists in the config schema (M1-A2). The database client reads:
- `host` (default: `localhost`)
- `port` (default: `5432`)
- `database` (default: `mulder`)
- `user` (default: `mulder`)
- `password` (optional — can use IAM auth in production)

### 4.6 Package dependencies

Add to `packages/core/package.json`:
- `pg` — PostgreSQL client
- `@types/pg` — Type definitions (devDependency)

### 4.7 Barrel exports

Update `packages/core/src/index.ts` to export:
- `getWorkerPool`, `getQueryPool`, `closeAllPools`
- `runMigrations`, `getMigrationStatus`
- Types: `MigrationResult`, `MigrationStatus`

Update `packages/core/src/database/index.ts` as the intermediary barrel.

## 5. QA Contract

All conditions are testable against a real PostgreSQL instance (Docker or local).

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Worker pool connects | A running PostgreSQL instance with valid config | `getWorkerPool()` is called | Pool connects successfully, `SELECT 1` returns a result |
| QA-02 | Query pool connects | A running PostgreSQL instance with valid config | `getQueryPool()` is called | Pool connects successfully, `SELECT 1` returns a result |
| QA-03 | Pools are singletons | Both pool functions called twice each | Second call returns same pool instance | No new connections created |
| QA-04 | Pool cleanup | Pools are active | `closeAllPools()` is called | All pools are ended, subsequent calls create new pools |
| QA-05 | Migration table auto-created | Fresh database with no `mulder_migrations` table | `runMigrations()` is called | `mulder_migrations` table exists |
| QA-06 | Migrations apply in order | Two SQL files: `001_test.sql`, `002_test.sql` | `runMigrations()` is called | Both applied in numeric order, recorded in `mulder_migrations` |
| QA-07 | Migrations are idempotent | Migrations already applied | `runMigrations()` is called again | All skipped, no errors, result shows 0 applied |
| QA-08 | Failed migration rolls back | A migration with invalid SQL | `runMigrations()` is called | Error thrown, failed migration NOT recorded, database unchanged |
| QA-09 | Migration status reports | Mix of applied and pending migrations | `getMigrationStatus()` is called | Each migration listed with correct applied/pending status and timestamp |
| QA-10 | CLI db migrate runs | Valid config, PostgreSQL running | `mulder db migrate` | Prints summary of applied/skipped migrations, exits 0 |
| QA-11 | CLI db status runs | Valid config, PostgreSQL running | `mulder db status` | Prints table with migration status, exits 0 |
| QA-12 | Invalid connection fails gracefully | Bad host/port in config | `getWorkerPool()` attempted | DatabaseError thrown with appropriate error code |
| QA-13 | Query pool has statement timeout | Query pool connected | A query running > 10s is executed | Query is cancelled/times out |
