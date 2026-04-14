---
spec: "72"
title: "Job Status API"
roadmap_step: M7-H6
functional_spec: ["§10.6"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/181"
created: 2026-04-14
---

# Spec 72: Job Status API

## 1. Objective

Expose Mulder's queued work state over authenticated HTTP so API clients can poll accepted pipeline jobs and inspect recent queue activity without shelling into the worker CLI. Per `§10.6`, the API stays a pure job producer/read surface: `POST /api/pipeline/*` creates jobs, while `GET /api/jobs` and `GET /api/jobs/:id` report status, progress, and failures from the existing `jobs`, `pipeline_runs`, and `pipeline_run_sources` tables.

## 2. Boundaries

- **Roadmap Step:** `M7-H6` — Job status API
- **Target:** `apps/api/src/app.ts`, `apps/api/src/routes/jobs.schemas.ts`, `apps/api/src/routes/jobs.ts`, `apps/api/src/lib/job-status.ts`, `tests/specs/72_job_status_api.test.ts`
- **In scope:** authenticated read-only routes for `GET /api/jobs` and `GET /api/jobs/:id`; query validation for recent-job filters; JSON response shaping for queue summaries and per-job detail; pipeline-aware detail enrichment using `runId`/`run_id` payload fields plus the existing pipeline-run repositories when available; not-found handling for unknown jobs; and black-box tests proving list/detail behavior against real queue rows
- **Out of scope:** creating, retrying, cancelling, or mutating jobs; new worker behavior or queue schema changes; search/entity/evidence/document routes (`M7-H7` through `M7-H10`); streaming/SSE/WebSocket updates; and any UI work (`M7-H11`)
- **Constraints:** keep both routes protected by the existing middleware/auth stack; reuse the shipped repository layer instead of ad hoc SQL in route handlers; keep the endpoints database-only with no inline pipeline execution; preserve the accepted-response status link contract from Spec 71; and make the detail route externally inspectable even while a worker is currently processing the job

## 3. Dependencies

- **Requires:** Spec 67 (`M7-H1`) job queue repository, Spec 68 (`M7-H2`) worker loop status semantics, Spec 69 (`M7-H3`) Hono server scaffold, Spec 70 (`M7-H4`) API middleware stack, and Spec 71 (`M7-H5`) async pipeline API routes that already return `/api/jobs/{id}` links
- **Blocks:** no later roadmap step is strictly blocked, but this step completes the async API polling contract promised by `M7-H5` and provides the shared queue-inspection surface future API consumers can rely on

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/jobs.schemas.ts`** — defines the query schemas and response envelopes for job list/detail routes
2. **`apps/api/src/lib/job-status.ts`** — owns repository-backed helpers that read job rows, derive optional pipeline-run progress, and map them into API-facing DTOs
3. **`apps/api/src/routes/jobs.ts`** — registers `GET /api/jobs` and `GET /api/jobs/:id` on the Hono app
4. **`apps/api/src/app.ts`** — mounts the jobs route group beneath the existing middleware stack
5. **`tests/specs/72_job_status_api.test.ts`** — black-box verification for authenticated list/detail behavior, filters, not-found handling, and pipeline-aware progress output

### 4.2 Route Contract

#### `GET /api/jobs`

Purpose: list recent jobs for polling/inspection.

Query parameters:

- `status` — optional job status filter (`pending | running | completed | failed | dead_letter`)
- `type` — optional job type filter (for example `pipeline_run`)
- `worker_id` — optional filter for active worker ownership
- `limit` — optional integer cap for returned rows; defaults to a safe recent-jobs window

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "type": "pipeline_run",
      "status": "running",
      "attempts": 1,
      "max_attempts": 3,
      "worker_id": "worker-host-123",
      "created_at": "2026-04-14T12:00:00.000Z",
      "started_at": "2026-04-14T12:00:03.000Z",
      "finished_at": null,
      "links": {
        "self": "/api/jobs/uuid"
      }
    }
  ],
  "meta": {
    "count": 1,
    "limit": 20
  }
}
```

Rules:

- rows are ordered newest-first, matching the repository inspection order from Spec 67
- filters only narrow the result set; they never mutate queue state
- the list route is intentionally lightweight and does not inline full pipeline-run source arrays for every item

#### `GET /api/jobs/:id`

Purpose: inspect one job's current queue state plus any pipeline progress tied to it.

Response shape:

```json
{
  "data": {
    "job": {
      "id": "uuid",
      "type": "pipeline_run",
      "status": "running",
      "attempts": 1,
      "max_attempts": 3,
      "worker_id": "worker-host-123",
      "created_at": "2026-04-14T12:00:00.000Z",
      "started_at": "2026-04-14T12:00:03.000Z",
      "finished_at": null,
      "error_log": null,
      "payload": {
        "sourceId": "source-uuid",
        "runId": "run-uuid"
      }
    },
    "progress": {
      "run_id": "run-uuid",
      "run_status": "running",
      "source_counts": {
        "pending": 0,
        "processing": 1,
        "completed": 0,
        "failed": 0
      },
      "sources": [
        {
          "source_id": "source-uuid",
          "current_step": "extract",
          "status": "processing",
          "error_message": null,
          "updated_at": "2026-04-14T12:00:05.000Z"
        }
      ]
    }
  }
}
```

Rules:

- unknown job IDs return a Mulder not-found response and never leak an empty success envelope
- when the job payload does not reference a valid pipeline run, `progress` is `null`
- failed/dead-letter jobs expose `error_log` so clients can see the worker-visible failure reason
- detail reads remain read-only and must work for pending, running, terminal, and reaped job states

### 4.3 Integration Points

- Spec 71's accepted-response `links.status` path resolves to a real detail endpoint once this step ships
- queue reads come from the existing `findJobById`, `findJobs`, and `countJobs` repository helpers
- pipeline progress comes from the existing `findPipelineRunById`, `findPipelineRunSourcesByRunId`, and `countPipelineRunSourcesByStatus` helpers when a job payload carries a pipeline run ID
- the worker/runtime remains the owner of queue mutations; these routes are inspection-only

### 4.4 Implementation Phases

**Phase 1: DTOs and repository-backed readers**
- add the list/detail schemas
- add a small API helper that maps job rows into HTTP-facing summaries and resolves optional pipeline progress

**Phase 2: Route registration**
- register `GET /api/jobs` and `GET /api/jobs/:id`
- mount the routes in the Hono app without weakening the existing middleware protections

**Phase 3: Black-box QA**
- add spec tests for list filtering, detail output, not-found behavior, and pipeline progress enrichment
- verify the API package still builds with the new route surface

## 5. QA Contract

1. **QA-01: `GET /api/jobs` lists recent jobs newest-first with filter support**
   - Given: a mix of queued jobs with different `status`, `type`, and `worker_id` values
   - When: `GET /api/jobs` is called with and without query filters
   - Then: the response is `200`, rows are ordered newest-first, and the filters narrow the result set correctly

2. **QA-02: `GET /api/jobs/:id` returns exact queue state for a known job**
   - Given: an existing job row in the `jobs` table
   - When: `GET /api/jobs/:id` is called with that job ID
   - Then: the response is `200` and includes the job's status, attempts, worker ownership, timestamps, payload, and error log fields as currently stored

3. **QA-03: pipeline jobs expose run progress from existing tracking tables**
   - Given: a `pipeline_run` job whose payload references a real `pipeline_runs` row and matching `pipeline_run_sources` rows
   - When: `GET /api/jobs/:id` is called
   - Then: the response includes `progress.run_id`, `progress.run_status`, per-status source counts, and the current source-step rows without inventing a second progress store

4. **QA-04: non-pipeline jobs return `progress: null` rather than a broken synthetic object**
   - Given: a non-`pipeline_run` job or a job whose payload does not resolve to a pipeline run
   - When: `GET /api/jobs/:id` is called
   - Then: the response still succeeds for the job detail and reports `progress` as `null`

5. **QA-05: unknown jobs fail with a not-found JSON error**
   - Given: a UUID that does not exist in the `jobs` table
   - When: `GET /api/jobs/:id` is called
   - Then: the API returns a Mulder JSON not-found response and does not emit a success envelope

6. **QA-06: jobs routes stay behind the existing auth middleware**
   - Given: the jobs routes are mounted in the API app
   - When: either route is requested without a valid bearer token
   - Then: the response is `401` and the route does not leak queue data

7. **QA-07: the API package compiles with the new jobs route surface**
   - Given: the jobs route files are wired into `@mulder/api`
   - When: the package build/typecheck runs
   - Then: the API package compiles successfully and the new route group is importable through the bootable app

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None for direct third-party spend. These are read-only PostgreSQL-backed inspection endpoints, but they are still cost-sensitive operationally because polling can be frequent; the implementation must therefore remain lightweight, stay within the existing relaxed rate-limit tier, and avoid any inline GCP or LLM calls.
