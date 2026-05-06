---
spec: 101
title: "Assertion Classification In Enrich"
roadmap_step: "M10-K4"
functional_spec: "§A3, §A1, §A2"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/269"
created: 2026-05-05
---

# Spec 101: Assertion Classification In Enrich

## 1. Objective

Complete M10-K4 by making assertions a first-class Enrich output. When `enrichment.assertion_classification.enabled` is true, the Enrich step must ask the structured-output model for classified assertions, persist them with source/story/entity provenance, and expose deterministic repository types for downstream credibility, contradiction, and agent work. The labels are exactly `observation`, `interpretation`, and `hypothesis`, with conservative classification and confidence metadata as described by §A3.

This step matters before archive ingest because unclassified extracted facts create a graph where empirical observations and author interpretations look identical. K4 stores the distinction at extraction time so later research and review layers can reason from the original epistemic class instead of trying to infer it after the graph has grown.

## 2. Boundaries

**Roadmap step:** M10-K4 - Assertion classification in Enrich step.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/269-assertion-classification-enrich`.

**In scope:**

- Add a `knowledge_assertions` persistence model for classified assertions extracted during Enrich.
- Add config under `enrichment.assertion_classification` with the §A3 defaults.
- Extend Enrich structured output schema and prompt instructions so Gemini can return assertions only when classification is enabled.
- Persist assertion rows idempotently per story/source/content/type, including classification provenance, confidence metadata, extracted entity links, artifact provenance, and optional quality metadata.
- Keep disabled classification backward-compatible: existing entity and relationship extraction still validates and no assertions are written.
- Add or update public repository exports and black-box spec coverage.

**Out of scope:**

- Human review workflows, review queues, `human_reviewed` mutation flows, or collaborative review UI. Those belong to §A13.
- Contradiction nodes, credibility profiles, similarity links, or research-agent behavior. Those belong to later M11+ steps.
- Retroactive classification of already-enriched stories.
- Creating domain-specific assertion categories beyond the three §A3 labels.
- Changing graph traversal or retrieval ranking to consume assertions.

**Primary files:**

- `packages/core/src/database/migrations/029_knowledge_assertions.sql`
- `packages/core/src/database/repositories/knowledge-assertion.types.ts`
- `packages/core/src/database/repositories/knowledge-assertion.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/prompts/templates/extract-entities.jinja2`
- `packages/pipeline/src/enrich/schema.ts`
- `packages/pipeline/src/enrich/types.ts`
- `packages/pipeline/src/enrich/index.ts`
- `tests/specs/101_assertion_classification_enrich.test.ts`
- `docs/roadmap.md`

## 3. Dependencies

- M10-K1 / Spec 98: content-addressed source storage is complete.
- M10-K2 / Spec 99: current downstream artifacts carry `provenance.source_document_ids`.
- M10-K3 / Spec 100: quality assessment exists and can provide optional quality metadata for assertion confidence.
- Existing M3 Enrich behavior, including dynamic JSON Schema generation, entity repositories, story entity links, and relationship writes.

K4 blocks M10-K9 because golden assertion-classification tests need a persisted assertion model and an observable Enrich path.

## 4. Blueprint

1. Add migration `029_knowledge_assertions.sql`:
   - Create `knowledge_assertions` with UUID primary key, `source_id`, `story_id`, `assertion_type`, `content`, `confidence_metadata JSONB`, `classification_provenance`, `extracted_entity_ids UUID[]`, `provenance JSONB`, optional `quality_metadata JSONB`, timestamps, and `deleted_at`.
   - Enforce assertion type values `observation`, `interpretation`, `hypothesis`.
   - Enforce classification provenance values `llm_auto`, `human_reviewed`, `author_explicit`.
   - Add source/story foreign keys with cascade semantics matching story lifecycle cleanup.
   - Add a uniqueness constraint or partial unique index that makes repeated Enrich runs idempotent for active assertions from the same story/source/content/type.
   - Add lookup indexes for `source_id`, `story_id`, `assertion_type`, and provenance source-id queries.

2. Add repository module and exports:
   - Define `AssertionType`, `ClassificationProvenance`, `ConfidenceMetadata`, `KnowledgeAssertion`, and create/upsert/list inputs.
   - Normalize JSONB confidence metadata and provenance without casual `any` or unchecked `as` assertions.
   - Provide `upsertKnowledgeAssertion`, `listKnowledgeAssertionsForStory`, `listKnowledgeAssertionsForSource`, and `deleteKnowledgeAssertionsForStory`.
   - Merge provenance source ids on idempotent upsert and preserve explicit classification provenance when supplied.

3. Add config:
   - `enrichment.assertion_classification.enabled` default `true`.
   - `conservative_labeling` default `true`.
   - `require_confidence_metadata` default `true`.
   - `default_provenance` default `llm_auto`.
   - `reviewable` default `true`.
   - `review_depth` enum `spot_check | single_review | double_review` default `spot_check`.
   - `spot_check_percentage` integer 0-100 default `20`.

4. Extend Enrich structured output:
   - Add assertion output items with `content`, `assertion_type`, `confidence_metadata`, optional `classification_provenance`, and optional `entity_names`.
   - When classification is enabled, generated JSON Schema requires an `assertions` array.
   - When classification is disabled, the runtime schema accepts existing responses without assertions and Enrich writes no assertion rows.
   - Prompt text must explain the three labels, conservative fallback, and confidence metadata fields using generic language only.

5. Wire Enrich persistence:
   - After entities are resolved and story-entity links are available, map assertion `entity_names` to resolved entity ids when possible.
   - Persist assertions with `source_id`, `story_id`, source artifact provenance, classification provenance, and confidence metadata.
   - Include quality metadata from the latest document quality assessment when available, but do not require K3 data to exist.
   - Extend `EnrichmentData` metadata with `assertionsCreated` or `assertionsPersisted`.
   - Preserve existing enrich behavior for entities, aliases, story entities, relationships, taxonomy links, and force reruns.

6. Update roadmap state only after gates:
   - Keep K4 marked in progress while implementation is open.
   - Mark K4 complete only after scoped tests, affected test plan, review, and PR merge to `milestone/10`.

## 5. QA Contract

1. **QA-01: Migration creates a constrained assertion store**
   - Given a migrated test database
   - When schema metadata for `knowledge_assertions` is inspected
   - Then the table exists with source/story foreign keys, required assertion/provenance constraints, provenance JSONB, confidence metadata JSONB, and active-row idempotency for story/source/content/type.

2. **QA-02: Config exposes §A3 defaults**
   - Given minimal config
   - When it is loaded through the public config loader
   - Then `enrichment.assertion_classification` is enabled with the default provenance, conservative labeling, required confidence metadata, review settings, and spot-check percentage from this spec.

3. **QA-03: Structured schema changes with the feature flag**
   - Given a representative ontology
   - When the Enrich extraction schema is generated with classification enabled
   - Then `assertions` are accepted with the three assertion types and confidence metadata.
   - When classification is disabled
   - Then existing entity/relationship-only model output remains valid.

4. **QA-04: Repository writes round-trip classified assertions**
   - Given a story, source, resolved entity ids, and assertion input
   - When the repository upserts and lists assertions
   - Then the returned assertion exposes normalized assertion type, classification provenance, confidence metadata, entity ids, and provenance source ids.

5. **QA-05: Upserts are idempotent and merge provenance**
   - Given two assertion writes for the same story/source/content/type with overlapping provenance
   - When both writes complete
   - Then one active assertion exists and its provenance source ids are unique.

6. **QA-06: Enrich persists assertions only when enabled**
   - Given deterministic dev-mode Enrich fixture output containing classified assertions
   - When Enrich runs with classification enabled
   - Then `knowledge_assertions` rows are created for the story and `EnrichmentData` reports the persisted count.
   - When Enrich runs with classification disabled
   - Then entity extraction still succeeds and no assertion rows are created.

7. **QA-07: Force reruns do not duplicate assertions**
   - Given a story that has already been enriched with assertions
   - When Enrich is re-run with `--force`
   - Then active assertions for the story are replaced or upserted idempotently without duplicate story/source/content/type rows.

## 5b. CLI Test Matrix

No new CLI commands are added. Existing CLI behavior must remain valid:

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder enrich <source-id>` | Source with segmented story and classified fixture output | Exit 0; story entities and knowledge assertions are written. |
| `mulder enrich --force <source-id>` | Previously enriched source | Exit 0; assertions remain idempotent after the rerun. |
| `mulder config validate --config <minimal-config>` | Minimal config without assertion block | Exit 0; default assertion classification config is accepted. |

## 6. Cost Considerations

K4 extends the existing Enrich model output but does not add a new paid service or a new model call. Token output may increase because assertions and confidence metadata are returned with entities and relationships. The implementation must keep the feature config-driven so teams can disable assertion classification during prompt benchmarking or low-cost local runs.
