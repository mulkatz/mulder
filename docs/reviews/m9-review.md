---
milestone: M9
title: "Beyond PDFs" - Multi-Format Ingestion
reviewed: 2026-05-04
steps_reviewed: [J1, J2, J3, J4, J5, J6, J7, J8, J9, J10, J11, J12, J13]
spec_sections: [§2, §2.1, §2.2, §2.7, §3, §3.1, §3.2, §4.3, §4.5, §15.1, §15.2]
verdict: PASS_WITH_WARNINGS
---

# Milestone Review: M9 - Multi-Format Ingestion

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Warning  | 1 |
| Note     | 3 |

**Verdict:** PASS_WITH_WARNINGS

M9 delivers the intended architecture shift from PDF-only ingestion to first-class multi-format sources. `sources.source_type` and `sources.format_metadata` are durable, file detection is magic-byte/content-shape driven, images stay on the layout path, text/DOCX/spreadsheet/email/URL sources produce story Markdown directly, source-type planning records `segment` as skipped for pre-structured formats, URL ingestion has fetch/render/lifecycle/refetch support, extract routing is driven by `source_type`, and the golden layer covers all seven source types.

The implementation is broadly aligned with the roadmap and functional spec. I found no critical divergence and no sign that the milestone went in the wrong direction. The one warning is a real surface gap: conservative cross-format dedup is implemented for CLI/URL ingest, but not for API/browser upload finalization, so one supported ingest surface can still create duplicates that M9-J12 was meant to avoid early.

---

## Per-Section Divergences

### §2.7 / M9-J12 - Cross-Format Dedup

**[DIV-001] API/browser upload finalization bypasses cross-format dedup**
- **Severity:** WARNING
- **Spec says:** Roadmap M9-J12 calls for "Cross-format dedup - early dedup at ingest" before graph-level MinHash (`docs/roadmap.md:256`). Spec 96 requires exact file-hash dedup to remain first, then a conservative cross-format lookup before upload/source creation when a strong cheap signal exists (`docs/specs/96_cross_format_ingest_dedup.spec.md:42-49`, `79-84`).
- **Code does:** CLI file ingest computes cross-format keys for text (`packages/pipeline/src/ingest/index.ts:760-768`), spreadsheet (`818-824`), email (`862-870`), and URL (`384-388`), then checks `findSourceByCrossFormatDedupKey()` before source creation (`905-927`, URL path `417-438`). Upload finalization in `packages/worker/src/dispatch.ts` only checks exact `file_hash` duplicates (`264-272`) and builds text/spreadsheet/email metadata without wrapping it in `withCrossFormatDedupMetadata()` (`348-367`, `389-415`, `427-453`).
- **Risk:** `mulder ingest report.txt` then browser/API upload of equivalent `report.md`, `.csv`, or `.eml` can create a second source row and miss the durable dedup metadata. Graph-level MinHash still protects later corroboration semantics, but the early M9 dedup promise is incomplete for one ingestion surface.
- **Recommendation:** Share the cross-format metadata/lookup helper between CLI ingest and `document_upload_finalize`, or explicitly document upload finalization as outside Spec 96. Given earlier M9 specs intentionally broadened API upload for these formats, sharing the helper is the cleaner alignment.

### §2.1 / M9-J1, J3-J10 - Ingest Surfaces

No blocking divergences found.

Verified:
- `021_source_type_format_metadata.sql` creates the M9 source discriminator and JSONB metadata, with repository mapping in `source.repository.ts`.
- `detectSourceType()` handles PDF/image magic bytes, OOXML DOCX/XLSX package evidence, CSV/text/email content shape, and URL input shape before source creation.
- CLI ingest accepts PDF, PNG/JPEG/TIFF, text/Markdown, DOCX, CSV/XLSX, EML/MSG, and URLs with per-format metadata and canonical raw storage paths.
- API upload schemas and worker finalization accept the non-URL file formats and canonicalize raw storage paths.
- URL ingest records snapshots, selected rendering metadata, host lifecycle state, and source lifecycle rows for real URL sources.

### §2.2 / M9-J3, J11 - Extract Routing

No divergences found.

Verified:
- `source-routing.ts` classifies `pdf`/`image` as layout sources and `text`/`docx`/`spreadsheet`/`email`/`url` as pre-structured sources.
- Extract branches by persisted `source.sourceType`, not filename.
- Pre-structured extractors create story Markdown and metadata under `segments/` and do not create route-primary `extracted/{source_id}/layout.json`.
- Image sources still use the Document AI/Gemini layout path and keep `segment` executable.

### §3.1 / §3.2 - Pipeline Composition and Step Skipping

No divergences found.

Verified:
- `planPipelineSteps()` preserves `ingest -> extract -> segment -> enrich -> embed -> graph` as the requested order and removes only `segment` from executable work for pre-structured sources.
- Synchronous pipeline runs record `source_steps.segment = skipped` and advance to `enrich`.
- API acceptance uses the same source-type plan, enqueues `enrich` instead of `segment` when appropriate, and excludes skipped work from budgetable steps.
- Worker chaining delegates to source-aware pipeline execution and preserves PDF/image behavior.

