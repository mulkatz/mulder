---
spec: "87"
title: "Image Ingestion — JPG, PNG, TIFF via Document AI / Gemini Vision"
roadmap_step: M9-J3
functional_spec: ["§2.1", "§2.2", "§2", "§3", "§4.5"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/251"
created: 2026-05-04
---

# Spec 87: Image Ingestion — JPG, PNG, TIFF via Document AI / Gemini Vision

## 1. Objective

Enable the pipeline to accept raster image files (JPG, PNG, TIFF) as first-class source documents. Images flow through the same Document AI / Gemini Vision extraction path as scanned PDFs — treated as single-page documents — and produce identical `layout.json` + page image artifacts that the downstream segment and enrich steps consume without modification.

This satisfies M9-J3 from the roadmap. The change is additive: it broadens the ingest step's accepted formats and adds an image extraction path to the extract step. Existing PDF behavior is fully preserved.

**Key constraint from the roadmap:** "Images — Single-page PDF path essentially. Same Document AI / Gemini Vision pipeline, simpler."

## 2. Boundaries

**Roadmap step:** M9-J3 — Image ingestion: JPG, PNG, TIFF via Document AI / Gemini Vision.

**Target files:**

- `packages/core/src/shared/services.ts` — add optional `mimeType?` to `DocumentAiService.processDocument()`
- `packages/core/src/shared/services.gcp.ts` — pass `mimeType` to Document AI rawDocument request
- `packages/core/src/shared/services.dev.ts` — accept (and ignore) `mimeType` parameter
- `packages/pipeline/src/ingest/index.ts` — add `resolveSourceFiles`, extend directory scanning, add image ingest path, update `execute` + pipeline orchestrator import
- `packages/pipeline/src/pipeline/index.ts` — update dry-run count to use `resolveSourceFiles`
- `packages/pipeline/src/index.ts` — export `resolveSourceFiles`
- `packages/pipeline/src/extract/index.ts` — add image extraction path
- `tests/specs/87_image_ingestion.test.ts`

**In scope:**

- Accept `image/png`, `image/jpeg`, and `image/tiff` files in `mulder ingest`.
- Skip PDF-specific validation for images: no PDF metadata extraction, no native-text detection, no page-count bomb check. Store `pageCount: 1`, `hasNativeText: false`, `nativeTextRatio: 0`.
- Store images with `source_type = 'image'` and `format_metadata` containing `media_type` and `file_size_bytes`.
- Broaden directory scanning in `resolveSourceFiles` to include `.jpg`, `.jpeg`, `.png`, `.tif`, `.tiff` in addition to `.pdf`. Keep `resolvePdfFiles` as a re-exported alias for backward compatibility.
- Add an image extraction path to the extract step that: downloads the image buffer, sends it to Document AI with the correct MIME type, treats the response as a single page, stores the original image as `pages/page-001.png`, applies the Gemini Vision fallback if confidence is below threshold.
- Extend the `DocumentAiService.processDocument()` interface with an optional `mimeType?` parameter (default: `'application/pdf'`). Update both GCP and dev implementations.
- Add image fixtures (`fixtures/raw/test-image.png`, `fixtures/raw/test-image.jpg`) for test use.

**Out of scope:**

- DOCX, text, spreadsheet, email, or URL ingestion (J4–J10).
- Format-aware extract routing dispatcher (J11).
- Cross-format deduplication (J12).
- Extracting image dimensions or EXIF metadata (not required by the spec).
- Changing the `SourceStatus` state machine or segment step behavior — images use the same pipeline flow as PDFs (ingest → extract → segment → enrich).
- Any Terraform or GCP infrastructure changes.

**Architectural constraints:**

- `DocumentAiService.processDocument()` remains backward-compatible: callers that omit `mimeType` continue to work without change.
- The image extraction path must produce the same `layout.json` schema as the PDF path — no schema divergence.
- Pipeline steps always use service interfaces, never direct GCP SDK calls.
- The page image stored at `pages/page-001.png` must be a PNG buffer — convert JPEG/TIFF source buffers to PNG using `@napi-rs/canvas` if needed, or store JPEG/TIFF as-is when the downstream segment step only needs a recognizable image format.
- For TIFF: convert to PNG before storing the page image (Gemini Vision and Document AI accept both, but PNG is the canonical page image format in the extract output).

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85 — `source_type = 'image'` already in the database enum, `detectSourceType()` already returns `'image'` for PNG/JPEG/TIFF magic bytes.
- M9-J2 / Spec 86 — `isPreStructuredType()` already classifies `image` as a normal-pipeline type (not pre-structured).
- M2-B7 / Spec 19 — Extract step with Document AI path to extend.

**Blocks:**

- M9-J11 — Format-aware extract routing can only dispatch images after J3 defines the image extraction path.
- M9-J13 — Golden tests for multi-format need image fixtures established by J3.

## 4. Blueprint

### Phase 1: Service interface — optional mimeType parameter

**`packages/core/src/shared/services.ts`** — Update the `DocumentAiService` interface:

```typescript
export interface DocumentAiService {
  /** Process a document and return structured layout data + page images.
   *  @param mimeType - MIME type of the content (default: 'application/pdf')
   */
  processDocument(
    content: Buffer,
    sourceId: string,
    mimeType?: string,
  ): Promise<DocumentAiResult>;
}
```

**`packages/core/src/shared/services.gcp.ts`** — Update `GcpDocumentAiService.processDocument()`:

```typescript
async processDocument(
  content: Buffer,
  sourceId: string,
  mimeType: string = 'application/pdf',
): Promise<DocumentAiResult> {
  // Replace hardcoded 'application/pdf' with the mimeType parameter
  const request = {
    name: this.processorName,
    rawDocument: {
      content: content.toString('base64'),
      mimeType,                      // ← was hardcoded 'application/pdf'
    },
  };
  // rest unchanged
}
```

**`packages/core/src/shared/services.dev.ts`** — Update `DevDocumentAiService.processDocument()` signature to accept (and ignore) the third parameter:

```typescript
async processDocument(
  _content: Buffer,
  sourceId: string,
  _mimeType?: string,
): Promise<DocumentAiResult>
```

### Phase 2: Ingest extension — accept images

**`packages/pipeline/src/ingest/index.ts`**:

1. Add `resolveSourceFiles(inputPath: string): Promise<string[]>` alongside `resolvePdfFiles`:
   - Single file: return `[resolved]` for any file (same as before).
   - Directory: scan recursively for `.pdf`, `.jpg`, `.jpeg`, `.png`, `.tif`, `.tiff` extensions (case-insensitive).
   - Sort results for deterministic ordering.

2. Keep `resolvePdfFiles` as an exported alias pointing to `resolveSourceFiles` for backward compatibility:
   ```typescript
   export { resolveSourceFiles as resolvePdfFiles };
   ```

3. Update `execute()` to call `resolveSourceFiles` instead of the old internal call.

4. In `processFile()`, remove the early rejection of `sourceType !== 'pdf'`. Replace the binary guard with an allowlist check:
   ```typescript
   if (sourceType !== 'pdf' && sourceType !== 'image') {
     throw new IngestError(
       `Unsupported source type "${sourceType}" for ${filename}; only pdf and image are supported in this step`,
       INGEST_ERROR_CODES.INGEST_UNSUPPORTED_SOURCE_TYPE,
       { context: { path: filePath, sourceType, confidence: detection.confidence } },
     );
   }
   ```

5. After the source-type check, branch on `sourceType`:

   **PDF path (unchanged):** Keep existing PDF metadata extraction, native-text detection, page-count bomb check, etc.

   **Image path (new):**
   - Skip `extractPdfMetadata`, `detectNativeText`, and page-count check.
   - Build `formatMetadata`:
     ```typescript
     const formatMetadata: Record<string, unknown> = {
       media_type: detection.mediaType ?? 'application/octet-stream',
       file_size_bytes: buffer.length,
     };
     ```
   - Set `pageCount = 1`, `hasNativeText = false`, `nativeTextRatio = 0`.
   - Upload with the detected media type (e.g., `image/png`) as the Content-Type.
   - Storage path: `raw/{sourceId}/original.{ext}` where `ext` is derived from the detected media type:
     - `image/png` → `original.png`
     - `image/jpeg` → `original.jpg`
     - `image/tiff` → `original.tiff`
   - Call `createSource()` with `sourceType: 'image'`, `pageCount: 1`, `hasNativeText: false`, `nativeTextRatio: 0`, `formatMetadata`.
   - Note: `pdfMetadata` field on `IngestFileResult` remains optional and is omitted for images — no type change needed.

### Phase 3: Extract extension — image path

**`packages/pipeline/src/extract/index.ts`**:

After loading the source record and validating its status, check `source.sourceType`:

```typescript
if (source.sourceType === 'image') {
  extractionData = await extractImage(input, source, services, config, pool, log, errors);
} else {
  // existing PDF extraction logic (unchanged)
}
```

Add a new private function `extractImage()`:

```typescript
async function extractImage(
  input: ExtractInput,
  source: Source,
  services: Services,
  config: MulderConfig,
  pool: pg.Pool,
  log: Logger,
  errors: StepError[],
): Promise<ExtractionData>
```

Logic inside `extractImage()`:

1. Download the image buffer from `source.storagePath`.
2. Determine the MIME type from `source.formatMetadata.media_type` (fallback: `'image/jpeg'`).
3. Call `services.documentAi.processDocument(imageBuffer, source.id, mimeType)`.
4. Parse the single-page Document AI result using the existing `parseDocumentAiResult()` — it handles any number of pages, single-page is a subset.
5. Build a single `LayoutPage` from the parsed result (pageNumber: 1).
6. If `page.confidence < config.extraction.confidence_threshold`: run the Gemini Vision fallback using `runVisionFallback()` — pass the original image buffer as the page image.
7. The page image to store at `pages/page-001.png` is the original image buffer (no conversion needed if PNG; for JPEG/TIFF, store as-is and upload with `image/png` content type only if converted — for simplicity, store as-is for JPEG and convert TIFF to PNG):
   - `image/png` → upload buffer as-is with `image/png`
   - `image/jpeg` → upload buffer as-is with `image/jpeg` (rename the path to `page-001.jpg` is NOT done — keep consistent `page-001.png` naming by converting using `@napi-rs/canvas`)
   
   **Decision:** Always store page images as PNG for consistency. Convert JPEG and TIFF to PNG using `@napi-rs/canvas`. The `createCanvas` + `loadImage` approach already available in the extract step can handle this.

8. Build `LayoutDocument` with `pageCount: 1`, `primaryMethod: 'document_ai'`.
9. Write `layout.json` + `pages/page-001.png` to GCS using the existing `writeToStorage()` helper.
10. Update source status to `'extracted'`, upsert source step.

For converting JPEG/TIFF to PNG:
```typescript
import { createCanvas, loadImage } from '@napi-rs/canvas';

async function toPNG(imageBuffer: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType === 'image/png') return imageBuffer;
  const img = await loadImage(imageBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return canvas.toBuffer('image/png');
}
```

### Phase 4: Pipeline orchestrator dry-run update

**`packages/pipeline/src/pipeline/index.ts`**:

Update the dry-run source count to use `resolveSourceFiles` (import name change only — the alias keeps it backward-compatible, so the import can stay as `resolvePdfFiles` if the alias is set up, or switch to `resolveSourceFiles`).

### Phase 5: Test fixtures + test file

Add test fixtures:
- `fixtures/raw/test-image.png` — a small valid PNG (can be generated programmatically in the test setup or committed as a real 1x1 PNG)
- `fixtures/raw/test-image.jpg` — a small valid JPEG

**`tests/specs/87_image_ingestion.test.ts`** — black-box tests using CLI subprocesses and SQL. Never import from `packages/`.

## 5. QA Contract

**QA-01: PNG file is accepted by ingest**

Given `fixtures/raw/test-image.png`, when `mulder ingest fixtures/raw/test-image.png` is run, then the command exits 0, prints type `image`, and the `sources` table contains a row with `source_type = 'image'`, `page_count = 1`, `has_native_text = false`, `native_text_ratio = 0`.

**QA-02: JPEG file is accepted by ingest**

Given `fixtures/raw/test-image.jpg`, when `mulder ingest fixtures/raw/test-image.jpg` is run, then it exits 0, prints type `image`, and a `sources` row exists with `source_type = 'image'`.

**QA-03: Image format metadata is stored**

Given an ingested image source, when the `sources` row is queried, then `format_metadata` contains `media_type` (e.g., `image/png`) and `file_size_bytes` (a positive integer).

**QA-04: Image source has correct pipeline defaults**

Given an ingested image source, when the `sources` row is queried, then `page_count = 1`, `has_native_text = false`, `native_text_ratio = 0`.

**QA-05: Directory scanning includes images**

Given a temporary directory containing one `.pdf` and one `.png`, when `mulder ingest <dir>` is run, then the command exits 0 and two source rows exist — one with `source_type = 'pdf'` and one with `source_type = 'image'`.

**QA-06: Duplicate image detection**

Given a PNG file already ingested, when the same file is ingested again, then the command exits 0, the output marks it as a duplicate, and `sources` still contains exactly one row for that file hash.

**QA-07: Unsupported type still rejected**

Given a `.txt` file, when `mulder ingest` is run, then it exits non-zero with an unsupported source type error and no source row is created — unchanged behavior from J1.

**QA-08: Image extraction produces layout artifacts**

Given an ingested image source (status `ingested`), when `mulder extract <sourceId>` is run in dev mode, then it exits 0, and `storage.download('extracted/<sourceId>/layout.json')` succeeds and parses as valid JSON with `pageCount = 1`.

**QA-09: Image extraction stores page image**

Given an extracted image source, when the GCS path `extracted/<sourceId>/pages/page-001.png` is downloaded, then the buffer is a non-empty PNG.

**QA-10: Existing PDF extraction tests still pass**

Given the Spec 19 (extract) and Spec 16 (ingest) test suites, when they are run after this change, then all existing assertions still pass.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest fixtures/raw/test-image.png` | Valid PNG | Exit 0, output includes `Type` = `image`, DB row `source_type = 'image'`. |
| `mulder ingest fixtures/raw/test-image.jpg` | Valid JPEG | Exit 0, output includes `Type` = `image`. |
| `mulder ingest <dir>` (mixed PDF + image) | Directory with PDF + PNG | Exit 0, two source rows with correct types. |
| `mulder ingest fixtures/raw/test-image.png` twice | Duplicate PNG | Exit 0 both times, second marked duplicate, one source row. |
| `mulder ingest <tmp>/not-an-image.txt` | Text file | Non-zero exit, unsupported type error, no source row. |
| `mulder extract <image-source-id>` | Ingested image source | Exit 0, layout.json accessible in storage with `pageCount = 1`. |

## 6. Cost Considerations

- Ingest: no GCP calls (local file reading and storage upload only — same as PDF).
- Extract: one Document AI call per image at approximately the same cost as a single-page PDF (`$1.50 / 1000 pages`). Gemini Vision fallback applies only if confidence is below threshold (rare for clean image scans).
- No migration — `source_type = 'image'` already exists in the database discriminator from J1.
