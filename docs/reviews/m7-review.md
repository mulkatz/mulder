---
milestone: M7
title: "M7 Review — API + Workers"
reviewed: 2026-04-17
steps_reviewed: [H1, H2, H3, H4, H5, H6, H7, H8, H9, H10, H11]
spec_sections: [§1, §4.3, §5, §5.1, §5.2, §5.3, §10, §10.2, §10.3, §10.4, §10.5, §10.6, §13, §14]
verdict: NEEDS_ATTENTION
---

# Milestone Review: M7 — API + Workers

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Warning  | 4 |
| Note     | 1 |

**Verdict:** NEEDS_ATTENTION

M7 has real breadth: the queue repository exists, the worker runtime exists, the Hono API exists, the document/search/entity/evidence surfaces exist, and both `@mulder/api` and `@mulder/worker` currently build. The main problems are architectural drift at the center of the async execution model and an incomplete viewer/API integration story. The highest-signal issues are that the API still enqueues a legacy monolithic `pipeline_run` job instead of per-step jobs, ordinary job failures do not actually retry through the queue, the demo app expects browser-session auth that the API does not provide, and the shipped demo currently fails its own production build.

## Review Scope

**Section map used for this review**

- **Sections from M7 steps:** §1, §4.3, §5, §10.2, §10.3, §10.4, §10.5, §10.6, §13
- **Cross-references:** §10 (full section), §14, `docs/api-architecture.md`
- **Primary implementation surfaces:** `packages/core/src/database/repositories/job.repository.ts`, `packages/worker/src/*`, `apps/api/src/*`, `demo/src/*`

---

## Per-Section Divergences

### §10.2 / §10.4 — Async API still uses a legacy monolithic `pipeline_run` job instead of per-step job slicing

**[DIV-001] The worker executes full pipeline runs inside one claimed queue job**
- **Severity:** WARNING
- **Spec says:** The async architecture should create one queued job per pipeline step per source, chaining the next step only after the current one succeeds. This is the main protection against long-running jobs and Cloud Run timeout loss. (`docs/functional-spec.md:1769-1795`, `2288-2289`, `2359-2365`)
- **Code does:** The API accepts runs by creating a single `pipeline_run` job, the worker explicitly supports `pipeline_run`, and that worker case delegates to the synchronous pipeline orchestrator that iterates all planned steps in-process. (`apps/api/src/lib/pipeline-jobs.ts:189-199`, `282-321`; `packages/worker/src/dispatch.ts:506-525`; `packages/pipeline/src/pipeline/index.ts:590-842`)
- **Evidence:** The queue does not hold step-scoped `extract` → `segment` → `enrich` → `embed` → `graph` jobs for normal pipeline execution. It holds a single `type = 'pipeline_run'` row and runs the whole slice under that job.

### §10.5 — Queue retries are not actually exercised for ordinary job failures

**[DIV-002] Failed jobs become terminal `failed` rows with no path back to `pending` inside M7**
- **Severity:** WARNING
- **Spec says:** The queue model talks in terms of exhausting retries and only then moving a job to `dead_letter`. (`docs/functional-spec.md:1911-1924`)
- **Code does:** `markJobFailed()` writes `failed` for non-exhausted jobs, but the M7 runtime never requeues those rows to `pending`; only stale `running` rows are reaped back to `pending`, and only `dead_letter` jobs have an explicit reset flow later. (`packages/core/src/database/repositories/job.repository.ts:405-440`, `474-507`)
- **Evidence:** There is no normal worker path that takes a freshly failed job and makes it runnable again, so `max_attempts` does not produce automatic retries for ordinary handler failures. In practice, those jobs stop after the first failure unless a separate recovery path intervenes.

### §10.6 / §13 — The demo viewer does not match the API auth contract it is supposed to consume

**[DIV-003] The frontend expects browser-session auth endpoints while the API only implements Bearer API-key auth**
- **Severity:** WARNING
- **Spec says:** M7 should produce the first web UI consuming the real API, and the M7 API design for Phase 1 uses API keys in `Authorization: Bearer <key>`. (`docs/functional-spec.md:1928-1940`; `docs/api-architecture.md:200-224`; `docs/roadmap.md:196-199`)
- **Code does:** The API middleware accepts only bearer tokens and registers no `/api/auth/*` routes. The demo app is wrapped in `AuthGate`, calls `/api/auth/session` and `/api/auth/login`, and its generic fetch helper sends cookies but no bearer token on normal API requests. (`apps/api/src/middleware/auth.ts:27-49`; `apps/api/src/app.ts:39-47`; `demo/src/App.tsx:15-38`; `demo/src/features/auth/useSession.ts:24-33`; `demo/src/features/auth/useLogin.ts:14-24`; `demo/src/lib/api-client.ts:32-80`)
- **Evidence:** Outside dev-preview bypass mode, the current demo cannot authenticate against the current API surface. Even if session endpoints existed, the protected document/search/entity/evidence calls still would not satisfy the API's bearer-token middleware as written.

