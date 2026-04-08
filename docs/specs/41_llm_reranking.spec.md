---
spec: 41
title: LLM Re-ranking — Gemini Flash
roadmap_step: M4-E5
functional_spec: §5.2, §4.8
scope: single
created: 2026-04-08
issue: https://github.com/mulkatz/mulder/issues/87
---

## 1. Objective

Implement the re-ranking layer that takes fused RRF results (from E4) and asks Gemini Flash to re-score them against the original query for final relevance ordering. This is the second half of the §5.2 fusion+re-ranking pipeline. The function is a library-only concern — wiring into a user-facing `mulder query` command ships in E6 (hybrid retrieval orchestrator).

## 2. Boundaries

### In scope
- New `rerank()` function in `packages/retrieval/src/reranker.ts`
- Uses existing `rerank.jinja2` prompt template (already contains query + candidate passages placeholders)
- Calls `LlmService.generateStructured` with a JSON Schema for `{ rankings: Array<{ passage_id, relevance_score }> }`
- Truncates input to `config.retrieval.rerank.candidates` (default: 20) before sending to Gemini
- Returns top `limit` results (default: `config.retrieval.top_k`)
- New `RerankedResult` type extending `FusedResult` with `rerankScore` and updated `rank`
- Feature flag via `config.retrieval.rerank.enabled` — when false, the function is a passthrough that returns the input truncated/ranked as-is
- Dev-mode fixture branch in `DevLlmService.generateStructured` for the rerank schema (returns passthrough-style rankings so dev mode does not explode)
- New error codes: `RETRIEVAL_RERANK_FAILED`, `RETRIEVAL_RERANK_INVALID_RESPONSE`
- Barrel exports

### Out of scope
- E6 hybrid retrieval orchestrator / `mulder query` CLI
- Running vector/fulltext/graph + fusion — re-rank receives `FusedResult[]` as input
- Changes to `config.retrieval.rerank.*` schema (already exists: `enabled`, `model`, `candidates`)
- Dynamic model selection / per-call model override (uses `config.retrieval.rerank.model`, but `LlmService.generateStructured` does not expose a `model` parameter — the model is bound when the Vertex client is constructed; re-ranking therefore uses whatever model the current `LlmService` instance is configured for in production, and the config field documents the expected default)
- Web-grounded re-ranking, multi-query fusion, learning-to-rank models

### Depends on
- `@mulder/retrieval` types: `FusedResult` (E4, 🟢)
- `@mulder/core` services: `LlmService`, `MulderConfig`
- `@mulder/core` prompts: `renderPrompt` + `rerank.jinja2` template + `en.json`/`de.json` `rerank.*` i18n keys (all exist)
- `@mulder/core` errors: `RetrievalError`, `RETRIEVAL_ERROR_CODES`

## 3. Dependencies

### Requires (must exist before implementation)
- `packages/retrieval/src/types.ts` — `FusedResult` type (E4, present)
- `packages/retrieval/src/fusion.ts` — `rrfFuse` (E4, present)
- `packages/core/src/shared/services.ts` — `LlmService`, `StructuredGenerateOptions`
- `packages/core/src/prompts/templates/rerank.jinja2` (present; already accepts `query` + `passages`)
- `packages/core/src/prompts/i18n/{en,de}.json` — `rerank.system_role`, `rerank.task_description`, `common.json_instruction` (present)
- `packages/core/src/shared/errors.ts` — `RetrievalError`, `RETRIEVAL_ERROR_CODES`

### Required by (will consume this)
- E6: Hybrid retrieval orchestrator (calls `rerank` after `rrfFuse`)

## 4. Blueprint

### 4.1 Extend `packages/retrieval/src/types.ts`

Add the reranked-result shape and options type. `RerankedResult` is an extension of `FusedResult` — the fused contributions are preserved for debugging/provenance. The new `rank` field is the 1-based position after re-ranking; the pre-rerank RRF rank is preserved inside each `contributions` entry and via the untouched `score` (the RRF fused score). `rerankScore` is the Gemini relevance score (0.0–1.0).

