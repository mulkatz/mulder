---
spec: 108
title: "Conflict Node Management"
roadmap_step: "M11-L2"
functional_spec: "§A9, §A3, §A5, §A8"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/287"
created: 2026-05-06
---

# Spec 108: Conflict Node Management

## 1. Objective

Complete M11-L2 by promoting contradictions from transient graph-edge flags into first-class conflict nodes from §A9. Mulder must persist ConflictNode entities with constrained conflict type, severity, detection method, resolution status, assertion participants, provenance, sensitivity metadata, and typed resolution records. The new model must integrate with existing M6 contradiction edges rather than breaking them, and it must create open conflict nodes from contradictory assertions during automated pipeline work when enabled.

Contradictions are research subjects, not ingestion errors. This step gives later review, credibility, reporting, and agent work a stable data model for explaining conflicts instead of only seeing `POTENTIAL_CONTRADICTION`, `CONFIRMED_CONTRADICTION`, or `DISMISSED_CONTRADICTION` edge labels.

## 2. Boundaries

**Roadmap step:** M11-L2 - Contradiction management - ConflictNode entities, severity, resolution.

**Base branch:** `milestone/11`. This spec is delivered to the M11 integration branch, not directly to `main`.

**Target branch:** `feat/287-conflict-node-management`.

**Primary files:**

