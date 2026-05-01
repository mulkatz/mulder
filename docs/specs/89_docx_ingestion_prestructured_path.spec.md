---
spec: "89"
title: "DOCX Ingestion on the Pre-Structured Path"
roadmap_step: M9-J5
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/237"
created: 2026-05-01
---

# Spec 89: DOCX Ingestion on the Pre-Structured Path

## 1. Objective

Add M9-J5 DOCX ingestion so `.docx` Office documents can enter Mulder as first-class `docx` sources. DOCX sources are already represented in the M9 source type enum and in the pre-structured step planner; this step makes that path executable by accepting DOCX files at ingest/upload time, storing canonical Office metadata, converting the document to story Markdown during `extract`, and letting downstream processing run `enrich -> embed -> graph` while `segment` is recorded as skipped.

This fulfills the roadmap requirement for Office document extraction via `mammoth` or an equivalent DOCX parser while preserving the functional-spec contracts from `§2` (strict step contracts and service-boundary discipline), `§2.1` (ingest registers sources and storage objects), `§3` (PostgreSQL-authoritative orchestration and skipped steps), and `§4.5` (format extractors follow service abstraction patterns rather than direct GCP/client coupling inside pipeline steps).

## 2. Boundaries

**Roadmap step:** M9-J5 - DOCX ingestion: Office document extraction via `mammoth` / `docx-parser`.

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
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/lib/cost-estimate.ts`
- `apps/api/src/routes/uploads.schemas.ts`
- `apps/api/src/lib/uploads.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/89_docx_ingestion_prestructured_path.test.ts`
- `docs/roadmap.md`

**In scope:**

- Accept `.docx` files in CLI ingest, directory discovery, API upload initiation, API upload completion validation, dev upload proxy, and worker upload finalization.
- Preserve magic/content detection precedence from Spec 85: decisive PDF/image magic bytes still win over misleading `.docx` extensions, and arbitrary ZIP files renamed to `.docx` must fail before source creation.
- Store DOCX sources with `source_type = 'docx'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, and `format_metadata` containing at least:
  - `media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"`
  - `original_extension = "docx"`
  - `byte_size`
  - `office_format = "docx"`
  - `container = "office_open_xml"`
  - `extraction_engine = "mammoth"`
- Upload DOCX originals under `raw/{source_id}/original.docx` using the DOCX media type.
- Keep duplicate detection based on the existing file-hash path.
- Add a service abstraction for DOCX-to-Markdown extraction. Pipeline extract code must call the service interface, not import the parser directly.
- Implement deterministic DOCX extraction that:
  - downloads the stored original through `services.storage`,
  - converts DOCX body content to Markdown,
  - derives a story title from the first Markdown heading, document metadata when available, or filename fallback,
  - writes `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
  - creates exactly one `stories` row in PostgreSQL,
  - marks `source_steps.extract` completed and the source status `extracted`.
- Let Spec 86's planner record `segment` as skipped when pipeline runs include that step for `docx` sources.
- Preserve all current PDF, image, and text ingest, extract, upload, and pipeline behavior.

**Out of scope:**

- Legacy `.doc`, spreadsheet, email, or URL ingestion. Those remain outside M9-J5 and are covered by later M9 tasks where applicable.
- Table-specific row/entity hints for spreadsheets. That is M9-J6.
- Rich DOCX layout preservation, comments, tracked changes review semantics, embedded images, footnotes/endnotes normalization beyond what the chosen parser emits as Markdown.
- Format-aware extract routing cleanup beyond the new DOCX branch in the existing extract step. The broader dispatch cleanup is M9-J11.
- Cross-format deduplication beyond existing file-hash duplicate handling. That is M9-J12.
- New database columns or enum values; Spec 85 already added `docx`.
- New direct GCP client usage in pipeline, CLI, API, or worker code.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for storage, Firestore, and format extraction effects.
- Unsupported, corrupt, encrypted, or unreadable DOCX files must fail before story creation and should not silently produce empty stories.
- DOCX extraction must be deterministic and cost-free: no Document AI, no Gemini Vision, and no Segment step.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `source_type`, `format_metadata`, and DOCX detection scaffolding.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `docx` skips `segment`.
- M9-J3 / Spec 87: broadened non-PDF ingest/upload patterns.
- M9-J4 / Spec 88: pre-structured text extraction pattern and direct story artifact creation.
- M2-B4 / Spec 16: existing ingest implementation.
- M3-C1 / Spec 22: story repository and story storage conventions.

**Blocks:**

- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: DOCX detection and metadata helpers

1. Expand `SUPPORTED_INGEST_EXTENSIONS` in `packages/pipeline/src/ingest/source-type.ts` to include `.docx`.
2. Add canonical DOCX helpers:
   - media type `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
   - storage extension `docx`
   - supported upload/content-type predicates shared by CLI/API/worker paths where useful.
