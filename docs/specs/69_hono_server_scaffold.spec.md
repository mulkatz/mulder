---
spec: "69"
title: "Hono Server Scaffold"
roadmap_step: M7-H3
functional_spec: ["§13 (apps/api/)"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/171"
created: 2026-04-14
---

# Spec 69: Hono Server Scaffold

## 1. Objective

Introduce Mulder's first real HTTP runtime in `apps/api` so M7 can build on a concrete Hono-based server rather than an empty placeholder package. Per `§13`, `apps/api` is the API application boundary; per the M7 architecture notes, the scaffold should use Hono with `@hono/node-server`, expose an unauthenticated health endpoint, and establish an app/server split that future middleware and route specs can extend without rewriting the bootstrap.

## 2. Boundaries

- **Roadmap Step:** `M7-H3` — Hono server scaffold — app, node-server, health endpoint
- **Target:** `apps/api/package.json`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/health.ts`, `tests/specs/69_hono_server_scaffold.test.ts`
- **In scope:** Hono runtime dependencies for `@mulder/api`; a reusable app factory that mounts `/api/health`; a Node entrypoint that starts the Hono app with `@hono/node-server`; minimal request logging through Mulder's existing logger; and black-box coverage proving the scaffold boots and serves the health route
- **Out of scope:** auth, rate limiting, request context, structured error middleware (`M7-H4`); pipeline, jobs, search, entity, evidence, or document routes (`M7-H5` through `M7-H10`); OpenAPI/Scalar setup; config schema additions for API settings; and any browser app work (`M7-H11`)
- **Constraints:** preserve the CLI-first package boundaries from `CLAUDE.md`; keep business logic out of the HTTP layer; keep the initial server bootstrap small and dependency-light; avoid inventing a broad API config surface before the middleware/routes specs land; and ensure the health endpoint can be called without authentication for Cloud Run-style liveness checks

## 3. Dependencies

- **Requires:** Spec 02 (`M1-A1`) monorepo app/package layout, Spec 05 (`M1-A4`) centralized logging, and the existing `@mulder/api` workspace package scaffold
- **Blocks:** `M7-H4` middleware composition, `M7-H5` pipeline API routes, `M7-H6` job status API, `M7-H7` search API routes, `M7-H8` entity API routes, `M7-H9` evidence API routes, and `M7-H10` document retrieval routes

## 4. Blueprint

### 4.1 Files

1. **`apps/api/package.json`** — adds the Hono runtime dependencies needed to boot the API on Node
2. **`apps/api/src/app.ts`** — exports a small `createApp()` factory that instantiates Hono, applies minimal request logging, and mounts the base routes
3. **`apps/api/src/routes/health.ts`** — defines the unauthenticated `GET /api/health` handler
4. **`apps/api/src/index.ts`** — exports the app surface and provides the executable Node server bootstrap
5. **`tests/specs/69_hono_server_scaffold.test.ts`** — black-box/spec-level verification of the health route and package buildability

### 4.2 Runtime Changes

This step introduces Mulder's first HTTP server process under `apps/api`:

- use `hono` as the application framework
- use `@hono/node-server` as the Node runtime adapter for local execution and future Cloud Run deployment
- keep the bootstrap separated into:
  - an app factory for tests and future composition
  - a process entrypoint for actual listening

The first route surface is intentionally narrow:

- `GET /api/health`

The health route should return a stable success payload that is shell- and HTTP-observable without depending on the database, GCP, or job queue state.

### 4.3 Config Changes

None. The scaffold may read a simple environment port fallback such as `PORT`/`MULDER_API_PORT`, but it must not add or require new `mulder.config.yaml` schema fields in this step.

### 4.4 Integration Points

- future middleware specs attach to the app factory instead of replacing bootstrap code
- future route specs register under the same `/api/*` namespace
- future deployment/runtime work can invoke the exported server entrypoint without restructuring `apps/api`
- tests can import the app factory directly and avoid shelling out to a long-lived server process for basic route verification

### 4.5 Implementation Phases

**Phase 1: App bootstrap**
- add Hono runtime dependencies
- create the app factory and the `/api/health` route
- wire a Node server entrypoint around the app

**Phase 2: QA coverage**
- add a black-box API test for `GET /api/health`
- verify the `@mulder/api` package still typechecks/builds cleanly with the new runtime

## 5. QA Contract

1. **QA-01: Health endpoint responds successfully from the app scaffold**
   - Given: the `@mulder/api` package app factory
   - When: a request is made to `GET /api/health`
   - Then: the response status is `200` and the body reports the service as healthy

2. **QA-02: Health endpoint is reachable under the `/api` namespace**
   - Given: the scaffolded Hono app
   - When: the health route is invoked by its public path
   - Then: the route resolves at `/api/health`, not an ad hoc root-only endpoint

3. **QA-03: Health checks do not require database or GCP connectivity**
   - Given: no active PostgreSQL, Firestore, or GCP credentials
   - When: `GET /api/health` runs
   - Then: the request still succeeds because the liveness probe is process-local only

4. **QA-04: The API package compiles with the new server runtime**
   - Given: the Hono scaffold files and package dependencies are wired into `@mulder/api`
   - When: the API package build/typecheck runs
   - Then: the package compiles successfully and exports the server/app surface without type errors

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None for direct service spend. This step is a local HTTP scaffold only and must not trigger database queries or paid external APIs.
