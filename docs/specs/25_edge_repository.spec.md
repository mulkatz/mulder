---
spec: 25
title: Edge Repository
roadmap_step: C4
functional_spec: ["§4.3 (entity_edges)", "§2.4", "§2.7", "§2.8"]
scope: single
created: 2026-04-02
issue: https://github.com/mulkatz/mulder/issues/53
---

# 25 — Edge Repository

## 1. Objective

Provide CRUD repository functions for the `entity_edges` table. This repository is the data access layer that the Enrich step (C8), Graph step (D5), Analyze step (G3-G5), and graph traversal retrieval (E3) will call. Follows the same plain-function pattern as `entity.repository.ts` — no class wrapper, accepts `pg.Pool` as first argument.

## 2. Boundaries

### In scope
- Edge CRUD: create, upsert, findById, findBySourceEntityId, findByTargetEntityId, findByEntityId (both directions), findByStoryId, findByEdgeType, findBetweenEntities, findAll (filtered), update, delete
- Delete helpers: deleteByStoryId, deleteBySourceId (via stories join)
- Count with filter
- Type definitions for all inputs/outputs
- Migration adding a partial unique index for idempotent upsert
- Row mapper (snake_case -> camelCase)
- Barrel exports from `repositories/index.ts`

### Out of scope
- Graph traversal logic / recursive CTEs (E3 — retrieval package)
- Deduplication logic / MinHash/SimHash (D5 — graph step)
- Contradiction resolution logic (G3 — analyze step)
- Corroboration scoring logic (D5 — graph step)
- The Enrich pipeline step itself (C8)
- The Graph pipeline step itself (D5)

### CLI commands in scope
N/A — this step is a library-only change (no CLI surface).

## 3. Dependencies

### Requires (must exist)
- Migration `005_relationships.sql` — creates `entity_edges` table (M1-A7, done)
- Migration `008_indexes.sql` — creates indexes on entity_edges (M1-A7, done)
- `DatabaseError` + `DATABASE_ERROR_CODES` from `shared/errors.ts` (M1-A3, done)
- `createLogger` / `createChildLogger` from `shared/logger.ts` (M1-A4, done)
- Entity repository for reference pattern (C3, done)

### Produces (for downstream)
- Edge repository used by Enrich step (C8), Graph step (D5), Analyze step (G3-G5)
- Edge queries used by graph traversal retrieval (E3)
- Delete helpers used by cascading reset (C9) and `--force` cleanup

## 4. Blueprint

### 4.1 Type Definitions — `edge.types.ts`

**Path:** `packages/core/src/database/repositories/edge.types.ts`

```typescript
// Edge types in the knowledge graph
export type EdgeType =
  | 'RELATIONSHIP'
  | 'DUPLICATE_OF'
  | 'POTENTIAL_CONTRADICTION'
  | 'CONFIRMED_CONTRADICTION'
  | 'DISMISSED_CONTRADICTION';

// ── Entity Edge ──

export interface EntityEdge {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationship: string;
  attributes: Record<string, unknown>;
  confidence: number | null;
  storyId: string | null;
  edgeType: EdgeType;
  analysis: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateEdgeInput {
  id?: string;                         // Optional pre-generated UUID
  sourceEntityId: string;
  targetEntityId: string;
  relationship: string;
  attributes?: Record<string, unknown>;
  confidence?: number;
  storyId?: string;
  edgeType?: EdgeType;                 // Defaults to 'RELATIONSHIP'
  analysis?: Record<string, unknown>;
}

export interface UpdateEdgeInput {
  attributes?: Record<string, unknown>;
  confidence?: number | null;
  edgeType?: EdgeType;
  analysis?: Record<string, unknown> | null;
}

export interface EdgeFilter {
  sourceEntityId?: string;
  targetEntityId?: string;
  edgeType?: EdgeType;
  storyId?: string;
  relationship?: string;
  limit?: number;
  offset?: number;
}
```

### 4.2 Edge Repository — `edge.repository.ts`

**Path:** `packages/core/src/database/repositories/edge.repository.ts`

Functions (all accept `pg.Pool` as first arg):