```typescript
/**
 * A result that has been re-ranked by Gemini Flash after RRF fusion.
 *
 * - `score` is the original RRF score (preserved for debugging).
 * - `rerankScore` is the Gemini relevance score (0.0–1.0).
 * - `rank` is the 1-based position in the re-ranked list.
 * - `contributions` is carried over from the upstream `FusedResult`.
 *
 * @see docs/specs/41_llm_reranking.spec.md §4.2
 * @see docs/functional-spec.md §5.2
 */
export interface RerankedResult {
  chunkId: string;
  storyId: string;
  content: string;
  /** Original RRF fused score, preserved for debugging. */
  score: number;
  /** Gemini relevance score (0.0 to 1.0). */
  rerankScore: number;
  /** 1-based rank in the re-ranked result list. */
  rank: number;
  /** Strategies that contributed this chunk (carried over from RRF fusion). */
  contributions: StrategyContribution[];
  /** Strategy-specific metadata (carried over from RRF fusion). */
  metadata?: Record<string, unknown>;
}

/** Options for the rerank function. */
export interface RerankOptions {
  /**
   * Maximum number of candidates to send to Gemini. Defaults to
   * `config.retrieval.rerank.candidates` (default: 20).
   * Input results are truncated (by RRF rank) to this count before prompting.
   */
  candidates?: number;
  /**
   * Maximum number of results to return after re-ranking. Defaults to
   * `config.retrieval.top_k` (default: 10).
   */
  limit?: number;
  /**
   * Override the template locale. Defaults to 'en'. Must be a locale that
   * exists in `packages/core/src/prompts/i18n/`.
   */
  locale?: string;
}
```

### 4.2 New file: `packages/retrieval/src/reranker.ts`

Single public export: `rerank()`. The function is pure except for the LLM call.

```typescript
export async function rerank(
  llmService: LlmService,
  query: string,
  fusedResults: FusedResult[],
  config: MulderConfig,
  options?: RerankOptions,
): Promise<RerankedResult[]>
```

**Algorithm:**

1. **Input validation:** `query` must be a non-empty trimmed string → else `RETRIEVAL_INVALID_INPUT`. `fusedResults` must be an array (empty allowed).
2. **Empty passthrough:** If `fusedResults.length === 0`, return `[]` without calling the LLM.
3. **Feature flag bypass:** If `config.retrieval.rerank.enabled === false`:
   - Truncate `fusedResults` to `limit`.
   - Map each to a `RerankedResult` with `rerankScore = score` (RRF score reused) and `rank = index + 1`.
   - Return. No LLM call.
4. **Resolve params:** `candidates = options.candidates ?? config.retrieval.rerank.candidates`, `limit = options.limit ?? config.retrieval.top_k`, `locale = options.locale ?? 'en'`. Validate `candidates > 0` and `limit > 0` → else `RETRIEVAL_INVALID_INPUT`.
5. **Truncate input:** Take the first `candidates` entries from `fusedResults` (already sorted by RRF rank; the fusion step guarantees rank is contiguous 1..N).
6. **Build passages block:** Render each candidate as `"[passage_id: <chunkId>]\n<content>\n"`. Join with blank lines. Passage IDs are the `chunkId` values — unique per fused result.
7. **Render prompt:** Call `renderPrompt('rerank', { locale, query, passages })`. The template already pulls `i18n.rerank.system_role`, `i18n.rerank.task_description`, and `i18n.common.json_instruction`.
8. **Call LLM:** `llmService.generateStructured<RerankResponse>({ prompt, schema: RERANK_JSON_SCHEMA })`.
9. **Validate response:**
   - Response must have a `rankings` array → else `RETRIEVAL_RERANK_INVALID_RESPONSE`.
   - Each entry must have a string `passage_id` and a `relevance_score` in `[0.0, 1.0]`.
   - Unknown `passage_id` values (not in the input) are ignored with a warn log. Missing passages are assigned a `rerankScore` equal to the minimum Gemini-returned score minus a small epsilon so they sort below all scored results (but above nothing).
   - On LLM call failure (any throw), wrap in `RetrievalError` with code `RETRIEVAL_RERANK_FAILED`.
10. **Sort + truncate:** Sort descending by `rerankScore` (break ties by original `score`, i.e. RRF score), truncate to `limit`.
11. **Assign 1-based ranks** and return.

**Error handling:**
- Empty query → `RetrievalError` code `RETRIEVAL_INVALID_INPUT`
- Invalid `candidates`/`limit` → `RetrievalError` code `RETRIEVAL_INVALID_INPUT`
- LLM call throws → wrap cause → `RetrievalError` code `RETRIEVAL_RERANK_FAILED`
- LLM returns malformed JSON (missing `rankings`, wrong shape, score out of range) → `RetrievalError` code `RETRIEVAL_RERANK_INVALID_RESPONSE`

