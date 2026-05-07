---
spec: 113
title: "Similar Entity Discovery"
roadmap_step: "M12-N1"
functional_spec: "§A10, §A11, §D2.6"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/299"
created: 2026-05-07
---

# Spec 113: Similar Entity Discovery

## 1. Objective

Complete M12-N1 by adding Mulder's first discovery surface for similar entity analysis from §A10. Researchers must be able to ask for entities similar to a selected entity and receive explainable, multi-dimensional scores across the four core dimensions (`semantic`, `structural`, `geospatial`, `temporal`) plus optional configured domain dimensions. Ingest-time or analysis-time auto-discovery must also be able to persist bounded `SIMILAR_TO` graph edges for high-signal pairs.

This step intentionally keeps dimensions visible instead of collapsing them into a hidden aggregate score. Sorting can use configured weights, but the persisted and returned result must expose every dimension separately with enough explanation for a reviewer or later agent to understand why a link exists.

## 2. Boundaries

**Roadmap step:** M12-N1 - Similar case discovery - multi-dimensional scoring, auto-discovery.

**Base branch:** `milestone/12`. This spec is delivered to the M12 integration branch, not directly to `main`.

**Target branch:** `feat/299-similar-entity-discovery`.

**Primary files:**

- `packages/core/src/database/migrations/043_similarity_cache.sql`
- `packages/core/src/database/repositories/similarity.repository.ts`
- `packages/core/src/database/repositories/similarity.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/index.ts`
- `packages/evidence/src/index.ts`
- `packages/pipeline/src/analyze/similarity.ts`
- `packages/pipeline/src/analyze/types.ts`
- `packages/pipeline/src/index.ts`
- `mulder.config.example.yaml`
- `tests/lib/schema.ts`
- `tests/specs/113_similar_entity_discovery.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `similar_case_discovery` config defaults from §A10 with candidate retrieval limits, score weights, explanation settings, auto-discovery thresholds, and domain-dimension config references.
- Add a `similarity_cache` persistence model for unordered entity pairs, per-dimension core scores, optional domain dimension scores, explanation, shared entity ids, key differences, provenance, sensitivity metadata, review status, auto-discovery metadata, and timestamps.
- Add repository APIs to upsert/list/find cached similarity results idempotently by entity pair and to return query-mode results for a selected entity.
- Add deterministic scoring helpers for core dimensions using available entity embeddings, graph connectivity, geometry, and ISO date attributes. Missing dimensions must be represented as `null`/`insufficient_data`, not fabricated scores.
- Add a domain-dimension extension point that accepts configured attribute-comparison dimensions now and can consume taxonomy mappings when M12-N2 adds them.
- Add an Analyze-facing public function that runs candidate scoring for one entity, sorts by configured weights, stores top results when requested, and optionally creates bounded `SIMILAR_TO` edges through the existing edge repository when auto-discovery thresholds are met.
- Register `similar_case_link` review artifacts when the M11 review workflow is available, without requiring a UI or manual review route.

**Out of scope:**

- Implementing cross-taxonomy mapping storage or LLM-suggested taxonomy mappings. That belongs to M12-N2.
- Building UI/API routes, sliders, watchlist alerts, or interactive result tuning.
- Long-running background scheduling beyond an exported auto-discovery function that later workers can call.
- Paid LLM explanation generation. This step may store caller-provided deterministic explanations and expose a service boundary for future generated explanations, but tests must not call Gemini or Vertex.
- Global precomputed similarity indexes for very large corpora.

**Architectural constraints:**

- Core code must stay domain-agnostic. Use generic entities, configured attributes, taxonomy ids, and display labels only from config.
- Do not combine dimensions into a persisted aggregate score. Sorting may compute a transient weighted rank and must keep raw dimension values visible.
- Candidate work must be bounded by config (`vector_top_k`, max results, `max_auto_links`) so ingest or analysis cannot fan out unboundedly.
- Similarity links must carry provenance and sensitivity metadata, and read APIs must preserve M11 RBAC filtering surfaces.
- Auto-discovery must be idempotent: rerunning for the same entity pair updates the cache/edge rather than duplicating rows.

## 3. Dependencies

- M10-K2 / Spec 99 and M10-K7 / Spec 104: downstream artifacts carry source provenance.
- M10-K5 / Spec 102: sensitivity metadata exists and must propagate onto similarity artifacts.
- M11-L3 / Spec 109: review artifacts exist for generated trust/discovery artifacts.
- M11-L5 / Spec 111 and Spec 112: RBAC filtering and trust metadata fixes are present on `main`.
- M6-G4 / Spec 63 and M6-G5 / Spec 64: evidence chains and spatio-temporal clustering provide adjacent Analyze patterns.
- M12-N2 will later add taxonomy mapping persistence that enriches domain-dimension scoring.

N1 blocks later M12 discovery workflows that consume similar entity links, including temporal pattern explanations and agent research planning.

## 4. Blueprint

1. Add config support:
   - Define `similar_case_discovery` with `enabled`, `candidate_retrieval.vector_top_k`, `geo_radius_km`, `temporal_window_years`, `scoring.core_dimensions`, `scoring.weights`, `scoring.domain_dimensions`, `explanation`, and `auto_discovery`.
   - Keep minimal configs valid and keep `mulder.config.example.yaml` self-contained.
   - Validate domain dimensions as generic config refs with `id`, `label`, `source`, optional `weight`, and source-specific metadata.

2. Add migration `043_similarity_cache.sql`:
   - Create `similarity_cache` with two entity ids, generated canonical pair columns or a check ensuring stable unordered pairs, core score JSONB, domain score JSONB, explanation, shared entity ids, key differences, ranked position metadata, review status, auto-discovered flag, provenance JSONB, sensitivity fields, and timestamps.
   - Add uniqueness for active unordered pairs and indexes for source entity lookup, review status, auto-discovered rows, provenance source ids, and sensitivity level.
   - Ensure `SIMILAR_TO` remains a valid generic graph relationship through the existing `entity_edges` model without introducing domain-specific edge names.

3. Add repository module and exports:
   - Define `CoreSimilarityDimensions`, `DomainSimilarityDimension`, `SimilarityResult`, `SimilarityCacheRecord`, create/upsert/list option types, score status metadata, and auto-discovery result types.
   - Implement `upsertSimilarityResult`, `findSimilarityByPair`, `listSimilarEntities`, `deleteSimilarityResultsForEntity`, and helper mapping functions.
   - Support `maxSensitivityLevel` filtering with the existing sensitivity lattice helpers.

4. Add scoring and Analyze integration:
   - Implement deterministic core-dimension scoring from available entity fields and graph edges.
   - Return explicit insufficient-data markers for missing embeddings, missing geometry, missing dates, or sparse graph topology.
   - Sort transiently by configured weights while returning raw dimension scores.
   - Persist top-N results when requested and create/update `SIMILAR_TO` edges only when `auto_discovery.create_graph_edge` is enabled and thresholds are met.

5. Add review integration:
   - Register reviewable artifacts of type `similar_case_link` for persisted auto-discovered links when review workflow helpers are available.
   - Include current score payload, explanation, provenance, sensitivity, and entity ids in review context.
   - Do not auto-approve or expose reviewer assignment beyond the existing review workflow defaults.

6. Update affected-test mapping only if needed:
   - Ensure changes under similarity repository/config/analyze files map to the M12-N1 spec tests without causing unrelated full DB suite fan-out.

7. Update roadmap state only after gates:
   - Keep N1 marked in progress while the branch is open.
   - Mark N1 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/12`.

