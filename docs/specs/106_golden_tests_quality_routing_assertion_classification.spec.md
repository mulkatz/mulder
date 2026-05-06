---
spec: 106
title: "Golden Tests For Quality Routing And Assertion Classification"
roadmap_step: "M10-K9"
functional_spec: "§A3, §A4, §A1, §A2"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/279"
created: 2026-05-06
---

# Spec 106: Golden Tests For Quality Routing And Assertion Classification

## 1. Objective

Complete M10-K9 by adding deterministic, fixture-backed golden tests for the two M10 trust surfaces that feed later archive ingest: document quality routing from §A4 and assertion classification from §A3.

K3 made quality a persisted pipeline step and K4 made assertions first-class Enrich output. K9 turns those behaviors into an operational regression suite: future changes to quality rules, prompts, schema generation, or eval tooling must have checked-in goldens that prove routing and epistemic classification still match the contract before real archive batches are ingested.

The suite must stay cost-free and domain-agnostic. It must not call Gemini, Document AI, GCP storage, or PostgreSQL by default. Golden annotations and fixtures are generic examples, not domain policy.

## 2. Boundaries

**Roadmap step:** M10-K9 - Golden tests: quality routing + assertion classification.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/279-golden-tests-quality-assertions`.

**Primary files:**

- `eval/golden/quality-routing/*.json`
- `eval/golden/assertions/*.json`
- `fixtures/quality-routing/*.json`
- `fixtures/assertions/*.json`
- `eval/golden/README.md`
- `packages/eval/src/quality-routing-runner.ts`
- `packages/eval/src/assertion-runner.ts`
- `packages/eval/src/types.ts`
- `packages/eval/src/index.ts`
- `apps/cli/src/lib/eval.ts`
- `tests/specs/106_golden_tests_quality_routing_assertion_classification.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add a quality-routing golden set with explicit cases for `high`, `medium`, `low`, and `unusable` quality decisions.
- Represent expected routing with `overall_quality`, `processable`, `recommended_path`, extraction gate outcome, quality metadata propagation, and the generic signals that justify the decision.
- Add an assertion-classification golden set with at least one `observation`, `interpretation`, and `hypothesis` case.
- Represent expected assertion output with content, assertion type, classification provenance, required confidence metadata, optional entity names, and optional source-quality metadata.
- Add deterministic actual fixtures that can be scored without database writes or live model output.
- Add public `@mulder/eval` loaders/runners that validate goldens, compare fixtures, and return aggregate pass/coverage metrics.
- Extend `mulder eval` with fixture-backed suite selection for quality routing and assertion classification.
- Preserve the existing `mulder eval` behavior for `extract`, `segment`, and `enrich`.
- Add black-box Vitest coverage for golden validation, fixture matching, CLI selection, baseline comparison compatibility, and no-cloud execution.

**Out of scope:**

- New quality-assessment production rules beyond Spec 100.
- New assertion-extraction prompt behavior beyond Spec 101.
- Human review workflows, confidence calibration UX, contradiction handling, credibility scoring, graph schema changes, or agent use of assertions.
- Live LLM, Document AI, OCR, GCS, or PostgreSQL-backed eval execution.
- Domain-specific classification labels or domain-specific quality categories.
- Rewriting historical eval baselines unless the current runner output intentionally adds new top-level suite sections.

## 3. Dependencies

- M10-K3 / Spec 100: document quality assessments, route names, and extract skip behavior exist.
- M10-K4 / Spec 101: `knowledge_assertions`, assertion labels, confidence metadata, and Enrich assertion persistence exist.
- M10-K8 / Spec 105: collection/provenance fixtures are available if needed, but K9 must not depend on collection-specific semantics.
- M8-I1 / Spec 77: `@mulder/eval` and `mulder eval` provide the checked-in fixture eval pattern.

K9 completes the M10 pre-archive quality gate. It does not block another M10 step; it blocks real archive ingest by providing a local regression suite for M10 quality and assertion behavior.

## 4. Blueprint

1. Add golden annotation formats:
   - `eval/golden/quality-routing/*.json` with one JSON file per deterministic quality case.
   - `eval/golden/assertions/*.json` with one JSON file per deterministic assertion case.
   - Update `eval/golden/README.md` with both schemas and rules for adding cases.

2. Add actual fixtures:
   - `fixtures/quality-routing/*.json` should mirror observable quality-assessment output, not internal function calls.
   - `fixtures/assertions/*.json` should mirror extracted assertion output plus optional persisted metadata.
   - Fixtures may intentionally include extra or mismatched fields only when tests assert that the runner reports the mismatch.

3. Add eval package support:
   - Extend `packages/eval/src/types.ts` with quality-routing and assertion-classification golden/result types.
   - Add `loadQualityRoutingGoldenSet`, `loadActualQualityRoutingCases`, and `runQualityRoutingEval`.
   - Add `loadAssertionGoldenSet`, `loadActualAssertionCases`, and `runAssertionClassificationEval`.
   - Export the new runners and public types from `packages/eval/src/index.ts`.
   - Runner output must include total cases, passed cases, failed cases, coverage by quality/assertion type, and per-case mismatch details.

4. Extend `mulder eval`:
   - Add `quality` and `assertions` as valid `--step` values.
   - Keep `enrich` mapped to the existing entity extraction suite for backward compatibility.
   - Omitted `--step` should run all fixture-backed suites: extraction, segmentation, entities, quality routing, and assertions.
   - Baseline comparison/update must preserve unrelated top-level sections and support the new suite keys when they exist in `eval/metrics/baseline.json`.
   - Human output should add compact quality-routing and assertion-classification sections.

5. Add black-box spec tests:
   - Validate both golden directories and fixture directories exist and contain the minimum coverage.
   - Verify runner outputs are deterministic and all checked-in fixture cases pass.
   - Verify intentionally malformed temp goldens fail validation with eval errors.
   - Verify `mulder eval --step quality --json` returns only the quality-routing suite.
   - Verify `mulder eval --step assertions --json` returns only the assertion-classification suite.
   - Verify `mulder eval --json` includes the two new suites while preserving the existing suites.
   - Verify the command succeeds with cloud and database environment variables absent.

6. Update roadmap state only after gates:
   - Keep K9 marked in progress while implementation is open.
   - Mark K9 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/10`.

## 5. QA Contract

1. **QA-01: Quality-routing goldens exist and cover §A4 routes**
   - Given the repository checkout
   - When `eval/golden/quality-routing/` is inspected
   - Then it contains deterministic cases for `high`, `medium`, `low`, and `unusable`, including `standard`, `enhanced_ocr`, `visual_extraction`, and `skip` route expectations.

2. **QA-02: Assertion goldens exist and cover §A3 labels**
   - Given the repository checkout
   - When `eval/golden/assertions/` is inspected
   - Then it contains deterministic cases for `observation`, `interpretation`, and `hypothesis`, and every case has complete confidence metadata.

3. **QA-03: Quality runner validates and scores fixtures**
   - Given quality-routing goldens and matching fixtures
   - When the public eval runner is called
   - Then all checked-in cases pass, coverage includes every expected quality value, and the result exposes per-case route/processability checks.

4. **QA-04: Assertion runner validates and scores fixtures**
   - Given assertion-classification goldens and matching fixtures
   - When the public eval runner is called
   - Then all checked-in cases pass, coverage includes every assertion type, and the result exposes confidence-metadata checks.

5. **QA-05: Runners report mismatches without live services**
   - Given a temporary actual fixture that changes one expected route or assertion type
   - When the matching eval runner is called
   - Then the result is deterministic, marks that case failed, and reports the mismatched field without network or database access.

6. **QA-06: Eval CLI can run quality and assertions suites**
   - Given a built CLI
   - When `mulder eval --step quality --json` and `mulder eval --step assertions --json` run
   - Then each exits 0 and emits only its selected suite.

7. **QA-07: Full eval includes the new suites**
   - Given a built CLI
   - When `mulder eval --json` runs
   - Then results include extraction, segmentation, entities, quality routing, and assertions.

8. **QA-08: Existing eval behavior remains compatible**
   - Given existing Spec 77 commands
   - When `mulder eval --step extract|segment|enrich` and `--compare baseline` run
   - Then existing suite keys and comparison semantics still work.

9. **QA-09: Suite is cost-free**
   - Given cloud and database environment variables are absent
   - When both new CLI suites run
   - Then they succeed without initializing GCP, Gemini, Document AI, GCS, or PostgreSQL clients.

10. **QA-10: K3/K4 regressions stay guarded**
    - Given the K9 branch
    - When scoped M10-K3 and M10-K4 tests are run alongside K9 scoped tests
    - Then existing quality-routing and assertion-classification behavior remains green.

## 5b. CLI Test Matrix

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder eval --step quality --json` | Checked-in quality-routing goldens/fixtures | Exit 0; JSON contains only `results.qualityRouting`. |
| `mulder eval --step assertions --json` | Checked-in assertion goldens/fixtures | Exit 0; JSON contains only `results.assertions`. |
| `mulder eval --json` | All checked-in fixture-backed suites | Exit 0; JSON includes extraction, segmentation, entities, qualityRouting, and assertions. |
| `mulder eval --step quality --compare baseline --json` | Baseline with `qualityRouting` section | Exit 0; comparison covers quality pass rate and failed case count. |
| `mulder eval --step assertions --compare baseline --json` | Baseline with `assertions` section | Exit 0; comparison covers assertion pass rate and failed case count. |
| `mulder eval --step bogus` | N/A | Exit non-zero; valid steps include `quality` and `assertions`. |

## 6. Cost Considerations

K9 must be cost-free. It reads checked-in JSON goldens and fixtures only. It must not instantiate production services, open database pools, make network calls, or call paid AI APIs. Baseline comparison and runner metrics must be simple in-memory operations over the small fixture set.
