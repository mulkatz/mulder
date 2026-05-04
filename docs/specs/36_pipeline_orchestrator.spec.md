---
spec: 36
title: "Pipeline Orchestrator — Cursor-Based Resume"
roadmap_step: M4-D6
functional_spec: ["§3.1", "§3.2", "§3.3", "§3.4", "§3.5", "§1 (pipeline cmd)", "§4.3 (pipeline_runs, pipeline_run_sources)"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/75
created: 2026-04-07
---

## 1. Objective

Implement the full pipeline orchestrator (`mulder pipeline run`, `mulder pipeline status`, `mulder pipeline retry`). This is a coordinator that chains the existing pipeline steps (ingest → extract → segment → enrich → embed → graph) and persists per-source progress in the `pipeline_runs` / `pipeline_run_sources` tables so a crash at document N resumes from document N — not from the beginning. A failed source does not crash the batch; it is marked `failed` in `pipeline_run_sources` and the batch continues.

This closes the M4 critical path: after this step, the pipeline can be driven end-to-end with a single command (`mulder pipeline run ./pdfs`), making v1.0 review-ready once retrieval steps (D7+) land.

**Boundaries with individual step CLIs:** The per-step CLIs (`mulder ingest`, `mulder extract`, …, `mulder graph`) stay unchanged and remain the primary debugging tool. The orchestrator calls the same `execute*` functions the step CLIs call — it does not reimplement any step logic.

**Boundaries with workers (M7):** The orchestrator runs synchronously in-process in a single Node.js process. Async job-queue execution and the `jobs` table belong to M7. The `pipeline_runs`/`pipeline_run_sources` cursor used here is the same data model the worker will eventually consume, but workers are out of scope for this spec.

**Boundaries with reprocess (M8):** `reprocess` is a separate M8 command that uses `source_steps.config_hash` to figure out what to re-run after config changes. This spec does not implement `reprocess`.

**Boundaries with v2.0 steps:** Ground and Analyze are v2.0. The orchestrator must skip them cleanly when they are not yet implemented / not enabled in config — the pipeline ends at `graph` for v1.0.

## 2. Boundaries

**In scope:**
- New package: `packages/pipeline/src/pipeline/` — orchestrator module
  - `types.ts` — `PipelineRunInput`, `PipelineRunResult`, `PipelineRunOptions`, `PipelineStepName`, `PipelineRunSourceProgress`
  - `index.ts` — `execute()` (run orchestrator), `shouldRun()`, step ordering, per-source processing loop
- New repository: `packages/core/src/database/repositories/pipeline-run.repository.ts`
  - `createPipelineRun`, `finalizePipelineRun`, `findPipelineRunById`
  - `upsertPipelineRunSource`, `findPipelineRunSourcesByRunId`, `findLatestPipelineRun`
  - `countPipelineRunSourcesByStatus`
- New repository types: `packages/core/src/database/repositories/pipeline-run.types.ts`
- New CLI module: `apps/cli/src/commands/pipeline.ts`
  - `pipeline run <path>` with `--up-to`, `--from`, `--dry-run`, `--tag`
  - `pipeline status` with `--source <id>`, `--tag <tag>`, `--run <id>`, `--json`
  - `pipeline retry <source-id>` with `--step <step>`
- Register `pipeline` command group in `apps/cli/src/index.ts`
- `PipelineError` class already exists; wire up use of the four reserved error codes (`PIPELINE_SOURCE_NOT_FOUND`, `PIPELINE_WRONG_STATUS`, `PIPELINE_STEP_FAILED`, `PIPELINE_RATE_LIMITED`)
- Barrel exports from `@mulder/pipeline` and `@mulder/core` for the new symbols

**Out of scope:**
- Async workers / job queue consumption (M7-H1/H2)
- `--cost-estimate` flag (M8-I2)
- `reprocess` command and config-hash diffing (M8-I4)
- Ground step execution (v2.0-G2) — orchestrator must gracefully skip it
- Analyze step execution (v2.0-G3..G7) — orchestrator must gracefully skip it
- Firestore observability updates from the orchestrator itself (each sub-step already does its own fire-and-forget write, orchestrator does not add additional writes)
- DLQ / reaper logic (M7-H2, M8-I5)
- `mulder pipeline run --watch` and `--cost-estimate` flags — defer to future specs

**CLI commands:**
- `mulder pipeline run <path>` — ingest all PDFs at path, then chain extract → segment → enrich → embed → graph for each source; persist progress per source
- `mulder pipeline run <path> --up-to <step>` — stop after the named step (e.g. `--up-to enrich` skips embed, graph)
- `mulder pipeline run <path> --from <step>` — resume from the named step (skips earlier steps if their target state is already met)
- `mulder pipeline run <path> --dry-run` — print what would execute without running anything
- `mulder pipeline run <path> --tag <tag>` — attach a human-readable tag to the `pipeline_runs` row
- `mulder pipeline status` — summarise the most recent run (counts by source status)
- `mulder pipeline status --source <id>` — per-source status and current_step
- `mulder pipeline status --tag <tag>` — pick the most recent run with that tag
- `mulder pipeline status --run <id>` — status for a specific run id
- `mulder pipeline status --json` — machine-readable output
- `mulder pipeline retry <source-id>` — re-run the current failed step for that source in a new run row (single source)
- `mulder pipeline retry <source-id> --step <step>` — re-run a specific step

## 3. Dependencies

### Requires (must exist):

- Source repository — spec 14 ✅
- Story repository — spec 22 ✅
- Ingest step (`executeIngest`) — spec 16 ✅
- Extract step (`executeExtract`) — spec 19 ✅
- Segment step (`executeSegment`) — spec 23 ✅
- Enrich step (`executeEnrich`) — spec 29 ✅
- Embed step (`executeEmbed`) — spec 34 ✅
- Graph step (`executeGraph`) — spec 35 ✅
- `pipeline_runs` + `pipeline_run_sources` tables — migration 013 ✅
- `PIPELINE_ERROR_CODES` + `PipelineError` — already in `@mulder/core` ✅
- Service abstraction / registry — spec 11 ✅

### Consumed by (later steps):

- Retrieval (D7/E1-E6) — none (retrieval runs at query time, not via orchestrator)
- Worker (M7-H1/H2) — will drive the same step functions; will reuse `pipeline_runs` schema
- Reprocess (M8-I4) — will create pipeline runs using the same orchestrator

## 4. Blueprint

### 4.1 Types — `packages/pipeline/src/pipeline/types.ts`

```typescript
import type { StepError } from '@mulder/core';

/** Ordered v1.0 pipeline steps. Ground + Analyze are v2.0, omitted here. */
export type PipelineStepName = 'ingest' | 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

/** User-facing options for a `pipeline run` invocation. */
export interface PipelineRunOptions {
  /** Stop after this step (inclusive). Must be a known step name. */
  upTo?: PipelineStepName;
  /** Skip steps earlier than this step. Only processes sources whose state allows the step. */
  from?: PipelineStepName;
  /** Optional human-readable tag attached to the `pipeline_runs` row. */
  tag?: string;
  /** If true, emit the plan without executing any step. */
  dryRun?: boolean;
  /** If provided, skip `ingest` and operate on existing sources with these ids. Used by `pipeline retry`. */
  sourceIds?: string[];
  /** If true (retry path), re-run the selected step even if the source is already past it. */
  force?: boolean;
}

/** Input to the orchestrator's `execute()` function. */
export interface PipelineRunInput {
  /** Path to a PDF file or directory. Ignored when `options.sourceIds` is set. */
  path?: string;
  options: PipelineRunOptions;
}

/** Per-source outcome for a single pipeline run. */
export interface PipelineRunSourceOutcome {
  sourceId: string;
  finalStep: PipelineStepName | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage: string | null;
}

/** Orchestrator result. */
export interface PipelineRunResult {
  status: 'success' | 'partial' | 'failed';
  runId: string;
  data: {
    runId: string;
    tag: string | null;
    plannedSteps: PipelineStepName[];
    totalSources: number;
    completedSources: number;
    failedSources: number;
    skippedSources: number;
    sources: PipelineRunSourceOutcome[];
  };
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;
    items_skipped: number;
  };
}
```

### 4.2 Repository types — `packages/core/src/database/repositories/pipeline-run.types.ts`

```typescript
export type PipelineRunStatus = 'running' | 'completed' | 'partial' | 'failed';
export type PipelineRunSourceStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface PipelineRun {
  id: string;
  tag: string | null;
  options: Record<string, unknown>;
  status: PipelineRunStatus;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface CreatePipelineRunInput {
  tag?: string | null;
  options?: Record<string, unknown>;
}

export interface PipelineRunSource {
  runId: string;
  sourceId: string;
  currentStep: string;         // last step successfully completed, or 'ingested' at start
  status: PipelineRunSourceStatus;
  errorMessage: string | null;
  updatedAt: Date;
}

export interface UpsertPipelineRunSourceInput {
  runId: string;
  sourceId: string;
  currentStep: string;
  status: PipelineRunSourceStatus;
  errorMessage?: string | null;
}
```

### 4.3 Repository — `packages/core/src/database/repositories/pipeline-run.repository.ts`

Exports:

- `createPipelineRun(pool, input): Promise<PipelineRun>` — inserts a row with `status = 'running'`
- `finalizePipelineRun(pool, id, status): Promise<PipelineRun>` — sets `status` + `finished_at = now()`
- `findPipelineRunById(pool, id): Promise<PipelineRun | null>`
- `findLatestPipelineRun(pool, tag?): Promise<PipelineRun | null>` — newest run (optionally filtered by tag)
- `upsertPipelineRunSource(pool, input): Promise<PipelineRunSource>` — uses `ON CONFLICT (run_id, source_id) DO UPDATE SET current_step = EXCLUDED.current_step, status = EXCLUDED.status, error_message = EXCLUDED.error_message, updated_at = now()`
- `findPipelineRunSourcesByRunId(pool, runId): Promise<PipelineRunSource[]>`
- `findPipelineRunSourceById(pool, runId, sourceId): Promise<PipelineRunSource | null>`
- `countPipelineRunSourcesByStatus(pool, runId): Promise<Record<PipelineRunSourceStatus, number>>`

All queries use parameterised SQL. Row mapping goes through a `mapPipelineRunRow` helper that parses `options` JSONB into a plain object.

### 4.4 Orchestrator — `packages/pipeline/src/pipeline/index.ts`

**Step order constant:**

```typescript
const STEP_ORDER: readonly PipelineStepName[] = ['ingest', 'extract', 'segment', 'enrich', 'embed', 'graph'] as const;
```

**Execute flow:**

1. Validate `input.options.upTo` / `input.options.from` are known step names (else throw `PipelineError(PIPELINE_WRONG_STATUS)`).
2. Compute the `plannedSteps` slice from `STEP_ORDER` using `from` and `upTo`.
3. If `dryRun` is true, build a `PipelineRunResult` with `status: 'success'`, a log-friendly plan, and return early without calling `createPipelineRun`.
4. Call `createPipelineRun({ tag, options })` → `runId`.
5. **Phase 1: Source enumeration.**
   - If `options.sourceIds` is set (retry path): load sources by id via `findSourceById` and enforce they exist. Missing ⇒ `PipelineError(PIPELINE_SOURCE_NOT_FOUND)`.
   - Else if `plannedSteps` contains `ingest`: call `executeIngest({ path: input.path!, ... })`. The result's per-file rows contain source ids. Treat `failed` files as immediate failures written to `pipeline_run_sources` with `status='failed'`, and continue with the successful ones.
   - Else: no ingest is planned (e.g. `--from extract`). Enumerate sources via `findAllSources(pool)` filtered to a status compatible with `from` (see §4.5 "status → step mapping"). This is the "resume from the beginning of step X for all eligible sources" flow.
6. Insert a `pipeline_run_sources` row for each discovered source (`current_step = 'ingested'`, `status = 'pending'`).
7. **Phase 2: Per-source processing.**
   - For each source, in enumeration order:
     - Set the row to `processing`.
     - For each step in `plannedSteps` after `ingest`:
       - Compute `shouldRun(step, source, options)` — see §4.5.
       - If not runnable: update `current_step` to the max step already reached and continue.
       - Execute the step via the corresponding `execute*` function. For stories-fanout steps (enrich, embed, graph), iterate `findStoriesBySourceId(pool, sourceId)` and run the step per story.
       - After each successful step, `upsertPipelineRunSource` with `current_step = step`.
       - On step error: catch, log, `upsertPipelineRunSource({ status: 'failed', errorMessage })`, break out of the per-source loop. Do NOT rethrow — the batch continues.
     - After all planned steps run cleanly: `upsertPipelineRunSource({ status: 'completed' })`.
8. **Phase 3: Finalisation.**
   - Count per-status rows via `countPipelineRunSourcesByStatus`.
   - Decide final run status: `completed` (all succeeded), `partial` (some failed), `failed` (all failed or zero succeeded when > 0 attempted). If zero sources discovered, status is `completed`.
   - Call `finalizePipelineRun(pool, runId, status)`.
   - Return a `PipelineRunResult`.

**Important rules:**

- The orchestrator **never catches** `PipelineError(PIPELINE_WRONG_STATUS)` that comes from `shouldRun` itself — that's a programming error, it escapes. It only catches per-step execute-function errors.
- Each `execute*` call uses the existing service registry already wired per step. The orchestrator does not construct services beyond what each step needs.
- The orchestrator opens a single worker pool via `getWorkerPool(config.gcp.cloud_sql)` and passes it into each step function.
- v2.0 steps (`ground`, `analyze`) are **not** in `STEP_ORDER`. If a future step adds them, `plannedSteps` will naturally include them. For now, the orchestrator does not call them.

### 4.5 `shouldRun()` — step eligibility

```typescript
function shouldRun(
  step: PipelineStepName,
  sourceStatus: SourceStatus,
  storyStatusesByStoryId: Map<string, StoryStatus>,
  options: PipelineRunOptions,
): boolean
```

Step → required current source status (unless `force` is true):

| Step      | Runnable when source status is                                          |
|-----------|--------------------------------------------------------------------------|
| `extract` | `ingested`                                                               |
| `segment` | `extracted`                                                              |
| `enrich`  | `segmented` OR any story is at `segmented` (partial resume)              |
| `embed`   | `enriched` OR any story is at `enriched`                                 |
| `graph`   | `embedded` OR any story is at `embedded`                                 |

If `options.force` is true (retry path), `shouldRun` still requires the source to exist, but the status check is relaxed — each `execute*` call will be made with `force: true` to trigger its own cascading reset.

If the source is already past the step (e.g. status `segmented` but we asked for `extract`), `shouldRun` returns `false` and the orchestrator leaves the `current_step` at the higher-reached step.

### 4.6 CLI command — `apps/cli/src/commands/pipeline.ts`

Follows the graph CLI pattern (`apps/cli/src/commands/graph.ts`). Exports `registerPipelineCommands(program)` which adds a `pipeline` sub-command group.

**`pipeline run <path>`:**

```
mulder pipeline run <path>
  --up-to <step>     Stop after this step (one of: extract|segment|enrich|embed|graph)
  --from <step>      Resume from this step
  --dry-run          Print the plan without executing
  --tag <tag>        Tag this run for later lookup
```

Argument rules:
- `<path>` is required unless `--from` is set and there are already ingested sources — still require `<path>` in v1 to keep UX simple; if absent, exit 1 with usage help.
- `--up-to` and `--from` must be known step names; unknown names exit 1 with a clear error.
- If `--from <x>` and `--up-to <y>` are both set and `y` comes before `x` in `STEP_ORDER`, exit 1.
- On success, print a summary table: `Source | Status | Current Step | Error` for the top N (default all, truncate at 50 rows) followed by a one-line summary.
- Exit 0 on `success`/`partial` when at least one source completed; exit 1 on `failed`.

**`pipeline status`:**

```
mulder pipeline status
  --source <id>      Per-source status across runs (latest row wins)
  --tag <tag>        Latest run with this tag
  --run <id>         Status of a specific run
  --json             Machine-readable output
```

Default (no flags): shows the most recent run — counts per status + the slowest/failing sources.
- `--source`: shows `current_step`, `status`, `error_message` for that source within its most recent run.
- `--json`: same data as table form, as JSON.

Exits 0 unless the targeted run/source is not found (exit 1).

**`pipeline retry <source-id>`:**

```
mulder pipeline retry <source-id>
  --step <step>      Retry a specific step (default: the failed step)
```

Loads the latest `pipeline_run_sources` row for the source. If its status is not `failed`, exit 1. Creates a new `pipeline_runs` row with a tag like `retry:<short-source-id>`, calls the orchestrator with `sourceIds: [sourceId]`, `from: step ?? failedStep`, `force: true`, `upTo: step ?? failedStep` (i.e. retry just that one step). Returns the new run's result.

**Error handling:**

All command handlers are wrapped in `withErrorHandler`. Validation errors use `printError` + `process.exit(1)` (consistent with other commands). Orchestrator errors bubble up and are printed by the error handler.

### 4.7 Integration points

- Register `registerPipelineCommands(program)` in `apps/cli/src/index.ts` (alphabetical with other `register*Commands` calls).
- Barrel from `packages/pipeline/src/index.ts`:
  ```typescript
  export type {
    PipelineRunInput,
    PipelineRunOptions,
    PipelineRunResult,
    PipelineRunSourceOutcome,
    PipelineStepName,
  } from './pipeline/index.js';
  export { execute as executePipelineRun, STEP_ORDER } from './pipeline/index.js';
  ```
- Barrel from `packages/core/src/database/repositories/index.ts`:
  ```typescript
  export * from './pipeline-run.repository.js';
  export type * from './pipeline-run.types.js';
  ```
- The re-exports propagate through `packages/core/src/index.ts` like the existing repository barrels.

### 4.8 Logging

Use `createChildLogger({ module: 'pipeline-orchestrator', runId })` at run start. Emit structured JSON log lines:

- `pipeline.run.start` — `{ runId, tag, plannedSteps, totalSources }`
- `pipeline.source.start` — `{ runId, sourceId, step }`
- `pipeline.source.step.ok` — `{ runId, sourceId, step, duration_ms }`
- `pipeline.source.step.failed` — `{ runId, sourceId, step, errorCode, errorMessage }` (warn, not error)
- `pipeline.run.finish` — `{ runId, status, totals }`

Do not log stack traces at warn level — the per-step `execute` functions already log their own failures.

### 4.9 Config

**No schema changes required.** The orchestrator does not read any new config key. All per-step config (batch sizes, concurrency) is already owned by the individual steps.

## 5. QA Contract

Each QA condition maps to one black-box test in `tests/specs/36_pipeline_orchestrator.test.ts`. Tests use the CLI (`npx mulder …`) or direct SQL via `pg`. Fixtures come from the existing test database + fixture PDFs, consistent with specs 33-35.

### QA-01: Happy path — full pipeline run

**Given** a directory with 1 fixture PDF and a dev-mode / test config
**When** `mulder pipeline run <dir>` is run
**Then** a new row is inserted into `pipeline_runs` with `status = 'completed'`, one row exists in `pipeline_run_sources` with `status = 'completed'` and `current_step = 'graph'`, and the corresponding `sources.status` is `graphed`. Exit code 0.

### QA-02: `--up-to enrich` stops mid-pipeline

**Given** a fresh source to be processed
**When** `mulder pipeline run <dir> --up-to enrich` is run
**Then** the source reaches `enriched` (not `embedded` or `graphed`), `pipeline_run_sources.current_step = 'enrich'`, and `pipeline_runs.status = 'completed'`. Exit 0.

### QA-03: `--from embed` resumes from the cursor

**Given** an existing source already at status `enriched` (no running ingest needed)
**When** `mulder pipeline run <dir> --from embed` is run
**Then** ingest/extract/segment/enrich are skipped for that source, embed + graph run, source reaches `graphed`, and `pipeline_run_sources.current_step = 'graph'`. Exit 0.

### QA-04: Failed source does not crash the batch

**Given** two sources in a single run where source A succeeds and source B is forced to fail at extract (e.g. by corrupting its upload reference in a test fixture)
**When** `mulder pipeline run <dir>` is run
**Then** source A reaches `graphed` with `status = 'completed'`, source B is `status = 'failed'` with `error_message` populated, `pipeline_runs.status = 'partial'`. Exit code 0 (partial is not a hard failure).

### QA-05: `--dry-run` makes no writes

**When** `mulder pipeline run <dir> --dry-run` is run
**Then** no `pipeline_runs` row is created, no source changes status, the command prints the planned step list and source count, exits 0.

### QA-06: `--tag` is persisted

**When** `mulder pipeline run <dir> --tag nightly-2026-04-07` is run
**Then** the newest `pipeline_runs` row has `tag = 'nightly-2026-04-07'`.

### QA-07: Status across runs

**Given** at least one completed run
**When** `mulder pipeline status` is run
**Then** the command prints the latest run's totals and exits 0.

### QA-08: Status for a specific source

**Given** a source that has been processed in at least one run
**When** `mulder pipeline status --source <id>` is run
**Then** the command prints that source's latest `current_step`, `status`, and any `error_message`, and exits 0.

### QA-09: Status JSON output is valid JSON

**When** `mulder pipeline status --json` is run
**Then** stdout contains a single valid JSON object with fields `runId`, `status`, `totals`, `sources`. Exit 0.

### QA-10: Retry a failed source

**Given** a source whose latest run ended with `status = 'failed'` at step `extract`
**When** `mulder pipeline retry <source-id>` is run
**Then** a new `pipeline_runs` row is created, the source is re-attempted from `extract`, and on success its latest `pipeline_run_sources` row has `status = 'completed'`. Exit 0.

### QA-11: Unknown `--up-to` step rejected

**When** `mulder pipeline run <dir> --up-to analyze` is run
**Then** the command prints an error listing valid step names and exits 1 without creating a `pipeline_runs` row.

### QA-12: `--from` after `--up-to` rejected

**When** `mulder pipeline run <dir> --from graph --up-to extract` is run
**Then** the command prints an error explaining the ordering constraint and exits 1.

### QA-13: Missing path rejected

**When** `mulder pipeline run` is run with no `<path>` argument and no `--from`
**Then** the command prints usage help and exits 1.

### QA-14: Idempotent re-run (no double work)

**Given** a source that is already `graphed`
**When** `mulder pipeline run <dir>` is run again on the same directory
**Then** the source is either skipped at ingest (via hash dedup — existing ingest behaviour) or marked `completed` at its current step immediately; no duplicate edges are created and the final run `status = 'completed'`. Exit 0.

## 5b. CLI Test Matrix

| ID | Command | Expected |
|----|---------|----------|
| CLI-01 | `mulder pipeline --help` | Lists `run`, `status`, `retry` subcommands, exits 0 |
| CLI-02 | `mulder pipeline run --help` | Shows `--up-to`, `--from`, `--dry-run`, `--tag` options, exits 0 |
| CLI-03 | `mulder pipeline status --help` | Shows `--source`, `--tag`, `--run`, `--json` options, exits 0 |
| CLI-04 | `mulder pipeline retry --help` | Shows `--step` option, exits 0 |
| CLI-05 | `mulder pipeline run` (no args) | Error: `<path>` required, exits 1 |
| CLI-06 | `mulder pipeline run <dir> --up-to bogus` | Error: unknown step `bogus`, exits 1 |
| CLI-07 | `mulder pipeline run <dir> --from graph --up-to extract` | Error: `--from` comes after `--up-to`, exits 1 |
| CLI-08 | `mulder pipeline retry` (no source-id) | Error: source-id required, exits 1 |
| CLI-09 | `mulder pipeline retry bogus-uuid` | Error: source not found, exits 1 |
| CLI-10 | `mulder pipeline status --run bogus-uuid` | Error: run not found, exits 1 |
