---
spec: "98"
title: "Content-Addressed Raw Blob Storage"
roadmap_step: M10-K1
functional_spec: ["§A2", "§A1", "§2.1", "§4.3", "§4.4"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/262"
created: 2026-05-05
---

# Spec 98: Content-Addressed Raw Blob Storage

## 1. Objective

Complete M10-K1 by moving Mulder's canonical raw-document storage from source-id-addressed paths to content-addressed blob paths. Today each ingested source stores an original under `raw/{source_id}/original.{ext}` and `sources.file_hash` prevents byte-identical duplicate source rows. §A2 requires the raw blob itself to be keyed by SHA-256 so the same bytes map to one immutable stored object independent of filename, source UUID, archive path, or submission channel.

This step establishes the storage foundation for later M10 provenance work without implementing the full provenance model. K1 must create durable blob identity, content-addressed storage paths, and exact-byte blob deduplication that both CLI ingest and API/browser upload finalization can use. Later steps will attach acquisition contexts, archive locations, custody chains, collections, source rollback, and quality decisions to these blobs.

## 2. Boundaries

**Roadmap step:** M10-K1 - Content-addressed storage: GCS layout migration, SHA-256 dedup.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/262-content-addressed-storage`.

**Target files:**

- `packages/core/src/database/migrations/024_document_blobs.sql`
- `packages/core/src/database/repositories/document-blob.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/shared/blob-storage.ts`
- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/services.gcp.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/index.ts`
- `packages/worker/src/dispatch.ts`
- `apps/api/src/lib/uploads.ts`
- `apps/api/src/routes/uploads.schemas.ts`
- `tests/specs/98_content_addressed_storage.test.ts`
- Existing M9 ingest/upload regression tests as needed
- `docs/roadmap.md`

**In scope:**

- Add a `document_blobs` table keyed by exact SHA-256 content hash with storage URI/path, byte size, media type, original filenames, storage status, integrity status, first-ingested and last-accessed timestamps.
- Add repository helpers to create or update a blob record idempotently and to look up blobs by content hash.
- Add pure helpers for deterministic content-addressed object paths using §A2's `sha256/{first2}/{next2}/{hash}` partitioning.
- Store raw originals at the content-addressed blob path for CLI ingest and finalized API/browser uploads.
- Preserve `sources.file_hash` exact duplicate behavior and existing duplicate result shapes.
- Record enough source-to-blob linkage for later M10 steps by keeping `sources.file_hash` aligned with `document_blobs.content_hash` and by storing the source's canonical `storage_path` as the content-addressed object path.
- Make storage uploads idempotent: if the blob object already exists, do not re-upload the same bytes unnecessarily.
- Keep derived artifacts (`extracted/`, `segments/`, page images, story Markdown) source-id-addressed and unchanged.
- Keep URL snapshot and refetch storage behavior unchanged unless the existing URL ingest path already routes through the common raw blob helper without weakening lifecycle semantics.

**Out of scope:**

- AcquisitionContext, OriginalSource, CustodyStep, ArchiveLocation, Archive, Collection, and BlobVersionLink persistence. These belong to M10-K7 and M10-K8.
- Source rollback, cold storage transitions, purge semantics, undo windows, and audit logs. These belong to M10-K6.
- Quality assessment routing. This belongs to M10-K3.
- Provenance arrays on downstream artifacts. This belongs to M10-K2.
- Retrospective migration or backfill of already stored local/GCS raw objects.
- Changing public document/download APIs beyond returning the new `storage_path` value already exposed by source records.
- Any paid-service calls, LLM calls, OCR calls, or integrity verification cron jobs.

## 3. Dependencies

- M9-J1 / Spec 85: `sources.source_type` and `sources.format_metadata` exist for all source types.
- M9-J3 through M9-J10: format-specific ingest and upload finalize paths share enough source metadata to converge on raw storage.
- M9-J12 / Spec 96: exact `file_hash` dedup remains first, cross-format dedup remains a second conservative source-level check.

This spec blocks M10-K2, M10-K6, M10-K7, and M10-K8 because those steps need a stable raw blob identity before they can attach provenance, rollback, archive, or collection semantics.

## 4. Blueprint

1. Add migration `024_document_blobs.sql`:
   - Create `document_blobs` with `content_hash TEXT PRIMARY KEY`.
   - Store `mulder_blob_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE`.
   - Store `storage_path TEXT NOT NULL UNIQUE`, `storage_uri TEXT NOT NULL UNIQUE`, `mime_type TEXT`, `file_size_bytes BIGINT NOT NULL`, `storage_class TEXT NOT NULL DEFAULT 'standard'`, `storage_status TEXT NOT NULL DEFAULT 'active'`, `original_filenames TEXT[] NOT NULL DEFAULT '{}'`, `first_ingested_at`, `last_accessed_at`, `integrity_verified_at`, `integrity_status TEXT NOT NULL DEFAULT 'unverified'`, and `created_at` / `updated_at`.
   - Add conservative CHECK constraints for `storage_status`, `storage_class`, and `integrity_status`.
   - Do not add provenance tables in this migration.
2. Add repository support:
   - Define `DocumentBlob`, `UpsertDocumentBlobInput`, and mapper types.
   - Implement `upsertDocumentBlob(pool, input)` with `ON CONFLICT (content_hash)` that appends a new filename when absent, refreshes `last_accessed_at`, and preserves immutable storage fields.
   - Implement `findDocumentBlobByHash(pool, contentHash)`.
3. Add pure blob storage helpers:
   - `buildContentAddressedBlobPath(contentHash, extension?)` returns `blobs/sha256/{aa}/{bb}/{hash}.{ext}` or a repository-standard path matching the documented partitioning.
   - `buildContentAddressedBlobUri(bucketNameOrPrefix, contentHash, extension?)` formats a stable URI when the service/config provides a bucket prefix.
   - Validate that only lowercase SHA-256 hex hashes are accepted.
4. Extend storage service behavior only where needed:
   - Reuse existing `exists`, `upload`, `download`, and `getMetadata` service methods where possible.
   - If URI construction needs a bucket prefix, expose it through config or a small service helper without importing raw GCP clients into pipeline code.
5. Wire CLI/file ingest:
   - Compute SHA-256 as today.
   - Preserve `findSourceByHash` exact source duplicate check as the first source-level dedup gate.
   - Build the content-addressed blob path and upload the raw bytes only when the blob object does not exist.
   - Upsert the `document_blobs` record before creating the source row.
   - Create new source rows with `storage_path` pointing at the content-addressed blob path.
   - Preserve cross-format dedup behavior after exact hash and before source creation.
6. Wire API/browser upload finalization:
   - The upload initiation path may continue using provisional `raw/{source_id}/original.{ext}` paths for direct upload sessions.
   - Finalization computes the same content hash, canonical media type, and extension.
   - Exact `file_hash` duplicates delete the provisional upload object and return the existing duplicate source as today.
   - Non-duplicates copy/upload from the provisional path to the content-addressed blob path, upsert `document_blobs`, create the source row with the blob path, then delete the provisional object.
   - Cross-format duplicates that are detected after metadata computation also delete the provisional object and do not create blob/source rows beyond any exact blob record already needed.
7. Update docs and roadmap:
   - Keep K1 marked in-progress during implementation and complete only after verification and review gates pass.
   - Do not update README progress until the full milestone count changes through normal completion.

## 5. QA Contract

1. **QA-01: Content-addressed helper produces deterministic partitioned paths**
   - Given: a valid lowercase SHA-256 hash and file extension
   - When: the public helper builds a blob path
   - Then: the result uses the `sha256/{first2}/{next2}/{hash}` partitioning and rejects malformed hashes.

2. **QA-02: Migration creates a durable document blob registry**
   - Given: a migrated test database
   - When: the schema is inspected
   - Then: `document_blobs` exists with `content_hash` as primary key, unique blob id, unique storage path/URI, status constraints, filename array, and integrity fields.

3. **QA-03: CLI ingest stores raw bytes at the content-addressed path**
   - Given: a valid ingest fixture
   - When: `mulder ingest <file>` runs
   - Then: the source row's `storage_path` contains the SHA-256 partitioned blob path, `sources.file_hash` equals `document_blobs.content_hash`, one `document_blobs` row exists, and the local/dev storage object exists at that path.

4. **QA-04: Exact duplicate CLI ingest does not duplicate blobs or sources**
   - Given: the same file is ingested twice
   - When: the second ingest runs
   - Then: Mulder reports the existing duplicate source, `sources` still has one row for the hash, `document_blobs` still has one row for the hash, and the blob record's `original_filenames` includes the submitted filename without duplicating entries.

5. **QA-05: API upload finalization canonicalizes provisional uploads into blob storage**
   - Given: a browser/API upload completes into its provisional raw path
   - When: the `document_upload_finalize` job runs
   - Then: the created source row points at the content-addressed blob path, the blob row exists, an extract job is queued when requested, and the provisional raw upload object is deleted.

6. **QA-06: API exact duplicate upload cleans up the provisional object**
   - Given: a source already exists for a file hash
   - When: the same bytes are uploaded through API/browser finalization
   - Then: finalization returns the existing duplicate result shape, does not create a second source row, does not create an extract job for the provisional source id, and deletes the provisional object.

7. **QA-07: Cross-format duplicate behavior remains unchanged**
   - Given: the M9 cross-format duplicate tests
   - When: the targeted M9-J12 test scope runs
   - Then: exact hash and cross-format duplicate behavior remain green with content-addressed raw storage.

8. **QA-08: Derived artifacts remain source-addressed**
   - Given: an ingested source proceeds through extract/segment or a pre-structured extract path
   - When: downstream artifacts are queried
   - Then: extracted and story artifact paths still use the source/story identifiers expected by existing tests.

## 5b. CLI Test Matrix

| Command | Scenario | Expected observable result |
|---------|----------|----------------------------|
| `mulder ingest --dry-run <fixture>` | Supported file | Exit 0; reports the same source type/page metadata as before; no source row, blob row, or storage object is created. |
| `mulder ingest <fixture>` | First exact file ingest | Exit 0; source row points at content-addressed blob path; one blob row exists; raw object exists at the blob path. |
| `mulder ingest <fixture>` | Re-ingest same bytes | Exit 0; duplicate output references existing source; source count and blob count for the hash remain one. |
| `mulder ingest <fixture-copy-with-different-name>` | Same bytes, different filename | Exit 0; duplicate output references existing source; blob filename metadata records the alternate submitted filename once. |

## 6. Cost Considerations

K1 is deterministic local/storage/database work. It adds SHA-256 computation, storage existence checks, object copy/upload/delete operations, and PostgreSQL writes. It must not add Document AI, Gemini, embedding, web rendering, or other paid AI calls. GCS object operations may increase slightly during upload finalization because provisional uploads are moved into content-addressed storage, but duplicate raw bytes should reduce long-term storage growth.
