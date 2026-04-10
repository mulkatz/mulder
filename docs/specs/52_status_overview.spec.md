---
spec: 52
title: Status Overview CLI
roadmap_step: F4
functional_spec: ["§1"]
scope: single
created: 2026-04-10
issue: https://github.com/mulkatz/mulder/issues/135
---

## 1. Objective

Implement `mulder status` — a single-screen overview of the entire Mulder instance. Shows aggregate counts for sources, stories, entities, edges, chunks, and taxonomy entries, grouped by their lifecycle status or type. A `--failed` flag narrows the view to only sources with failed pipeline steps. A `--json` flag emits machine-readable output. No business logic in the CLI layer — the command calls repository functions and formats the result.

## 2. Boundaries

### In scope
- `mulder status` command (top-level, not a subcommand)
- `--failed` flag: show only sources with failed `source_steps`
- `--json` flag: structured JSON output
- New aggregate repository functions for group-by queries
- Barrel export updates in `@mulder/core`
- CLI registration in `apps/cli/src/index.ts`

### Out of scope
- `pipeline status` (already exists — per-run detail view)
- `db status` (already exists — migration status)
- Threshold/degradation display (§5.3 context — informational only for this spec)
- Firestore observability projection
- Any API routes (M7)

## 3. Dependencies

### Requires (must exist)
- `countSources`, `countStories`, `countEntities`, `countEdges`, `countChunks`, `countTaxonomyEntries` — all exist
- `findLatestPipelineRun` — exists
- `findSourceSteps` — exists
- `getWorkerPool`, `loadConfig`, `closeAllPools` — exist
- CLI scaffold (`apps/cli/src/index.ts`) — exists
- `withErrorHandler`, `printJson`, `printError`, `printSuccess` — exist

### Provides (new)
- `countSourcesByStatus(pool)` — aggregate sources grouped by status
- `countStoriesByStatus(pool)` — aggregate stories grouped by status
- `countEntitiesByType(pool)` — aggregate active entities grouped by type
- `findSourcesWithFailedSteps(pool)` — sources with at least one failed source_step
- `mulder status` CLI command

## 4. Blueprint

### 4.1 New repository functions

**File: `packages/core/src/database/repositories/source.repository.ts`**

Add two functions:

```typescript
/**
 * Count sources grouped by status.
 * Returns a record like { ingested: 3, extracted: 5, ... }.
 */
export async function countSourcesByStatus(pool: pg.Pool): Promise<Record<string, number>> {
  // SQL: SELECT status, COUNT(*)::int AS count FROM sources GROUP BY status
}

/**
 * Find sources that have at least one failed source_step.
 * Returns source ID, filename, the failed step name, and error message.
 */
export async function findSourcesWithFailedSteps(pool: pg.Pool): Promise<FailedSourceInfo[]> {
  // SQL: SELECT s.id, s.filename, ss.step_name, ss.error_message
  //      FROM sources s
  //      JOIN source_steps ss ON ss.source_id = s.id
  //      WHERE ss.status = 'failed'
  //      ORDER BY s.updated_at DESC
  //      LIMIT 100
}
```

New type in `source.types.ts`:
```typescript
export interface FailedSourceInfo {
  sourceId: string;
  filename: string;
  stepName: string;
  errorMessage: string | null;
}
```

**File: `packages/core/src/database/repositories/story.repository.ts`**

```typescript
/**
 * Count stories grouped by status.
 */
export async function countStoriesByStatus(pool: pg.Pool): Promise<Record<string, number>> {
  // SQL: SELECT status, COUNT(*)::int AS count FROM stories GROUP BY status
}
```

**File: `packages/core/src/database/repositories/entity.repository.ts`**

```typescript
/**
 * Count active entities (canonical_id IS NULL) grouped by type.
 * Merged entities (those with canonical_id set) are excluded.
 */
export async function countEntitiesByType(pool: pg.Pool): Promise<Record<string, number>> {
  // SQL: SELECT type, COUNT(*)::int AS count FROM entities WHERE canonical_id IS NULL GROUP BY type ORDER BY count DESC
}
```

### 4.2 Barrel exports

**File: `packages/core/src/database/repositories/index.ts`**

Add exports:
- `countSourcesByStatus`, `findSourcesWithFailedSteps` from source repo
- `countStoriesByStatus` from story repo
- `countEntitiesByType` from entity repo
- `FailedSourceInfo` type from source types

### 4.3 CLI command

**File: `apps/cli/src/commands/status.ts`** (new file)

```typescript
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Overview: sources, stories, entities, pipeline health')
    .option('--failed', 'Show only sources with failed pipeline steps')
    .option('--json', 'Machine-readable JSON output')
    .action(withErrorHandler(async (options) => {
      // 1. Load config, get pool
      // 2. Run aggregate queries in parallel (Promise.all)
      // 3. If --failed: call findSourcesWithFailedSteps only
      // 4. If --json: printJson(data)
      // 5. Else: format human-readable table
    }));
}
```

