---
spec: 105
title: "Collection Management"
roadmap_step: "M10-K8"
functional_spec: "§A2.3, §A1, §A2"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/277"
created: 2026-05-06
---

# Spec 105: Collection Management

## 1. Objective

Complete M10-K8 by adding generic collection management on top of the ingest provenance model from Spec 104. Collections are logical document groupings inside Mulder, independent of physical archives. They can mirror an archive, represent one import batch, or be curated/thematic groups, while the core remains domain-agnostic under §A1.

K8 makes the `collection_id` captured by AcquisitionContext real: operators can create collections, tag them, define ingestion defaults, attach provenance contexts to them, and inspect collection statistics derived from current provenance/blob rows.

## 2. Boundaries

**Roadmap step:** M10-K8 - Collection management: create, tag, defaults.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/277-collection-management`.

**Primary files:**

- `packages/core/src/database/migrations/036_collections.sql`
- `packages/core/src/database/repositories/collection.types.ts`
- `packages/core/src/database/repositories/collection.repository.ts`
- `packages/core/src/database/repositories/ingest-provenance.types.ts`
- `packages/core/src/database/repositories/ingest-provenance.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `apps/cli/src/commands/collection.ts`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/index.ts`
- `tests/specs/105_collection_management.test.ts`
- Existing K7 ingest provenance and config tests as needed
- `docs/roadmap.md`

**In scope:**

- Add a durable `collections` table matching §A2.3 collection fields: identity, name, description, type, optional archive link, creator, visibility, tags, defaults, and timestamps.
- Add a foreign key from `acquisition_contexts.collection_id` to `collections.collection_id` without breaking existing nullable rows.
- Store collection defaults as explicit typed columns or constrained JSON, including `sensitivity_level`, `default_language`, and nullable `credibility_profile_id`.
- Store tags as a normalized text array with deterministic ordering and duplicate removal.
- Add repository APIs to create, update, find, list, tag, and summarize collections.
- Compute `document_count`, `total_size_bytes`, `languages`, and date range from active or restored acquisition contexts joined to document blobs and collection metadata. Stored counters may exist as cache columns only if repository reads keep them correct.
- Support explicit collection ids during ingest provenance and fail clearly when an unknown collection id is supplied.
- Support configured auto-creation:
  - archive mirror collections when provenance includes an archive and `ingest_provenance.collections.auto_create_from_archive` is enabled;
  - import batch/manual defaults when provenance omits a collection and config supplies a default collection policy;
  - path-segment tags when `ingest_provenance.collections.auto_tag_from_path_segments` is enabled.
- Add CLI management commands for collection create, list, show, tag, and defaults inspection/update.
- Keep all collection types and defaults generic. Domain labels belong in config, tags, and user-provided metadata, not in core code.

**Out of scope:**

- Browser app collection management UI.
- Collection RBAC enforcement. `visibility` is stored for future §A5 access control, but K8 does not enforce user roles.
- Credibility profile implementation. K8 only stores nullable default profile ids for later §A8 work.
- Virtual archive tree browsing API/UI beyond path-segment tagging needed for collection defaults.
- Blob version links and version collection behavior.
- Paid LLM auto-classification of folder segment types. K8 may consume existing path segment metadata but must not call paid services.

## 3. Dependencies

- M10-K1 / Spec 98: `document_blobs` stores content-addressed blob metadata.
- M10-K5 / Spec 102: sensitivity levels exist and collection defaults should use the same generic levels.
- M10-K7 / Spec 104: archives, archive locations, and acquisition contexts exist, including nullable `collection_id`.

K8 blocks real archive ingest because archive batches need durable collection assignment, defaults, and tags before documents enter the pipeline at scale. K8 also gives K9 richer provenance fixtures for golden test coverage.

## 4. Blueprint

1. Add migration `036_collections.sql`:
   - Create `collections` with `collection_id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `name`, `description`, `type`, `archive_id UUID NULL REFERENCES archives(archive_id)`, `created_by`, `visibility`, `tags TEXT[]`, `default_sensitivity_level`, `default_language`, `default_credibility_profile_id UUID NULL`, timestamps, and optional stored statistic cache fields if needed.
   - Constrain `type` to `archive_mirror`, `thematic`, `import_batch`, `curated`, `other`.
   - Constrain `visibility` to `private`, `team`, `public`.
   - Constrain `default_language` to non-empty text and `tags` to an array.
   - Add a uniqueness rule that prevents duplicate archive mirror collections for the same archive.
   - Add useful indexes for archive lookup, type/visibility filters, name search, tags, and created timestamps.
   - Add or repair `acquisition_contexts.collection_id` foreign key to `collections(collection_id)` using `ON DELETE SET NULL`.
   - Keep the migration replay-safe with guarded `ALTER TABLE` and `IF NOT EXISTS` objects.

2. Add repository types:
   - `CollectionType`, `CollectionVisibility`, `CollectionDefaults`, `Collection`, `CollectionInput`, `CollectionUpdateInput`, `CollectionSummary`, and `CollectionListOptions`.
   - Map snake_case rows to camelCase objects consistently with the existing provenance repositories.
   - Normalize tags by trimming, lowercasing only when already established locally, sorting, and removing duplicates. Do not impose domain-specific tag vocabularies.

