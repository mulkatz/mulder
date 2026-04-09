---
spec: 47
title: Document AI Extraction — End-to-End (Real GCP)
roadmap_step: QA-Gate Post-MVP fix sprint
functional_spec: §2.2 (extract step), §4.5 (service abstraction)
scope: single
created: 2026-04-09
---

## 1. Objective

End-to-end coverage of the Document AI Layout Parser path in the extract step. Spec 19 covers the native-text path because every fixture in `fixtures/raw/` either has embedded text (`native-text-sample.pdf`) or is rendered to text-only fallback in dev mode. Real Document AI calls were never exercised in CI before this spec.

This spec also acts as the regression test for the Document AI multi-region misconfig bug (`gcp.region` was wrongly used as the processor location segment, producing a 404 from the per-region Document AI endpoint). Spec 13 QA-10 catches the misconfig at config-load time via the `z.enum(['eu', 'us'])` constraint; this spec catches a hypothetical regression at runtime if the enum is ever loosened or bypassed.

## 2. Boundaries

### In scope
- Real `mulder ingest` + `mulder extract` against an image-only PDF that forces routing to Path B (`document_ai`)
- Verification that:
  - `sources.has_native_text = false`
  - `source_steps.status = 'completed'` for `step_name = 'extract'`
  - `sources.status = 'extracted'` after the call returns
  - `layout.json` is written to `.local/storage/extracted/{sourceId}/layout.json`
  - The layout JSON contains at least one page with at least one block
- Cost ceiling: ~€0.30 per run (one Document AI Layout Parser call against ~1 page)

### Out of scope
- Native-text path coverage (spec 19)
- Document AI processor creation / IAM setup (operator concern)
- CER / WER quality measurement against a ground-truth text version (future enhancement when a paired text+image fixture exists)
- Page image rendering quality (covered separately by the spec 19 native path + the pdfjs-dist + @napi-rs/canvas integration)

### Depends on
- `MULDER_E2E_GCP=true` env var to enable
- Working `gcloud` ADC for the configured project
- `mulder.config.yaml` with `dev_mode: false`, real `gcp.project_id`, real `gcp.document_ai.processor_id`, and the matching `gcp.document_ai.location`
- Built CLI at `apps/cli/dist/index.js`
- Running PostgreSQL container `mulder-pg-test` with migrations applied
- `fixtures/raw/scanned-sample.pdf` — pdf-lib-generated image-only PDF; `pdftotext` returns empty for it

## 5. QA Contract

All conditions are gated behind `it.skipIf(!E2E_ENABLED)` so they only run when `MULDER_E2E_GCP=true`. A separate notice test runs unconditionally so the suite never reports spec 47 as silently empty.

### QA-01: Ingest reports hasNativeText=false for the image-only PDF
**Given** `MULDER_E2E_GCP=true` and `fixtures/raw/scanned-sample.pdf` (zero embedded text)
**When** `mulder ingest fixtures/raw/scanned-sample.pdf` runs
**Then** the CLI exits 0, a row exists in `sources` for `scanned-sample.pdf`, and `sources.has_native_text = false`

### QA-02: Extract routes to the Document AI path and completes
**Given** the ingested source from QA-01
**When** `mulder extract <source-id>` runs
**Then** the CLI exits 0, `sources.status` advances to `'extracted'`, and `source_steps` has a `completed` row for `step_name = 'extract'`. A misconfigured `document_ai.location` would have produced a 404 here and the extract would have failed.

### QA-03: layout.json contains real Document AI Layout Parser output
**Given** the extracted source from QA-02
**When** the layout JSON at `.local/storage/extracted/{sourceId}/layout.json` is loaded
**Then** the file exists, parses as JSON, contains a `pages` array with at least one entry, and the first page has a `blocks` array — i.e. real structured layout data, not a placeholder

### QA-04: Successful chain through QA-01..QA-03 is the #93 regression coverage
**Given** all of QA-01, QA-02, and QA-03 passed
**When** the test asserts on the layout.json existence one more time
**Then** the assertion passes — confirming the wrong-location bug is gone. If the location had been wrong, the test would have failed at QA-02 with a Document AI 404.

## 5b. CLI Test Matrix

Same as the QA contract above — every QA-NN row corresponds to a CLI invocation. No additional matrix is needed.

| # | Command | Expected |
|---|---------|----------|
| QA-01 | `mulder ingest fixtures/raw/scanned-sample.pdf` | exit 0, `sources.has_native_text = false` |
| QA-02 | `mulder extract <source-id>` | exit 0, `sources.status = 'extracted'`, `source_steps.extract.status = 'completed'` |

## Pass / Fail

- **Pass:** When `MULDER_E2E_GCP=true`, all four `it.skipIf` conditions are green.
- **Pass:** When `MULDER_E2E_GCP` is unset, only the `SKIP-NOTICE` test runs and passes.
- **Fail:** A 404 from the Document AI endpoint at QA-02 means the location segment is wrong (regression of #93). A missing `layout.json` at QA-03 means the extract step picked the native-text path instead of the Document AI path.

## Out of scope

- The full Frontiers of Science paired-fixture CER/WER measurement called out in #103's acceptance criteria. The synthetic `scanned-sample.pdf` proves the Document AI path runs end-to-end without burning the cost of a 16-page real-magazine call. Pairing with a real ground-truth fixture for quality measurement is a follow-up that requires committing a ~14 MB binary fixture, which we have intentionally deferred.
- Multiple pages — the synthetic fixture is 1 page. The Document AI Layout Parser handles arbitrary page counts; that scaling is exercised when real archive ingest happens, not in this regression test.
