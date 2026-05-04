---
spec: "97"
title: "Multi-Format Golden Tests"
roadmap_step: M9-J13
functional_spec: ["§15.1", "§15.2", "§2", "§3", "§4.5"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/258"
created: 2026-05-04
---

# Spec 97: Multi-Format Golden Tests

## 1. Objective

Complete M9-J13 by adding a deterministic multi-format golden test layer for the completed M9 ingest and extract surface. The milestone goal is not another extractor rewrite; it is a black-box confidence net proving that PDF, image, text/Markdown, DOCX, spreadsheet, email, and URL sources all enter the same source/story/status model and that downstream pipeline rules stay format-agnostic.

This fulfills functional spec §15.1 by adding a manually curated golden fixture set and §15.2 by asserting step-level quality signals that are observable in the local test harness: source type classification, story creation, route behavior, segment skipping, and duplicate handling. It also protects the M9 shared contracts from §2, §3, and §4.5: extractors stay behind service abstractions, pre-structured sources bypass segment, and no format-specific path should leak into downstream story semantics.

## 2. Boundaries

**Roadmap step:** M9-J13 - Golden tests: multi-format - one fixture per format, Vitest assertions.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target branch:** `feat/258-multi-format-golden-tests`.

**Target files:**

- `eval/golden/multi-format/manifest.json`
- `eval/golden/README.md`
- `tests/specs/97_multi_format_golden_tests.test.ts`
- Optional test-local helper files under `tests/lib/` if the implementation would otherwise duplicate large fixture builders
- `docs/roadmap.md`

**In scope:**

- Add a committed golden manifest with one deterministic case for each supported M9 source type: `pdf`, `image`, `text`, `docx`, `spreadsheet`, `email`, and `url`.
- Let the test harness materialize binary or server-backed fixtures from the manifest when committing raw binary files would add noise.
- Run black-box CLI/database/storage assertions for ingest and extract behavior.
- Verify that layout-capable sources (`pdf`, `image`) and pre-structured sources (`text`, `docx`, `spreadsheet`, `email`, `url`) both create stories with stable metadata shape.
- Verify that pre-structured sources record segment skipping after pipeline/extract orchestration while layout sources remain on the layout path.
- Include a Spec 96 duplicate scenario for a cheap strong-signal pair so obvious cross-format duplicates do not inflate the source set.
- Re-run the relevant M9 regression matrix.

**Out of scope:**

- New source formats.
- New paid service calls, live GCP fixtures, or model-generated golden annotations.
- Changing production extraction behavior solely to make tests pass.
- Forcing PDF/DOCX ingest-time source collapse. Spec 96 intentionally keeps early dedup conservative for sources without a cheap ingest-time text signal; graph-level MinHash remains responsible for later PDF/DOCX equivalence.
- Adding or changing `mulder eval` CLI behavior.

## 3. Dependencies

- M9-J1 / Spec 85: first-class `source_type` and `format_metadata`.
- M9-J2 / Spec 86: pipeline step skipping for pre-structured sources.
- M9-J3 through M9-J10: all M9 formats have ingest/extract paths.
- M9-J11 / Spec 95: extract routing by `source_type`.
- M9-J12 / Spec 96: conservative cross-format ingest dedup for cheap strong signals.
- Existing eval package and golden directory from Specs 21 and 31.

This spec is the final M9 task and blocks the milestone-level review/merge to `main`.

## 4. Blueprint

1. Add `eval/golden/multi-format/manifest.json`.
   - Each entry should include `id`, `source_type`, `fixture_kind`, expected filename/source type, expected story count minimum, expected route kind, and expected stable metadata keys.
   - Manifest entries may reference existing committed fixtures such as `fixtures/raw/native-text-sample.pdf` or define deterministic fixture content that the test materializes into a temporary directory.
2. Update `eval/golden/README.md` with the multi-format manifest purpose and annotation rules.
3. Add `tests/specs/97_multi_format_golden_tests.test.ts`.
   - Build required packages once.
   - Migrate the test database when PostgreSQL is available.
   - Start a local HTTP server for the URL fixture and run that CLI case asynchronously so the server can respond.
   - Materialize DOCX/XLSX/email/text/image fixtures deterministically in a temp directory.
   - Clean `sources`, related pipeline/story tables, URL lifecycle tables, and storage snapshots between cases.
4. Test the golden manifest structure without importing private implementation code.
5. Test ingest/extract for each manifest entry through `node apps/cli/dist/index.js`.
6. Assert converged story contracts:
   - `sources.source_type` equals the manifest source type
   - at least one `stories` row exists after extract or pipeline
   - story metadata includes `source_type`
   - pre-structured sources do not create layout JSON as their primary route
   - layout sources create layout artifacts
7. Test the duplicate scenario with a text/Markdown or Markdown/URL pair whose normalized content key is identical.
8. Run the relevant M9 regression suite.

No database migration or config change is required.

## 5. QA Contract

1. **QA-01: Multi-format golden manifest exists**
   - Given: the repository is checked out
   - When: `eval/golden/multi-format/manifest.json` is read
   - Then: it is valid JSON and contains exactly one primary case for each source type: `pdf`, `image`, `text`, `docx`, `spreadsheet`, `email`, and `url`.

2. **QA-02: Manifest entries are complete**
   - Given: the manifest entries
   - When: each entry is validated
   - Then: each entry has `id`, `source_type`, `fixture_kind`, `expected_filename`, `expected_route`, `expected_story_min`, and `expected_metadata_keys`.

3. **QA-03: Ingest classifies every golden fixture**
   - Given: each manifest fixture materialized locally
   - When: `mulder ingest <fixture>` runs
   - Then: the command exits 0, creates one source row, and persists the manifest source type and required metadata keys.

4. **QA-04: Extract converges every format to stories**
   - Given: each golden fixture has been ingested
   - When: `mulder extract <source-id>` runs
   - Then: at least the manifest minimum story count exists, each story has Markdown and metadata storage URIs, and story metadata includes the source type.

5. **QA-05: Route artifacts match layout versus pre-structured expectations**
   - Given: extracted golden sources
   - When: storage and source steps are inspected
   - Then: `pdf` and `image` sources have layout artifacts, while `text`, `docx`, `spreadsheet`, `email`, and `url` sources do not create a route-primary layout JSON and are eligible for segment skipping.

6. **QA-06: Pipeline orchestration skips segment for pre-structured formats**
   - Given: at least one pre-structured golden source
   - When: `mulder pipeline run <fixture>` runs
   - Then: the source reaches extracted/enriched pipeline flow with `segment` recorded as skipped.

7. **QA-07: Cross-format duplicate golden case does not inflate source set**
   - Given: two manifest-backed fixtures with the same strong normalized cheap content signal
   - When: they are ingested sequentially
   - Then: the second ingest reports a duplicate and only one source row exists for that content.

8. **QA-08: M9 regression suite remains green**
   - Given: existing M9 spec tests
   - When: the relevant M9 regression matrix is run
   - Then: all previously green ingest/extract/routing/dedup behavior remains green.

## 5b. CLI Test Matrix

This step does not add a new command, but it exercises existing CLI behavior.

| Command | Expected |
| --- | --- |
| `mulder ingest <golden-fixture>` | exits 0 and persists the expected source type |
| `mulder extract <source-id>` | creates story Markdown and metadata for every source type |
| `mulder pipeline run <prestructured-fixture>` | records segment as skipped |
| `mulder ingest <duplicate-a>` then `mulder ingest <duplicate-b>` | second ingest reports duplicate and source count stays stable |

## 6. Cost Considerations

All fixtures must run with local/dev services. Do not add live Document AI, Gemini, Playwright-only, embedding, or other paid service calls solely for this golden test. URL tests may use a local HTTP server with unsafe URL override enabled only under `NODE_ENV=test`.
