---
spec: 38
title: "Full-Text Search Retrieval — BM25 over chunks.fts_vector"
roadmap_step: M4-E2
functional_spec: ["§5.1 (full-text search)", "§4.3 (chunks.fts_vector generated column)", "§5.3 (sparse graph degradation)"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/81
created: 2026-04-07
---

## 1. Objective

Add the second strategy to the `@mulder/retrieval` package: full-text BM25 search over the same `chunks` table that vector search hits, using the generated `fts_vector` column. The wrapper sits at the same architectural layer as `vectorSearch` (E1) — a thin retrieval-layer module on top of the existing `searchByFts` repository function — and returns the shared `RetrievalResult` shape so RRF fusion (E4) can merge results from vector + fulltext + graph uniformly.

What this strategy does:

1. Accept a free-text query string (FTS uses literal text, no embedding step needed).
2. Validate the query is non-empty.
3. Call the chunk repository's full-text search via `plainto_tsquery('simple', …)` against the generated `chunks.fts_vector` column.
4. **Exclude generated question chunks (`is_question = true`) by default**, per functional spec §5.1. Question chunks were generated to expand the *semantic* search surface for the vector strategy; lexical matching against question text is noisy and the spec explicitly filters them out for FTS. The default can be overridden via `options.includeQuestions: true` for callers that want everything.
5. Return a normalized `RetrievalResult[]` with `strategy: 'fulltext'`, ts_rank scores, and 1-based ranks.
6. Wrap repository errors in `RetrievalError(RETRIEVAL_QUERY_FAILED)` and validation errors in `RetrievalError(RETRIEVAL_INVALID_INPUT)`, matching the pattern E1 established.

This is the second of three retrieval strategies. After E2 lands, two thirds of the input plumbing for RRF fusion (E4) is in place. No CLI command yet — `mulder query` is owned by E6.

**Boundaries with E1 (vector):** The vector wrapper already exists in `packages/retrieval/src/vector.ts` and exports the shared `RetrievalResult` / `RetrievalStrategy` types from `types.ts`. This spec reuses those types verbatim and adds a sibling `FulltextSearchOptions` to the same `types.ts`.

**Boundaries with E3 (graph traversal):** Recursive CTE traversal lands in E3 with its own module. Out of scope here.

**Boundaries with E4/E5 (RRF + re-rank):** No fusion, no LLM re-ranking. Returns its own ts_rank list and the consumer does whatever it wants with it.

**Boundaries with E6 (hybrid orchestrator + `mulder query`):** No CLI command, no `mulder query` integration. Library-only.

## 2. Boundaries

**In scope:**
- New module: `packages/retrieval/src/fulltext.ts` — `fulltextSearch()` function
- Extend `packages/retrieval/src/types.ts` with `FulltextSearchOptions`
- Extend `packages/retrieval/src/index.ts` barrel to export `fulltextSearch` + `FulltextSearchOptions`
- Extend `searchByFts` in `packages/core/src/database/repositories/chunk.repository.ts` with an optional `excludeQuestions` filter — backwards-compatible (default off, the existing 3-arg call signature still works)
- Tests live in `tests/specs/38_fulltext_search_retrieval.test.ts` (added by verify agent, not implement agent)

**Out of scope:**
- `mulder query` CLI command (E6)
- Hybrid retrieval orchestration (E6)
- Vector search wrapper (E1, already done)
- Graph traversal (E3)
- RRF fusion (E4)
- Gemini re-ranking (E5)
- Any new database migration (the `fts_vector` generated column already exists in migration 008)
- Any new error codes (`RETRIEVAL_INVALID_INPUT` and `RETRIEVAL_QUERY_FAILED` already exist from spec 37)
- Any new config keys (`retrieval.strategies.fulltext.weight` already exists; FTS does not need an `ef_search` analogue)
- `searchByFts` SQL changes beyond adding the optional `is_question = false` filter

**CLI commands affected:** None. Library-only.

## 3. Dependencies

### Requires (must exist)
- `packages/core/src/database/repositories/chunk.repository.ts` — `searchByFts()` (spec 32) ✅
- `packages/core/src/database/repositories/chunk.types.ts` — `FtsSearchResult`, `Chunk` (spec 32) ✅
- `packages/retrieval/src/types.ts` — `RetrievalResult`, `RetrievalStrategy` (spec 37) ✅
- `packages/core/src/shared/errors.ts` — `RetrievalError`, `RETRIEVAL_ERROR_CODES` (spec 37) ✅
- `packages/core/src/config/schema.ts` — `retrieval.strategies.fulltext` (already has `weight`) ✅
- Generated `chunks.fts_vector` column from migration 008 ✅

### Required by (future consumers)
- Spec for E4 (RRF fusion) — calls `fulltextSearch()` as the second of three strategy inputs
- Spec for E6 (hybrid orchestrator + `mulder query`) — calls `fulltextSearch()` as one of three strategies

## 4. Blueprint

### 4.1 Repository extension — `packages/core/src/database/repositories/chunk.repository.ts`

The existing `searchByFts(pool, query, limit, filter?)` accepts a `filter` of `{ storyIds?: string[] }`. Extend the filter to also accept `excludeQuestions?: boolean`. When `excludeQuestions === true`, append `AND is_question = false` to the WHERE clause. Default behavior (filter omitted or `excludeQuestions !== true`) is unchanged — the existing spec 32 test (`searchByFts(pool, 'Phoenix', 5)`) keeps passing as-is.

**Updated signature:**

```typescript
export async function searchByFts(
  pool: pg.Pool,
  query: string,
  limit: number,
  filter?: { storyIds?: string[]; excludeQuestions?: boolean },
): Promise<FtsSearchResult[]>;
```

**SQL change:** add one branch to the existing WHERE-clause builder. The current implementation already builds `conditions` as an array of strings; just push `'is_question = false'` when `filter?.excludeQuestions === true`. No new bind parameters needed (the value is a SQL literal, not user input).

**No type-file change required** — the inline `filter` parameter type holds the new field. If the implementer wants to extract a `FtsFilter` type alias for clarity, that's fine but not required.

**Backwards compatibility:** The `excludeQuestions` field is optional. The existing test in `tests/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.test.ts` (line 674) calls `searchByFts(pool, 'Phoenix', 5)` with no filter. This must continue to return all matching chunks regardless of `is_question`.

### 4.2 Fulltext search options — `packages/retrieval/src/types.ts`

Add a new exported interface alongside `VectorSearchOptions`. Keep the file's existing structure and section comments — append a new "Fulltext search options" section.

```typescript
/**
 * Options for {@link fulltextSearch}. The query string is required — full-text
 * search has no precomputed-input alternative the way vector search does.
 *
 * By default, generated question chunks (`is_question = true`) are excluded
 * from results because lexical matching against question text is noisy
 * (functional spec §5.1). Set `includeQuestions: true` to opt back in.
 */
export interface FulltextSearchOptions {
  /** Free-text BM25 query. Required. Whitespace-only is rejected. */
  query: string;
  /** Maximum number of results to return. Default: `retrieval.top_k` from config (10). */
  limit?: number;
  /** Optional filter: only search within chunks of these stories. */
  storyIds?: string[];
  /**
   * Include generated question chunks in the result set. Default: `false`
   * (content chunks only, per functional spec §5.1). Most callers should
   * leave this off — `true` exists for diagnostic / debug use.
   */
  includeQuestions?: boolean;
}
```

### 4.3 Fulltext search wrapper — `packages/retrieval/src/fulltext.ts`

```typescript
/**
 * Full-text search retrieval strategy.
 *
 * Thin wrapper over `chunks.searchByFts` that:
 *   1. Validates the query string is non-empty.
 *   2. Resolves the result limit from config (`retrieval.top_k`).
 *   3. Excludes generated question chunks by default (functional spec §5.1).
 *   4. Returns the shared `RetrievalResult[]` shape so RRF fusion (E4) can
 *      merge it with vector + graph results uniformly.
 *
 * Errors are wrapped in `RetrievalError`:
 *   - empty / whitespace query → `RETRIEVAL_INVALID_INPUT`
 *   - repository / DB failure → `RETRIEVAL_QUERY_FAILED`
 *
 * An empty result set is NOT an error — returns `[]`.
 *
 * @see docs/specs/38_fulltext_search_retrieval.spec.md §4.3
 * @see docs/functional-spec.md §5.1
 */

import type { MulderConfig } from '@mulder/core';
import {
  createChildLogger,
  createLogger,
  RETRIEVAL_ERROR_CODES,
  RetrievalError,
  searchByFts,
} from '@mulder/core';
import type pg from 'pg';
import type { FulltextSearchOptions, RetrievalResult } from './types.js';

const logger = createChildLogger(createLogger(), { module: 'retrieval-fulltext' });

export async function fulltextSearch(
  pool: pg.Pool,
  config: MulderConfig,
  options: FulltextSearchOptions,
): Promise<RetrievalResult[]>;
```

**Process flow:**

1. Validate `options.query` is a non-empty string after `.trim()`. Throw `RetrievalError(RETRIEVAL_INVALID_INPUT)` otherwise.
2. Resolve `limit = options.limit ?? config.retrieval.top_k`.
3. Build the repository filter: always set `excludeQuestions: !options.includeQuestions` so the default (`includeQuestions === undefined`) maps to `excludeQuestions: true`. When `storyIds` is provided and non-empty, include it in the same filter object.
4. Call `searchByFts(pool, options.query.trim(), limit, filter)`. Wrap any thrown error in `RetrievalError(RETRIEVAL_QUERY_FAILED, { cause })`.
5. Map each `FtsSearchResult` to a `RetrievalResult`:
   - `chunkId = result.chunk.id`
   - `storyId = result.chunk.storyId`
   - `content = result.chunk.content`
   - `score = result.rank` (ts_rank, strategy-native, NOT normalized)
   - `rank = index + 1` (1-based position in the result list)
   - `strategy = 'fulltext'`
   - `metadata = { tsRank: result.rank, isQuestion: result.chunk.isQuestion }`
6. Log a debug line with query length, limit, includeQuestions flag, result count, elapsed ms.
7. Return the array.

**Empty query handling:** an all-whitespace query like `"   "` is rejected at step 1 with `RETRIEVAL_INVALID_INPUT`. A non-empty query that happens to match no documents is NOT an error — the wrapper returns `[]`.

**Why no embedding service parameter:** unlike `vectorSearch`, FTS operates on the literal query string via `plainto_tsquery`. There is nothing to embed and the registry-injected services container is not needed. The function takes only `pool`, `config`, and `options` — three positional args instead of vector's four.

### 4.4 Barrel export — `packages/retrieval/src/index.ts`

Append the new exports next to the existing vector exports:

```typescript
export type { FulltextSearchOptions, RetrievalResult, RetrievalStrategy, VectorSearchOptions } from './types.js';
export { fulltextSearch } from './fulltext.js';
export { vectorSearch } from './vector.js';
```

(Sort the exports alphabetically by symbol name to match the project's biome import-ordering convention.)

### 4.5 No package.json / tsconfig changes

The `@mulder/retrieval` package already depends on `@mulder/core` and has `pg` declared as a peer dependency from spec 37. No new runtime or dev dependencies. No new tsconfig project references.

### 4.6 No new error codes

The existing `RETRIEVAL_ERROR_CODES` are sufficient:
- `RETRIEVAL_INVALID_INPUT` — empty / whitespace query
- `RETRIEVAL_QUERY_FAILED` — repository or pg failure

`RETRIEVAL_EMBEDDING_FAILED` and `RETRIEVAL_DIMENSION_MISMATCH` exist for vector-only paths and are not used here. No additions to the error code coverage test (`tests/specs/37_qa_error_code_coverage.test.ts`) required.

### 4.7 No config schema changes

`retrieval.strategies.fulltext` already exposes a `weight: 0.3` default. FTS has no `ef_search`-equivalent tuning knob (PostgreSQL FTS does not expose one in the way pgvector's HNSW does). The wrapper uses `retrieval.top_k` as the default limit — same field vector search uses.

### 4.8 Integration verification

- `pnpm turbo run build` builds `@mulder/core` and `@mulder/retrieval` cleanly.
- `npx biome check .` passes.
- `npx vitest run tests/` — full test suite green. Spec 32's `searchByFts` test continues to pass without modification (backwards-compat check). New tests live under spec 38.

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | FTS returns ranked chunks for matching query | A populated chunks table with content like "Phoenix lights case Arizona" | Import `fulltextSearch` from `@mulder/retrieval` and call it with `{ query: "Phoenix", limit: 5 }` | Returns a `RetrievalResult[]` of length ≤ 5, ordered by `score` descending, each with `strategy: 'fulltext'`, `rank` 1..N contiguous, valid `chunkId` and `storyId` |
| QA-02 | Story-id filter restricts results | Two stories A and B, each with chunks containing the keyword "phoenix" | `fulltextSearch(pool, config, { query: "phoenix", storyIds: [storyA.id] })` | All returned `storyId` values equal `storyA.id` |
| QA-03 | Empty query rejected | — | `fulltextSearch(pool, config, { query: "   " })` (whitespace only) | Throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT` |
| QA-04 | Empty-string query rejected | — | `fulltextSearch(pool, config, { query: "" })` | Throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT` |
| QA-05 | Question chunks excluded by default | A story with two chunks: one content chunk (`is_question = false`) and one question chunk (`is_question = true`), both containing the literal word "Phoenix" | `fulltextSearch(pool, config, { query: "Phoenix" })` | Only the content chunk is returned. No result has `metadata.isQuestion === true` |
| QA-06 | `includeQuestions: true` returns question chunks | Same setup as QA-05 | `fulltextSearch(pool, config, { query: "Phoenix", includeQuestions: true })` | Both chunks returned (content + question) |
| QA-07 | Empty result set returns `[]` | Chunks table has content but no chunk matches the query | `fulltextSearch(pool, config, { query: "zzzzzzzz_no_match" })` | Returns `[]` (no error) |
| QA-08 | Default limit respects `retrieval.top_k` config | `retrieval.top_k = 7` in config, chunks table has > 7 chunks all matching "test" | `fulltextSearch(pool, config, { query: "test" })` (no `limit`) | Returns at most 7 results (ts_rank may yield fewer for very rare terms; the assertion is `length ≤ 7` AND that an explicit `limit: 100` returns more than 7) |
| QA-09 | RetrievalResult shape contract | A successful FTS query | Inspect each result | Each has `chunkId: string`, `storyId: string`, `content: string`, `score: number` (ts_rank, ≥ 0), `rank: number` (1..N contiguous), `strategy: 'fulltext'`, `metadata.tsRank` is a number, `metadata.isQuestion` is a boolean |
| QA-10 | Repository helper backwards-compatible | — | Call the legacy 3-arg form `searchByFts(pool, "phoenix", 5)` (no filter) on a chunks table containing both content and question chunks that match | Returns chunks of both `is_question` values (no implicit filter applied — the new `excludeQuestions` flag defaults to off when the filter is omitted) |
| QA-11 | Repository helper honors new filter | — | Call `searchByFts(pool, "phoenix", 5, { excludeQuestions: true })` | Every returned chunk has `is_question === false` |
| QA-12 | Story-id filter and excludeQuestions combine | Two stories with mixed content + question chunks | `fulltextSearch(pool, config, { query: "phoenix", storyIds: [storyA.id] })` | Only chunks belonging to `storyA` AND with `is_question = false` are returned |

### 5b. CLI Test Matrix

N/A — this spec is library-only. No CLI surface. The future `mulder query` command (E6) will introduce CLI tests.

### 5c. Test infrastructure notes for the verify agent

This spec follows the same library-test pattern that spec 37 established. The verify agent should:

1. Use a **dynamic import** of `@mulder/retrieval` and `@mulder/core` (`searchByFts`, `RetrievalError`, `loadConfig`, `mulderConfigSchema`) so the tests run against the built dist, not source. Set up a `beforeAll` that runs `pnpm turbo run build --filter=@mulder/retrieval --filter=@mulder/core` if dist is missing — same pattern as `tests/specs/37_vector_search_retrieval.test.ts`.
2. Use the same `mulder-pg-test` PostgreSQL container and `isPgAvailable()` / `it.skipIf` pattern as spec 37.
3. Seed the database with at least 2 stories and a mix of content + question chunks containing deterministic keywords (e.g., "phoenix", "arizona", "lights"). Embeddings can be `NULL` for FTS tests — the `fts_vector` column is generated from `content` and does not require an embedding to populate. Use raw SQL via `docker exec psql` for seeding (same helpers as spec 37 — `runSql`, `runSqlReturning`).
4. Clean test data between runs by `DELETE FROM chunks; DELETE FROM stories WHERE title LIKE 'spec38-%'; DELETE FROM source_steps WHERE source_id IN (SELECT id FROM sources WHERE filename LIKE 'spec38-%'); DELETE FROM sources WHERE filename LIKE 'spec38-%';`.
5. For `is_question = true` chunks: insert with explicit `is_question = TRUE` and a `parent_chunk_id` pointing to a content chunk in the same story (matches the spec 32 schema).
6. Treat the **public package surface** as the system boundary. Import only from `@mulder/retrieval` and `@mulder/core` — never from `packages/retrieval/src/...` or any internal source file. The repository helper (`searchByFts`) is part of the `@mulder/core` public barrel, so QA-10 / QA-11 may import it directly.

## 6. Estimation

- **Files created:** 1 (`packages/retrieval/src/fulltext.ts`)
- **Files modified:** 3
  - `packages/retrieval/src/types.ts` (+ `FulltextSearchOptions`)
  - `packages/retrieval/src/index.ts` (+ `fulltextSearch`, `FulltextSearchOptions`)
  - `packages/core/src/database/repositories/chunk.repository.ts` (extend `searchByFts` filter with `excludeQuestions`)
- **Complexity:** Low. Mirrors the established E1 pattern. The only novel decision is where to push the `is_question` filter (resolved: into the SQL via the existing `searchByFts` filter param, not in-app post-filter).
- **Risk:** Very low. Backwards-compatible repo extension, no schema changes, no new dependencies, no LLM, no GCP. The `pg_trgm` / `tsvector` plumbing is already battle-tested by spec 32 tests.

## 7. Notes for the implementer

- **Don't add a new repository function — extend the existing one.** `searchByFts` already exists and has a clean filter parameter. Adding a sibling `searchByFtsContentOnly` would be redundant. Just extend the filter type with one optional boolean field.
- **Default `excludeQuestions` to off in the repo, on in the retrieval wrapper.** The repository function is a low-level building block; it should not impose business policy on its callers. The retrieval-layer wrapper enforces functional spec §5.1 by always passing `excludeQuestions: true` unless the caller explicitly opts in via `includeQuestions: true`. This split keeps the repo backwards-compatible (spec 32's existing `searchByFts(pool, 'Phoenix', 5)` test still passes) while making the retrieval-layer behavior match the functional spec.
- **No bind-parameter trickery for the `is_question = false` filter.** Unlike `hnsw.ef_search`, this is a standard WHERE-clause condition. No SQL injection risk, no client-side validation needed beyond TypeScript's `boolean` type. Just push the literal `'is_question = false'` into the existing `conditions` array when the flag is set.
- **Don't normalize `score`.** Return ts_rank as-is (it can be a small float like `0.0064`). Cross-strategy normalization is RRF's job in E4.
- **Don't add `mulder query` here.** Library-only, same boundary as E1.
- **`plainto_tsquery('simple', …)` matches the existing repo and migration 008.** Don't switch dictionaries (`'english'`, `'german'`, etc.) — multilingual handling is intentional and the `simple` dictionary is the chosen default for all FTS operations in the project.
- **Question chunks vs content chunks:** the embed step (spec 34) generates question chunks as paraphrases of content for better *semantic* (vector) recall. Their literal text is intentionally similar to the content chunk it was generated from, so lexical FTS would double-count matches. This is why §5.1 mandates the exclusion. Don't try to make this configurable per-call beyond the single `includeQuestions` opt-in flag.
- **Logging:** match the structure used by `vectorSearch` so observability stays consistent across strategies. Use the same `module: 'retrieval-fulltext'` child logger naming convention.