- `packages/core/src/database/migrations/038_conflict_nodes.sql`
- `packages/core/src/database/repositories/conflict-node.repository.ts`
- `packages/core/src/database/repositories/conflict-node.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/prompts/templates/detect-assertion-conflict.jinja2`
- `packages/core/src/prompts/templates/resolve-contradiction.jinja2`
- `packages/pipeline/src/enrich/conflicts.ts`
- `packages/pipeline/src/enrich/index.ts`
- `packages/pipeline/src/enrich/types.ts`
- `packages/pipeline/src/analyze/index.ts`
- `packages/pipeline/src/analyze/types.ts`
- `packages/pipeline/src/index.ts`
- `tests/lib/schema.ts`
- `tests/specs/108_conflict_node_management.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `conflict_nodes`, `conflict_assertions`, and `conflict_resolutions` tables with constrained §A9 enum values and M10 provenance/sensitivity fields.
- Add public repository APIs for creating, listing, reading, and resolving conflict nodes with assertion participants.
- Add `contradiction_management` config with §A9 defaults for detection enablement, conflict types, severity levels, similarity band, shared-entity requirement, minimum confidence, and metrics flags.
- Add an assertion-conflict detector that compares newly persisted assertions with existing assertions sharing at least one entity, confirms candidate conflicts through structured LLM output, and creates open conflict nodes when enabled.
- Extend existing `mulder analyze --contradictions` behavior so confirmed or dismissed legacy contradiction edges can populate typed conflict resolution records when matching assertion participants are available.
- Preserve legacy `entity_edges` contradiction behavior and existing evidence API/export consumers.
- Feed conflict density metadata back into credibility profile data in a narrow, observable way without changing L1's credibility score semantics.

**Out of scope:**

- Review queues, reviewer assignment, review events, or review status transitions beyond storing the `review_status` fields required by §A9. Those belong to M11-L3.
- API/UI routes for manually reporting conflicts or editing resolutions.
- Agent-driven contradiction search from §A16.
- Transitive contradiction reasoning across more than the assertions participating in a single conflict.
- Removing or renaming existing `entity_edges` contradiction states.
- Recomputing historical conflicts for an existing archive outside normal re-run or Analyze workflows.

**Architectural constraints:**

- Conflict nodes must reference persisted `knowledge_assertions`; do not invent an untyped claim store parallel to §A3.
- Automatic detection must be bounded and config-driven so mass ingest cannot create unbounded LLM calls.
- Detection failures are non-fatal for Enrich but must be observable in result metadata and step errors.
- Resolution writes must be idempotent for the same conflict and legacy edge.
- Sensitivity must propagate from participating assertions using the most restrictive level.
- The feature must work in dev/test mode without live Vertex/Gemini cost.

## 3. Dependencies

- M10-K4 / Spec 101: `knowledge_assertions` exist and carry assertion type plus extracted entity ids.
- M10-K5 / Spec 102: sensitivity levels exist and must propagate to new conflict artifacts.
- M10-K2 / Spec 99 and M10-K7 / Spec 104: provenance metadata exists for downstream artifacts.
- M11-L1 / Spec 107: source credibility profiles exist and can receive later consistency signals.
- M6-G3 / Spec 61 and M6-G7 / Spec 65: contradiction resolution and analyze orchestration already operate on legacy contradiction edges.

L2 blocks M11-L3 review queues for conflict nodes and conflict resolutions, later credibility consistency feedback, M12 analysis features that depend on contradiction density, and M14 agent research that consumes conflict topology.

## 4. Blueprint

1. Add migration `038_conflict_nodes.sql`:
   - Create `conflict_nodes` with UUID primary key, constrained `conflict_type` (`factual`, `interpretive`, `taxonomic`, `temporal`, `spatial`, `attributive`), constrained `detection_method` (`llm_auto`, `statistical`, `human_reported`), `detected_at`, `detected_by`, constrained `resolution_status` (`open`, `explained`, `confirmed_contradictory`, `false_positive`), constrained `severity` (`minor`, `significant`, `fundamental`), required `severity_rationale`, `review_status` default `pending`, optional `legacy_edge_id`, numeric `confidence`, `provenance JSONB`, `sensitivity_level`, `sensitivity_metadata`, timestamps, and `deleted_at`.
   - Create `conflict_assertions` with `conflict_id`, `assertion_id`, `source_document_id`, `assertion_type`, `claim`, nullable `credibility_profile_id`, and a participant role such as `claim_a`, `claim_b`, or `context`.
   - Create `conflict_resolutions` with `conflict_id`, constrained `resolution_type`, required `explanation`, `resolved_by`, `resolved_at`, `evidence_refs TEXT[]`, `review_status`, optional `legacy_edge_id`, and timestamps.
   - Add indexes for open conflicts, severity, conflict type, legacy edge id, assertion id, provenance source ids, sensitivity level, and resolution status.
   - Make conflict creation idempotent for the same unordered assertion pair and conflict type without preventing multi-assertion context rows.
   - Extend reset/purge helpers so Enrich/Graph resets and source purges remove or update conflict artifacts that only depend on the purged source.

2. Add repository module and exports:
   - Define `ConflictType`, `ConflictSeverity`, `ConflictResolutionStatus`, `ConflictDetectionMethod`, `ResolutionType`, `ConflictAssertion`, `ConflictResolution`, and `ConflictNode`.
   - Provide `createConflictNode`, `findConflictNodeById`, `findConflictNodeByLegacyEdgeId`, `listConflictNodes`, `listOpenConflictNodes`, `resolveConflictNode`, and `deleteConflictNodesForStory` or source-scoped cleanup helpers as needed by reset/purge.
   - Return joined participant assertions and latest resolution in one normalized DTO.
   - Validate enum values, participant count, score bounds, non-empty rationales, and non-empty resolution explanations before writes.
   - Preserve idempotency by returning an existing active node when the same canonical assertion pair and conflict type already exist.

3. Add config:
   - `contradiction_management.enabled` default `true`.
   - `contradiction_management.conflict_types` defaults to the six §A9 types.
   - `contradiction_management.severity_levels` defaults to `minor`, `significant`, `fundamental`.
   - `contradiction_management.detection.pipeline` default `true`.
   - `contradiction_management.detection.agent` and `human_reported` default `false` until those surfaces exist.
   - `contradiction_management.detection.embedding_similarity_band` default `[0.3, 0.8]`.
   - `contradiction_management.detection.require_shared_entity` default `true`.
   - `contradiction_management.detection.llm_confirmation` default `true`.
   - `contradiction_management.detection.llm_engine` default `gemini-2.5-pro`.
   - `contradiction_management.detection.min_confidence` default `0.7`.
   - `contradiction_management.detection.max_candidates_per_story` default `25`.
   - `contradiction_management.auto_severity_assessment` default `true`.
   - `contradiction_management.review.conflict_detection` and `resolution` default `single_review`.
   - `contradiction_management.metrics.track_contradiction_density`, `track_resolution_rate`, and `feed_credibility_profiles` default `true`.

4. Add assertion-conflict detection:
   - After Enrich persists assertions, load assertions for the current story and existing active assertions that share at least one extracted entity id.
   - Exclude same-story duplicates, same-source duplicates, empty entity overlaps when shared-entity is required, and existing active conflicts for the same assertion pair.
   - Bound candidates with `max_candidates_per_story`.
   - Ask `services.llm.generateStructured` through `detect-assertion-conflict.jinja2` to confirm or dismiss each candidate and return `conflict_type`, `severity`, `severity_rationale`, `confidence`, and a concise claim summary for each participant.
   - Persist open `llm_auto` conflict nodes when confidence is at least `min_confidence`.
   - Propagate provenance from participant assertions and sensitivity from the most restrictive participant.
   - Return counts for candidates examined, conflicts created, conflicts skipped, and failures.

5. Extend Analyze contradiction resolution:
   - Extend the existing `resolve-contradiction` structured response with optional `conflict_type`, `severity`, `severity_rationale`, `resolution_type`, and `evidence_refs`.
   - When Analyze updates a legacy contradiction edge, find or create a linked conflict node only when at least two matching knowledge assertions can be resolved from the legacy edge context.
   - For confirmed contradictions, set `resolution_status = confirmed_contradictory` with a typed resolution record.
   - For dismissed contradictions, set `resolution_status = false_positive` with a typed resolution record.
   - Preserve the legacy edge update and explanation fields so existing exports and API routes keep working.
   - Include conflict-node counts in `ContradictionAnalyzeData`.

6. Feed credibility consistency metadata:
   - When a conflict node is created or resolved, update a lightweight metadata field or repository-visible metric that lets credibility profile consumers see conflict involvement by source.
   - Do not mutate dimension scores automatically and do not create aggregate reliability scores.

7. Update roadmap state only after gates:
   - Keep L2 marked in progress while implementation is open.
   - Mark L2 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/11`.

