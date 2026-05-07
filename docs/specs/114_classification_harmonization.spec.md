---
spec: 114
title: "Classification Harmonization"
roadmap_step: "M12-N2"
functional_spec: "§A11, §A10, §D2.1, §D2.2, §D2.6"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/301"
created: 2026-05-07
---

# Spec 114: Classification Harmonization

## 1. Objective

Complete M12-N2 by adding Mulder's domain-agnostic classification harmonization layer from §A11. Multiple configured classification taxonomies must be persisted with categories, hierarchy metadata, translations, and directed cross-taxonomy mappings. Mappings must preserve confidence, rationale, review state, provenance, and sensitivity metadata so they can feed similar case discovery without hiding uncertainty or bypassing M11 review/RBAC controls.

This step makes classification mappings usable infrastructure, not a domain taxonomy bundle. Concrete taxonomies, labels, and prompt semantics remain in config or caller-supplied data. Mulder core stores and queries generic taxonomy/category/mapping records and exposes deterministic lookup and scoring hooks for N1's `taxonomy_mapping` similarity dimensions.

## 2. Boundaries

**Roadmap step:** M12-N2 - Classification harmonization - cross-taxonomy mappings.

**Base branch:** `milestone/12`. This spec is delivered to the M12 integration branch, not directly to `main`.

**Target branch:** `feat/301-classification-harmonization`.

**Primary files:**

- `packages/core/src/database/migrations/044_classification_harmonization.sql`
- `packages/core/src/database/repositories/classification-harmonization.repository.ts`
- `packages/core/src/database/repositories/classification-harmonization.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/index.ts`
- `packages/pipeline/src/analyze/similarity.ts`
- `packages/pipeline/src/analyze/types.ts`
- `packages/pipeline/src/index.ts`
- `mulder.config.example.yaml`
- `tests/lib/schema.ts`
- `tests/specs/114_classification_harmonization.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `taxonomy.harmonization` config defaults from §A11 with enabled flag, configured taxonomy references, auto-mapping policy, and classification-reference extraction toggles.
- Add classification taxonomy/category/mapping persistence for generic `ClassificationTaxonomy`, `ClassificationCategory`, and `TaxonomyMapping` records.
- Support directed mapping types `equivalent`, `broader`, `narrower`, `overlapping`, and `related` with confidence range checks, optional conditions, rationale, mapping author, review status, provenance, sensitivity metadata, timestamps, and soft deletion.
- Add repository APIs to upsert/list/find taxonomies, categories, and mappings; resolve mappings between categories across taxonomies; and return reverse-direction views with the correct broader/narrower inversion.
- Register `taxonomy_mapping` review artifacts for generated or draft mappings through the existing M11 review workflow.
- Add a deterministic scoring helper so N1 domain similarity dimensions can consume taxonomy mappings and expose mapping confidence/type as score evidence.
- Keep affected-test mapping scoped to M12-N2/config/taxonomy/similarity files without broadening unrelated DB lanes.

**Out of scope:**

- Shipping domain-specific taxonomies or hard-coded classification labels.
- Taxonomy visualization, API routes, UI review screens, project-board review assignment, or import/export CLIs.
- Calling Gemini/Vertex or any paid LLM during tests. Auto-mapping may expose a draft input boundary, but suggestion generation itself stays outside this step.
- Deciding a canonical internal superset taxonomy. M12-N2 stores mappings between configured taxonomies only.
- Full Enrich LLM prompt work for implicit classification extraction. This step may store caller-provided extracted references and draft mappings, but complete prompt changes belong to a later Enrich-focused step.

**Architectural constraints:**

- Core code must not contain domain-specific taxonomy names or labels. Only generic taxonomy ids, category codes, display labels from config/data, and mapping metadata are allowed.
- Mapping lookup must be directed but usable from either side. Reverse views must preserve the original mapping id and invert `broader`/`narrower` semantics.
- `draft`, LLM-authored, or contested mappings must remain visible as lower-trust artifacts and must be reviewable; callers can filter by review status.
- Sensitivity filters must use the existing sensitivity lattice and must not leak over-sensitive mappings through similarity scoring or lookup APIs.
- Config defaults and tests must work from a fresh checkout using example/default config, not a local root `mulder.config.yaml`.

## 3. Dependencies

- M10-K2 / Spec 99 and M10-K7 / Spec 104: downstream artifacts carry source provenance.
- M10-K5 / Spec 102: sensitivity metadata exists and must propagate onto classification mappings.
- M11-L3 / Spec 109: `taxonomy_mapping` is a reviewable artifact type.
- M11-L5 / Spec 111 and Spec 112: RBAC/sensitivity filters and trust metadata fixes are present on `main`.
- M12-N1 / Spec 113: similar case discovery has a `taxonomy_mapping` domain-dimension extension point.

N2 enables cross-system similarity, temporal pattern aggregation by harmonized classification, external correlation grouping, and later agent research planning.

## 4. Blueprint

1. Add config support:
   - Extend `taxonomy` config with `harmonization.enabled`, `taxonomies`, `auto_mapping`, and `extraction`.
   - Keep an omitted `taxonomy.harmonization` valid by applying self-contained defaults.
   - Represent configured taxonomy references generically with `id`, optional `source`, optional `version`, optional `language`, and `status`.

2. Add migration `044_classification_harmonization.sql`:
   - Create `classification_taxonomies` with stable id, name, version, language, description, status, source ref, provenance, sensitivity metadata, timestamps, and `deleted_at`.
   - Create `classification_categories` with stable id, taxonomy id, code, label, translations JSONB, definition, optional parent id, attributes array/JSONB, provenance, sensitivity metadata, timestamps, and `deleted_at`.
   - Create `taxonomy_mappings` with source/target taxonomy/category refs, constrained mapping type, confidence, conditions, rationale, constrained mapping author, constrained review status, provenance, sensitivity metadata, timestamps, and `deleted_at`.
   - Add idempotent unique indexes for active taxonomies/categories/mappings and lookup indexes for taxonomy id, category id, mapping type, review status, provenance source ids, and sensitivity level.

3. Add repository module and exports:
   - Define `ClassificationTaxonomy`, `ClassificationCategory`, `TaxonomyMapping`, mapping type/author/review status unions, input/list option types, and similarity scoring result types.
   - Implement `upsertClassificationTaxonomy`, `findClassificationTaxonomy`, `listClassificationTaxonomies`, `upsertClassificationCategory`, `findClassificationCategory`, `listClassificationCategories`, `upsertTaxonomyMapping`, `findTaxonomyMapping`, `listTaxonomyMappings`, and `resolveTaxonomyMappings`.
   - Support filtering by taxonomy id, category id, mapping type, review status, minimum confidence, and `maxSensitivityLevel`.
   - Return reverse-direction mapping views for lookup calls without duplicating rows.

4. Add review integration:
   - When a mapping is created by `llm_auto` or stored with `review_status = draft`, upsert a `taxonomy_mapping` review artifact.
   - Include mapping type, source/target category refs, confidence, rationale, conditions, provenance, and sensitivity context in the review artifact payload.
   - Do not auto-approve mappings or assign reviewers beyond existing review workflow defaults.

5. Add similarity integration:
   - Provide a deterministic helper for N1 domain dimensions that scores mapped category pairs by mapping type and confidence.
   - `equivalent` and high-confidence `overlapping` mappings should score higher than `related`; `broader`/`narrower` should preserve direction in the evidence payload.
   - Similarity scoring must respect review-status and sensitivity filters and surface insufficient-data when no usable category refs or mappings exist.

6. Update affected-test mapping only if needed:
   - Ensure taxonomy harmonization repository/config/similarity files map to the M12-N2 spec tests and do not cause unrelated full DB suite fan-out.

7. Update roadmap state only after gates:
   - Keep N2 marked in progress while the branch is open.
   - Mark N2 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/12`.

