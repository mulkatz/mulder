---
spec: 24
title: Entity + Alias Repositories
roadmap_step: C3
functional_spec: ["§4.3 (entities, entity_aliases, story_entities)", "§2.4"]
scope: single
created: 2026-04-02
issue: https://github.com/mulkatz/mulder/issues/51
---

# 24 — Entity + Alias Repositories

## 1. Objective

Provide CRUD repository functions for the `entities`, `entity_aliases`, and `story_entities` tables. These repositories are the data access layer that the Enrich step (C8), Graph step (D5), and Entity management CLI (F3) will call. Follows the same plain-function pattern as `source.repository.ts` and `story.repository.ts` — no class wrapper, accepts `pg.Pool` as first argument.

## 2. Boundaries

### In scope
- Entity CRUD: create, findById, findByType, findByCanonicalId, findAll (filtered), update, delete
- Entity upsert by name+type (for idempotent enrichment)
- Entity alias CRUD: create, findByEntityId, delete, deleteByEntityId
- Story-entity junction CRUD: link, unlink, findByStoryId, findByEntityId, deleteByStoryId
- Type definitions for all inputs/outputs
- Barrel exports from `repositories/index.ts`
- Row mappers (snake_case → camelCase)

### Out of scope
- Entity edges (roadmap step C4 — separate spec)
- Taxonomy normalization logic (C6)
- Cross-lingual entity resolution logic (C7)
- JSON Schema generation (C5)
- The Enrich pipeline step itself (C8)
- CLI commands for entity management (F3)

### CLI commands in scope
N/A — this step is a library-only change (no CLI surface).

## 3. Dependencies

### Requires (must exist)
- Migration `004_entities.sql` — creates `entities` and `entity_aliases` tables (M1-A7, 🟢)
- Migration `005_relationships.sql` — creates `story_entities` and `entity_edges` tables (M1-A7, 🟢)
- Migration `008_indexes.sql` — creates indexes on entity tables (M1-A7, 🟢)
- `DatabaseError` + `DATABASE_ERROR_CODES` from `shared/errors.ts` (M1-A3, 🟢)
- `createLogger` / `createChildLogger` from `shared/logger.ts` (M1-A4, 🟢)
- Story repository pattern for reference (C1, 🟢)

### Produces (for downstream)
- Entity repository used by Enrich step (C8), Graph step (D5), Entity CLI (F3)
- Alias repository used by Enrich step (C8, taxonomy normalization), Entity CLI (F3)
- Story-entity junction used by Enrich step (C8), Graph step (D5)

## 4. Blueprint

### 4.1 Type Definitions — `entity.types.ts`

**Path:** `packages/core/src/database/repositories/entity.types.ts`

```typescript
// Taxonomy status for entities
export type TaxonomyStatus = 'auto' | 'curated' | 'merged';

// ── Entity ──

export interface Entity {
  id: string;
  canonicalId: string | null;
  name: string;
  type: string;
  attributes: Record<string, unknown>;
  corroborationScore: number | null;
  sourceCount: number;
  taxonomyStatus: TaxonomyStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEntityInput {
  id?: string;               // Optional pre-generated UUID
  name: string;
  type: string;
  canonicalId?: string;
  attributes?: Record<string, unknown>;
  taxonomyStatus?: TaxonomyStatus;
}

export interface UpdateEntityInput {
  name?: string;
  type?: string;
  canonicalId?: string | null; // null to clear
  attributes?: Record<string, unknown>;
  corroborationScore?: number | null;
  sourceCount?: number;
  taxonomyStatus?: TaxonomyStatus;
}

export interface EntityFilter {
  type?: string;
  canonicalId?: string;
  taxonomyStatus?: TaxonomyStatus;
  limit?: number;
  offset?: number;
}

// ── Entity Alias ──

export interface EntityAlias {
  id: string;
  entityId: string;
  alias: string;
  source: string | null;
}

export interface CreateEntityAliasInput {
  entityId: string;
  alias: string;
  source?: string;
}

// ── Story-Entity Junction ──

export interface StoryEntity {
  storyId: string;
  entityId: string;
  confidence: number | null;
  mentionCount: number;
}

export interface LinkStoryEntityInput {
  storyId: string;
  entityId: string;
  confidence?: number;
  mentionCount?: number;
}
```

### 4.2 Entity Repository — `entity.repository.ts`

**Path:** `packages/core/src/database/repositories/entity.repository.ts`

Functions (all accept `pg.Pool` as first arg):

