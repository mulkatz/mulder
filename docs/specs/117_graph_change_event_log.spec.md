---
spec: 117
title: Graph Change Event Log
roadmap_step: M13-P1
functional_spec:
  - §A14.1
  - §A14.4
scope: single
created: 2026-05-09
issue: https://github.com/mulkatz/mulder/issues/311
---

## 1. Objective

Every structural change to the Knowledge Graph (entity created/updated/deleted/merged; edge created/updated/deleted) is recorded as an immutable, append-only log entry. The log is the foundation for graph versioning, audit trails, and the diff queries that arrive in P2.

Two pipeline integration points emit events in P1: the graph step (edge writes from deduplication, corroboration, and contradiction detection) and the enrich step (entity upserts). Source rollback emits `node_deleted` / `edge_deleted` events during purge. Review, agent, and manual change integrations land in future milestones.

Retention is configurable: non-significant events are pruned after `retention_days`; significant events (node creation, deletion, merging) are kept indefinitely when `retention_keep_significant: true`.

## 2. Boundaries

**In scope:**
- `graph_change_events` table (migration 049)
- `GraphChangeEvent` TypeScript types and repository (insert, query, cleanup)
- `graph_versioning.change_log` config section and Zod validation
- Core barrel export updates
- Integration: graph step emits `edge_created` / `edge_updated` for every `upsertEdge` call
- Integration: enrich step emits `node_created` / `node_updated` for every entity upsert
- Integration: source rollback emits `node_deleted` / `edge_deleted` during cascade purge
- Retention cleanup: `cleanupGraphChangeEvents()` repository function + CLI flag

**Out of scope (P2):**
- Graph snapshots and diff queries (§A14.2, §A14.3)
- Review / agent / manual change event integration

**Commands in scope:**
- `mulder graph events` — list recent change events (default: 50 most recent)
- `mulder graph events --entity-id <uuid>` — filter by entity
- `mulder graph events --type <change_type>` — filter by change type
- `mulder graph events --since <ISO8601>` — filter by timestamp
- `mulder graph events --limit <n>` — cap result count
- `mulder graph events --cleanup` — delete stale events per retention config; prints count

## 3. Dependencies

Requires:
- M1-A6 / M1-A7 — database client and migration runner
- M3-C8 — enrich step (`upsertEntityByNameType` is the hook point)
- M4-D5 — graph step (`upsertEdge` is the hook point)
- M10-K6 — source rollback repository (cascade purge hook point)

## 4. Blueprint

### 4.1 New files

#### `packages/core/src/database/migrations/049_graph_change_events.sql`

```sql
CREATE TABLE IF NOT EXISTS graph_change_events (
  event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_type    TEXT NOT NULL
                   CHECK (change_type IN (
                     'node_created','node_updated','node_deleted','node_merged',
                     'edge_created','edge_updated','edge_deleted','attribute_changed'
                   )),
  entity_id      UUID REFERENCES entities(id) ON DELETE SET NULL,
  edge_id        UUID REFERENCES entity_edges(id) ON DELETE SET NULL,
  before_state   JSONB,
  after_state    JSONB,
  caused_by_type TEXT NOT NULL
                   CHECK (caused_by_type IN ('ingest','purge','review','agent','manual')),
  caused_by_ref  TEXT NOT NULL,
  source_doc_ids TEXT[] NOT NULL DEFAULT '{}',
  is_significant BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX graph_change_events_timestamp_idx
  ON graph_change_events (timestamp DESC);
CREATE INDEX graph_change_events_entity_idx
  ON graph_change_events (entity_id)
  WHERE entity_id IS NOT NULL;
CREATE INDEX graph_change_events_edge_idx
  ON graph_change_events (edge_id)
  WHERE edge_id IS NOT NULL;
CREATE INDEX graph_change_events_significant_idx
  ON graph_change_events (timestamp DESC)
  WHERE is_significant = true;
```

#### `packages/core/src/database/repositories/graph-change-events.types.ts`

