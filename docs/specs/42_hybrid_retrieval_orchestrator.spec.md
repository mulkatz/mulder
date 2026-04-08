---
spec: 42
title: Hybrid Retrieval Orchestrator — `mulder query`
roadmap_step: M4-E6
functional_spec: §5, §1 (query cmd), §5.3
scope: single
created: 2026-04-08
issue: https://github.com/mulkatz/mulder/issues/89
---

## 1. Objective

Wire the three retrieval strategies (vector E1, fulltext E2, graph E3), RRF fusion (E4), and LLM re-ranking (E5) together behind a single library function `hybridRetrieve()` and expose it to users via the `mulder query` CLI command. This closes out M4 — after this step, a user can ingest PDFs, process them through the full pipeline, and ask natural-language questions against the indexed corpus from the terminal, with scores from each strategy explained on demand.

## 2. Boundaries

### In scope

- New `hybridRetrieve()` orchestrator function in `packages/retrieval/src/orchestrator.ts`
  - Runs vector + fulltext + graph in parallel (`Promise.all`), fuses via `rrfFuse`, re-ranks via `rerank`
  - Supports strategy modes `'vector' | 'fulltext' | 'graph' | 'hybrid'` (maps `--strategy` CLI flag to which strategies run)
  - Skip `rerank` when `options.noRerank === true` OR `config.retrieval.rerank.enabled === false`
  - Returns a `HybridRetrievalResult` object containing: `results`, `confidence`, and per-strategy `explain` breakdowns
- New `extractQueryEntities()` helper in `packages/retrieval/src/query-entities.ts`
  - Simple keyword/alias matching (no LLM call) against the `entity_aliases` and `entities` tables
  - Tokenizes the query, looks up exact alias matches first, then case-insensitive name matches
  - Returns a deduplicated list of seed entity IDs for graph traversal
  - Empty result is fine — the orchestrator degrades gracefully per §5.3
- New `computeQueryConfidence()` helper (same file or inline) producing the §5.3 confidence object:
  - `corpus_size`: count of sources with any completed pipeline step (from `sources.status`)
  - `taxonomy_status`: `'not_started' | 'bootstrapping' | 'active' | 'mature'` derived from corpus_size vs `config.thresholds.taxonomy_bootstrap`
  - `corroboration_reliability`: `'insufficient' | 'low' | 'moderate' | 'high'` derived from corpus_size vs `config.thresholds.corroboration_meaningful`
  - `graph_density`: `edge_count / entity_count` (0.0 when no entities, capped at a finite number)
  - `degraded`: boolean, true if graph strategy returned zero results or corpus_size is below `taxonomy_bootstrap` threshold
- New `@mulder/retrieval` types:
  - `RetrievalStrategyMode` (`'vector' | 'fulltext' | 'graph' | 'hybrid'`)
  - `HybridRetrieveOptions` (topK, strategy mode, noRerank, explain toggles, optional query embedding override)
  - `QueryConfidence` (the object described above)
  - `HybridRetrievalResult` (final output shape)
- New `packages/retrieval/src/orchestrator.ts` error handling: wraps strategy failures in `RetrievalError` with new code `RETRIEVAL_ORCHESTRATOR_FAILED`. Individual strategy failures do NOT crash the orchestrator when at least one other strategy succeeded (partial-mode hybrid is valid); only when ALL active strategies fail is the orchestrator-level error raised.
- New CLI command `mulder query <question>` in `apps/cli/src/commands/query.ts`:
  - `--strategy <s>` (`vector | fulltext | graph | hybrid`, default `hybrid`)
  - `--top-k <n>` (default: `config.retrieval.top_k`)
  - `--no-rerank` (skip LLM re-ranking)
  - `--explain` (print per-strategy score breakdown)
  - `--json` (machine-readable JSON output to stdout)
  - Standard error handling via `withErrorHandler`, closes pools in `finally`
- CLI wiring: `apps/cli/package.json` depends on `@mulder/retrieval`; `apps/cli/tsconfig.json` references the retrieval package; `apps/cli/src/index.ts` registers `registerQueryCommands`
- New error code `RETRIEVAL_ORCHESTRATOR_FAILED` in `RETRIEVAL_ERROR_CODES`
- Barrel re-exports: orchestrator function + all new types

### Out of scope

