---
spec: 40
title: RRF Fusion — Configurable Weights
roadmap_step: M4-E4
functional_spec: §5.2
scope: single
created: 2026-04-08
issue: https://github.com/mulkatz/mulder/issues/85
---

## 1. Objective

Implement Reciprocal Rank Fusion (RRF) that merges results from the three retrieval strategies (vector, fulltext, graph) into a single deduplicated, ranked list. Weights are configurable per strategy via `mulder.config.yaml`. This is the first half of the §5.2 fusion+re-ranking pipeline — the re-ranking step (Gemini Flash) ships in E5.

## 2. Boundaries

### In scope
- RRF scoring algorithm: `Σ (weight_i / (k + rank_i))` with k=60
- Configurable per-strategy weights from config (`retrieval.strategies.{vector,fulltext,graph}.weight`)
- Cross-strategy deduplication by `chunkId`
- Accept results from any combination of strategies (1, 2, or 3)
- Return fused results sorted by RRF score descending
- New `FusedResult` type extending `RetrievalResult` with provenance tracking
- New error codes for fusion-specific failures

### Out of scope
- Gemini re-ranking (E5)
- Hybrid retrieval orchestrator / `mulder query` CLI (E6)
- Running the three strategies — fusion receives their outputs
- Strategy selection logic (which strategies to run)

### Depends on
- `@mulder/retrieval` types: `RetrievalResult`, `RetrievalStrategy` (E1-E3, all 🟢)
- Config schema: `retrieval.strategies.{vector,fulltext,graph}.weight` (exists)
- Error infrastructure: `RetrievalError`, `RETRIEVAL_ERROR_CODES` (exists)

## 3. Dependencies

### Requires (must exist before implementation)
- `packages/retrieval/src/types.ts` — `RetrievalResult`, `RetrievalStrategy`
- `packages/core/src/shared/errors.ts` — `RetrievalError`, `RETRIEVAL_ERROR_CODES`
- `packages/core/src/config/schema.ts` — strategy weight fields

### Required by (will consume this)
- E5: LLM re-ranking (receives fused results as input)
- E6: Hybrid retrieval orchestrator (calls fusion after running strategies)

## 4. Blueprint

### 4.1 New types (`packages/retrieval/src/types.ts` — extend)

```typescript
/**
 * A result that has been through RRF fusion. Extends `RetrievalResult` with
 * provenance tracking: which strategies contributed this chunk and their
 * individual ranks/scores.
 */
export interface FusedResult {
  chunkId: string;
  storyId: string;
  content: string;
  /** RRF score: Σ (weight_i / (k + rank_i)) across contributing strategies. */
  score: number;
  /** 1-based rank in the fused result list. */
  rank: number;
  /** Strategies that contributed this chunk, with their individual rank and score. */
  contributions: StrategyContribution[];
  /** Strategy-specific metadata merged from all contributing results. */
  metadata?: Record<string, unknown>;
}

export interface StrategyContribution {
  strategy: RetrievalStrategy;
  /** 1-based rank within this strategy's result list. */
  rank: number;
  /** Strategy-native score (cosine sim, ts_rank, path confidence). */
  score: number;
}

/** Options for the RRF fusion function. */
export interface FusionOptions {
  /** RRF constant k. Default: 60. */
  k?: number;
  /** Maximum number of fused results to return. Default: config `retrieval.top_k`. */
  limit?: number;
  /** Per-strategy weights. Default: from config. */
  weights?: Partial<Record<RetrievalStrategy, number>>;
}
```

### 4.2 New file: `packages/retrieval/src/fusion.ts`

Single exported function:

```typescript
export function rrfFuse(
  strategyResults: Map<RetrievalStrategy, RetrievalResult[]>,
  config: MulderConfig,
  options?: FusionOptions,
): FusedResult[]
```

**Algorithm:**
1. Resolve weights from `options.weights` || config (`retrieval.strategies.{s}.weight`).
2. Resolve k from `options.k` || 60.
3. Resolve limit from `options.limit` || `config.retrieval.top_k`.
4. For each strategy's results, compute per-result RRF contribution: `weight / (k + rank)`.
5. Group by `chunkId`. For duplicates (same chunk from multiple strategies), sum RRF scores and track contributions.
6. Sort descending by fused score. Assign 1-based `rank`.
7. Truncate to `limit`.
8. Return `FusedResult[]`.

