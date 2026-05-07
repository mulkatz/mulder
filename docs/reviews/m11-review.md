---
milestone: M11
title: "Trust Layer — Credibility, Contradictions, Review"
reviewed_at: 2026-05-07
reviewed_sha: 091b7d2329121c7831a18266b7cd601234baf1a7
review_branch: milestone/11
steps_reviewed: 5
spec_sections:
  - "§A3"
  - "§A5"
  - "§A5.3"
  - "§A7"
  - "§A8"
  - "§A9"
  - "§A13"
verdict: PASS_WITH_WARNINGS
---

# M11 Milestone Review

## Summary

Verdict: **PASS_WITH_WARNINGS**.

M11 is complete on `milestone/11` at `091b7d2329121c7831a18266b7cd601234baf1a7`. The roadmap marks L1-L5 complete, the related M11 issues are closed, the M11 PRs are merged, and the latest pre-review `milestone/11` CI run is green.

Severity counts:

| Severity | Count |
| --- | ---: |
| CRITICAL | 0 |
| WARNING | 2 |
| NOTE | 5 |

## Reviewed Tasks

| Step | Spec | Issue | PR | Status |
| --- | --- | --- | --- | --- |
| M11-L1 | `docs/specs/107_credibility_profile_drafts.spec.md` | #283 | #284 | Closed / merged |
| M11-L2 | `docs/specs/108_conflict_node_management.spec.md` | #287 | #288 | Closed / merged |
| M11-L3 | `docs/specs/109_review_workflow_infrastructure.spec.md` | #289 | #290 | Closed / merged |
| M11-L4 | `docs/specs/110_translation_service.spec.md` | #291 | #292 | Closed / merged |
| M11-L5 | `docs/specs/111_rbac_implementation.spec.md` | #293 | #294 | Closed / merged |

## Section Review

### §A3 — Assertion Classification

No M11-specific divergence found. M11 correctly builds on the M10 `knowledge_assertions` table rather than inventing a second assertion store.

Evidence:

- Conflict nodes reference persisted assertions and copy assertion type, claim text, source id, credibility profile id, provenance, and sensitivity context from `knowledge_assertions` (`packages/core/src/database/repositories/conflict-node.repository.ts:339-359`).
- Review workflow includes `assertion_classification` as a valid future artifact type (`packages/core/src/database/migrations/039_review_workflow.sql:16-25`).

NOTE: Actual assertion-classification review artifact registration remains deferred. Spec 109 explicitly keeps assertion-classification review integration out of L3 beyond generic type support (`docs/specs/109_review_workflow_infrastructure.spec.md:56-59`).

### §A5 and §A5.3 — Sensitivity & RBAC

The RBAC foundation is implemented for the M11 task scope.

Evidence:

- Default roles and permissions match §A5.3 (`packages/core/src/shared/access-control.ts:4-65`).
- Sensitivity comparison uses the canonical ordered lattice (`packages/core/src/shared/access-control.ts:111-117`).
- Source, entity, story, conflict, review, and translation repositories expose sensitivity filtering, and document/entity API routes pass browser principals through to those filters.
- Fresh-checkout config behavior has been hardened: `loadConfig()` falls back from `mulder.config.yaml` to `mulder.config.example.yaml` when the local config is absent (`packages/core/src/config/loader.ts:48-55`, `packages/core/src/config/loader.ts:130-136`), and the CLI sets `MULDER_CONFIG` to the example config when needed (`apps/cli/src/index.ts:47-60`).

WARNING: Credibility profiles are not yet first-class sensitivity/provenance-bearing artifacts. §A5 requires every artifact to carry sensitivity, and §A6 says provenance tracking must include credibility profiles (`docs/functional-spec-addendum.md:790-845`, `docs/functional-spec-addendum.md:864-876`). The L1 profile tables only store profile/dimension fields and timestamps (`packages/core/src/database/migrations/037_source_credibility_profiles.sql:1-50`), while `SourceCredibilityProfileListOptions` has no `maxSensitivityLevel` filter (`packages/core/src/database/repositories/source-credibility.types.ts:59-64`). Current exposure is limited, and source ownership/review context mitigates immediate risk, but any future profile API, export, or agent surface needs a clear direct sensitivity/provenance policy.

NOTE: §A5.4 external query gating and access audit are not implemented in M11. This is an intentional phased deferral in Spec 111 (`docs/specs/111_rbac_implementation.spec.md:70-74`) and belongs with later agent/export safety work.

### §A7 — Translation Service

No divergence found in the accepted L4 scope.

Evidence:

- `translated_documents` stores source/target languages, engine, content hash, current/stale status, `full` vs `translation_only`, output format, and sensitivity metadata (`packages/core/src/database/migrations/040_translated_documents.sql:1-42`).
- Cache lookup happens before the LLM call and returns a `cached` outcome when source hash and format match (`packages/pipeline/src/translate/index.ts:219-246`).
- New translations stale older current rows for the same source/target pair and persist inherited source sensitivity (`packages/core/src/database/repositories/translated-document.repository.ts:62-111`, `packages/pipeline/src/translate/index.ts:270-281`).

NOTE: The full-pipeline path records `pipeline_path = "full"` through the translation service but does not alter the main pipeline order. Spec 110 explicitly leaves full pipeline reordering out of L4.

### §A8 — Credibility Profiles

No aggregate-score divergence found. L1 implements the multidimensional profile model and preserves draft/human-review semantics.

Evidence:

