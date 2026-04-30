---
spec: "77"
title: "Large PDF Browser Upload Flow"
roadmap_step: M7-H11
functional_spec: ["§10.6", "§13"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/197"
created: 2026-04-15
---

# Spec 77: Large PDF Browser Upload Flow

## 1. Objective

Deliver the upload half of `M7-H11` in a way that works for realistic research PDFs without fighting Mulder's global API middleware or Cloud Run request limits. Instead of proxying PDF bytes through `POST /api/documents/upload`, the browser requests an upload session from Mulder, uploads the PDF directly to Cloud Storage, and then asks Mulder to finalize the upload into the normal source + pipeline model.

This spec resolves issue `#197` by making the transport explicit and durable: the API keeps its 10 MB request-body guard for normal JSON routes, while document bytes move over a direct storage upload path that supports large files and keeps route logic focused on validation, deduplication, and job orchestration.

## 2. Boundaries

- **Roadmap Step:** `M7-H11` — Document Viewer UI
- **Target:** `packages/core/src/shared/services.ts`, `packages/core/src/shared/services.dev.ts`, `packages/core/src/shared/services.gcp.ts`, `packages/core/src/database/repositories/source.types.ts`, `packages/core/src/database/repositories/source.repository.ts`, `packages/core/src/database/repositories/job.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/core/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/uploads.schemas.ts`, `apps/api/src/routes/uploads.ts`, `apps/api/src/lib/uploads.ts`, `packages/worker/src/worker.types.ts`, `packages/worker/src/dispatch.ts`, `apps/app/src/pages/Upload.tsx`, `tests/specs/77_large_pdf_browser_upload_flow.test.ts`
- **In scope:** a browser-safe upload contract for large PDFs; upload-session initiation over authenticated JSON; direct-to-storage upload transport that bypasses API body-size bottlenecks; queued server-side finalization that validates the uploaded object, computes file hash, performs deduplication, creates or resolves the source, marks ingest as completed, and optionally enqueues the pipeline run; job payload/status data that lets the UI distinguish new uploads from duplicates; and black-box tests for accepted large uploads, oversized rejected uploads, duplicate handling, and preserved middleware behavior
- **Out of scope:** the full split-view document reader for `H11`, resumable-upload pause/resume UI polish beyond what the storage session already supports, multi-file batch upload, signed download URLs, non-PDF formats, and changing the existing global 10 MB API limit for unrelated routes
- **Constraints:** keep the public API job-producer model from `§10.6`; do not add a generic large-body bypass on the main API stack; keep storage access behind `StorageService`; preserve dedupe semantics based on file hash; and keep the browser flow compatible with the existing async worker/pipeline architecture

## 3. Dependencies

- **Requires:** Spec 14 (`M2-B2`) source repository, Spec 16 (`M2-B4`) ingest validation + dedupe behavior, Spec 67 (`M7-H1`) job queue repository, Spec 68 (`M7-H2`) worker loop, Spec 69 (`M7-H3`) Hono server scaffold, Spec 70 (`M7-H4`) middleware stack, Spec 71 (`M7-H5`) async pipeline API routes, and Spec 76 (`M7-H10`) document retrieval routes
- **Blocks:** a production-worthy `H11` upload page that can handle normal research PDFs without middleware rejection, plus any later bulk-upload UI that depends on the same transport and finalize contract

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/shared/services.ts`** — extend `StorageService` with upload-session creation and object metadata helpers needed by the browser upload flow
2. **`packages/core/src/shared/services.dev.ts`** — provide deterministic dev/test storage behavior for initiated uploads and finalized objects
3. **`packages/core/src/shared/services.gcp.ts`** — implement direct Cloud Storage upload-session creation plus object metadata reads for production
4. **`packages/core/src/database/repositories/source.types.ts`** — allow explicit source IDs for browser-initiated uploads
5. **`packages/core/src/database/repositories/source.repository.ts`** — persist a source row with a caller-supplied ID when finalize succeeds
6. **`packages/core/src/database/repositories/job.repository.ts`** — support writing finalize results back into job payloads before completion
7. **`apps/api/src/routes/uploads.schemas.ts`** — define the initiation and completion request/response envelopes
8. **`apps/api/src/lib/uploads.ts`** — own upload-session initiation, completion-job enqueueing, and job-payload result mapping
9. **`apps/api/src/routes/uploads.ts`** — mount authenticated upload endpoints
10. **`apps/api/src/app.ts`** — register the upload route group while preserving the existing middleware order
11. **`packages/worker/src/worker.types.ts`** — add the finalize job payload contract
12. **`packages/worker/src/dispatch.ts`** — dispatch `document_upload_finalize` jobs through the finalize workflow
13. **`apps/app/src/pages/Upload.tsx`** — implement the real initiate → upload → complete → poll interaction when product ingest is enabled
14. **`tests/specs/77_large_pdf_browser_upload_flow.test.ts`** — verify the contract end to end at the HTTP/job boundary

### 4.2 Route Contract

#### `POST /api/uploads/documents/initiate`

Purpose: start a browser upload without sending PDF bytes through Mulder.

Request body:

```json
{
  "filename": "mufon-journal-2017-03.pdf",
  "size_bytes": 19300352,
  "content_type": "application/pdf",
  "tags": ["review"]
}
```

Success behavior:

- returns `201`
- response includes:
  - `source_id` — pre-assigned UUID for the eventual source
  - `storage_path` — `raw/{source_id}/original.pdf`
  - `upload` — direct upload target details (`url`, `method`, optional headers, transport kind)
  - `limits.max_bytes` — resolved from `config.ingestion.max_file_size_mb`
- validates filename, declared content type, and declared size before creating the session

Rules:

- the request body stays JSON-sized and must continue to pass through the existing body-limit middleware
- declared sizes above the configured ingest maximum fail here with a Mulder validation/error response
- production transport uses a direct Cloud Storage resumable upload session; Mulder must not proxy the PDF bytes through the main route handler

#### Direct upload step

Purpose: move the PDF bytes from browser to storage without going through Mulder's API body path.

Rules:

- the browser uploads the file to the returned session target and stores no secrets beyond the returned session URL/headers
- the uploaded object lands at the returned `storage_path`
- upload failure before completion does not create a source row or queue a pipeline job

#### `POST /api/uploads/documents/complete`

Purpose: tell Mulder the storage upload finished and queue server-side finalization.

Request body:

```json
{
  "source_id": "uuid",
  "filename": "mufon-journal-2017-03.pdf",
  "storage_path": "raw/uuid/original.pdf",
  "tags": ["review"],
  "start_pipeline": true
}
```

Success behavior:

- returns `202`
- enqueues a `document_upload_finalize` job
- response includes the finalize `job_id`, a job-status link, and the provisional `source_id`

Rules:

- this route verifies that the uploaded object exists before enqueueing finalize work
- repeated completion calls for the same `source_id` must not enqueue duplicate in-flight finalize jobs, including under near-simultaneous requests
- `start_pipeline: true` means finalize should enqueue the normal pipeline run after ingest registration succeeds

### 4.3 Finalize Job Contract

`document_upload_finalize` is a worker-owned job that turns an uploaded object into a Mulder source.

Payload in:

```json
{
  "sourceId": "uuid",
  "filename": "mufon-journal-2017-03.pdf",
  "storagePath": "raw/uuid/original.pdf",
  "tags": ["review"],
  "startPipeline": true
}
```

Worker behavior:

1. confirm the object still exists at `storagePath`
2. read object bytes and run the same PDF validation gates as CLI ingest where applicable:
   - PDF magic bytes
   - configured max file size
   - lightweight PDF metadata extraction / page-count gate
   - native text detection
   - SHA-256 hash computation
3. dedupe against existing sources by file hash
4. if unique:
   - create the source using the pre-assigned `sourceId`
   - write the same source metadata shape as CLI ingest
   - upsert `source_steps.ingest = completed`
   - optionally enqueue the normal `pipeline_run` starting from `extract`
5. if duplicate:
   - delete the newly uploaded object at the provisional `storagePath`
   - do not create a second source row
   - mark the finalize result with the existing source ID instead

Job payload out:

- before completion, update the job payload with:
  - `result_status: "created" | "duplicate"`
  - `resolved_source_id`
  - `duplicate_of_source_id` when applicable
  - `pipeline_job_id` and `pipeline_run_id` when a pipeline job was queued

### 4.4 UI Flow

- the upload page uses the new initiate endpoint instead of a fake timer-driven upload
- after initiation, the page uploads the file directly to the returned target
- after the direct upload succeeds, the page calls complete and polls `/api/jobs/{job_id}`
- when finalize completes:
  - new upload: show the created source and pipeline job links
  - duplicate upload: explain that the document already exists and link to the existing source

### 4.5 Middleware And Limit Behavior

- keep `createBodyLimitMiddleware()` at the existing 10 MB default for normal API routes
- the upload contract must succeed for PDFs larger than 10 MB because the PDF body never traverses the JSON API route stack
- oversized uploads must still be rejected deterministically at initiation using the configured ingest size limit
- the dev/test upload proxy path may bypass the body-limit middleware, but only for the dedicated authenticated upload endpoint used to emulate direct storage uploads locally

### 4.6 Implementation Phases

**Phase 1: storage + repository groundwork**
- extend storage/session capabilities
- support explicit source IDs and job-payload result updates

**Phase 2: API + worker finalize flow**
- add initiate/complete routes and upload library helpers
- add `document_upload_finalize` worker handling and pipeline enqueueing

**Phase 3: UI + verification**
- wire the upload page to the real flow
- add black-box tests for accepted large uploads, oversized rejection, duplicates, and unchanged middleware protection

## 5. QA Contract

### QA-01: large PDF uploads initiate without tripping the API body limit

**Given** an authenticated client declares a PDF larger than 10 MB but within `ingestion.max_file_size_mb`,
**When** it sends `POST /api/uploads/documents/initiate`,
**Then** the response is `201` with a direct upload target and no `REQUEST_BODY_TOO_LARGE` error.

### QA-02: oversized uploads are rejected before any storage session is used

**Given** an authenticated client declares a PDF larger than the configured ingest maximum,
**When** it sends `POST /api/uploads/documents/initiate`,
**Then** the API rejects the request with a Mulder validation/error response and no finalize job is created.

### QA-03: completing a successful upload creates a source and pipeline job

**Given** a PDF has been uploaded to the returned storage path and `start_pipeline` is true,
**When** the client sends `POST /api/uploads/documents/complete`,
**Then** the API returns `202`, the finalize job completes successfully, a source with the pre-assigned ID exists, ingest is marked completed, and a `pipeline_run` job is queued.

### QA-04: duplicate uploads resolve to the existing source without creating a second record

**Given** a second uploaded PDF has the same file hash as an existing source,
**When** finalize runs,
**Then** the finalize job completes with `result_status = "duplicate"`, the provisional upload object is removed, and only the original source row remains.

### QA-05: missing uploaded objects fail clearly at completion/finalize time

**Given** the browser never uploaded the file or the storage object disappeared,
**When** the client calls complete,
**Then** the API or finalize job returns a clear not-found style failure instead of silently creating a broken source.

### QA-06: normal API routes keep their existing 10 MB body protection

**Given** a non-upload mutating route still receives an oversized request body,
**When** that request passes through the middleware stack,
**Then** Mulder still returns `REQUEST_BODY_TOO_LARGE`.

### QA-07: upload endpoints remain authenticated

**Given** the upload routes are mounted,
**When** an unauthenticated client calls initiate or complete,
**Then** the request fails through the established auth boundary.

### QA-08: repeated completion requests do not enqueue a second finalize job

**Given** an uploaded object already has a pending finalize job for the same `source_id`,
**When** the client calls `POST /api/uploads/documents/complete` again,
**Then** Mulder returns a conflict-style error and only one pending finalize job exists for that upload.

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

This flow avoids unnecessary Mulder API egress and memory pressure by sending PDF bytes directly to storage, but it does add Cloud Storage upload-session traffic plus one finalize worker read of the uploaded object. The implementation should avoid duplicate object copies and should delete duplicate uploads promptly so large-file mistakes do not silently accumulate storage cost.