| Function | SQL Pattern | Notes |
|----------|------------|-------|
| `createEntity(pool, input)` | `INSERT ... ON CONFLICT (id) DO UPDATE SET updated_at = now()` | Idempotent by ID |
| `upsertEntityByNameType(pool, input)` | `INSERT ... ON CONFLICT (name, type) WHERE canonical_id IS NULL DO UPDATE` | For enrichment — finds or creates. Requires a unique partial index on `(name, type) WHERE canonical_id IS NULL` to avoid collisions between canonical and alias entities. |
| `findEntityById(pool, id)` | `SELECT * WHERE id = $1` | Returns `Entity \| null` |
| `findEntitiesByType(pool, type)` | `SELECT * WHERE type = $1 ORDER BY name` | |
| `findEntitiesByCanonicalId(pool, canonicalId)` | `SELECT * WHERE canonical_id = $1` | Find merged entities |
| `findAllEntities(pool, filter?)` | Dynamic WHERE + pagination | Same pattern as `findAllStories` |
| `countEntities(pool, filter?)` | `SELECT COUNT(*)` with filter | |
| `updateEntity(pool, id, input)` | Dynamic SET clauses | Same pattern as `updateStory` |
| `deleteEntity(pool, id)` | `DELETE WHERE id = $1` | Returns boolean |
| `deleteEntitiesBySourceId(pool, sourceId)` | Deletes entities that are ONLY linked to stories of the given source (via `story_entities` + `stories`). Entities linked to other sources are preserved. | For `--force` cleanup |

**Note on `upsertEntityByNameType`:** The `entities` table has no unique constraint on `(name, type)` by default (the spec only has a PK on `id`). To support idempotent enrichment, this function needs a migration adding a partial unique index: `CREATE UNIQUE INDEX idx_entities_name_type_canonical ON entities(name, type) WHERE canonical_id IS NULL`. This ensures canonical entities (those without a `canonical_id` pointing elsewhere) are unique by name+type, while allowing multiple alias entities with the same name to exist. Add this index in a new migration `015_entity_name_type_index.sql`.

### 4.3 Entity Alias Repository — `entity-alias.repository.ts`

**Path:** `packages/core/src/database/repositories/entity-alias.repository.ts`

Functions:

| Function | SQL Pattern | Notes |
|----------|------------|-------|
| `createEntityAlias(pool, input)` | `INSERT ... ON CONFLICT (entity_id, alias) DO NOTHING RETURNING *` | Idempotent via UNIQUE constraint. Returns existing row on conflict. |
| `findAliasesByEntityId(pool, entityId)` | `SELECT * WHERE entity_id = $1 ORDER BY alias` | |
| `findEntityByAlias(pool, alias)` | `SELECT e.* FROM entities e JOIN entity_aliases ea ON ... WHERE ea.alias = $1` | Lookup entity by any alias |
| `deleteEntityAlias(pool, id)` | `DELETE WHERE id = $1` | Returns boolean |
| `deleteAliasesByEntityId(pool, entityId)` | `DELETE WHERE entity_id = $1` | For entity cleanup |

### 4.4 Story-Entity Junction Repository — `story-entity.repository.ts`

**Path:** `packages/core/src/database/repositories/story-entity.repository.ts`

Functions:

| Function | SQL Pattern | Notes |
|----------|------------|-------|
| `linkStoryEntity(pool, input)` | `INSERT ... ON CONFLICT (story_id, entity_id) DO UPDATE SET confidence = EXCLUDED.confidence, mention_count = EXCLUDED.mention_count` | Idempotent upsert |
| `findEntitiesByStoryId(pool, storyId)` | `SELECT e.*, se.confidence, se.mention_count FROM entities e JOIN story_entities se ON ...` | Returns enriched entity with junction data |
| `findStoriesByEntityId(pool, entityId)` | `SELECT s.*, se.confidence, se.mention_count FROM stories s JOIN story_entities se ON ...` | Returns stories linked to an entity |
| `unlinkStoryEntity(pool, storyId, entityId)` | `DELETE WHERE story_id = $1 AND entity_id = $2` | Returns boolean |
| `deleteStoryEntitiesByStoryId(pool, storyId)` | `DELETE WHERE story_id = $1` | For re-enrichment cleanup |
| `deleteStoryEntitiesBySourceId(pool, sourceId)` | `DELETE FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)` | For `--force` at source level |

### 4.5 Migration — `015_entity_name_type_index.sql`

**Path:** `packages/core/src/database/migrations/015_entity_name_type_index.sql`

```sql
-- Partial unique index for idempotent entity upsert by name+type.
-- Only applies to canonical entities (canonical_id IS NULL).
-- Merged/alias entities may share the same name+type as their canonical.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type_canonical
  ON entities(name, type)
  WHERE canonical_id IS NULL;
```

### 4.6 Barrel Exports — `repositories/index.ts`