## 5. QA Contract

1. **QA-01: Config exposes §A11 harmonization defaults**
   - Given `mulder.config.example.yaml` and a minimal config without `taxonomy.harmonization`
   - When config is loaded through the public loader
   - Then harmonization defaults are present with bounded auto-mapping policy, extraction toggles, and no hard-coded domain taxonomy labels.

2. **QA-02: Harmonization schema is constrained**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `classification_taxonomies`, `classification_categories`, and `taxonomy_mappings` exist with mapping type, confidence, author, review status, provenance, sensitivity, soft-delete, and lookup constraints/indexes.

3. **QA-03: Taxonomies and categories round-trip**
   - Given a taxonomy with parent/child categories, translations, definitions, and attributes
   - When repository upserts and lists those records
   - Then hierarchy refs, translations, attributes, provenance, sensitivity metadata, and active status are preserved.

4. **QA-04: Directed mappings resolve both ways**
   - Given categories in two taxonomies and mappings of every supported type
   - When mappings are resolved from either side
   - Then the original direction is preserved, reverse views invert `broader`/`narrower`, and confidence/rationale/conditions remain visible.

5. **QA-05: Filtering respects review status and sensitivity**
   - Given mappings across draft/reviewed/contested states and sensitivity levels
   - When lookup runs with review and `maxSensitivityLevel` filters
   - Then over-sensitive and excluded-status mappings are omitted.

6. **QA-06: Draft mappings become reviewable**
   - Given an LLM-authored or draft taxonomy mapping
   - When it is upserted
   - Then a `taxonomy_mapping` review artifact exists with source/target refs, mapping type, confidence, rationale, provenance, and sensitivity context.

7. **QA-07: Similarity scoring consumes mappings**
   - Given entities with category refs in different taxonomies and a reviewed mapping between those categories
   - When a `taxonomy_mapping` similarity dimension is evaluated
   - Then the domain score reflects mapping type and confidence, includes mapping evidence, and respects review/sensitivity filters.

## 5b. CLI Test Matrix

N/A - no CLI commands are added or changed in this step.

## 6. Cost Considerations

N2 adds database/config logic and deterministic scoring only. It must not call Gemini, Vertex, GCP, or external networks in tests. Auto-mapping configuration may name a future reasoning model from §A11, but this step stores caller-provided draft mappings and review metadata rather than generating mappings itself.
