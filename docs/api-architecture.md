# M7 API Architecture — Design Decisions

Companion to `roadmap.md` M7 (H1–H11). Covers framework choice, API structure, OpenAPI strategy, middleware stack, and key trade-offs.

---

## 1. Framework: Hono

**Decision:** Hono with `@hono/node-server` for Cloud Run.

**Why Hono over Express/Fastify:**
- Native Zod integration (`@hono/zod-validator`) — project already uses Zod everywhere
- `@hono/zod-openapi` generates OpenAPI spec from the same Zod schemas that validate requests — single source of truth
- Hono RPC (`hono/client`) gives free end-to-end type safety for the CLI → API path — zero codegen, types flow through TypeScript
- 140M downloads/month, production-grade, v4.12 stable
- Tiny cold start on Cloud Run (~20ms init vs ~200ms Express)
- Built-in middleware covers all needs (CORS, auth, compression, rate limiting, logging)

**Why not Express:** No native TypeScript type inference across middleware chain. Zod-OpenAPI integration requires third-party glue. Cold start heavier.

**Why not Fastify:** Good option technically, but Hono's Zod-OpenAPI story is tighter and the RPC client has no Fastify equivalent.

**Packages:**
```
hono                        # Core framework
@hono/node-server           # Node.js adapter (Cloud Run)
@hono/zod-openapi           # OpenAPI spec generation from Zod schemas
@hono/zod-validator         # Request validation (used internally by zod-openapi)
@scalar/hono-api-reference  # API explorer UI
```

---

## 2. OpenAPI: Schema-First via Zod

**Decision:** `@hono/zod-openapi` — routes defined with Zod schemas that double as OpenAPI documentation.

**How it works:**
```typescript
// 1. Define route with Zod schemas
const searchRoute = createRoute({
  method: 'post',
  path: '/api/search',
  tags: ['Search'],
  request: {
    body: { content: { 'application/json': { schema: SearchRequestSchema } } }
  },
  responses: {
    200: { content: { 'application/json': { schema: SearchResponseSchema } } },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } } },
    429: { description: 'Rate limit exceeded' }
  }
})

// 2. Implement handler — fully typed from schemas
app.openapi(searchRoute, async (c) => {
  const body = c.req.valid('json') // typed as SearchRequest
  const result = await hybridRetrieve(body, config, services, pool)
  return c.json(result, 200)       // typed as SearchResponse
})

// 3. OpenAPI spec served automatically at /doc
app.doc('/doc', { openapi: '3.1.0', info: { title: 'Mulder API', version: '1.0.0' } })
```

**Why not `hono-openapi` (rhinobase):** Higher download count, but decorator-style `describeRoute()` separates schema from route — two sources of truth. For a greenfield API, the `createRoute()` pattern is cleaner.

**Why not hand-written OpenAPI:** Mulder already has 40+ Zod types across pipeline, retrieval, and config. Duplicating them as YAML/JSON schemas is a maintenance burden that violates DRY.

**Shared schemas:** Route schemas import from `@mulder/core` types and extend them for HTTP context (pagination, error envelopes). Core domain types stay in `packages/core/`, API-specific wrappers live in `apps/api/src/schemas/`.

---

## 3. API Explorer: Scalar

**Decision:** Scalar (`@scalar/hono-api-reference`) over Swagger UI.

**Why:**
- Modern UI, dark mode, built-in API client for testing endpoints directly
- Code generation in multiple languages (curl, Python, JS, Go)
- First-class Hono middleware — one-liner setup
- Microsoft adopted Scalar as .NET 9+ default (replacing Swagger UI)

**Setup:**
```typescript
import { apiReference } from '@scalar/hono-api-reference'

app.get('/reference', apiReference({
  spec: { url: '/doc' },
  theme: 'default',
}))
```

Accessible at `/reference` in development. Can be disabled in production via config flag.

---

## 4. Route Structure

Based on §10.7 of the functional spec. Two categories: **async** (job-producing) and **sync** (direct response).

### Async Routes (Job Queue)

Long-running operations. API writes to `jobs` table, returns `202 Accepted` + job reference.

```
POST   /api/pipeline/run              # Enqueue pipeline run → 202 { job_id }
POST   /api/pipeline/retry            # Retry failed sources → 202 { job_id }
POST   /api/taxonomy/bootstrap        # Enqueue taxonomy bootstrap → 202 { job_id }
POST   /api/taxonomy/re-bootstrap     # Enqueue taxonomy re-bootstrap → 202 { job_id }
```

