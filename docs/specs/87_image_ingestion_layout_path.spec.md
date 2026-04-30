---
spec: "87"
title: "Image Ingestion on the Layout Extraction Path"
roadmap_step: M9-J3
functional_spec: ["§2.1", "§2.2", "§3.1", "§3.2", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/231"
created: 2026-04-30
---

# Spec 87: Image Ingestion on the Layout Extraction Path

## 1. Objective

Add M9-J3 image ingestion so PNG, JPEG, and TIFF files can enter Mulder as first-class `image` sources and continue through the existing layout-oriented pipeline. Images behave like single-page layout sources: ingest detects the image format from magic bytes, persists image format metadata, extract sends the original image through the service abstraction to Document AI / Gemini Vision, and downstream orchestration keeps `segment` in the executable path.

This fulfills the M9 roadmap requirement for image ingestion while preserving the functional-spec contracts from `§2.1` (ingest creates source records and storage objects), `§2.2` (extract writes layout JSON and page images), `§3.1` / `§3.2` (images remain on the layout path), and `§4.5` (pipeline code calls service interfaces rather than raw GCP clients).

## 2. Boundaries

**Roadmap step:** M9-J3 - Image ingestion: JPG, PNG, TIFF via Document AI / Gemini Vision.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/extract/types.ts`
- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/services.gcp.ts`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/lib/cost-estimate.ts`
- `apps/api/src/routes/uploads.schemas.ts`
- `apps/api/src/lib/uploads.ts`
- `packages/worker/src/worker.types.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/87_image_ingestion_layout_path.test.ts`
- `docs/roadmap.md`

**In scope:**

- Accept PNG, JPEG/JPG, and TIFF/TIF files in CLI ingest.
- Expand directory ingest discovery so directories can include PDFs and supported image files.
- Preserve magic-byte-first detection from Spec 85; misleading image extensions must not override decisive PDF or image magic bytes.
- Store image sources with `source_type = 'image'`, `page_count = 1`, `has_native_text = false`, `native_text_ratio = 0`, and `format_metadata` containing at least `media_type`, original extension, byte size, and best-effort `width` / `height` when cheaply available.
- Upload image originals under `raw/{source_id}/original.{ext}` with the detected media type.
- Keep duplicate detection based on the existing file hash path.
- Keep PDF ingest output and persistence backward compatible.
- Update cost estimation so images are counted as one scanned/layout page rather than being parsed as PDFs.
- Update API/browser upload initiation, completion validation, dev upload proxy, and worker finalization so supported image uploads reach the same source record and pipeline job path as CLI ingests.
- Update the Document AI service interface to accept a media type while defaulting existing PDF callers to `application/pdf`.
- Update extract so image sources always use the Document AI layout path, pass the stored image media type through the service interface, write `layout.json`, write a usable `pages/page-001.png` page image when possible, mark the source extracted, and leave `segment` as the next executable step.
- Keep the shared step planner behavior from Spec 86: `image` is a layout source and must not skip `segment`.

**Out of scope:**

- Text, DOCX, spreadsheet, email, URL ingestion. Those remain M9-J4 through M9-J10.
- URL rendering, robots/rate-limit lifecycle, and cross-format deduplication.
- Multi-page TIFF splitting beyond treating the uploaded image as one layout source unless Document AI returns multiple pages.
- New database columns or changes to the `sources.source_type` enum; Spec 85 already added `image`.
- New direct GCP client usage in pipeline, CLI, API, or worker code.
- Replacing the Segment step or changing story/entity/chunk contracts.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for Document AI, storage, Firestore, and Gemini calls.
- Unsupported or unknown files must fail before source creation.
- Existing PDF ingest, extract, upload, and pipeline behavior is the compatibility baseline.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `source_type`, `format_metadata`, and magic-byte detection.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `image` remains a layout source.
- M2-B4 / Spec 16 and M3-C1 / Spec 19: existing PDF ingest and extract implementation.
- M7 upload/worker follow-ups that introduced `document_upload_finalize` jobs.

**Blocks:**

- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

This step does not block pre-structured format ingestion, but it establishes the first non-PDF layout source.

## 4. Blueprint

### Phase 1: Shared image format helpers

1. Keep `detectSourceType()` as the source of truth for image detection.
2. Add helper behavior where needed to derive:
   - canonical media type (`image/png`, `image/jpeg`, `image/tiff`)
   - canonical storage extension (`png`, `jpg`, `tiff`)
   - best-effort dimensions for PNG and JPEG from file headers; TIFF dimensions may be omitted if not cheaply available.
3. Do not add a heavyweight image dependency unless the repository already has an appropriate runtime library available.

### Phase 2: CLI ingest

1. Replace PDF-only file discovery with supported-ingest-file discovery for PDFs plus PNG/JPEG/TIFF.
2. Split per-file ingest after source detection:
   - PDF follows the existing metadata, page-count, native-text, storage, duplicate, and output behavior.
   - Image follows the shared file-size and duplicate gates, stores one-page image metadata, uploads using the detected media type, and creates the source with image fields.
3. Keep the visible CLI table stable while allowing `Type = image`, `Pages = 1`, and `Native Text = no`.
4. Keep `--dry-run` validation from creating source rows or storage objects.
5. Update CLI cost estimation to include images as one scanned/layout page and to avoid running PDF native-text detection on images.

### Phase 3: API/browser upload path

1. Allow upload initiation for supported image filenames/content types in addition to PDFs.
2. Generate storage paths with the canonical original extension.
3. Relax completion schema validation from `original.pdf` to the supported `original.{ext}` path for the requested source.
4. Keep size checks and in-flight-finalize conflict checks unchanged.
5. Include enough payload or storage metadata for the worker to validate the uploaded bytes by magic bytes before creating a source row.
6. Preserve PDF upload behavior, including existing path shape for PDFs.

### Phase 4: Worker finalization

1. Replace PDF-only finalize validation with `detectSourceType()`.
2. For PDFs, preserve the current PDF metadata/native-text path.
3. For images, persist the same source fields as CLI ingest, upsert the ingest source step, emit Firestore observability with `sourceType: image`, and enqueue an `extract` job when `startPipeline` is true.
4. Reject recognized but unsupported non-image/non-PDF types with the existing unsupported source type error family.
5. Preserve duplicate cleanup behavior for image hashes.

### Phase 5: Extract image sources

1. Load the source row and branch by `source.sourceType`.
2. For `pdf`, preserve all current extraction paths.
3. For `image`, always use the Document AI path:
   - download the original image
   - read `formatMetadata.media_type` or fall back to source detection
   - call `services.documentAi.processDocument()` with that media type
   - parse Document AI layout output using the existing parser
   - run Gemini Vision fallback when low-confidence page text and a page image are available
   - write layout artifacts to `extracted/{source_id}/`
4. If Document AI returns page images, use them. Otherwise, write a normalized PNG page image for PNG/JPEG when possible; if normalization is unavailable, keep the source extracted with layout JSON and no page image rather than failing solely because of a preview byproduct.
5. Update service interface implementations so GCP passes the requested media type and dev mode remains deterministic.

### Phase 6: QA and compatibility

1. Add `tests/specs/87_image_ingestion_layout_path.test.ts`.
2. Reuse existing test helpers for CLI subprocesses, SQL checks, and dev storage where possible.
3. Run the existing PDF ingest/extract/pipeline planner tests that could regress from broadening the file discovery or service interface.

## 5. QA Contract

**QA-01: CLI dry-run accepts image sources without persistence**

Given a valid PNG, JPEG, and TIFF fixture, when `mulder ingest --dry-run` is run for each file, then the command exits 0, prints `Type` as `image`, prints `Pages` as `1`, and no `sources` row or storage object is created.

**QA-02: CLI image ingest persists image metadata**

Given a valid PNG file, when `mulder ingest` runs, then the command exits 0 and the database source row has `source_type = 'image'`, `page_count = 1`, `has_native_text = false`, `native_text_ratio = 0`, a `raw/{source_id}/original.png` storage path, and `format_metadata.media_type = 'image/png'`.

**QA-03: Directory ingest discovers PDFs and images**

Given a directory containing one PDF and one PNG, when `mulder ingest --dry-run <dir>` runs, then both files appear in the output with their respective source types and the command exits 0.

**QA-04: Magic bytes remain authoritative**

Given a PNG file renamed to `.pdf`, when `mulder ingest --dry-run` runs, then the command reports `image`, not `pdf`, and validates as an image source. Given a PDF renamed to `.png`, it still reports `pdf`.

**QA-05: Duplicate image ingest returns the existing source**

Given the same PNG file is ingested twice, when the second ingest runs, then it reports duplicate status, does not create a second source row for the same file hash, and preserves `source_type = 'image'`.

**QA-06: Image extract writes layout artifacts and keeps layout path**

Given an ingested image source in dev mode, when `mulder extract <source_id>` runs, then the source reaches `extracted`, `extracted/{source_id}/layout.json` exists, at least one page is represented in the extraction result, and the shared pipeline planner still includes `segment` for source type `image`.

**QA-07: API upload accepts image media types**

Given an upload initiate request for `scan.png` with `content_type = image/png`, when the upload is completed and the finalize job runs, then a source row is created with `source_type = 'image'` and an extract job is queued when `start_pipeline` is true.

**QA-08: Unsupported formats still fail before persistence**

Given a `.txt` file, when `mulder ingest` or upload finalization processes it during M9-J3, then it fails with an unsupported source type message and no source row is created.

**QA-09: Existing PDF behavior remains green**

Given the existing Spec 16, Spec 19, Spec 85, and Spec 86 PDF-oriented tests, when they run after this change, then PDF ingest, extract, duplicate handling, upload finalization, and pipeline planning remain compatible.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run <tmp>/scan.png` | PNG image | Exit 0; output includes `image`, `Pages` = `1`; no DB/storage persistence. |
| `mulder ingest <tmp>/scan.png` | PNG image | Exit 0; DB row has `source_type = image`; storage path ends in `original.png`. |
| `mulder ingest --dry-run <tmp>/mixed-dir` | Directory with PDF + PNG | Exit 0; output includes both `pdf` and `image`. |
| `mulder ingest --dry-run <tmp>/png-renamed.pdf` | PNG magic with `.pdf` extension | Exit 0; output reports `image`, proving magic bytes win. |
| `mulder extract <image-source-id>` | Ingested image source | Exit 0; layout artifacts written; source status becomes `extracted`. |

## 6. Cost Considerations

Images use the scanned/layout extraction path and therefore may call paid Document AI and Gemini Vision services during extract. Ingest itself remains local plus storage/database work. CLI cost estimation must count each image as one scanned/layout page so users see downstream extract/segment/enrich/embed cost before a large image batch runs. Dev and test mode must continue to use deterministic service implementations without GCP cost.
