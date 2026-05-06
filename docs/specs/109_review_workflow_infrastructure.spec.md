---
spec: 109
title: "Review Workflow Infrastructure"
roadmap_step: "M11-L3"
functional_spec: "§A13, §A3, §A5, §A8, §A9"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/289"
created: 2026-05-06
---

# Spec 109: Review Workflow Infrastructure

## 1. Objective

Complete M11-L3 by adding Mulder's domain-agnostic review workflow infrastructure from §A13. LLM-generated and trust-layer artifacts must be representable as reviewable artifacts, moved through immutable review events, and surfaced through thematic queues with pending counts and oldest pending timestamps. This work makes L1 credibility profiles and L2 conflict artifacts review-ready without introducing a UI or deciding open product questions such as expertise weighting.

The review layer is not a parallel fact store. It records the human-review state of artifacts produced elsewhere and keeps enough current value plus context for a later API/UI to present them safely. Review decisions must be auditable, disagreement must be preserved as `contested`, and auto-approval must remain distinguishable from manual approval.

## 2. Boundaries

**Roadmap step:** M11-L3 - Review workflow infrastructure - ReviewableArtifact, queues, events.

**Base branch:** `milestone/11`. This spec is delivered to the M11 integration branch, not directly to `main`.

**Target branch:** `feat/289-review-workflow-infrastructure`.

**Primary files:**

- `packages/core/src/database/migrations/039_review_workflow.sql`
- `packages/core/src/database/repositories/review-workflow.repository.ts`
- `packages/core/src/database/repositories/review-workflow.types.ts`
- `packages/core/src/database/repositories/source-credibility.repository.ts`
- `packages/core/src/database/repositories/conflict-node.repository.ts`
- `packages/core/src/database/repositories/source-rollback.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/index.ts`
- `tests/lib/schema.ts`
- `tests/specs/109_review_workflow_infrastructure.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `review_artifacts`, `review_events`, and `review_queues` tables with constrained §A13 status, action, confidence, and creator values.
- Add repository APIs for upserting/listing reviewable artifacts, appending immutable events, applying review status transitions, listing queues with computed counts, and auto-approving due artifacts.
- Register review artifacts for M11 trust-layer objects: `credibility_profile`, `conflict_node`, and `conflict_resolution`.
- Add `review_workflow` config defaults and schema aligned with §A13.
- Preserve review disagreement as `contested` instead of majority-voting or overwriting the disagreement.
- Keep queue counts computed from current artifact rows so counts cannot drift.
- Extend source purge/reset cleanup so review rows for purged source-owned artifacts do not survive as dangling review work.

**Out of scope:**

- Review API routes, app UI, notifications, export/import of offline review batches, or project-board style reviewer assignment screens.
- Expertise weighting, gamification, consensus algorithms, or any product choice listed as open in §A13.8.
- Agent findings, taxonomy mappings, similar-case links, and assertion-classification review integration beyond keeping the artifact type model generic enough for later steps.
- Changing credibility dimension scores, conflict severity, or assertion classification values automatically based on review metrics.
- Background schedulers for auto-approval. L3 provides a repository operation that callers can invoke later.

**Architectural constraints:**

- Review events are append-only after creation. Corrections create new events and update the review artifact projection.
- Review artifact lookup by `(artifact_type, subject_id)` must be idempotent for active rows.
- Queue summaries must be derived from `review_artifacts`, not denormalized counters.
- Review context/current value are JSONB payloads owned by the producing feature and must be stored as objects for inspectability.
- Default config and tests must work from a fresh checkout using example/temp configs, not a missing root `mulder.config.yaml`.

## 3. Dependencies

- M10-K4 / Spec 101: assertion classification is one future reviewable artifact type.
- M10-K5 / Spec 102: sensitivity metadata exists and review artifacts must not bypass sensitivity-aware future filtering.
- M11-L1 / Spec 107: credibility profiles exist and carry draft/review status.
- M11-L2 / Spec 108: conflict nodes and conflict resolutions exist and carry review status.

L3 blocks L4/L5 only at the milestone integration level, but it directly enables later API/UI review queues, credibility review, conflict resolution review, and agent output review.

## 4. Blueprint

1. Add migration `039_review_workflow.sql`:
   - Create `review_artifacts` with `artifact_id UUID`, constrained `artifact_type`, `subject_id UUID`, `subject_table TEXT`, constrained `created_by` (`llm_auto`, `human`, `agent`), constrained `review_status` (`pending`, `approved`, `auto_approved`, `corrected`, `contested`, `rejected`), `current_value JSONB`, `context JSONB`, `source_id UUID`, `priority INTEGER`, `due_at TIMESTAMPTZ`, timestamps, and `deleted_at`.
   - Add a partial unique index on `(artifact_type, subject_id)` for active artifacts.
   - Create `review_events` with `event_id UUID`, `artifact_id`, `reviewer_id`, constrained action (`approve`, `correct`, `reject`, `comment`, `escalate`), previous/new JSON values, constrained confidence (`certain`, `likely`, `uncertain`), required rationale for `correct`, `reject`, and `escalate`, tags, and `created_at`.
   - Create `review_queues` with stable `queue_key`, name, `artifact_types TEXT[]`, assignees, priority rules JSONB, active flag, and timestamps.
   - Seed default queues for credibility profiles, conflicts, and contested artifacts.
   - Add indexes for pending queue scans, status, type, source, due date, and event history.
   - Extend source purge/reset cleanup where source-owned review artifacts can be safely deleted or soft-deleted.

2. Add repository module and exports:
   - Define `ReviewableArtifact`, `ReviewEvent`, `ReviewQueue`, `ReviewStatus`, `ReviewAction`, `ReviewConfidence`, `ReviewCreatedBy`, and input/list option types.
   - Implement `upsertReviewableArtifact`, `findReviewableArtifactById`, `findReviewableArtifactBySubject`, `listReviewableArtifacts`, `recordReviewEvent`, `listReviewEvents`, `upsertReviewQueue`, `listReviewQueues`, `listReviewQueueArtifacts`, `autoApproveDueReviewArtifacts`, and source cleanup helpers.
   - `recordReviewEvent` must run in one transaction, insert the immutable event, and update only the artifact projection.
   - Approve sets status `approved`; correct sets `corrected` and replaces `current_value`; reject sets `rejected`; escalate sets `contested`; comment leaves status unchanged unless the artifact is already contested.
   - If a second reviewer records a contradictory terminal action against an already reviewed artifact, set status `contested` and keep both event positions in history.
   - Queue summaries compute `pending_count` and `oldest_pending` at read time.

3. Add config:
   - `review_workflow.enabled` default `true`.
   - `artifact_types.assertion_classification` defaults to spot-check, 20 percent, auto-approve after 168 hours, min confidence 0.9.
   - `artifact_types.credibility_profile` defaults to double-review and no auto-approval.
   - `artifact_types.taxonomy_mapping` defaults to single-review and auto-approve after 336 hours.
   - `artifact_types.similar_case_link` defaults to single-review and auto-approve after 168 hours.
   - `artifact_types.agent_finding` defaults to single-review and no auto-approval.
   - `metrics.track_accuracy`, `auto_adjust_depth`, `accuracy_threshold_for_upgrade`, and `accuracy_threshold_for_downgrade` match §A13.

4. Integrate existing M11 artifacts:
   - When a source credibility profile is created or updated with `profile_author = llm_auto` or draft-like status, upsert a `credibility_profile` review artifact with a compact current value and source context.
   - When a conflict node is created, upsert a `conflict_node` review artifact with severity, status, participant claim summaries, provenance, and sensitivity context.
   - When a conflict resolution is created, upsert a `conflict_resolution` review artifact with resolution type, explanation, resolver, evidence refs, and conflict context.
   - These integrations must not fail the original feature on duplicate review artifact creation. Validation failures should surface during tests and development.

5. Add metrics-ready behavior without automating policy decisions:
   - Repository list options expose status/action filters sufficient for later accuracy reporting.
   - L3 does not implement automatic review-depth upgrades/downgrades. It stores config and events needed for that later behavior.

6. Update roadmap state only after gates:
   - Keep L3 in progress while implementation is open.
   - Mark L3 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/11`.

