---
spec: "71"
title: "Async Pipeline API Routes"
roadmap_step: M7-H5
functional_spec: ["§10.2", "§10.6"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/178"
created: 2026-04-14
---

# Spec 71: Async Pipeline API Routes

## 1. Objective

Introduce Mulder's first async pipeline HTTP routes so authenticated API clients can trigger background processing without calling pipeline functions directly from the request/response cycle. Per `§10.6`, the API must stay a pure job producer that returns `202 Accepted` plus a job reference; per `§10.2`, the queue-backed path must preserve observable progress through the existing `jobs` and `pipeline_runs` data model instead of inventing ad hoc in-memory execution.

This step ships the source-scoped async entrypoints for pipeline execution and retry:

- `POST /api/pipeline/run`
- `POST /api/pipeline/retry`

The initial API contract should reuse the already-shipped pipeline orchestrator and queue infrastructure so the HTTP layer remains thin, validation-heavy, and externally inspectable.

## 2. Boundaries

- **Roadmap Step:** `M7-H5` — Pipeline API routes (async)
- **Target:** `apps/api/src/app.ts`, `apps/api/src/routes/pipeline.schemas.ts`, `apps/api/src/routes/pipeline.ts`, `apps/api/src/lib/pipeline-jobs.ts`, `packages/worker/src/worker.types.ts`, `packages/worker/src/dispatch.ts`, `packages/worker/src/runtime.ts`, `tests/specs/71_pipeline_api_routes.test.ts`
- **In scope:** authenticated async pipeline route registration under `/api/pipeline/*`; Zod-backed request/response contracts for run and retry; source existence and retry-precondition validation against the existing repositories; queue/job creation using the existing `jobs` and `pipeline_runs` tables; worker payload support for API-created pipeline jobs that execute the existing orchestrator for a single source; and black-box coverage for accepted requests, invalid requests, missing sources, retry gating, and externally inspectable queue state
- **Out of scope:** job status/read routes (`M7-H6`); synchronous search/entity/evidence/document routes (`M7-H7` through `M7-H10`); upload/import endpoints for new files; taxonomy async routes; OpenAPI/Scalar publication; multi-source batch submission; and any UI work (`M7-H11`)
- **Constraints:** the API route handlers must not call pipeline step functions or the orchestrator directly; all execution must happen through the queue/worker boundary; response bodies must follow Mulder's API envelope shape; request validation must happen at the HTTP edge; the route layer must stay source-scoped rather than inventing filesystem-path semantics; and retry requests must reuse the existing failed-step semantics from the CLI/orchestrator rather than introducing a second retry model

## 3. Dependencies

- **Requires:** Spec 14 (`M2-B2`) source repository lookups, Spec 36 (`M4-D6`) pipeline orchestrator + `pipeline_runs`/`pipeline_run_sources`, Spec 67 (`M7-H1`) job queue repository, Spec 68 (`M7-H2`) worker loop, Spec 69 (`M7-H3`) Hono server scaffold, and Spec 70 (`M7-H4`) API middleware stack
- **Blocks:** `M7-H6` job status API, because the accepted response must link to real queued work; and any external API consumer that needs to start or retry pipeline processing through HTTP rather than CLI

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/pipeline.schemas.ts`** — defines the route-facing Zod schemas for pipeline run/retry requests and the shared `202 Accepted` job envelope
2. **`apps/api/src/lib/pipeline-jobs.ts`** — owns repository-backed helpers for validating a source, deriving retry inputs, creating `pipeline_runs` metadata, and enqueueing the corresponding job
3. **`apps/api/src/routes/pipeline.ts`** — registers `POST /api/pipeline/run` and `POST /api/pipeline/retry` on the Hono app and maps service outcomes to HTTP responses
4. **`apps/api/src/app.ts`** — mounts the pipeline routes beneath the existing middleware stack
5. **`packages/worker/src/worker.types.ts`** — extends the queue payload contract so API-created pipeline jobs can carry `runId`, `from`, `upTo`, `tag`, and retry/force intent
6. **`packages/worker/src/dispatch.ts`** — executes an API-created pipeline job by calling the existing single-source pipeline orchestrator rather than treating it as an extract-only legacy placeholder
7. **`packages/worker/src/runtime.ts`** — keeps payload decoding aligned with the richer pipeline job contract
8. **`tests/specs/71_pipeline_api_routes.test.ts`** — black-box tests covering accepted requests, validation failures, missing sources, retry preconditions, and job/pipeline-run persistence

### 4.2 Route Contract

#### `POST /api/pipeline/run`

Request body:

```json
{
  "source_id": "uuid",
  "from": "extract | segment | enrich | embed | graph",
  "up_to": "extract | segment | enrich | embed | graph",
  "tag": "optional-tag",
  "force": false
}
```

Rules:

- `source_id` is required and must reference an existing source row
- `from` and `up_to` are optional, but when both are present `from` must not come after `up_to`
- the API is source-scoped: it operates on an existing source id, not a local path or upload payload
- on acceptance, the route creates a `pipeline_runs` row that records the requested options and enqueues exactly one queue job for the worker boundary

Accepted response:

```json
{
  "data": {
    "job_id": "uuid",
    "status": "pending",
    "run_id": "uuid"
  },
  "links": {
    "status": "/api/jobs/{job_id}"
  }
}
```

#### `POST /api/pipeline/retry`

Request body:

```json
{
  "source_id": "uuid",
  "step": "extract | segment | enrich | embed | graph",
  "tag": "optional-tag"
}
```

Rules:

- `source_id` is required and must reference an existing source row
- if `step` is omitted, the route derives the latest failed step from `pipeline_run_sources`
- retry is only allowed when the source has a latest failed pipeline step to retry; otherwise return a conflict-style error and do not enqueue work
- retry is implemented as a new queued pipeline job with `force: true`, `from = step`, and `up_to = step`

### 4.3 Queue And Worker Contract

This step uses a single queued pipeline job as the HTTP-to-worker handoff for one source. The payload must be explicit and replayable:

```json
{
  "sourceId": "uuid",
  "runId": "uuid",
  "from": "extract",
  "upTo": "graph",
  "tag": "api-optional-tag",
  "force": false
}
```

Worker behavior:

- decode the richer `pipeline_run` payload
- call the existing pipeline orchestrator with `sourceIds: [sourceId]`
- pass through `from`, `upTo`, `tag`, and `force`
- let the orchestrator remain the owner of `pipeline_runs` / `pipeline_run_sources` progress semantics

This preserves the API rule that requests only enqueue work while keeping progress externally visible in the same tables the CLI path already uses.

### 4.4 Config Changes

None. This step consumes the existing API middleware/config surface from Spec 70 and the existing database/service configuration required by the worker/orchestrator.

### 4.5 Integration Points

- the route layer uses `@mulder/core` repository exports for `findSourceById`, `findLatestPipelineRunSourceForSource`, `createPipelineRun`, and `enqueueJob`
- accepted responses link forward to the future job-status routes in `M7-H6`
- the worker remains the only process that executes pipeline work after an API request is accepted
- retry semantics stay aligned with `mulder pipeline retry <source-id>` so HTTP and CLI operators see the same failure model

### 4.6 Implementation Phases

**Phase 1: HTTP contracts + route wiring**
- add request/response schemas for run and retry
- add repository-backed helpers that validate the source/retry state and persist the accepted job metadata
- mount the new routes in the API app

**Phase 2: Worker payload bridge**
- extend the `pipeline_run` queue payload to carry the data required by the API contract
- update worker payload decoding and dispatch so the queued pipeline job executes the existing single-source orchestrator contract

**Phase 3: Black-box QA**
- add API-focused tests for accepted requests, validation failures, missing sources, retry conflicts, and persisted queue/run metadata
- verify the API and worker packages still compile with the richer job payload contract

## 5. QA Contract

1. **QA-01: `POST /api/pipeline/run` accepts a valid source-scoped request**
   - Given: an existing source id and a valid API key
   - When: `POST /api/pipeline/run` is called with a valid body
   - Then: the response is `202`, the body includes `job_id`, `run_id`, and a `/api/jobs/{job_id}` status link, and a pending queue row exists for that accepted job

2. **QA-02: malformed pipeline-run requests fail at the HTTP edge**
   - Given: a request body missing `source_id` or using invalid step names/order
   - When: `POST /api/pipeline/run` is called
   - Then: the API returns a Mulder JSON client error and no job or pipeline run row is created

3. **QA-03: unknown sources are rejected without queue side effects**
   - Given: a well-formed request body with a non-existent `source_id`
   - When: either pipeline route is called
   - Then: the API returns a not-found style error and does not enqueue a job

4. **QA-04: `POST /api/pipeline/retry` only accepts retryable failed work**
   - Given: a source with no failed latest pipeline step
   - When: `POST /api/pipeline/retry` is called
   - Then: the API returns a conflict-style error and does not enqueue a retry job

5. **QA-05: retry requests enqueue a forced single-step pipeline job**
   - Given: a source whose latest pipeline progress is failed at a retryable step
   - When: `POST /api/pipeline/retry` is called with or without an explicit step override
   - Then: the accepted queue payload targets that source, sets `force=true`, constrains the orchestrator to the selected step, and returns `202` with queue visibility

6. **QA-06: the API-created pipeline job is executable by the worker contract**
   - Given: a queued `pipeline_run` job created by the API helper
   - When: the worker decodes and dispatches that job
   - Then: the payload is accepted without shape errors and the worker invokes the existing single-source pipeline orchestrator rather than an extract-only placeholder path

7. **QA-07: the API and worker packages compile with the shared payload contract**
   - Given: the route, helper, and worker payload changes are wired into the workspace
   - When: package build/typecheck runs
   - Then: both `@mulder/api` and `@mulder/worker` compile without type errors

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

This step does not add a new direct paid-service integration, but it is operationally cost-sensitive because it opens a remote trigger surface for extraction, segmentation, enrichment, and embedding work. Validation and auth must therefore reject bad requests before a queue row is created, and the route handlers must never execute expensive pipeline logic inline.
