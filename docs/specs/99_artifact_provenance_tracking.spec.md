---
spec: "99"
title: "Artifact Provenance Tracking"
roadmap_step: M10-K2
functional_spec: ["§A6.1", "§A1", "§A2"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/264"
created: 2026-05-05
---

# Spec 99: Artifact Provenance Tracking

## 1. Objective

Complete M10-K2 by making every persisted artifact that exists today carry structured provenance. §A6.1 defines the target shape:

```ts
interface ArtifactProvenance {
  source_document_ids: string[];
  extraction_pipeline_run: string;
  created_at: string;
}
```

This spec applies that contract to the current artifact stores: `entities`, `entity_aliases`, `entity_edges`, `story_entities`, and `chunks`. The provenance payload must identify the source documents that contributed to each artifact, preserve that information across idempotent upserts and re-runs, and backfill existing rows where the source can be derived from `stories.source_id`.

Mulder currently supports both step-local CLI execution and batch pipeline runs. Because many artifact writes do not yet have a real `pipeline_runs.id` in their call path, K2 must store `extraction_pipeline_run` as a nullable field inside the provenance payload. Writers must set it when a true pipeline run id is available and otherwise leave it `null`. They must not synthesize a fake run id from source ids, job ids, or step names.

## 2. Boundaries

**Roadmap step:** M10-K2 - Provenance tracking: `source_document_ids` on all artifacts.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/264-artifact-provenance-tracking`.

**Target files:**

- `packages/core/src/database/migrations/025_artifact_provenance.sql`
- `packages/core/src/database/repositories/artifact-provenance.ts`
- `packages/core/src/database/repositories/entity.types.ts`
- `packages/core/src/database/repositories/entity.repository.ts`
- `packages/core/src/database/repositories/entity-alias.repository.ts`
- `packages/core/src/database/repositories/story-entity.repository.ts`
- `packages/core/src/database/repositories/edge.types.ts`
- `packages/core/src/database/repositories/edge.repository.ts`
- `packages/core/src/database/repositories/chunk.types.ts`
- `packages/core/src/database/repositories/chunk.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/pipeline/src/enrich/index.ts`
- `packages/pipeline/src/embed/index.ts`
- `packages/pipeline/src/graph/index.ts`
- `tests/specs/99_artifact_provenance_tracking.test.ts`
- Existing repository, schema, enrich, embed, and graph tests as needed
- `docs/roadmap.md`

**In scope:**

- Add a structured `provenance JSONB NOT NULL` column to `entities`, `entity_aliases`, `entity_edges`, `story_entities`, and `chunks`.
- Store provenance using the snake_case §A6.1 keys: `source_document_ids`, `extraction_pipeline_run`, and `created_at`.
- Treat `source_document_ids` as a unique array of source UUID strings.
- Treat `extraction_pipeline_run` as `UUID | null` until all artifact writers receive a real batch run context.
- Treat `created_at` as the artifact provenance creation timestamp. New writes use `now`; backfill uses the artifact row's existing `created_at` where one exists and `now` where the table has no timestamp column.
- Backfill existing rows:
  - `chunks`: from `chunks.story_id -> stories.source_id`.
  - `story_entities`: from `story_entities.story_id -> stories.source_id`.
  - `entity_edges`: from `entity_edges.story_id -> stories.source_id` when `story_id` is present.
  - `entities`: aggregate distinct source ids from `story_entities -> stories`.
  - `entity_aliases`: inherit the owning entity's aggregated source ids.
- Update repository types, mappers, create helpers, and upsert helpers to round-trip provenance.
- Update pipeline writers so artifacts created from a story include that story's source id.
- Merge provenance on idempotent upserts by unioning `source_document_ids`, preserving a real `extraction_pipeline_run` when provided, and never duplicating source ids.
- Keep resets and force reprocessing behavior compatible with existing cascade functions.

**Out of scope:**

- New artifact stores for assertions, credibility profiles, conflict nodes, or similarity links. Those artifacts do not exist yet and belong to later M10/M11 steps.
- The full ingest provenance model: AcquisitionContext, OriginalSource, CustodyStep, ArchiveLocation, Archive, Collection, and BlobVersionLink. Those belong to M10-K7 and M10-K8.
- Source rollback, soft-delete, cascading purge, or artifact provenance subtraction. Those belong to M10-K6 and will consume the K2 provenance fields later.
- Public API response schema changes unless existing repository-returned objects already flow through internal test helpers.
- Fuzzy provenance inference for graph-wide or corpus-wide artifacts without story/source context.
- Paid-service calls, embedding calls, LLM calls, OCR calls, or external network access.

## 3. Dependencies

- M10-K1 / Spec 98: content-addressed raw blob storage is complete and `sources` remain the durable document records referenced by artifacts.
- Existing story-linked artifact model: `stories.source_id` is the authoritative source context for chunks, story-entity links, and story-scoped edges.
- Existing repository upsert behavior for entities, aliases, edges, story links, and chunks must remain idempotent.

This spec blocks M10-K6 because rollback needs reliable `source_document_ids` before it can hide, purge, or preserve shared artifacts correctly.

## 4. Blueprint

1. Add migration `025_artifact_provenance.sql`:
   - Add `provenance JSONB NOT NULL DEFAULT jsonb_build_object('source_document_ids', '[]'::jsonb, 'extraction_pipeline_run', NULL, 'created_at', to_jsonb(now()))` or an equivalent constant/default-safe expression to each current artifact table.
   - Add CHECK constraints that require `provenance` to contain `source_document_ids`, `extraction_pipeline_run`, and `created_at`, and require `source_document_ids` to be a JSON array.
   - Add GIN or expression indexes for source-id lookup where useful for future rollback, using the least invasive index form supported by the current test database.
   - Backfill the five tables using story/source joins and entity aggregation.
2. Add a repository-level provenance helper:
   - Define an `ArtifactProvenance` TypeScript type with `sourceDocumentIds: string[]`, `extractionPipelineRun: string | null`, and `createdAt: Date`.
   - Provide conversion helpers between camelCase TypeScript and snake_case JSONB.
   - Provide a normalization helper that sorts/deduplicates source ids, drops empty strings, preserves a supplied run id, and fills `createdAt` when missing.
   - Provide a SQL expression or helper fragment for safe `source_document_ids` union on upsert.
3. Update repository types and mappers:
   - Add `provenance` to `Entity`, `EntityAlias`, `StoryEntity`, `EntityEdge`, and `Chunk`.
   - Add optional `provenance` to create/upsert input types.
   - Map database JSONB into normalized TypeScript provenance consistently.
4. Update artifact writes:
   - Enrich step: pass story-source provenance to entity upserts, aliases, and story-entity links.
   - Embed step: pass story-source provenance to chunks.
   - Graph step: pass story-source provenance to story-scoped edges and preserve existing graph dedup/upsert behavior.
   - If a writer lacks source context, it must still write a valid provenance payload with an empty `source_document_ids` array rather than failing.
5. Preserve idempotency:
   - Re-running a step for the same source must not append duplicate source ids.
   - Creating the same entity or edge from two different sources must merge both source ids.
   - When an upsert receives a non-null `extraction_pipeline_run`, it may overwrite a previous null value but must not overwrite an existing non-null value with null.
6. Update docs and roadmap:
   - Keep K2 marked in progress while implementation is open.
   - Mark K2 complete only after targeted tests, milestone lane checks, and review pass.

## 5. QA Contract

1. **QA-01: Migration adds valid provenance to every current artifact table**
   - Given: a migrated test database
   - When: `information_schema` and `pg_constraint` are inspected
   - Then: `entities`, `entity_aliases`, `entity_edges`, `story_entities`, and `chunks` each have a non-null `provenance` JSONB column with keys `source_document_ids`, `extraction_pipeline_run`, and `created_at`, and `source_document_ids` is constrained to a JSON array.

2. **QA-02: Migration backfills story-linked artifacts**
   - Given: rows created before migration for `stories`, `chunks`, `story_entities`, and `entity_edges`
   - When: migration `025_artifact_provenance.sql` runs
   - Then: each story-linked artifact has `source_document_ids` containing the owning `stories.source_id`.

3. **QA-03: Migration backfills shared entities and aliases**
   - Given: one entity linked to stories from two sources before migration and one alias for that entity
   - When: migration `025_artifact_provenance.sql` runs
   - Then: the entity and alias provenance contain both source ids exactly once.

4. **QA-04: Repository writes round-trip provenance**
   - Given: create/upsert inputs with source provenance
   - When: entities, aliases, story links, edges, and chunks are written and read back
   - Then: their TypeScript objects expose normalized provenance with the expected source ids and nullable run id.

5. **QA-05: Entity and edge upserts merge provenance**
   - Given: the same logical entity or edge is created from two source documents
   - When: the second write uses the existing conflict/upsert path
   - Then: the persisted artifact has both source ids, no duplicates, and keeps a non-null pipeline run id if one was previously stored or newly supplied.

6. **QA-06: Pipeline artifacts carry source provenance**
   - Given: a source proceeds through segment, enrich, embed, and graph
   - When: artifact rows are queried
   - Then: story entities, chunks, and story-scoped edges contain the source id that owns the story, while entities and aliases contain the union of sources that contributed to them.

7. **QA-07: Force reprocessing remains idempotent**
   - Given: a source has completed enrich/embed/graph and those steps are re-run with force or through the existing reset path
   - When: artifacts are recreated or upserted
   - Then: source ids are not duplicated and cascade/reset behavior remains unchanged.

8. **QA-08: Future artifact classes are not stubbed**
   - Given: §A6.1 mentions assertions, credibility profiles, conflict nodes, and similarity links
   - When: the implementation is inspected
   - Then: K2 does not create empty tables, fake repositories, or placeholder APIs for artifact classes that are not yet implemented.

## 5b. CLI Test Matrix

| Command | Scenario | Expected observable result |
|---------|----------|----------------------------|
| `mulder enrich <source-id>` | Source with segmented stories | Exit 0; `entities`, `entity_aliases`, and `story_entities` include provenance for the source. |
| `mulder embed <source-id>` | Source with enriched stories | Exit 0; created chunks include provenance for the source. |
| `mulder graph <source-id>` | Source with embedded/enriched stories | Exit 0; story-scoped edges include provenance for the source. |
| `mulder enrich --force <source-id>` | Re-run existing source | Exit 0; provenance source ids remain unique after the re-run. |

## 6. Cost Considerations

K2 is deterministic database and local pipeline work. It adds JSONB columns, backfill SQL, repository mapping, and small payload writes on artifact creation/upsert. It must not add paid service calls or broader pipeline work. The largest runtime cost is migration backfill over existing artifact tables; because K2 only aggregates through indexed story/entity relationships and stores compact source-id arrays, the production cost is expected to be bounded and appropriate for a milestone migration.
