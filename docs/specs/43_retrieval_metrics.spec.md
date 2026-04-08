---
spec: 43
title: Retrieval Metrics — Precision@k, Recall@k, F1@k, MRR, nDCG@10
roadmap_step: QA-Gate Phase 3 (D5)
functional_spec: §5 (hybrid retrieval), §15 (quality evaluation)
scope: single
created: 2026-04-09
---

## 1. Objective

Retrospective QA contract for the pure retrieval-metric functions exported from `@mulder/eval`: `hitMatches`, `computeRetrievalMetricsAtK`, `computeMRR`, `computeNDCG10`, `countPrimaryRecall`, and `loadRetrievalGoldenSet`. These functions pin down the mathematical behavior of retrieval quality evaluation without touching the filesystem, database, or retrieval layer. Given an array of expected hits (from a golden set) and an array of actual hits (from a retrieval run), they compute standard IR metrics at various cutoffs.

Matching strategy is content substring (case-insensitive): an actual hit "matches" an expected hit when the expected hit's `contentContains` substring appears in the actual hit's content. This is deliberately loose — generated chunk IDs change between runs, so content-based matching is the only robust option for a fixture-independent golden set.

## 2. Boundaries

### In scope
- Mathematical correctness of Precision@k, Recall@k, F1@k, MRR, and nDCG@10
- Negative-query handling (empty expected hits → monotonic metric semantics)
- Relevance-level semantics: `primary` counts toward recall, `secondary` and `tangential` boost precision but do not penalize recall when missing
- nDCG@10 gain function: primary=3, secondary=2, tangential=1, no match=0
- DCG formula variant: `(2^rel - 1) / log2(rank + 1)` — industry standard
- Golden-set loader (`loadRetrievalGoldenSet`) structure validation and language/type coverage assertions

### Out of scope
- Running actual retrieval (spec 37 vector, spec 38 fulltext, spec 39 graph, spec 42 hybrid)
- Re-ranker behavior (spec 41)
- Golden-set authoring workflow or fixture generation
- End-to-end metric-reporting CLI or dashboards

### Depends on
- `@mulder/eval` package exports `hitMatches`, `computeRetrievalMetricsAtK`, `computeMRR`, `computeNDCG10`, `countPrimaryRecall`, `loadRetrievalGoldenSet`, `EVAL_ERROR_CODES`, `MulderEvalError`
- `eval/golden/retrieval/` contains 12 curated golden files (`q001-*.json` through `q012-*.json`)
- Types `ActualRetrievalHit`, `ExpectedRetrievalHit`, `RetrievalMetricAtK` exported from `@mulder/eval`

## 5. QA Contract

All conditions are testable via direct function calls — no CLI, no database, no network. Each `it()` in `tests/specs/43_retrieval_metrics.test.ts` maps 1:1 to a QA condition below.

### `hitMatches`

#### QA-01: Case-insensitive substring match
**Given** an actual hit with content `"The Phoenix Lights appeared on March 13, 1997"`
**When** `hitMatches` is called with expected substrings `"phoenix lights"`, `"PHOENIX LIGHTS"`, `"March 13, 1997"`
**Then** all three return `true`

#### QA-02: Negative match when substring absent
**Given** an actual hit with content unrelated to the expected substring
**When** `hitMatches` is called
**Then** returns `false`

#### QA-03: Match spans word boundaries
**Given** an actual hit containing the multi-word substring verbatim
**When** `hitMatches` is called
**Then** returns `true` (no tokenizer false-negatives)

### `computeRetrievalMetricsAtK`

#### QA-04: Perfect top-k match
**Given** 3 primary expected hits and 3 actual hits that all match
**When** called with `k=5`
**Then** `precision=1, recall=1, f1=1`

#### QA-05: Zero matches
**Given** 1 primary expected hit and 2 non-matching actual hits
**When** called with `k=5`
**Then** `precision=0, recall=0, f1=0`

#### QA-06: Partial recall
**Given** 2 primary expected hits and 2 actual hits where only 1 matches
**When** called with `k=5`
**Then** `precision=0.5, recall=0.5, f1=0.5`

#### QA-07: Recall counts only primary hits
**Given** 1 primary + 1 secondary + 1 tangential expected, actual contains only the primary
**When** called with `k=5`
**Then** `recall=1` (the sole primary is found), `precision=1` (1 of 1 top-k matches)

#### QA-08: Precision counts any relevance level
**Given** 1 primary + 1 secondary expected, actual matches both
**When** called with `k=5`
**Then** `precision=1` (both top-k hits match something)

#### QA-09: k truncates the actual list
**Given** 3 primary expected hits and 3 actual hits that all match
**When** called with `k=2`
**Then** `precision=1` (both top-2 match), `recall=2/3` (2 of 3 primaries in top-2)