## 5. QA Contract

1. **QA-01: Config exposes domain-agnostic similarity defaults**
   - Given `mulder.config.example.yaml` and a minimal config without `similar_case_discovery`
   - When config is loaded through the public loader
   - Then similar case discovery is enabled with the four core dimensions, bounded candidate retrieval, score weights, explanation settings, auto-discovery defaults, and no hard-coded domain labels.

2. **QA-02: Similarity cache schema is constrained and idempotent**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `similarity_cache` exists with unordered-pair uniqueness, dimension JSONB fields, explanation fields, review status, provenance, sensitivity fields, and lookup indexes.

3. **QA-03: Repository upserts and lists per-dimension results**
   - Given two persisted entities and a similarity result containing semantic, structural, geospatial, temporal, and one configured domain dimension
   - When the same pair is upserted twice in reversed order and listed from either entity
   - Then one active record is returned with separate dimension scores, explanation, shared entity ids, key differences, provenance, and sensitivity metadata.

4. **QA-04: Query-mode scoring exposes insufficient data**
   - Given entities where one or more core inputs are missing
   - When similar entity discovery runs in query mode
   - Then missing dimensions are marked as insufficient data and no fabricated score is returned, while available dimensions still appear.

5. **QA-05: Auto-discovery persists bounded links**
   - Given candidate entities whose configured dimensions meet the auto-discovery threshold
   - When auto-discovery runs with `create_graph_edge` enabled and `max_auto_links = 1`
   - Then at most one `SIMILAR_TO` edge and one cache row are created or updated idempotently for the highest-ranked candidate.

6. **QA-06: Sensitivity filtering hides over-sensitive links**
   - Given cached similarity results across sensitivity levels
   - When results are listed with `maxSensitivityLevel = internal`
   - Then restricted and confidential similarity links are omitted, while admin-level listing can see them.

7. **QA-07: Review artifact registration is observable**
   - Given an auto-discovered similarity link and review workflow enabled
   - When the link is persisted
   - Then a `similar_case_link` review artifact exists with entity ids, score payload, explanation, provenance, and sensitivity context.

## 5b. CLI Test Matrix

N/A - no CLI commands are added or changed in this step.

## 6. Cost Considerations

No paid services are introduced in this step. Explanation generation must be deterministic or caller-provided for M12-N1, and tests must not call Gemini, Vertex, GCP, or external networks. Candidate retrieval and auto-discovery must be bounded by config so future ingest integration cannot create unbounded embedding, graph, or LLM work.
