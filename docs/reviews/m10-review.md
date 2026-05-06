---
milestone: M10
title: "Provenance & Quality — Pre-Archive Foundations"
reviewed_at: 2026-05-06
reviewed_sha: 21df3062a3422294f61d8cc54d631e953a07b97a
review_branch: origin/milestone/10
report_branch: codex/m10-milestone-review
steps_reviewed: 9
spec_sections:
  - "§A1"
  - "§A2"
  - "§A2.2"
  - "§A2.3"
  - "§A2.4"
  - "§A2.5"
  - "§A3"
  - "§A4"
  - "§A5"
  - "§A6"
  - "§A6.1"
verdict: PASS_WITH_WARNINGS
---

# M10 Milestone Review

## Summary

Verdict: **PASS_WITH_WARNINGS**.

M10 is complete on `origin/milestone/10` at `21df3062a3422294f61d8cc54d631e953a07b97a`. The roadmap marks K1-K9 complete, all M10 issues are closed, all M10 PRs are merged, the latest milestone CI run is green, and the local M10 scope suite passed.

Severity counts:

| Severity | Count |
| --- | ---: |
| CRITICAL | 0 |
| WARNING | 1 |
| NOTE | 0 |

## Reviewed Tasks

| Step | Spec | Issue | PR | Status |
| --- | --- | --- | --- | --- |
| M10-K1 | `docs/specs/98_content_addressed_storage.spec.md` | #262 | #263 | Closed / merged |
| M10-K2 | `docs/specs/99_artifact_provenance_tracking.spec.md` | #264 | #265 | Closed / merged |
| M10-K3 | `docs/specs/100_document_quality_assessment_step.spec.md` | #266 | #267 | Closed / merged |
| M10-K4 | `docs/specs/101_assertion_classification_enrich.spec.md` | #269 | #270 | Closed / merged |
| M10-K5 | `docs/specs/102_sensitivity_tagging_auto_detection.spec.md` | #271 | #272 | Closed / merged |
| M10-K6 | `docs/specs/103_source_rollback_soft_delete_cascading_purge.spec.md` | #273 | #274 | Closed / merged |
| M10-K7 | `docs/specs/104_ingest_provenance_data_model.spec.md` | #275 | #276 | Closed / merged |
| M10-K8 | `docs/specs/105_collection_management.spec.md` | #277 | #278 | Closed / merged |
| M10-K9 | `docs/specs/106_golden_tests_quality_routing_assertion_classification.spec.md` | #279 | #280 | Closed / merged |

## Section Review

### §A1 — Core vs. Domain Separation

No divergence found. M10's new storage, provenance, rollback, sensitivity, collection, quality, and assertion surfaces use generic names and config-driven defaults. Domain labels remain in user/config/test data rather than core schema or pipeline logic.

### §A2, §A2.2-§A2.5 — Ingest Data Model & Document Provenance

No divergence found in M10 scope.

Evidence:

- Content-addressed paths are built as `blobs/sha256/{first2}/{next2}/{hash}` and validate lowercase SHA-256 hashes (`packages/core/src/shared/blob-storage.ts:33-36`).
- `document_blobs` is content-hash keyed, and duplicate byte ingest appends filenames/provenance without duplicating the blob.
- K7 adds `archives`, `acquisition_contexts`, `original_sources`, `custody_steps`, and `archive_locations`.
- K8 makes `collections` real and attaches `acquisition_contexts.collection_id` through a nullable FK.
- Source purge moves exclusive blob records to `cold_storage` status and keeps shared blobs active.

Deferred items such as `blob_version_links`, virtual archive browsing, integrity cron jobs, and physical cold-bucket movement are outside the accepted M10 task specs.

### §A3 — Assertion Classification

No divergence found in M10 scope.

Evidence:

- `knowledge_assertions` stores `observation`, `interpretation`, and `hypothesis` assertions with confidence metadata, classification provenance, extracted entity ids, artifact provenance, quality metadata, sensitivity metadata, and active-row idempotency.
- Enrich persists assertions only when classification is enabled and keeps existing entity/relationship extraction compatible when disabled.
- K9 adds cost-free golden coverage for all three assertion labels.

Graph-structural separation and agent consumption are intentionally deferred by Spec 101 and later M11+ work.

### §A4 — Document Quality Pipeline

No divergence found in M10 scope.

Evidence:

