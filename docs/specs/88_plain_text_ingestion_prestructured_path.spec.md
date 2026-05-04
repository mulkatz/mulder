---
spec: "88"
title: "Plain Text Ingestion on the Pre-Structured Path"
roadmap_step: M9-J4
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/233"
created: 2026-04-30
---

# Spec 88: Plain Text Ingestion on the Pre-Structured Path

## 1. Objective

Add M9-J4 plain text ingestion so `.txt`, `.md`, and `.markdown` files can enter Mulder as first-class `text` sources. Text sources are already part of the M9 discriminator from Spec 85 and the pre-structured skip rules from Spec 86; this step turns that scaffolding into an executable path where ingest stores the original text, extract converts it directly into story Markdown, and downstream processing runs `enrich -> embed -> graph` without OCR or segmentation.

This fulfills the roadmap requirement for plain text and Markdown pass-through while preserving the functional-spec contracts from `§2` (step contracts and service-boundary discipline), `§2.1` (ingest registers sources and storage objects), `§3` (PostgreSQL-authoritative pipeline orchestration and skipped steps), and `§4.5` (pipeline code uses service interfaces rather than direct GCP clients).

## 2. Boundaries

**Roadmap step:** M9-J4 - Plain text ingestion: `.txt`, `.md` pass-through with no OCR and no segment step.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/extract/types.ts`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/lib/cost-estimate.ts`
- `apps/api/src/routes/uploads.schemas.ts`
- `apps/api/src/lib/uploads.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/88_plain_text_ingestion_prestructured_path.test.ts`
- `docs/roadmap.md`

**In scope:**

