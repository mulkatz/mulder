---
spec: "70"
title: "API Middleware Stack"
roadmap_step: M7-H4
functional_spec: ["§10.6"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/176"
created: 2026-04-14
---

# Spec 70: API Middleware Stack

## 1. Objective

Introduce the shared HTTP middleware layer for Mulder's Hono API so every later M7 route lands on a consistent request pipeline instead of re-implementing auth, rate limiting, or error handling per endpoint. Per `§10.6`, the API must stay a clean job producer/read interface with tiered rate limiting, structured error responses, and clear separation between public and protected surfaces. This step also aligns the runtime with `docs/api-architecture.md` by establishing request IDs, request-scoped logging/context, API-key auth, body limits, and public-path exceptions that H5-H10 can reuse unchanged.

## 2. Boundaries

- **Roadmap Step:** `M7-H4` — Middleware — auth, rate limiting, error handling, request context
- **Target:** `packages/core/src/config/schema.ts`, `packages/core/src/config/types.ts`, `mulder.config.example.yaml`, `apps/api/src/app.ts`, `apps/api/src/middleware/request-id.ts`, `apps/api/src/middleware/request-context.ts`, `apps/api/src/middleware/secure-headers.ts`, `apps/api/src/middleware/body-limit.ts`, `apps/api/src/middleware/rate-limit.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/middleware/error-handler.ts`, `tests/specs/70_api_middleware_stack.test.ts`
- **In scope:** API config surface for auth/rate-limiting/CORS-friendly public path handling where needed by middleware; deterministic request ID generation; request-scoped context/logger plumbing; security headers and request body limits; API-key bearer auth with explicit public exceptions for health/OpenAPI/explorer paths; tiered in-memory rate limiting with `Retry-After`; centralized mapping of Mulder/Zod/unexpected errors to Mulder's error envelope; and black-box tests covering public access, protected access, throttling, body-size rejection, and structured errors
- **Out of scope:** pipeline/job/search/entity/evidence/document route implementations (`M7-H5` through `M7-H10`); OpenAPI or Scalar registration; persistent/shared rate limiting across instances; user/session auth beyond static API keys; database-backed auth or ACLs; and UI work (`M7-H11`)
- **Constraints:** preserve the app/server split from Spec 69; keep middleware order explicit and reusable; keep unauthenticated liveness/docs routes public while protecting application data surfaces; do not bypass Mulder's existing config loader or logger; do not require Redis or any new infrastructure; and keep the middleware behavior shell-observable for the verification worker

## 3. Dependencies

- **Requires:** Spec 03 (`M1-A2`) config loader + schema defaults, Spec 04 (`M1-A3`) Mulder error hierarchy, Spec 05 (`M1-A4`) centralized logging, and Spec 69 (`M7-H3`) Hono server scaffold
- **Blocks:** `M7-H5` pipeline API routes, `M7-H6` job status API, `M7-H7` search API routes, `M7-H8` entity API routes, `M7-H9` evidence API routes, `M7-H10` document retrieval routes, and `M7-H11` viewer integration work that depends on stable auth/public-path behavior

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/config/schema.ts`** — adds the `api` config surface for API keys, explorer toggle, and rate-limiting defaults
2. **`packages/core/src/config/types.ts`** — exports the derived API config types used by the server runtime
3. **`mulder.config.example.yaml`** — documents the new API config keys and safe defaults
4. **`apps/api/src/app.ts`** — composes the middleware stack in the correct order around the Hono app
5. **`apps/api/src/middleware/request-id.ts`** — ensures each request carries a stable request ID header/context value
6. **`apps/api/src/middleware/request-context.ts`** — attaches request-scoped metadata/logger state for downstream handlers
7. **`apps/api/src/middleware/secure-headers.ts`** — applies baseline HTTP safety headers
8. **`apps/api/src/middleware/body-limit.ts`** — rejects oversized API request bodies before handler execution
9. **`apps/api/src/middleware/rate-limit.ts`** — implements the strict/standard/relaxed token-bucket tiers from `§10.6`
10. **`apps/api/src/middleware/auth.ts`** — enforces bearer-token auth except on explicitly public endpoints
11. **`apps/api/src/middleware/error-handler.ts`** — maps known application/validation failures to Mulder's error envelope
12. **`tests/specs/70_api_middleware_stack.test.ts`** — black-box coverage for middleware behavior

### 4.2 Runtime Changes

The Hono app should gain a reusable middleware pipeline with this effective behavior:

- a request ID is generated when the client does not send one
- the request context exposes the request ID and a child logger for downstream route handlers
- public paths remain callable without auth:
  - `GET /api/health`
  - `/doc`
  - `/reference`
- protected API routes require `Authorization: Bearer <key>` where the key matches configured API keys
- requests are rate-limited by endpoint tier, returning `429` plus `Retry-After`
- request bodies above the configured cap are rejected before business logic runs
- known errors return Mulder's JSON error envelope instead of raw stacks or framework defaults

Middleware order matters. The stack should establish request metadata before auth/rate limiting/logging decisions, and the global error handler must wrap the composed app so downstream failures stay normalized.

### 4.3 Config Changes

Add an `api` section to Mulder's config schema with defaults that keep local development ergonomic while still enabling middleware behavior:

- `port`
- `auth.api_keys[]`
- `rate_limiting.enabled`
- `explorer.enabled`

The schema must allow local/test overrides without requiring users to define an API block for non-API workflows.

### 4.4 Integration Points

- later route specs consume the request context/logger instead of rebuilding per-request state
- H5-H10 can opt into rate-limit tiers declaratively based on route surface
- auth/public-path rules remain centralized in middleware rather than duplicated in route handlers
- the global error handler becomes the single HTTP translation point for `MulderError` and validation failures
- the viewer work in H11 can rely on a stable public-vs-protected contract once document routes exist

### 4.5 Implementation Phases

**Phase 1: Config and middleware primitives**
- add the API config schema and documented defaults
- implement request ID, request context, secure headers, and body-limit middleware

**Phase 2: Protection and normalization**
- implement API-key auth with explicit public-path bypasses
- implement tiered in-memory rate limiting with `Retry-After`
- implement the global error handler and wire it into the app

**Phase 3: Composition and QA**
- update the Hono app to compose middleware in the intended order
- add black-box tests for auth, throttling, size limits, public paths, and error envelopes

## 5. QA Contract

1. **QA-01: Public health checks stay unauthenticated and traceable**
   - Given: the API app is started with middleware enabled and no `Authorization` header
   - When: `GET /api/health` is requested
   - Then: the response is `200`, includes a request ID header, and succeeds without database or GCP access

2. **QA-02: Protected routes reject missing or invalid bearer tokens**
   - Given: a protected API route and middleware configured with at least one API key
   - When: the route is requested without a valid `Authorization: Bearer <key>` header
   - Then: the response is `401` with Mulder's JSON error envelope and no handler-side business logic executes

3. **QA-03: Rate-limited routes return `429` with retry guidance**
   - Given: a route assigned to one of the `§10.6` rate-limit tiers
   - When: requests exceed that tier's allowed burst/window
   - Then: the API responds with `429 Too Many Requests` and includes a `Retry-After` header

4. **QA-04: Oversized request bodies are rejected before handler logic**
   - Given: a route expecting JSON input and a request body above the configured maximum
   - When: the request is sent
   - Then: the API returns an explicit client error for body size and the handler is not invoked

5. **QA-05: Known application and validation errors are normalized**
   - Given: a route that raises a `MulderError` or request validation failure
   - When: the request is processed
   - Then: the response uses Mulder's JSON error envelope with the expected HTTP status code and request traceability

6. **QA-06: The API package still compiles with the middleware stack enabled**
   - Given: the new middleware modules and config schema are wired into `@mulder/api`
   - When: the API package build/typecheck runs
   - Then: the package compiles successfully and exports a bootable app/server surface

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

This step should not add direct third-party spend on its own, but it is cost-sensitive because the middleware tiering protects future synchronous LLM-backed routes from accidental token burn. Rate limiting must therefore ship with deterministic defaults rather than being left for later route work.