### Sync Routes (Direct Response)

Read-only or lightweight operations. Hit database/services directly, return immediately.

```
# Jobs
GET    /api/jobs                      # List jobs (filterable by status, type)
GET    /api/jobs/:id                  # Job status + progress + errors

# Search
POST   /api/search                    # Hybrid retrieval (vector + BM25 + graph + RRF + rerank)

# Sources
GET    /api/sources                   # List sources (filterable, paginated)
GET    /api/sources/:id               # Source detail + step status
DELETE /api/sources/:id               # Soft-delete source + cascade

# Stories
GET    /api/stories                   # List stories (filterable by source, status)
GET    /api/stories/:id               # Story detail + entity links

# Entities
GET    /api/entities                  # List/search entities (filterable by type, taxonomy)
GET    /api/entities/:id              # Entity detail + relationships + aliases
POST   /api/entities/merge            # Merge two entities (lightweight, sync)

# Entity Edges
GET    /api/entities/:id/edges        # Entity relationships

# Taxonomy
GET    /api/taxonomy                  # List taxonomy entries
GET    /api/taxonomy/export           # Export taxonomy as YAML

# Documents (for Document Viewer — H10/H11)
GET    /api/documents/:id/pdf         # Stream original PDF from GCS
GET    /api/documents/:id/layout      # Layout Markdown for viewer
GET    /api/documents/:id/pages       # Page images listing
GET    /api/documents/:id/pages/:num  # Individual page image from GCS

# Status
GET    /api/status                    # Pipeline health overview
GET    /api/health                    # Liveness probe (Cloud Run)
```

### Response Envelope

Consistent structure across all endpoints:

```typescript
// Success
{ "data": T, "meta"?: { pagination, timing, confidence } }

// Error
{ "error": { "code": string, "message": string, "details"?: object } }

// Job created
{ "data": { "job_id": string, "status": "pending" }, "links": { "status": "/api/jobs/{id}" } }
```

### Pagination

Cursor-based for lists (consistent with pipeline orchestrator pattern):

```
GET /api/entities?limit=50&cursor=eyJ...
→ { "data": [...], "meta": { "pagination": { "cursor": "eyJ...", "has_more": true } } }
```

**Why cursor over offset:** Offset pagination breaks with concurrent inserts (missing/duplicate items). Cursor pagination is stable, cheaper on PostgreSQL (no `OFFSET` scan), and already the pattern used by the pipeline orchestrator.

---

## 5. Middleware Stack

Applied in order. Each middleware is a single responsibility.

```
1. request-id          # X-Request-Id header (generated if missing)
2. logger              # Structured JSON request/response logging (pino)
3. cors                # Configurable origins (dev: *, prod: domain whitelist)
4. secure-headers      # Security headers (X-Content-Type-Options, etc.)
5. body-limit          # Max request body: 10MB (prevents abuse)
6. rate-limiter        # Token bucket per IP (tiered, see §10.7)
7. auth                # API key validation (Bearer token → config)
8. error-handler       # Global: MulderError → HTTP response, Zod errors → 400
```

### Auth Strategy

**Phase 1 (M7):** API key in `Authorization: Bearer <key>`. Key configured in `mulder.config.yaml` under `api.auth.api_keys[]`. Simple, sufficient for single-user/team deployments.

```yaml
# mulder.config.yaml
api:
  port: 8080
  auth:
    api_keys:
      - name: "cli"
        key: "${MULDER_API_KEY}"    # env var reference
      - name: "viewer"
        key: "${MULDER_VIEWER_KEY}"
  cors:
    origins: ["http://localhost:5173"]  # Document Viewer dev
  rate_limiting:
    enabled: true
  explorer:
    enabled: true  # Scalar UI at /reference
```

**Phase 2 (future):** `@hono/firebase-auth` or `@hono/oidc-auth` for multi-user. Auth middleware is pluggable — swap implementation without changing routes.

**Unauthenticated endpoints:** `/api/health` (liveness probe), `/doc` (OpenAPI spec), `/reference` (Scalar UI) — all read-only, no data exposure.

### Rate Limiting (§10.7)

