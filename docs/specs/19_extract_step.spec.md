---
spec: 19
title: Extract Step
roadmap_step: M2-B7
functional_spec: §2.2, §4.4
scope: single
issue: https://github.com/mulkatz/mulder/issues/38
created: 2026-03-31
---

# Spec 19 — Extract Step

## 1. Objective

Implement the `mulder extract <source-id>` command — the second pipeline step that takes ingested PDF sources and produces structured layout data with spatial information and page images. This step bridges raw PDFs to the Segment step by outputting Document AI Structured JSON (bounding boxes, reading order, confidence) and rendered page images to GCS.

Three extraction paths based on native text ratio:
- **Native text path** (ratio >= threshold): Extract text locally via `pdf-parse`, render page images from PDF. No Document AI cost.
- **Document AI path** (ratio < threshold): Send to Document AI Layout Parser for OCR + spatial layout analysis. Page images come from the API response.
- **Gemini Vision fallback**: For Document AI pages with low confidence, send page images to Gemini for corrected text. Circuit-breaker capped at `max_vision_pages`.

## 2. Boundaries

### In scope
- Pipeline step module: `packages/pipeline/src/extract/index.ts`
- Input types: `ExtractInput`, output types: `ExtractResult`, `ExtractionData`, `PageExtraction`
- Native text detection threshold check (uses existing `source.native_text_ratio` from ingest)
- Native text extraction via `pdf-parse` for high native-text sources
- Document AI extraction via `DocumentAiService` interface for scanned sources
- Gemini Vision fallback for low-confidence Document AI pages via `LlmService`
- Page image rendering for native text path (PDF pages → PNG via `pdf-to-img`)
- Confidence threshold config: `extraction.confidence_threshold` (new config field)
- Vision fallback prompt template: `templates/vision-fallback.jinja2`
- Output to GCS: `extracted/{doc-id}/layout.json` + `extracted/{doc-id}/pages/page-{NNN}.png`
- Source status update: `ingested` → `extracted` (PostgreSQL authoritative)
- Source step tracking via `upsertSourceStep()`
- Firestore observability projection (fire-and-forget)
- CLI command: `mulder extract <source-id>` with `--all`, `--force`, `--fallback-only`
- `--force` triggers cascading reset via `reset_pipeline_step()` before re-extraction
- New error codes for extract-specific failures
- Structured logging (step start/complete, per-page progress, extraction method)

### Out of scope
- Segment step (M3-C2) — layout.json and page images are consumed there
- Cost estimation on `extract` command (M8-I2)
- Image-only source types (M9-J3) — only PDF sources handled
- `reset_pipeline_step()` PL/pgSQL function (M3-C9) — `--force` will use a simpler application-level delete for now

### Deviation from functional spec
- **`--force` cascading reset:** The functional spec references `reset_pipeline_step()` PL/pgSQL function (§4.3.1, M3-C9), which doesn't exist yet. For now, `--force` performs application-level cleanup: delete GCS `extracted/{doc-id}/` prefix, then update source status back to `ingested` and delete the extract source_step. Full cascading reset (stories, chunks, edges) will be added when `reset_pipeline_step()` is implemented.
- **Page image rendering for native text path:** The functional spec doesn't explicitly call out how page images are generated when Document AI is skipped. We use `pdf-to-img` (a thin wrapper around `pdfjs-dist` canvas rendering) to render pages as PNGs. This ensures the Segment step always has page images regardless of extraction path.

## 3. Dependencies

### Requires (must exist)
- `@mulder/core` — source repository (`findSourceById`, `updateSourceStatus`, `upsertSourceStep`, `findAllSources`)
- `@mulder/core` — service interfaces (`StorageService`, `DocumentAiService`, `LlmService`, `FirestoreService`)
- `@mulder/core` — service registry (`createServiceRegistry`)
- `@mulder/core` — config loader (`loadConfig`) with `extraction` section
- `@mulder/core` — error classes (`PipelineError`, `ExternalServiceError`)
- `@mulder/core` — logger (`createLogger`, `createChildLogger`)
- `@mulder/core` — prompt template engine (`renderPrompt`)
- `@mulder/core` — native text detection (`detectNativeText`) — used at extraction time for the native path
- `@mulder/pipeline` — ingest step (sources must be ingested first)
- CLI scaffold in `apps/cli/` with Commander.js

### Required by (future steps)
- M3-C2: Segment step — reads `extracted/{doc-id}/layout.json` and page images from GCS
- M2-B8: Fixture generator — may use extract output as fixture source

