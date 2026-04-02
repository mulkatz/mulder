---
spec: 16
title: Ingest Step
roadmap_step: M2-B4
functional_spec: §2.1, §4.3 (sources), §1 (ingest cmd)
scope: single
issue: https://github.com/mulkatz/mulder/issues/32
created: 2026-03-31
---

# Spec 16 — Ingest Step

## 1. Objective

Implement the `mulder ingest <path>` command — the first pipeline step that accepts PDF files (single file or directory), validates them, detects native text, uploads to Cloud Storage, and registers them as sources in PostgreSQL. This is the entry point for all documents into the Mulder pipeline.

The ingest step must work in both GCP mode (real uploads) and dev mode (fixture-based storage). It produces `SourceRecord[]` with IDs, storage paths, and native text flags ready for the Extract step.

## 2. Boundaries

### In scope
- Pipeline step module: `packages/pipeline/src/ingest/index.ts`
- Pre-flight validation: file size, page count, magic bytes (`%PDF-`)
- Native text detection via existing `detectNativeText()` from `@mulder/core`
- Cloud Storage upload via `StorageService` interface (not direct GCP SDK)
- Source record creation via existing `createSource()` repository function
- Source step tracking via existing `upsertSourceStep()` repository function
- Firestore observability projection (fire-and-forget)
- SHA-256 file hash for dedup (via `createSource`'s `ON CONFLICT` on `file_hash`)
- CLI command: `mulder ingest <path>` with `--dry-run`, `--tag`, `--cost-estimate`
- Directory scanning: recursively find all `.pdf` files when `<path>` is a directory
- Structured logging via pino (step start/complete, per-file progress)
- New error codes for ingest-specific failures

### Out of scope
- `--watch` mode (future enhancement)
- Cost estimation logic (M8-I2, stub the flag to print "not yet implemented")
- Multi-format ingestion (M9)
- Any processing beyond ingest (extract, segment, etc.)

### Deviation from functional spec
- `pdfinfo` (poppler-utils) is NOT used for page count pre-check. Instead, the existing `detectNativeText()` already parses the PDF and returns `pageCount`. We use this for both native text detection AND page count validation, avoiding a second parse and an external binary dependency.

## 3. Dependencies

### Requires (must exist)
- `@mulder/core` — source repository (`createSource`, `findSourceByHash`, `upsertSourceStep`)
- `@mulder/core` — native text detection (`detectNativeText`)
- `@mulder/core` — service interfaces (`StorageService`, `FirestoreService`)
- `@mulder/core` — service registry (`createServiceRegistry`)
- `@mulder/core` — config loader (`loadConfig`) with `ingestion` section
- `@mulder/core` — error classes (`PipelineError`, `PIPELINE_ERROR_CODES`)
- `@mulder/core` — logger (`createLogger`, `createChildLogger`)
- CLI scaffold in `apps/cli/` with Commander.js

### Required by (future steps)
- M2-B7: Extract step — reads sources with `status=ingested`
- M2-B8: Fixture generator — may use ingest as input

## 4. Blueprint

### 4.1 New error codes

Add ingest-specific error codes to `packages/core/src/shared/errors.ts`:

```typescript
export const INGEST_ERROR_CODES = {
  INGEST_FILE_NOT_FOUND: 'INGEST_FILE_NOT_FOUND',
  INGEST_NOT_PDF: 'INGEST_NOT_PDF',
  INGEST_FILE_TOO_LARGE: 'INGEST_FILE_TOO_LARGE',
  INGEST_TOO_MANY_PAGES: 'INGEST_TOO_MANY_PAGES',
  INGEST_UPLOAD_FAILED: 'INGEST_UPLOAD_FAILED',
  INGEST_DUPLICATE: 'INGEST_DUPLICATE',
} as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[keyof typeof INGEST_ERROR_CODES];
```

Add `IngestErrorCode` to the `MulderErrorCode` union. Create `IngestError extends MulderError`.

### 4.2 Pipeline step module

**File:** `packages/pipeline/src/ingest/index.ts`

Exports a single `execute` function following the global step contract:

```typescript
export interface IngestInput {
  path: string;          // File or directory path
  tags?: string[];       // Optional tags for batch operations
  dryRun?: boolean;      // Validate without uploading
}

export interface IngestFileResult {
  sourceId: string;
  filename: string;
  storagePath: string;
  fileHash: string;
  pageCount: number;
  hasNativeText: boolean;
  nativeTextRatio: number;
  duplicate: boolean;    // true if file_hash already existed
}

export interface IngestResult {
  status: 'success' | 'partial' | 'failed';
  data: IngestFileResult[];
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;
    items_skipped: number;
    items_cached: number;
  };
}
```

**`execute(input, config, services, pool)` flow per file:**

1. **Resolve files:** If `input.path` is a directory, recursively find all `*.pdf` files. If single file, use as-is.
2. **For each PDF file:**
   a. Check file exists (`fs.stat`)
   b. Check magic bytes: read first 5 bytes, verify `%PDF-` header
   c. Check file size against `config.ingestion.max_file_size_mb`
   d. Read file into Buffer
   e. Compute SHA-256 hash
   f. Check for duplicate via `findSourceByHash(pool, hash)` — if exists, add to results as `duplicate: true`, skip upload
   g. Run `detectNativeText(buffer)` — gets `pageCount`, `hasNativeText`, `nativeTextRatio`
   h. Check page count against `config.ingestion.max_pages`
   i. If `dryRun`: add to results, skip upload and DB insert
   j. Upload to storage: `services.storage.upload(`raw/${sourceId}/original.pdf`, buffer, 'application/pdf')`
      - Generate `sourceId` as UUID v4 before upload (so storage path is deterministic)
   k. Create source record via `createSource(pool, { ... })`
   l. Upsert source step: `upsertSourceStep(pool, { sourceId, stepName: 'ingest', status: 'completed' })`
   m. Fire Firestore observability update (fire-and-forget, catch errors silently):
      `services.firestore.setDocument('documents', sourceId, { filename, uploadedAt, fileHash, status: 'ingested' })`
3. **Error handling:** Per-file errors are caught and added to `errors[]`. Processing continues for remaining files. If ALL files fail, `status: 'failed'`. If some fail, `status: 'partial'`.

### 4.3 CLI command

**File:** `apps/cli/src/commands/ingest.ts`

```
mulder ingest <path>
  --dry-run         Validate without uploading
  --tag <tag>       Tag ingested sources (repeatable)
  --cost-estimate   Show cost estimate (stub: "not yet implemented")
```

Thin wrapper:
1. Parse arguments
2. Load and validate config
3. Get database pool via `getWorkerPool(config)`
4. Create service registry via `createServiceRegistry(config, logger)`
5. Call `execute()` from `@mulder/pipeline`
6. Format and print results (table: filename, sourceId, pages, nativeText, status)
7. Close pools on exit

### 4.4 Package setup

`packages/pipeline/` needs:
- `package.json` — add `@mulder/core` as workspace dependency
- `src/ingest/index.ts` — the step module
- Barrel export from `packages/pipeline/src/index.ts`
- `tsconfig.json` — project references to `@mulder/core`

### 4.5 Integration wiring

- `apps/cli/src/commands/ingest.ts` — new CLI command file
- `apps/cli/src/index.ts` — register `registerIngestCommands(program)`
- `apps/cli/package.json` — add `@mulder/pipeline` as workspace dependency

### 4.6 StepError type

Add to `@mulder/core` shared types (if not already present):

```typescript
export interface StepError {
  file?: string;
  code: string;
  message: string;
}
```

## 5. QA Contract

Black-box tests interact via CLI execution and database queries only. No imports from `packages/`.

### Conditions

**QA-01: Single PDF ingest**
- Given: A valid PDF file in `fixtures/raw/`
- When: `mulder ingest <path>` is executed
- Then: Exit code 0, source record in `sources` table with `status='ingested'`, `has_native_text` and `native_text_ratio` populated

**QA-02: Directory ingest**
- Given: A directory containing multiple PDF files
- When: `mulder ingest <directory>` is executed
- Then: Exit code 0, one source record per PDF file in the database

**QA-03: Duplicate detection**
- Given: A PDF that was already ingested (same file hash)
- When: `mulder ingest <same-path>` is executed again
- Then: Exit code 0, output indicates duplicate, no new source record created, existing record's `updated_at` is refreshed

**QA-04: Non-PDF rejection**
- Given: A file that is not a PDF (e.g., a .txt file renamed to .pdf, or missing magic bytes)
- When: `mulder ingest <path>` is executed
- Then: Exit code non-zero or output contains error about invalid PDF, no source record created

**QA-05: File size limit**
- Given: Config with `ingestion.max_file_size_mb: 0.001` (effectively ~1KB)
- When: `mulder ingest <normal-pdf>` is executed
- Then: Output contains error about file too large, no source record created

**QA-06: Dry run mode**
- Given: A valid PDF file
- When: `mulder ingest <path> --dry-run` is executed
- Then: Exit code 0, output shows validation results, NO source record in database, NO file uploaded to storage

**QA-07: Tag assignment**
- Given: A valid PDF file
- When: `mulder ingest <path> --tag batch1` is executed
- Then: Source record has `tags` array containing `'batch1'`

**QA-08: Source step tracking**
- Given: A successfully ingested PDF
- When: Querying `source_steps` for the new source
- Then: Row exists with `step_name='ingest'`, `status='completed'`

**QA-09: Page count validation**
- Given: Config with `ingestion.max_pages: 1` and a multi-page PDF
- When: `mulder ingest <multi-page-pdf>` is executed
- Then: Output contains error about too many pages, no source record created

**QA-10: Storage path convention**
- Given: A successfully ingested PDF
- When: Checking the source record's `storage_path`
- Then: Path follows pattern `raw/{uuid}/original.pdf`
