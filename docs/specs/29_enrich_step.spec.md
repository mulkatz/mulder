---
spec: 29
title: Enrich Step
roadmap_step: C8
functional_spec: §2.4, §6.2, §1 (enrich cmd)
scope: single
issue: https://github.com/mulkatz/mulder/issues/61
created: 2026-04-03
---

# 29 — Enrich Step

## 1. Objective

Implement the Enrich pipeline step (`mulder enrich`) that extracts entities and relationships from stories using Gemini structured output, normalizes them against the taxonomy (pg_trgm), resolves cross-document entity matches (3-tier), and writes results to PostgreSQL. This is the fourth pipeline step, operating on stories produced by the Segment step.

The step orchestrates existing building blocks (JSON Schema generator from spec 26, taxonomy normalization from spec 27, cross-lingual entity resolution from spec 28) into a complete pipeline step with CLI integration.

## 2. Boundaries

**In scope:**
- `execute()` function for the enrich pipeline step (single story or batch via `--all`/`--source`)
- Pre-chunking fallback for oversized stories (> `enrichment.max_story_tokens`)
- Token counting via Vertex AI `countTokens` API
- Taxonomy normalization (calls existing `normalizeTaxonomy`)
- Cross-lingual entity resolution (calls existing `resolveEntity`)
- Deadlock prevention via lexicographic sort of entity upserts
- Force cleanup (story-level and source-level)
- CLI command: `mulder enrich <story-id>`, `--all`, `--source <id>`, `--force`
- EnrichError + ENRICH_ERROR_CODES in the error hierarchy
- Barrel exports from pipeline package

**Out of scope:**
- Taxonomy bootstrap (M5 — F1)
- Taxonomy curation workflow (M5 — F2)
- Embed step (M4 — D4)
- Graph step (M4 — D5)
- `--force` with `--all` (spec §2.4: too dangerous for bulk)

**CLI surface (from §1):**
```
mulder enrich <story-id>     # Enrich a specific story
  --all                      # Enrich all stories with status=segmented
  --source <id>              # Enrich all stories from a specific source
  --force                    # Re-enrich even if already enriched (cascading reset)
```

## 3. Dependencies

### Requires (must exist)
- Spec 22: Story repository — `findStoryById`, `findStoriesBySourceId`, `updateStoryStatus`
- Spec 23: Segment step — stories with `segmented` status, GCS Markdown URIs
- Spec 24: Entity + alias repositories — `createEntity`, `upsertEntityByNameType`, `createEntityAlias`
- Spec 25: Edge repository — `upsertEdge`, `deleteEdgesByStoryId`, `deleteEdgesBySourceId`
- Spec 26: JSON Schema generator — `generateExtractionSchema`, `getExtractionResponseSchema`
- Spec 27: Taxonomy normalization — `normalizeTaxonomy`
- Spec 28: Cross-lingual entity resolution — `resolveEntity`

### Provides (consumed by)
- D4 (Embed step) — stories with status `enriched`
- D5 (Graph step) — entities and edges in database

## 4. Blueprint

### 4.1 New Files

#### `packages/pipeline/src/enrich/types.ts`

Step-specific types:

```typescript
export interface EnrichInput {
  storyId: string;
  force?: boolean;
}

export interface EnrichResult {
  status: 'success' | 'partial' | 'failed';
  data: EnrichmentData | null;
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;
    items_skipped: number;
    items_cached: number;
  };
}

export interface EnrichmentData {
  storyId: string;
  entitiesExtracted: number;
  entitiesResolved: number;
  relationshipsCreated: number;
  taxonomyEntriesAdded: number;
  chunksUsed: number; // 1 if no pre-chunking, N if pre-chunked
}

export interface ExtractedEntity {
  name: string;
  type: string;
  confidence: number;
  attributes: Record<string, unknown>;
  mentions: string[];
}

export interface ExtractedRelationship {
  source_entity: string;
  target_entity: string;
  relationship_type: string;
  confidence: number;
  attributes?: Record<string, unknown>;
}
```

#### `apps/cli/src/commands/enrich.ts`