3. Strengthen DOCX detection so a ZIP signature plus `.docx` extension is not enough on its own; require Office Open XML evidence such as `[Content_Types].xml` and `word/document.xml` in the package before returning `sourceType = 'docx'`.
4. Add a reusable DOCX metadata builder that records the in-scope metadata fields above.
5. Keep PDF/image magic-byte detection ahead of DOCX detection and keep CSV/email/text shape detection behavior unchanged.

### Phase 2: CLI ingest and cost estimation

1. Add `docx` to the ingestible source types in `packages/pipeline/src/ingest/index.ts`.
2. For `.docx`:
   - validate file size with the existing ingest gate,
   - require a valid Office Open XML DOCX package,
   - skip PDF metadata extraction and native text detection,
   - create a source row with `sourceType: 'docx'`,
   - store DOCX metadata in both `formatMetadata` and compatibility `metadata`,
   - upload the original using `original.docx` and the DOCX media type.
3. Keep CLI table columns unchanged while allowing `Type = docx`, `Pages = 0`, and `Native Text = no`.
4. Update `apps/cli/src/lib/cost-estimate.ts` so DOCX files are accepted in ingest profiling, count as zero scanned/layout pages, and do not reserve extract or segment OCR-style costs.
5. Keep PDF, image, and text cost/profile behavior unchanged.

### Phase 3: API upload and worker finalization

1. Update `apps/api/src/routes/uploads.schemas.ts` to accept `.docx` filenames and the DOCX content type.
2. Keep content-type/extension agreement strict and generate canonical storage paths `raw/{source_id}/original.docx`.
3. Update `apps/api/src/lib/uploads.ts` validation messages and initiation output to include DOCX files.
4. Update `packages/worker/src/dispatch.ts` upload finalization so `docx` is finalizable:
   - validate detected source type from bytes and filename,
   - compute the same DOCX metadata as CLI ingest,
   - canonicalize upload storage paths if needed,
   - create the source row transactionally,
   - emit Firestore observability with `sourceType: docx`,
   - enqueue `extract` when `startPipeline` is true.
5. Preserve duplicate cleanup and retry-safe upload canonicalization from Specs 87 and 88.

### Phase 4: Office extraction service

1. Add an `OfficeDocumentExtractorService` or equivalent typed service interface in `packages/core/src/shared/services.ts`.
2. Implement DOCX-to-Markdown extraction in both dev and GCP service bundles using `mammoth` or an equivalent DOCX parser. Because the parser is local and deterministic, dev and GCP modes may share the same implementation helper, but the pipeline must still consume it through the service registry.
3. Return a typed extraction result with:
   - `markdown`
   - optional `title`
   - parser metadata such as warnings/messages and extraction engine.
4. Reject corrupt, encrypted, unreadable, or effectively empty DOCX files with a typed extraction error surfaced by the extract step.
5. Add the parser dependency to the correct package manifest and update `pnpm-lock.yaml`.

### Phase 5: DOCX extract path

1. Branch `packages/pipeline/src/extract/index.ts` by `source.sourceType`.
2. Preserve the existing PDF/image layout extract path and text pre-structured extract path.
3. For `docx` sources:
   - download `source.storagePath` through `services.storage`,
   - call the Office extraction service,
   - normalize Markdown line endings,
   - derive a title from the first Markdown heading, parser metadata, or filename,
   - write `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
   - call `createStory()` with the written URIs, detected title, `pageStart = null`, `pageEnd = null`, `extractionConfidence = 1.0`, and metadata that records `source_type = docx`, `office_format = docx`, and `extraction_engine`,
   - update the source status to `extracted`,
   - upsert `source_steps.extract = completed`,
   - write Firestore extract observability.
4. Do not write layout JSON or page images for DOCX sources.
5. Let pipeline/worker step planning skip `segment`; do not special-case `segment` inside DOCX extract.

### Phase 6: QA and compatibility

1. Add `tests/specs/89_docx_ingestion_prestructured_path.test.ts`.
2. Use black-box boundaries: CLI subprocesses, API requests, worker job processing, public package exports, SQL checks, and local dev storage artifacts.
3. Run the existing Spec 85, Spec 86, Spec 87, and Spec 88 suites that cover format detection, step skipping, non-PDF compatibility, and pre-structured text extraction.

## 5. QA Contract

**QA-01: CLI dry-run accepts DOCX sources without persistence**

Given a valid `.docx` fixture, when `mulder ingest --dry-run <file.docx>` runs, then the command exits 0, prints `Type` as `docx`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-02: CLI DOCX ingest persists Office metadata**

Given a valid `.docx` file, when `mulder ingest` runs, then the command exits 0 and the database source row has `source_type = 'docx'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, a `raw/{source_id}/original.docx` storage path, and `format_metadata.media_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'`.

