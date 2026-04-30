---
source_review: m7-review.md
created: 2026-04-17
scope_classification: multi-spec
status: superseded
---

# M7 Remediation Plan

> Historical remediation record. Browser app guidance now lives in `apps/app`, `docs/product-app-design-strategy.md`, `docs/product-app-api-integration.md`, and `docs/product-app-deployment.md`. Do not use this plan as a current frontend implementation guide.

Implementation plan for the still-open findings in [`docs/reviews/m7-review.md`](./m7-review.md).

## 1. Current Status

### Findings still open

| Review ID | Theme | Current read |
|----------|-------|--------------|
| `DIV-001` | Async execution model | Still open. The API and worker still route normal async execution through legacy monolithic `pipeline_run` jobs rather than real per-step queue slicing. |
| `DIV-002` | Queue retries | Still open. The queue repository still marks ordinary failures as `failed`, and the runtime does not appear to requeue them automatically before exhaustion. |
| `DIV-003` | Browser auth contract | Resolved for the product-app path. Browser-safe session routes and `apps/app` auth hooks exist; keep future UI work on the product-app contract. |
| `DIV-005` | API docs / middleware drift | Still open. OpenAPI/Scalar/CORS are still documented as shipping even though the app/config surface does not fully match that description. |

### Findings already resolved

| Review ID | Theme | Resolution |
|----------|-------|------------|
| `DIV-004` | Retired browser prototype build | Superseded. The old browser prototype is no longer an active build target; verify `apps/app` instead. |

### Cross-cutting doc gap

The roadmap and V1 plan both reference [`docs/specs/77_browser_safe_email_password_auth.spec.md`](../specs/77_browser_safe_email_password_auth.spec.md), but that file is not present in the repository. Even if the implementation proceeds first, we should restore a real spec artifact so the browser-auth contract is no longer implicit.

## 2. Architect-Style Scope Assessment

Using the `architect` workflow's scope rules, this follow-up is **`multi-spec`**:

- it spans more than three distinct concerns
- it touches API, worker, queue semantics, frontend auth integration, and docs/config surfaces
- it would clearly exceed a clean single-spec boundary

That means the right next step is **decomposition**, not one giant catch-all spec.

## 3. Recommended Workstreams

### Workstream A — Browser Session Auth Contract Recovery

**Addresses:** `DIV-003`, part of `DIV-005`

**Recommendation:** implement the browser-safe session model the V1 web app already assumes, rather than reverting the frontend to bearer API keys.

Why this direction:

- the product app depends on Spec 77 auth being green
- the product app assumes invite-based session auth
- the current web app is built around cookie-backed session flows, not bearer-key entry
- reverting the app to API keys would move the product away from the documented browser story

**Suggested issue title**

`[API/Auth] Browser-safe session auth for product app clients — M7 follow-up`

**Suggested implementation scope**

1. Recreate or replace the missing browser-auth spec file so the contract is explicit again.
2. Add the missing `/api/auth/*` route family expected by the product app:
   - `POST /api/auth/login`
   - `POST /api/auth/logout`
   - `GET /api/auth/session`
   - `POST /api/auth/invitations/accept`
   - `POST /api/auth/invitations`
3. Extend middleware/config to support cookie-backed browser auth alongside the current protected API surface.
4. Make the browser credential story explicit for dev and production:
   - same-origin dev proxy
   - credentialed CORS only where truly required
   - cookie flags by environment
5. Add end-to-end verification from product-app auth entrypoints through protected document/search routes.

**Primary surfaces**

- `apps/api/src/app.ts`
- `apps/api/src/middleware/auth.ts`
- new `apps/api/src/routes/auth*.ts`
- new auth/session library code under `apps/api/src/lib/`
- `packages/core/src/config/schema.ts`
- `apps/app/src/features/auth/*`
- `apps/app/src/lib/api-client.ts`

**Verification target**

- browser login sets a valid session
- `GET /api/auth/session` round-trips the current user
- protected product app routes work with browser credentials only
- admin invite creation matches the frontend modal contract

### Workstream B — Replace Monolithic `pipeline_run` Jobs With Per-Step Queue Jobs

**Addresses:** `DIV-001`

**Recommendation:** move normal async execution to real step-scoped jobs and treat the current `pipeline_run` path as a compatibility shim to retire.

This is the highest-risk architectural fix in the set. It should be split into at least two phases instead of landed as one broad rewrite.

**Suggested issue title**

`[Worker/API] Replace legacy pipeline_run jobs with step-scoped queue execution — M7 follow-up`

**Suggested phase split**

**Phase 1: queue contract + dispatch surface**

- define explicit step job payloads for `extract`, `segment`, `enrich`, `embed`, `graph`, and later `analyze`
- teach the worker runtime/dispatch to execute those job types directly
- preserve external observability through `jobs` and `pipeline_run_sources`

**Phase 2: API production path**

- update pipeline run/retry APIs to enqueue step jobs instead of one `pipeline_run`
- chain follow-on jobs only after the current step succeeds
- ensure retries can restart from the correct failed step without reviving the whole monolithic flow

**Primary surfaces**

- `packages/worker/src/worker.types.ts`
- `packages/worker/src/dispatch.ts`
- `packages/worker/src/runtime.ts`
- `apps/api/src/lib/pipeline-jobs.ts`
- `apps/api/src/routes/pipeline*.ts`
- `apps/api/src/lib/job-status.ts`
- relevant queue/pipeline repository helpers in `packages/core`