CLI command following the segment.ts pattern:
- `mulder enrich <story-id>` — enrich a single story
- `--all` — enrich all stories with status `segmented`
- `--source <id>` — enrich all stories from a specific source
- `--force` — re-enrich (cascading reset)
- `<story-id>` and `--all`/`--source` are mutually exclusive
- Output: table with Story ID, Entities, Relationships, Status
- Summary line with totals

### 4.2 Modified Files

#### `packages/pipeline/src/enrich/index.ts`

Currently barrel exports only. Add `execute()` function + keep existing re-exports.

**execute() flow:**
1. Load story from DB, validate status (must be >= `segmented`)
2. If already enriched and no `--force`, skip
3. If `--force` and already enriched, run `forceCleanup()`
4. Load story Markdown from GCS via `gcs_markdown_uri`
5. Token count check via `services.llm.countTokens()` (or equivalent)
6. If tokens ≤ `config.enrichment.max_story_tokens`: single extraction call
7. If tokens > limit: pre-chunk at paragraph boundaries (~10k tokens each), extract per chunk, aggregate + deduplicate
8. Generate JSON Schema from ontology via `generateExtractionSchema()`
9. Build extraction prompt via `renderPrompt('extract-entities', ...)`
10. Call Gemini structured output, validate response via `getExtractionResponseSchema()`
11. Sort entities lexicographically by `(type, name)` for deadlock prevention
12. For each entity:
    a. Upsert to `entities` table
    b. Normalize via `normalizeTaxonomy()` — assign `canonical_id`
    c. Resolve via `resolveEntity()` — cross-document matching
    d. Link to story via `linkStoryEntity()`
13. For each relationship:
    a. Resolve source/target entity names to IDs
    b. Upsert to `entity_edges` table via `upsertEdge()`
14. Update story status to `enriched`
15. Upsert source step record
16. Fire-and-forget Firestore observability update

**forceCleanup() flow:**
- When called with `--force` on a story: delete `story_entities` for that story, delete `entity_edges` for that story, reset story status to `segmented`
- When called with `--force --source <id>`: iterate all stories for that source, cleanup each, also delete all `entity_edges` by source

#### `packages/core/src/shared/errors.ts`

Add `EnrichError` class and `ENRICH_ERROR_CODES`:

```typescript
export const ENRICH_ERROR_CODES = {
  ENRICH_STORY_NOT_FOUND: 'ENRICH_STORY_NOT_FOUND',
  ENRICH_INVALID_STATUS: 'ENRICH_INVALID_STATUS',
  ENRICH_MARKDOWN_NOT_FOUND: 'ENRICH_MARKDOWN_NOT_FOUND',
  ENRICH_LLM_FAILED: 'ENRICH_LLM_FAILED',
  ENRICH_VALIDATION_FAILED: 'ENRICH_VALIDATION_FAILED',
  ENRICH_ENTITY_WRITE_FAILED: 'ENRICH_ENTITY_WRITE_FAILED',
} as const;
export type EnrichErrorCode = (typeof ENRICH_ERROR_CODES)[keyof typeof ENRICH_ERROR_CODES];
export class EnrichError extends MulderError { ... }
```

#### `packages/core/src/index.ts`

Add missing exports needed by the enrich step:
- `upsertEntityByNameType`
- `linkStoryEntity`, `unlinkStoryEntity`
- `deleteStoryEntitiesByStoryId`, `deleteStoryEntitiesBySourceId`
- `deleteEdgesByStoryId`, `deleteEdgesBySourceId`
- `upsertEdge`, `createEdge`
- `deleteEntitiesBySourceId`
- `findEntitiesByCanonicalId`, `findEntitiesByType`
- `EnrichError`, `ENRICH_ERROR_CODES`
- Types: `CreateEdgeInput`, `EntityEdge`, `LinkStoryEntityInput`, `StoryEntity`

#### `packages/pipeline/src/index.ts`

Add enrich exports:
```typescript
export type { EnrichInput, EnrichmentData, EnrichResult } from './enrich/types.js';
export { execute as executeEnrich } from './enrich/index.js';
// Keep existing re-exports from enrich
```

#### `apps/cli/src/commands/` integration

Register enrich command in the CLI entry point (wherever commands are registered — likely `apps/cli/src/index.ts` or similar).

### 4.3 Config