| Function | SQL Pattern | Notes |
|----------|------------|-------|
| `createEdge(pool, input)` | `INSERT ... RETURNING *` | Plain insert, generates UUID |
| `upsertEdge(pool, input)` | `INSERT ... ON CONFLICT (source_entity_id, target_entity_id, relationship, edge_type, story_id) WHERE story_id IS NOT NULL DO UPDATE SET attributes = EXCLUDED.attributes, confidence = EXCLUDED.confidence, analysis = EXCLUDED.analysis` | For idempotent graph step. Uses partial unique index. Only works when story_id is provided. |
| `findEdgeById(pool, id)` | `SELECT * WHERE id = $1` | Returns `EntityEdge \| null` |
| `findEdgesBySourceEntityId(pool, sourceEntityId)` | `SELECT * WHERE source_entity_id = $1 ORDER BY created_at` | Outgoing edges |
| `findEdgesByTargetEntityId(pool, targetEntityId)` | `SELECT * WHERE target_entity_id = $1 ORDER BY created_at` | Incoming edges |
| `findEdgesByEntityId(pool, entityId)` | `SELECT * WHERE source_entity_id = $1 OR target_entity_id = $1 ORDER BY created_at` | Both directions |
| `findEdgesByStoryId(pool, storyId)` | `SELECT * WHERE story_id = $1 ORDER BY created_at` | Edges from a story |
| `findEdgesByType(pool, edgeType)` | `SELECT * WHERE edge_type = $1 ORDER BY created_at` | E.g., all POTENTIAL_CONTRADICTION edges |
| `findEdgesBetweenEntities(pool, entityIdA, entityIdB)` | `SELECT * WHERE (source = A AND target = B) OR (source = B AND target = A)` | All edges between two entities, both directions |
| `findAllEdges(pool, filter?)` | Dynamic WHERE + pagination | Same pattern as `findAllEntities` |
| `countEdges(pool, filter?)` | `SELECT COUNT(*)` with filter | |
| `updateEdge(pool, id, input)` | Dynamic SET clauses | Same pattern as `updateEntity` |
| `deleteEdge(pool, id)` | `DELETE WHERE id = $1` | Returns boolean |
| `deleteEdgesByStoryId(pool, storyId)` | `DELETE WHERE story_id = $1` | For re-enrichment cleanup. Returns count. |
| `deleteEdgesBySourceId(pool, sourceId)` | `DELETE FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)` | For `--force` at source level. Returns count. |

**Note on `upsertEdge`:** Requires the partial unique index from migration 016. When `storyId` is not provided (null), falls back to plain `createEdge` behavior (INSERT only, no upsert). This is because edges without a story_id (e.g., analysis-created edges) don't have a natural upsert key.

### 4.3 Migration — `016_edge_upsert_index.sql`

**Path:** `packages/core/src/database/migrations/016_edge_upsert_index.sql`

```sql
-- Partial unique index for idempotent edge upsert.
-- Covers the common case: same relationship between same entities from the
-- same story should be upserted (Graph step re-runs). Different edge_types
-- between the same entities can coexist (e.g., RELATIONSHIP + POTENTIAL_CONTRADICTION).
-- Edges without story_id (analysis-created) are excluded — they use plain INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_edges_upsert
  ON entity_edges(source_entity_id, target_entity_id, relationship, edge_type, story_id)
  WHERE story_id IS NOT NULL;
```

### 4.4 Barrel Exports — `repositories/index.ts`

Add exports for all new edge repository functions and types alongside existing exports.

### 4.5 Integration Points

- `upsertEdge` is the primary write path for the Graph step (D5) — ensures idempotency when re-running graph construction
- `findEdgesByType('POTENTIAL_CONTRADICTION')` is the entry point for the Analyze step (G3)
- `updateEdge` is used by Analyze to store resolution results in the `analysis` JSONB field and update `edge_type` to CONFIRMED/DISMISSED
- `deleteEdgesByStoryId` and `deleteEdgesBySourceId` are used by the cascading reset function and `--force` cleanup
- `findEdgesByEntityId` (both directions) is used by graph traversal (E3) and entity management CLI (F3)
- `findEdgesBetweenEntities` is used by contradiction detection to check if a contradiction edge already exists

## 5. QA Contract

### Pre-conditions
- PostgreSQL running (via docker-compose) with migrations applied through 015
- Migration 016 applied (edge upsert partial index)
- At least one entity and one story in the database (for FK constraints)

