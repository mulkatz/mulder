---
spec: 37
title: "Vector Search Retrieval — pgvector Cosine Similarity"
roadmap_step: M4-E1
functional_spec: ["§5.1 (vector search)", "§5.3 (sparse graph degradation)", "§4.3 (HNSW index)", "§14 (HNSW design decision)"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/79
created: 2026-04-07
---

## 1. Objective

Stand up the `@mulder/retrieval` package with its first strategy: vector search over the `chunks` table using pgvector cosine similarity (HNSW index). The package currently exports nothing — this spec turns it into a real module that the eventual hybrid orchestrator (E6) and individual retrieval strategies (E2 graph traversal, E3 BM25 wrapper, E4 RRF, E5 re-rank) will plug into.

The vector search wrapper is a thin retrieval-layer module on top of the existing `chunks.searchByVector` repository function (already built in spec 32). Its job is to:

1. Accept either a text query or a precomputed query embedding.
2. If text was provided, embed it via the `EmbeddingService` (registry-injected — works in dev mode against fixtures).
3. Call the chunk repository's vector search.
4. Return a normalized, retrieval-layer result type (`RetrievalResult`) that all strategies will share — chunk id, story id, content, similarity score, and the strategy name. This shared type unblocks E2/E3/E4 because RRF fusion needs a uniform shape.
5. Emit `hnsw.ef_search` once per Node.js process before the first query, configurable via `retrieval.strategies.vector.ef_search` (default 40 per spec §4.3).

This step is the foundation for the entire retrieval system. After this lands, we can ask "show me the chunks closest to this query vector" from a top-level API and get a typed answer. No CLI command yet — `mulder query` lands in E6 once all three strategies + RRF + re-rank exist.

**Boundaries with E2 (BM25 wrapper):** The chunk repository already has `searchByFts`. E2 will add a parallel `fulltext.ts` retrieval module. This spec does not touch fulltext.

**Boundaries with E3 (graph traversal):** Recursive CTE traversal lands in E3 with its own module. Out of scope here.

**Boundaries with E4/E5 (RRF + re-rank):** No fusion, no LLM re-ranking. The vector search returns its own ranked list and the consumer does whatever it wants with it.

**Boundaries with E6 (hybrid orchestrator + `mulder query`):** No CLI command, no `mulder query` integration. The spec is library-only. The retrieval package will be exported for future consumers but no CLI surface exists yet.

## 2. Boundaries

**In scope:**
- New module: `packages/retrieval/src/types.ts` — shared retrieval-layer types (`RetrievalResult`, `VectorSearchOptions`, `RetrievalStrategy` enum)
- New module: `packages/retrieval/src/vector.ts` — `vectorSearch()` function (text or embedding input)
- Replace `packages/retrieval/src/index.ts` stub with real barrel exports
- Add `pg` and `@mulder/core` dependencies to `packages/retrieval/package.json` (already has `@mulder/core`; add `pg` as devDependency for types only — runtime pool is passed in)
- Extend `retrieval.strategies.vector` config schema with `ef_search` (default 40) — `packages/core/src/config/schema.ts` and `defaults.ts`
- Tests live in `tests/specs/37_vector_search_retrieval.test.ts` (added by verify agent, not implement agent)

**Out of scope:**
- `mulder query` CLI command (E6)
- Hybrid retrieval orchestration (E6)
- BM25 / fulltext wrapper (E2)
- Graph traversal (E3)
- RRF fusion (E4)
- Gemini re-ranking (E5)
- Any new database migration (HNSW index already exists in migration 008)
- `searchByVector` itself (already exists in `chunk.repository.ts`)

**CLI commands affected:** None. Library-only.

## 3. Dependencies

### Requires (must exist)
- `packages/core/src/database/repositories/chunk.repository.ts` — `searchByVector()` (spec 32) ✅
- `packages/core/src/database/repositories/chunk.types.ts` — `VectorSearchResult`, `Chunk` (spec 32) ✅
- `packages/core/src/shared/services.ts` — `EmbeddingService` interface (spec 10) ✅
- `packages/core/src/shared/registry.ts` — `Services` container (spec 10) ✅
- `packages/core/src/config/schema.ts` — `retrievalStrategiesSchema.vector` (already has `weight`) ✅
- HNSW index on `chunks(embedding vector_cosine_ops)` from migration 008 ✅
- `pgvector` extension and `text-embedding-004` 768-dim chunks from prior M4 steps ✅

### Required by (future consumers)
- Spec for E4 (RRF fusion) — needs `RetrievalResult` shape from this spec
- Spec for E6 (hybrid orchestrator + `mulder query`) — calls `vectorSearch()` as one of three strategies
- Future evidence/grounding modules that want a "find chunks like this text" primitive

## 4. Blueprint

### 4.1 Shared retrieval types — `packages/retrieval/src/types.ts`

```typescript
import type { Chunk } from '@mulder/core';

/** Identifies which strategy produced a retrieval result. */
export type RetrievalStrategy = 'vector' | 'fulltext' | 'graph';

/**
 * Normalized retrieval-layer result. Every strategy (vector, fulltext, graph)
 * returns this shape so RRF fusion (E4) can merge them uniformly.
 *
 * - `score` is the strategy-native score (cosine similarity for vector,
 *   ts_rank for fulltext, path confidence for graph). It is NOT normalized
 *   across strategies — that happens in fusion.
 * - `rank` is the 1-based position within this strategy's result list,
 *   used by RRF to compute `1 / (k + rank)`.
 */
export interface RetrievalResult {
  chunkId: string;
  storyId: string;
  content: string;
  score: number;
  rank: number;
  strategy: RetrievalStrategy;
  /** Strategy-specific metadata. For vector: { distance, similarity }. */
  metadata?: Record<string, unknown>;
}

/** Options for `vectorSearch()`. Exactly one of `query` or `embedding` is required. */
export interface VectorSearchOptions {
  /** Free-text query. If provided, will be embedded via the EmbeddingService. */
  query?: string;
  /** Precomputed query embedding. Overrides `query` when both are provided. */
  embedding?: number[];
  /** Maximum number of results to return. Default: `retrieval.top_k` from config (10). */
  limit?: number;
  /** Optional filter: only search within chunks of these stories. */
  storyIds?: string[];
  /**
   * Optional: skip generated question chunks (`is_question = true`) so that
   * vector search only matches content chunks. Default: false (include all).
   * Reserved for future use — content+question matching is the M4 default.
   */
  contentOnly?: boolean;
}
```

### 4.2 Vector search wrapper — `packages/retrieval/src/vector.ts`

```typescript
import type pg from 'pg';
import type { EmbeddingService, MulderConfig } from '@mulder/core';
import { searchByVector } from '@mulder/core';
import { createChildLogger, createLogger, RetrievalError, RETRIEVAL_ERROR_CODES } from '@mulder/core';
import type { RetrievalResult, VectorSearchOptions } from './types.js';

/**
 * Vector search retrieval strategy.
 *
 * Wraps the chunk repository's `searchByVector` with text-query embedding,
 * config-driven defaults, and the shared `RetrievalResult` shape.
 *
 * The HNSW `ef_search` session parameter is set once per pool on the
 * first call (per Node.js process) using `retrieval.strategies.vector.ef_search`
 * from config. Higher values trade speed for recall.
 */
export async function vectorSearch(
  pool: pg.Pool,
  embeddingService: EmbeddingService,
  config: MulderConfig,
  options: VectorSearchOptions,
): Promise<RetrievalResult[]>;
```

**Process flow:**

1. Validate options:
   - At least one of `query` or `embedding` must be provided. Throw `RetrievalError(RETRIEVAL_INVALID_INPUT)` otherwise.
   - If `query` is an empty/whitespace string and no `embedding`, throw same error.
2. Resolve query embedding:
   - If `options.embedding` is provided, use it directly.
   - Else call `embeddingService.embed([options.query])` and take `result[0].vector`.
   - Validate the resulting vector has the expected length (`config.embedding.storage_dimensions`, default 768). Throw `RETRIEVAL_DIMENSION_MISMATCH` if mismatched.
3. Resolve limit: `options.limit ?? config.retrieval.top_k`.
4. Ensure HNSW `ef_search` is set on the pool: call `ensureEfSearch(pool, config.retrieval.strategies.vector.ef_search)` (see 4.3).
5. Call `searchByVector(pool, embedding, limit, options.storyIds ? { storyIds: options.storyIds } : undefined)` from the chunk repository.
6. If `contentOnly` is true, filter the results in-application to drop `chunk.isQuestion === true`. (We do this post-query because the SQL helper does not currently support that filter; pushing it down is a future optimization, not blocking.)
7. Map each `VectorSearchResult` to a `RetrievalResult`:
   - `chunkId = result.chunk.id`
   - `storyId = result.chunk.storyId`
   - `content = result.chunk.content`
   - `score = result.similarity` (1 - cosine distance, higher = better)
   - `rank = index + 1`
   - `strategy = 'vector'`
   - `metadata = { distance: result.distance, similarity: result.similarity, isQuestion: result.chunk.isQuestion }`
8. Log a debug line with query length, embedding source (text vs precomputed), result count, and elapsed ms.
9. Return the array.

**Error handling:**
- Embedding service failures bubble up wrapped in `RetrievalError(RETRIEVAL_EMBEDDING_FAILED, { cause })` so callers can distinguish "embedding failed" from "query failed".
- Repository errors bubble up wrapped in `RetrievalError(RETRIEVAL_QUERY_FAILED, { cause })`.
- Empty result set is NOT an error — return `[]`.

### 4.3 ef_search session parameter — same file

`hnsw.ef_search` is a per-session PostgreSQL parameter. We must set it before each query on the connection that runs the query (sessions in pg's pool are not shared, so the simplest correct approach is to issue `SET LOCAL hnsw.ef_search = $1` inside a single transaction together with the search). Two acceptable approaches:

**Option A (chosen — simplest):** Cache a `WeakSet<pg.Pool>` of pools that have already had `ALTER ROLE` applied at the database level — not done. **Reject:** requires DDL.

**Option B (chosen):** Set it per query inline:

```typescript
async function searchWithEfSearch(
  pool: pg.Pool,
  embedding: number[],
  limit: number,
  efSearch: number,
  filter: { storyIds?: string[] } | undefined,
): Promise<VectorSearchResult[]> {
  // Acquire a dedicated connection so SET applies to the same session as the query
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL hnsw.ef_search = ${Number(efSearch)}`);
    // Reuse the repository's query by inlining it on the client (not the pool):
    // We cannot pass `client` into searchByVector(pool, ...) because it takes
    // a pool. Instead, run the same SELECT here. SET LOCAL is scoped to a
    // transaction, so wrap in BEGIN/COMMIT.
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `SELECT *, embedding::text, (embedding <=> $1::vector) AS distance
         FROM chunks
         WHERE embedding IS NOT NULL
           ${filter?.storyIds ? 'AND story_id = ANY($3::uuid[])' : ''}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        filter?.storyIds ? [formatEmbedding(embedding), limit, filter.storyIds] : [formatEmbedding(embedding), limit],
      );
      await client.query('COMMIT');
      return result.rows.map(/* same mapper as repo */);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}
```

**This is too duplicative.** Instead, **option C (chosen for real)**:

Add a small helper to the chunk repository — `searchByVector` already exists; add a sibling `searchByVectorWithEfSearch(pool, embedding, limit, efSearch, filter)` in `chunk.repository.ts` that does the `BEGIN; SET LOCAL hnsw.ef_search; SELECT; COMMIT;` dance using a checked-out client. The retrieval-layer wrapper calls this when `efSearch` is configured. If `efSearch` is null/undefined, falls back to the existing `searchByVector(pool, ...)`. This keeps the SQL in the repository (where it belongs) and the retrieval layer thin.

**Final 4.3 decision:** Add `searchByVectorWithEfSearch` to `chunk.repository.ts`. The retrieval `vectorSearch` function calls it.

### 4.4 Repository extension — `packages/core/src/database/repositories/chunk.repository.ts`

Add ONE new exported function:

```typescript
/**
 * Same as `searchByVector` but sets `hnsw.ef_search` on the connection
 * for the duration of the query. Use when retrieval needs higher recall
 * than the global default.
 *
 * @param efSearch - HNSW ef_search value. Higher = better recall, slower.
 *                   Caller is responsible for validating this is a positive integer.
 */
export async function searchByVectorWithEfSearch(
  pool: pg.Pool,
  queryEmbedding: number[],
  limit: number,
  efSearch: number,
  filter?: { storyIds?: string[] },
): Promise<VectorSearchResult[]>;
```

**Implementation notes:**
- Acquire a client via `pool.connect()`.
- `BEGIN`, then `SET LOCAL hnsw.ef_search = <integer>` (parameterized as a number, not a string concat — sanitize via `Number.isInteger` and `Math.max(1, …)`. PostgreSQL doesn't accept bind params for SET, so it must be an inline integer; the input must be validated as a finite positive integer before being interpolated).
- Run the same SELECT as `searchByVector` on the client.
- `COMMIT` on success, `ROLLBACK` on error.
- Always `client.release()` in `finally`.
- Wrap pg errors in `DatabaseError(DB_QUERY_FAILED)` matching the existing pattern.
- Re-export from `packages/core/src/database/index.ts` and `packages/core/src/index.ts` barrel.

**Refactor opportunity:** The SELECT body is identical to `searchByVector`. Extract a tiny private helper `buildVectorSearchQuery(filter)` returning `{ sql, paramOffset }` or just inline the duplication — both acceptable. Implementer's call.

### 4.5 RetrievalError + error codes — `packages/core/src/shared/errors.ts`

Add a new error class and code namespace, following the existing pattern (`EmbedError`, `EnrichError`, `GraphError`, etc.):

```typescript
export const RETRIEVAL_ERROR_CODES = {
  RETRIEVAL_INVALID_INPUT: 'RETRIEVAL_INVALID_INPUT',
  RETRIEVAL_EMBEDDING_FAILED: 'RETRIEVAL_EMBEDDING_FAILED',
  RETRIEVAL_QUERY_FAILED: 'RETRIEVAL_QUERY_FAILED',
  RETRIEVAL_DIMENSION_MISMATCH: 'RETRIEVAL_DIMENSION_MISMATCH',
} as const;

export type RetrievalErrorCode = (typeof RETRIEVAL_ERROR_CODES)[keyof typeof RETRIEVAL_ERROR_CODES];

export class RetrievalError extends MulderError {
  constructor(message: string, code: RetrievalErrorCode, options?: ErrorOptions) {
    super(message, code, options);
    this.name = 'RetrievalError';
  }
}
```

Export from `packages/core/src/shared/errors.ts` and the package barrel. Also add `RetrievalError` to the error code coverage test mappings in `tests/specs/37_qa_error_code_coverage.test.ts` (existing test — it tracks all defined error codes).

### 4.6 Config schema extension — `packages/core/src/config/schema.ts`

Extend `vectorStrategySchema`:

```typescript
const vectorStrategySchema = z.object({
  weight: z.number().min(0).max(1).default(0.5),
  ef_search: z.number().int().positive().default(40),  // NEW
});
```

Update `packages/core/src/config/defaults.ts`:

```typescript
strategies: {
  vector: { weight: 0.5, ef_search: 40 },  // updated
  fulltext: { weight: 0.3 },
  graph: { weight: 0.2, max_hops: 2, supernode_threshold: 100 },
},
```

### 4.7 Package wiring

**`packages/retrieval/package.json`** — add runtime dep on `pg` (peer-style):

```json
{
  "name": "@mulder/retrieval",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc --build", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@mulder/core": "workspace:*"
  },
  "devDependencies": {
    "@types/pg": "catalog:",
    "pg": "catalog:"
  },
  "peerDependencies": {
    "pg": "catalog:"
  }
}
```

`pg` is a peer dep because the caller passes the `Pool` in. This avoids two copies of `pg` in node_modules. Match the version pattern (`catalog:`) used by other packages — verify in implement step.

**`packages/retrieval/tsconfig.json`** — already has `references: [{ "path": "../core" }]`. No changes.

**`packages/retrieval/src/index.ts`** — replace stub with:

```typescript
export { vectorSearch } from './vector.js';
export type { RetrievalResult, RetrievalStrategy, VectorSearchOptions } from './types.js';
```

### 4.8 Integration verification

- `pnpm turbo run build` builds `@mulder/retrieval` cleanly.
- `npx biome check .` passes.
- `npx vitest run tests/` — full test suite green (no regressions). New tests live under spec 37.

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Vector search by text query returns ranked chunks | A populated chunks table with embeddings (dev fixtures) | A node script imports `vectorSearch` from `@mulder/retrieval` and calls it with a text query and `limit: 5` | Returns a `RetrievalResult[]` of length ≤ 5, ordered by `score` descending, each with `strategy: 'vector'`, `rank` 1..N, valid `chunkId` and `storyId` |
| QA-02 | Vector search by precomputed embedding bypasses embedding service | A 768-dim embedding array | `vectorSearch(pool, embeddingService, config, { embedding, limit: 3 })` | Returns ≤ 3 results; the embedding service is NOT called (verifiable via a fake `EmbeddingService` whose `embed()` throws) |
| QA-03 | Story-id filter restricts results | Two stories A and B, each with multiple chunks and embeddings | `vectorSearch(..., { query: "...", storyIds: [storyA.id] })` | All returned `storyId` values equal `storyA.id` |
| QA-04 | Empty query rejected | — | `vectorSearch(..., { query: "   " })` (whitespace only, no embedding) | Throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT` |
| QA-05 | Missing input rejected | — | `vectorSearch(..., {})` (no query, no embedding) | Throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT` |
| QA-06 | Dimension mismatch rejected | An embedding of wrong length (e.g., 384) | `vectorSearch(..., { embedding: <384-dim> })` | Throws `RetrievalError` with code `RETRIEVAL_DIMENSION_MISMATCH` |
| QA-07 | Embedding failure wrapped | An `EmbeddingService` that throws | `vectorSearch(..., { query: "anything" })` | Throws `RetrievalError` with code `RETRIEVAL_EMBEDDING_FAILED` and `cause` set to the original error |
| QA-08 | Empty result set returns `[]` | Empty chunks table or filter that matches nothing | `vectorSearch(..., { query: "...", storyIds: ['00000000-0000-0000-0000-000000000000'] })` | Returns `[]` (no error) |
| QA-09 | Default limit respects `retrieval.top_k` config | `retrieval.top_k = 7` in config, chunks table has > 7 embedded chunks | `vectorSearch(..., { query: "..." })` (no `limit`) | Returns exactly 7 results |
| QA-10 | `ef_search` set on the connection per query | `retrieval.strategies.vector.ef_search = 80`; chunks populated | A vector search query runs | The query succeeds (exact value not observable via SQL after COMMIT, so this is verified by a successful query when ef_search is set via the new repository function — the test asserts `searchByVectorWithEfSearch` exists and can be called with a non-default value without erroring) |
| QA-11 | RetrievalResult shape contract | A successful search | Inspect each result | Each has `chunkId: string`, `storyId: string`, `content: string`, `score: number` (between 0 and 1 for cosine), `rank: number` (1..N, contiguous), `strategy: 'vector'`, `metadata.distance` and `metadata.similarity` are numbers |
| QA-12 | Repository function exported from core barrel | — | `import { searchByVectorWithEfSearch } from '@mulder/core'` in a test file | Import resolves; calling it with valid args returns rows |

### 5b. CLI Test Matrix

N/A — this spec is library-only. No CLI surface. The future `mulder query` command (E6) will introduce CLI tests.

### 5c. Test infrastructure notes for the verify agent

Because there is no CLI command, tests must call the library directly. The verify agent should:

1. Use a **dynamic import** of `@mulder/retrieval` (and `@mulder/core` for the `Services`/`Pool`/config loader). The build must run before the tests, so the test should set up a `beforeAll` that runs `pnpm turbo run build --filter=@mulder/retrieval --filter=@mulder/core` if the dist is missing.
2. Spin up the test PostgreSQL container (`mulder-pg-test`) the same way other spec tests do.
3. Seed the database with at least 2 stories and 6 chunks with deterministic embeddings (e.g., `[1, 0, 0, ...]`, `[0, 1, 0, ...]`). Use raw SQL via `docker exec psql` or a tiny seeding helper that calls the chunk repo.
4. For QA-02 and QA-07, construct an in-test `EmbeddingService` stub (`{ embed: async () => { throw new Error('boom') } }` or `{ embed: async (texts) => texts.map(() => ({ text: '', vector: [...] })) }`).
5. Skip tests cleanly with `it.skipIf(!isPgAvailable())` if the test container is not running, matching the pattern in `tests/specs/34_embed_step.test.ts`.

This is the first spec where black-box tests must call into a library rather than the CLI. The verify agent should treat the **public package surface** (`@mulder/retrieval` exports) as the system boundary instead of CLI stdin/stdout. No `import` from `packages/retrieval/src/...` or any internal file — only the published package barrel.

## 6. Estimation

- **Files created:** 2 (`packages/retrieval/src/types.ts`, `packages/retrieval/src/vector.ts`)
- **Files modified:** 6
  - `packages/retrieval/src/index.ts` (replace stub)
  - `packages/retrieval/package.json` (add deps)
  - `packages/core/src/database/repositories/chunk.repository.ts` (+ `searchByVectorWithEfSearch`)
  - `packages/core/src/database/index.ts` and `packages/core/src/index.ts` (barrel re-export)
  - `packages/core/src/shared/errors.ts` (+ `RetrievalError`, `RETRIEVAL_ERROR_CODES`)
  - `packages/core/src/config/schema.ts` and `packages/core/src/config/defaults.ts` (+ `ef_search`)
  - `tests/specs/37_qa_error_code_coverage.test.ts` (add `RetrievalError` to mappings)
- **Complexity:** Low–medium. Bulk of the work (HNSW index, repo SQL, embedding wrapper) is already done. The only non-trivial decision is the `ef_search` plumbing (4.3/4.4).
- **Risk:** Low. New package surface area is small and isolated. No schema changes, no LLM prompt iteration.

## 7. Notes for the implementer

- **Don't reinvent the SQL.** `searchByVector` already exists. The new `searchByVectorWithEfSearch` is a controlled duplication, not a refactor of the original — leave the original alone so other callers (future grounding/eval code) can use it without paying for `ef_search` plumbing.
- **`SET LOCAL hnsw.ef_search` cannot use bind parameters.** PostgreSQL `SET` only takes literal values. Validate the integer client-side (`Number.isInteger(x) && x > 0`) before string-interpolating, and error out hard if someone passes garbage. This is the only place in the codebase where SQL interpolation is unavoidable — call it out in a comment.
- **Don't add `mulder query` here.** It's tempting because the CLI is right there, but E6 owns hybrid orchestration and the integrated CLI command. Build only the library.
- **Keep `RetrievalResult.score` strategy-native.** Don't normalize to 0..1 across strategies — that's RRF's job in E4.
- **Question chunks are part of the search corpus.** The default behavior includes them (`is_question = true` chunks have their own embeddings and were intentionally created during the embed step to expand the search surface). The `contentOnly` option exists for callers who want pure-content search later, but the default returns everything.
