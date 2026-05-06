---
spec: 102
title: "Sensitivity Tagging And Auto Detection"
roadmap_step: "M10-K5"
functional_spec: "§A5, §A1, §A2"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/271"
created: 2026-05-05
---

# Spec 102: Sensitivity Tagging And Auto Detection

## 1. Objective

Complete M10-K5 by adding sensitivity levels to Mulder's current document and artifact records, then wiring config-driven auto-detection into Enrich. §A5 defines four generic levels, `public`, `internal`, `restricted`, and `confidential`, and requires sensitivity assignment at the finest practical artifact level with upward propagation. This step creates that data foundation before archive ingest, without implementing RBAC enforcement or external-query filtering.

K5 matters because provenance and assertion records are only safe for real archives if Mulder can distinguish public material from internal or restricted personal information. The default remains conservative: minimal config starts at `internal`, and auto-detection can raise the level when Enrich observes configured PII or sensitive information.

## 2. Boundaries

**Roadmap step:** M10-K5 - Sensitivity level tagging + auto-detection.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/271-sensitivity-tagging-auto-detection`.

**In scope:**

- Add `sensitivity_level` and `sensitivity_metadata` to current document/artifact tables: `sources`, `stories`, `entities`, `entity_aliases`, `story_entities`, `chunks`, `entity_edges`, and `knowledge_assertions`.
- Add shared sensitivity types and normalization helpers for the §A5 level and metadata shape.
- Add config under `access_control.sensitivity` with the §A5 defaults needed for tagging and auto-detection.
- Extend Enrich structured output so auto-detection can return sensitivity metadata for extracted entities, relationships, and assertions when enabled.
- Persist detected sensitivity on entities, story-entity links, entity edges, and knowledge assertions.
- Propagate the most restrictive child artifact level upward to the story and source after Enrich writes complete.
- Preserve backward compatibility for existing rows and repository reads by defaulting to `internal` sensitivity.

**Out of scope:**

- RBAC roles, permissions, request filtering, API authorization, or UI visibility gates. Those belong to M11-L5.
- External query sanitization or web-research blocking. That belongs to later agent/query-gate work.
- Human review workflows, sensitivity-change audit screens, or declassification scheduling beyond storing nullable metadata fields.
- Pseudonymization or redaction of stored content.
- Sensitivity-aware export filtering. That belongs to M13-P3.

**Primary files:**

- `packages/core/src/database/migrations/031_sensitivity_levels.sql`
- `packages/core/src/shared/sensitivity.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/database/repositories/source.types.ts`
- `packages/core/src/database/repositories/story.types.ts`
- `packages/core/src/database/repositories/entity.types.ts`
- `packages/core/src/database/repositories/edge.types.ts`
- `packages/core/src/database/repositories/chunk.types.ts`
- `packages/core/src/database/repositories/knowledge-assertion.types.ts`
- `packages/core/src/database/repositories/*.repository.ts` files for those mapped types
- `packages/core/src/database/repositories/index.ts`
- `packages/pipeline/src/enrich/schema.ts`
- `packages/pipeline/src/enrich/types.ts`
- `packages/pipeline/src/enrich/index.ts`
- `packages/core/src/prompts/templates/extract-entities.jinja2`
- `tests/specs/102_sensitivity_tagging_auto_detection.test.ts`
- `docs/roadmap.md`

## 3. Dependencies

- M10-K1 / Spec 98: source documents are backed by durable content-addressed storage.
- M10-K2 / Spec 99: artifacts carry source provenance.
- M10-K3 / Spec 100: quality metadata can coexist with downstream artifacts.
- M10-K4 / Spec 101: `knowledge_assertions` exists and can receive artifact metadata.

K5 blocks M10-K6 because rollback must preserve or purge sensitivity-bearing artifacts consistently, and it blocks later RBAC/export/query-gate work that consumes `sensitivity_level`.

## 4. Blueprint

1. Add migration `031_sensitivity_levels.sql`:
   - Add `sensitivity_level TEXT NOT NULL DEFAULT 'internal'` and `sensitivity_metadata JSONB NOT NULL DEFAULT ...` to `sources`, `stories`, `entities`, `entity_aliases`, `story_entities`, `chunks`, `entity_edges`, and `knowledge_assertions`.
   - Constrain levels to `public`, `internal`, `restricted`, `confidential`.
   - Require metadata keys `level`, `reason`, `assigned_by`, `assigned_at`, `pii_types`, and `declassify_date`, with `pii_types` as a JSON array and `level` matching `sensitivity_level`.
   - Backfill existing rows to `internal`, `reason = 'default_policy'`, `assigned_by = 'policy_rule'`, `pii_types = []`, and `declassify_date = null`.
   - Add indexes for `sensitivity_level` on high-volume tables and keep GIN usage minimal.

2. Add shared sensitivity helpers:
   - Export `SensitivityLevel`, `SensitivityAssignmentSource`, `PIIType`, `SensitivityMetadata`, and `SensitivityTagged`.
   - Provide `normalizeSensitivityMetadata`, `defaultSensitivityMetadata`, `mostRestrictiveSensitivityLevel`, and `mergeSensitivityMetadata`.
   - Keep helpers domain-agnostic and free of RBAC policy decisions.

3. Add config:
   - `access_control.enabled` default `true`.
   - `access_control.sensitivity.levels` default `['public', 'internal', 'restricted', 'confidential']`.
   - `access_control.sensitivity.default_level` default `internal`.
   - `access_control.sensitivity.auto_detection` default `true`.
   - `access_control.sensitivity.propagation` enum with `upward` default.
   - `access_control.sensitivity.pii_types` default to the §A5 PII type list.
   - Add only lightweight placeholders for RBAC/external query gate if needed for config shape; do not implement enforcement.

4. Update repository mappings:
   - Add sensitivity fields to public mapped types for sources, stories, entities, aliases, story entities, chunks, edges, and knowledge assertions.
   - Add optional sensitivity input fields where writers create or upsert those rows.
   - Normalize missing or legacy values to the configured/default `internal` shape.
   - Preserve idempotent upsert behavior and provenance merging.

5. Extend Enrich structured output and prompt:
   - Add optional `sensitivity` metadata to extracted entity, relationship, and assertion objects.
   - When `access_control.sensitivity.auto_detection` is true, generated JSON Schema requires the sensitivity object and constrains levels and PII types.
   - When auto-detection is false, existing Enrich response shapes remain valid and writers use the configured default.
   - Prompt text must explain the four generic levels, the configured PII type vocabulary, and conservative upward classification.

6. Wire Enrich persistence and propagation:
   - Pass sensitivity metadata to entity, story-entity, edge, and assertion writes.
   - Use `assigned_by = 'llm_auto'` for model-detected metadata and `assigned_by = 'policy_rule'` for default metadata.
   - After Enrich writes child artifacts, set the story sensitivity to the most restrictive child level when propagation is `upward`.
   - Set the source sensitivity to the most restrictive story/artifact level for that source.
   - Preserve `--force` behavior and avoid duplicate rows or stale child sensitivity after reruns.

7. Update roadmap state only after gates:
   - Keep K5 marked in progress while implementation is open.
   - Mark K5 complete only after scoped tests, affected checks, review, and PR merge to `milestone/10`.

## 5. QA Contract

1. **QA-01: Migration adds constrained sensitivity fields**
   - Given a migrated database
   - When schema metadata is inspected for current document/artifact tables
   - Then each table has `sensitivity_level`, `sensitivity_metadata`, valid level constraints, metadata shape checks, and default internal metadata for existing rows.

2. **QA-02: Config exposes §A5 tagging defaults**
   - Given minimal config
   - When the public config loader resolves defaults
   - Then `access_control.sensitivity` is enabled with the four levels, default `internal`, auto-detection true, upward propagation, and the §A5 PII type vocabulary.

3. **QA-03: Shared helpers choose the most restrictive level**
   - Given multiple sensitivity metadata objects
   - When helper APIs merge or compare them
   - Then `confidential` outranks `restricted`, which outranks `internal`, which outranks `public`, and PII type arrays remain unique.

4. **QA-04: Repository reads and writes round-trip sensitivity**
   - Given sources, stories, entities, edges, chunks, and assertions with explicit sensitivity metadata
   - When public repository APIs create, upsert, and read those records
   - Then returned objects expose normalized sensitivity level and metadata.

5. **QA-05: Enrich auto-detection writes child artifact sensitivity**
   - Given deterministic Enrich fixture output containing `restricted` entity sensitivity, `internal` relationship sensitivity, and `confidential` assertion sensitivity
   - When Enrich runs with auto-detection enabled
   - Then the created entity, story-entity link, edge, and assertion rows store the detected levels and metadata.

6. **QA-06: Upward propagation updates story and source**
   - Given the same Enrich run with child artifacts at multiple levels
   - When Enrich completes
   - Then the story and source sensitivity are updated to the most restrictive child level.

7. **QA-07: Disabled auto-detection preserves existing Enrich compatibility**
   - Given Enrich model output without sensitivity objects
   - When auto-detection is disabled
   - Then Enrich succeeds, no validation error is thrown, and created artifacts receive the configured default sensitivity.

8. **QA-08: Force reruns do not leave stale higher sensitivity**
   - Given a story enriched once with confidential child artifacts
   - When `--force` reruns Enrich with only internal child artifacts
   - Then active child artifacts, story, and source no longer retain stale confidential sensitivity from deleted/replaced rows.

## 5b. CLI Test Matrix

No new CLI commands are added. Existing commands must remain valid:

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder config validate <minimal-config>` | Minimal config without `access_control` | Exit 0; default sensitivity config is accepted. |
| `mulder config show <minimal-config>` | Minimal config without `access_control` | Output includes resolved `access_control.sensitivity` defaults. |
| `mulder enrich <source-id>` | Segmented source with sensitivity-bearing fixture output | Exit 0; child artifacts plus story/source expose sensitivity metadata. |
| `mulder enrich --force <source-id>` | Previously enriched source | Exit 0; sensitivity propagation reflects the rerun output. |

## 6. Cost Considerations

K5 does not add a new paid service call. It extends the existing Enrich structured-output payload, so model output tokens may increase when auto-detection is enabled. The feature remains config-driven so local, benchmark, or low-cost runs can disable auto-detection and rely on the default policy-rule sensitivity metadata.
