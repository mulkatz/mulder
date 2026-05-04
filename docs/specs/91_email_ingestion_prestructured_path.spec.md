---
spec: "91"
title: "Email Ingestion on the Pre-Structured Path"
roadmap_step: M9-J7
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/243"
created: 2026-05-01
---

# Spec 91: Email Ingestion on the Pre-Structured Path

## 1. Objective

Add M9-J7 email ingestion so `.eml` and `.msg` message files can enter Mulder as first-class `email` sources. Email sources are already represented in the M9 source type enum and in the pre-structured step planner; this step makes that path executable by accepting message files at ingest/upload time, storing canonical email metadata, converting headers and body content into story Markdown during `extract`, and letting downstream processing run `enrich -> embed -> graph` while `segment` is recorded as skipped.

This fulfills the roadmap requirement for email parsing where header metadata maps directly to enrichment-visible entity and temporal hints: sender, recipients, message date, subject, message ID, thread ID, and attachment summaries. The implementation must preserve the functional-spec contracts from `§2` (strict step contracts and service-boundary discipline), `§2.1` (ingest registers sources and storage objects), `§3` (PostgreSQL-authoritative orchestration and skipped steps), and `§4.5` (format extractors use service abstractions rather than direct client coupling inside pipeline steps).

## 2. Boundaries

**Roadmap step:** M9-J7 - Email ingestion: `.eml` / `.msg` parsing, header metadata -> entities.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/extract/types.ts`
- `packages/pipeline/src/index.ts`
- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/services.gcp.ts`
- `packages/core/src/shared/email-extractor.ts`
- `packages/core/src/shared/errors.ts`
- `packages/core/src/database/migrations/022_source_parent.sql`
- `packages/core/src/database/repositories/source.types.ts`
- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/lib/cost-estimate.ts`
- `apps/api/src/routes/uploads.schemas.ts`
- `apps/api/src/lib/uploads.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/91_email_ingestion_prestructured_path.test.ts`
- `docs/roadmap.md`

**In scope:**

- Accept `.eml` and `.msg` files in CLI ingest, directory discovery, API upload initiation, API upload completion validation, dev upload proxy, and worker upload finalization.
- Preserve magic/content detection precedence from Spec 85:
  - decisive PDF/image magic bytes still win over misleading `.eml` or `.msg` extensions,
  - DOCX and XLSX Open XML signatures still win before email detection,
  - arbitrary text renamed to `.eml` must fail unless it has a valid RFC 822 / MIME message shape,
  - arbitrary OLE/compound binary files renamed to `.msg` must fail before source creation unless the message parser can extract Outlook MSG evidence.
- Store email sources with `source_type = 'email'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, and `format_metadata` containing at least:
  - `media_type` (`message/rfc822` or `application/vnd.ms-outlook`)
  - `original_extension` (`eml` or `msg`)
  - `byte_size`
  - `email_format` (`eml` or `msg`)
  - `container` (`rfc822_mime` or `outlook_msg`)
  - `parser_engine`
  - `message_id`
  - `thread_id`
  - `subject`
  - `from`
  - `to`
  - `cc`
  - `bcc`
  - `sent_at`
  - `reply_to`
  - `in_reply_to`
  - `references`
  - `attachment_count`
  - `attachments` as lightweight summaries with filename, media type, size, disposition, content ID, and child source ID when one is created.