- LLM-based query entity extraction (§5.1 mentions "via Gemini or simple keyword matching" — we pick keyword matching for determinism, zero cost, and testability; the LLM variant can ship later if recall is insufficient)
- Query-side entity resolution beyond alias/name lookup (no cross-lingual tier-2/tier-3 resolution — that's enrich-time, spec 28)
- HTTP API / REST endpoint for query (that's M7 H6)
- Interactive REPL mode for repeated queries
- Query logging to a history table, query caching, query analytics
- Spell-check, stemming, or reformulation of the user's question
- "Answer" generation (RAG synthesis) — E6 returns ranked chunks, not synthesized answers
- Cursor pagination — one call, one result page
- Changes to the strategy implementations themselves (vector.ts, fulltext.ts, graph.ts, fusion.ts, reranker.ts) — they are already complete and used as-is

### Depends on

- `@mulder/retrieval` exports: `vectorSearch`, `fulltextSearch`, `graphSearch`, `rrfFuse`, `rerank`, `RetrievalResult`, `FusedResult`, `RerankedResult` (E1–E5, all 🟢)
- `@mulder/core` services: `loadConfig`, `createServiceRegistry`, `createLogger`, `getWorkerPool`, `closeAllPools`
- `@mulder/core` repositories: `findEntityByAlias`, `findAllEntities` (for name fallback), counts on `sources` + `entities` + `entity_edges`
- `@mulder/core` errors: `RetrievalError`, `RETRIEVAL_ERROR_CODES`, `withErrorHandler`
- Commander.js (already used by every existing CLI command)

## 3. Dependencies

### Requires (must exist before implementation)

- `packages/retrieval/src/vector.ts` — `vectorSearch` (E1, 🟢)
- `packages/retrieval/src/fulltext.ts` — `fulltextSearch` (E2, 🟢)
- `packages/retrieval/src/graph.ts` — `graphSearch` (E3, 🟢)
- `packages/retrieval/src/fusion.ts` — `rrfFuse` (E4, 🟢)
- `packages/retrieval/src/reranker.ts` — `rerank` (E5, 🟢)
- `packages/core/src/database/repositories/entity-alias.repository.ts` — `findEntityByAlias` (M3-C3, 🟢)
- `packages/core/src/database/repositories/entity.repository.ts` — `findAllEntities`, `countEntities` (M3-C3, 🟢)
- `packages/core/src/shared/services.ts` — `EmbeddingService`, `LlmService`
- `apps/cli/src/lib/errors.ts` — `withErrorHandler`
- `apps/cli/src/lib/output.ts` — `printSuccess`, `printError`

### Required by (will consume this)

- M5: `mulder status` and `mulder entity show` reuse the confidence helper
- M7: H6 Search API routes wrap `hybridRetrieve` behind HTTP
- Agent (M14): uses `hybridRetrieve` as one of its retrieval tools

## 4. Blueprint

### 4.1 New file: `packages/retrieval/src/query-entities.ts`

Keyword-based query entity extraction and corpus statistics. Pure SQL/repository calls, no LLM.

```typescript
import type pg from 'pg';
import type { MulderConfig } from '@mulder/core';
import { findEntityByAlias, findAllEntities, countEntities } from '@mulder/core';
import type { QueryConfidence } from './types.js';

/**
 * Extracts candidate seed entities from a free-text query for graph traversal.
 *
 * Strategy (deterministic, no LLM — see spec 42 §2 "Out of scope"):
 * 1. Tokenize the query on whitespace + punctuation.
 * 2. Generate candidate phrases: 1-gram, 2-gram, 3-gram (window size ≤ 3).
 * 3. For each phrase, attempt an exact alias match via `findEntityByAlias`.
 * 4. Deduplicate by entity.id, preserving insertion order.
 *
 * Empty result is fine — the orchestrator skips graph strategy gracefully.
 *
 * @returns Seed entity IDs for graphSearch, in first-seen order. Capped at 20
 *   to bound traversal cost (25+ seeds on a dense graph produce exponential
 *   fan-out even with supernode pruning).
 */
export async function extractQueryEntities(
  pool: pg.Pool,
  query: string,
): Promise<string[]>;

/**
 * Computes the `QueryConfidence` object per functional spec §5.3.
 *
 * All values are derived from cheap COUNT(*) queries on sources + entities +
 * entity_edges. No expensive graph metrics.
 *
 * Thresholds come from `config.thresholds`:
 * - taxonomy_status: `not_started` (0), `bootstrapping` (< taxonomy_bootstrap),
 *   `active` (< 2× threshold), `mature` (≥ 2× threshold)
 * - corroboration_reliability: `insufficient` (< 10), `low` (< corroboration_meaningful),
 *   `moderate` (< 2× threshold), `high` (≥ 2× threshold)
 * - graph_density: edge_count / entity_count (0.0 if entity_count = 0)
 * - degraded: true if corpus_size < taxonomy_bootstrap OR graph returned 0 hits
 */
export async function computeQueryConfidence(
  pool: pg.Pool,
  config: MulderConfig,
  options: { graphHitCount: number },
): Promise<QueryConfidence>;
```

**Tokenization rules (stable, testable):**
- Split on `/[\s\.,;:!?()\[\]{}"']+/`
- Lowercase for normalization, but pass the **original** token (preserving case) to `findEntityByAlias` first; fall back to lowercased lookup. This matches the `entity_aliases.alias` column which is stored case-sensitively.
- Discard tokens shorter than 2 chars after normalization
- Generate n-grams from windows of 1, 2, 3 tokens (joined by space)
- Cap total candidate phrases examined at 100 (query tokens × window combinations can blow up on long queries)

**SQL helpers needed** (`query-entities.ts` imports from `@mulder/core`):
- `countSources()` — `SELECT COUNT(*) FROM sources WHERE status != 'ingested'` (a corpus is everything past raw ingestion)
- `countEntitiesTotal()` — uses existing `countEntities(pool)` with no filter
- `countEdges()` — `SELECT COUNT(*) FROM entity_edges`

Two of these (sources + edges) don't have existing repository helpers. Add them to `packages/core/src/database/repositories/entity.repository.ts` and `source.repository.ts` respectively (or inline as a private helper inside `query-entities.ts` using `pool.query`). Choose: **inline in `query-entities.ts`** — these are query-layer statistics, not domain repository concerns, and a single file keeps the blast radius small.

### 4.2 New file: `packages/retrieval/src/orchestrator.ts`

The central `hybridRetrieve()` function.

```typescript
import type pg from 'pg';
import type {
  EmbeddingService,
  LlmService,
  MulderConfig,
} from '@mulder/core';
import { createChildLogger, createLogger, RETRIEVAL_ERROR_CODES, RetrievalError } from '@mulder/core';
import { vectorSearch } from './vector.js';
import { fulltextSearch } from './fulltext.js';
import { graphSearch } from './graph.js';
import { rrfFuse } from './fusion.js';
import { rerank } from './reranker.js';
import { extractQueryEntities, computeQueryConfidence } from './query-entities.js';
import type {
  FusedResult,
  HybridRetrievalResult,
  HybridRetrieveOptions,
  RerankedResult,
  RetrievalResult,
  RetrievalStrategy,
} from './types.js';

export async function hybridRetrieve(
  pool: pg.Pool,
  embeddingService: EmbeddingService,
  llmService: LlmService,
  config: MulderConfig,
  query: string,
  options?: HybridRetrieveOptions,
): Promise<HybridRetrievalResult>
```

**Algorithm:**

1. **Input validation:**
   - `query` must be a non-empty trimmed string → else `RetrievalError(RETRIEVAL_INVALID_INPUT)`
   - `options.topK`, if present, must be a positive integer → else `RETRIEVAL_INVALID_INPUT`
   - `options.strategy`, if present, must be one of `vector | fulltext | graph | hybrid`
2. **Resolve defaults:**
   - `strategy = options.strategy ?? config.retrieval.default_strategy` (default: `'hybrid'`)
   - `topK = options.topK ?? config.retrieval.top_k`
   - `noRerank = options.noRerank === true` (false by default)
   - `explain = options.explain === true`
3. **Choose active strategies** from the mode:
   - `vector` → `['vector']`
   - `fulltext` → `['fulltext']`
   - `graph` → `['graph']`
   - `hybrid` → `['vector', 'fulltext', 'graph']`
4. **Resolve query entities for graph traversal** (only if graph is active):
   - `seedEntityIds = await extractQueryEntities(pool, query)`
   - If empty → graph strategy is **skipped** (not an error). Track this in `explain.skipped = ['graph:no_seeds']`.
5. **Run strategies in parallel** using `Promise.allSettled`:
   - `vector`: `vectorSearch(pool, embeddingService, config, { query, limit: oversample })`
   - `fulltext`: `fulltextSearch(pool, config, { query, limit: oversample })`
   - `graph`: only if seedEntityIds.length > 0 → `graphSearch(pool, config, { entityIds: seedEntityIds, limit: oversample })`
   - `oversample = Math.max(topK * 3, config.retrieval.rerank.candidates)` — ensures fusion has enough headroom before re-rank truncation
6. **Handle strategy outcomes:**
   - On `fulfilled`: add to `strategyResults` map and track hit count in `explain.counts[strategy]`
   - On `rejected`: log a warn with the strategy name + error, track in `explain.failures[strategy] = error.code ?? 'UNKNOWN'`
   - If ALL active strategies are in `rejected` or `skipped` (i.e. `strategyResults.size === 0`) → throw `RetrievalError(RETRIEVAL_ORCHESTRATOR_FAILED)` with context listing each failure/skip
7. **Fuse with RRF:**
   - `fused: FusedResult[] = rrfFuse(strategyResults, config, { limit: oversample })`
8. **Optionally re-rank:**
   - If `noRerank === true` OR `config.retrieval.rerank.enabled === false`:
     - Build a passthrough `RerankedResult[]` from `fused` truncated to `topK` with `rerankScore = score` (same shape the reranker uses for its flag-disabled branch; we cannot import the private helper — inline the mapping)
   - Else: `reranked = await rerank(llmService, query, fused, config, { limit: topK })`
9. **Compute confidence object:**
   - `graphHitCount = strategyResults.get('graph')?.length ?? 0`
   - `confidence = await computeQueryConfidence(pool, config, { graphHitCount })`
10. **Assemble result:**
    - `{ query, strategy, topK, results: reranked, confidence, explain: explainObject }`
    - `explain` always present but only populated when `options.explain === true`; otherwise `explain.counts`/`failures`/`skipped` are populated but per-result score breakdowns are omitted to keep the happy path lean
11. **Return.**

**Logging:**
- `debug`: orchestrator called, with query, strategy, topK, noRerank
- `info`: orchestrator complete, with elapsedMs, hitCounts per strategy, finalCount
- `warn`: per-strategy failure with error code + cause message

### 4.3 Extend `packages/retrieval/src/types.ts`

```typescript
/** Strategy selector for the orchestrator. Maps to `--strategy` CLI flag. */
export type RetrievalStrategyMode = 'vector' | 'fulltext' | 'graph' | 'hybrid';

/** Options for hybridRetrieve. All fields optional; pick up defaults from config. */
export interface HybridRetrieveOptions {
  /** Which strategies to run. Default: `config.retrieval.default_strategy` (usually `hybrid`). */
  strategy?: RetrievalStrategyMode;
  /** Final result count. Default: `config.retrieval.top_k`. */
  topK?: number;
  /** Skip LLM re-ranking even when the feature flag is enabled. */
  noRerank?: boolean;
  /** Populate per-result strategy breakdowns in the explain block. */
  explain?: boolean;
}

/**
 * Confidence object returned alongside results. Reflects how much to trust
 * the results given the current corpus size and graph density.
 *
 * @see docs/functional-spec.md §5.3
 */
export interface QueryConfidence {
  corpus_size: number;
  taxonomy_status: 'not_started' | 'bootstrapping' | 'active' | 'mature';
  corroboration_reliability: 'insufficient' | 'low' | 'moderate' | 'high';
  graph_density: number;
  degraded: boolean;
}

/**
 * Per-strategy diagnostic breakdown. Always present in the result, but
 * per-result scoring details are only populated when `options.explain === true`.
 */
export interface HybridRetrievalExplain {
  /** Hit count per strategy actually executed (skipped/failed strategies omitted). */
  counts: Partial<Record<RetrievalStrategy, number>>;
  /** Strategies that were skipped with reason (e.g. `graph:no_seeds`). */
  skipped: string[];
  /** Strategies that failed with the error code observed (e.g. `graph: RETRIEVAL_QUERY_FAILED`). */
  failures: Partial<Record<RetrievalStrategy, string>>;
  /** Seed entity IDs used by graph strategy. Empty array when graph was skipped. */
  seedEntityIds: string[];
  /** Per-result contributions, only populated when options.explain === true. */
  contributions?: Array<{
    chunkId: string;
    rerankScore: number;
    rrfScore: number;
    strategies: Array<{ strategy: RetrievalStrategy; rank: number; score: number }>;
  }>;
}

/** Final output of hybridRetrieve. */
export interface HybridRetrievalResult {
  query: string;
  strategy: RetrievalStrategyMode;
  topK: number;
  results: RerankedResult[];
  confidence: QueryConfidence;
  explain: HybridRetrievalExplain;
}
```

### 4.4 Extend `packages/retrieval/src/index.ts`

```typescript
export { hybridRetrieve } from './orchestrator.js';
export { extractQueryEntities, computeQueryConfidence } from './query-entities.js';
export type {
  HybridRetrievalExplain,
  HybridRetrievalResult,
  HybridRetrieveOptions,
  QueryConfidence,
  RetrievalStrategyMode,
} from './types.js';
```

### 4.5 Extend `packages/core/src/shared/errors.ts`

Add one new code to `RETRIEVAL_ERROR_CODES`:

```typescript
RETRIEVAL_ORCHESTRATOR_FAILED: 'RETRIEVAL_ORCHESTRATOR_FAILED',
```

No changes to the `RetrievalError` class — the union picks up automatically via `typeof RETRIEVAL_ERROR_CODES`.

### 4.6 New file: `apps/cli/src/commands/query.ts`

Thin Commander wrapper that loads config, creates the registry, calls `hybridRetrieve`, and formats output.

```typescript
import {
  closeAllPools,
  createLogger,
  createServiceRegistry,
  getWorkerPool,
  loadConfig,
} from '@mulder/core';
import { hybridRetrieve, type HybridRetrievalResult, type RetrievalStrategyMode } from '@mulder/retrieval';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface QueryOptions {
  strategy?: string;   // raw string from commander, validated before use
  topK?: string;       // raw string, parsed to int
  noRerank?: boolean;
  explain?: boolean;
  json?: boolean;
}

export function registerQueryCommands(program: Command): void {
  program
    .command('query')
    .description('Hybrid retrieval query against the indexed corpus')
    .argument('<question>', 'Natural-language question')
    .option('--strategy <s>', 'vector | fulltext | graph | hybrid (default: hybrid)')
    .option('--top-k <n>', 'Number of results to return')
    .option('--no-rerank', 'Skip LLM re-ranking')
    .option('--explain', 'Show retrieval strategy breakdown per result')
    .option('--json', 'Output as JSON')
    .action(withErrorHandler(async (question: string, options: QueryOptions) => { /* ... */ }));
}
```

**CLI validation:**
1. `question` is a required positional — Commander enforces this, but also verify non-whitespace. Empty/whitespace → `printError('question must not be empty')`, exit 1.
2. `--strategy` must be one of the four valid modes. Invalid → `printError('invalid --strategy value: ...')`, exit 1.
3. `--top-k`, if provided, must parse to a positive integer. Invalid → exit 1.
4. Config must allow retrieval: if `config.dev_mode !== true` AND no `config.gcp.cloud_sql`, print a clear error (same pattern as `embed.ts:85-95`).

**CLI execution:**
1. Load config via `loadConfig()`.
2. Create logger, registry, and worker pool (`getWorkerPool(config.gcp.cloud_sql)` when present).
3. Call `hybridRetrieve(pool, services.embedding, services.llm, config, question, { strategy, topK, noRerank, explain })`.
4. Format output based on `--json` flag:
   - **JSON mode:** `process.stdout.write(JSON.stringify(result, null, 2) + '\n')`
   - **Text mode:** print a header (`Query: "..."`, `Strategy: hybrid`, `Top K: 10`), then a numbered list of results with rank, rerank score, story id, truncated content (80 chars), plus the confidence summary. When `--explain` is set, also print the contributions block after each result.
5. Exit 0 on success. If `result.results.length === 0`, print `printSuccess('No results.')` — empty is not an error.
6. `finally { await closeAllPools(); }`.

### 4.7 Extend `apps/cli/src/index.ts`

```typescript
import { registerQueryCommands } from './commands/query.js';
// ...
registerQueryCommands(program);
```

### 4.8 Extend `apps/cli/package.json`

Add `@mulder/retrieval` to dependencies:

```json
"@mulder/retrieval": "workspace:*",
```

### 4.9 Extend `apps/cli/tsconfig.json`

Add a project reference to the retrieval package:

```json
"references": [
  { "path": "../../packages/core" },
  { "path": "../../packages/pipeline" },
  { "path": "../../packages/retrieval" }
]
```

### 4.10 Database

No DDL changes. All counts use existing tables (`sources`, `entities`, `entity_edges`).

### 4.11 Config

No schema changes — all relevant knobs already exist:
- `retrieval.default_strategy` (default: `'hybrid'`)
- `retrieval.top_k` (default: 10)
- `retrieval.rerank.enabled` (default: true)
- `retrieval.rerank.candidates` (default: 20)
- `retrieval.strategies.graph.max_hops` (default: 2)
- `retrieval.strategies.graph.supernode_threshold` (default: 100)
- `thresholds.taxonomy_bootstrap` (default: 25)
- `thresholds.corroboration_meaningful` (default: 50)

### 4.12 Implementation phases

**Phase 1 — types + error code:**
- Add `RETRIEVAL_ORCHESTRATOR_FAILED` to `packages/core/src/shared/errors.ts`
- Add `RetrievalStrategyMode`, `HybridRetrieveOptions`, `QueryConfidence`, `HybridRetrievalExplain`, `HybridRetrievalResult` to `packages/retrieval/src/types.ts`
- `pnpm turbo run build` clean

**Phase 2 — query entity extraction + confidence:**
- Create `packages/retrieval/src/query-entities.ts` with `extractQueryEntities` and `computeQueryConfidence`
- Unit-clean build + lint

**Phase 3 — orchestrator:**
- Create `packages/retrieval/src/orchestrator.ts` with `hybridRetrieve`
- Export from barrel `packages/retrieval/src/index.ts`
- `pnpm turbo run build` clean

**Phase 4 — CLI command:**
- Add `@mulder/retrieval` to `apps/cli/package.json`
- Add project reference to `apps/cli/tsconfig.json`
- Create `apps/cli/src/commands/query.ts`
- Register in `apps/cli/src/index.ts`
- `pnpm install` to wire the workspace dep, then `pnpm turbo run build` clean

**Phase 5 — lint + full test suite regression check:**
- `npx biome check .` clean
- `npx vitest run tests/ --reporter=verbose` — existing tests must still pass

## 5. QA Contract

All conditions are testable from black-box boundaries only: CLI subprocess invocation, SQL via `docker exec psql`, and the `@mulder/retrieval` package public entrypoint. Tests use `@mulder/retrieval` only as a library consumer — never reach into `src/`. The LLM service is stubbed via a local test double when calling the library directly; CLI tests rely on dev mode (`dev_mode: true`) so no external calls occur.

### QA-01: Barrel exports are correct

**Given** the `@mulder/retrieval` package entry point
**When** `hybridRetrieve`, `extractQueryEntities`, `computeQueryConfidence`, and the types `HybridRetrievalResult`, `HybridRetrieveOptions`, `QueryConfidence`, `RetrievalStrategyMode`, `HybridRetrievalExplain` are imported by name
**Then** all imports resolve (no `undefined` / module-not-found).

### QA-02: Empty query rejected

**Given** a valid pool, services, and config
**When** `hybridRetrieve(pool, embed, llm, config, '   ')` is called
**Then** throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT`. No strategy is executed. No LLM call is made.

### QA-03: Invalid strategy rejected

**Given** valid pool/services/config and a non-empty query
**When** `hybridRetrieve(..., { strategy: 'fuzzy' as never })` is called
**Then** throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT`.

### QA-04: Invalid topK rejected

**Given** valid inputs
**When** `hybridRetrieve(..., { topK: 0 })` or `{ topK: -5 }` or `{ topK: 1.5 }` is called
**Then** throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT`.

### QA-05: Error code is registered

**Given** `RETRIEVAL_ERROR_CODES` exported from `@mulder/core`
**When** inspected at runtime
**Then** it contains `RETRIEVAL_ORCHESTRATOR_FAILED: 'RETRIEVAL_ORCHESTRATOR_FAILED'`.

### QA-06: hybrid mode runs all three strategies against an indexed corpus

**Given** a corpus with ≥ 3 sources ingested+extracted+segmented+enriched+embedded+graphed (fixture setup via CLI pipeline) and a question whose answer requires content chunks plus at least one known entity name present in the corpus
**When** `mulder query "<question>" --json` is run via CLI
**Then** the JSON output has `strategy === 'hybrid'`, `results` has ≥ 1 entry, each result has a non-empty `content`, a numeric `rerankScore`, and `contributions` listing at least one of `vector | fulltext | graph` as a contributing strategy.

### QA-07: `--strategy vector` skips fulltext and graph

**Given** an indexed corpus and a non-empty query
**When** `mulder query "..." --strategy vector --explain --json` is run
**Then** in the JSON output, `strategy === 'vector'`, `explain.counts` contains only the `vector` key (no `fulltext`, no `graph`), and `explain.seedEntityIds` is `[]`.

### QA-08: `--strategy fulltext` skips vector and graph

**Given** an indexed corpus
**When** `mulder query "..." --strategy fulltext --explain --json` is run
**Then** `explain.counts` contains only the `fulltext` key.

### QA-09: `--strategy graph` uses extracted seed entities only

**Given** an indexed corpus in which at least one entity name appears in the query (e.g., the query contains a known person/place name from the fixture)
**When** `mulder query "...<known name>..." --strategy graph --explain --json` is run
**Then** `explain.counts` contains only the `graph` key, `explain.seedEntityIds.length >= 1`, and `results.length >= 1`.

### QA-10: graph skipped when no seeds match

**Given** an indexed corpus
**When** `mulder query "zzzz absolutely nothing matches" --strategy hybrid --explain --json` is run
**Then** `explain.seedEntityIds === []`, `explain.skipped` includes `'graph:no_seeds'`, `explain.counts` does NOT contain a `graph` key, and `vector` + `fulltext` still return results (i.e., the orchestrator did not crash).

### QA-11: `--no-rerank` bypasses LLM re-rank

**Given** an indexed corpus and a direct library call with a stub `LlmService` that records calls
**When** `hybridRetrieve(..., { noRerank: true })` is called
**Then** the stub's `generateStructured` was NOT invoked and results are returned with `rerankScore === score` (the RRF score passed through).

### QA-12: `--explain` populates contributions

**Given** a hybrid query against an indexed corpus
**When** `mulder query "..." --explain --json` is run
**Then** each entry in `explain.contributions` has a `chunkId` matching a result's `chunkId`, a numeric `rerankScore`, a numeric `rrfScore`, and a non-empty `strategies` array whose entries have `strategy`, `rank`, and `score`.

### QA-13: confidence.corpus_size matches actual source count

**Given** a corpus where exactly N sources have status past `'ingested'` (verified via `SELECT COUNT(*) FROM sources WHERE status != 'ingested'`)
**When** `mulder query "..." --json` is run
**Then** the JSON output's `confidence.corpus_size === N`.

### QA-14: confidence classifies taxonomy_status by threshold

**Given** `config.thresholds.taxonomy_bootstrap = 25`, a corpus of 3 sources
**When** `hybridRetrieve` is called
**Then** `confidence.taxonomy_status === 'bootstrapping'` and `confidence.degraded === true` (corpus below bootstrap threshold).

### QA-15: confidence graph_density is 0.0 when no entities

**Given** an empty `entities` table (truncated fixture)
**When** `hybridRetrieve` is called
**Then** `confidence.graph_density === 0` (no division by zero).

### QA-16: orchestrator fails only when ALL active strategies fail

**Given** a library-level test where the embedding service throws (simulating vector failure) AND the `entities` table is empty so graph is skipped, but fulltext succeeds
**When** `hybridRetrieve` is called with `strategy: 'hybrid'`
**Then** the function returns successfully with `results` populated from fulltext, `explain.failures.vector` is set, `explain.skipped` contains `'graph:no_seeds'`, and NO `RetrievalError` is thrown.

### QA-17: orchestrator raises when every strategy fails/skips

**Given** a library-level test where vector throws AND fulltext throws AND graph has no seeds
**When** `hybridRetrieve` is called with `strategy: 'hybrid'`
**Then** throws `RetrievalError` with code `RETRIEVAL_ORCHESTRATOR_FAILED`, and the error context includes a per-strategy breakdown (`vector: <code>`, `fulltext: <code>`, `graph: 'no_seeds'`).

### QA-18: `extractQueryEntities` deduplicates by entity id

**Given** an entity "Area 51" with both a canonical alias "Area 51" and an alias "area51" in `entity_aliases`
**When** `extractQueryEntities(pool, 'what happened at Area 51 and area51')` is called
**Then** the returned array has exactly one id (the entity for Area 51) — duplicates suppressed.

### QA-19: `extractQueryEntities` empty result is safe

**Given** a query containing no known entity names
**When** `extractQueryEntities(pool, 'a random nonsense string')` is called
**Then** returns `[]` and does not throw.

### QA-20: `computeQueryConfidence` degraded flag reflects graph hit count

**Given** a populated corpus ≥ `taxonomy_bootstrap` threshold but `graphHitCount = 0`
**When** `computeQueryConfidence(pool, config, { graphHitCount: 0 })` is called
**Then** `confidence.degraded === true` (graph zero-hits forces degraded), even though corpus_size is above threshold.

### QA-21: Results are sorted by rerankScore descending when re-rank is active

**Given** a hybrid query with re-ranking enabled (default)
**When** the CLI prints `--json` output
**Then** `results[i].rerankScore >= results[i + 1].rerankScore` for all adjacent pairs, and `results[i].rank === i + 1`.

### QA-22: `topK` truncates the final result list

**Given** a corpus with many matching chunks
**When** `mulder query "..." --top-k 3 --json` is run
**Then** `results.length <= 3`.

## 5b. CLI Test Matrix

All CLI tests run against a populated test database (see `tests/specs/34_embed_step.test.ts` for the fixture-setup pattern). Dev mode + the test PG container are sufficient — no real GCP calls.

### CLI-01: `--help` prints usage with all flags

**Given** a built CLI
**When** `mulder query --help` is run
**Then** exit 0, stdout contains the substrings `query`, `--strategy`, `--top-k`, `--no-rerank`, `--explain`, `--json`.

### CLI-02: Missing `<question>` argument errors

**Given** a built CLI
**When** `mulder query` is run with no positional
**Then** exit != 0, stderr contains `missing required argument` or equivalent Commander error text.

### CLI-03: Empty-string `<question>` errors cleanly

**Given** a built CLI
**When** `mulder query ""` is run
**Then** exit != 0, stderr contains a message that the question must not be empty (no stack trace).

### CLI-04: Invalid `--strategy` value errors cleanly

**Given** a built CLI
**When** `mulder query "test" --strategy bogus` is run
**Then** exit != 0, stderr contains `strategy` and one of `vector | fulltext | graph | hybrid`.

### CLI-05: `--json` output is parseable JSON

**Given** a populated corpus
**When** `mulder query "test" --json` is run
**Then** exit 0 and stdout is valid JSON (`JSON.parse` succeeds). The parsed object has keys: `query`, `strategy`, `topK`, `results`, `confidence`, `explain`.

### CLI-06: Text-mode output renders results

**Given** a populated corpus
**When** `mulder query "test"` is run (no `--json`)
**Then** exit 0, stdout contains the query substring, the word `Results` (header) or equivalent, and at least one rank prefix like `1.` or `[1]`.

### CLI-07: `--explain` text mode prints per-result strategy scores

**Given** a populated corpus
**When** `mulder query "test" --explain` is run
**Then** exit 0, stdout contains the substring `vector` or `fulltext` or `graph` in a context that suggests a per-result breakdown (e.g., followed by a rank or score).

### CLI-08: empty-result query does not crash

**Given** a populated corpus that definitely does not contain the string `xyznonsense12345`
**When** `mulder query "xyznonsense12345" --json` is run
**Then** exit 0, parsed output has `results: []` (or very small), and `confidence.degraded === true`.

### CLI-09 (smoke, optional): `--top-k 1 --strategy vector`

**Given** a populated corpus
**When** `mulder query "test" --top-k 1 --strategy vector --json` is run
**Then** exit 0, parsed `strategy === 'vector'`, `results.length <= 1`.