- Accept `.txt`, `.md`, and `.markdown` files in CLI ingest.
- Expand directory ingest discovery and ingest cost profiling so directories may contain PDFs, images, and supported text files.
- Preserve magic/content detection precedence from Spec 85: decisive PDF/image magic bytes still win over misleading text extensions.
- Store text sources with `source_type = 'text'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, and `format_metadata` containing at least `media_type`, original extension, byte size, character count, line count, and UTF-8 encoding.
- Upload text originals under `raw/{source_id}/original.txt` or `raw/{source_id}/original.md` using the detected text media type.
- Keep duplicate detection based on the existing file hash path.
- Update API/browser upload initiation, completion validation, dev upload proxy, and worker finalization so supported text uploads reach the same source record and pipeline job path as CLI ingests.
- Add an extract path for `text` sources that:
  - downloads the stored text original through the storage service,
  - decodes it as UTF-8,
  - preserves Markdown input as Markdown,
  - wraps plain `.txt` input into minimal Markdown without inventing facts,
  - writes `segments/{source_id}/{story_id}.md` and `.meta.json`,
  - creates a `stories` row in PostgreSQL,
  - marks `source_steps.extract` completed and the source status `extracted`.
- Let Spec 86's planner record `segment` as skipped when pipeline runs include that step for `text` sources.
- Preserve all current PDF and image ingest, extract, upload, and pipeline behavior.

**Out of scope:**

- DOCX, spreadsheet, email, or URL ingestion. Those remain M9-J5 through M9-J10.
- Format-aware extract routing beyond the new text branch in the existing extract step. The broader dispatch cleanup is M9-J11.
- Row-level chunking, semantic splitting, or LLM summarization during text extract.
- Cross-format deduplication beyond existing file-hash duplicate handling. That is M9-J12.
- New database columns or changes to the `sources.source_type` enum; Spec 85 already added `text`.
- New direct GCP client usage in pipeline, CLI, API, or worker code.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for storage and Firestore effects.
- Unsupported or unknown files must fail before source creation.
- Text extraction must be deterministic and cost-free: no Document AI, no Gemini Vision, and no Segment step.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `source_type`, `format_metadata`, and text detection scaffolding.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `text` skips `segment`.
- M9-J3 / Spec 87: broadened ingest/upload patterns for non-PDF source types.
- M2-B4 / Spec 16: existing ingest implementation.
- M3-C1 / Spec 22: story repository and story storage conventions.

**Blocks:**

- M9-J5 DOCX ingestion.
- M9-J6 CSV/Excel ingestion.
- M9-J7 email ingestion.
- M9-J8 URL ingestion.
- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: Text detection and metadata helpers

1. Expand `SUPPORTED_INGEST_EXTENSIONS` in `packages/pipeline/src/ingest/source-type.ts` to include `.txt`, `.md`, and `.markdown`.
2. Add canonical text media/storage helpers:
   - `text/plain` -> `txt`
   - `text/markdown` and `text/x-markdown` -> `md`
3. Add a reusable text metadata builder that records:
   - `media_type`
   - `original_extension`
   - `byte_size`
   - `character_count`
   - `line_count`
   - `encoding = "utf-8"`
4. Keep unknown binary files rejected and keep CSV/email shape detection ahead of generic readable-text fallback.

### Phase 2: CLI ingest and cost estimation

1. Add `text` to the ingestible source types in `packages/pipeline/src/ingest/index.ts`.
2. For `.txt`, `.md`, and `.markdown`:
   - validate file size with the existing ingest gate,
   - require readable UTF-8 text,
   - skip PDF metadata extraction and native text detection,
   - create a source row with `sourceType: 'text'`,
   - store text metadata in both `formatMetadata` and compatibility `metadata`,
   - upload the original using the canonical raw extension and media type.
3. Keep CLI table columns unchanged while allowing `Type = text`, `Pages = 0`, and `Native Text = no`.
4. Update `apps/cli/src/lib/cost-estimate.ts` so text files are accepted in ingest profiling, count as zero scanned/layout pages, and do not reserve extract or segment OCR-style costs.
5. Keep PDF and image cost/profile behavior unchanged.

### Phase 3: API upload and worker finalization

1. Update `apps/api/src/routes/uploads.schemas.ts` to accept `.txt`, `.md`, and `.markdown` filenames plus `text/plain`, `text/markdown`, and `text/x-markdown` content types.
2. Keep content-type/extension agreement strict and generate canonical storage paths (`original.txt` or `original.md`).
3. Update `apps/api/src/lib/uploads.ts` validation messages and initiation output to include supported text files.
4. Update `packages/worker/src/dispatch.ts` upload finalization so `text` is finalizable:
   - validate detected source type from bytes/filename,
   - compute the same text metadata as CLI ingest,
   - canonicalize upload storage paths if needed,
   - create the source row transactionally,
   - emit Firestore observability with `sourceType: text`,
   - enqueue `extract` when `startPipeline` is true.
5. Preserve duplicate cleanup and retry-safe upload canonicalization from Spec 87.

### Phase 4: Text extract path

1. Branch `packages/pipeline/src/extract/index.ts` by `source.sourceType`.
2. Preserve the existing PDF/image layout extract path exactly for layout sources.
3. For `text` sources:
   - download `source.storagePath` through `services.storage`,
   - decode as UTF-8 and reject unreadable/binary content with a typed extract error,
   - normalize Markdown line endings,
   - for plain text, create Markdown with a title heading derived from the filename and escaped body text,
   - for Markdown, preserve the input body and derive a story title from the first heading or filename,
   - write `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
   - call `createStory()` with the written URIs, detected title, `pageStart = null`, `pageEnd = null`, `extractionConfidence = 1.0`, and metadata that records `source_type = text` and whether the input was Markdown,
   - update the source status to `extracted`,
   - upsert `source_steps.extract = completed`,
   - write Firestore extract observability.
4. Do not write layout JSON or page images for text sources.
5. Let pipeline/worker step planning skip `segment`; do not special-case `segment` inside text extract.

### Phase 5: QA and compatibility

1. Add `tests/specs/88_plain_text_ingestion_prestructured_path.test.ts`.
2. Use black-box boundaries: CLI subprocesses, API requests, worker job processing, public package exports, SQL checks, and local dev storage artifacts.
3. Run the existing Spec 85, Spec 86, and Spec 87 suites that cover format detection, step skipping, and non-PDF compatibility.