**Logging (pino structured):**
- `debug`: `"rerank called"` with `{ query, inputCount, candidates, limit, enabled }`
- `debug`: `"rerank bypassed (feature flag)"` on flag-disabled path
- `debug`: `"rerank complete"` with `{ inputCount, candidates, returned, elapsedMs }`
- `warn`: `"rerank: unknown passage_id in response"` per unknown id

### 4.3 JSON Schema for structured output

Inside `reranker.ts`, declare the JSON Schema the LLM must conform to:

```typescript
const RERANK_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          passage_id: { type: 'string' },
          relevance_score: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['passage_id', 'relevance_score'],
      },
    },
  },
  required: ['rankings'],
};

interface RerankResponse {
  rankings: Array<{ passage_id: string; relevance_score: number }>;
}
```

### 4.4 Extend `packages/core/src/shared/errors.ts`

Add two new codes to `RETRIEVAL_ERROR_CODES`:

```typescript
RETRIEVAL_RERANK_FAILED: 'RETRIEVAL_RERANK_FAILED',
RETRIEVAL_RERANK_INVALID_RESPONSE: 'RETRIEVAL_RERANK_INVALID_RESPONSE',
```

No changes to `RetrievalError` class or the code union — those pick up the new entries automatically via `typeof RETRIEVAL_ERROR_CODES`.

### 4.5 Extend `packages/core/src/shared/services.dev.ts`

Add a detection branch in `DevLlmService.generateStructured` for the rerank schema (detected by the presence of a `rankings` property with a nested `passage_id` + `relevance_score` shape). The dev implementation returns the passages in order with linearly decreasing fake scores so existing tests that run in dev mode do not error.

Detection: `hasProperty('rankings')` — following the existing convention in `DevLlmService`. The fixture returns:

```typescript
{
  rankings: [], // dev mode cannot inspect prompt text to extract passage IDs
}
```

Empty is fine — the reranker contract specifies unknown/missing passages get a sub-floor score, so with zero rankings all inputs receive the same fallback score, ordering falls through to the RRF tiebreaker, and dev-mode callers get the top-`limit` input in RRF order (i.e. effectively passthrough behavior, matching the `enabled: false` branch). This is intentional: dev mode should exercise the code path without requiring fixture inspection of the passage IDs.

### 4.6 Extend `packages/retrieval/src/index.ts`

```typescript
export { rerank } from './reranker.js';
export type { RerankedResult, RerankOptions } from './types.js';
```

### 4.7 Config

No config schema changes. All required fields already exist:
- `config.retrieval.rerank.enabled` (boolean, default `true`)
- `config.retrieval.rerank.model` (string, default `"gemini-2.5-flash"`) — documented but not consumed at call time (see Out of Scope)
- `config.retrieval.rerank.candidates` (int, default `20`)
- `config.retrieval.top_k` (int, default `10`)

### 4.8 Database

No database changes.

### 4.9 Implementation phases

**Phase 1: Error codes + types**
- Add `RETRIEVAL_RERANK_FAILED` and `RETRIEVAL_RERANK_INVALID_RESPONSE` to `RETRIEVAL_ERROR_CODES`
- Add `RerankedResult` and `RerankOptions` to `packages/retrieval/src/types.ts`

**Phase 2: Dev-mode LLM fixture branch**
- Extend `DevLlmService.generateStructured` in `packages/core/src/shared/services.dev.ts` with a rerank detection branch

**Phase 3: Core reranker**
- Create `packages/retrieval/src/reranker.ts` with `rerank()`
- Update `packages/retrieval/src/index.ts` barrel exports

**Phase 4: Build + lint + full test suite**
- `pnpm turbo run build`
- `npx biome check .`
- `npx vitest run tests/ --reporter=verbose` (regression check)

## 5. QA Contract

All conditions are testable via direct function calls with a stubbed `LlmService`. No CLI, no HTTP, no database, no network.

### QA-01: Feature flag disabled is passthrough
**Given** `config.retrieval.rerank.enabled = false` and 15 fused results  
**When** `rerank()` is called with `limit = 10`  
**Then** returns the first 10 fused results as `RerankedResult[]`, `rerankScore` equals the original RRF `score` for each, `rank` is 1..10, and `LlmService.generateStructured` is never called.

