---
spec: "90"
title: "Spreadsheet Ingestion on the Pre-Structured Path"
roadmap_step: M9-J6
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/241"
created: 2026-05-01
---

# Spec 90: Spreadsheet Ingestion on the Pre-Structured Path

## 1. Objective

Add M9-J6 spreadsheet ingestion so `.csv` and `.xlsx` tabular files can enter Mulder as first-class `spreadsheet` sources. Spreadsheet sources are already represented in the M9 source type enum and in the pre-structured step planner; this step makes that path executable by accepting tabular files at ingest/upload time, storing canonical tabular metadata, converting CSV rows and workbook sheets into story Markdown tables during `extract`, and letting downstream processing run `enrich -> embed -> graph` while `segment` is recorded as skipped.

This fulfills the roadmap requirement for CSV/Excel ingestion where each sheet becomes a story, large spreadsheets are chunked by row groups, and rows with entity-like data receive extraction hints. The implementation must preserve the functional-spec contracts from `§2` (strict step contracts and service-boundary discipline), `§2.1` (ingest registers sources and storage objects), `§3` (PostgreSQL-authoritative orchestration and skipped steps), and `§4.5` (format extractors use service abstractions rather than direct client coupling inside pipeline steps).

## 2. Boundaries

**Roadmap step:** M9-J6 - CSV/Excel ingestion: tabular data -> Markdown tables, row-level entity hints.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/extract/types.ts`
- `packages/pipeline/src/index.ts`
- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/services.gcp.ts`
- `packages/core/src/shared/spreadsheet-extractor.ts`
- `packages/core/src/shared/errors.ts`
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/lib/cost-estimate.ts`
- `apps/api/src/routes/uploads.schemas.ts`
- `apps/api/src/lib/uploads.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts`
- `docs/roadmap.md`

**In scope:**

- Accept `.csv` and `.xlsx` files in CLI ingest, directory discovery, API upload initiation, API upload completion validation, dev upload proxy, and worker upload finalization.
- Preserve magic/content detection precedence from Spec 85:
  - decisive PDF/image magic bytes still win over misleading `.csv` or `.xlsx` extensions,
  - arbitrary ZIP files renamed to `.xlsx` must fail before source creation unless they contain Office Open XML spreadsheet evidence,
  - `.csv` files must be readable UTF-8 delimited text before becoming spreadsheet sources.
- Store spreadsheet sources with `source_type = 'spreadsheet'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, and `format_metadata` containing at least:
  - `media_type` (`text/csv` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
  - `original_extension` (`csv` or `xlsx`)
  - `byte_size`
  - `tabular_format` (`csv` or `xlsx`)
  - `container` (`delimited_text` or `office_open_xml`)
  - `parser_engine`
  - `sheet_count`
  - `sheet_names`
  - `table_summaries` with sheet name, row count, column count, and row group count
  - `encoding = "utf-8"` and detected delimiter for CSV.
- Upload spreadsheet originals under `raw/{source_id}/original.csv` or `raw/{source_id}/original.xlsx` using the canonical media type.
- Keep duplicate detection based on the existing file-hash path.
- Add a service abstraction for spreadsheet parsing. Pipeline extract code must call the service interface, not import the parser directly.
- Implement deterministic spreadsheet extraction that:
  - downloads the stored original through `services.storage`,
  - parses CSV and XLSX locally,
  - creates one story per CSV file, one story per non-empty XLSX sheet, and additional row-group stories for large tables,
  - renders each story as a GitHub-Flavored Markdown table,
  - includes deterministic row-level entity hints in story metadata and in a compact Markdown hint section for enrichment visibility,
  - writes `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
  - creates `stories` rows in PostgreSQL,
  - marks `source_steps.extract` completed and the source status `extracted`.
- Let Spec 86's planner record `segment` as skipped when pipeline runs include that step for `spreadsheet` sources.
- Preserve all current PDF, image, text, and DOCX ingest, extract, upload, cost, and pipeline behavior.

**Out of scope:**

- Legacy `.xls`, `.ods`, `.tsv`, Numbers, Google Sheets, email, or URL ingestion.
- Formula recalculation, pivot tables, charts, comments, rich cell formatting, merged-cell visual layout, workbook protection semantics, or macro execution.
- Schema inference beyond deterministic row-level hints; no domain-specific entity types may be hard-coded.
- LLM summarization during extract.
- Format-aware extract routing cleanup beyond the new spreadsheet branch in the existing extract step. The broader dispatch cleanup is M9-J11.
- Cross-format deduplication beyond existing file-hash duplicate handling. That is M9-J12.
- New database columns or enum values; Spec 85 already added `spreadsheet`.
- New direct GCP client usage in pipeline, CLI, API, or worker code.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for storage, Firestore, and format extraction effects.
- Unsupported, corrupt, encrypted, password-protected, malformed, or empty spreadsheets must fail before story creation and should not silently produce empty stories.
- Spreadsheet extraction must be deterministic and cost-free: no Document AI, no Gemini Vision, and no Segment step.
- Row-level hints must be generic and ontology-agnostic. Use header/value heuristics such as email, URL, date, location-like header names, person/name-like header names, organization-like header names, and identifier-like columns; do not add domain-specific assumptions.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `source_type`, `format_metadata`, and spreadsheet detection scaffolding.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `spreadsheet` skips `segment`.
- M9-J3 / Spec 87: broadened non-PDF ingest/upload patterns.
- M9-J4 / Spec 88: pre-structured text extraction pattern and direct story artifact creation.
- M9-J5 / Spec 89: service-bound deterministic document extraction pattern and DOCX compatibility baseline.
- M2-B4 / Spec 16: existing ingest implementation.
- M3-C1 / Spec 22: story repository and story storage conventions.

**Blocks:**

- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: Spreadsheet detection and metadata helpers

1. Expand `SUPPORTED_INGEST_EXTENSIONS` in `packages/pipeline/src/ingest/source-type.ts` to include `.csv` and `.xlsx`.
2. Extend canonical storage/media helpers:
   - `text/csv` -> `csv`
   - `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` -> `xlsx`
3. Strengthen XLSX detection so a ZIP signature plus `.xlsx` extension is not enough on its own; require Office Open XML spreadsheet evidence such as `[Content_Types].xml` and `xl/workbook.xml` before returning `sourceType = 'spreadsheet'`.
4. Keep CSV detection limited to readable UTF-8 delimited text with at least two non-empty rows and a consistent delimiter candidate among comma, semicolon, or tab.
5. Add reusable spreadsheet metadata builders:
   - lightweight ingest metadata based on bytes, filename, media type, and CSV delimiter when available,
   - extract-enriched metadata based on parsed sheet/table summaries.
6. Keep PDF/image magic-byte detection ahead of spreadsheet detection and keep DOCX/email/text shape detection behavior unchanged.

### Phase 2: CLI ingest and cost estimation

1. Add `spreadsheet` to the ingestible source types in `packages/pipeline/src/ingest/index.ts`.
2. For `.csv`:
   - validate file size with the existing ingest gate,
   - require readable UTF-8 delimited content,
   - skip PDF metadata extraction and native text detection,
   - create a source row with `sourceType: 'spreadsheet'`,
   - store CSV metadata in both `formatMetadata` and compatibility `metadata`,
   - upload the original using `original.csv` and `text/csv`.
3. For `.xlsx`:
   - validate file size with the existing ingest gate,
   - require valid Office Open XML spreadsheet evidence,
   - skip PDF metadata extraction and native text detection,
   - create a source row with `sourceType: 'spreadsheet'`,
   - store XLSX metadata in both `formatMetadata` and compatibility `metadata`,
   - upload the original using `original.xlsx` and the XLSX media type.
4. Keep CLI table columns unchanged while allowing `Type = spreadsheet`, `Pages = 0`, and `Native Text = no`.
5. Update `apps/cli/src/lib/cost-estimate.ts` so CSV/XLSX files are accepted in ingest profiling, count as zero scanned/layout pages, and do not reserve extract or segment OCR-style costs.
6. Keep PDF, image, text, and DOCX cost/profile behavior unchanged.

### Phase 3: API upload and worker finalization

1. Update `apps/api/src/routes/uploads.schemas.ts` to accept `.csv` / `.xlsx` filenames and the canonical CSV/XLSX content types.
2. Keep content-type/extension agreement strict and generate canonical storage paths `raw/{source_id}/original.csv` or `raw/{source_id}/original.xlsx`.
3. Update `apps/api/src/lib/uploads.ts` validation messages and initiation output to include spreadsheet files.
4. Update `packages/worker/src/dispatch.ts` upload finalization so `spreadsheet` is finalizable:
   - validate detected source type from bytes and filename,
   - compute the same spreadsheet metadata as CLI ingest,
   - canonicalize upload storage paths if needed,
   - create the source row transactionally,
   - emit Firestore observability with `sourceType: spreadsheet`,
   - enqueue `extract` when `startPipeline` is true.
5. Preserve duplicate cleanup and retry-safe upload canonicalization from Specs 87 through 89.

### Phase 4: Spreadsheet extraction service

1. Add a `SpreadsheetExtractorService` or equivalent typed service interface in `packages/core/src/shared/services.ts`.
2. Implement CSV/XLSX parsing in both dev and GCP service bundles using a deterministic local parser. Because parsing is local and deterministic, dev and GCP modes may share the same implementation helper, but the pipeline must still consume it through the service registry.
3. Return a typed extraction result with:
   - parsed sheets,
   - normalized headers,
   - data rows,
   - row group ranges,
   - sheet/table summaries,
   - parser metadata such as parser engine and warnings.
4. Reject corrupt, encrypted, password-protected, unreadable, or effectively empty spreadsheets with typed extraction errors surfaced by the extract step.
5. Add any parser dependency to the correct package manifest and update `pnpm-lock.yaml`.

### Phase 5: Markdown table rendering and row-level hints

1. Add deterministic Markdown table rendering that:
   - escapes pipe characters and line breaks inside cell values,
   - preserves header order,
   - emits one header separator row,
   - limits each story to a bounded row group when the sheet is large.
2. Default row grouping should be deterministic and visible in metadata. A reasonable initial threshold is 200 data rows per story; future config is out of scope for this step.
3. Add generic entity-hint extraction:
   - email-like values,
   - URL-like values,
   - date-like values,
   - identifier-like values from header names such as `id`, `case`, `invoice`, `reference`,
   - person/name-like values from header names such as `name`, `person`, `author`, `contact`,
   - organization-like values from header names such as `company`, `organization`, `agency`,
   - location-like values from header names such as `city`, `country`, `address`, `location`, `place`.
4. Store hints in story metadata under `entity_hints` with row number, sheet name, column name, hint type, value, and confidence/source (`header`, `value`, or `header_value`).
5. Add a compact `## Row Entity Hints` Markdown section only when hints exist so the current enrichment step can see the hints without reading story metadata.
6. Keep the table content itself the primary evidence; hints must not invent entities that are absent from the table.

### Phase 6: Spreadsheet extract path

1. Branch `packages/pipeline/src/extract/index.ts` by `source.sourceType`.
2. Preserve the existing PDF/image layout extract path, text path, and DOCX path.
3. For `spreadsheet` sources:
   - download `source.storagePath` through `services.storage`,
   - call the spreadsheet extraction service,
   - create story titles from filename, sheet name, and row group range,
   - write `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
   - call `createStory()` for each generated sheet or row-group story with `pageStart = null`, `pageEnd = null`, `extractionConfidence = 1.0`, and metadata that records `source_type = spreadsheet`, `tabular_format`, `sheet_name`, `row_start`, `row_end`, `row_count`, `column_count`, and `entity_hints`,
   - update the source format metadata with parsed table summaries when possible,
   - update the source status to `extracted`,
   - upsert `source_steps.extract = completed`,
   - write Firestore extract observability.
4. Do not write layout JSON or page images for spreadsheet sources.
5. Let pipeline/worker step planning skip `segment`; do not special-case `segment` inside spreadsheet extract.

### Phase 7: QA and compatibility

1. Add `tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts`.
2. Use black-box boundaries: CLI subprocesses, API requests, worker job processing, public package exports, SQL checks, and local dev storage artifacts.
3. Run the existing Spec 85, Spec 86, Spec 87, Spec 88, and Spec 89 suites that cover format detection, step skipping, non-PDF compatibility, pre-structured text extraction, and DOCX extraction.

## 5. QA Contract

**QA-01: CLI dry-run accepts CSV sources without persistence**

Given a valid `.csv` fixture with a header row and data rows, when `mulder ingest --dry-run <file.csv>` runs, then the command exits 0, prints `Type` as `spreadsheet`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-02: CLI dry-run accepts XLSX sources without persistence**

Given a valid `.xlsx` fixture with at least one non-empty worksheet, when `mulder ingest --dry-run <file.xlsx>` runs, then the command exits 0, prints `Type` as `spreadsheet`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-03: CLI spreadsheet ingest persists tabular metadata**

Given valid CSV and XLSX files, when `mulder ingest` runs for each file, then each source row has `source_type = 'spreadsheet'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, a canonical `raw/{source_id}/original.csv` or `raw/{source_id}/original.xlsx` storage path, and `format_metadata.media_type` matching the file type.

**QA-04: Spreadsheet detection rejects arbitrary ZIP files**

Given a ZIP file with no `xl/workbook.xml` entry but a `.xlsx` filename, when `mulder ingest --dry-run` runs, then it fails before source creation with an unsupported or invalid spreadsheet message.

**QA-05: CSV detection rejects unreadable or shape-invalid CSV files**

Given a `.csv` file that is binary, empty, or contains no consistent delimited rows, when `mulder ingest --dry-run` runs, then it fails before source creation with an unsupported or invalid spreadsheet message.

**QA-06: Directory ingest discovers PDFs, images, text, DOCX, and spreadsheets**

Given a directory containing one PDF, one PNG, one `.txt`, one `.docx`, one `.csv`, and one `.xlsx`, when `mulder ingest --dry-run <dir>` runs, then all six supported files appear in the output with their respective source types and the command exits 0.

**QA-07: Magic bytes remain authoritative**

Given a PDF, PNG, or DOCX saved with a `.csv` or `.xlsx` extension, when `mulder ingest --dry-run` runs, then it reports the magic-byte/source-package type (`pdf`, `image`, or `docx`) rather than `spreadsheet`.

**QA-08: CSV extract creates a pre-structured table story**

Given an ingested CSV source in dev mode, when `mulder extract <source_id>` runs, then the source reaches `extracted`, exactly one story row exists for the source, the story Markdown object exists under `segments/{source_id}/`, the Markdown contains a table, no `extracted/{source_id}/layout.json` is written, and `source_steps.extract` is `completed`.

**QA-09: XLSX extract creates one story per non-empty sheet**

Given an ingested XLSX source with two non-empty sheets and one empty sheet, when `mulder extract <source_id>` runs, then exactly two story rows are created, each story metadata identifies its sheet name, no story is created for the empty sheet, and the source reaches `extracted`.

**QA-10: Large spreadsheet extract chunks by row groups**

Given an ingested spreadsheet with more than the row-group threshold of data rows, when `mulder extract <source_id>` runs, then multiple story rows are created with non-overlapping `row_start` / `row_end` metadata and each Markdown table stays within the configured/default row-group size.

**QA-11: Row-level entity hints are exposed to enrich**

Given a spreadsheet with name, date, location, email, URL, and identifier-like columns, when extract runs, then story metadata contains `entity_hints` entries for those rows/columns and the story Markdown includes a `Row Entity Hints` section with the same visible values.

**QA-12: Pipeline skips segment for spreadsheets after extract**

Given an ingested spreadsheet source, when `mulder pipeline run --from extract --up-to enrich --source-id <source_id>` or the equivalent existing-source path runs, then `extract` executes, `segment` is recorded as skipped, `enrich` runs against the created story or stories, and no layout or segment job/artifact is created.

**QA-13: API upload accepts spreadsheet media types**

Given an upload initiation request for `table.csv` with `content_type = text/csv` and for `book.xlsx` with `content_type = application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, when each upload is completed and the finalize job runs, then source rows are created with `source_type = 'spreadsheet'`, canonical storage paths, and an `extract` job is queued when `start_pipeline` is true.

**QA-14: Duplicate spreadsheet ingest returns the existing source**

Given the same CSV or XLSX file is ingested twice, when the second ingest runs, then it reports duplicate status, does not create a second source row for the same file hash, and preserves `source_type = 'spreadsheet'`.

**QA-15: Existing PDF, image, text, and DOCX behavior remains green**

Given the existing Spec 85, Spec 86, Spec 87, Spec 88, and Spec 89 tests, when they run after this change, then PDF/image/text/DOCX ingest, extract, duplicate handling, upload finalization, and pipeline planning remain compatible.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run <tmp>/table.csv` | Valid CSV | Exit 0; output includes `spreadsheet`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest --dry-run <tmp>/book.xlsx` | Valid XLSX | Exit 0; output includes `spreadsheet`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest <tmp>/table.csv` | Valid CSV | Exit 0; DB row has `source_type = spreadsheet`; storage path ends in `original.csv`. |
| `mulder ingest <tmp>/book.xlsx` | Valid XLSX | Exit 0; DB row has `source_type = spreadsheet`; storage path ends in `original.xlsx`. |
| `mulder ingest --dry-run <tmp>/fake.xlsx` | Arbitrary ZIP renamed to XLSX | Non-zero or failed-file result; no source row; invalid/unsupported spreadsheet evidence is visible. |
| `mulder ingest --dry-run <tmp>/bad.csv` | Binary, empty, or shape-invalid CSV | Non-zero or failed-file result; no source row; invalid/unsupported CSV evidence is visible. |
| `mulder ingest --dry-run <tmp>/mixed-dir` | PDF + PNG + TXT + DOCX + CSV + XLSX | Exit 0; output includes `pdf`, `image`, `text`, `docx`, and `spreadsheet`. |
| `mulder extract <spreadsheet-source-id>` | Ingested CSV/XLSX source | Exit 0; one or more stories are created directly from Markdown tables; no layout JSON is written. |
| `mulder pipeline run --from extract --up-to enrich --source-id <spreadsheet-source-id>` | Ingested spreadsheet source | Exit 0; `segment` is skipped; stories reach `enriched`. |

## 6. Cost Considerations

Spreadsheet ingestion and spreadsheet extract are deterministic local/storage/database operations. They must not call Document AI, Gemini Vision, or the Segment LLM path. Cost estimation should show CSV/XLSX files as zero scanned/layout pages for extract and should avoid reserving segment cost for spreadsheet sources because Spec 86 skips `segment` for pre-structured formats. Downstream `enrich`, `embed`, and `graph` costs remain unchanged once spreadsheet extract has produced story Markdown.