**Default output format (human-readable):**

```
Sources     42 total
  ingested     3    extracted    5    segmented    8
  enriched    10    embedded    10    graphed      6

Stories    156 total
  segmented   20    enriched    50    embedded    50
  graphed     36

Entities   523 active (47 merged)
  person    200    location   150    event      100
  object     73

Edges     1204
Chunks    3400
Taxonomy    45 confirmed, 478 auto

Pipeline
  Last run   2026-04-10T10:30:00Z  completed
  Failed     2 sources with failed steps
```

**`--failed` output:**

```
Sources with failed steps:

  ID          Filename                  Step       Error
  ──────────  ────────────────────────  ─────────  ──────────────────────
  abc12345    report-2024.pdf           extract    Document AI timeout
  def67890    analysis.pdf              enrich     Gemini rate limit exceeded

2 sources with failed steps
```

**`--json` output structure:**

```json
{
  "sources": {
    "total": 42,
    "byStatus": { "ingested": 3, "extracted": 5, ... }
  },
  "stories": {
    "total": 156,
    "byStatus": { "segmented": 20, "enriched": 50, ... }
  },
  "entities": {
    "active": 523,
    "merged": 47,
    "byType": { "person": 200, "location": 150, ... }
  },
  "edges": 1204,
  "chunks": 3400,
  "taxonomy": {
    "confirmed": 45,
    "auto": 478
  },
  "pipeline": {
    "lastRun": { "id": "...", "status": "completed", "createdAt": "...", "finishedAt": "..." },
    "failedSources": 2
  }
}
```

When `--failed` is combined with `--json`:
```json
{
  "failedSources": [
    { "sourceId": "...", "filename": "...", "stepName": "extract", "errorMessage": "..." }
  ],
  "total": 2
}
```

### 4.4 CLI registration

**File: `apps/cli/src/index.ts`**

Add import and call `registerStatusCommand(program)`.

### 4.5 Integration notes

- All aggregate queries run in parallel via `Promise.all` for performance.
- Entity counts exclude merged entities (canonical_id IS NOT NULL) from the "active" count but report the merged count separately.
- Taxonomy counts use `countTaxonomyEntries` with status filter (already exists).
- The `--failed` flag is a separate code path — it only queries `findSourcesWithFailedSteps`, not the full overview.
- Pipeline "last run" uses existing `findLatestPipelineRun(pool)`.
- Failed source count for the overview uses `findSourcesWithFailedSteps` and takes `.length`.
- `closeAllPools()` in finally block as per existing pattern.

## 5. QA Contract

### QA-01: Default overview shows aggregate counts
- **Given** a database with at least 1 source, 1 story, and 1 entity
- **When** `mulder status` is run
- **Then** stdout contains lines with "Sources", "Stories", "Entities", "Edges", "Chunks", and shows numeric counts

### QA-02: --json flag produces valid JSON
- **Given** a database with data
- **When** `mulder status --json` is run
- **Then** stdout is valid JSON with keys: sources, stories, entities, edges, chunks, taxonomy, pipeline

### QA-03: --failed shows only failed sources
- **Given** a source with a failed source_step
- **When** `mulder status --failed` is run
- **Then** stdout lists the failed source with its step name and error message

### QA-04: --failed with --json
- **Given** a source with a failed source_step
- **When** `mulder status --failed --json` is run
- **Then** stdout is valid JSON with failedSources array containing the failed source info

### QA-05: Empty database shows zero counts
- **Given** an empty database (migrations applied, no data)
- **When** `mulder status` is run
- **Then** all counts are 0 and no error is thrown

### QA-06: --failed with no failures
- **Given** no sources have failed steps
- **When** `mulder status --failed` is run
- **Then** stdout shows "No sources with failed steps" (or similar)

### QA-07: Entity counts exclude merged entities
- **Given** entities exist where some have canonical_id set (merged)
- **When** `mulder status --json` is run
- **Then** entities.active excludes merged, entities.merged counts them separately

### QA-08: --help shows command description
- **When** `mulder status --help` is run
- **Then** output includes "Overview" and describes --failed and --json flags

## 5b. CLI Test Matrix

| ID | Command | Assertion |
|----|---------|-----------|
| CLI-01 | `mulder status --help` | exit 0, output contains "Overview" |
| CLI-02 | `mulder status` | exit 0, output contains "Sources" and "Stories" |
| CLI-03 | `mulder status --json` | exit 0, valid JSON on stdout |
| CLI-04 | `mulder status --failed` | exit 0, output contains "failed" context |
| CLI-05 | `mulder status --failed --json` | exit 0, valid JSON with failedSources |
