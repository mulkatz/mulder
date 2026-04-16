---
spec: 77
title: "Eval CLI + Reporter"
roadmap_step: M8-I1
functional_spec: ["§1", "§15.1", "§15.2", "§15.3", "§16"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/196"
created: 2026-04-15
---

# Spec 77: Eval CLI + Reporter

## 1. Objective

Add a top-level `mulder eval` command that operationalizes Mulder's checked-in golden test sets as a repeatable CLI workflow. The command must run the existing fixture-backed eval suites, print a human-readable summary by default, emit machine-readable JSON on demand, compare the current run against `eval/metrics/baseline.json`, and optionally update the baseline in place.

This fulfills the CLI command-tree contract in `docs/functional-spec.md` §1 and the evaluation workflow in §15 by turning the existing `@mulder/eval` package into a first-class user-facing capability. The command is explicitly local and deterministic: it reads checked-in goldens, fixtures, and baseline files only, and does not require PostgreSQL, GCP, or live model calls.

## 2. Boundaries

**In scope:**
- New top-level CLI command: `mulder eval`
- Step selector surface that follows pipeline terminology:
  - `mulder eval` → run all fixture-backed suites in this step
  - `mulder eval --step extract`
  - `mulder eval --step segment`
  - `mulder eval --step enrich`
- Comparison mode:
  - `mulder eval --compare baseline`
  - compare only the suites executed in the current invocation
  - preserve unrelated top-level baseline sections when reading or writing
- Baseline update mode:
  - `mulder eval --update-baseline`
  - rewrite only the suite sections produced by the current invocation
  - write atomically so interrupted writes do not corrupt `eval/metrics/baseline.json`
- Output modes:
  - default human-readable reporter to stdout
  - `--json` returns structured JSON for scripts
- Exact repository paths used by the command:
  - `eval/golden/extraction/`
  - `eval/golden/segmentation/`
  - `eval/golden/entities/`
  - `fixtures/extracted/`
  - `fixtures/segments/`
  - `fixtures/entities/`
  - `eval/metrics/baseline.json`
- CLI-level validation and error messages for unsupported steps, missing baseline files, invalid JSON, or missing golden/fixture directories
- Black-box spec tests for the new CLI surface

**Out of scope:**
- New golden annotations, new metric formulas, or changes to `@mulder/eval` runner semantics
- Retrieval eval CLI integration; the existing retrieval runner requires a query callback and corpus setup that this roadmap step does not yet define as a stable local black-box lane
- Real-GCP or live-corpus evaluation
- Budget alerts or cost-estimation UX from `M8-I2` / `M8-I3`

**Target files:**
- `apps/cli/src/commands/eval.ts`
- `apps/cli/src/lib/eval.ts`
- `apps/cli/src/index.ts`
- `apps/cli/package.json`
- `apps/cli/tsconfig.json`
- `tests/specs/77_eval_cli_reporter.test.ts`

**Architectural constraints:**
- Keep the command a thin CLI wrapper; reusable runner orchestration and comparison logic belongs in `apps/cli/src/lib/eval.ts`
- Use only public `@mulder/eval` exports; do not import package-internal files by path
- Keep all eval execution local and fixture-backed; this command must not instantiate the service registry or any GCP clients
- Preserve existing top-level keys in `eval/metrics/baseline.json` that were not part of the current run

## 3. Dependencies

**Requires (must exist):**
- `packages/eval/` public runner exports from specs 21 and 31
- `eval/golden/{extraction,segmentation,entities}/`
- `fixtures/{extracted,segments,entities}/`
- `eval/metrics/baseline.json`
- CLI scaffold from spec 06 (`apps/cli/src/index.ts`, Commander wiring, shared error handling)

**Required by (future steps):**
- M8 operational workflows that need a standard local quality gate before expensive or irreversible actions
- Future retrieval / grounding / graph eval surfaces that may extend the same CLI contract

## 4. Blueprint

## 4.1 File Plan

### New files

| File | Purpose |
|------|---------|
| `apps/cli/src/commands/eval.ts` | Commander registration for `mulder eval` and CLI argument validation |
| `apps/cli/src/lib/eval.ts` | Repo-path resolution, suite execution, baseline comparison, JSON shaping, and human-readable reporter helpers |
| `tests/specs/77_eval_cli_reporter.test.ts` | Black-box CLI subprocess tests for the full command surface |

### Modified files

| File | Change |
|------|--------|
| `apps/cli/src/index.ts` | Register `registerEvalCommands` in the top-level CLI |
| `apps/cli/package.json` | Add `@mulder/eval` workspace dependency |
| `apps/cli/tsconfig.json` | Add project reference to `../../packages/eval` |

## 4.2 Command Contract

```bash
npx mulder eval
npx mulder eval --step extract
npx mulder eval --step segment
npx mulder eval --step enrich
npx mulder eval --compare baseline
npx mulder eval --update-baseline
npx mulder eval --json
```

Rules:

- `--step` accepts only `extract`, `segment`, or `enrich`
- Omitted `--step` means run all three suites
- `--compare` accepts only `baseline`
- `--compare baseline` may be combined with `--step` and/or `--json`
- `--update-baseline` may be combined with `--step` and/or `--json`
- `--compare baseline` and `--update-baseline` may be used together; comparison is produced from the pre-write baseline, then the selected suites are written back

## 4.3 Suite Mapping

The CLI uses pipeline-oriented step names but maps them to the existing eval runners:

| CLI step | Runner | Golden dir | Fixture dir | Result key |
|----------|--------|------------|-------------|------------|
| `extract` | `runExtractionEval()` | `eval/golden/extraction/` | `fixtures/extracted/` | `extraction` |
| `segment` | `runSegmentationEval()` | `eval/golden/segmentation/` | `fixtures/segments/` | `segmentation` |
| `enrich` | `runEntityEval()` | `eval/golden/entities/` | `fixtures/entities/` | `entities` |

The default `mulder eval` command runs all three rows above and returns a combined result object with one top-level key per suite.

## 4.4 Baseline Comparison

`apps/cli/src/lib/eval.ts` should expose a comparison helper that accepts current suite results plus baseline JSON and emits a compact diff structure for the executed suites only.

Comparison rules:

- Lower-is-better metrics:
  - extraction: `avgCer`, `avgWer`, `maxCer`, `maxWer`
- Higher-is-better metrics:
  - segmentation: `avgBoundaryAccuracy`, `segmentCountExactRatio`
  - entities: `overall.avgPrecision`, `overall.avgRecall`, `overall.avgF1`
  - per-type entity metrics: `avgPrecision`, `avgRecall`, `avgF1`
- Identical values are reported as `unchanged`
- Missing baseline sections for a requested suite are validation errors for `--compare baseline`

Human-readable comparison output should include current value, baseline value, delta, and status (`improved`, `regressed`, `unchanged`) for each reported metric.

## 4.5 Baseline Update Semantics

When `--update-baseline` is present:

- Load the current `eval/metrics/baseline.json` if it exists; if it does not exist, start from an empty object
- Replace only the top-level suite keys produced by the current invocation
- Preserve unrelated top-level keys such as future `retrieval`, `ground`, or other eval sections
- Write via a temporary file in the same directory followed by rename so the baseline file is never partially written

The command's exit code remains `0` when the write succeeds, even if metrics regressed; this step is a reporter, not a policy gate.

## 4.6 JSON Output Shape

`--json` must emit a single JSON object to stdout:

```json
{
  "step": "all | extract | segment | enrich",
  "results": {
    "extraction": {},
    "segmentation": {},
    "entities": {}
  },
  "comparison": {
    "against": "baseline",
    "suites": {}
  },
  "baselineUpdated": false
}
```

Rules:

- `results` contains only the suites actually executed
- `comparison` is omitted when `--compare` is not present
- `baselineUpdated` is `true` only when the baseline write completed successfully

## 4.7 Human Reporter

Default output should be a concise terminal report that is useful in local iteration without requiring `--json`.

Required content:

- One section per executed suite
- Extraction: CER/WER summary
- Segmentation: boundary accuracy and exact-count ratio
- Entities: overall precision/recall/F1 plus per-type rows when available
- When `--compare baseline` is present, each section must show the comparison against baseline directly under the current summary
- When `--update-baseline` is present, append a clear confirmation line naming the updated suites

The reporter must not depend on ANSI-only semantics for meaning; plain-text output must stay readable in CI logs.

## 5. QA Contract

Tests file: `tests/specs/77_eval_cli_reporter.test.ts`

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Full eval runs locally | Built CLI and checked-in fixtures exist | `node apps/cli/dist/index.js eval` | Exit `0`, stdout includes extraction, segmentation, and entity summary sections |
| QA-02 | Single-step extract run is scoped | Built CLI exists | `node apps/cli/dist/index.js eval --step extract --json` | Exit `0`, JSON contains only `results.extraction` |
| QA-03 | Single-step segment run is scoped | Built CLI exists | `node apps/cli/dist/index.js eval --step segment --json` | Exit `0`, JSON contains only `results.segmentation` |
| QA-04 | Single-step enrich run is scoped | Built CLI exists | `node apps/cli/dist/index.js eval --step enrich --json` | Exit `0`, JSON contains only `results.entities` |
| QA-05 | Baseline comparison works | Valid `eval/metrics/baseline.json` exists | `node apps/cli/dist/index.js eval --compare baseline --json` | Exit `0`, JSON contains `comparison.against = "baseline"` and comparison data for all executed suites |
| QA-06 | Invalid step is rejected | Built CLI exists | `node apps/cli/dist/index.js eval --step bogus` | Exit non-zero with validation feedback naming valid steps |
| QA-07 | Missing baseline is rejected for compare mode | Baseline file is temporarily absent | `node apps/cli/dist/index.js eval --compare baseline` | Exit non-zero with a clear baseline-missing error |
| QA-08 | Invalid baseline JSON is rejected | Baseline file contains malformed JSON | `node apps/cli/dist/index.js eval --compare baseline` | Exit non-zero with a parse error |
| QA-09 | Baseline update rewrites only selected suites | Valid baseline exists | `node apps/cli/dist/index.js eval --step extract --update-baseline --json` | Exit `0`, `baselineUpdated` is `true`, extraction section changes, and unrelated top-level keys remain intact |
| QA-10 | Command is fixture-only | GCP env/config is absent | `node apps/cli/dist/index.js eval --step extract` | Exit `0`; command succeeds without DB or GCP clients |

## 5b. CLI Test Matrix

| ID | Command | Expected outcome |
|----|---------|------------------|
| CLI-01 | `mulder eval` | Exit `0`, human-readable report for extraction + segmentation + entities |
| CLI-02 | `mulder eval --step extract` | Exit `0`, extraction-only report |
| CLI-03 | `mulder eval --step segment` | Exit `0`, segmentation-only report |
| CLI-04 | `mulder eval --step enrich` | Exit `0`, entity-only report |
| CLI-05 | `mulder eval --compare baseline` | Exit `0`, comparison against baseline shown for all executed suites |
| CLI-06 | `mulder eval --step extract --compare baseline --json` | Exit `0`, extraction result + extraction comparison only |
| CLI-07 | `mulder eval --update-baseline --step extract --json` | Exit `0`, extraction rerun persisted and JSON confirms the write |
| CLI-08 | `mulder eval --step bogus` | Exit non-zero with valid-step guidance |
| CLI-09 | `mulder eval --compare unsupported` | Exit non-zero with valid-compare guidance |
| CLI-10 | `mulder eval --compare baseline` with missing baseline file | Exit non-zero with baseline-missing error |

## 6. Cost Considerations

This command must be cost-free in normal use. It operates entirely on checked-in goldens, local fixtures, and a local baseline file. It must not initialize GCP clients, call Gemini, call Document AI, or require PostgreSQL.

Because this step sits in the M8 operational-safety milestone, the implementation must preserve that cheap-by-default posture: users should be able to run `mulder eval` as often as they want during local development and CI without incurring cloud spend. Retrieval or live-corpus eval integration belongs to a separate spec once there is a stable, explicit low-cost contract for that path.