### §13 — The shipped demo artifact is not currently buildable

**[DIV-004] `demo` fails its own production build**
- **Severity:** WARNING
- **Spec says:** M7 closes with the first demoable web UI consuming the real API. A buildable viewer is the minimum bar for that artifact. (`docs/roadmap.md:196-199`, `2141-2265`)
- **Code does:** `cd demo && npm run build` currently fails on an unused local in `KeyboardShortcuts.tsx`. (`demo/src/components/CommandPalette/KeyboardShortcuts.tsx:16-20`)
- **Evidence:** Local verification during this review failed with `TS6133: 'theme' is declared but its value is never read.` That blocks the demo bundle before Vite finishes.

### §13 / `docs/api-architecture.md` — Public API docs/config promises drift from the implementation

**[DIV-005] OpenAPI/Scalar/CORS are documented for M7 but not actually wired**
- **Severity:** NOTE
- **Spec says:** The M7 companion API architecture document describes `@hono/zod-openapi`, Scalar at `/reference`, OpenAPI at `/doc`, and configurable CORS origins under `api.cors`. (`docs/api-architecture.md:11-17`, `23-30`, `34-64`, `74-94`, `189-224`)
- **Code does:** `@mulder/api` depends only on `hono`, `@hono/node-server`, and `zod`; the app registers no `/doc` or `/reference` handlers, no CORS middleware, and the config schema/defaults do not define `api.cors`. (`apps/api/package.json:13-21`; `apps/api/src/app.ts:25-49`; `packages/core/src/config/schema.ts:74-80`; `packages/core/src/config/defaults.ts:9-24`)
- **Evidence:** The auth middleware still treats `/doc` and `/reference` as public paths, but the app never mounts them. This is mainly docs/config drift today, but it also leaves the cross-origin browser story underspecified.

---

## Cross-Cutting Convention Review

### Naming and Structure

- The reviewed M7 files generally follow the repo's naming conventions (`kebab-case.ts`, camelCase symbols, snake_case JSON/HTTP fields).
- The main M7 code lives where §13 says it should: `packages/worker`, `apps/api`, and `demo/` all exist and are active.

### TypeScript / Build Health

- `pnpm --filter @mulder/api build` passed during this review.
- `pnpm --filter @mulder/worker build` passed during this review.
- `cd demo && npm run build` failed on `demo/src/components/CommandPalette/KeyboardShortcuts.tsx:19`.

### Verification Surface

- `pnpm test:scope run milestone M7` did not reach the M7 tests because global setup failed while building unrelated CLI eval code.
- `pnpm test:api:e2e` failed for the same reason.
- The blocking errors are in `apps/cli/src/lib/eval.ts:20`, `362-364` (`@mulder/eval` resolution + `unknown` metric accesses), which means the intended M7 verification lanes are currently unavailable even before any M7 assertions run.

### Architecture Pattern Compliance

- Good: queue claim / completion / failure writes remain short auto-commit repository calls; the worker does not wrap dequeue and job execution in one long transaction.
- Good: API route handlers stay fairly thin and delegate to `lib/*` helpers.
- Drift: the core async execution model in §10.2 was supposed to move from whole-pipeline orchestration to per-step queue jobs, but the implementation still routes the worker back into the synchronous pipeline orchestrator.

---

## CLAUDE.md / Companion-Doc Consistency

- **Consistent:** the repository now has real `apps/api`, `packages/worker`, and `demo/` surfaces, so M7 clearly moved the codebase beyond CLI-only operation.
- **Inconsistent:** `docs/api-architecture.md` describes a richer M7 surface than the implementation actually ships today: OpenAPI, Scalar, and CORS are documented as chosen and configured, but they are not wired into the current app/package/config.
- **Inconsistent:** the current demo is no longer just a minimal split-view shell; it assumes a session-auth model and broader app shell that the current M7 API does not provide.

---

## Recommendations

### Must Fix

1. Replace the legacy `pipeline_run` queue flow with real per-step job slicing, or explicitly revise the M7 functional/architecture docs if the project is intentionally accepting monolithic worker jobs.
2. Align the browser/UI auth contract with the API: either implement the browser-safe session/auth routes the demo expects, or change the demo to use the actual bearer-key model the API enforces.
3. Restore a green `demo` production build and re-run the viewer verification lane before treating H11 as complete.

### Should Fix

1. Decide whether queue failures are supposed to auto-retry; if yes, add the missing requeue path, and if not, tighten §10.5 language so "max_attempts retries" does not promise behavior the queue does not deliver.
2. Either implement the documented OpenAPI/Scalar/CORS surface or trim `docs/api-architecture.md`, the auth middleware whitelist, and config expectations down to what actually ships.
3. Unblock the intended M7 test lanes by fixing the unrelated `apps/cli/src/lib/eval.ts` TypeScript errors; right now the scoped milestone and API E2E commands cannot even start.

### For Consideration

1. Revisit whether `--concurrency <n>` on `mulder worker start` should stay as a forward-looking CLI knob or become real parallel execution now that M7 is marked complete.

