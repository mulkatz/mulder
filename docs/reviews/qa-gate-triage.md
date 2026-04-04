# QA Gate Triage — Pre-Search Verification Checkpoint

**Date:** 2026-04-04
**Scope:** M1-M3 + D1-D3 (31 completed roadmap steps)
**Issue:** https://github.com/mulkatz/mulder/issues/69

## Purpose

This document classifies 5 known issues discovered during the QA gate exploration. Each issue is classified as BY DESIGN, RESERVED, or KNOWN LIMITATION with evidence from the codebase and functional spec.

---

## Issue 1: TaxonomyStatus vs TaxonomyEntryStatus

**Classification:** BY DESIGN

**Description:** Two different enums with overlapping values exist for taxonomy-related status tracking. `TaxonomyStatus` (auto | curated | merged) lives on the `entities` table and tracks entity-level taxonomy lifecycle. `TaxonomyEntryStatus` (auto | confirmed | rejected) lives on the `taxonomy` table and tracks taxonomy entry curation lifecycle.

**Evidence:**
- `packages/core/src/database/repositories/entity.types.ts:18` — `TaxonomyStatus = 'auto' | 'curated' | 'merged'`
- `packages/core/src/database/repositories/taxonomy.types.ts:16` — `TaxonomyEntryStatus = 'auto' | 'confirmed' | 'rejected'`
- Functional spec §6.2: Normalization creates taxonomy entries with `auto` status; §6.3: Curation workflow changes entries to `confirmed` or `rejected`
- Functional spec §4.3: `entities.taxonomy_status` tracks whether an entity has been auto-matched, human-curated, or merged with another entity

**Rationale:** These are intentionally different enums tracking different concepts. An entity can be `merged` (combined with another entity), while a taxonomy entry can be `rejected` (removed from canonical vocabulary). The shared `auto` value reflects that both start in an automatic state before human intervention.

---

## Issue 2: Embed/Graph Resets Don't Update sources.status

**Classification:** BY DESIGN

**Description:** When calling `reset_pipeline_step(source_id, 'embed')` or `reset_pipeline_step(source_id, 'graph')`, the source's status is not updated. Only story statuses change.

**Evidence:**
- `packages/core/src/database/migrations/014_pipeline_functions.sql:32-38` — embed reset has no `UPDATE sources` statement
- `packages/core/src/database/migrations/014_pipeline_functions.sql:40-47` — graph reset has no `UPDATE sources` statement
- Functional spec §4.3.1 — the PL/pgSQL function spec shows embed/graph resets only update `stories.status`, not `sources.status`

**Rationale:** The embed and graph steps operate on stories, not sources. Source status advancement is the orchestrator's responsibility (D6). These reset functions correctly scope their status changes to the level at which the step operates.

---

## Issue 3: Enrich Doesn't Advance sources.status

**Classification:** BY DESIGN

**Description:** After running `mulder enrich --source <id>`, stories advance to `status = 'enriched'` but `sources.status` remains at `'segmented'`.

**Evidence:**
- Functional spec §2.4 step 10: "Update story status to enriched" — no mention of updating source status
- Functional spec §3.2: The pipeline orchestrator is responsible for advancing source status across steps
- `tests/specs/34_qa_status_state_machine.test.ts` QA-10: Explicitly verifies this behavior

**Rationale:** Enrich operates at the story level. A source may have some stories enriched and others still segmented (in a future partial-processing scenario). The orchestrator (D6, not yet built) is responsible for aggregating story statuses and advancing the source status when all stories reach a given level.

---

## Issue 4: 14 Error Codes Defined But Never Thrown

**Classification:** RESERVED

**Description:** Fourteen error codes exist in `packages/core/src/shared/errors.ts` that are not currently thrown anywhere in production source code. They are defined for future pipeline steps and capabilities.

**Evidence:**
- `CONFIG_NOT_FOUND` — Reserved for config file resolution in CLI commands
- `PIPELINE_SOURCE_NOT_FOUND` — Reserved for D6 pipeline orchestrator
- `PIPELINE_WRONG_STATUS` — Reserved for D6 pipeline orchestrator status checks
- `PIPELINE_STEP_FAILED` — Reserved for D6 pipeline orchestrator step failure wrapping
- `PIPELINE_RATE_LIMITED` — Reserved for D6 pipeline orchestrator retry exhaustion (referenced in `isRetryableError` type guard)
- `TAXONOMY_BOOTSTRAP_TOO_FEW` — Reserved for F1 taxonomy bootstrap command
- `INGEST_DUPLICATE` — Reserved for M9 cross-format deduplication
- `EXTRACT_PAGE_RENDER_FAILED` — Reserved for real GCP page rendering failures (dev mode uses fixture PNGs)
- `ENRICH_VALIDATION_FAILED` — Reserved for Gemini structured output validation (currently handled by retry)
- `EMBED_STORY_NOT_FOUND` — Reserved for D4 embed step execute()
- `EMBED_INVALID_STATUS` — Reserved for D4 embed step execute()
- `EMBED_MARKDOWN_NOT_FOUND` — Reserved for D4 embed step execute()
- `EMBED_QUESTION_GENERATION_FAILED` — Reserved for D4 embed step execute()
- `EMBED_CHUNK_WRITE_FAILED` — Reserved for D4 embed step execute()

**Resolution:** Each code now has a `@reserved` JSDoc annotation documenting its intended future use. The QA-21 test verifies no DEAD codes exist (all are either ACTIVE or RESERVED).

---

## Issue 5: Fixtures Disconnected From Real PDFs

**Classification:** KNOWN LIMITATION

**Description:** Dev-mode fixtures in `fixtures/` are static snapshots of real GCP outputs. They may drift from actual GCP API response structures over time. The fixture-based tests validate code behavior against these snapshots, not against live GCP services.

**Evidence:**
- `fixtures/extracted/` — Static Document AI layout JSON snapshots
- `fixtures/segments/` — Static Gemini segmentation output snapshots
- `packages/core/src/shared/services.dev.ts` — Dev service implementation reads from fixtures
- `CLAUDE.md` architecture: "dev_mode: true → no GCP calls, fixture-based"

**Rationale:** This is an inherent trade-off of fixture-based development. The `mulder fixtures generate` command (B8) exists to re-generate fixtures from real GCP runs. This is not a code correctness concern — it's a maintenance task to keep fixtures fresh. Real GCP integration is validated separately when running in production mode.

---

## Gate Verdict

All 5 issues are classified and accounted for. None are bugs. The QA gate can proceed.

- **BY DESIGN (3):** Issues 1, 2, 3 — intentional architectural decisions documented in the functional spec
- **RESERVED (1):** Issue 4 — error codes annotated for future use with `@reserved` JSDoc
- **KNOWN LIMITATION (1):** Issue 5 — fixture freshness is a maintenance concern, not a correctness issue