## 4. Blueprint

### 4.1 Config schema addition

Add `confidence_threshold` to the extraction config in `packages/core/src/config/schema.ts`:

```typescript
const extractionObj = z.object({
  native_text_threshold: z.number().min(0).max(1).default(0.9),
  confidence_threshold: z.number().min(0).max(1).default(0.85),
  max_vision_pages: z.number().positive().int().default(20),
  segmentation: segmentationConfigSchema.default(defaults(segmentationConfigSchema)),
});
```

`confidence_threshold` determines when a Document AI page triggers Gemini Vision fallback. Pages with Document AI confidence below this threshold are sent to Gemini Vision for corrected text.

### 4.2 New error codes

Add extract-specific error codes to `packages/core/src/shared/errors.ts`:

```typescript
export const EXTRACT_ERROR_CODES = {
  EXTRACT_SOURCE_NOT_FOUND: 'EXTRACT_SOURCE_NOT_FOUND',
  EXTRACT_INVALID_STATUS: 'EXTRACT_INVALID_STATUS',
  EXTRACT_DOCUMENT_AI_FAILED: 'EXTRACT_DOCUMENT_AI_FAILED',
  EXTRACT_VISION_FALLBACK_FAILED: 'EXTRACT_VISION_FALLBACK_FAILED',
  EXTRACT_NATIVE_TEXT_FAILED: 'EXTRACT_NATIVE_TEXT_FAILED',
  EXTRACT_STORAGE_FAILED: 'EXTRACT_STORAGE_FAILED',
  EXTRACT_PAGE_RENDER_FAILED: 'EXTRACT_PAGE_RENDER_FAILED',
} as const;

export type ExtractErrorCode = (typeof EXTRACT_ERROR_CODES)[keyof typeof EXTRACT_ERROR_CODES];
```

Add `ExtractErrorCode` to the `MulderErrorCode` union. Create `ExtractError extends MulderError`.

### 4.3 Pipeline step types

**File:** `packages/pipeline/src/extract/types.ts`

```typescript
export interface ExtractInput {
  sourceId: string;          // Single source to extract
  force?: boolean;           // Force re-extraction (cascading delete first)
  fallbackOnly?: boolean;    // Only run Gemini Vision fallback
}

export type ExtractionMethod = 'native' | 'document_ai' | 'vision_fallback';

export interface PageExtraction {
  pageNumber: number;
  method: ExtractionMethod;
  confidence: number;        // 0-1, confidence in the extraction quality
  text: string;              // Extracted text for this page
}

export interface ExtractionData {
  sourceId: string;
  layoutUri: string;               // GCS URI: extracted/{doc-id}/layout.json
  pageImageUris: string[];         // GCS URIs: extracted/{doc-id}/pages/page-NNN.png
  pageCount: number;
  primaryMethod: 'native' | 'document_ai';
  pages: PageExtraction[];
  visionFallbackCount: number;     // How many pages used Gemini Vision
  visionFallbackCapped: boolean;   // true if circuit breaker hit
}

export interface ExtractResult {
  status: 'success' | 'partial' | 'failed';
  data: ExtractionData | null;
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;       // Pages processed
    items_skipped: number;         // Pages skipped (e.g., high confidence = no vision needed)
    items_cached: number;          // LLM cache hits (vision fallback, dev mode)
  };
}
```

### 4.4 Pipeline step module

**File:** `packages/pipeline/src/extract/index.ts`

Exports a single `execute` function following the global step contract:

```typescript
export async function execute(
  input: ExtractInput,
  config: MulderConfig,
  services: Services,
  pool: pg.Pool | undefined,
  logger: Logger,
): Promise<ExtractResult>
```

**`execute()` flow:**

