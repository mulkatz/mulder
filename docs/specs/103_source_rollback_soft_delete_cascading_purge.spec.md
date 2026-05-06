---
spec: 103
title: "Source Rollback Soft Delete And Cascading Purge"
roadmap_step: "M10-K6"
functional_spec: "§A6, §A1, §A2"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/273"
created: 2026-05-06
---

# Spec 103: Source Rollback Soft Delete And Cascading Purge

## 1. Objective

Complete M10-K6 by adding a structured source rollback workflow: immediate soft-delete, restore during the undo window, and a deterministic cascading purge that removes or provenance-subtracts artifacts created from the removed source. §A6 defines rollback as a different operation from `--force`: rollback removes a source from active analysis, while force resets a processing step for re-run.

This step must make rollback safe before archive ingest. A deleted source must disappear from normal repository and CLI views immediately, while purge remains auditable, explicit, and reversible only before the undo deadline.

## 2. Boundaries

**Roadmap step:** M10-K6 - Source rollback: soft-delete + cascading purge.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/273-source-rollback-soft-delete-purge`.

**In scope:**

- Add source deletion state to `sources` and a `source_deletions` table.
- Add a generic `audit_log` table for rollback and purge events.
- Add config under `source_rollback` with §A6 defaults.
- Add repository APIs for soft-delete, restore, purge planning, purge execution, and audit listing.
- Hide soft-deleted sources from normal source/story/artifact repository reads by default, while preserving explicit include-deleted options for admin/rollback use.
- Implement cascading purge for stores that exist today: source steps, pipeline run links, document quality assessments, stories/segments, story entities, entity edges, chunks, knowledge assertions, entities/aliases that become unreferenced, URL lifecycle rows, and current source/blob links.
- For artifacts with provenance from multiple sources, remove only the deleted source id from provenance and keep the artifact active.
- Add CLI commands for rollback soft-delete, restore, purge dry-run, and confirmed purge.

**Out of scope:**

- Cloud Run job scheduling for automatic purge after the undo window; K6 provides the deterministic purge command/path that a later worker can schedule.
- Journal/report annotation and agent-session handling; those stores do not exist yet.
- Translation stores and credibility profiles that do not exist yet.
- Physical GCS deletion beyond source/segment paths already represented by current storage services; long-term cold-storage policy belongs to later archive/storage work.
- RBAC enforcement; K5 only added sensitivity metadata and M11-L5 will enforce roles.

**Primary files:**

- `packages/core/src/database/migrations/032_source_rollback.sql`
- `packages/core/src/database/repositories/source-rollback.types.ts`
- `packages/core/src/database/repositories/source-rollback.repository.ts`
- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/database/repositories/story.repository.ts`
- `packages/core/src/database/repositories/knowledge-assertion.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `apps/cli/src/commands/source.ts` or the existing closest source/rollback command module
- `apps/cli/src/index.ts` if command registration changes
- `tests/specs/103_source_rollback_soft_delete_cascading_purge.test.ts`
- `docs/roadmap.md`

## 3. Dependencies

- M10-K1 / Spec 98: sources have durable content-addressed raw storage references.
- M10-K2 / Spec 99: artifacts carry `provenance.source_document_ids`.
- M10-K4 / Spec 101: `knowledge_assertions` exists and supports active/deleted rows.
- M10-K5 / Spec 102: sensitivity-bearing artifacts must be preserved or purged consistently.

K6 blocks M10-K7 and M10-K8 operational use because ingest provenance and collection metadata need a safe removal path before archive data enters the system.

## 4. Blueprint

1. Add migration `032_source_rollback.sql`:
   - Add `deleted_at TIMESTAMPTZ`, `deletion_status TEXT NOT NULL DEFAULT 'active'`, and `active_source BOOLEAN` or equivalent lookup/index support to `sources`.
   - Constrain `deletion_status` to `active`, `soft_deleted`, `purging`, `purged`, `restored`.
   - Create `source_deletions` with `id`, `source_id`, `deleted_by`, `deleted_at`, `reason`, `status`, `undo_deadline`, `restored_at`, `purged_at`, timestamps, and a current-row uniqueness rule.
   - Create `audit_log` with `id`, `event_type`, `artifact_type`, `artifact_id`, `source_id`, `actor`, `reason`, `metadata`, and `created_at`.
   - Add indexes for active source lookup, deletion status, undo deadline, and audit source/event lookups.

2. Add config:
   - `source_rollback.undo_window_hours` default `72`.
   - `auto_purge_after_undo_window` default `true`.
   - `require_reason` default `true`.
   - `require_confirmation` default `true`.
   - `orphan_handling` enum `mark | delete` default `mark`.
   - `journal_annotation`, `notify_on_purge` defaults from §A6.

3. Add repository APIs:
   - `softDeleteSource(pool, input)` validates reason, sets source status, writes `source_deletions`, and writes audit.
   - `restoreSource(pool, input)` restores the current soft deletion before purge and writes audit.
   - `planSourcePurge(pool, sourceId)` returns counts by subsystem and whether each artifact is exclusive or shared.
   - `purgeSource(pool, input)` executes in one transaction, writes audit, marks deletion status, and returns the purge report.
   - `listSourceDeletions`, `findSourceDeletionForSource`, and `listAuditEventsForSource` support CLI/admin visibility.

4. Default visibility:
   - Normal source repository reads and list helpers exclude `deletion_status IN ('soft_deleted', 'purging', 'purged')`.
   - Story/artifact lookups that are source-scoped exclude soft-deleted sources by default.
   - Add explicit `{ includeDeleted: true }` or rollback-specific helpers where needed.
   - Preserve existing tests by keeping legacy behavior for hard delete helpers unless they are specifically rollback commands.

5. Purge semantics for current stores:
   - Delete stories for the source and cascade current story-scoped rows.
   - Delete source steps, pipeline run source links, document quality assessments, URL lifecycle rows, and source-local metadata.
   - For `knowledge_assertions`, soft-delete rows whose provenance only contains the purged source; subtract the source id from shared rows.
   - For entities, aliases, story entity links, edges, and chunks, use provenance to delete exclusive artifacts or subtract shared provenance where a row can remain valid.
   - Garbage-collect unreferenced entities according to `orphan_handling`: mark where supported, otherwise delete when no live story/entity references remain.
   - Mark the source `purged` and keep the source deletion/audit protocol.

6. CLI:
   - `mulder source rollback <source-id> --reason <reason> [--actor <id>] [--json]`.
   - `mulder source restore <source-id> [--actor <id>] [--json]`.
   - `mulder source purge <source-id> --dry-run [--json]`.
   - `mulder source purge <source-id> --confirm --reason <reason> [--actor <id>] [--json]`.
   - Missing reason or confirmation exits non-zero when configured.

7. Update roadmap state only after gates:
   - Keep K6 marked in progress while implementation is open.
   - Mark K6 complete only after scoped tests, affected checks, review, and PR merge to `milestone/10`.

## 5. QA Contract

1. **QA-01: Migration creates rollback state and audit tables**
   - Given a migrated database
   - When schema metadata is inspected
   - Then `sources` has deletion state columns, `source_deletions` and `audit_log` exist, constraints enforce valid statuses, and useful indexes exist.

2. **QA-02: Config exposes §A6 defaults**
   - Given minimal config
   - When config is loaded
   - Then `source_rollback` defaults match §A6, including a 72-hour undo window and required reason/confirmation.

3. **QA-03: Soft-delete hides sources from normal reads**
   - Given an active source with story/artifacts
   - When rollback soft-delete is called with actor and reason
   - Then normal source list/read helpers hide it, include-deleted helpers can see it, `source_deletions` records the undo deadline, and audit contains the rollback event.

4. **QA-04: Restore reactivates a soft-deleted source**
   - Given a soft-deleted source inside the undo window
   - When restore is called
   - Then normal reads show it again, deletion status is `restored` or active per repository contract, and audit records the restore.

5. **QA-05: Purge dry-run reports planned cascade**
   - Given a soft-deleted source with stories, chunks, edges, assertions, source steps, quality assessments, and URL lifecycle metadata
   - When purge is run with `dryRun`
   - Then no rows are deleted and the report includes non-zero counts grouped by subsystem.

6. **QA-06: Purge deletes exclusive artifacts and keeps audit**
   - Given a soft-deleted source with artifacts whose provenance only includes that source
   - When confirmed purge runs
   - Then exclusive downstream artifacts are removed or soft-deleted according to their table contract, source status is `purged`, and audit records the purge protocol.

7. **QA-07: Purge subtracts shared provenance**
   - Given an assertion or graph artifact with provenance from two source ids
   - When one source is purged
   - Then the artifact remains active with the purged source removed from `provenance.source_document_ids`.

8. **QA-08: CLI safety gates enforce reason and confirmation**
   - Given rollback CLI commands
   - When reason or confirmation is missing where required
   - Then the command exits non-zero and no deletion/purge state changes.

9. **QA-09: CLI rollback, restore, dry-run, and purge work**
   - Given test sources in the database
   - When the CLI rollback/restore/purge commands run with `--json`
   - Then they exit 0, emit parseable JSON, and match the repository-visible state transitions.

## 5b. CLI Test Matrix

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder source rollback <source-id> --reason "duplicate ingest" --actor test --json` | Active source | Exit 0; source hidden from normal reads and deletion row written. |
| `mulder source rollback <source-id> --json` | Active source | Exit non-zero when reason is required; no state change. |
| `mulder source restore <source-id> --actor test --json` | Soft-deleted source inside undo window | Exit 0; source visible again. |
| `mulder source purge <source-id> --dry-run --json` | Soft-deleted source | Exit 0; report only, no deleted rows. |
| `mulder source purge <source-id> --confirm --reason "requested removal" --actor test --json` | Soft-deleted source | Exit 0; source marked purged and downstream artifacts handled. |
| `mulder source purge <source-id> --reason "requested removal"` | Soft-deleted source | Exit non-zero when confirmation is required; no purge. |

## 6. Cost Considerations

K6 is deterministic database, local storage, and CLI work. It must not call paid AI services. Purge may delete storage objects represented by current source/story paths, but the default implementation should keep physical deletion bounded and auditable. Large production purges should be run with dry-run first and reviewed before confirmation.