### §4.3 / §4.5 - Schema and Service Boundaries

No divergences found.

Verified:
- Migrations add the source discriminator, parent source relationship, URL lifecycle tables, and URL host lifecycle tables without replacing the PostgreSQL source of truth.
- Format extraction remains behind service interfaces (`documentAi`, `officeDocuments`, `spreadsheets`, `emails`, `urls`, `urlRenderers`, `urlExtractors`). Pipeline code does not import raw GCP clients.
- Firestore writes remain best-effort observability; routing and orchestration use PostgreSQL.

### §15.1 / §15.2 - Golden Tests

No blocking divergences found.

Verified:
- `eval/golden/multi-format/manifest.json` has one deterministic case per M9 source type.
- `tests/specs/97_multi_format_golden_tests.test.ts` exercises ingest, extract, route behavior, story artifact convergence, skipped segment recording, and a strong-signal duplicate pair through CLI/database/storage boundaries.
- Spec 97 interprets §15.2 quality signals locally as route, metadata, story, and duplicate assertions rather than live OCR/model quality scoring. That is appropriate for the M9 no-paid-service golden layer.

---

## Cross-Cutting Notes

**[NOTE-001] Attachment child sources are source rows, but do not get an ingest step row**
- Email extract registers supported attachments as child `sources` and uploads the raw bytes (`packages/pipeline/src/extract/index.ts:1322-1335`), but it does not upsert `source_steps.ingest = completed` for those child sources. The spec says child pipelines are not executed inside parent email extract and remain normal sources that can be scheduled. Scheduling by source status still works, so this is not blocking, but step observability/reprocess semantics are slightly less complete than top-level ingest.

**[NOTE-002] Fresh local-file pipeline dry-run is aggregate-only**
- URL dry-run and existing-source dry-run compute source-type-aware plans. For a fresh local path with `ingest` in the requested range, `pipeline run --dry-run` currently counts files via `resolvePdfFiles()`/supported-file discovery without materializing dry-run sources (`packages/pipeline/src/pipeline/index.ts:677-689`), so it cannot show per-source `sourceType` or skipped steps for local text/DOCX/spreadsheet/email inputs. Specs explicitly require seeded/existing-source dry-run coverage, so this is an ergonomics gap rather than a contract failure.

**[NOTE-003] Duplicate task spec files remain for M9-J2/J3**
- `pnpm test:scope list milestone M9` resolves two Spec 86 files and two Spec 87 files, though the final test selection still lands on the expected 14 M9 test files. This is harmless for the runner today but can confuse future agents about which task spec is authoritative. Marking the older J2/J3 spec docs as superseded would reduce review friction.

---

## Critical Correctness Checks

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Every source has `source_type` and `format_metadata` | PASS | Migration 021 plus source repository create/update mapping |
| 2 | Magic bytes beat misleading extensions | PASS | `detectSourceType()` routes PDF/image magic before text/email fallbacks; M9 tests cover renamed files |
| 3 | Images stay on the layout path | PASS | `LAYOUT_SOURCE_TYPES = ['pdf', 'image']`; image extract uses Document AI media type path |
| 4 | Pre-structured sources bypass segment | PASS | `PRESTRUCTURED_SOURCE_TYPES` includes text/DOCX/spreadsheet/email/URL; planner records skipped `segment` |
| 5 | Text/DOCX/spreadsheet/email/URL extract create stories directly | PASS | Dedicated extract branches create Markdown/story rows and no route-primary layout JSON |
| 6 | API and worker orchestration use source-aware step planning | PASS | API `planSourcePipeline()` plus worker `pipeline_run` dispatch preserve skipped-step behavior |
| 7 | URL lifecycle supports fetch, status, changed/unchanged refetch, and reset | PASS | URL lifecycle repository plus `refetchUrlSource()` reset changed snapshots to `ingested` and clear extract state |
| 8 | Extract routing is controlled by `source_type`, not filename | PASS | `requireExtractRoute(source.sourceType)` is called after loading the source row |
| 9 | Early cross-format dedup exists before graph MinHash | PARTIAL | CLI/URL ingest pass; API/browser upload finalization gap is DIV-001 |
| 10 | Graph-level MinHash dedup remains unchanged | PASS | Spec 96 regression runs existing graph tests; graph dedup module remains separate |
| 11 | Golden layer covers every M9 source type | PASS | Manifest has pdf/image/text/docx/spreadsheet/email/url cases |
| 12 | Format extractors use service abstractions | PASS | Core `Services` interface owns all external/parsing services; pipeline consumes injected services |

---

## Verification

Passed in this review branch:

```bash
pnpm test:scope run milestone M9 -- --reporter=verbose
```

Result: 14 test files passed, 136 tests passed, duration 543.00s.

---

## Recommendations

1. Fix DIV-001 before treating M9 as fully polished: reuse CLI ingest's cross-format metadata and lookup path inside `document_upload_finalize`.
2. Add a focused regression test for API/browser upload cross-format duplicate behavior after that fix.
3. Optional cleanup: mark the older duplicate M9-J2/J3 spec files as superseded and consider richer local-file pipeline dry-run source plans.
