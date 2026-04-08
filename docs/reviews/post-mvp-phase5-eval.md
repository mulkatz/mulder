---
phase: 5
title: "Post-MVP Quality Evaluation"
scope: extraction, segmentation, entity eval runners against fixture-based golden sets + baseline comparison
date: 2026-04-08
verdict: PASS_WITH_DEFERRAL
---

# Post-MVP QA Gate — Phase 5: Quality Evaluation

## Executive Summary

Ran all three existing evaluation runners (extraction, segmentation, entity) against the
fixture-based golden sets and diffed the results against the checked-in `eval/metrics/baseline.json`
(established 2026-04-02 / 2026-04-03).

**Result: zero regressions.** Every summary metric is bit-identical to the baseline, confirming
that (a) Phase 3 additions to `@mulder/eval` did not break the existing runners, and
(b) no fixture drift has crept into the corpus since the baseline was established six days ago.

**Retrieval evaluation is deferred to Phase 4.** Running a fixture-seeded retrieval baseline
against the fake embedding service would produce all-tied scores (FakeEmbeddingService returns
constant 768-zero vectors in the test harness), which is not a meaningful signal. The first
retrieval baseline will be generated from the Phase 4 GCP smoketest using real
`text-embedding-004` outputs.

All four retrieval metric functions (Precision@k, Recall@k, MRR, nDCG@10) are independently
validated by 28 unit tests in `tests/specs/43_retrieval_metrics.test.ts` — the infrastructure
is green, only the real-data baseline is pending.

**Verdict:** PASS_WITH_DEFERRAL — three of four evals complete, the fourth is correctly waiting
for Phase 4.

---

## 1. Extraction evaluation

**Golden set:** `eval/golden/extraction/` — 5 annotated pages across 5 fixture documents
(`native-text-sample`, `scanned-sample`, `mixed-language-sample`, `multi-column-sample`,
`table-layout-sample`), covering all three difficulty levels.

**Runner:** `runExtractionEval(goldenDir, fixtures/extracted)` from `@mulder/eval`.

**Summary (current vs baseline):**

| Metric | Current | Baseline | Delta |
|--------|---------|----------|-------|
| `totalPages` | 5 | 5 | 0 |
| `avgCer`     | 0.003544 | 0.003544 | 0.000000 |
| `avgWer`     | 0.013982 | 0.013982 | 0.000000 |
| `maxCer`     | 0.007233 | 0.007233 | 0.000000 |
| `maxWer`     | 0.028571 | 0.028571 | 0.000000 |

Per-difficulty breakdown unchanged: simple / moderate / complex all bit-identical.

**Verdict:** ✅ No regression.

---

## 2. Segmentation evaluation

**Golden set:** `eval/golden/segmentation/` — 3 annotated documents
(`magazine-issue-1`, `mixed-content-issue`, `single-story-report`).

**Runner:** `runSegmentationEval(goldenDir, fixtures/segments)`.

**Summary (current vs baseline):**

| Metric | Current | Baseline | Delta |
|--------|---------|----------|-------|
| `totalDocuments`           | 3        | 3        | 0 |
| `avgBoundaryAccuracy`      | 0.944444 | 0.944444 | 0.000000 |
| `segmentCountExactRatio`   | 1.000000 | 1.000000 | 0.000000 |

All per-difficulty breakdowns unchanged.

**Verdict:** ✅ No regression.

---

## 3. Entity evaluation

**Golden set:** `eval/golden/entities/` — 5 annotated stories
(`editorial-article`, `investigation-article`, `multi-entity-article`, `sighting-report-article`,
`cross-lingual-article`).

**Runner:** `runEntityEval(goldenDir, fixtures/entities)`.

**Overall summary (current vs baseline):**

| Metric | Current | Baseline | Delta |
|--------|---------|----------|-------|
| `totalSegments`            | 5        | 5        | 0 |
| `overall.avgPrecision`     | 0.905556 | 0.905556 | 0.000000 |
| `overall.avgRecall`        | 0.886111 | 0.886111 | 0.000000 |
| `overall.avgF1`            | 0.895261 | 0.895261 | 0.000000 |
| `relationships.avgF1`      | 0.966667 | 0.966667 | 0.000000 |

**Per-type breakdown (current run):**

| Type         | Precision | Recall | F1    | Count |
|--------------|-----------|--------|-------|-------|
| person       | 0.9500    | 0.9333 | 0.9314 | 5 |
| event        | 0.9167    | 1.0000 | 0.9500 | 4 |
| location     | 0.8333    | 0.9333 | 0.8667 | 5 |
| organization | 1.0000    | 0.8833 | 0.9314 | 5 |
| **document** | **0.0000** | **0.0000** | **0.0000** | 1 |

**Note on the `document` type:** F1 = 0 across the board, identical to baseline. This is a
pre-existing known issue — the cross-lingual-article golden annotation expects a `document`
entity type that the enrich prompt does not currently extract. Not a Phase 5 regression,
but worth carrying into Phase 7 triage as a latent quality gap against the published
ontology. Tracked as **P5-EVAL-DOCUMENT-TYPE-01** below.

**Verdict:** ✅ No regression vs baseline; one pre-existing gap noted.

---

## 4. Retrieval evaluation — DEFERRED TO PHASE 4

### 4.1 Why deferred

The hybrid retrieval pipeline depends on three inputs that are only meaningful when the
upstream embedding service is real:

1. **Vector search** uses `text-embedding-004` for query embeddings (768-dim Matryoshka).
   The test harness's `FakeEmbeddingService` returns a constant all-zeros vector, which
   makes every chunk tied for cosine similarity.
2. **BM25 search** does use real tsvector ranking, but without competition from a meaningful
   vector strategy, RRF fusion collapses to "BM25 alone".
3. **Graph traversal** requires seed entities extracted from the query via the LLM
   entity-extraction step — another real-LLM dependency.

Running a Phase 5 retrieval baseline with fake services would produce numbers that reflect
infrastructure wiring, not actual retrieval quality. We would then have to re-run the whole
exercise with real services in Phase 4 and throw away the first baseline.

### 4.2 What's already validated

- **Metric math** — all four functions (Precision@k, Recall@k, MRR, nDCG@10) are exercised
  by 28 unit tests in `tests/specs/43_retrieval_metrics.test.ts`, including edge cases
  (negative queries, empty results, k-truncation, boundary conditions).
- **Golden set shape** — all 12 golden queries parse, validate, and load cleanly (QA-26/27/28
  in spec 43).
- **Runner wiring** — `runRetrievalEval(goldenDir, runQuery)` signature matches
  `hybridRetrieve` output shape (both return `chunkId`, `storyId`, `content`, `rank`, `score`).
- **Corpus-seeding flow** — spec 44 (`44_e2e_pipeline_integration.test.ts`) seeds a real
  fixture corpus end-to-end in under 10 seconds with fake services.

The only missing piece is a real-embedding run against a real corpus. That is exactly what
Phase 4 will produce.

### 4.3 Plan for Phase 4 retrieval baseline

Inside the Phase 4 smoketest, after the Frontiers of Science PDF has been fully processed,
run:

```bash
# From the QA-Gate Phase 5 eval script pattern (.local/phase5-eval.mjs):
mulder query "<each golden query text>" --json  # 12 invocations
```

Capture each response, feed to `runRetrievalEval` via the `runQuery` callback, and write
the result to `eval/metrics/baseline.json` as a new top-level `retrieval` section alongside
`extraction`, `segmentation`, `entities`.

The 12 golden queries were written against the existing fixture corpus (Phoenix Lights,
Rendlesham Forest, Hessdalen, Project Blue Book), not the Frontiers of Science PDF. For
the Phase 4 baseline, we have two options:

- **Option A:** Ingest the 5 existing fixture story markdowns as a real GCP corpus and run
  the golden queries against that. Cost: ~€0.30 (embed + rerank only, no Document AI).
- **Option B:** Write a separate golden query set tailored to the Frontiers of Science
  article content and skip the fixture queries. Cost: ~€0.05 (queries only).

**Recommendation:** Option A. It uses the existing golden set (higher reuse, no new
annotation work) and the cost is still comfortably within the €3 Phase 4 cap.

---

## 5. Phase 5 findings

| ID | Severity | Title | Phase for fix |
|----|----------|-------|---------------|
| P5-EVAL-DOCUMENT-TYPE-01 | NOTE | Entity eval shows F1=0 for `document` type — pre-existing gap between cross-lingual-article golden annotation and enrich prompt behavior. Unchanged since 2026-04-03 baseline. | Post-gate (requires enrich prompt update OR golden annotation revision — user-facing decision) |
| P5-EVAL-RETRIEVAL-DEFERRED-01 | NOTE | Retrieval baseline not yet produced. Deferred to Phase 4 GCP smoketest where real `text-embedding-004` output makes the measurement meaningful. | Phase 4 |

Neither is a blocker. Both are documentation of state, not new bugs.

---

## 6. Exit criteria

| Criterion | Status |
|-----------|--------|
| Extraction eval run + compared to baseline | ✅ Zero regression |
| Segmentation eval run + compared to baseline | ✅ Zero regression |
| Entity eval run + compared to baseline | ✅ Zero regression |
| Retrieval eval run | ⏸ Deferred to Phase 4 (real-service dependency) |
| Baseline updated with new retrieval section | ⏸ Deferred to Phase 4 |
| Phase 5 report written | ✅ (this doc = D8-partial) |

**Verdict: PASS_WITH_DEFERRAL.** Proceed to Phase 4.

---

## 7. Reproducibility

The extraction/segmentation/entity evals were run via this inline Node script (kept under
`.local/` which is gitignored — not committed as a permanent script because `mulder eval` CLI
is scheduled for M8/I1 per roadmap):

```javascript
// .local/phase5-eval.mjs
import { resolve } from 'node:path';
import { runExtractionEval, runSegmentationEval, runEntityEval }
  from './packages/eval/dist/index.js';

const ROOT = resolve(import.meta.dirname);
const out = {
  extraction:   runExtractionEval(resolve(ROOT, 'eval/golden/extraction'),   resolve(ROOT, 'fixtures/extracted')),
  segmentation: runSegmentationEval(resolve(ROOT, 'eval/golden/segmentation'), resolve(ROOT, 'fixtures/segments')),
  entity:       runEntityEval(resolve(ROOT, 'eval/golden/entities'),         resolve(ROOT, 'fixtures/entities')),
};
process.stdout.write(JSON.stringify(out, null, 2));
```

Run from workspace root: `node .local/phase5-eval.mjs`.

When the `mulder eval` CLI is built in M8 (roadmap step I1), this script should be replaced
by `mulder eval --compare baseline`.
