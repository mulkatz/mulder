---
spec: "76"
title: "Document Retrieval Routes"
roadmap_step: M7-H10
functional_spec: ["§10.6"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/191"
created: 2026-04-15
---

# Spec 76: Document Retrieval Routes

## 1. Objective

Expose Mulder's document-viewer retrieval surface over authenticated HTTP so clients can browse documents, stream the original PDF, fetch the derived `layout.md`, and inspect extracted page-image availability without shelling into CLI storage helpers. Per `§10.6`, these routes remain synchronous and artifact-backed: they read already-persisted source metadata and storage objects directly, and they never enqueue jobs or rerun pipeline steps.

This step is the API half of the deferred document-viewer work. It gives `M7-H11` a real backend surface that respects Mulder's service abstraction and production shape instead of relying on local-only filesystem shortcuts.

## 2. Boundaries

- **Roadmap Step:** `M7-H10` — Document retrieval routes
- **Target:** `apps/api/src/app.ts`, `apps/api/src/routes/documents.schemas.ts`, `apps/api/src/routes/documents.ts`, `apps/api/src/lib/documents.ts`, `packages/core/src/database/repositories/source.types.ts`, `packages/core/src/database/repositories/source.repository.ts`, `packages/core/src/database/repositories/index.ts`, `tests/specs/76_document_retrieval_routes.test.ts`
- **In scope:** authenticated `GET /api/documents`; authenticated `GET /api/documents/:id/pdf`; authenticated `GET /api/documents/:id/layout`; authenticated `GET /api/documents/:id/pages`; authenticated `GET /api/documents/:id/pages/:num`; source-list filtering needed for a viewer-facing document index; storage-backed streaming of raw PDF, derived layout markdown, and extracted page images through the existing `StorageService`; and black-box tests proving sync behavior, auth protection, artifact content types, empty or missing artifact handling, and viewer-oriented response contracts
- **Out of scope:** the React document viewer UI (`M7-H11`), direct filesystem reads in the API layer, re-running `extract`, serving raw `layout.json`, source/stories CRUD routes outside the document-viewer surface, write or mutation endpoints, signed URL generation, caching/CDN work, and any new queue or pipeline orchestration behavior
- **Constraints:** keep all routes behind the existing middleware/auth stack; keep the surface synchronous and read-only; use `@mulder/core` repositories plus `StorageService` rather than ad hoc SDK wiring; preserve the service-abstraction rule called out in the roadmap note for `H11`; and treat missing artifacts as observable API errors instead of silently synthesizing substitute content

## 3. Dependencies

- **Requires:** Spec 14 (`M2-B2`) source repository, Spec 19 (`M2-B7`) extract artifact layout/page-image persistence, Spec 48 (layout Markdown persistence beside `layout.json`), Spec 49 (`mulder show` confirms `layout.md` as a first-class artifact), Spec 69 (`M7-H3`) Hono server scaffold, and Spec 70 (`M7-H4`) API middleware stack
- **Blocks:** Spec 11 (`M7-H11`) Document Viewer UI, which needs a stable API for listing documents and retrieving PDF, layout markdown, and page imagery without bypassing the real service layer

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/documents.schemas.ts`** — defines the query schemas, JSON list/page-list response shapes, and artifact metadata contracts for document retrieval
2. **`apps/api/src/lib/documents.ts`** — owns repository-backed source lookup, viewer-oriented DTO mapping, and storage-backed artifact loaders
3. **`apps/api/src/routes/documents.ts`** — registers the document route group and handles JSON vs streaming response details
4. **`apps/api/src/app.ts`** — mounts the document route group beneath the existing middleware stack
5. **`packages/core/src/database/repositories/source.types.ts`** — extends source-list filtering if needed for viewer-facing document search
6. **`packages/core/src/database/repositories/source.repository.ts`** — adds any source-list query support needed for filename search and count parity
7. **`packages/core/src/database/repositories/index.ts`** — exports any new source query helpers
8. **`tests/specs/76_document_retrieval_routes.test.ts`** — black-box verification for the document retrieval API surface

### 4.2 Route Contract

#### `GET /api/documents`

Purpose: list document rows for authenticated viewer clients.

Query parameters:

- `status` — optional source-status filter
- `search` — optional case-insensitive filename substring filter
- `limit` — optional integer cap with a safe default
- `offset` — optional integer offset

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "filename": "case-file.pdf",
      "status": "extracted",
      "page_count": 12,
      "has_native_text": true,
      "layout_available": true,
      "page_image_count": 12,
      "created_at": "2026-04-15T12:00:00.000Z",
      "updated_at": "2026-04-15T12:05:00.000Z",
      "links": {
        "pdf": "/api/documents/uuid/pdf",
        "layout": "/api/documents/uuid/layout",
        "pages": "/api/documents/uuid/pages"
      }
    }
  ],
  "meta": {
    "count": 1,
    "limit": 20,
    "offset": 0
  }
}
```

Rules:

- the list route is source-backed and viewer-oriented; it does not inline story bodies or full extraction payloads
- `layout_available` reflects whether `extracted/{sourceId}/layout.md` exists in storage
- `page_image_count` reflects the number of stored page-image objects under `extracted/{sourceId}/pages/`

#### `GET /api/documents/:id/pdf`

Purpose: stream the original stored PDF for a source.

Success behavior:

- returns `200`
- `Content-Type: application/pdf`
- `Content-Disposition: inline; filename="<source filename>"`
- body bytes match the stored raw artifact referenced by `sources.storage_path`

Rules:

- unknown source IDs fail with a Mulder JSON not-found response
- known sources whose raw storage object is missing also fail clearly instead of returning an empty success
- the route streams storage-backed bytes only; it does not regenerate or transform the PDF

#### `GET /api/documents/:id/layout`

Purpose: return the derived layout markdown artifact produced by Extract.

Success behavior:

- returns `200`
- `Content-Type: text/markdown; charset=utf-8`
- body bytes match `extracted/{sourceId}/layout.md`

Rules:

- this route serves the stored `layout.md` artifact, not `layout.json`
- sources that exist but have not been extracted yet fail with a clear not-found response for the missing artifact
- the API must not synthesize markdown from `layout.json` on demand

#### `GET /api/documents/:id/pages`

Purpose: list the extracted page-image artifacts available for a source.

Response shape:

```json
{
  "data": {
    "source_id": "uuid",
    "pages": [
      {
        "page_number": 1,
        "image_url": "/api/documents/uuid/pages/1"
      }
    ]
  },
  "meta": {
    "count": 1
  }
}
```

Rules:

- the route reads storage listings under `extracted/{sourceId}/pages/`
- page numbers are derived from the stored `page-NNN.png` naming pattern
- if a source exists but no page images are present, the route returns `200` with an empty `pages` array

#### `GET /api/documents/:id/pages/:num`

Purpose: stream one extracted page image for the viewer.

Success behavior:

- returns `200`
- `Content-Type: image/png`
- body bytes match the stored `extracted/{sourceId}/pages/page-{NNN}.png` object for the requested page number

Rules:

- page numbers must validate at the HTTP edge as positive integers
- unknown source IDs or missing page objects fail with a Mulder JSON not-found response
- the route serves persisted images only and never renders pages dynamically in the API process

### 4.3 Integration Points

- document list queries reuse the source repository and stay aligned with Mulder's source/status model
- artifact reads go through the existing `StorageService`, keeping dev and GCP behavior swappable and avoiding a viewer-only filesystem backdoor
- request-scoped logging should record route metadata such as source ID, filename filter, artifact kind, and page number without introducing a second logging system
- the route group consumes the existing auth and rate-limit middleware, with document list/layout/pages in the standard tier and artifact streams preserving the same authenticated boundary

### 4.4 Implementation Phases

**Phase 1: source-list and artifact helper layer**
- add document list and page-list schemas
- implement repository-backed list helpers plus storage-backed artifact and page-list readers

**Phase 2: route wiring and streaming behavior**
- register `/api/documents/*`
- handle JSON list responses and streaming headers/content types for PDF, markdown, and PNG artifacts

**Phase 3: black-box verification**
- cover auth protection, list filtering, sync non-queue behavior, missing-artifact handling, and byte-level artifact retrieval in a dedicated spec test

## 5. QA Contract

### QA-01: authenticated document listing returns viewer-ready metadata

**Given** persisted source rows with stored raw/extracted artifacts,
**When** an authenticated client sends `GET /api/documents`,
**Then** the response is `200` JSON with document rows, viewer links, and artifact availability metadata.

### QA-02: list filters narrow the document set without mutating it

**Given** documents with different statuses and filenames,
**When** an authenticated client sends `GET /api/documents` with `status` and `search` filters,
**Then** the response includes only matching rows and no source state changes.

### QA-03: PDF retrieval streams the stored raw artifact

**Given** a source with a stored raw PDF,
**When** an authenticated client sends `GET /api/documents/{id}/pdf`,
**Then** the response is `200`, `Content-Type` is `application/pdf`, and the response bytes match the stored PDF exactly.

### QA-04: layout retrieval returns the stored `layout.md` artifact

**Given** an extracted source with `extracted/{id}/layout.md` in storage,
**When** an authenticated client sends `GET /api/documents/{id}/layout`,
**Then** the response is `200`, `Content-Type` is `text/markdown; charset=utf-8`, and the body matches the stored markdown exactly.

### QA-05: missing artifacts fail clearly

**Given** either an unknown source ID or a known source missing the requested PDF, layout, or page artifact,
**When** an authenticated client requests that artifact route,
**Then** the API returns a Mulder not-found response instead of an empty success payload.

### QA-06: page listing reflects stored extracted page images

**Given** an extracted source with page images under `extracted/{id}/pages/`,
**When** an authenticated client sends `GET /api/documents/{id}/pages`,
**Then** the response is `200` JSON with page numbers and per-page retrieval URLs derived from the stored object set.

### QA-07: page-image retrieval streams exact PNG bytes

**Given** a stored page image for a source,
**When** an authenticated client sends `GET /api/documents/{id}/pages/{num}`,
**Then** the response is `200`, `Content-Type` is `image/png`, and the response bytes match the stored page image exactly.

### QA-08: document retrieval stays synchronous and non-queueing

**Given** the document retrieval routes are available,
**When** an authenticated client exercises list and artifact endpoints,
**Then** no jobs or pipeline runs are created as a side effect.

### QA-09: document retrieval stays behind auth and validates malformed inputs

**Given** the route group is mounted,
**When** a request is unauthenticated or uses malformed query/page parameters,
**Then** the API fails at the middleware or HTTP validation edge with the established Mulder response shape.

### QA-10: API package compiles with the new document route surface

**Given** the document route implementation is in place,
**When** the API build and the dedicated H10 spec test run,
**Then** both pass without requiring the full CI-equivalent suite.

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

This step adds no new LLM, Document AI, or queue cost. It reuses already-persisted storage artifacts and source metadata. Runtime cost is limited to authenticated Cloud Storage reads and normal API compute for listing and streaming documents; the implementation should avoid eager multi-artifact downloads on list endpoints so viewer browsing does not turn one page load into unnecessary storage churn.