**QA-03: DOCX detection rejects arbitrary ZIP files**

Given a ZIP file with no `word/document.xml` entry but a `.docx` filename, when `mulder ingest --dry-run` runs, then it fails before source creation with an unsupported or invalid DOCX message.

**QA-04: Directory ingest discovers PDFs, images, text, and DOCX files**

Given a directory containing one PDF, one PNG, one `.txt`, one `.md`, and one `.docx`, when `mulder ingest --dry-run <dir>` runs, then all five supported files appear in the output with their respective source types and the command exits 0.

**QA-05: Magic bytes remain authoritative**

Given a PDF or PNG saved with a `.docx` extension, when `mulder ingest --dry-run` runs, then it reports the magic-byte source type (`pdf` or `image`) rather than `docx`.

**QA-06: DOCX extract creates a pre-structured story**

Given an ingested DOCX source in dev mode, when `mulder extract <source_id>` runs, then the source reaches `extracted`, exactly one story row exists for the source, the story Markdown object exists under `segments/{source_id}/`, no `extracted/{source_id}/layout.json` is written, and `source_steps.extract` is `completed`.

**QA-07: Extract rejects empty or unreadable DOCX output**

Given a corrupt or effectively empty DOCX source row and raw object, when `mulder extract <source_id>` runs, then the command fails with a typed extract error, no story row is created, and the source is not marked `extracted`.

**QA-08: Pipeline skips segment for DOCX after extract**

Given an ingested DOCX source, when `mulder pipeline run --from extract --up-to enrich --source-id <source_id>` or the equivalent existing-source path runs, then `extract` executes, `segment` is recorded as skipped, `enrich` runs against the created story, and no layout or segment job/artifact is created.

**QA-09: API upload accepts DOCX media type**

Given an upload initiation request for `brief.docx` with `content_type = application/vnd.openxmlformats-officedocument.wordprocessingml.document`, when the upload is completed and the finalize job runs, then a source row is created with `source_type = 'docx'`, a canonical `original.docx` storage path, and an `extract` job is queued when `start_pipeline` is true.

**QA-10: Duplicate DOCX ingest returns the existing source**

Given the same DOCX file is ingested twice, when the second ingest runs, then it reports duplicate status, does not create a second source row for the same file hash, and preserves `source_type = 'docx'`.

**QA-11: Existing PDF, image, and text behavior remains green**

Given the existing Spec 85, Spec 86, Spec 87, and Spec 88 tests, when they run after this change, then PDF/image/text ingest, extract, duplicate handling, upload finalization, and pipeline planning remain compatible.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run <tmp>/brief.docx` | Valid DOCX | Exit 0; output includes `docx`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest <tmp>/brief.docx` | Valid DOCX | Exit 0; DB row has `source_type = docx`; storage path ends in `original.docx`. |
| `mulder ingest --dry-run <tmp>/fake.docx` | Arbitrary ZIP renamed to DOCX | Non-zero or failed-file result; no source row; invalid/unsupported DOCX evidence is visible. |
| `mulder ingest --dry-run <tmp>/mixed-dir` | PDF + PNG + TXT + MD + DOCX | Exit 0; output includes `pdf`, `image`, `text`, and `docx`. |
| `mulder extract <docx-source-id>` | Ingested DOCX source | Exit 0; one story is created directly from DOCX Markdown; no layout JSON is written. |
| `mulder pipeline run --from extract --up-to enrich --source-id <docx-source-id>` | Ingested DOCX source | Exit 0; `segment` is skipped; story reaches `enriched`. |

## 6. Cost Considerations

DOCX ingestion and DOCX extract are deterministic local/storage/database operations. They must not call Document AI, Gemini Vision, or the Segment LLM path. Cost estimation should show DOCX files as zero scanned/layout pages for extract and should avoid reserving segment cost for DOCX sources because Spec 86 skips `segment` for pre-structured formats. Downstream `enrich`, `embed`, and `graph` costs remain unchanged once DOCX has produced story Markdown.