- Upload email originals under `raw/{source_id}/original.eml` or `raw/{source_id}/original.msg` using the canonical media type.
- Keep duplicate detection based on the existing file-hash path.
- Add a service abstraction for email parsing. Pipeline extract code must call the service interface, not import the parser directly.
- Implement deterministic email extraction that:
  - downloads the stored original through `services.storage`,
  - parses RFC 822 / MIME `.eml` and Outlook `.msg` messages locally,
  - creates one story per message,
  - renders normalized headers, body text/HTML-derived text, attachment summaries, and entity hints into Markdown,
  - stores story metadata with the same header-derived hints visible in Markdown,
  - writes `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
  - creates `stories` rows in PostgreSQL,
  - marks `source_steps.extract` completed and the source status `extracted`.
- Add a nullable `sources.parent_source_id` relationship so supported attachments can be registered as child sources of the email source when extraction has both content bytes and a supported filename/media shape.
- For supported attachments, register child source rows and upload their original bytes under the child source's canonical `raw/{child_source_id}/original.<ext>` path. Child source pipelines are not executed inside the parent email extract step; they remain normal sources that can be scheduled by existing orchestration.
- For unsupported, inline-only, encrypted, or parser-incomplete attachments, retain metadata summaries without creating child source rows.
- Let Spec 86's planner record `segment` as skipped when pipeline runs include that step for `email` sources.
- Preserve all current PDF, image, text, DOCX, and spreadsheet ingest, extract, upload, cost, and pipeline behavior.

**Out of scope:**

- PST, OST, MBOX, EMLX, TNEF/winmail.dat deep extraction, S/MIME decryption, PGP decryption, calendar invite normalization, or address book resolution.
- Executing child attachment pipelines inside the parent email extract step.
- URL crawling or link snapshotting from email bodies. URL ingestion remains M9-J8 through M9-J10.
- Trust scoring for senders, spam/phishing classification, DKIM/SPF/DMARC validation, or mailbox account ingestion.
- LLM summarization during extract.
- Format-aware extract routing cleanup beyond the new email branch in the existing extract step. The broader dispatch cleanup is M9-J11.
- Cross-format deduplication beyond existing file-hash duplicate handling. That is M9-J12.
- New source type enum values; Spec 85 already added `email`.
- New direct GCP client usage in pipeline, CLI, API, or worker code.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for storage, Firestore, and format extraction effects.
- Unsupported, corrupt, encrypted, malformed, parser-incomplete, or bodyless/headerless messages must fail before story creation and should not silently produce empty stories.
- Email extraction must be deterministic and cost-free: no Document AI, no Gemini Vision, and no Segment step.
- Header-derived hints must be generic and ontology-agnostic. Use sender/recipient/date/thread facts that are present in the message; do not infer people, organizations, or events that are absent from the email.
- Attachment child-source creation must be best-effort and idempotent. Existing duplicate file hashes should not create duplicate source rows, and existing sources should not be force-reparented.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `source_type`, `format_metadata`, and email detection scaffolding.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `email` skips `segment`.
- M9-J3 / Spec 87: broadened non-PDF ingest/upload patterns.
- M9-J4 / Spec 88: pre-structured text extraction pattern and direct story artifact creation.
- M9-J5 / Spec 89: service-bound deterministic document extraction pattern and DOCX compatibility baseline.
- M9-J6 / Spec 90: deterministic parser service pattern and spreadsheet compatibility baseline.
- M2-B4 / Spec 16: existing ingest implementation.
- M3-C1 / Spec 22: story repository and story storage conventions.

**Blocks:**

- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: Email detection and metadata helpers

1. Expand `SUPPORTED_INGEST_EXTENSIONS` in `packages/pipeline/src/ingest/source-type.ts` to include `.eml` and `.msg`.
2. Add canonical storage/media helpers:
   - `message/rfc822` -> `eml`
   - `application/vnd.ms-outlook` -> `msg`
3. Strengthen `.eml` detection so extension alone is not enough; require readable UTF-8 content with a valid RFC 822 header block and at least meaningful sender/date/message/subject evidence.
4. Add Outlook `.msg` detection using the OLE compound document signature plus `.msg` extension, then validate actual message properties during ingest/extract before source creation.
5. Keep PDF/image magic-byte detection ahead of email detection, keep DOCX/XLSX package detection ahead of `.msg`, and keep CSV/text shape detection behavior unchanged.
6. Add reusable email metadata builders:
   - lightweight ingest metadata based on bytes, filename, media type, and format,
   - extract-enriched metadata based on parsed headers, message IDs, thread IDs, body presence, and attachment summaries.
7. Add deterministic thread ID derivation:
   - prefer normalized `References` root when present,
   - else prefer `In-Reply-To`,
   - else prefer `Message-ID`,
   - else use a stable hash of normalized sender, recipients, subject, and sent date.

### Phase 2: CLI ingest and cost estimation

1. Add `email` to the ingestible source types in `packages/pipeline/src/ingest/index.ts`.
2. For `.eml`:
   - validate file size with the existing ingest gate,
   - require readable RFC 822 / MIME message content,
   - skip PDF metadata extraction and native text detection,
   - create a source row with `sourceType: 'email'`,
   - store email metadata in both `formatMetadata` and compatibility `metadata`,
   - upload the original using `original.eml` and `message/rfc822`.
3. For `.msg`:
   - validate file size with the existing ingest gate,
   - require Outlook MSG parser evidence,
   - skip PDF metadata extraction and native text detection,
   - create a source row with `sourceType: 'email'`,
   - store email metadata in both `formatMetadata` and compatibility `metadata`,
   - upload the original using `original.msg` and `application/vnd.ms-outlook`.
4. Keep CLI table columns unchanged while allowing `Type = email`, `Pages = 0`, and `Native Text = no`.
5. Update `apps/cli/src/lib/cost-estimate.ts` so `.eml` and `.msg` files are accepted in ingest profiling, count as zero scanned/layout pages, and do not reserve extract or segment OCR-style costs.
6. Update ingest command copy to include email sources.
7. Keep PDF, image, text, DOCX, and spreadsheet cost/profile behavior unchanged.

### Phase 3: API upload and worker finalization

1. Update `apps/api/src/routes/uploads.schemas.ts` to accept `.eml` / `.msg` filenames and canonical email content types.
2. Keep content-type/extension agreement strict and generate canonical storage paths `raw/{source_id}/original.eml` or `raw/{source_id}/original.msg`.
3. Update `apps/api/src/lib/uploads.ts` validation messages and initiation output to include email files.
4. Update `packages/worker/src/dispatch.ts` upload finalization so `email` is finalizable:
   - validate detected source type from bytes and filename,
   - compute the same email metadata as CLI ingest,
   - canonicalize upload storage paths if needed,
   - create the source row transactionally,
   - emit Firestore observability with `sourceType: email`,
   - enqueue `extract` when `startPipeline` is true.
5. Preserve duplicate cleanup and retry-safe upload canonicalization from Specs 87 through 90.

### Phase 4: Email extraction service

1. Add an `EmailExtractorService` typed service interface in `packages/core/src/shared/services.ts`.
2. Implement `.eml` and `.msg` parsing in both dev and GCP service bundles using deterministic local parsers. Because parsing is local and deterministic, dev and GCP modes may share the same implementation helper, but the pipeline must still consume it through the service registry.
3. Return a typed extraction result with:
   - normalized headers,
   - sender/recipient address objects,
   - subject,
   - sent date,
   - message ID,
   - references / in-reply-to values,
   - thread ID,
   - plain body text,
   - sanitized HTML-derived text when no plain body exists,
   - attachment summaries and content bytes for supported attachment registration,
   - parser metadata and warnings.
4. Reject corrupt, encrypted, unreadable, bodyless/headerless, or parser-incomplete messages with typed extraction errors surfaced by the extract step.
5. Add any parser dependency to the correct package manifest and update `pnpm-lock.yaml`.

### Phase 5: Source parent relationship for attachments

1. Add a nullable `parent_source_id UUID REFERENCES sources(id) ON DELETE SET NULL` column and an index in `packages/core/src/database/migrations/022_source_parent.sql`.
2. Extend source repository types, row mappers, create input, update input, and query results with `parentSourceId`.
3. Keep default source creation behavior unchanged: top-level user-ingested sources have `parentSourceId = null`.
4. During email extract, for each supported attachment with bytes:
   - detect source type using the same source-type discriminator,
   - compute file hash,
   - allocate a child source ID for canonical raw storage,
   - upload the attachment original to `raw/{child_source_id}/original.<ext>`,
   - create or return a source row with `parentSourceId = email source id`,
   - store attachment-derived format metadata where available.
5. If a duplicate attachment hash already exists, return the existing source ID and do not force a parent reassignment.
6. Do not run child extract/enrich/embed/graph inside the parent email extract step.

### Phase 6: Markdown rendering and entity hints

1. Add deterministic Markdown rendering that:
   - includes a compact title and header summary,
   - normalizes address display as `Name <address>` when names exist,
   - escapes Markdown table pipes and line breaks in header values,
   - includes the body content as the primary evidence,
   - includes an `## Attachments` section only when attachments exist,
   - includes an `## Email Entity Hints` section only when hints exist.
