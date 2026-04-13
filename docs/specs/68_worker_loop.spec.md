---
spec: "68"
title: "Worker Loop"
roadmap_step: M7-H2
functional_spec: ["§1 (worker cmd)", "§10.3", "§10.4", "§10.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/170"
created: 2026-04-13
---

# Spec 68: Worker Loop

## 1. Objective

Implement Mulder's background worker runtime so async jobs created from the PostgreSQL queue can be claimed, executed, observed, and recovered entirely through the CLI-first surface. Per `§10.3`, queue claims must remain short auto-commit statements with no long-lived transaction around step execution; per `§10.4` and `§10.5`, `mulder worker start`, `mulder worker status`, and `mulder worker reap` must give operators a safe way to run the queue, inspect active work, and recover stuck jobs without adding Redis, Pub/Sub, or Cloud Tasks.

## 2. Boundaries

- **Roadmap Step:** `M7-H2` — Worker loop — `mulder worker start/status/reap`
- **Target:** `packages/worker/src/worker.types.ts`, `packages/worker/src/dispatch.ts`, `packages/worker/src/runtime.ts`, `packages/worker/src/index.ts`, `apps/cli/src/commands/worker.ts`, `apps/cli/src/index.ts`, `tests/specs/68_worker_loop.test.ts`
- **In scope:** worker runtime configuration and types; deterministic worker ID generation and structured logging; polling loop over the existing job repository; job dispatch for currently supported async job types; graceful shutdown semantics; CLI commands for `worker start`, `worker status`, and `worker reap`; and black-box coverage for queue polling, completion/failure marking, stale-job recovery, and operator-visible status output
- **Out of scope:** HTTP API routes (`M7-H3` through `M7-H10`), Hono server bootstrap (`M7-H3`), new queue schema changes beyond the existing `jobs` table, document viewer work (`M7-H11`), and the later dead-letter retry command surface (`M8-I5`)
- **Constraints:** no long-lived transaction or checked-out DB client may span pipeline execution; the worker must use the dedicated OLTP pool from `getWorkerPool`; CLI commands remain thin wrappers that load config and call package/runtime functions; supported job dispatch must follow the per-step job-slicing model from `§10.2`; and shutdown must leave the database in an externally inspectable state instead of swallowing in-flight failures

## 3. Dependencies

- **Requires:** Spec 07 (`M1-A6`) database client and pool lifecycle helpers, Spec 09 (`M1-A8`) job queue schema, Spec 67 (`M7-H1`) job queue repository operations, the existing CLI scaffold from Spec 06, and the pipeline entrypoints already exported by `@mulder/pipeline`
- **Blocks:** `M7-H5` pipeline API job production, `M7-H6` job status API, and any end-to-end async execution flow in M7 because those steps rely on a real worker consumer

## 4. Blueprint

### 4.1 Files

1. **`packages/worker/src/worker.types.ts`** — worker runtime types, supported job payload shapes, status snapshot types, and CLI-facing option contracts
2. **`packages/worker/src/dispatch.ts`** — maps dequeued job types to the correct pipeline/taxonomy execution function and validates the payload fields each job requires
3. **`packages/worker/src/runtime.ts`** — implements the polling loop, dequeue/execute/mark-complete-or-fail cycle, graceful shutdown, status inspection helpers, and reap helper built on the existing job repository
4. **`packages/worker/src/index.ts`** — public exports for runtime helpers consumed by the CLI package
5. **`apps/cli/src/commands/worker.ts`** — Commander registration for `mulder worker start`, `mulder worker status`, and `mulder worker reap`
6. **`apps/cli/src/index.ts`** — registers the new worker command group
7. **`tests/specs/68_worker_loop.test.ts`** — black-box/spec-level QA for the runtime and CLI-visible behavior against the real job table

### 4.2 Database Changes

No new schema is introduced. This step consumes the existing `jobs` table and the repository functions added in Spec 67.

The runtime must preserve the critical transaction discipline from `§10.3`:

1. `dequeueJob(workerId)` runs as one auto-commit claim statement
2. the actual job handler runs with no open transaction wrapping it
3. `markJobCompleted(...)` or `markJobFailed(...)` runs as a separate auto-commit write

`worker status` should read queue state through repository helpers such as `findJobs`, `countJobs`, and/or `findJobById`, while `worker reap` should call the stale-running-job reset path without directly issuing ad hoc SQL from the CLI layer.

### 4.3 Config Changes

No Mulder config schema changes are required in this step. `worker start` exposes runtime knobs as CLI flags:

- `--concurrency <n>` with default `1`
- `--poll-interval <ms>` with default `5000`

The initial implementation may process one claimed job at a time even when the concurrency value is parsed, as long as the runtime shape and validation leave room for follow-up parallelism without breaking the CLI contract. If true parallel job execution is added now, it must still preserve the no-open-transaction rule for every claimed job.

### 4.4 Integration Points

- `@mulder/core` provides `loadConfig`, `getWorkerPool`, queue repositories, logging, and pool shutdown helpers
- `@mulder/pipeline` provides the async step entrypoints invoked from job dispatch
- `mulder worker start` is the operator-facing runner for background execution in local/dev and later Cloud Run container modes
- `mulder worker status` is the first operator-visible queue inspection surface before the HTTP status API lands
- `mulder worker reap` is the manual recovery tool for stale `running` jobs before the later retry CLI expands dead-letter workflows

### 4.5 Implementation Phases

**Phase 1: Runtime foundation**
- define worker options, job payload guards, and status snapshot types
- implement worker ID generation, polling loop, and graceful-stop control flow
- wire dequeue → dispatch → complete/fail using the Spec 67 repository boundary

**Phase 2: CLI surface**
- add the `worker` command group with `start`, `status`, and `reap`
- keep the command handlers thin: config load, runtime invocation, formatted operator output, and proper exit codes

**Phase 3: QA coverage**
- add black-box tests for successful job execution, failed job execution, idle polling behavior, status visibility, and stale-job recovery
- verify the CLI/runtime closes pools cleanly on exit and leaves queue state externally visible

## 5. QA Contract

1. **QA-01: `worker start` claims and completes a runnable job**
   - Given: a pending job of a supported type in the `jobs` table
   - When: the worker starts and processes one poll cycle
   - Then: the job is claimed by a worker ID, the matching handler runs, and the row ends in `completed`

2. **QA-02: Failed handlers mark the job failed or dead-letter according to retry state**
   - Given: a pending job whose handler throws, with one case below `max_attempts` and one case exhausting it
   - When: the worker processes the job
   - Then: the first row ends in `failed` with error details, and the exhausted row ends in `dead_letter`

3. **QA-03: Idle polling does not mutate the queue**
   - Given: no pending runnable jobs
   - When: `worker start` polls the queue
   - Then: no rows are modified and the worker sleeps until the next interval or shutdown

4. **QA-04: The worker never requires a long-lived transaction around step execution**
   - Given: a job handler that performs slow asynchronous work
   - When: the worker claims and executes that job
   - Then: queue state remains correct without wrapping dequeue, execution, and completion in one transaction, and the job record is still inspectable by separate reads during execution

5. **QA-05: `worker status` reports running and pending queue state**
   - Given: a mix of pending, running, completed, failed, and dead-letter jobs
   - When: the status command runs
   - Then: operators can see active worker-owned jobs and queue counts without reading implementation internals

6. **QA-06: `worker reap` resets stale running jobs and leaves fresh jobs alone**
   - Given: one running job older than the stale threshold and one more recent running job
   - When: `mulder worker reap` runs
   - Then: only the stale job returns to `pending`, its worker ownership is cleared, and the fresh job remains `running`

7. **QA-07: Graceful shutdown stops polling without corrupting the claimed job state**
   - Given: the worker process receives a shutdown signal while idle or between jobs
   - When: shutdown is requested
   - Then: the polling loop exits cleanly, logs the stop event, and closes pooled resources without leaving synthetic failures behind

8. **QA-08: Public package exports and CLI registration compile cleanly**
   - Given: the worker runtime and CLI command files are wired into the workspace
   - When: the TypeScript build/typecheck runs
   - Then: `@mulder/worker` exports the runtime helpers and the `mulder worker` command tree is available without type errors

## 5b. CLI Test Matrix

| Command | Scenario | Expected |
|--------|----------|----------|
| `mulder worker start` | default flags, one supported pending job | job is processed and logged with a worker ID |
| `mulder worker start --poll-interval 100` | no jobs pending | process waits without mutating queue state |
| `mulder worker start --concurrency 1` | handler throws | job becomes `failed` or `dead_letter` per retry budget |
| `mulder worker status` | mixed queue states | output shows pending/running/terminal counts and active worker ownership |
| `mulder worker reap` | stale vs fresh running jobs | only stale jobs are reset to `pending` |

## 6. Cost Considerations

None for direct service spend. The worker runtime itself is PostgreSQL-backed and CLI-driven; its main operational constraint is avoiding accidental long-lived transactions or runaway polling behavior that would create unnecessary database load.