Exports:
- `GraphChangeType` — union of 8 change type literals
- `CausedByType` — union of 5 cause type literals
- `GraphChangeEvent` — full event shape (eventId, timestamp, changeType, entityId, edgeId, beforeState, afterState, causedBy, sourceDocumentIds, isSignificant)
- `AppendGraphChangeEventInput` — insert input (no eventId, no timestamp, no isSignificant — computed)
- `GraphChangeEventQueryOptions` — filter shape for list queries (entityId, edgeId, changeType, since, until, significantOnly, limit, offset)
- `CleanupGraphChangeEventsOptions` — retentionDays, keepSignificant
- `CleanupGraphChangeEventsResult` — deletedCount

#### `packages/core/src/database/repositories/graph-change-events.repository.ts`

Exports:
- `appendGraphChangeEvent(pool: Queryable, input: AppendGraphChangeEventInput, enabled?: boolean): Promise<GraphChangeEvent | null>` — inserts one event; returns null (no-op) when `enabled === false`
- `appendGraphChangeEventsBulk(pool: Queryable, inputs: AppendGraphChangeEventInput[], enabled?: boolean): Promise<number>` — batch INSERT for high-volume callers (graph step loop); returns row count
- `queryGraphChangeEvents(pool: Queryable, options: GraphChangeEventQueryOptions): Promise<GraphChangeEvent[]>` — filtered list with DESC timestamp ordering
- `cleanupGraphChangeEvents(pool: Queryable, options: CleanupGraphChangeEventsOptions): Promise<CleanupGraphChangeEventsResult>` — DELETE rows where `timestamp < now() - interval '<retentionDays> days'` AND (keepSignificant = false OR is_significant = false)

Significance is computed at insert time using the spec's threshold list: `node_created`, `node_deleted`, `node_merged`, `edge_between_clusters`. The last token is a tag applied by callers — when the `AppendGraphChangeEventInput` includes `changeType: 'edge_created'` and `afterState` contains a flag `edgeBetweenClusters: true`, the repository sets `is_significant = true`.

### 4.2 Files to modify

#### `packages/core/src/database/repositories/index.ts`
Add exports for `graph-change-events.types.js` and `graph-change-events.repository.js`.

#### `packages/core/src/config/schema.ts`
Add a new `graphVersioningObj` Zod schema and wire it into `baseMulderConfigSchema`:

```yaml
graph_versioning:
  change_log:
    enabled: true               # boolean
    retention_days: 365         # positive integer
    retention_keep_significant: true   # boolean
    significance_threshold: "node_created|node_deleted|node_merged|edge_between_clusters"
```

`retention_days` must be validated as a positive integer (≥ 1). `significance_threshold` is stored as a string (pipe-separated tokens) but not validated beyond being a non-empty string.