Three tiers as specified:

| Tier | Endpoints | Limit | Reason |
|------|-----------|-------|--------|
| Strict | `POST /api/search` (with reranking) | 10 req/min/IP | Triggers Gemini Flash |
| Standard | `GET /api/entities/*`, `GET /api/stories/*`, search without rerank | 60 req/min/IP | DB queries only |
| Relaxed | `GET /api/jobs/*`, `GET /api/health` | 120 req/min/IP | Status polling |

In-memory token bucket (no Redis). Single-instance is sufficient — Cloud Run scales per instance, each instance has its own bucket. Returns `429` with `Retry-After` header.

---

## 6. Error Handling

Map existing `MulderError` hierarchy to HTTP status codes in a global `onError` handler.

```typescript
app.onError((err, c) => {
  // Known application errors
  if (err instanceof MulderError) {
    const status = mapErrorToStatus(err) // CONFIG_INVALID → 400, NOT_FOUND → 404, etc.
    return c.json({ error: { code: err.code, message: err.message, details: err.context } }, status)
  }
  // Zod validation errors (from @hono/zod-openapi defaultHook)
  if (err instanceof ZodError) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.flatten() } }, 400)
  }
  // Unexpected errors — log full stack, return generic message
  logger.error({ err }, 'Unhandled error')
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
})
```

**Error code → HTTP status mapping:**

| Error Type | HTTP Status |
|-----------|-------------|
| ConfigError, ValidationError | 400 |
| AuthError | 401 |
| NotFoundError | 404 |
| RateLimitError | 429 |
| ExtractError, EnrichError, EmbedError, GraphError | 500 (operational) |
| DatabaseError | 503 |

`cause` chaining preserved for logging — the original error (GCP SDK error, pg error) is logged but never exposed to the client.

---

## 7. Hono RPC Client for CLI

**Decision:** Use Hono RPC for CLI → API communication when running in remote mode.

**Why:** The CLI and API are both TypeScript in the same monorepo. Hono RPC gives end-to-end type safety with zero code generation — the CLI imports the API's type and gets fully typed method calls.

```typescript
// apps/api/src/index.ts — export app type
export type AppType = typeof app

// apps/cli/src/lib/api-client.ts — import and use
import { hc } from 'hono/client'
import type { AppType } from '@mulder/api'

const client = hc<AppType>(apiUrl)
const res = await client.api.search.$post({ json: { query: 'find X', top_k: 10 } })
const data = await res.json() // fully typed
```

**When used:** CLI commands check if `api.url` is configured in `mulder.config.yaml`. If set, route commands through the API client instead of calling pipeline functions directly. This enables remote execution without changing the CLI interface.

**External consumers:** Use the OpenAPI spec at `/doc`. The RPC client is a convenience for same-monorepo TypeScript consumers, not a public contract.

---

## 8. Server Lifecycle on Cloud Run

```typescript
import { serve } from '@hono/node-server'

const server = serve({ fetch: app.fetch, port: config.api?.port ?? 8080 })

// Graceful shutdown — Cloud Run sends SIGTERM with 10s window
let shuttingDown = false
process.on('SIGTERM', async () => {
  shuttingDown = true
  server.close()
  await db.end()      // drain connection pools
  process.exit(0)
})
```

**Health check:** `GET /api/health` returns `200` with `{ status: 'ok', version }`. Cloud Run uses this as liveness probe.

**Worker co-location:** The worker (`mulder worker start`) runs as a separate Cloud Run service or as a sidecar. It shares the same `@mulder/core` and `@mulder/pipeline` packages but does NOT run an HTTP server. API and worker communicate only through the `jobs` table.

---

## 9. Project Structure