- `source_credibility_profiles` has one unique profile per source, constrained source type, profile author, and review status, while `credibility_dimensions` stores configurable dimensions, scores, rationales, evidence refs, and known factors (`packages/core/src/database/migrations/037_source_credibility_profiles.sql:1-50`).
- Default config supplies the five §A8 dimensions and keeps `agent_instruction = weight_but_never_exclude` (`packages/core/src/config/defaults.ts:152-163`).
- Auto-generated profiles are created through a prompt-backed LLM draft generator and existing human-reviewed profiles are skipped (`packages/pipeline/src/enrich/credibility.ts:130-205`).
- Draft profiles register `credibility_profile` review artifacts (`packages/core/src/database/repositories/source-credibility.repository.ts:248-279`).

The sensitivity/provenance warning listed under §A5 also applies before credibility profiles become externally readable.

### §A9 — Conflict Node Management

No divergence found in the accepted L2 scope.

Evidence:

- `conflict_nodes`, `conflict_assertions`, and `conflict_resolutions` persist the §A9 conflict type, detection method, severity, resolution status, participant, credibility-profile, provenance, and sensitivity fields (`packages/core/src/database/migrations/038_conflict_nodes.sql:1-152`).
- Pipeline detection is bounded by shared entities, configured conflict types, confidence threshold, and `max_candidates_per_story` (`packages/pipeline/src/enrich/conflicts.ts:164-273`).
- Legacy Analyze contradiction resolution can promote matching `POTENTIAL_CONTRADICTION` edges into typed conflict nodes and resolutions (`packages/pipeline/src/analyze/index.ts:421-493`).
- Credibility consumers can query source-level conflict involvement without mutating dimension scores (`packages/core/src/database/repositories/conflict-node.repository.ts:705-729`).

NOTE: §A9's functional config lists agent and human-reported detection as enabled paths (`docs/functional-spec-addendum.md:1204-1228`), but M11 defaults them to `false` until those surfaces exist (`packages/core/src/config/defaults.ts:171-180`). Spec 108 intentionally scoped agent/human conflict reporting out of L2.

### §A13 — Review Workflow

The review infrastructure itself is implemented: generic reviewable artifacts, immutable review events, thematic queues, contested-state handling, and auto-approval operation.

Evidence:

- `review_artifacts`, `review_events`, and `review_queues` implement the constrained statuses, actions, confidence values, current/context JSON, default queues, and active-subject idempotency (`packages/core/src/database/migrations/039_review_workflow.sql:1-95`).
- Queue summaries compute `pending_count` and `oldest_pending` from current artifact rows instead of denormalized counters (`packages/core/src/database/repositories/review-workflow.repository.ts:566-585`).
- Auto-approval exists as an explicit repository operation (`packages/core/src/database/repositories/review-workflow.repository.ts:640-665`).

WARNING: §A13.6's metrics feedback loop is not implemented even though defaults expose `metrics.auto_adjust_depth: true`. The addendum says review accuracy metrics should feed back into pipeline review depth (`docs/functional-spec-addendum.md:1675-1723`), but Spec 109 explicitly defers changing review depth from metrics and only keeps list/filter options for later reporting (`docs/specs/109_review_workflow_infrastructure.spec.md:52-60`). Before teams rely on §A13.6 behavior, either implement the metrics/adjustment worker or mark the config as reserved/non-operational.

NOTE: There is no background scheduler for auto-approval. This is accepted by Spec 109, which provides a repository operation for later callers rather than scheduler behavior.

## Cross-Cutting Convention Review

No blocking convention drift found. The reviewed M11 work follows the repository's domain-agnostic naming, ESM TypeScript modules, central config schema/defaults, repository-style database access, shared service abstractions, and prompt-template boundaries. The new tests are spec-scoped and use example/temp configs and dev-mode fixtures rather than live GCP or a required root `mulder.config.yaml`.

The two CI-support PRs merged during M11 (#285 and #286) also align with the testing architecture: docs-only changes are scoped away from unrelated DB suites, and milestone pushes use affected checks instead of unnecessarily broad jobs.

## `CLAUDE.md` Consistency

No M11-blocking inconsistency found. `CLAUDE.md` now describes the implemented seven-step pipeline, content-addressed storage, PostgreSQL as authoritative state, service abstraction boundaries, domain-agnostic config, and the expected config-loader pattern. One small doc nuance remains: its repo tree still lists `mulder.config.yaml` as a root file, but the actual loader and CLI now correctly tolerate a fresh checkout without that file by falling back to the example config.

## Verification

Local verification used for milestone acceptance before this review:

- `pnpm test:scope run milestone M11 -- --reporter=verbose`
  - 5 files, 43 tests passed.

Remote verification before this review report:

- Latest `milestone/11` CI before this report: run `25472527983`, head `091b7d2329121c7831a18266b7cd601234baf1a7`, status `completed`, conclusion `success`.
- Open PRs against `milestone/11`: none.
- M11 issues #283, #287, #289, #291, and #293 are closed.

No new local DB test suite was run for this docs-only review report.

## Recommendations

Must-fix before M11 can stand: none.

Should-fix:

- Add a direct sensitivity/provenance policy for source credibility profiles before exposing them through API, export, or agent surfaces.
- Make `review_workflow.metrics.auto_adjust_depth` operational or explicitly reserved so config does not imply automatic review-depth changes that do not yet run.

For consideration:

- Track external query gating and access audit in the later agent/export safety specs instead of widening M11 retroactively.
- Track agent-driven and human-reported conflict detection surfaces in the later agent/API/UI work.
- Track assertion-classification review artifact registration as a follow-up to connect M10 assertions to the generic M11 review layer.
