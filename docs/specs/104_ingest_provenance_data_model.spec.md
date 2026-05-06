---
spec: "104"
title: "Ingest Provenance Data Model"
roadmap_step: M10-K7
functional_spec: ["§A2.3", "§A2.2", "§A2.4", "§A2.5", "§A6"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/275"
created: 2026-05-06
---

# Spec 104: Ingest Provenance Data Model

## 1. Objective

Complete M10-K7 by adding the ingest provenance model from §A2.3. Mulder already has content-addressed raw blobs (Spec 98), artifact provenance (Spec 99), and source rollback (Spec 103). K7 fills the remaining pre-archive gap by recording how a document entered Mulder, where it lived in the original archive, and what custody path is known for it.

The core invariant is that one immutable `document_blobs` row can have multiple acquisition contexts and archive locations. Exact-byte duplicate ingests must not discard new provenance metadata; they append a new AcquisitionContext and optional ArchiveLocation to the existing blob.

## 2. Boundaries

**Roadmap step:** M10-K7 - Ingest provenance data model: AcquisitionContext, ArchiveLocation, Archive, CustodyChain.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/275-ingest-provenance-data-model`.

**Target files:**

- `packages/core/src/database/migrations/034_ingest_provenance.sql`
- `packages/core/src/database/repositories/ingest-provenance.types.ts`
- `packages/core/src/database/repositories/ingest-provenance.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/config/index.ts`
- `packages/core/src/database/repositories/source-rollback.repository.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `apps/cli/src/commands/ingest.ts`
- `tests/specs/104_ingest_provenance_data_model.test.ts`
- Existing ingest, rollback, and config tests as needed
- `docs/roadmap.md`

**In scope:**

- Add durable tables for `archives`, `acquisition_contexts`, `original_sources`, `custody_steps`, and `archive_locations`.
- Link provenance rows to `document_blobs.content_hash` because content hash is the durable raw blob identity established by Spec 98.
- Link AcquisitionContext rows to `sources.id` when an ingest source exists, while allowing duplicate-context rows to reference the existing source returned by exact-hash dedup.
- Store `collection_id UUID NULL` on acquisition contexts without a foreign key. Collection creation, collection defaults, and collection statistics belong to M10-K8.
- Store ArchiveLocation path and physical metadata as structured JSON where the model is intentionally flexible: `path_segments JSONB` and `physical_location JSONB`.
- Store OriginalSource and CustodyChain as first-class rows under an AcquisitionContext.
- Add repository APIs for creating/upserting/listing archives, acquisition contexts, original sources, custody steps, and archive locations.
- Add a higher-level repository helper to record an ingest provenance bundle in one transaction.
- Extend ingest input so callers can provide provenance metadata. The CLI must accept one JSON file flag (`--provenance <path>`) that maps to the same input shape.
- For normal non-dry-run ingest, create at least a minimal AcquisitionContext for every successful file or URL, even when no optional provenance metadata is provided.
- For exact duplicate ingests, append a new AcquisitionContext and optional ArchiveLocation to the existing `document_blobs` row instead of creating a new blob.
- Keep source rollback compatible with the new tables:
  - soft-delete marks active acquisition contexts for the source as `deleted`;
  - restore reactivates contexts for a restored source;
  - purge plans count acquisition contexts and archive locations without deleting shared blob/archive records.
- Add `ingest_provenance` config defaults for required metadata policy and archive auto-registration behavior.

**Out of scope:**

- Collection repository/API/CLI management, collection defaults, automatic collection creation, or collection statistics. Those belong to M10-K8.
- `blob_version_links` and version replacement/reprocessing behavior.
- Virtual archive tree API/UI.
- Retrospective backfill for old source rows that predate K7.
- External archive adapters, paid-service calls, OCR/LLM work, or network calls.
- User/role enforcement for provenance submitters. K7 records submitter metadata but does not authenticate it.

## 3. Dependencies

- M10-K1 / Spec 98: `document_blobs` exists and uses content hash as the durable blob key.
- M10-K2 / Spec 99: downstream artifacts already carry `source_document_ids`.
- M10-K6 / Spec 103: rollback exists and must remain green after K7 adds provenance tables.

K7 blocks M10-K8 because collection rows will reference archive/provenance data, and it blocks real archive imports because Mulder must not ingest archive batches without preserving provenance.

## 4. Blueprint

1. Add migration `034_ingest_provenance.sql`:
   - Create `archives` with `archive_id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `name`, `description`, `type`, `institution`, `custodian`, `physical_address`, `status`, `structure_description`, `estimated_document_count`, `languages TEXT[]`, date-range columns, ingest-status columns, access restrictions, and timestamps.
   - Create `acquisition_contexts` with `context_id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `blob_content_hash TEXT NOT NULL REFERENCES document_blobs(content_hash)`, `source_id UUID NULL REFERENCES sources(id) ON DELETE SET NULL`, `channel`, submitter fields, `submitted_at`, `collection_id UUID NULL`, notes/metadata JSONB, authenticity fields, `status`, deletion/restoration timestamps, and audit timestamps.
   - Create `original_sources` with one row per context and the §A2.3 source fields.
   - Create `custody_steps` with `context_id`, `step_order`, holder fields, action array, date fields, notes, and `UNIQUE(context_id, step_order)`.
   - Create `archive_locations` with `blob_content_hash`, `archive_id`, original path/filename, `path_segments JSONB`, `physical_location JSONB`, source status, validity timestamps, and uniqueness that prevents duplicate location rows for the same blob/archive/path/filename.
   - Add conservative CHECK constraints for enum-like fields and JSON object/array shape.
   - Add indexes for blob lookup, source lookup, archive lookup, active context lookup, and archive path browsing.
   - Make the migration replay-safe with `IF NOT EXISTS` and guarded constraints/indexes.

2. Add repository types and mappers:
   - Define TypeScript unions for acquisition channel, source type, custody action, archive type/status, context status, authenticity status, archive source status, path segment, and physical location.
   - Map between snake_case DB rows and camelCase repository objects consistently.
   - Normalize metadata arrays/JSON so repository callers receive stable arrays and objects.

3. Add repository APIs:
   - `createArchive`, `upsertArchive`, `findArchiveById`, and `listArchives`.
   - `recordAcquisitionContext`, `findAcquisitionContextById`, `listAcquisitionContextsForBlob`, and `listAcquisitionContextsForSource`.
   - `recordOriginalSource` and `findOriginalSourceForContext`.
   - `recordCustodyStep`, `replaceCustodyChain`, and `listCustodyChainForContext`.
   - `recordArchiveLocation` and `listArchiveLocationsForBlob`.
   - `recordIngestProvenance(pool, input)` to create the context plus optional original source, custody steps, archive/upsert, and archive location in one transaction.
   - `markAcquisitionContextsForSourceDeleted` and `restoreAcquisitionContextsForSource` for rollback integration.

4. Wire ingest:
   - Extend `IngestInput` with optional `provenance`.
   - Add an input shape that can express channel, submitter, collection id, notes/metadata, original source, custody chain, archive, and archive location.
   - Default minimal provenance for file ingest: `channel: "manual_upload"`, `submitted_by.type: "system"`, `submitted_by.user_id: "mulder-cli"` unless supplied.
   - Default minimal provenance for URL ingest: `channel: "web_research"`.
   - When a new source is created, record provenance for the new source and its content hash.
   - When exact-hash duplicate ingest returns an existing source, still record a new AcquisitionContext for the existing blob/source if a pool is available.
   - Dry-runs must not write provenance rows.
   - CLI `mulder ingest <path> --provenance <json-file>` loads the JSON input and passes it through without adding bespoke flags for every nested field.

5. Keep rollback compatible:
   - `softDeleteSource` marks acquisition contexts for the source as `deleted` with the same deletion timestamp.
   - `restoreSource` marks those contexts as `active` again.
   - `planSourcePurge` reports acquisition contexts as source-owned rows and archive locations as shared blob/archive metadata when the blob still has another active context.
   - `purgeSource` must not delete `document_blobs`, `archives`, or shared archive locations just because one source context is purged.

6. Add config support:
   - Add `ingest_provenance.required_metadata` with booleans for `channel`, `submitted_by`, `collection_id`, `original_source`, and `custody_chain`.
   - Add `ingest_provenance.archives.auto_register`.
   - Existing minimal configs that omit `ingest_provenance` must validate using defaults.

7. Update docs and roadmap:
   - Mark K7 in progress during implementation.
   - Mark K7 complete only after verification, review, and merge gates pass.

## 5. QA Contract

1. **QA-01: Migration creates ingest provenance tables**
   - Given a fresh migrated database
   - Then `archives`, `acquisition_contexts`, `original_sources`, `custody_steps`, and `archive_locations` exist with primary keys, foreign keys, constraints, and indexes sufficient for blob/source/archive lookup.

2. **QA-02: Repository records a complete provenance bundle**
   - Given an existing `document_blobs` row and source
   - When `recordIngestProvenance` receives archive, archive location, original source, and custody chain input
   - Then the acquisition context, archive, archive location, original source, and ordered custody steps round-trip through public repository APIs.

3. **QA-03: Duplicate blob acquisitions append context without duplicating blob**
   - Given one content hash already exists in `document_blobs`
   - When two acquisition contexts are recorded for that hash
   - Then there is still one blob row and two context rows with distinct `context_id` values and stable submitter/channel metadata.

4. **QA-04: Ingest writes minimal provenance by default**
   - Given non-dry-run ingest of a supported local fixture
   - Then the resulting source's `file_hash` has one active AcquisitionContext linked to the blob and source.

5. **QA-05: Ingest accepts explicit provenance metadata**
   - Given `executeIngest` or `mulder ingest --provenance <json-file>` with archive/original-source/custody metadata
   - Then the metadata is persisted and visible through repository reads.

6. **QA-06: Rollback marks provenance contexts without deleting shared archive metadata**
   - Given a source with an active AcquisitionContext and ArchiveLocation
   - When rollback soft-delete runs
   - Then the context is marked `deleted`, restore reactivates it, and archive/blob rows remain.

7. **QA-07: Config defaults preserve existing configs**
   - Given the shipped example config and a minimal config without `ingest_provenance`
   - Then config validation succeeds and exposes the K7 defaults.

8. **QA-08: Regression guard**
   - Spec 98, Spec 99, and Spec 103 targeted checks remain green for content-addressed storage, artifact provenance, and rollback behavior.

## 6. Deliverables

- Spec 104 implementation branch and PR against `milestone/10`.
- Issue #275 linked from the PR body with `Closes #275`.
- Migration, repositories, ingest wiring, CLI JSON provenance flag, config defaults, and black-box tests.
- Roadmap K7 marked complete only after local verification, PR CI, and review approval.