2. Store hints in story metadata under `entity_hints` with hint type, field name, value, confidence, and source (`header`, `thread`, or `attachment`).
3. Include hints for:
   - sender email/address display,
   - recipient email/address display for to/cc/bcc/reply-to,
   - sent date,
   - subject,
   - message ID,
   - thread ID,
   - attachment filenames and child source IDs.
4. Keep the message body and headers as primary evidence; hints must not invent entities that are absent from the message.

### Phase 7: Email extract path

1. Branch `packages/pipeline/src/extract/index.ts` by `source.sourceType`.
2. Preserve the existing PDF/image layout extract path, text path, DOCX path, and spreadsheet path.
3. For `email` sources:
   - download `source.storagePath` through `services.storage`,
   - determine email format from source metadata or storage extension,
   - call the email extraction service,
   - register supported attachments as child sources when possible,
   - create a story title from subject and sent date,
   - write `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
   - call `createStory()` with `pageStart = null`, `pageEnd = null`, `extractionConfidence = 1.0`, and metadata that records `source_type = email`, `email_format`, header fields, `thread_id`, `message_id`, attachment summaries, and `entity_hints`,
   - update the source format metadata with parsed header and attachment details when possible,
   - update the source status to `extracted`,
   - upsert `source_steps.extract = completed`,
   - write Firestore extract observability.
4. Do not write layout JSON or page images for email sources.
5. Let pipeline/worker step planning skip `segment`; do not special-case `segment` inside email extract.

### Phase 8: QA and compatibility

1. Add `tests/specs/91_email_ingestion_prestructured_path.test.ts`.
2. Use black-box boundaries: CLI subprocesses, API requests, worker job processing, public package exports, SQL checks, and local dev storage artifacts.
3. Run the existing Spec 85, Spec 86, Spec 87, Spec 88, Spec 89, and Spec 90 suites that cover format detection, step skipping, non-PDF compatibility, pre-structured text extraction, DOCX extraction, and spreadsheet extraction.

## 5. QA Contract

**QA-01: CLI dry-run accepts EML sources without persistence**

Given a valid `.eml` fixture with headers and body content, when `mulder ingest --dry-run <file.eml>` runs, then the command exits 0, prints `Type` as `email`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-02: CLI dry-run accepts MSG sources without persistence**

Given a valid `.msg` fixture with headers and body content, when `mulder ingest --dry-run <file.msg>` runs, then the command exits 0, prints `Type` as `email`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-03: CLI email ingest persists message metadata**

Given valid EML and MSG files, when `mulder ingest` runs for each file, then each source row has `source_type = 'email'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, a canonical `raw/{source_id}/original.eml` or `raw/{source_id}/original.msg` storage path, and `format_metadata.media_type` matching the file type.

