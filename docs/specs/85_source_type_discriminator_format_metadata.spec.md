---
spec: "85"
title: "Source Type Discriminator + Format Metadata"
roadmap_step: M9-J1
functional_spec: ["§2", "§3", "§4.3", "§4.5"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/225"
created: 2026-04-29
---

# Spec 85: Source Type Discriminator + Format Metadata

## 1. Objective

Add the first M9 multi-format ingestion foundation: every source must carry a first-class `source_type` discriminator and a JSONB `format_metadata` payload, and ingest must determine the source type from file signatures before considering filename extensions.

This satisfies M9-J1 from the roadmap and prepares the existing PDF-only ingest path for later image, text, Office, email, spreadsheet, and URL handlers without changing downstream story/entity/chunk contracts. The implementation fulfills the relevant functional-spec contracts from `§2` (step outputs and service-boundary discipline), `§3` (pipeline status remains PostgreSQL-authoritative), `§4.3` (the `sources` table is the system record for ingested documents), and `§4.5` (pipeline code still uses service interfaces for external effects).

## 2. Boundaries

**Roadmap step:** M9-J1 — Source type discriminator: `source_type` column, JSONB `format_metadata`, magic-byte detection.

**Target files:**

- `packages/core/src/database/migrations/021_source_type_format_metadata.sql`
- `packages/core/src/database/repositories/source.types.ts`
- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/index.ts`
- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/ingest/types.ts`
- `apps/cli/src/commands/ingest.ts`
- `tests/specs/85_source_type_discriminator_format_metadata.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add a database-level `source_type` discriminator with allowed values `pdf`, `image`, `text`, `docx`, `spreadsheet`, `email`, and `url`.
- Add `sources.format_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`.
- Backfill existing rows as `source_type = 'pdf'` and copy existing PDF metadata into `format_metadata`.
- Keep existing `page_count`, `has_native_text`, `native_text_ratio`, and `metadata` fields intact for compatibility with current M1-M8 code.
- Expose `sourceType` and `formatMetadata` through source repository types, row mapping, create, update, filters where useful, and barrel exports.
- Add a reusable source type detector that uses magic bytes first and extension/content-shape fallback second.
- Update ingest so PDF files still flow through the existing validation, metadata, native-text, storage, source-step, and Firestore behavior, while storing `source_type = 'pdf'` and PDF metadata in `format_metadata`.
- Reject recognized non-PDF source types as unsupported in this step, with no database row and no storage upload.
- Surface source type in the `mulder ingest` result table for successful PDF ingest and in errors for unsupported formats.

**Out of scope:**

- Accepting image, text, DOCX, spreadsheet, email, or URL sources. Those land in M9-J3 through M9-J10.
- Pipeline step skipping (`skip_to`) for pre-structured formats. That is M9-J2.
- Format-aware extraction dispatch. That is M9-J11.
- Cross-format deduplication beyond existing file-hash duplicate handling. That is M9-J12.
- Removing PDF-specific compatibility columns from `sources`.
- Any direct GCP client changes; external effects remain behind the existing service registry.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Source detection must never trust an extension over decisive magic bytes.
- Unknown files and recognized-but-not-yet-supported formats must fail before upload and before source creation.
- The current PDF ingest behavior must remain backward compatible for callers and existing tests.

## 3. Dependencies

**Requires:**

- M1-A7 / Spec 08 core schema migrations.
- M2-B2 / Spec 14 source repository.
- M2-B4 / Spec 16 ingest step.

**Blocks:**

- M9-J2 pipeline step skipping.
- M9-J3 through M9-J10 format-specific ingestion handlers.
- M9-J11 format-aware extract routing.
- M9-J12 cross-format dedup.
- M9-J13 golden tests for multi-format ingestion.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: Database discriminator

1. Add `packages/core/src/database/migrations/021_source_type_format_metadata.sql`.
2. Create the allowed discriminator as a database-constrained value. A PostgreSQL enum is acceptable; a `TEXT` column with an explicit check constraint is acceptable only if the constraint names every roadmap value.
3. Add `source_type` to `sources` with default `pdf`, non-null semantics, and a backfill for existing rows.
4. Add `format_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`.
5. Backfill `format_metadata` from existing `sources.metadata` for PDF rows so previously ingested PDF metadata remains available from the new field.
6. Add `idx_sources_source_type` for format-aware follow-up queries.

### Phase 2: Repository and public types

1. In `source.types.ts`, add:
   - `SourceType = 'pdf' | 'image' | 'text' | 'docx' | 'spreadsheet' | 'email' | 'url'`
   - `SourceFormatMetadata = Record<string, unknown>`
   - `sourceType` and `formatMetadata` on `Source`
   - optional `sourceType` and `formatMetadata` on create/update inputs
   - optional `sourceType` on `SourceFilter`
2. In `source.repository.ts`, map `source_type` and `format_metadata` both directions.
3. Ensure `createSource()` inserts the new fields when provided and defaults to `pdf` / `{}` when omitted.
4. Ensure idempotent duplicate return paths include the persisted source type and format metadata.
5. Export the new types through `packages/core/src/database/repositories/index.ts` and `packages/core/src/index.ts`.

### Phase 3: Source type detection

Create `packages/pipeline/src/ingest/source-type.ts` with a pure detector that accepts `(buffer, filenameOrInput)` and returns:

```typescript
type SourceDetectionResult = {
  sourceType: SourceType;
  confidence: 'magic' | 'extension' | 'content';
  mediaType?: string;
};
```

Detection order:

1. Magic bytes:
   - `%PDF-` -> `pdf`
   - PNG signature -> `image`
   - JPEG SOI -> `image`
   - TIFF little/big-endian signatures -> `image`
   - ZIP local header with `.docx` extension -> `docx`
   - ZIP local header with `.xlsx` extension -> `spreadsheet`
2. Content/shape fallback:
   - readable text or `.txt` / `.md` -> `text`
   - `.csv` extension with delimited text shape -> `spreadsheet`
   - RFC-822-like headers or `.eml` -> `email`
   - `http://` / `https://` input shape -> `url` when the detector is called without a local file buffer in a later step
3. Unknown -> return no supported type or throw a typed ingest error before upload.

The detector is reusable scaffolding for later M9 steps, but J1 only allows `pdf` to continue.

### Phase 4: Ingest integration

1. Replace the private PDF-only magic check in `packages/pipeline/src/ingest/index.ts` with the new detector.
2. Preserve existing directory behavior: directories still resolve PDF candidates only until later M9 steps intentionally broaden that surface.
3. For a PDF:
   - keep the existing PDF metadata and native-text checks
   - upload with `application/pdf`
   - call `createSource()` with `sourceType: 'pdf'`
   - write PDF metadata to both `metadata` and `formatMetadata` for compatibility
   - include `sourceType` and `formatMetadata` in `IngestFileResult`
   - include `sourceType` in Firestore observability payload
4. For a recognized non-PDF:
   - throw a typed ingest error such as `INGEST_UNSUPPORTED_SOURCE_TYPE`
   - include the detected type in error context/message
   - create no source row and upload nothing
5. For an unknown source:
   - fail with the existing invalid-file class or a new typed unknown-format error
   - create no source row and upload nothing

### Phase 5: CLI and black-box QA

1. Update `apps/cli/src/commands/ingest.ts` output to include a compact `Type` column for successful rows.
2. Add `tests/specs/85_source_type_discriminator_format_metadata.test.ts` using black-box boundaries only: CLI subprocesses, SQL via `tests/lib/db.js`, and filesystem fixtures/temp files.
3. Keep existing Spec 16 ingest behavior green.

## 5. QA Contract

**QA-01: Migration exposes source type and format metadata**

Given a migrated database, when `information_schema.columns` is queried for `sources`, then `source_type` and `format_metadata` exist, are non-null/defaulted for new rows, and `source_type` accepts every M9 roadmap value while rejecting an arbitrary value.

**QA-02: Existing/new PDF rows default to PDF**

Given the migration has run, when a source row is inserted without explicitly setting `source_type` or `format_metadata`, then the row reads back with `source_type = 'pdf'` and `format_metadata = '{}'::jsonb`.

**QA-03: PDF ingest records format data**

Given `fixtures/raw/native-text-sample.pdf`, when `mulder ingest` is run, then it exits 0, prints type `pdf`, and the database row has `source_type = 'pdf'`, `format_metadata` containing PDF metadata, and the existing `metadata`, `has_native_text`, and `native_text_ratio` behavior preserved.

**QA-04: Magic bytes override misleading extension**

Given a PNG or JPEG file saved with a `.pdf` extension, when `mulder ingest` is run, then the command fails with an unsupported source type message that names `image`, and no row is inserted into `sources`.

**QA-05: Text-like formats are detected but not accepted yet**

Given a `.txt` or `.md` file, when `mulder ingest` is run, then the command fails with an unsupported source type message that names `text`, and no row is inserted into `sources`.

**QA-06: Source repository round trip exposes new fields**

Given a built package and migrated database, when a source is created through the public repository API with `sourceType: 'pdf'` and non-empty `formatMetadata`, then a subsequent public repository read returns the same `sourceType` and `formatMetadata` without losing existing fields.

**QA-07: Duplicate PDF return path preserves source type**

Given a PDF has already been ingested, when the same file is ingested again, then the duplicate output path still returns and prints `pdf`, and the database still contains exactly one row for that file hash.

**QA-08: Existing ingest tests still pass**

Given the Spec 16 ingest suite, when it is run after this change, then all existing PDF ingest assertions still pass or are updated only to account for the new visible `Type` column.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest fixtures/raw/native-text-sample.pdf` | Valid PDF | Exit 0, output includes `Type` = `pdf`, DB row has `source_type = 'pdf'`. |
| `mulder ingest <tmp>/image-renamed.pdf` | PNG/JPEG magic with `.pdf` extension | Non-zero exit, detected type `image` appears in error, no source row. |
| `mulder ingest <tmp>/note.txt` | Plain text file | Non-zero exit, detected type `text` appears in error, no source row. |
| `mulder ingest fixtures/raw/native-text-sample.pdf` twice | Duplicate PDF | Exit 0 both times, second output marks duplicate and still shows `pdf`, one source row. |
| `mulder ingest --dry-run fixtures/raw/native-text-sample.pdf` | Valid PDF dry run | Exit 0, output includes `pdf`, no DB row and no upload. |

## 6. Cost Considerations

J1 adds local detection, database columns, and repository metadata only. It introduces no new paid service calls. Unsupported non-PDF files fail before storage upload or any GCP/LLM work. PDF ingest keeps the existing cost behavior.
