---
spec: "80"
title: "Step-Chained Async Pipeline API Jobs"
roadmap_step: ""
functional_spec: ["§10.2", "§10.6"]
scope: phased
issue: ""
created: 2026-04-18
---

# Spec 80: Step-Chained Async Pipeline API Jobs

## 1. Objective

Rewrite the async pipeline API producer path so `POST /api/pipeline/run` and `POST /api/pipeline/retry` enqueue step-scoped jobs instead of one monolithic `pipeline_run` job. This restores the execution model described in `§10.2`: the API remains a pure job producer, but the queue holds one step job per source at a time, and successful completion of a step enqueues the next step as a new job.

This spec depends on Spec 79’s worker/runtime contract. Its job is to move the normal acceptance path over to the new queue model while preserving `202 Accepted`, job observability, and `pipeline_run_sources` progress tracking.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap M7 remediation follow-up for review divergence `DIV-001`
- **Target:** `apps/api/src/routes/pipeline.schemas.ts`, `apps/api/src/routes/pipeline.ts`, `apps/api/src/lib/pipeline-jobs.ts`, `apps/api/src/lib/job-status.ts`, `packages/worker/src/dispatch.ts`, `packages/worker/src/runtime.ts`, `tests/specs/80_step_chained_pipeline_api_jobs.test.ts`
- **In scope:** changing the normal API acceptance path from `pipeline_run` payloads to step-scoped job creation; enqueueing only the first step at acceptance time; enqueueing the next step only after the current one succeeds; preserving `pipeline_runs` and `pipeline_run_sources` observability; and rewriting retry acceptance so a failed step is retried as one explicit step job
- **Out of scope:** worker payload definitions beyond what Spec 79 introduced, browser auth/session work, OpenAPI/Scalar explorer decisions, and dead-letter manual recovery
- **Constraints:** the API must still return `202 Accepted` immediately; no route handler may execute pipeline steps directly; ordinary accepted work must stop creating `type = 'pipeline_run'` queue rows; and `--up-to` / retry semantics must remain externally observable through the queue and status routes

## 3. Dependencies

- **Requires:** Spec 71 (`M7-H5`) async pipeline API routes and Spec 79 in this follow-up set
- **Blocks:** Spec 81 in this follow-up set, because retry semantics are easier to finalize once the API is producing the correct job shape

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/pipeline.schemas.ts`** — keep the public acceptance/request contract stable where possible while reflecting step-scoped job behavior where needed
2. **`apps/api/src/lib/pipeline-jobs.ts`** — rewrite run/retry acceptance so it creates the correct first step job and records the run metadata needed for later chaining
3. **`apps/api/src/routes/pipeline.ts`** — keep the route handlers thin while delegating to the new producer behavior
4. **`apps/api/src/lib/job-status.ts`** — ensure API status/progress reporting still surfaces the right job/run state during step chaining
5. **`packages/worker/src/dispatch.ts`** and **`runtime.ts`** — add the minimal chaining hook needed so successful step completion can enqueue the next step job
6. **`tests/specs/80_step_chained_pipeline_api_jobs.test.ts`** — black-box verification for accepted run/retry requests and chained step-job progression

### 4.2 Acceptance Model

#### `POST /api/pipeline/run`

- validates the request
- creates a `pipeline_runs` row
- records source progress metadata
- enqueues exactly one initial step job for the requested source/run
- returns `202` plus the first `job_id`

#### `POST /api/pipeline/retry`

- validates that a retryable failed step exists
- enqueues exactly one step-scoped retry job for that failed step
- does not recreate the old monolithic `pipeline_run` path

### 4.3 Chaining Rule

When a step job succeeds:

- if the run has another step within its planned range, the system enqueues the next step as a fresh job
- if the completed step is the final planned step, the run ends without enqueueing another job
- `up_to` means “stop chaining after this step”

### 4.4 Integration Points

- the API remains a pure producer
- the worker becomes the only component allowed to advance a run by enqueueing the next step
- `pipeline_run_sources` continues to expose externally inspectable per-source progress
- job status APIs remain meaningful even though one logical run now spans multiple queue rows

### 4.5 Implementation Phases

**Phase 1: acceptance rewrite**
- stop enqueuing normal `pipeline_run` jobs
- produce the correct first step job

**Phase 2: worker-side chaining**
- enqueue follow-on step jobs only after success
- respect `up_to` and retry boundaries

**Phase 3: observability + QA**
- keep run/job status externally clear
- add black-box tests for run, retry, and stop conditions

## 5. QA Contract

1. **QA-01: accepted pipeline runs enqueue the first step job, not pipeline_run**
   - Given: a valid `POST /api/pipeline/run` request
   - When: the API accepts it
   - Then: the response is `202`, and the queue contains the first step job rather than a monolithic `pipeline_run` job

2. **QA-02: successful step completion enqueues the next planned step**
   - Given: a run spanning multiple steps
   - When: the worker completes the current step job successfully
   - Then: the next step is enqueued as a new job for the same run/source

3. **QA-03: up_to stops the chain**
   - Given: a run request with an `up_to` boundary
   - When: the worker completes that final planned step
   - Then: no additional step job is enqueued

4. **QA-04: retry enqueues one explicit failed-step job**
   - Given: a source with a retryable failed step
   - When: `POST /api/pipeline/retry` is accepted
   - Then: the queue contains one retry job for that step, not a broad pipeline re-run

5. **QA-05: normal accepted work no longer creates pipeline_run queue rows**
   - Given: ordinary accepted API run/retry requests
   - When: they are persisted
   - Then: the queue does not receive new `type = 'pipeline_run'` rows for those requests

## 5b. CLI Test Matrix

N/A — no CLI command surface is introduced or modified in this step.

## 6. Cost Considerations

- **Services called:** unchanged relative to the requested pipeline steps
- **Estimated cost per run:** unchanged in total, but distributed across shorter queue jobs
- **Dev mode alternative:** yes — API acceptance and worker chaining can be verified against local/dev queue execution
- **Safety flags:** the rewrite must not break `202` acceptance semantics or strand in-flight run observability
