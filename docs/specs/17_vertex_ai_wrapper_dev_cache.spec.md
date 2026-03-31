---
spec: 17
title: Vertex AI Wrapper + Dev Cache
roadmap_step: M2-B5
functional_spec: ["§4.8"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/34
created: 2026-03-31
---

# 1. Objective

Add a process-level concurrency limiter and a dev-mode LLM response cache to all Vertex AI calls. The concurrency limiter prevents thundering herd 429s when multiple workers fire simultaneous Gemini/embedding requests. The dev cache eliminates redundant API calls during prompt iteration, reducing cost from O(docs × iterations) to O(docs) for the first run and O(1) for unchanged prompts.

# 2. Boundaries

**In scope:**
- `vertex.ts` — concurrency-limited wrapper functions for all Vertex AI calls
- `llm-cache.ts` — SQLite-based request cache (dev mode only)
- Wiring `services.gcp.ts` to use `vertex.ts` instead of calling GenAI SDK directly
- Config additions: `vertex.max_concurrent_requests` (default: 2)
- CLI: `mulder cache clear` command
- CLI: `mulder cache stats` command (shows hit count, entries, size)

**Out of scope:**
- Rate limiter changes (already exists in `rate-limiter.ts`)
- Retry logic changes (already exists in `retry.ts`)
- New service interfaces (existing `LlmService`/`EmbeddingService` interfaces unchanged)
- Prompt templates (M2-B6)
- Production cache (this is dev-only)

# 3. Dependencies

**Requires:**
- `@google/genai` SDK (already installed)
- `better-sqlite3` (new dependency — synchronous SQLite for cache)
- `p-limit` (new dependency — process-level concurrency limiter)
- Service abstraction layer (M1-A10, done)
- GCP service implementations (M2-B1, done)

**Required by:**
- Extract step (M2-B7) — uses `vertex.ts` functions via service interfaces
- Segment step (M3-C2) — uses `vertex.ts` for Gemini calls
- Enrich step (M3-C8) — uses `vertex.ts` for entity extraction
- Embed step (M4-D4) — uses `vertex.ts` for embeddings

# 4. Blueprint

## 4.1 New Files

### `packages/core/src/vertex.ts`

Thin wrapper around the GenAI SDK. All Vertex AI calls go through here.

**Exports:**
- `createVertexClient(ai: GoogleGenAI, options: VertexClientOptions): VertexClient`

**`VertexClientOptions`:**
```typescript
interface VertexClientOptions {
  maxConcurrentRequests: number  // from config, default 2
  cache?: LlmCache              // injected in dev mode, undefined in prod
  logger: Logger
}
```

**`VertexClient`:**
```typescript
interface VertexClient {
  generateStructured<T>(options: StructuredGenerateOptions): Promise<T>
  generateText(options: TextGenerateOptions): Promise<string>
  groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult>
  embed(texts: string[], model: string, dimensions: number): Promise<EmbeddingResult[]>
}
```

**Implementation pattern:**
- Creates a `pLimit(maxConcurrentRequests)` limiter at construction time
- Every method wraps the GenAI SDK call inside `limiter(async () => { ... })`
- If `cache` is provided, checks cache before making the API call
- Cache key: SHA-256 of `JSON.stringify({ model, prompt, schema?, systemInstruction? })`
- On cache hit: returns cached response, logs at `warn` level with tokens saved
- On cache miss: makes the API call, stores result in cache
- Embedding calls also go through the limiter (shared Vertex AI quota)
- Grounded generate calls are NOT cached (web results are time-sensitive)
- Uses `withRetry` for all SDK calls (imported from `retry.ts`)

### `packages/core/src/llm-cache.ts`

SQLite-based LLM response cache for dev mode.

**Exports:**
- `createLlmCache(dbPath: string, logger: Logger): LlmCache`
- `LlmCache` interface

**`LlmCache` interface:**
```typescript
interface LlmCache {
  get(hash: string): CacheEntry | undefined
  set(hash: string, entry: Omit<CacheEntry, 'request_hash' | 'created_at'>): void
  clear(): number  // returns number of entries cleared
  stats(): CacheStats
  close(): void
}

interface CacheEntry {
  request_hash: string
  response: string        // serialized JSON response
  model: string
  tokens_saved: number
  created_at: number      // Unix timestamp ms
}

interface CacheStats {
  entries: number
  totalTokensSaved: number
  dbSizeBytes: number
}
```

**Implementation:**
- Uses `better-sqlite3` for synchronous SQLite operations
- Database file: `.mulder-cache.db` in project root (gitignored)
- Schema: single `cache_entries` table with columns matching `CacheEntry`
- `get()`: SELECT by `request_hash`
- `set()`: INSERT OR REPLACE
- `clear()`: DELETE all rows, returns count
- `stats()`: COUNT + SUM(tokens_saved) + file size
- No TTL — manual clear only (prompt iteration use case)
- Creates table on first access (auto-migration)

### `packages/core/src/shared/cache-hash.ts`

**Exports:**
- `computeCacheKey(params: CacheKeyParams): string`

**`CacheKeyParams`:**
```typescript
interface CacheKeyParams {
  model: string
  prompt: string
  schema?: Record<string, unknown>
  systemInstruction?: string
}
```

**Implementation:**
- SHA-256 of `JSON.stringify(params)` with keys sorted for determinism
- Uses Node.js `crypto.createHash('sha256')`

## 4.2 Modified Files

### `packages/core/src/shared/services.gcp.ts`

**Changes:**
- Remove direct GenAI SDK calls from `GcpLlmService` and `GcpEmbeddingService`
- Both classes receive a `VertexClient` via constructor instead of raw `GoogleGenAI`
- `GcpLlmService.generateStructured/generateText/groundedGenerate` delegate to `vertexClient.generateStructured/generateText/groundedGenerate`
- `GcpEmbeddingService.embed` delegates to `vertexClient.embed`
- `createGcpServices()` factory creates the `VertexClient` and injects it
- `withRetry` calls move from service classes to `vertex.ts` (retry is now inside the concurrency limiter)

### `packages/core/src/shared/gcp.ts`

No changes needed — `getGenAI()` still provides the raw singleton. The `VertexClient` wraps it.

### `packages/core/src/config/schema.ts`

**Add `vertex` section to the config schema:**
```typescript
const vertexSchema = z.object({
  max_concurrent_requests: z.number().int().min(1).max(20).default(2),
}).default({})
```

Add to `mulderConfigSchema` at top level.

### `packages/core/src/config/types.ts`

Export `VertexConfig` type (auto-generated from schema via `z.infer`).

### `packages/core/src/index.ts`

Add exports:
- `createVertexClient`, `VertexClient`, `VertexClientOptions` from `vertex.ts`
- `createLlmCache`, `LlmCache`, `CacheEntry`, `CacheStats` from `llm-cache.ts`
- `computeCacheKey`, `CacheKeyParams` from `shared/cache-hash.ts`
- `VertexConfig` type from `config/types.ts`

### `apps/cli/src/commands/cache.ts` (new)

**Commands:**
- `mulder cache clear` — deletes all cache entries, reports count
- `mulder cache stats` — shows entries, tokens saved, db size

**Implementation:**
- Creates `LlmCache` instance with default db path
- Calls `cache.clear()` or `cache.stats()`
- Outputs results to stdout

### `apps/cli/src/index.ts`

Wire the `cache` command group.

## 4.3 Dependencies

**New npm dependencies (packages/core):**
- `p-limit` — latest version, ESM-compatible concurrency limiter
- `better-sqlite3` — latest version, synchronous SQLite3 bindings
- `@types/better-sqlite3` — TypeScript definitions (devDependency)

## 4.4 Config Changes

Add to `mulder.config.yaml` and `mulder.config.example.yaml`:
```yaml
vertex:
  max_concurrent_requests: 2  # Per-worker process Vertex AI concurrency limit
```

## 4.5 Integration Points

1. `createGcpServices()` in `services.gcp.ts`:
   - Creates `LlmCache` if `MULDER_LLM_CACHE=true` env var is set
   - Creates `VertexClient` with cache (if enabled) and concurrency config
   - Passes `VertexClient` to `GcpLlmService` and `GcpEmbeddingService`

2. Dev services (`services.dev.ts`): No changes needed — dev services don't call Vertex AI.

3. Registry (`registry.ts`): No changes needed — it already selects between dev and GCP services.

# 5. QA Contract

**QA-01: Concurrency limiter bounds parallel requests**
- Given: `vertex.max_concurrent_requests: 2` in config
- When: 10 concurrent `generateText` calls are fired simultaneously
- Then: At most 2 are in-flight at any time; all 10 eventually resolve

**QA-02: Cache stores and retrieves LLM responses**
- Given: `MULDER_LLM_CACHE=true` environment variable is set
- When: `generateStructured` is called with the same prompt twice
- Then: Second call returns the cached response without making an API call

**QA-03: Cache key is deterministic**
- Given: Two identical prompts with the same model and schema
- When: Cache keys are computed
- Then: Both produce the same SHA-256 hash

**QA-04: Grounded generate bypasses cache**
- Given: `MULDER_LLM_CACHE=true` is set
- When: `groundedGenerate` is called
- Then: The call is NOT cached (web results are time-sensitive)

**QA-05: `mulder cache clear` removes all entries**
- Given: The cache database has entries
- When: `mulder cache clear` is run
- Then: All entries are deleted, the count is reported

**QA-06: `mulder cache stats` reports cache statistics**
- Given: The cache database exists
- When: `mulder cache stats` is run
- Then: Output includes entry count, tokens saved, and database size

**QA-07: Cache is disabled by default**
- Given: No `MULDER_LLM_CACHE` env var is set
- When: GCP services are created
- Then: No cache is instantiated, all calls go directly to Vertex AI

**QA-08: Embedding calls go through concurrency limiter**
- Given: `vertex.max_concurrent_requests: 1` in config
- When: 5 concurrent `embed` calls are fired
- Then: They execute sequentially (max 1 in-flight)

**QA-09: Config schema validates vertex section**
- Given: `mulder.config.yaml` with `vertex.max_concurrent_requests: 0`
- When: Config is loaded
- Then: Validation fails (min is 1)

**QA-10: Cache database is auto-created**
- Given: No `.mulder-cache.db` file exists
- When: `LlmCache` is created
- Then: The database file and schema are created automatically
