---
spec: 51
title: Entity Management CLI
roadmap_step: F3
functional_spec: ["§1 (entity cmd)", "§6 (taxonomy system)"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/133
created: 2026-04-10
---

# 1. Objective

Add the `mulder entity` command group with four subcommands — `list`, `show`, `merge`, and `aliases` — providing human-in-the-loop entity management for production use. Users can inspect extracted entities, view their relationships, manually merge duplicate entities, and manage aliases.

All business logic uses existing repository functions from `@mulder/core`. The merge operation is the only new repository-level function (transactional reassignment of edges, story links, and aliases).

# 2. Boundaries

**In scope:**
- `mulder entity list [--type <type>] [--search <q>] [--json]`
- `mulder entity show <entity-id> [--json]`
- `mulder entity merge <id1> <id2> [--json]`
- `mulder entity aliases <entity-id> [--add <name>] [--remove <alias-id>] [--json]`
- Extending `EntityFilter` with a `search` field (ILIKE on `entities.name`)
- Adding a `mergeEntities` function to the entity repository (transactional)
- Exporting currently-unexported repository functions from `@mulder/core`

**Out of scope:**
- Batch merge operations
- Interactive merge workflows (diffing two entities for user review)
- Entity deletion (handled by `mulder db gc` for orphans)
- Taxonomy reassignment (handled by `mulder taxonomy merge`)

**Existing infrastructure (from C3, C4):**
- `entity.repository.ts` — `findEntityById`, `findAllEntities`, `countEntities`, `findEntitiesByCanonicalId`, `updateEntity`
- `entity-alias.repository.ts` — `findAliasesByEntityId`, `createEntityAlias`, `deleteEntityAlias`
- `edge.repository.ts` — `findEdgesByEntityId`, `findAllEdges`
- `story-entity.repository.ts` — `findStoriesByEntityId`

# 3. Dependencies

**Requires (must exist):**
- Entity, alias, edge, and story-entity repositories (C3, C4) — all exist
- CLI scaffold with `withErrorHandler`, `printJson`, `printError`, `printSuccess` (A5) — exists
- Config loader, `getWorkerPool`, `closeAllPools` (A2, A6) — exist

**Required by:**
- F4 (Status overview) — will use `countEntities`
- F5 (Export commands) — will use entity listing

# 4. Blueprint

## 4.1 Extend `EntityFilter` with search

**File:** `packages/core/src/database/repositories/entity.types.ts`

Add `search?: string` to `EntityFilter`. When set, applies `WHERE name ILIKE '%' || $N || '%'` (case-insensitive substring match).

## 4.2 Update `findAllEntities` to support search

**File:** `packages/core/src/database/repositories/entity.repository.ts`

When `filter.search` is provided, add an ILIKE condition on `entities.name`:
```sql
name ILIKE '%' || $N || '%'
```

## 4.3 Add `mergeEntities` function

**File:** `packages/core/src/database/repositories/entity.repository.ts`

New exported function `mergeEntities(pool, targetId, sourceId)` — merges entity `sourceId` into `targetId` in a single transaction:

1. Verify both entities exist (throw `DB_NOT_FOUND` if either missing)
2. Verify `sourceId !== targetId` (throw `VALIDATION_ERROR` if same)
3. Verify neither entity is already merged (has `canonical_id` set — throw `VALIDATION_ERROR` if so)
4. **Reassign story_entities:** `UPDATE story_entities SET entity_id = $target WHERE entity_id = $source` — handle conflicts with `ON CONFLICT (story_id, entity_id) DO NOTHING` followed by `DELETE FROM story_entities WHERE entity_id = $source` for any remaining rows (story was already linked to both entities)
5. **Reassign edges (source side):** `UPDATE entity_edges SET source_entity_id = $target WHERE source_entity_id = $source` — skip self-loops (where target_entity_id = $target)
6. **Reassign edges (target side):** `UPDATE entity_edges SET target_entity_id = $target WHERE target_entity_id = $source` — skip self-loops (where source_entity_id = $target)
7. **Delete self-loops:** `DELETE FROM entity_edges WHERE source_entity_id = target_entity_id` (edges that became self-referential after reassignment)
8. **Copy aliases:** For each alias of the source entity, create it on the target (idempotent via `ON CONFLICT DO NOTHING`)
9. **Add source entity name as alias on target:** Create alias with `source: 'merge'`
10. **Mark source as merged:** `UPDATE entities SET canonical_id = $target, taxonomy_status = 'merged' WHERE id = $source`

Returns: `{ target: Entity, merged: Entity, edgesReassigned: number, storiesReassigned: number, aliasesCopied: number }`

## 4.4 Export missing functions from `@mulder/core`

**File:** `packages/core/src/database/repositories/index.ts`

Add to exports:
- `findEdgesByEntityId` (from `edge.repository.ts`)
- `deleteEntityAlias` (from `entity-alias.repository.ts`)
- `deleteAliasesByEntityId` (from `entity-alias.repository.ts`)
- `mergeEntities` (new, from `entity.repository.ts`)

**File:** `packages/core/src/index.ts`

Add same functions to top-level exports, plus the `MergeEntitiesResult` type.

## 4.5 CLI command file

**File:** `apps/cli/src/commands/entity.ts`

Export: `registerEntityCommands(program: Command): void`

### `entity list`

```
mulder entity list [--type <type>] [--search <q>] [--json]
```

- Calls `findAllEntities(pool, { type, search, limit: 100 })`
- Calls `countEntities(pool, { type, search })` for total count
- Default output: table with columns: ID (first 8 chars), Name, Type, Taxonomy Status, Source Count, Corroboration
- `--json`: full entity objects array
- Footer: "Showing {n} of {total} entities"

### `entity show`

```
mulder entity show <entity-id> [--json]
```

- Calls `findEntityById(pool, id)` — error if null
- Calls `findAliasesByEntityId(pool, id)` — aliases
- Calls `findEdgesByEntityId(pool, id)` — relationships (both directions)
- Calls `findStoriesByEntityId(pool, id)` — linked stories
- Calls `findEntitiesByCanonicalId(pool, id)` — merged entities (entities that were merged into this one)
- Default output: structured text block showing entity details, aliases, relationships, and stories
- `--json`: single object with `entity`, `aliases`, `edges`, `stories`, `mergedEntities` fields

### `entity merge`

```
mulder entity merge <id1> <id2> [--json]
```

- `id1` is the target (survives), `id2` is the source (gets merged)
- Calls `mergeEntities(pool, id1, id2)`
- Default output: summary of what was reassigned
- `--json`: the `MergeEntitiesResult` object

### `entity aliases`

```
mulder entity aliases <entity-id> [--add <name>] [--remove <alias-id>] [--json]
```

- Without flags: list all aliases for the entity
- `--add <name>`: create a new alias (source: `'manual'`)
- `--remove <alias-id>`: delete an alias by its UUID
- Default output: table with columns: ID (first 8 chars), Alias, Source
- `--json`: array of alias objects

## 4.6 Register in CLI index

**File:** `apps/cli/src/index.ts`

Add `import { registerEntityCommands } from './commands/entity.js'` and call `registerEntityCommands(program)`.

# 5. QA Contract

**QA-01: entity list — no filter**
Given entities exist in the database, when `mulder entity list` is run, then it outputs a table of entities sorted by name with ID, Name, Type, Status, Source Count columns. Exit code 0.

**QA-02: entity list — type filter**
Given entities of types "person" and "location" exist, when `mulder entity list --type person` is run, then only person entities are returned. Exit code 0.

**QA-03: entity list — search filter**
Given an entity named "Josef Allen Hynek" exists, when `mulder entity list --search hynek` is run, then the entity appears in results (case-insensitive substring match). Exit code 0.

**QA-04: entity list — json output**
When `mulder entity list --json` is run, then stdout contains valid JSON array of entity objects. Exit code 0.

**QA-05: entity show — valid ID**
Given entity with ID exists and has aliases, edges, and linked stories, when `mulder entity show <id>` is run, then it displays entity details, aliases, relationships, and stories. Exit code 0.

**QA-06: entity show — invalid ID**
When `mulder entity show <nonexistent-uuid>` is run, then it prints an error message and exits with code 1.

**QA-07: entity show — json output**
When `mulder entity show <id> --json` is run, then stdout contains valid JSON with `entity`, `aliases`, `edges`, `stories`, `mergedEntities` fields. Exit code 0.

**QA-08: entity merge — success**
Given two distinct canonical entities (no canonical_id set), when `mulder entity merge <id1> <id2>` is run, then id2's story_entities are reassigned to id1, id2's edges are reassigned to id1, id2's aliases are copied to id1, id2's name becomes an alias on id1, and id2 gets `canonical_id = id1` and `taxonomy_status = 'merged'`. Exit code 0.

**QA-09: entity merge — same ID**
When `mulder entity merge <id> <id>` (same ID twice) is run, then it prints a validation error and exits with code 1.

**QA-10: entity merge — already merged entity**
Given entity id2 already has `canonical_id` set, when `mulder entity merge <id1> <id2>` is run, then it prints a validation error and exits with code 1.

**QA-11: entity merge — json output**
When `mulder entity merge <id1> <id2> --json` is run, then stdout contains valid JSON with merge result fields. Exit code 0.

**QA-12: entity aliases — list**
Given entity has aliases, when `mulder entity aliases <entity-id>` is run, then all aliases are displayed. Exit code 0.

**QA-13: entity aliases — add**
When `mulder entity aliases <entity-id> --add "New Alias"` is run, then a new alias is created with source `'manual'` and appears in the output. Exit code 0.

**QA-14: entity aliases — remove**
Given an alias exists, when `mulder entity aliases <entity-id> --remove <alias-id>` is run, then the alias is deleted. Exit code 0.

**QA-15: entity aliases — json output**
When `mulder entity aliases <entity-id> --json` is run, then stdout contains valid JSON array of alias objects. Exit code 0.

# 5b. CLI Test Matrix

| # | Command | Flags | Assertion |
|---|---------|-------|-----------|
| CLI-01 | `entity list` | `--help` | Shows usage with --type, --search, --json options |
| CLI-02 | `entity show` | `--help` | Shows usage with entity-id argument and --json option |
| CLI-03 | `entity merge` | `--help` | Shows usage with id1, id2 arguments and --json option |
| CLI-04 | `entity aliases` | `--help` | Shows usage with entity-id argument and --add, --remove, --json options |
| CLI-05 | `entity` | `--help` | Shows all subcommands: list, show, merge, aliases |