- The canonical pipeline order now includes `quality` between `ingest` and `extract` (`packages/core/src/shared/pipeline-step-plan.ts:18-26`).
- `document_quality_assessments` persists method, quality, processability, route, dimensions, and signals.
- Extract gates `skip` and `manual_transcription_required` routes without failing the pipeline.
- K9 adds quality-routing goldens for `high`, `medium`, `low`, and `unusable`.

Gemini Vision assessment, enhanced OCR implementation, manual queues, and batch reports are explicitly out of scope for Spec 100.

### §A5 — Sensitivity Levels

No divergence found in M10 scope.

Evidence:

- K5 adds `sensitivity_level` and `sensitivity_metadata` to the current document/artifact tables named by Spec 102.
- Shared helpers expose the four generic levels and §A5 PII vocabulary.
- Enrich can require and persist model-detected sensitivity metadata, and upward propagation updates story/source sensitivity to the most restrictive child level.

RBAC, external query gating, export filtering, pseudonymization, and access audit UX are later work.

### §A6 and §A6.1 — Source Provenance Tracking & Rollback

No divergence found in M10 scope.

Evidence:

- K2 adds structured artifact provenance to current artifact stores and K4 extends the same pattern to assertions.
- K6 adds source soft-delete, restore, dry-run planning, confirmed purge, audit events, default-hidden deleted sources, and provenance subtraction for shared artifacts.
- K7 integrates rollback with acquisition contexts so source rollback marks/restores provenance contexts without deleting shared archive/blob metadata.

Cloud Run scheduling, journal/report annotation, translation stores, and credibility profiles are not present yet and are outside K6's accepted scope.

## Cross-Cutting Convention Review

No code-level convention divergence found in the reviewed M10 implementation. The reviewed code follows the repository's plain-function repository style, ESM TypeScript modules, config schema/default wiring, generic naming, and service-abstraction boundaries. The M10 tests are black-box/spec-scoped and avoid paid services where the task specs require cost-free behavior.

## `CLAUDE.md` Consistency

### WARNING — `CLAUDE.md` still describes the pre-M10 pipeline and raw storage layout

Spec evidence:

- §A4 requires quality assessment between ingest and extract (`docs/functional-spec-addendum.md:596-602`).
- §A2 requires content-addressed storage keyed by content hash and deduplication that appends provenance (`docs/functional-spec-addendum.md:386-417`).

Implementation evidence:

- The actual step order is `ingest`, `quality`, `extract`, `segment`, `enrich`, `embed`, `graph` (`packages/core/src/shared/pipeline-step-plan.ts:18-26`).
- The raw blob helper writes `blobs/sha256/{aa}/{bb}/{hash}` (`packages/core/src/shared/blob-storage.ts:33-36`).

Drift:

- `CLAUDE.md` still labels the full pipeline as "8 steps" and shows `ingest -> extract -> segment -> enrich -> [ground] -> embed -> graph -> [analyze]` (`CLAUDE.md:91-95`).
- `CLAUDE.md` still documents `raw/` as the original-PDF storage prefix (`CLAUDE.md:110-118`), while M10 moved canonical raw blobs to the content-addressed blob path.

Impact:

This does not invalidate the M10 implementation, but it can mislead future agents and humans during M11+ work because `CLAUDE.md` is a required workflow read.

## Verification

Local verification:

- `pnpm test:scope list milestone M10` found 9 M10 spec files.
- `pnpm test:scope run milestone M10 -- --reporter=verbose`
  - DB lane: 8 files, 79 tests passed.
  - Heavy lane: 1 file, 18 tests passed.
  - Total: 9 files, 97 tests passed.

Remote verification:

- Latest `milestone/10` CI: run `25437750308`, head `21df3062a3422294f61d8cc54d631e953a07b97a`, status `completed`, conclusion `success`.
- Open PRs against `milestone/10`: none.
- Open M10 issues found by GitHub search: none.

## Recommendations

Must-fix before M10 can stand: none.

Should-fix:

- Update `CLAUDE.md` so its pipeline and storage architecture sections reflect M10's `quality` step and content-addressed raw blob storage.

For consideration:

- Keep deferred addendum capabilities tracked in later milestone specs rather than widening M10 retroactively: blob version links, integrity cron jobs, physical cold-bucket movement, virtual archive browsing, RBAC/query gates, Gemini Vision quality assessment, and agent/report rollback annotation.