```
apps/api/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                 # Server entry: create app, start server
    ├── app.ts                   # Hono app: middleware + route mounting
    ├── schemas/                 # API-specific Zod schemas (extend core types)
    │   ├── common.ts            # Pagination, error envelope, job response
    │   ├── search.ts            # SearchRequest, SearchResponse
    │   ├── pipeline.ts          # PipelineRunRequest, JobStatusResponse
    │   ├── sources.ts           # SourceListParams, SourceDetail
    │   ├── entities.ts          # EntityListParams, EntityDetail
    │   └── documents.ts         # Document retrieval schemas
    ├── routes/
    │   ├── pipeline.ts          # POST /api/pipeline/* (async, job-producing)
    │   ├── jobs.ts              # GET /api/jobs/*
    │   ├── search.ts            # POST /api/search
    │   ├── sources.ts           # GET/DELETE /api/sources/*
    │   ├── stories.ts           # GET /api/stories/*
    │   ├── entities.ts          # GET /api/entities/*, POST /api/entities/merge
    │   ├── taxonomy.ts          # GET /api/taxonomy/*, POST (async)
    │   ├── documents.ts         # GET /api/documents/* (PDF, layout, pages)
    │   ├── status.ts            # GET /api/status, /api/health
    │   └── index.ts             # Mount all route groups
    └── middleware/
        ├── auth.ts              # API key validation
        ├── rate-limiter.ts      # Tiered token bucket
        ├── error-handler.ts     # MulderError → HTTP response mapping
        └── request-context.ts   # Inject config, services, pools into context
```

**Route handler pattern:**
```typescript
// Every handler follows the same pattern as CLI commands:
// 1. Extract validated input (Zod already validated by middleware)
// 2. Get services from context (injected by request-context middleware)
// 3. Call business logic function (same as CLI calls)
// 4. Return typed response

app.openapi(searchRoute, async (c) => {
  const body = c.req.valid('json')
  const { config, services, pool } = c.var  // injected by middleware
  const result = await hybridRetrieve(body, config, services, pool)
  return c.json({ data: result }, 200)
})
```

---

## 10. API Versioning

**Decision:** No versioning prefix in M7. Single version, `/api/*` prefix.

**Why:** Mulder is a single-tenant tool, not a multi-consumer platform. The CLI and Document Viewer are the only consumers, both in the same monorepo, both updated together. Premature versioning adds routing complexity and cognitive overhead.

**When to add versioning:** If/when external consumers appear, introduce `/api/v2/*` alongside `/api/*` (which becomes v1). Migration via OpenAPI spec diffing.

---

## 11. Key Trade-offs

| Decision | Chose | Over | Why |
|----------|-------|------|-----|
| Framework | Hono | Express, Fastify | Zod-OpenAPI native, RPC client, cold start |
| OpenAPI | `@hono/zod-openapi` | `hono-openapi`, hand-written | Single source of truth with validation |
| API Explorer | Scalar | Swagger UI, Redoc | Modern UX, built-in client, active development |
| Auth | API key | OAuth2, Firebase Auth | Sufficient for single-tenant; auth middleware is swappable |
| Rate limiting | In-memory token bucket | Redis, external service | Single-instance per Cloud Run; no infrastructure overhead |
| Pagination | Cursor-based | Offset | Stable under concurrent writes, cheaper on PostgreSQL |
| Versioning | None (yet) | `/api/v1/*` | Single consumer, co-deployed, premature abstraction |
| RPC Client | Hono RPC for CLI | REST client, codegen | Zero overhead, type-safe, same monorepo |
| Error format | `{ error: { code, message, details } }` | RFC 7807 Problem Details | Simpler, matches existing error codes, no `type` URI needed |

---

## 12. Implementation Order

Per roadmap H1–H11, but refined with dependencies:

```
H1  Job queue repository (enqueue, dequeue, reap)
H2  Worker loop (mulder worker start/status/reap)
H3  Hono server scaffold (app.ts, middleware, health endpoint)
H9  Middleware (auth, rate limiting, error handling, request context)
    ↑ moved up — needed by all routes
H4  Pipeline API routes (POST /api/pipeline/run → job queue)
H5  Job status API (GET /api/jobs/*)
H6  Search API routes (POST /api/search)
H7  Entity API routes (GET /api/entities/*)
H8  Evidence API routes (GET /api/evidence/*)
H10 Document retrieval routes (GET /api/documents/*)
H11 Document Viewer UI (Vite+React, consumes H10)
```

H9 moves before H4–H8 because every route needs the middleware stack.

---

## References

- §10 (Job Queue & Worker Architecture) — `docs/functional-spec.md`
- §13 (Source Layout) — `docs/functional-spec.md`
- §D1–D5 (Domain-Agnostic Core) — `docs/architecture-core-vs-domain.md`
- Hono docs — https://hono.dev
- `@hono/zod-openapi` — https://hono.dev/examples/zod-openapi
- Scalar — https://scalar.com
