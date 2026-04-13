---
spec: "67"
title: "Job Queue Repository"
roadmap_step: M7-H1
functional_spec: ["§4.3 (jobs table)", "§10.2", "§10.3"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/168"
created: 2026-04-13
---

# Spec 67: Job Queue Repository

## 1. Objective

Implement the repository layer for Mulder's async job queue so the upcoming API and worker can enqueue jobs, atomically claim the next runnable job, inspect queue state, and recover stale running jobs without introducing Redis, Pub/Sub, or an ORM. Per `§10.2`, PostgreSQL is the task broker; per `§10.3`, dequeue must use `FOR UPDATE SKIP LOCKED` and keep the claim itself as a short auto-commit statement rather than a long-lived transaction.

## 2. Boundaries

- **Roadmap Step:** `M7-H1` — Job queue repository — enqueue/dequeue/reap
- **Target:** `packages/core/src/database/repositories/job.types.ts`, `packages/core/src/database/repositories/job.repository.ts`, `packages/core/src/database/repositories/index.ts`, `tests/specs/67_job_queue_repository.test.ts`
- **In scope:** typed `jobs` table records and DTOs; enqueue/create helpers; read helpers needed to inspect queued work; atomic dequeue that claims the oldest pending runnable job and stamps worker ownership; terminal-state updates for completed and failed jobs; dead-letter transition when attempts are exhausted; and stale-running-job reaping for later worker/status flows
- **Out of scope:** worker CLI/process management (`M7-H2`), HTTP routes (`M7-H3` through `M7-H10`), pipeline-step chaining logic after job completion, retry CLI/reset flows (`M8-I5`), and any schema/config changes beyond using the existing `jobs` table
- **Constraints:** all SQL must be parameterized; no ORM; repository functions must keep the dequeue claim as a single auto-commit statement and must not require callers to hold an open transaction during pipeline work; payload stays opaque JSONB; and the implementation must follow existing Mulder repository patterns for `DatabaseError`, logging, and camelCase row mapping

## 3. Dependencies

- **Requires:** Spec 07 (`M1-A6`) database client and dual pools, Spec 09 (`M1-A8`) migration `012_job_queue.sql`, and the shared error/logging utilities under `packages/core/src/shared/`
- **Blocks:** `M7-H2` worker loop, `M7-H5` pipeline API job production, and `M7-H6` job status API

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/database/repositories/job.types.ts`** — defines the queue-facing job contract: `JobStatus`, `Job`, enqueue inputs, queue filters, and small result types for dequeue/reap operations
2. **`packages/core/src/database/repositories/job.repository.ts`** — implements the plain-function repository for enqueueing, listing, looking up, dequeuing, completing, failing, dead-lettering, and reaping jobs
3. **`packages/core/src/database/repositories/index.ts`** — re-exports the new job repository and types through the existing database barrel
4. **`tests/specs/67_job_queue_repository.test.ts`** — black-box QA coverage for queue lifecycle behavior against the real PostgreSQL schema

### 4.2 Database Changes

No new schema is introduced in this step. The repository is the data-access layer over the existing `jobs` table from `012_job_queue.sql`:

```sql
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          job_status NOT NULL DEFAULT 'pending',
  attempts        INTEGER DEFAULT 0,
  max_attempts    INTEGER DEFAULT 3,
  error_log       TEXT,
  worker_id       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
```

The dequeue path must implement the `§10.3` claim pattern as one auto-commit statement:

```sql
UPDATE jobs
SET status = 'running',
    started_at = now(),
    attempts = attempts + 1,
    worker_id = $1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending' AND attempts <= max_attempts
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

Failure updates must preserve retry semantics:

- if the just-finished attempt still has retries remaining, keep the failure visible with `status = 'failed'`, store `error_log`, and stamp `finished_at`
- if `attempts >= max_attempts`, transition the row to `status = 'dead_letter'`
- if the reaper resets a stale `running` row, it returns the row to `pending` without changing `attempts`; a pending row at exactly `max_attempts` is allowed one recovery pickup, and any later crash or explicit failure after that pickup must end in `dead_letter`

This spec does not add the later retry reset flow; it only preserves the terminal states the next milestones consume.

### 4.3 Config Changes

None. Callers may pass `max_attempts` when enqueueing, typically sourced from the existing `pipeline.retry.max_attempts` config, but the repository itself does not add or change config schema.

### 4.4 Integration Points

- `M7-H2` will use `dequeueJob`, `markJobCompleted`, `markJobFailed`, and `reapRunningJobs` as the worker's queue boundary
- `M7-H5` and later status surfaces may use `findJobById`, `findJobs`, and `countJobs` to expose queue state without reaching into raw SQL
- enqueue helpers must keep `payload` generic enough for pipeline, taxonomy, grounding, and later async job types
- dequeue ordering must respect FIFO-by-`created_at` among runnable pending jobs
- dequeue, completion, failure, and reaping must all leave rows in states that are externally inspectable by a later status API

### 4.5 Implementation Phases

**Phase 1: Job types + repository**
- add `job.types.ts`
- implement the repository functions in `job.repository.ts`
- wire exports into the repositories barrel

**Phase 2: Queue QA coverage**
- add black-box repository tests in `tests/specs/67_job_queue_repository.test.ts`
- verify the queue lifecycle behavior against the live schema, including claim ordering and stale-job reaping

## 5. QA Contract

1. **QA-01: Enqueue creates a pending job with the expected defaults**
   - Given: a migrated PostgreSQL database
   - When: a job is enqueued with `type`, `payload`, and no explicit status override
   - Then: a row exists in `jobs` with `status='pending'`, `attempts=0`, the provided payload, and a non-empty `id`

2. **QA-02: Job lookup and filtered listing expose queue state**
   - Given: queued jobs with different `type` and `status` values
   - When: the repository looks up a job by ID and lists jobs with filters
   - Then: the returned rows match the stored queue state and are ordered newest-first for inspection surfaces

3. **QA-03: Dequeue claims the oldest runnable pending job exactly once**
   - Given: multiple pending jobs with distinct `created_at` order
   - When: a worker dequeues the next job
   - Then: the oldest pending row is returned, its status becomes `running`, `attempts` increments by one, `worker_id` is stored, and a second dequeue does not return the same row again

4. **QA-04: Dequeue skips unrunnable jobs**
   - Given: jobs already `running`, already terminal, or already beyond the retry budget (`attempts > max_attempts`)
   - When: `dequeueJob` runs
   - Then: those rows are ignored, while a pending row at exactly `attempts = max_attempts` remains eligible for one recovery pickup after reap

5. **QA-05: Mark completed finalizes the claimed job**
   - Given: a running job
   - When: the repository marks it completed
   - Then: the row becomes `completed`, `finished_at` is set, and the worker ownership remains traceable

6. **QA-06: Mark failed records the error and preserves retry/dead-letter semantics**
   - Given: a running job with remaining retries, and another running job whose latest attempt exhausts `max_attempts`
   - When: the repository marks each job failed
   - Then: the first row ends in `failed` with `error_log` and `finished_at` populated, and the exhausted row ends in `dead_letter`

7. **QA-07: Reaper resets stale running jobs back to pending**
   - Given: a running job whose `started_at` is older than the configured stale threshold
   - When: the repository reaps stale jobs
   - Then: that row returns to `pending`, clears `worker_id` and `started_at`, and is counted in the reap result

8. **QA-08: Fresh running jobs are not reaped**
   - Given: a running job whose `started_at` is newer than the stale threshold
   - When: the reaper runs
   - Then: the row remains `running` and the reap result count does not include it

9. **QA-09: Repository exports compile cleanly through the public database barrel**
   - Given: the repository has been wired into `packages/core/src/database/repositories/index.ts`
   - When: the workspace TypeScript build runs
   - Then: the new job types and repository functions are importable from `@mulder/core` without build errors

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None. This step is PostgreSQL-only and does not call paid services.