**QA-04: EML detection rejects arbitrary text**

Given a plain text file renamed to `.eml` without a valid RFC 822 / MIME header block, when `mulder ingest --dry-run` runs, then it fails before source creation with an unsupported or invalid email message.

**QA-05: MSG detection rejects arbitrary compound/binary files**

Given an arbitrary binary or non-message OLE compound file renamed to `.msg`, when `mulder ingest --dry-run` runs, then it fails before source creation with an unsupported or invalid email message.

**QA-06: Directory ingest discovers PDFs, images, text, DOCX, spreadsheets, and emails**

Given a directory containing one PDF, one PNG, one `.txt`, one `.docx`, one `.csv`, one `.xlsx`, one `.eml`, and one `.msg`, when `mulder ingest --dry-run <dir>` runs, then all eight supported files appear in the output with their respective source types and the command exits 0.

**QA-07: Magic bytes remain authoritative**

Given a PDF, PNG, DOCX, or XLSX saved with an `.eml` or `.msg` extension, when `mulder ingest --dry-run` runs, then it reports the magic-byte/source-package type rather than `email` or rejects unsupported mismatches before source creation.

**QA-08: Email extract creates a pre-structured message story**

Given an ingested email source in dev mode, when `mulder extract <source_id>` runs, then the source reaches `extracted`, exactly one story row exists for the source, the story Markdown object exists under `segments/{source_id}/`, the Markdown contains headers and body content, no `extracted/{source_id}/layout.json` is written, and `source_steps.extract` is `completed`.