3. Add repository APIs:
   - `createCollection(pool, input)` and `upsertArchiveMirrorCollection(pool, input)`.
   - `findCollectionById(pool, id)` and `findCollectionByName(pool, name)`.
   - `listCollections(pool, options)` with type, visibility, archive id, tag, and pagination filters.
   - `updateCollection(pool, id, patch)` for description, visibility, defaults, and archive link changes.
   - `setCollectionTags(pool, id, tags)`, `addCollectionTags(pool, id, tags)`, and `removeCollectionTags(pool, id, tags)`.
   - `summarizeCollection(pool, id)` deriving active document counts, total blob size, languages, and earliest/latest provenance/archive dates.
   - `resolveCollectionForIngest(pool, input, config)` to handle explicit ids, archive mirror auto-create, and configured default collection behavior inside one transaction.

4. Wire ingest provenance:
   - Extend `ingest_provenance.collections` config with `auto_create_from_archive`, `auto_tag_from_path_segments`, optional default collection name/type/visibility/created_by, and default values for sensitivity/language.
   - Existing configs that omit collection options must still validate with defaults from §A2.7.
   - `recordIngestProvenance` must validate or resolve `collection_id` before inserting an AcquisitionContext.
   - When archive mirror auto-create is enabled and provenance includes an archive, create or reuse one `archive_mirror` collection for that archive and attach the context.
   - When path-segment auto-tagging is enabled, merge `segment_type:name` tags into the resolved collection.
   - Dry-run ingest must not create collections or collection tags.

5. Add CLI:
   - `mulder collection create --name <name> [--type <type>] [--archive <archive-id>] [--description <text>] [--visibility <private|team|public>] [--tag <tag>...] [--json]`.
   - `mulder collection list [--type <type>] [--visibility <visibility>] [--tag <tag>] [--json]`.
   - `mulder collection show <collection-id> [--json]`.
   - `mulder collection tag <collection-id> --add <tag>... [--remove <tag>...] [--json]`.
   - `mulder collection defaults <collection-id> [--sensitivity <level>] [--language <code>] [--credibility-profile <id>] [--json]`.
   - Commands must require Cloud SQL/Postgres config like the existing source/taxonomy management commands and emit parseable JSON under `--json`.

6. Update docs and roadmap:
   - Keep K8 marked in progress while implementation is open.
   - Mark K8 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/10`.

## 5. QA Contract

1. **QA-01: Migration creates collection storage**
   - Given a fresh migrated database
   - Then `collections` exists with type, visibility, tag/default constraints, useful indexes, and a safe foreign key from `acquisition_contexts.collection_id`.

2. **QA-02: Repository manages collections and tags**
   - Given repository calls for create, list, show, update, and tag mutation
   - Then collections round-trip with deterministic tags, defaults, archive links, and visibility filters.

3. **QA-03: Summary derives current collection statistics**
   - Given two blobs with active AcquisitionContexts in one collection and a deleted context in another
   - When the collection summary is read
   - Then document count, total size, languages, and date range reflect only active/restored contexts for the requested collection.

4. **QA-04: Explicit ingest collection id is enforced**
   - Given ingest provenance with a valid collection id
   - Then the AcquisitionContext is linked to that collection.
   - Given an unknown collection id
   - Then ingest/provenance recording fails without writing a dangling context.

5. **QA-05: Archive mirror auto-create works**
   - Given ingest provenance with archive metadata and `auto_create_from_archive` enabled
   - When no explicit collection id is supplied
   - Then one `archive_mirror` collection is created or reused for the archive and the context is linked to it.

6. **QA-06: Path segment tags merge into collections**
   - Given archive location path segments and `auto_tag_from_path_segments` enabled
   - Then collection tags include deterministic tags derived from those segments without overwriting existing manual tags.

7. **QA-07: Config defaults preserve existing configs**
   - Given the shipped example config and a minimal config that omits `ingest_provenance.collections`
   - Then config validation succeeds and exposes the K8 defaults.

8. **QA-08: CLI collection management works**
   - Given a migrated test database
   - When collection create/list/show/tag/defaults commands run with `--json`
   - Then each exits 0, emits parseable JSON, and matches repository-visible state.

9. **QA-09: Regression guard**
   - Spec 104 provenance tests remain green, especially duplicate ingest and explicit provenance behavior.

## 5b. CLI Test Matrix

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder collection create --name "Archive A" --type archive_mirror --archive <archive-id> --tag fonds --json` | Existing archive | Exit 0; collection row created with archive link and tag. |
| `mulder collection list --tag fonds --json` | At least one tagged collection | Exit 0; JSON list includes the tagged collection and summary fields. |
| `mulder collection show <collection-id> --json` | Existing collection | Exit 0; JSON includes defaults, tags, archive id, and derived statistics. |
| `mulder collection tag <collection-id> --add region:a --remove stale --json` | Existing collection | Exit 0; tags are updated deterministically. |
| `mulder collection defaults <collection-id> --sensitivity internal --language de --json` | Existing collection | Exit 0; defaults update and round-trip. |
| `mulder collection show <unknown-id> --json` | Missing collection | Exit non-zero; no state changes. |

## 6. Cost Considerations

K8 is deterministic database, config, pipeline wiring, and CLI work. It must not call paid AI services. Derived statistics should be computed with bounded SQL over indexed provenance rows; bulk archive imports may contain many contexts, so summary queries need pagination/filter support and useful indexes.