## 5. QA Contract

1. **QA-01: Review schema is constrained and idempotent**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `review_artifacts`, `review_events`, and `review_queues` exist with required constraints, active subject uniqueness, default queues, and indexes for pending/status/type scans.

2. **QA-02: Config exposes §A13 defaults**
   - Given minimal config based on the example config
   - When it is loaded through the public config loader
   - Then `review_workflow` is enabled with the §A13 artifact-type depths, auto-approval windows, spot-check percentage, and metrics thresholds.

3. **QA-03: Artifacts are upserted and listed by queue**
   - Given a `credibility_profile` review artifact and a `conflict_node` review artifact
   - When the repository lists review artifacts and queue summaries
   - Then each artifact is returned once by subject, the matching thematic queue has computed pending count, and oldest pending reflects the earliest pending artifact.

4. **QA-04: Review events are immutable and update projection status**
   - Given a pending review artifact
   - When a reviewer approves it, comments on it, or corrects it with a new value
   - Then immutable events are appended, status transitions follow §A13, and the artifact history exposes previous/new values without mutating earlier events.

5. **QA-05: Reviewer disagreement becomes contested**
   - Given one reviewer approves an artifact
   - When a different reviewer rejects or corrects the same artifact with rationale
   - Then the artifact status becomes `contested`, both positions remain in event history, and the contested queue includes the artifact.

6. **QA-06: Auto-approval is explicit**
   - Given a pending artifact whose due date has passed and whose artifact type allows auto-approval
   - When `autoApproveDueReviewArtifacts` runs
   - Then the artifact status becomes `auto_approved` and the result count reports the updated artifact without creating a manual approval event.

7. **QA-07: Credibility profiles register review artifacts**
   - Given a source credibility profile is auto-generated or upserted in draft state
   - When the profile repository completes
   - Then a `credibility_profile` review artifact exists with source context and does not require a root local `mulder.config.yaml`.

8. **QA-08: Conflict nodes and resolutions register review artifacts**
   - Given a conflict node and a typed conflict resolution are created
   - When the conflict repository completes
   - Then `conflict_node` and `conflict_resolution` review artifacts exist with participant/resolution context and can be found through the conflict review queue.

## 5b. CLI Test Matrix

N/A - no CLI commands are added in this step. Existing config CLI behavior must continue to accept minimal example-derived configs with `review_workflow` omitted so defaults are applied.

## 6. Cost Considerations

L3 adds no direct paid-service calls. It can increase database writes when LLM-generated artifacts are produced, so integrations must use idempotent upserts and compact JSON context. Queue summaries must be computed with indexed filters to avoid expensive full-table scans as review volume grows.
