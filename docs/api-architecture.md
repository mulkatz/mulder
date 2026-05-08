# M7 API Architecture — Design Decisions

Companion to `roadmap.md` M7 (H1–H11). Covers framework choice, API structure, the shipped middleware stack, and key trade-offs.

**Runtime parity note:** This document preserves the M7 architecture direction. The exact current inventory of mounted HTTP routes, CLI-only capabilities, backend-only capabilities, and app-ready contracts is tracked in [`api-parity-matrix.md`](./api-parity-matrix.md). If a route sketch or CLI remote-mode note below is not represented as mounted in that matrix, treat it as design intent or partial future work rather than a shipped runtime guarantee.

---

## 1. Framework: Hono

**Decision:** Hono with `@hono/node-server` for Cloud Run.

**Why Hono over Express/Fastify:**
- Small typed routing surface that works well with the repository's Zod request/response schemas
- Hono RPC (`hono/client`) gives free end-to-end type safety for the CLI → API path — zero codegen, types flow through TypeScript
- 140M downloads/month, production-grade, v4.12 stable
- Tiny cold start on Cloud Run (~20ms init vs ~200ms Express)
- Built-in middleware patterns cover auth, security headers, rate limiting, and error handling without adding a heavier framework

**Why not Express:** No native TypeScript type inference across middleware chain. Zod-OpenAPI integration requires third-party glue. Cold start heavier.

**Why not Fastify:** Good option technically, but Hono keeps the Cloud Run/serverless surface smaller and the RPC client has no Fastify equivalent.

**Packages:**
```
hono                        # Core framework
@hono/node-server           # Node.js adapter (Cloud Run)
```

---

## 2. Runtime Schemas And OpenAPI Contract

**Decision:** The API uses runtime Zod validation through `@hono/zod-openapi` and publishes a machine-readable OpenAPI document at `GET /api/openapi.json`.

**How it works:**
```typescript
app.openapi(searchRoute, async (c) => {
  const body = SearchRequestSchema.parse(await c.req.json())
  const result = await hybridRetrieve(body, config, services, pool)
  SearchResponseSchema.parse(result)
  return c.json(result, 200)
})
```

**Published contract:** `GET /api/openapi.json` is public and generated from the mounted product routes. It must not advertise route sketches or backend-only capabilities that are not actually mounted.

**Not mounted:** M7 does not mount `/doc` or `/reference`. A human-facing API explorer remains a separate future feature.

**Shared schemas:** Route schemas import from `@mulder/core` types and extend them for HTTP context (pagination, error envelopes). Core domain types stay in `packages/core/`, API-specific wrappers live in `apps/api/src/schemas/`.

---

## 3. API Explorer

**Decision:** No API explorer is mounted in the M7 runtime.

Scalar remains a good future option, but it is not represented as a shipped config key or public unauthenticated route today. External clients should use `GET /api/openapi.json` directly.

---

## 4. Route Structure

Based on §10.7 of the functional spec. Two categories: **async** (job-producing) and **sync** (direct response).

### Async Routes (Job Queue)

Long-running operations. API writes to `jobs` table, returns `202 Accepted` + job reference.

```
POST   /api/pipeline/run              # Enqueue pipeline run → 202 { job_id }
POST   /api/pipeline/retry            # Retry failed sources → 202 { job_id }
```

Taxonomy bootstrap/re-bootstrap are intentionally not mounted yet. They need a
dedicated worker job type and browser curation workflow before becoming product
HTTP routes.

### Sync Routes (Direct Response)

Read-only or lightweight operations. Hit database/services directly, return immediately.