**Edge cases:**
- Empty `strategyResults` map → return `[]` (not an error — sparse graph degradation)
- All strategies return empty → return `[]`
- Single strategy provided → still apply RRF formula (becomes single-strategy passthrough with weight normalization)
- Weight of 0 for a strategy → skip its results entirely
- Duplicate `chunkId` within the same strategy → use first occurrence only (defensive — strategies shouldn't return dupes)

**Error handling:**
- Negative weights → `RETRIEVAL_FUSION_INVALID_WEIGHTS`
- k <= 0 → `RETRIEVAL_FUSION_INVALID_K`

### 4.3 New error codes (`packages/core/src/shared/errors.ts` — extend)

Add to `RETRIEVAL_ERROR_CODES`:

```typescript
RETRIEVAL_FUSION_INVALID_WEIGHTS: 'RETRIEVAL_FUSION_INVALID_WEIGHTS',
RETRIEVAL_FUSION_INVALID_K: 'RETRIEVAL_FUSION_INVALID_K',
```

### 4.4 Barrel export (`packages/retrieval/src/index.ts` — extend)

```typescript
export { rrfFuse } from './fusion.js';
export type { FusedResult, FusionOptions, StrategyContribution } from './types.js';
```

### 4.5 Implementation phases

**Phase 1: Types + error codes**
- Add `FusedResult`, `StrategyContribution`, `FusionOptions` to `types.ts`
- Add fusion error codes to `errors.ts`

**Phase 2: Core fusion logic**
- Create `fusion.ts` with `rrfFuse`
- Update barrel export in `index.ts`

### 4.6 Config

No config changes needed — `retrieval.strategies.{vector,fulltext,graph}.weight` and `retrieval.top_k` already exist. The `k` constant (60) is a function-level default, not a config field.

### 4.7 Database

No database changes.

## 5. QA Contract

All conditions are testable via direct function calls — no CLI, no HTTP, no database.

### QA-01: Single-strategy passthrough
**Given** vector results with 5 items and default weights  
**When** `rrfFuse` is called with only vector results  
**Then** returns 5 results, each with RRF score = `vector_weight / (60 + rank)`, sorted descending by score

### QA-02: Multi-strategy deduplication
**Given** vector returns chunks [A, B, C] and fulltext returns chunks [B, C, D]  
**When** `rrfFuse` is called  
**Then** returns 4 unique chunks [B, C, A, D] (B and C have highest scores due to double contribution), no duplicate chunkIds

### QA-03: Weighted scoring
**Given** vector (weight=0.5) returns [A rank 1] and fulltext (weight=0.3) returns [B rank 1]  
**When** `rrfFuse` is called with k=60  
**Then** A's score = 0.5/(60+1) ≈ 0.00820, B's score = 0.3/(60+1) ≈ 0.00492, A ranks higher

### QA-04: Three-strategy fusion with shared chunk
**Given** all three strategies return chunk X at different ranks  
**When** `rrfFuse` is called  
**Then** chunk X's score = Σ (weight_i / (60 + rank_i)) across all three, contributions array has 3 entries

### QA-05: Zero-weight strategy exclusion
**Given** graph weight is 0, vector and fulltext have non-zero weights  
**When** `rrfFuse` is called with graph results  
**Then** graph results are ignored, fused list contains only vector and fulltext contributions

### QA-06: Empty input returns empty
**Given** empty strategyResults map  
**When** `rrfFuse` is called  
**Then** returns `[]` without error

### QA-07: Limit enforcement
**Given** strategies return 30 unique chunks total  
**When** `rrfFuse` is called with limit=10  
**Then** returns exactly 10 results

### QA-08: Custom k parameter
**Given** results with known ranks  
**When** `rrfFuse` is called with k=1  
**Then** scores use k=1 instead of 60 (verifiable by exact score comparison)

### QA-09: Rank assignment is 1-based and contiguous
**Given** any non-empty fusion result  
**When** examining the returned `FusedResult[]`  
**Then** ranks are 1, 2, 3, ..., N with no gaps

### QA-10: Invalid weights rejected
**Given** a negative weight value  
**When** `rrfFuse` is called  
**Then** throws `RetrievalError` with code `RETRIEVAL_FUSION_INVALID_WEIGHTS`

### QA-11: Invalid k rejected
**Given** k=0 or k=-1  
**When** `rrfFuse` is called  
**Then** throws `RetrievalError` with code `RETRIEVAL_FUSION_INVALID_K`

### QA-12: Contributions track provenance
**Given** chunk B appears in vector (rank 2) and fulltext (rank 1)  
**When** `rrfFuse` is called  
**Then** chunk B's `contributions` array has two entries with correct strategy, rank, and score for each

## 5b. CLI Test Matrix

N/A — this step has no CLI surface. Fusion is a library function consumed by E6.
