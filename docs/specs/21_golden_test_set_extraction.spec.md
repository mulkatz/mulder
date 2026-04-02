---
spec: 21
title: "Golden Test Set: Extraction"
roadmap_step: M2-B9
functional_spec: ["§15.1", "§15.2"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/42
created: 2026-04-02
---

# 1. Objective

Create a golden test set for extraction quality evaluation. 5-10 manually annotated pages covering different difficulty levels (simple layout, multi-column, mixed languages) with ground truth text. Implement CER (Character Error Rate) and WER (Word Error Rate) metric computations as a reusable eval library. Write Vitest assertions that compare extraction output against golden annotations and establish a checked-in baseline.

This is the first eval infrastructure — designed to be extended for segmentation and entity golden tests in M3-C10.

# 2. Boundaries

**In scope:**
- `eval/golden/` directory with ground truth JSON files for extraction
- `eval/metrics/baseline.json` — checked-in baseline extraction results
- `packages/eval/` package — CER/WER computation, eval runner, types
- Vitest test file asserting extraction quality against golden set
- Golden annotations for the existing fixture PDFs (`native-text-sample.pdf`, `scanned-sample.pdf`)
- Synthetic golden pages to reach 5-10 coverage across difficulty levels

**Out of scope:**
- `mulder eval` CLI command (M8-I1)
- Segmentation metrics (Boundary Accuracy — M3-C10)
- Entity extraction metrics (Precision/Recall/F1 — M3-C10)
- Embedding retrieval accuracy metrics (M4)
- Real Document AI / Gemini calls — golden annotations are hand-crafted

# 3. Dependencies

**Requires (must exist):**
- `fixtures/raw/` — test PDFs (exists: `native-text-sample.pdf`, `scanned-sample.pdf`)
- `fixtures/extracted/` — extraction output format (exists: `_schema.json`)
- `packages/pipeline/src/extract/types.ts` — `LayoutDocument`, `LayoutPage` types (exists)
- `packages/core/` — shared types, error classes (exists)

**Required by (future steps):**
- M3-C10 — Golden test set: segmentation + entities (extends eval package)
- M8-I1 — `mulder eval` CLI (wraps eval package)

# 4. Blueprint

## 4.1 File Plan

### New files

| File | Purpose | Mirrors |
|------|---------|---------|
| `packages/eval/package.json` | Eval package config | `packages/pipeline/package.json` |
| `packages/eval/tsconfig.json` | TypeScript config | `packages/pipeline/tsconfig.json` |
| `packages/eval/src/index.ts` | Barrel exports | `packages/pipeline/src/index.ts` |
| `packages/eval/src/types.ts` | Golden annotation + metric types | — |
| `packages/eval/src/extraction-metrics.ts` | CER/WER computation | — |
| `packages/eval/src/eval-runner.ts` | Load golden set, compare against extraction output, produce results | — |
| `eval/golden/extraction/native-text-sample-p1.json` | Ground truth: simple native-text page | — |
| `eval/golden/extraction/scanned-sample-p1.json` | Ground truth: scanned page | — |
| `eval/golden/extraction/multi-column-p1.json` | Ground truth: multi-column layout | — |
| `eval/golden/extraction/mixed-language-p1.json` | Ground truth: DE+EN mixed content | — |
| `eval/golden/extraction/table-layout-p1.json` | Ground truth: page with tables | — |
| `eval/golden/README.md` | Documents annotation format and process | — |
| `eval/metrics/baseline.json` | Initial eval results (checked in) | — |

### Modified files

| File | Change |
|------|--------|
| `package.json` (root) | Add `packages/eval` to workspace |
| `turbo.json` | Add eval package to pipeline |
| `pnpm-workspace.yaml` | Include `packages/eval` (if not already wildcard) |
| `fixtures/extracted/` | Add synthetic layout.json files for golden test pages |

## 4.2 Types (`packages/eval/src/types.ts`)

```typescript
/** Ground truth annotation for a single page's extraction. */
export interface ExtractionGolden {
  /** Reference to source fixture. */
  sourceSlug: string;
  /** 1-indexed page number. */
  pageNumber: number;
  /** Difficulty level for reporting. */
  difficulty: 'simple' | 'moderate' | 'complex';
  /** Language(s) present on the page. */
  languages: string[];
  /** Expected full page text (reading order). */
  expectedText: string;
  /** Optional: expected block count (for layout accuracy). */
  expectedBlockCount?: number;
  /** Annotation metadata. */
  annotation: {
    author: string;
    date: string;
    notes?: string;
  };
}

/** CER/WER result for a single page. */
export interface ExtractionMetricResult {
  sourceSlug: string;
  pageNumber: number;
  difficulty: string;
  cer: number;
  wer: number;
  charCount: number;
  wordCount: number;
}

/** Aggregate extraction eval results. */
export interface ExtractionEvalResult {
  timestamp: string;
  pages: ExtractionMetricResult[];
  summary: {
    totalPages: number;
    avgCer: number;
    avgWer: number;
    maxCer: number;
    maxWer: number;
    byDifficulty: Record<string, { avgCer: number; avgWer: number; count: number }>;
  };
}
```

## 4.3 CER/WER Computation (`packages/eval/src/extraction-metrics.ts`)

```
computeCER(expected: string, actual: string): number
  → Levenshtein distance at character level / max(len(expected), 1)
  → Normalize whitespace before comparison (collapse runs, trim)
  → Return 0.0 for perfect match, 1.0 for completely wrong

computeWER(expected: string, actual: string): number
  → Levenshtein distance at word level / max(wordCount(expected), 1)
  → Split on whitespace after normalization
  → Return 0.0 for perfect match

levenshteinDistance(a: T[], b: T[]): number
  → Standard dynamic programming edit distance
  → Used by both CER and WER (generic over string chars or word arrays)
```

## 4.4 Eval Runner (`packages/eval/src/eval-runner.ts`)

```
loadGoldenSet(goldenDir: string): ExtractionGolden[]
  → Read all *.json from goldenDir
  → Parse + validate structure
  → Return sorted by sourceSlug + pageNumber

runExtractionEval(goldenDir: string, extractedDir: string): ExtractionEvalResult
  → Load golden set
  → For each golden page:
    → Find matching layout.json in extractedDir/{sourceSlug}/
    → Find matching page in layout.pages
    → Compute CER + WER
  → Aggregate results
  → Return full eval result with summary
```

## 4.5 Golden Annotations

Each golden JSON file contains manually transcribed ground truth text for a specific page. The text represents the ideal extraction output in reading order.

**5 golden pages minimum:**

1. **native-text-sample-p1** — simple: single-column native PDF text, German
2. **scanned-sample-p1** — moderate: scanned single-column, typical OCR challenges
3. **multi-column-p1** — complex: multi-column magazine layout, reading order matters
4. **mixed-language-p1** — moderate: mixed German/English text
5. **table-layout-p1** — complex: page containing tables, structure preservation matters

For pages that don't have matching real fixture PDFs, create synthetic `layout.json` fixture files in `fixtures/extracted/` that simulate Document AI output — this allows the eval to run without GCP.

## 4.6 Synthetic Fixture Strategy

Since only `native-text-sample.pdf` and `scanned-sample.pdf` exist in `fixtures/raw/`, and `fixtures/extracted/` has no layout data yet:

1. Create `fixtures/extracted/native-text-sample/layout.json` — simulated Document AI output for the existing native-text PDF
2. Create `fixtures/extracted/scanned-sample/layout.json` — simulated Document AI output for the existing scanned PDF
3. Create `fixtures/extracted/multi-column-sample/layout.json` — synthetic multi-column layout
4. Create `fixtures/extracted/mixed-language-sample/layout.json` — synthetic mixed-language content
5. Create `fixtures/extracted/table-layout-sample/layout.json` — synthetic table layout

These fixtures follow the `LayoutDocument` schema from `packages/pipeline/src/extract/types.ts`. The golden annotations contain the "ideal" text, while the fixture layout.json files contain "realistic" extraction output (with minor OCR errors for scanned/complex pages to make the eval meaningful).

## 4.7 Baseline

`eval/metrics/baseline.json` stores the first eval run's results. Format matches `ExtractionEvalResult`. Checked into git as the reference point for regression detection.

## 4.8 Integration

- `packages/eval` is a workspace package, importable by tests and future CLI
- No runtime dependency on GCP — purely operates on local files
- Vitest test imports eval runner and asserts metric thresholds

# 5. QA Contract

Tests file: `tests/specs/21_golden_test_set_extraction.test.ts`

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Golden directory exists | Repo checked out | `eval/golden/extraction/` is listed | Directory exists with ≥5 JSON files |
| QA-02 | Golden files are valid | Golden JSON files exist | Each file is read and parsed | All files contain required fields: `sourceSlug`, `pageNumber`, `difficulty`, `languages`, `expectedText`, `annotation` |
| QA-03 | Fixture layout files exist | Golden pages reference source slugs | Check `fixtures/extracted/{slug}/layout.json` for each golden page | Every golden page has a matching layout.json fixture |
| QA-04 | CER computation is correct | Known input pairs | `computeCER("hello world", "helo wrld")` | Returns expected edit distance ratio (deterministic — no GCP) |
| QA-05 | WER computation is correct | Known input pairs | `computeWER("the quick brown fox", "the quik brown")` | Returns expected word error rate |
| QA-06 | Perfect match returns zero | Identical strings | `computeCER(text, text)` and `computeWER(text, text)` | Both return 0.0 |
| QA-07 | Eval runner produces results | Golden set + fixtures exist | `runExtractionEval()` is called | Returns `ExtractionEvalResult` with one entry per golden page and correct summary stats |
| QA-08 | Baseline file exists | Eval has been run | `eval/metrics/baseline.json` is read | Valid JSON matching `ExtractionEvalResult` schema, with `summary.totalPages >= 5` |
| QA-09 | Eval package builds | `packages/eval/` exists | `pnpm turbo run build --filter=@mulder/eval` | Build succeeds with no errors |
| QA-10 | Difficulty coverage | Golden set loaded | Count pages by difficulty | At least 1 'simple', 1 'moderate', 1 'complex' page |