```
# Jobs
GET    /api/jobs                      # List jobs (filterable by status, type)
GET    /api/jobs/:id                  # Job status + progress + errors

# Search
POST   /api/search                    # Hybrid retrieval (vector + BM25 + graph + RRF + rerank)

# Documents / Sources
GET    /api/documents                 # List sources (filterable, paginated)
GET    /api/documents/:id             # Reader-safe source detail
GET    /api/documents/:id/stories     # Document-scoped stories
GET    /api/documents/:id/observability # Processing background for a source

# Entities
GET    /api/entities                  # List/search entities (filterable by type, taxonomy)
GET    /api/entities/:id              # Entity detail + relationships + aliases
POST   /api/entities/merge            # Merge two entities (lightweight, sync)

# Entity Edges
GET    /api/entities/:id/edges        # Entity relationships

# Taxonomy
GET    /api/taxonomy                  # List taxonomy entries
GET    /api/taxonomy/export           # Export taxonomy as YAML

# Collections
GET    /api/collections               # List collections
POST   /api/collections               # Create non-archive collection
GET    /api/collections/:id           # Collection detail
PATCH  /api/collections/:id           # Patch mutable collection metadata

# Discovery
GET    /api/discovery/similar-entities
GET    /api/discovery/temporal-patterns
GET    /api/discovery/classification-mappings
GET    /api/discovery/external-correlations

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
2. request-context     # Request-scoped logger/context
3. secure-headers      # Security headers (X-Content-Type-Options, etc.)
4. body-limit          # Max request body: 10MB, with upload dev-proxy exemption
5. auth                # Bearer API key or browser session cookie
6. rate-limiter        # Token bucket per authenticated principal/IP tier
7. error-handler       # Global: MulderError → HTTP response, Zod errors → 400
```

### Auth Strategy

**M7 runtime:** server/CLI callers use API keys in `Authorization: Bearer <key>`, and browser callers use HTTP-only session cookies created by `/api/auth/*`.

```yaml
# mulder.config.yaml
api:
  port: 8080
  auth:
    api_keys:
      - name: "cli"
        key: "${MULDER_API_KEY}"    # env var reference
    browser:
      enabled: true
      cookie_name: "mulder_session"
      session_secret: "${MULDER_SESSION_SECRET}"
      session_ttl_hours: 168
      invitation_ttl_hours: 168
      cookie_secure: false
      same_site: "Lax"
  rate_limiting:
    enabled: true
```

**Future:** OAuth/OIDC can be added behind the same route/middleware boundary if needed.

**Unauthenticated endpoints:** `/api/health`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`, and `/api/auth/invitations/accept`.

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
  // Zod validation errors from route-level schema parsing
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

**External consumers:** Use the documented JSON routes directly or fetch the generated OpenAPI document from `GET /api/openapi.json`. The JSON contract is intentionally shipped without a bundled explorer UI.

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
    │   ├── entities.ts          # EntityListParams, EntityDetail
    │   ├── documents.ts         # Document retrieval schemas
    │   ├── collections.ts       # Collection read/mutation schemas
    │   ├── taxonomy.ts          # Taxonomy list/export schemas
    │   └── discovery.ts         # M12 discovery read schemas
    ├── routes/
    │   ├── pipeline.ts          # POST /api/pipeline/* (async, job-producing)
    │   ├── jobs.ts              # GET /api/jobs/*
    │   ├── search.ts            # POST /api/search
    │   ├── entities.ts          # GET /api/entities/*, POST /api/entities/merge
    │   ├── taxonomy.ts          # GET /api/taxonomy/*
    │   ├── collections.ts       # GET/POST/PATCH /api/collections*
    │   ├── discovery.ts         # GET /api/discovery/*
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

**When to add versioning:** If/when external consumers appear, introduce `/api/v2/*` alongside `/api/*` (which becomes v1). Use contract tests and, if added later, generated schema diffs to guide migration.

---

## 11. Key Trade-offs

| Decision | Chose | Over | Why |
|----------|-------|------|-----|
| Framework | Hono | Express, Fastify | Small runtime, RPC client option, cold start |
| OpenAPI | Mounted JSON contract at `/api/openapi.json` | Silent route sketches | Keep external contracts aligned to mounted routes |
| API Explorer | Future explicit feature | Silent Scalar config | Avoid promising unmounted `/reference` routes |
| Auth | API key + browser session cookie | Browser-shipped API key | Keeps CLI/server access and browser access safe |
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