Uses existing config:
- `config.enrichment.model` — Gemini model for extraction (default: `gemini-2.5-flash`)
- `config.enrichment.max_story_tokens` — token threshold for pre-chunking (default: 15000)
- `config.taxonomy.normalization_threshold` — pg_trgm similarity threshold (default: 0.4)
- `config.entity_resolution` — 3-tier resolution strategy config
- `config.ontology` — entity types, attributes, relationships

### 4.4 Integration Points

- **Service abstraction:** Uses `services.llm.generateStructured()` for Gemini, `services.storage.download()` for GCS Markdown, `services.embedding.embed()` (via resolution), `services.firestore.setDocument()` for observability
- **Prompt template:** Uses existing `extract-entities.jinja2` template
- **Token counting:** Uses `services.llm.countTokens()` or Vertex AI `countTokens` API. If the service interface lacks this, a simple character-based estimate (chars / 4) is acceptable as fallback.

### 4.5 Phases

**Phase 1:** Core step logic
- Types, error codes, execute function, force cleanup
- Core exports additions

**Phase 2:** CLI + integration
- CLI command, pipeline barrel exports, command registration

## 5. QA Contract

### QA-01: Single story enrichment
**Given** a story with status `segmented` and Markdown in GCS
**When** `execute({ storyId })` is called
**Then** entities are written to `entities` table, edges to `entity_edges`, story_entities junction populated, story status updated to `enriched`, source step upserted as `completed`

### QA-02: Batch enrichment via --all
**Given** multiple stories with status `segmented`
**When** `mulder enrich --all` is called
**Then** all segmented stories are enriched, stories already `enriched` are skipped

### QA-03: Source-scoped enrichment
**Given** a source with multiple segmented stories
**When** `mulder enrich --source <id>` is called
**Then** only stories from that source are enriched

### QA-04: Force re-enrichment (story-level)
**Given** a story with status `enriched` and existing entities/edges
**When** `execute({ storyId, force: true })` is called
**Then** existing story_entities and entity_edges for that story are deleted, entities re-extracted, story re-enriched

### QA-05: Force re-enrichment (source-level)
**Given** a source with enriched stories
**When** `mulder enrich --source <id> --force` is called
**Then** all stories from that source are cleaned up and re-enriched

### QA-06: Skip already enriched
**Given** a story with status `enriched`
**When** `execute({ storyId })` is called without `--force`
**Then** the step returns `success` with `items_processed: 0` and `items_skipped > 0`

### QA-07: Invalid status rejection
**Given** a story with status `ingested` (not yet segmented)
**When** `execute({ storyId })` is called
**Then** an EnrichError with code `ENRICH_INVALID_STATUS` is thrown

### QA-08: Taxonomy normalization
**Given** an entity extracted from a story
**When** the entity is processed
**Then** `normalizeTaxonomy()` is called and the entity gets a `canonical_id` from the taxonomy

### QA-09: Entity resolution
**Given** an entity matching an existing entity (same name/type in another document)
**When** resolution runs
**Then** the entity is merged with the existing canonical entity

### QA-10: Deadlock prevention
**Given** entities extracted from a story
**When** entities are written to the database
**Then** they are sorted lexicographically by `(type, name)` before any database writes

### QA-11: Relationship edge creation
**Given** relationships extracted between entities
**When** the step completes
**Then** `entity_edges` records exist with correct source/target entity IDs and relationship types

### QA-12: Story not found
**Given** a non-existent story ID
**When** `execute({ storyId })` is called
**Then** an EnrichError with code `ENRICH_STORY_NOT_FOUND` is thrown

### QA-13: --all and --force are mutually exclusive
**Given** the CLI
**When** `mulder enrich --all --force` is called
**Then** an error is printed and the process exits with code 1

## 5b. CLI Test Matrix

### CLI-01: Help output
**When** `mulder enrich --help`
**Then** output includes `<story-id>`, `--all`, `--source`, `--force`

### CLI-02: No arguments
**When** `mulder enrich` (no story-id, no --all, no --source)
**Then** error message and exit code 1

### CLI-03: Mutually exclusive args
**When** `mulder enrich <id> --all`
**Then** error message and exit code 1

### CLI-04: --source without --all
**When** `mulder enrich --source <id>`
**Then** enriches stories from that source (valid usage)