**QA-09: Header-derived entity hints are exposed to enrich**

Given an email with sender, recipients, date, subject, message ID, and thread headers, when extract runs, then story metadata contains `entity_hints` entries for those facts and the story Markdown includes an `Email Entity Hints` section with the same visible values.

**QA-10: Thread ID is deterministic**

Given two emails in the same conversation where one references the other via `References` or `In-Reply-To`, when extract runs for both, then each story metadata contains the same deterministic `thread_id`.

**QA-11: Supported attachments become child sources**

Given an email with a supported attachment such as `.txt`, `.docx`, `.csv`, `.xlsx`, PDF, or image content, when extract runs, then a child source row exists with `parent_source_id` equal to the email source ID, the attachment original is uploaded under the child source raw path, and the parent story metadata lists the child source ID.

**QA-12: Unsupported attachments remain metadata-only**

Given an email with an unsupported or parser-incomplete attachment, when extract runs, then no child source row is created for that attachment, but the parent story metadata and Markdown attachment summary include the filename/media type when available.

**QA-13: Pipeline skips segment for emails after extract**

Given an ingested email source, when `mulder pipeline run --from extract --up-to enrich --source-id <source_id>` or the equivalent existing-source path runs, then `extract` executes, `segment` is recorded as skipped, `enrich` runs against the created story, and no layout or segment job/artifact is created.

**QA-14: API upload accepts email media types**

Given an upload initiation request for `message.eml` with `content_type = message/rfc822` and for `message.msg` with `content_type = application/vnd.ms-outlook`, when each upload is completed and the finalize job runs, then source rows are created with `source_type = 'email'`, canonical storage paths, and an `extract` job is queued when `start_pipeline` is true.

**QA-15: Duplicate email ingest returns the existing source**

Given the same EML or MSG file is ingested twice, when the second ingest runs, then it reports duplicate status, does not create a second source row for the same file hash, and preserves `source_type = 'email'`.

**QA-16: Existing PDF, image, text, DOCX, and spreadsheet behavior remains green**

Given the existing Spec 85, Spec 86, Spec 87, Spec 88, Spec 89, and Spec 90 tests, when they run after this change, then PDF/image/text/DOCX/spreadsheet ingest, extract, duplicate handling, upload finalization, and pipeline planning remain compatible.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run <tmp>/message.eml` | Valid EML | Exit 0; output includes `email`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest --dry-run <tmp>/message.msg` | Valid MSG | Exit 0; output includes `email`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest <tmp>/message.eml` | Valid EML | Exit 0; DB row has `source_type = email`; storage path ends in `original.eml`. |
| `mulder ingest <tmp>/message.msg` | Valid MSG | Exit 0; DB row has `source_type = email`; storage path ends in `original.msg`. |
| `mulder ingest --dry-run <tmp>/fake.eml` | Plain text renamed to EML | Non-zero or failed-file result; no source row; invalid/unsupported email evidence is visible. |
| `mulder ingest --dry-run <tmp>/fake.msg` | Arbitrary binary/OLE renamed to MSG | Non-zero or failed-file result; no source row; invalid/unsupported MSG evidence is visible. |
| `mulder ingest --dry-run <tmp>/mixed-dir` | PDF + PNG + TXT + DOCX + CSV + XLSX + EML + MSG | Exit 0; output includes `pdf`, `image`, `text`, `docx`, `spreadsheet`, and `email`. |
| `mulder extract <email-source-id>` | Ingested EML/MSG source | Exit 0; one story is created directly from message headers/body; no layout JSON is written. |
| `mulder pipeline run --from extract --up-to enrich --source-id <email-source-id>` | Ingested email source | Exit 0; `segment` is skipped; the story reaches `enriched`. |

## 6. Cost Considerations

Email ingestion and email extract are deterministic local/storage/database operations. They must not call Document AI, Gemini Vision, or the Segment LLM path. Cost estimation should show EML/MSG files as zero scanned/layout pages for extract and should avoid reserving segment cost for email sources because Spec 86 skips `segment` for pre-structured formats. Downstream `enrich`, `embed`, and `graph` costs remain unchanged once email extract has produced story Markdown.