### QA Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Edge creation | Pool connected, two entities + one story exist | `createEdge(pool, { sourceEntityId, targetEntityId, relationship: 'works_with', storyId, confidence: 0.9 })` | Returns EntityEdge with generated UUID, defaults (edgeType='RELATIONSHIP', attributes={}) |
| QA-02 | Edge upsert idempotent | Edge between entities A-B with relationship 'located_at' from story S exists | `upsertEdge(pool, { sourceEntityId: A, targetEntityId: B, relationship: 'located_at', storyId: S, confidence: 0.95 })` | Returns existing edge with updated confidence, no duplicate created |
| QA-03 | Edge upsert creates new | No edge between A-B | `upsertEdge(pool, { sourceEntityId: A, targetEntityId: B, relationship: 'sighted_at', storyId: S })` | Creates new edge, returns it |
| QA-04 | Find edge by ID | Edge exists | `findEdgeById(pool, id)` | Returns edge with all fields mapped to camelCase |
| QA-05 | Find edge by ID not found | No edge with that ID | `findEdgeById(pool, 'non-existent-uuid')` | Returns `null` |
| QA-06 | Find edges by source entity | Entity has 3 outgoing edges | `findEdgesBySourceEntityId(pool, entityId)` | Returns 3 edges |
| QA-07 | Find edges by target entity | Entity has 2 incoming edges | `findEdgesByTargetEntityId(pool, entityId)` | Returns 2 edges |
| QA-08 | Find edges by entity (both) | Entity has 2 outgoing + 1 incoming | `findEdgesByEntityId(pool, entityId)` | Returns 3 edges total |
| QA-09 | Find edges by story | Story has 4 edges | `findEdgesByStoryId(pool, storyId)` | Returns 4 edges |
| QA-10 | Find edges by type | DB has 2 POTENTIAL_CONTRADICTION edges | `findEdgesByType(pool, 'POTENTIAL_CONTRADICTION')` | Returns 2 edges |
| QA-11 | Find edges between entities | Entities A and B have edges in both directions | `findEdgesBetweenEntities(pool, A, B)` | Returns all edges between A and B regardless of direction |
| QA-12 | Update edge | Edge exists | `updateEdge(pool, id, { confidence: 0.5, analysis: { resolution: 'dismissed' } })` | Returns updated edge with new values |
| QA-13 | Update edge not found | No edge | `updateEdge(pool, id, ...)` | Throws `DatabaseError` with `DB_NOT_FOUND` |
| QA-14 | Delete edge | Edge exists | `deleteEdge(pool, id)` | Returns `true`, edge gone |
| QA-15 | Delete edges by story | Story has 3 edges | `deleteEdgesByStoryId(pool, storyId)` | Returns 3, all edges for that story deleted |
| QA-16 | Delete edges by source | Source has stories with 5 total edges | `deleteEdgesBySourceId(pool, sourceId)` | Returns 5, all edges for that source's stories deleted |
| QA-17 | Count edges with filter | DB has edges of mixed types | `countEdges(pool, { edgeType: 'RELATIONSHIP' })` | Returns correct count |
| QA-18 | Cascade: delete story removes edges | Story has edges | Delete story via story repo | Edges with that story_id removed (ON DELETE CASCADE) |
| QA-19 | Edge with null story_id | Pool connected, two entities exist | `createEdge(pool, { sourceEntityId, targetEntityId, relationship: 'analysis_link', edgeType: 'CONFIRMED_CONTRADICTION' })` | Edge created with null storyId |
| QA-20 | Different edge_types coexist | RELATIONSHIP edge between A-B from story S exists | `upsertEdge(pool, { sourceEntityId: A, targetEntityId: B, relationship: 'located_at', storyId: S, edgeType: 'POTENTIAL_CONTRADICTION' })` | Creates second edge (different edge_type), both coexist |

### 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Notes

- The `entity_edges` table has `ON DELETE CASCADE` on `story_id` — when a story is deleted, all edges referencing that story are automatically removed. This is critical for `--force` re-runs.
- The `entity_edges` table does NOT cascade on entity deletion (no ON DELETE CASCADE on source_entity_id/target_entity_id). This means deleting an entity will fail if it has edges. The orphaned entity GC function handles cleanup in the correct order.
- The partial unique index only covers edges WITH a story_id. Edges without story_id (e.g., analysis-created contradiction resolutions) are always inserted fresh. If the Analyze step needs idempotency, it should delete-then-insert or use the edge ID directly.
- `findAllEdges` with filter supports combining multiple filter fields (e.g., edgeType + storyId) for flexible querying.