Add exports for all new repository functions and types alongside existing source and story exports.

### 4.7 Integration Points

- `findEntitiesByStoryId` returns `StoryEntityWithEntity` (entity fields + junction fields) — used by Enrich step to check existing entities before re-extraction
- `findStoriesByEntityId` returns `StoryEntityWithStory` (story fields + junction fields) — used by Entity CLI to show context
- `deleteEntitiesBySourceId` must handle the case where an entity is shared across multiple sources — only delete if it would become orphaned (no remaining `story_entities` links)

## 5. QA Contract

### Pre-conditions
- PostgreSQL running (via docker-compose) with migrations applied through 014
- Migration 015 applied (entity name+type partial index)

### QA Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Entity creation | Pool connected, valid input | `createEntity(pool, { name: 'UFO Sighting', type: 'event' })` | Returns Entity with generated UUID, defaults (sourceCount=0, taxonomyStatus='auto', attributes={}) |
| QA-02 | Entity idempotent upsert | Entity 'Area 51' / 'location' exists | `upsertEntityByNameType(pool, { name: 'Area 51', type: 'location' })` | Returns existing entity, no duplicate created |
| QA-03 | Entity findById | Entity exists | `findEntityById(pool, id)` | Returns entity with all fields mapped to camelCase |
| QA-04 | Entity findById not found | No entity with that ID | `findEntityById(pool, 'non-existent-uuid')` | Returns `null` |
| QA-05 | Entity update | Entity exists | `updateEntity(pool, id, { name: 'Updated Name', corroborationScore: 0.8 })` | Returns updated entity, `updatedAt` changed |
| QA-06 | Entity update not found | No entity | `updateEntity(pool, id, ...)` | Throws `DatabaseError` with `DB_NOT_FOUND` |
| QA-07 | Entity filter by type | Multiple entities of different types | `findAllEntities(pool, { type: 'person' })` | Returns only 'person' entities |
| QA-08 | Entity count with filter | Multiple entities | `countEntities(pool, { type: 'location' })` | Returns correct count |
| QA-09 | Entity delete | Entity exists | `deleteEntity(pool, id)` | Returns `true`, entity gone |
| QA-10 | Alias creation | Entity exists | `createEntityAlias(pool, { entityId, alias: 'Roswell', source: 'doc-1' })` | Returns alias with generated UUID |
| QA-11 | Alias idempotent | Same alias+entityId exists | `createEntityAlias(pool, same input)` | Returns existing alias, no error |
| QA-12 | Find aliases by entity | Entity has 3 aliases | `findAliasesByEntityId(pool, entityId)` | Returns 3 aliases sorted by alias |
| QA-13 | Find entity by alias | Alias 'Roswell' linked to entity | `findEntityByAlias(pool, 'Roswell')` | Returns the linked entity |
| QA-14 | Story-entity link | Story + entity exist | `linkStoryEntity(pool, { storyId, entityId, confidence: 0.9, mentionCount: 3 })` | Junction row created |
| QA-15 | Story-entity idempotent upsert | Link exists | `linkStoryEntity(pool, { storyId, entityId, confidence: 0.95, mentionCount: 5 })` | Confidence and mentionCount updated, no duplicate |
| QA-16 | Find entities by story | Story linked to 3 entities | `findEntitiesByStoryId(pool, storyId)` | Returns 3 entities with confidence and mentionCount |
| QA-17 | Find stories by entity | Entity linked to 2 stories | `findStoriesByEntityId(pool, entityId)` | Returns 2 stories with junction data |
| QA-18 | Delete story entities by story | Story has 3 entity links | `deleteStoryEntitiesByStoryId(pool, storyId)` | All 3 junction rows deleted, entities still exist |
| QA-19 | Cascade: delete entity removes aliases | Entity has aliases | `deleteEntity(pool, id)` | Entity + all aliases deleted (ON DELETE CASCADE) |
| QA-20 | Cascade: delete story removes junction | Story has entity links | Delete story via story repo | Junction rows removed (ON DELETE CASCADE) |

### 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Notes

- The `deleteEntitiesBySourceId` function is complex — it must check for orphaned entities. Implementation: delete from `story_entities` where story belongs to source, then delete entities that have no remaining `story_entities` rows. This should be done in a transaction.
- The partial unique index `idx_entities_name_type_canonical` is essential for the Enrich step's idempotent upsert pattern. Without it, concurrent enrichment of different documents could create duplicate canonical entities.
- `findEntitiesByStoryId` and `findStoriesByEntityId` return enriched types (`StoryEntityWithEntity` / `StoryEntityWithStory`) that include both the joined record and the junction metadata (confidence, mentionCount).
