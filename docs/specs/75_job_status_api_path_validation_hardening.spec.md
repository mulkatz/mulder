---
spec: "75"
title: "Job Status API Path Validation Hardening"
roadmap_step: M7-H6
functional_spec: ["§10.6"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/188"
created: 2026-04-15
---

# Spec 75: Job Status API Path Validation Hardening

## 1. Objective

Harden Mulder's `GET /api/jobs/:id` contract so malformed job IDs fail as client validation errors at the HTTP boundary instead of surfacing downstream PostgreSQL UUID errors as `503` responses. Per `§10.6`, the jobs API is a lightweight read surface for polling queued work; invalid path input should therefore be rejected early with a stable `400` JSON validation response while preserving the existing `404` behavior for unknown but well-formed UUIDs.

## 2. Boundaries

- **Roadmap Step:** `M7-H6` — Job status API
- **Target:** `apps/api/src/routes/jobs.schemas.ts`, `apps/api/src/routes/jobs.ts`, `tests/specs/72_job_status_api.test.ts`
- **In scope:** a Zod-backed path-param schema for `/api/jobs/:id`; route-level UUID validation before `getJobStatusById()` is called; preserving the existing success and not-found contracts for valid UUIDs; and black-box tests proving malformed IDs return `400` instead of `503`
- **Out of scope:** list-route query changes for `GET /api/jobs`; payload `runId` / `run_id` hardening inside `apps/api/src/lib/job-status.ts`; queue schema or repository changes; new middleware behavior; and any search/entity/evidence/document API work
- **Constraints:** keep the route behind the existing auth and rate-limit stack; rely on the existing error-handler behavior for Zod validation failures; do not weaken the current `404` not-found contract for valid UUIDs that do not exist; and keep the fix limited to the route boundary rather than pushing malformed IDs into the repository layer

## 3. Dependencies

- **Requires:** Spec 70 (`M7-H4`) API middleware stack for Zod validation error handling, and Spec 72 (`M7-H6`) job status API for the existing route surface and response shapes
- **Blocks:** no later roadmap step directly, but this follow-up restores the client-visible contract expected by API consumers polling `/api/jobs/:id`

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/jobs.schemas.ts`** — add a dedicated params schema for the job detail route, using UUID validation compatible with the current error-handler stack
2. **`apps/api/src/routes/jobs.ts`** — parse `c.req.param('id')` through the params schema before calling `getJobStatusById()`
3. **`tests/specs/72_job_status_api.test.ts`** — add black-box coverage for malformed job IDs returning `400`, while retaining the existing `404` assertion for missing but valid UUIDs

### 4.2 Route Contract Adjustment

#### `GET /api/jobs/:id`

Additional rule:

- malformed non-UUID path values are rejected with a `400` Mulder validation error before any repository query runs

Examples:

- `/api/jobs/not-a-uuid` → `400` with `error.code = "VALIDATION_ERROR"`
- `/api/jobs/550e8400-e29b-41d4-a716-446655440000` when the row does not exist → existing `404 DB_NOT_FOUND`

### 4.3 Implementation Phases

**Phase 1: Route schema**
- add a `JobDetailParamsSchema` (or equivalent) in `jobs.schemas.ts`
- keep the shape minimal: `{ id: uuid }`

**Phase 2: Route hardening**
- parse the route param in `registerJobRoutes()`
- pass only the validated UUID string into `getJobStatusById()`

**Phase 3: Regression QA**
- add a malformed-ID test that asserts `400`
- keep the existing missing-valid-UUID test to prove `404` still works

## 5. QA Contract

1. **QA-01: malformed job IDs fail fast with a validation error**
   - Given: the jobs routes are mounted and authenticated
   - When: `GET /api/jobs/not-a-uuid` is called
   - Then: the response is `400` with Mulder's JSON validation error envelope, and no `503 DB_QUERY_FAILED` response is emitted

2. **QA-02: unknown but valid UUIDs still return not-found**
   - Given: a well-formed UUID that does not exist in the `jobs` table
   - When: `GET /api/jobs/:id` is called with that UUID
   - Then: the response remains `404` with `DB_NOT_FOUND`

3. **QA-03: known job detail behavior is unchanged for valid UUIDs**
   - Given: an existing job row
   - When: `GET /api/jobs/:id` is called with that job's UUID
   - Then: the response still succeeds with `200` and returns the existing job detail envelope

4. **QA-04: the API package still compiles with the hardened route**
   - Given: the route files are wired into `@mulder/api`
   - When: the API package build or typecheck runs
   - Then: the package compiles successfully without changing the public route surface beyond the new validation behavior

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

None for direct third-party spend. This is a route-boundary validation hardening change on an existing PostgreSQL-backed read endpoint.