## 5. QA Contract

**QA-01: CLI dry-run accepts text sources without persistence**

Given valid `.txt`, `.md`, and `.markdown` fixtures, when `mulder ingest --dry-run` is run for each file, then the command exits 0, prints `Type` as `text`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-02: CLI text ingest persists text metadata**

Given a valid `.txt` file, when `mulder ingest` runs, then the command exits 0 and the database source row has `source_type = 'text'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, a `raw/{source_id}/original.txt` storage path, and `format_metadata.media_type = 'text/plain'`.

**QA-03: Markdown ingest preserves Markdown format metadata**

Given a valid `.md` or `.markdown` file, when `mulder ingest` runs, then the source row has `source_type = 'text'`, a canonical `original.md` storage path, and `format_metadata.media_type = 'text/markdown'`.

**QA-04: Directory ingest discovers PDFs, images, and text files**

Given a directory containing one PDF, one PNG, one `.txt`, and one `.md`, when `mulder ingest --dry-run <dir>` runs, then all four supported files appear in the output with their respective source types and the command exits 0.

**QA-05: Magic bytes remain authoritative**

Given a PDF or PNG saved with a `.txt` extension, when `mulder ingest --dry-run` runs, then it reports the magic-byte source type (`pdf` or `image`) rather than `text`.

**QA-06: Text extract creates a pre-structured story**

Given an ingested text source in dev mode, when `mulder extract <source_id>` runs, then the source reaches `extracted`, exactly one story row exists for the source, the story Markdown object exists under `segments/{source_id}/`, no `extracted/{source_id}/layout.json` is written, and `source_steps.extract` is `completed`.

**QA-07: Pipeline skips segment for text after extract**

Given an ingested text source, when `mulder pipeline run --from extract --up-to enrich --source-id <source_id>` or the equivalent existing-source path runs, then `extract` executes, `segment` is recorded as skipped, `enrich` runs against the created story, and no segment job/artifact is created.

**QA-08: API upload accepts text media types**

Given an upload initiation request for `note.md` with `content_type = text/markdown`, when the upload is completed and the finalize job runs, then a source row is created with `source_type = 'text'`, a canonical `original.md` storage path, and an `extract` job is queued when `start_pipeline` is true.

**QA-09: Duplicate text ingest returns the existing source**

Given the same text file is ingested twice, when the second ingest runs, then it reports duplicate status, does not create a second source row for the same file hash, and preserves `source_type = 'text'`.

**QA-10: Existing PDF and image behavior remains green**

Given the existing Spec 16, Spec 85, Spec 86, and Spec 87 tests, when they run after this change, then PDF/image ingest, extract, duplicate handling, upload finalization, and pipeline planning remain compatible.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run <tmp>/note.txt` | Plain text | Exit 0; output includes `text`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest <tmp>/note.txt` | Plain text | Exit 0; DB row has `source_type = text`; storage path ends in `original.txt`. |
| `mulder ingest <tmp>/brief.md` | Markdown | Exit 0; DB row has `format_metadata.media_type = text/markdown`; storage path ends in `original.md`. |
| `mulder ingest --dry-run <tmp>/mixed-dir` | PDF + PNG + TXT + MD | Exit 0; output includes `pdf`, `image`, and `text`. |
| `mulder extract <text-source-id>` | Ingested text source | Exit 0; one story is created directly from text; no layout JSON is written. |
| `mulder pipeline run --from extract --up-to enrich --source-id <text-source-id>` | Ingested text source | Exit 0; `segment` is skipped; story reaches `enriched`. |

## 6. Cost Considerations

Text ingestion and text extract are deterministic local/storage/database operations. They must not call Document AI, Gemini Vision, or the Segment LLM path. Cost estimation should show text files as zero scanned/layout pages for extract and should avoid reserving segment cost for text sources because Spec 86 skips `segment` for pre-structured formats. Downstream `enrich`, `embed`, and `graph` costs remain unchanged once text has produced story Markdown.