#### QA-10: Negative query + empty actual
**Given** empty expected hits and empty actual hits
**When** called with any `k>0`
**Then** `precision=1, recall=1, f1=1` — a negative query correctly returning nothing is a perfect result

#### QA-11: Negative query + non-empty actual
**Given** empty expected hits and ≥1 actual hit
**When** called with any `k>0`
**Then** `precision=0, recall=0, f1=0` — returning anything for a negative query is a failure

#### QA-12: Invalid k rejected with typed error
**Given** any expected/actual arrays
**When** called with `k=0`, `k=-1`, or `k=1.5`
**Then** throws `MulderEvalError` with code `EVAL_ERROR_CODES.INVALID_ARGUMENT` and a message containing `"positive integer"`

### `computeMRR`

#### QA-13: First primary hit at rank 1
**Given** 1 primary expected and actual with the match at position 0
**When** `computeMRR` is called
**Then** returns `1.0`

#### QA-14: First primary hit at rank 3
**Given** 1 primary expected and actual with the match at position 2
**When** `computeMRR` is called
**Then** returns `1/3` (≈ 0.333)

#### QA-15: No primary hit in actual
**Given** 1 primary expected and actual with no matches
**When** `computeMRR` is called
**Then** returns `0`

#### QA-16: Secondary/tangential hits do not contribute to MRR
**Given** only secondary and tangential expected hits, actual contains them
**When** `computeMRR` is called
**Then** returns `0` — MRR is primary-only

#### QA-17: Negative query + empty actual → MRR = 1
**Given** empty expected and empty actual
**When** `computeMRR` is called
**Then** returns `1` — the query was satisfied by returning nothing

#### QA-18: Negative query + non-empty actual → MRR = 0
**Given** empty expected and ≥1 actual hit
**When** `computeMRR` is called
**Then** returns `0`

### `computeNDCG10`

#### QA-19: Ideal ordering → nDCG = 1
**Given** expected hits sorted primary > secondary > tangential, actual in the same order
**When** `computeNDCG10` is called
**Then** returns `1.0` (within floating-point tolerance)

#### QA-20: Reversed ordering → nDCG < 1
**Given** expected hits sorted primary > secondary > tangential, actual in reverse order
**When** `computeNDCG10` is called
**Then** returns a value strictly between 0 and 1

#### QA-21: Empty actual → nDCG = 0
**Given** at least one primary expected and empty actual
**When** `computeNDCG10` is called
**Then** returns `0`

#### QA-22: Negative query (no expected) → nDCG = 0
**Given** empty expected (with or without any actual)
**When** `computeNDCG10` is called
**Then** returns `0` — ideal DCG is 0 for a negative query, so nDCG degenerates to 0 by contract

#### QA-23: nDCG is sensitive to rank position
**Given** the same two primary hits at positions {1, 2} vs. {3, 4}
**When** `computeNDCG10` is called on both
**Then** the first score is strictly greater than the second

### `countPrimaryRecall`

#### QA-24: Counts primary hits anywhere in actual
**Given** 2 primary + 1 secondary expected, actual contains both primaries (at any rank) and the secondary
**When** `countPrimaryRecall` is called
**Then** returns `2`

#### QA-25: No primary expected → returns 0
**Given** only secondary and tangential expected hits, actual contains them
**When** `countPrimaryRecall` is called
**Then** returns `0`

### `loadRetrievalGoldenSet`

#### QA-26: Loads all 12 QA-gate golden queries
**Given** the `eval/golden/retrieval/` directory
**When** `loadRetrievalGoldenSet` is called
**Then** returns exactly 12 entries, all `queryId` values unique, and the list is sorted by `queryId`

#### QA-27: All golden files validate structurally
**Given** the 12 loaded golden entries
**When** each is inspected
**Then** every entry has a non-empty `queryId`, non-empty `queryText`, `language` in `['de', 'en']`, `queryType` in `['factual', 'exploratory', 'relational', 'negative']`, and the invariant that negative queries have empty `expectedHits` while all others have at least one

#### QA-28: Includes at least one negative query per language
**Given** the loaded golden set
**When** filtering by `queryType === 'negative'`
**Then** at least 2 negative queries exist and the set of their languages contains both `'en'` and `'de'`

## 5b. CLI Test Matrix

N/A — this spec covers pure library functions. There is no CLI surface; `@mulder/eval` is consumed by the eval runner (`packages/eval/src/retrieval-runner.ts`) and by test code.

## Pass / Fail

- Pass: all 28 `it()` blocks in `tests/specs/43_retrieval_metrics.test.ts` assert green
- Fail: any assertion fails, or any of the exported functions breaks its contract above

## Out of scope

Retrieval accuracy of the underlying strategies (vector/fulltext/graph) and their composition into ranked results is covered by specs 37, 38, 39, and 42. This spec covers only the metric functions that consume retrieval output and produce quality numbers.