**Verification target**

- a normal run enqueues and processes step-scoped jobs in order
- the queue visibly contains step jobs rather than one `pipeline_run`
- `pipeline_run_sources` remains externally accurate during execution
- Cloud Run timeout risk is reduced because no single queue job spans the whole source pipeline

### Workstream C — Restore Real Retry Semantics Before Dead Letter

**Addresses:** `DIV-002`

**Recommendation:** land this after Workstream B’s queue-contract work has settled, because retry behavior will be easier to reason about once the job model is step-scoped.

**Suggested issue title**

`[Queue] Restore automatic retry semantics before dead-letter — M7 follow-up`

**Suggested implementation scope**

1. Decide and document the intended retry lifecycle:
   - non-exhausted failure returns to `pending`
   - exhausted failure moves to `dead_letter`
2. Adjust repository/runtime behavior so ordinary handler failures re-enter the queue automatically when attempts remain.
3. Keep stale-job reap and manual dead-letter recovery as separate operator flows.
4. Add tests that distinguish:
   - transient handler failure
   - repeated exhaustion
   - stale `running` recovery
   - explicit dead-letter retry

**Primary surfaces**

- `packages/core/src/database/repositories/job.repository.ts`
- `packages/worker/src/runtime.ts`
- `packages/worker/src/dispatch.ts`
- later compatibility checks against `apps/api/src/lib/pipeline-jobs.ts`

**Verification target**

- a failing job retries without operator intervention until attempts are exhausted
- `failed` becomes a true transient/intermediate state or is removed from the normal retry path entirely
- `dead_letter` remains reserved for exhausted work

### Workstream D — Align API Architecture Docs and Runtime Surface

**Addresses:** `DIV-005`

**Recommendation:** do not let this expand into unrelated platform work. Decide first whether OpenAPI/Scalar/CORS are meant to ship now or later.

**Suggested issue title**

`[Docs/API] Align documented API surface with shipped middleware behavior — M7 follow-up`

**Decision gate**

Pick one of two paths and stay consistent:

1. **Implement the documented surface now**
   - wire `/doc`
   - wire `/reference`
   - add the missing config keys and runtime support
   - add explicit credentialed CORS behavior if browser auth requires it

2. **Trim the docs to current reality**
   - remove unshipped OpenAPI/Scalar/CORS claims
   - tighten auth middleware public-path exceptions
   - align config docs with what the app actually reads

**Recommendation:** fold credentialed CORS into Workstream A, but keep OpenAPI/Scalar as a separate yes/no docs decision so auth work is not blocked on explorer tooling.

### Workstream E — Unblock the Intended M7 Verification Lane

**Addresses:** review recommendation, not a top-line divergence

**Suggested issue title**

`[Build/Test] Unblock M7 scoped verification commands — M7 follow-up`

**Why it matters**

Even if the main fixes land correctly, they are harder to trust if `pnpm test:scope -- milestone M7` and `pnpm test:api:e2e` still fail before reaching the actual M7 assertions.

**Suggested implementation scope**

1. Fix the unrelated CLI/eval TypeScript breakages that currently block those lanes.
2. Re-run the intended M7 milestone/API-focused commands after each major remediation workstream.
3. Treat lane health as a gating criterion before closing the queue/auth follow-up issues.

## 4. Recommended Execution Order

### Order optimized for product credibility

1. **Workstream A — Browser session auth**
2. **Workstream B — per-step async jobs**
3. **Workstream C — retry semantics**
4. **Workstream D — docs/runtime alignment**
5. **Workstream E — verification-lane cleanup** (can start in parallel if narrowly scoped)

Rationale:

- the web app is already the visible product surface, and its auth backend gap is the most user-facing broken contract
- the async job-model rewrite is the deepest system change and should not be mixed into auth work
- retry semantics depend on the final job model being stable
- docs cleanup should happen after we know which runtime shape we are actually keeping

### Order optimized for core architecture first

1. **Workstream B**
2. **Workstream C**
3. **Workstream A**
4. **Workstream D**
5. **Workstream E**

If the goal is “make M7 internally correct before demo polish,” this is the better order. It is riskier for short-term demoability.

## 5. Proposed Spec / Issue Decomposition

If you want me to formalize this with the `architect` workflow next, I recommend the following split:

1. **Spec A:** browser-safe email/password + invite session auth for the API and demo
2. **Spec B1:** step-scoped worker job contract and dispatch/runtime changes
3. **Spec B2:** async pipeline API rewrite to enqueue chained step jobs
4. **Spec C:** automatic retry semantics before dead-letter
5. **Spec D:** API architecture/docs/CORS/OpenAPI alignment
6. **Optional Spec E:** scoped verification-lane repair, only if the lane is still blocked after A-D

This is intentionally **not** one spec.

## 6. Recommended First Concrete Move

Start with **Workstream A** unless the immediate goal is pure backend correctness over demo usability.

Why:

- the frontend is already shipping against that contract
- the roadmap explicitly treats browser auth as a prerequisite for the V1 app
- the missing auth spec file is itself a documentation integrity problem we can repair while defining the backend work

If you want, I can next turn **Workstream A** into a proper architect-generated spec/issue package, then do the same for **Workstream B1/B2** after that.
