---
spec: 14
title: Source Repository
roadmap_step: M2-B2
functional_spec: ["§4.3 (sources table)", "§2.1"]
scope: single
created: 2026-03-30
issue: https://github.com/mulkatz/mulder/issues/28
---

# 14 — Source Repository

## 1. Objective

Provide a type-safe repository module for CRUD operations on the `sources` and `source_steps` tables. This is the data access layer that the Ingest step (B4) and all subsequent pipeline steps use to create, read, update, and query source records. The repository uses the worker pool from the database client and follows the existing pattern established by the migration runner.

## 2. Boundaries

### In scope
- TypeScript types for `Source`, `SourceStep`, and related DTOs (create/update inputs)
- Source repository: `create`, `findById`, `findByHash`, `findAll` (with filters), `updateStatus`, `update`, `delete`
- Source step repository: `upsert`, `findBySourceId`, `findBySourceAndStep`
- All queries use parameterized SQL (no raw string interpolation)
- Idempotent inserts via `ON CONFLICT` on `file_hash`
- Barrel export from `packages/core/src/database/index.ts`

### Out of scope
- Cloud Storage upload (that's Ingest step B4)
- Firestore observability writes (that's Ingest step B4)
- Native text detection (that's B3)
- Pipeline orchestration logic

### Constraints
- Uses `pg` directly (same pattern as `client.ts` and `migrate.ts`) — no ORM
- Worker pool for all writes; query pool available for read-heavy operations
- Custom `DatabaseError` for all failure modes
- No `any` or `as` type assertions

## 3. Dependencies

### Requires (must exist)
- `packages/core/src/database/client.ts` — connection pools (M1-A6, 🟢)
- `packages/core/src/shared/errors.ts` — `DatabaseError` class (M1-A3, 🟢)
- `packages/core/src/shared/logger.ts` — structured logging (M1-A4, 🟢)
- Migration `002_sources.sql` — `sources` and `source_steps` tables (M1-A7, 🟢)

### Required by (future consumers)
- B3: Native text detection (updates `has_native_text`, `native_text_ratio`)
- B4: Ingest step (creates source records)
- B7: Extract step (reads/updates source status)
- All subsequent pipeline steps (read source, update status/steps)

## 4. Blueprint

### 4.1 Types — `packages/core/src/database/repositories/source.types.ts`

```typescript
/** Source status lifecycle. */
export type SourceStatus = 'ingested' | 'extracted' | 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';

/** Source step execution status. */
export type SourceStepStatus = 'pending' | 'completed' | 'failed' | 'partial';

/** A source record from the database. */
export interface Source {
  id: string;
  filename: string;
  storagePath: string;
  fileHash: string;
  pageCount: number | null;
  hasNativeText: boolean;
  nativeTextRatio: number;
  status: SourceStatus;
  reliabilityScore: number | null;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a new source. */
export interface CreateSourceInput {
  filename: string;
  storagePath: string;
  fileHash: string;
  pageCount?: number;
  hasNativeText?: boolean;
  nativeTextRatio?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Input for updating a source. Partial — only provided fields are updated. */
export interface UpdateSourceInput {
  filename?: string;
  storagePath?: string;
  pageCount?: number;
  hasNativeText?: boolean;
  nativeTextRatio?: number;
  status?: SourceStatus;
  reliabilityScore?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Filters for querying sources. */
export interface SourceFilter {
  status?: SourceStatus;
  tags?: string[];
  limit?: number;
  offset?: number;
}

/** A source_steps record from the database. */
export interface SourceStep {
  sourceId: string;
  stepName: string;
  status: SourceStepStatus;
  configHash: string | null;
  completedAt: Date | null;
  errorMessage: string | null;
}

/** Input for upserting a source step. */
export interface UpsertSourceStepInput {
  sourceId: string;
  stepName: string;
  status: SourceStepStatus;
  configHash?: string;
  errorMessage?: string;
}
```

### 4.2 Source Repository — `packages/core/src/database/repositories/source.repository.ts`

The repository is a set of plain functions that accept a `pg.Pool` as the first argument (same pattern as `migrate.ts`). No class wrapper — keeps it simple and testable.

**Exports:**

| Function | Signature | SQL | Notes |
|----------|-----------|-----|-------|
| `createSource` | `(pool, input) → Promise<Source>` | `INSERT ... ON CONFLICT (file_hash) DO UPDATE SET updated_at = now() RETURNING *` | Idempotent via `file_hash` unique constraint. On conflict, returns existing record with updated timestamp. |
| `findSourceById` | `(pool, id) → Promise<Source \| null>` | `SELECT * FROM sources WHERE id = $1` | Returns `null` if not found. |
| `findSourceByHash` | `(pool, hash) → Promise<Source \| null>` | `SELECT * FROM sources WHERE file_hash = $1` | For dedup checking at ingest time. |
| `findAllSources` | `(pool, filter?) → Promise<Source[]>` | `SELECT * ... WHERE ... ORDER BY created_at DESC LIMIT $N OFFSET $M` | Dynamic WHERE clause based on filter. |
| `countSources` | `(pool, filter?) → Promise<number>` | `SELECT COUNT(*) FROM sources WHERE ...` | For pagination and status overview. |
| `updateSource` | `(pool, id, input) → Promise<Source>` | `UPDATE sources SET ... WHERE id = $1 RETURNING *` | Dynamic SET clause. Sets `updated_at = now()`. Throws `DatabaseError` if not found. |
| `updateSourceStatus` | `(pool, id, status) → Promise<Source>` | `UPDATE sources SET status = $1, updated_at = now() WHERE id = $2 RETURNING *` | Convenience for status transitions. Throws if not found. |
| `deleteSource` | `(pool, id) → Promise<boolean>` | `DELETE FROM sources WHERE id = $1` | Returns `true` if deleted, `false` if not found. Cascades to `source_steps`. |

**Source step functions:**

| Function | Signature | SQL | Notes |
|----------|-----------|-----|-------|
| `upsertSourceStep` | `(pool, input) → Promise<SourceStep>` | `INSERT ... ON CONFLICT (source_id, step_name) DO UPDATE SET ... RETURNING *` | Idempotent. Sets `completed_at = now()` when status is `completed`. |
| `findSourceSteps` | `(pool, sourceId) → Promise<SourceStep[]>` | `SELECT * FROM source_steps WHERE source_id = $1 ORDER BY step_name` | All steps for a source. |
| `findSourceStep` | `(pool, sourceId, stepName) → Promise<SourceStep \| null>` | `SELECT * ... WHERE source_id = $1 AND step_name = $2` | Single step lookup. |

**Row mapping:** A private `mapSourceRow(row)` function converts snake_case DB columns to camelCase TypeScript properties. Same pattern for `mapSourceStepRow(row)`.

**Error handling:** All functions wrap `pg` errors in `DatabaseError` with appropriate codes. A new error code `DB_QUERY_FAILED` is added to `errors.ts` for repository query failures.

### 4.3 Error codes — `packages/core/src/shared/errors.ts`

Add to `DATABASE_ERROR_CODES`:

```typescript
DB_QUERY_FAILED: 'DB_QUERY_FAILED',
DB_NOT_FOUND: 'DB_NOT_FOUND',
```

### 4.4 Barrel exports

**`packages/core/src/database/repositories/index.ts`** — new barrel for repositories:
```typescript
export * from './source.types.js';
export * from './source.repository.js';
```

**`packages/core/src/database/index.ts`** — add repository exports:
```typescript
export * from './repositories/index.js';
```

**`packages/core/src/index.ts`** — types and repository functions are re-exported via the database barrel (already exported).

### 4.5 Integration

No config changes. No new migrations (tables already exist). No service abstraction changes — repositories are pure database access, not GCP services.

## 5. QA Contract

All conditions testable via CLI (`psql` or node script) against a running PostgreSQL instance (docker-compose).

| ID | Condition | Given / When / Then |
|----|-----------|---------------------|
| QA-01 | Create source inserts row | Given a running PostgreSQL with migrations applied, when `createSource` is called with valid input, then a row exists in `sources` with status `ingested` and all provided fields match. |
| QA-02 | Create source is idempotent on file_hash | Given a source with hash `abc123` exists, when `createSource` is called with the same `file_hash`, then no duplicate row is created and the existing source is returned with an updated `updated_at`. |
| QA-03 | Find source by ID returns correct record | Given a created source, when `findSourceById` is called with its ID, then all fields match the created record. |
| QA-04 | Find source by ID returns null for missing | When `findSourceById` is called with a non-existent UUID, then `null` is returned. |
| QA-05 | Find source by hash works | Given a created source, when `findSourceByHash` is called with its hash, then the correct source is returned. |
| QA-06 | Update source status transitions correctly | Given a source with status `ingested`, when `updateSourceStatus` is called with `extracted`, then the source's status is `extracted` and `updated_at` is refreshed. |
| QA-07 | Update source partial fields | Given a source, when `updateSource` is called with `{ pageCount: 42, hasNativeText: true }`, then only those fields change and other fields remain untouched. |
| QA-08 | Delete source cascades to source_steps | Given a source with associated source_steps, when `deleteSource` is called, then both the source and its source_steps are removed. |
| QA-09 | Find all sources with status filter | Given 3 sources (2 ingested, 1 extracted), when `findAllSources({ status: 'ingested' })` is called, then exactly 2 sources are returned. |
| QA-10 | Upsert source step creates and updates | Given a source, when `upsertSourceStep` is called twice with different statuses, then only one row exists with the latest status. |
| QA-11 | Find source steps returns all steps | Given a source with 3 steps upserted, when `findSourceSteps` is called, then all 3 steps are returned. |
| QA-12 | Count sources respects filter | Given 5 sources with mixed statuses, when `countSources({ status: 'ingested' })` is called, then the correct count is returned. |
| QA-13 | Build compiles without errors | When `pnpm turbo run build` is run, then the build succeeds with zero TypeScript errors. |
| QA-14 | Biome lint passes | When `npx biome check .` is run, then no lint or format violations are found. |