## 5. QA Contract

1. **QA-01: Conflict schema is constrained and reset-safe**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `conflict_nodes`, `conflict_assertions`, and `conflict_resolutions` exist with required enum checks, assertion foreign keys, provenance/sensitivity columns, indexes, and cleanup behavior for Enrich/Graph resets.

2. **QA-02: Config exposes §A9 defaults**
   - Given minimal config
   - When it is loaded through the public config loader
   - Then contradiction management is enabled with the six conflict types, three severity levels, pipeline detection enabled, shared-entity and LLM confirmation enabled, min confidence `0.7`, max candidates `25`, and review/metrics defaults.

3. **QA-03: Repository creates idempotent conflict nodes**
   - Given two persisted knowledge assertions with shared entity ids and different sources
   - When `createConflictNode` runs twice for the same assertion pair and conflict type
   - Then one active conflict node exists, it has two participant rows, preserves participant claim text, exposes severity and detection metadata, and the second call returns the existing node.

4. **QA-04: Repository stores typed resolutions**
   - Given an open conflict node
   - When `resolveConflictNode` stores a `different_time`, `source_unreliable`, or `genuinely_contradictory` resolution
   - Then the node status changes to the expected §A9 status and the latest resolution exposes explanation, resolver, timestamp, evidence refs, and review status.

5. **QA-05: Enrich creates open conflict nodes from contradictory assertions**
   - Given a source whose newly enriched story produces an assertion that shares an entity with an existing assertion from another source
   - When contradiction management pipeline detection is enabled and the deterministic LLM fixture confirms the candidate
   - Then Enrich succeeds, an open conflict node is persisted with assertion participants, severity, rationale, provenance, sensitivity, and Enrich result metadata reports the conflict count.

6. **QA-06: Enrich skips disabled or low-confidence detection**
   - Given the same assertion candidate
   - When contradiction management is disabled, pipeline detection is disabled, or the fixture confidence is below `min_confidence`
   - Then Enrich writes no conflict node and reports a skipped detection outcome without failing the story.

7. **QA-07: Analyze promotes legacy contradiction resolutions**
   - Given a `POTENTIAL_CONTRADICTION` legacy edge whose stories have matching participant assertions
   - When `mulder analyze --contradictions` confirms or dismisses the edge
   - Then the legacy edge status and analysis explanation are preserved, and a linked conflict node plus typed resolution are written idempotently.

8. **QA-08: Conflict involvement is observable for credibility consumers**
   - Given conflict nodes involving assertions from two sources
   - When repository metrics or source-level conflict involvement are queried
   - Then callers can distinguish total/open/resolved conflict involvement by source without modifying credibility dimension scores.

## 5b. CLI Test Matrix

No new CLI commands are added. Existing CLI behavior must remain valid:

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder config validate --config <minimal-config>` | Minimal config without `contradiction_management` | Exit 0; default contradiction management config is accepted. |
| `mulder enrich <source-id>` | New assertion conflicts with an existing assertion | Exit 0; an open conflict node is created when detection is enabled. |
| `mulder enrich <source-id>` | Detection disabled or low-confidence fixture | Exit 0; no conflict node is created and Enrich reports a skipped outcome. |
| `mulder analyze --contradictions` | Legacy potential contradiction with matching assertions | Exit 0; legacy edge is resolved and a typed conflict resolution is persisted. |
| `mulder analyze --contradictions` | Same legacy edge already promoted | Exit 0; no duplicate conflict node or resolution is created. |

## 6. Cost Considerations

L2 can add bounded structured-output LLM calls during Enrich when `contradiction_management.enabled` and `detection.pipeline` are true. Candidate selection must require shared entity ids by default, cap work at `max_candidates_per_story`, skip existing conflict pairs, and respect `min_confidence`. Dev and test mode must use deterministic fixtures. Teams can disable automatic detection with `contradiction_management.enabled: false` or `detection.pipeline: false` while preserving repository and Analyze promotion behavior.