1. **Load source:** `findSourceById(pool, input.sourceId)` — fail with `EXTRACT_SOURCE_NOT_FOUND` if null.
2. **Validate status:** Source must have `status >= 'ingested'`. If already `extracted` and not `--force`, skip with info log. If `--force`, clean up first (see 4.7).
3. **Download PDF:** `services.storage.download(`raw/${sourceId}/original.pdf`)` → Buffer.
4. **Choose extraction path** based on `source.native_text_ratio` vs `config.extraction.native_text_threshold`:

   **Path A — Native text (ratio >= threshold):**
   a. Extract text per page via `pdf-parse` (or re-use `detectNativeText` with page-level output)
   b. Render page images from PDF buffer using `pdf-to-img` library
   c. Build layout.json with text content per page (no bounding boxes — native text doesn't have spatial data from Document AI, but has reading-order text)
   d. Set `primaryMethod: 'native'`, all pages get `method: 'native'`, `confidence: 1.0`

   **Path B — Document AI (ratio < threshold):**
   a. Call `services.documentAi.processDocument(pdfBuffer, sourceId)` → `DocumentAiResult`
   b. The result contains `document` (structured JSON with bounding boxes, reading order, confidence per block) and `pageImages` (rendered page buffers)
   c. Parse per-page confidence from Document AI response
   d. For pages with confidence < `config.extraction.confidence_threshold`:
      - If `visionFallbackCount < config.extraction.max_vision_pages`:
        - Render prompt via `renderPrompt('vision-fallback', { page_text, confidence })`
        - Call `services.llm.generateText({ prompt, media: [{ mimeType: 'image/png', data: pageImage }] })`
        - Merge corrected text into the layout data for that page
        - Set page `method: 'vision_fallback'`
        - Increment `visionFallbackCount`
      - Else: keep Document AI text as-is, set `visionFallbackCapped: true`, log warning
   e. Set `primaryMethod: 'document_ai'`

   **Path C — Fallback only (`--fallback-only`):**
   a. Source must already be `extracted` (layout.json exists)
   b. Download existing layout.json from GCS
   c. Re-run only the Gemini Vision fallback on low-confidence pages
   d. Upload updated layout.json

5. **Write to GCS:**
   - `services.storage.upload(`extracted/${sourceId}/layout.json`, JSON.stringify(layoutData), 'application/json')`
   - For each page image: `services.storage.upload(`extracted/${sourceId}/pages/page-${padded}.png`, imageBuffer, 'image/png')`
   - Page numbering: zero-padded 3 digits (`page-001.png`, `page-002.png`, ...)

6. **Update database:**
   - `updateSourceStatus(pool, sourceId, 'extracted')`
   - `upsertSourceStep(pool, { sourceId, stepName: 'extract', status: 'completed' })`

7. **Firestore observability (fire-and-forget):**
   ```typescript
   services.firestore.setDocument('documents', sourceId, {
     status: 'extracted',
     extractedAt: new Date().toISOString(),
     primaryMethod,
     pageCount,
     visionFallbackCount,
     visionFallbackCapped,
   }).catch(() => { /* non-fatal */ });
   ```

8. **Return** `ExtractResult` with GCS URIs, per-page extraction details, and timing metadata.

### 4.5 Layout JSON format

The `layout.json` output is a normalized format that the Segment step consumes:

```typescript
interface LayoutDocument {
  sourceId: string;
  pageCount: number;
  primaryMethod: 'native' | 'document_ai';
  extractedAt: string;           // ISO 8601
  pages: LayoutPage[];
  metadata: {
    visionFallbackCount: number;
    visionFallbackCapped: boolean;
    documentAiRaw?: Record<string, unknown>;  // Original Document AI response (only for document_ai path)
  };
}

interface LayoutPage {
  pageNumber: number;            // 1-indexed
  method: ExtractionMethod;
  confidence: number;
  text: string;                  // Full page text (reading order)
  blocks?: LayoutBlock[];        // Only present for document_ai method
}

interface LayoutBlock {
  text: string;
  type: string;                  // paragraph, heading, table, list, etc.
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
}
```

For native text extraction, `blocks` is omitted (no spatial data). For Document AI, blocks include bounding boxes and reading order.

### 4.6 Vision fallback prompt template

**File:** `packages/core/src/prompts/templates/vision-fallback.jinja2`

```
{{ i18n.vision_fallback.system_role }}

## Context
{{ i18n.vision_fallback.context_description }}

The automated OCR system extracted the following text with low confidence ({{ confidence }}):

---
{{ page_text }}
---

## Task
{{ i18n.vision_fallback.task_description }}

{{ i18n.common.language_instruction }}
```

**i18n keys** (add to `en.json` and `de.json`):
- `vision_fallback.system_role`: "You are an expert document OCR correction system."
- `vision_fallback.context_description`: "You are reviewing a page image alongside low-confidence OCR text."
- `vision_fallback.task_description`: "Examine the page image and correct any OCR errors in the extracted text. Preserve the original formatting, paragraph breaks, and reading order. Return only the corrected text, nothing else."

### 4.7 Force re-extraction

When `--force` is passed:
1. Delete GCS prefix `extracted/${sourceId}/` via `services.storage.list()` + `services.storage.delete()` for each file
2. Update source status back to `ingested` (or let the extract step overwrite)
3. Delete the extract source_step record (so it re-tracks as new)
4. Proceed with normal extraction

Note: Full cascading reset (deleting downstream stories, chunks, edges) is deferred to M3-C9 when `reset_pipeline_step()` PL/pgSQL function is implemented.

### 4.8 Batch extraction (`--all`)

When `--all` is passed instead of a `source-id`:
1. Query all sources with `status = 'ingested'` via `findAllSources(pool, { status: 'ingested' })`
2. Process each source sequentially (respects rate limits)
3. Per-source errors are caught — processing continues for remaining sources
4. Overall result: `success` if all pass, `partial` if some fail, `failed` if all fail

### 4.9 CLI command

**File:** `apps/cli/src/commands/extract.ts`

```
mulder extract <source-id>
  --all               Extract all sources with status=ingested
  --force             Re-extract even if already extracted
  --fallback-only     Only run Gemini Vision fallback on low-confidence pages
```

Thin wrapper:
1. Parse arguments — `source-id` and `--all` are mutually exclusive
2. Load and validate config
3. Get database pool via `getWorkerPool(config)`
4. Create service registry
5. If `--all`: query sources, loop calling `execute()` for each
6. If single source-id: call `execute()` once
7. Format and print results (table: sourceId, pages, method, visionFallback, status)
8. Close pools on exit

### 4.10 Package dependencies

Add to `packages/pipeline/package.json`:
- `pdf-to-img` — PDF page rendering to PNG (for native text path)
- `pdf-parse` — already a dependency from ingest, used for native text extraction

### 4.11 Barrel exports

Update `packages/pipeline/src/index.ts`:
```typescript
export type { ExtractInput, ExtractResult, ExtractionData, PageExtraction } from './extract/index.js';
export { execute as executeExtract } from './extract/index.js';
```

### 4.12 Integration wiring

- `apps/cli/src/commands/extract.ts` — new CLI command file
- `apps/cli/src/index.ts` — register `registerExtractCommands(program)`

## 5. QA Contract

Black-box tests interact via CLI execution and database queries only. No imports from `packages/`.

### Conditions

**QA-01: Single source extraction (native text)**
- Given: An ingested source with `native_text_ratio >= 0.9` (high native text)
- When: `mulder extract <source-id>` is executed
- Then: Exit code 0, source status in database is `extracted`, layout.json exists in GCS at `extracted/{source-id}/layout.json`

**QA-02: Page images generated**
- Given: A successfully extracted source
- When: Checking GCS for `extracted/{source-id}/pages/`
- Then: One PNG file per page exists with naming pattern `page-NNN.png` (zero-padded 3 digits)

**QA-03: Layout JSON structure**
- Given: A successfully extracted source
- When: Reading `extracted/{source-id}/layout.json` from GCS
- Then: JSON contains `sourceId`, `pageCount`, `primaryMethod`, `extractedAt`, and `pages` array with one entry per page, each having `pageNumber`, `method`, `confidence`, `text`

**QA-04: Source step tracking**
- Given: A successfully extracted source
- When: Querying `source_steps` for the source
- Then: Row exists with `step_name='extract'`, `status='completed'`

**QA-05: Status validation — rejects non-ingested**
- Given: A source-id that does not exist (or has not been ingested)
- When: `mulder extract <invalid-id>` is executed
- Then: Exit code non-zero, output contains error about source not found or invalid status

**QA-06: Already extracted — skip without force**
- Given: A source that is already `extracted`
- When: `mulder extract <source-id>` is executed (no `--force`)
- Then: Exit code 0, output indicates source already extracted, no re-processing occurs

**QA-07: Force re-extraction**
- Given: A source that is already `extracted`
- When: `mulder extract <source-id> --force` is executed
- Then: Exit code 0, source is re-extracted, source status is `extracted`, layout.json is refreshed

**QA-08: Batch extraction (--all)**
- Given: Multiple ingested sources in the database
- When: `mulder extract --all` is executed
- Then: Exit code 0, all ingested sources now have status `extracted`

**QA-09: Extraction method recorded per page**
- Given: A successfully extracted source
- When: Reading layout.json
- Then: Each page in the `pages` array has a `method` field that is one of `native`, `document_ai`, or `vision_fallback`

**QA-10: Idempotent extraction with force**
- Given: A source extracted with `--force` twice
- When: Checking the final state
- Then: Source status is `extracted`, layout.json exists, no duplicate records in source_steps
