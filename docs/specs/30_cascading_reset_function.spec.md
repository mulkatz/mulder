---
spec: 30
title: Cascading Reset Function
roadmap_step: C9
functional_spec: §4.3.1, §3.4
scope: single
created: 2026-04-03
issue: https://github.com/mulkatz/mulder/issues/63
---

# 30 — Cascading Reset Function

## 1. Objective

Wire pipeline steps to use the existing `reset_pipeline_step()` PL/pgSQL function (migration 014) for `--force` resets instead of performing manual multi-query deletes in application code. Add a `mulder db gc` CLI command that calls `gc_orphaned_entities()` for orphaned entity cleanup. This centralizes cascading reset logic in the database for atomicity and correctness per §4.3.1.

## 2. Boundaries

### In scope
- Repository function to call `reset_pipeline_step(source_id, step)` from TypeScript
- Repository function to call `gc_orphaned_entities()` from TypeScript
- Refactor extract, segment, and enrich `forceCleanup` functions to use the DB function for data cleanup (GCS cleanup remains in application code)
- `mulder db gc` CLI command
- `--json` output support for `db gc`

### Out of scope
- Modifying the PL/pgSQL functions themselves (already correct in migration 014)
- Adding new migrations
- Embed/graph steps (not yet implemented — they'll use the DB function when built)
- `mulder reprocess` (M8 scope)
- Scheduled/automatic GC (future — manual CLI trigger only for now)

## 3. Dependencies

### Requires
- Migration 014 applied (`reset_pipeline_step`, `gc_orphaned_entities` functions exist)
- Existing pipeline steps: extract, segment, enrich (C2, C8)

### Required by
- D4 (embed step) and D5 (graph step) will use `resetPipelineStep()` for their `--force` paths
- D6 (pipeline orchestrator) will use it for cascading resets

## 4. Blueprint

### 4.1 Repository function: `resetPipelineStep`

**File:** `packages/core/src/database/repositories/pipeline-reset.ts` (new)

```typescript
import type pg from 'pg';

export type PipelineStep = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

/**
 * Calls the reset_pipeline_step() PL/pgSQL function.
 * Atomically cascading-deletes all downstream data for a source at a given step.
 * GCS artifact cleanup must be handled by the caller AFTER this returns.
 */
export async function resetPipelineStep(
  pool: pg.Pool,
  sourceId: string,
  step: PipelineStep,
): Promise<void> {
  await pool.query('SELECT reset_pipeline_step($1, $2)', [sourceId, step]);
}

/**
 * Calls the gc_orphaned_entities() PL/pgSQL function.
 * Returns the number of orphaned entities deleted.
 */
export async function gcOrphanedEntities(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ gc_orphaned_entities: number }>(
    'SELECT gc_orphaned_entities()',
  );
  return result.rows[0].gc_orphaned_entities;
}
```

Export from barrel: `packages/core/src/database/index.ts`

### 4.2 Refactor: Extract step force cleanup

**File:** `packages/pipeline/src/extract/index.ts`

Replace the `forceCleanup` function body. Remove manual `deleteSourceStep` and `updateSourceStatus` calls. Keep GCS cleanup (the DB function doesn't handle GCS).

```typescript
async function forceCleanup(sourceId: string, services: Services, pool: pg.Pool, logger: Logger): Promise<void> {
  // 1. GCS cleanup (not in DB function)
  const prefix = `extracted/${sourceId}/`;
  const existing = await services.storage.list(prefix);
  for (const path of existing.paths) {
    await services.storage.delete(path);
  }
  logger.debug({ sourceId, deletedFiles: existing.paths.length }, 'Deleted existing extraction artifacts');

  // 2. Atomic DB reset — cascading-deletes stories, chunks, edges, ALL source_steps
  await resetPipelineStep(pool, sourceId, 'extract');
  logger.info({ sourceId }, 'Force cleanup complete — source status reset to ingested');
}
```

Remove imports: `deleteSourceStep`, `updateSourceStatus` (if no longer used elsewhere in the file).
Add import: `resetPipelineStep` from `@mulder/core`.

### 4.3 Refactor: Segment step force cleanup

**File:** `packages/pipeline/src/segment/index.ts`

Replace the `forceCleanup` function body. Remove manual `deleteStoriesBySourceId`, `deleteSourceStep`, `updateSourceStatus` calls. Keep GCS cleanup.

```typescript
async function forceCleanup(sourceId: string, services: Services, pool: pg.Pool, logger: Logger): Promise<void> {
  // 1. Atomic DB reset — cascading-deletes stories (+ chunks, story_entities, edges), resets source_steps
  await resetPipelineStep(pool, sourceId, 'segment');
  logger.debug({ sourceId }, 'DB reset complete for segment');

  // 2. GCS cleanup (not in DB function)
  const prefix = `segments/${sourceId}/`;
  const existing = await services.storage.list(prefix);
  for (const path of existing.paths) {
    await services.storage.delete(path);
  }
  logger.debug({ sourceId, deletedFiles: existing.paths.length }, 'Deleted existing segment artifacts');

  logger.info({ sourceId }, 'Force cleanup complete — source status reset to extracted');
}
```

Remove imports: `deleteStoriesBySourceId`, `deleteSourceStep`, `updateSourceStatus` (if no longer used elsewhere in the file).
Add import: `resetPipelineStep` from `@mulder/core`.

### 4.4 Refactor: Enrich step force cleanup

**File:** `packages/pipeline/src/enrich/index.ts`

The enrich step has two force paths: per-story and per-source. The DB function operates per-source. Refactor `forceCleanupSource` to use the DB function. Keep `forceCleanupStory` as-is (the DB function doesn't support per-story granularity — it resets all stories for a source).

**Replace `forceCleanupSource`:**
```typescript
async function forceCleanupSource(sourceId: string, pool: pg.Pool, logger: Logger): Promise<void> {
  await resetPipelineStep(pool, sourceId, 'enrich');
  logger.info({ sourceId }, 'Force cleanup complete — stories reset to segmented');
}
```

Remove imports that are no longer used: `deleteStoryEntitiesBySourceId`, `findStoriesBySourceId`, `deleteEdgesByStoryId`, `updateStoryStatus`, `deleteSourceStep` — but ONLY if they're not used by `forceCleanupStory` or elsewhere. `forceCleanupStory` still uses `deleteStoryEntitiesByStoryId`, `deleteEdgesByStoryId`, `updateStoryStatus` so those stay.

Add import: `resetPipelineStep` from `@mulder/core`.

### 4.5 CLI command: `mulder db gc`

**File:** `apps/cli/src/commands/db.ts` (extend existing)

Add a `gc` subcommand under the `db` command group:

```typescript
dbCmd
  .command('gc')
  .description('Garbage-collect orphaned entities (no story references)')
  .option('--json', 'output result as JSON')
  .argument('[config-path]', 'path to config file')
  .action(
    withErrorHandler(async (configPath?: string, options?: { json?: boolean }) => {
      const config = loadConfig(configPath);
      if (!config.gcp) {
        printError('GCP configuration is required for database operations');
        process.exit(1);
        return;
      }

      const pool = getWorkerPool(config.gcp.cloud_sql);
      try {
        const deletedCount = await gcOrphanedEntities(pool);
        if (options?.json) {
          process.stdout.write(JSON.stringify({ deleted: deletedCount }) + '\n');
        } else if (deletedCount === 0) {
          printSuccess('No orphaned entities found');
        } else {
          printSuccess(`Deleted ${deletedCount} orphaned entity(ies)`);
        }
      } finally {
        await closeAllPools();
      }
    }),
  );
```

Add import: `gcOrphanedEntities` from `@mulder/core`.

### 4.6 Integration wiring

- **Barrel export:** Add `resetPipelineStep`, `gcOrphanedEntities`, and `PipelineStep` type to `packages/core/src/database/index.ts`
- **Pipeline barrel:** No changes needed — `forceCleanupSource` is already exported from enrich

### 4.7 No new migrations

Both PL/pgSQL functions already exist in migration 014. No schema changes needed.

## 5. QA Contract

### QA conditions (black-box, tested via CLI + SQL)

**QA-01: Extract --force uses atomic reset**
- Given: a source with status `extracted` that has stories, chunks, and source_steps records
- When: `mulder extract <id> --force` is run (or the force cleanup path is triggered)
- Then: stories, source_steps are deleted atomically; source status is `ingested`; GCS extracted/ prefix is cleaned

**QA-02: Segment --force uses atomic reset**
- Given: a source with status `segmented` that has stories
- When: `mulder segment <id> --force` is run
- Then: stories (+ cascaded chunks, story_entities, edges) are deleted atomically; source_steps for segment/enrich/embed/graph are cleared; source status is `extracted`; GCS segments/ prefix is cleaned

**QA-03: Enrich --force (source-level) uses atomic reset**
- Given: a source with enriched stories that have story_entities and entity_edges
- When: `mulder enrich <id> --force` is run (source-level)
- Then: story_entities and entity_edges are deleted atomically; source_steps for enrich/embed/graph are cleared; stories reset to `segmented`; source status is `segmented`

**QA-04: Enrich --force (story-level) still works**
- Given: a single story with story_entities and entity_edges
- When: per-story force cleanup is triggered
- Then: that story's story_entities and entity_edges are deleted; story status reset to `segmented`; other stories for the same source are untouched

**QA-05: `mulder db gc` removes orphaned entities**
- Given: entities exist in the database with no story_entities references
- When: `mulder db gc` is run
- Then: orphaned entities are deleted; the count is reported

**QA-06: `mulder db gc --json` outputs JSON**
- Given: the database has orphaned entities
- When: `mulder db gc --json` is run
- Then: stdout contains valid JSON with a `deleted` field (integer)

**QA-07: `mulder db gc` reports zero when no orphans**
- Given: all entities have at least one story_entities reference
- When: `mulder db gc` is run
- Then: output says "No orphaned entities found"

**QA-08: Entities shared across sources are NOT deleted by --force**
- Given: Entity "USA" is linked to stories from Source A and Source B
- When: `mulder enrich <source-A-id> --force` is run
- Then: Entity "USA" still exists (still linked to Source B); only Source A's story_entities and entity_edges are removed

### 5b. CLI Test Matrix

| # | Command | Flags | Assert |
|---|---------|-------|--------|
| CLI-01 | `mulder db gc` | (none) | exits 0, output contains "orphaned" or "entities" |
| CLI-02 | `mulder db gc` | `--json` | exits 0, stdout is valid JSON with `deleted` key |
| CLI-03 | `mulder db gc` | `--help` | exits 0, shows description |