#### `packages/pipeline/src/graph/index.ts`
After each `upsertEdge` call in the graph step `execute()` function, collect the edge result and push an `AppendGraphChangeEventInput` into a batch array. After all edge writes complete, call `appendGraphChangeEventsBulk` with `config.graph_versioning.change_log.enabled` as the guard. Use `caused_by: { type: 'ingest', referenceId: story.sourceId }` and `sourceDocumentIds: [story.sourceId]`. Use `edge_created` for genuinely new edges and `edge_updated` for re-upserted edges (detect via the upserted row's `created_at === updated_at` or a returned `wasInserted` flag from `upsertEdge`).

#### `packages/core/src/database/repositories/edge.repository.ts`
Modify `upsertEdge` to return `{ edge: EntityEdge; wasInserted: boolean }` (or equivalent) so callers can distinguish `edge_created` from `edge_updated`. This is a non-breaking additive change — callers that destructure only `edge` are unaffected.

#### `packages/pipeline/src/enrich/index.ts`
After each `upsertEntityByNameType` call in the enrich step entity loop, append a `node_created` or `node_updated` event (using a returned `wasInserted` flag from the entity repository). Collect events into a batch array; bulk-insert at the end of the entity loop. Guard on `config.graph_versioning.change_log.enabled`.

#### `packages/core/src/database/repositories/entity.repository.ts`
Modify `upsertEntityByNameType` to return `{ entity: Entity; wasInserted: boolean }` so enrich can distinguish `node_created` from `node_updated`. Additive, non-breaking.

#### `packages/core/src/database/repositories/source-rollback.repository.ts`
In the purge path (after entities and edges are cascade-deleted), query the IDs that were deleted and bulk-append `node_deleted` / `edge_deleted` events with `caused_by: { type: 'purge', referenceId: sourceId }`. Because the rows are deleted before event logging, capture the IDs before deletion.

#### `apps/cli/src/commands/graph.ts`
Add an `events` subcommand:
```
mulder graph events [--entity-id <uuid>] [--type <change_type>] [--since <ISO8601>] [--limit <n>] [--cleanup]
```
The `--cleanup` flag runs `cleanupGraphChangeEvents` using the config's `graph_versioning.change_log` values and prints `Deleted N change events.` on success.

### 4.3 Commit sequence

1. `feat: add graph change events migration (049) and config schema`
2. `feat: add graph-change-events repository`
3. `feat: integrate change event logging into graph step`
4. `feat: integrate change event logging into enrich step`
5. `feat: emit purge events from source rollback`
6. `feat: add mulder graph events CLI subcommand`

## 5. QA Contract

**QA-01 — node_created on entity ingest**
Given: a fresh story is enriched via the enrich pipeline step
When: the step completes
Then: `graph_change_events` contains at least one row with `change_type = 'node_created'`, a non-null `entity_id` matching a real entity, `caused_by_type = 'ingest'`, `caused_by_ref` = the source's UUID, and `is_significant = true`

**QA-02 — edge_created on graph step**
Given: a story has been enriched and embedded
When: `mulder graph <story-id>` runs and creates edges
Then: `graph_change_events` contains rows with `change_type IN ('edge_created','edge_updated')`, non-null `edge_id`, `caused_by_type = 'ingest'`, and the `source_doc_ids` array contains the source UUID

**QA-03 — purge events on source rollback**
Given: a source has been ingested through the graph step and has associated entities and edges
When: the source rollback purge is executed for that source
Then: `graph_change_events` contains `node_deleted` and `edge_deleted` rows with `caused_by_type = 'purge'` and `caused_by_ref = <source-id>`

**QA-04 — retention cleanup removes non-significant events**
Given: the database contains change events with `timestamp < now() - interval '1 day'` — both significant (`is_significant = true`) and non-significant
And: the config has `retention_days: 1` and `retention_keep_significant: true`
When: `mulder graph events --cleanup` is called
Then: non-significant events older than 1 day are deleted; significant events remain; the command exits 0 and prints the deletion count

**QA-05 — change log disabled**
Given: `graph_versioning.change_log.enabled: false` in config
When: `mulder graph <story-id>` runs
Then: no rows are inserted into `graph_change_events`; the graph step still exits with success status

**QA-06 — filter by entity**
Given: change events exist for multiple entities
When: `mulder graph events --entity-id <uuid>` is called
Then: all returned rows have `entity_id = <uuid>`; rows for other entities are not returned

**QA-07 — config validation rejects invalid retention_days**
Given: a `mulder.config.yaml` with `graph_versioning.change_log.retention_days: -5`
When: `mulder config validate` is called
Then: the command exits non-zero with an error message referencing `retention_days`

## 5b. CLI Test Matrix

| Test | Command | Expected |
|------|---------|----------|
| CLI-01 | `mulder graph events --help` | Exit 0; output includes `--entity-id`, `--type`, `--since`, `--limit`, `--cleanup` |
| CLI-02 | `mulder graph events --limit 5` | Exit 0; ≤5 events returned (or empty list if no events exist) |
| CLI-03 | `mulder graph events --type node_created` | Exit 0; all returned rows have `changeType = 'node_created'` |
| CLI-04 | `mulder graph events --since 1970-01-01T00:00:00Z` | Exit 0; returns all events present in the database |
| CLI-05 | `mulder graph events --cleanup` | Exit 0; stdout contains a number (deleted count, may be 0) |
| CLI-06 | `mulder graph events --type invalid_type` | Exit non-zero; error message references unknown change type |