### QA-02: Empty input returns empty without LLM call
**Given** an empty `fusedResults` array and `enabled = true`  
**When** `rerank()` is called  
**Then** returns `[]` and `LlmService.generateStructured` is never called.

### QA-03: Empty query rejected
**Given** `query = ""` (or only whitespace), non-empty fused results  
**When** `rerank()` is called  
**Then** throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT`; the LLM is never called.

### QA-04: Re-ranking reorders by Gemini scores
**Given** three fused results `A` (RRF rank 1), `B` (rank 2), `C` (rank 3), and the stub LLM returns `rankings: [{passage_id: 'C', 0.9}, {passage_id: 'A', 0.5}, {passage_id: 'B', 0.1}]`  
**When** `rerank()` is called with `limit = 3`  
**Then** the returned order is `[C, A, B]`, each `rerankScore` matches the stub's return, each `rank` is 1..3, and the original RRF `score` values are preserved in each `score` field.

### QA-05: Candidates limit truncates input to LLM
**Given** 25 fused results and `config.retrieval.rerank.candidates = 10`  
**When** `rerank()` is called  
**Then** the prompt passed to `generateStructured` contains exactly 10 passage blocks (the top 10 by RRF rank), and passages 11–25 are not mentioned in the prompt.

### QA-06: Output limit enforcement
**Given** 20 fused results, LLM returns scores for all 20, `limit = 5`  
**When** `rerank()` is called  
**Then** returns exactly 5 results — the top 5 by `rerankScore`.

### QA-07: Unknown passage_id in response is ignored
**Given** 3 fused results `[A, B, C]`, LLM returns `rankings: [{passage_id: 'ZZZ', 0.9}, {passage_id: 'A', 0.6}]`  
**When** `rerank()` is called  
**Then** the `ZZZ` ranking is discarded, `A` gets `rerankScore = 0.6`, `B` and `C` get a fallback score strictly less than 0.6, and the function does not throw. Final result is length 3.

### QA-08: LLM failure wraps in RetrievalError
**Given** the stub `LlmService.generateStructured` throws `new Error("vertex ai 503")`  
**When** `rerank()` is called with non-empty input  
**Then** throws `RetrievalError` with code `RETRIEVAL_RERANK_FAILED` and the original error is preserved as the `cause`.

### QA-09: Malformed LLM response rejected
**Given** the stub returns `{ not_rankings: [] }` (missing `rankings` key)  
**When** `rerank()` is called  
**Then** throws `RetrievalError` with code `RETRIEVAL_RERANK_INVALID_RESPONSE`.

### QA-10: Relevance score out of range rejected
**Given** the stub returns `rankings: [{passage_id: 'A', relevance_score: 1.5}]`  
**When** `rerank()` is called  
**Then** throws `RetrievalError` with code `RETRIEVAL_RERANK_INVALID_RESPONSE`.

### QA-11: FusedResult provenance is preserved
**Given** a fused result whose `contributions` array has two strategies (vector, fulltext)  
**When** `rerank()` is called and the result is returned  
**Then** the corresponding `RerankedResult.contributions` array is deeply equal to the input — re-ranking does not mutate contribution provenance.

### QA-12: Rank is 1-based and contiguous in output
**Given** any non-empty re-rank result  
**When** examining the returned `RerankedResult[]`  
**Then** ranks are `1, 2, 3, ..., N` with no gaps and no duplicates.

### QA-13: Prompt contains the query text verbatim
**Given** `query = "who authored the report"` and non-empty fused results  
**When** `rerank()` is called  
**Then** the `prompt` field passed to `generateStructured` contains the substring `"who authored the report"`.

### QA-14: Rerank error codes are registered
**Given** the `RETRIEVAL_ERROR_CODES` export from `@mulder/core`  
**When** inspected at runtime  
**Then** it contains `RETRIEVAL_RERANK_FAILED: 'RETRIEVAL_RERANK_FAILED'` and `RETRIEVAL_RERANK_INVALID_RESPONSE: 'RETRIEVAL_RERANK_INVALID_RESPONSE'`.

### QA-15: Barrel re-exports rerank and its types
**Given** the `@mulder/retrieval` package entry point  
**When** imported in a test file  
**Then** `rerank`, `RerankedResult`, and `RerankOptions` are available as named exports.

## 5b. CLI Test Matrix

N/A — this step has no CLI surface. Re-ranking is a library function consumed by E6.
