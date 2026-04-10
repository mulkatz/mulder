---
spec: 50
title: Taxonomy Export/Curate/Merge
roadmap_step: F2
functional_spec: ["6.3", "1"]
also_read: ["6", "5.3"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/131
created: 2026-04-10
---

## 1. Objective

Implement the human-in-the-loop taxonomy curation workflow: `mulder taxonomy export` dumps the current taxonomy to a YAML file, the user edits it (rename, merge, confirm, reject entries), and `mulder taxonomy merge` applies the curated changes back to the database. Also adds `mulder taxonomy curate` which opens the curated file in `$EDITOR` for convenience.

This completes the taxonomy curation cycle started by F1 (bootstrap). Bootstrap proposes machine-generated groupings with `status: auto`; this step lets the human refine them.

**Spec refs:** §6.3 (curation workflow), §1 (taxonomy CLI subtree — `export`, `curate`, `merge`).

## 2. Boundaries

### In scope
- `mulder taxonomy export` — export taxonomy to YAML (stdout or file via `--output`)
- `mulder taxonomy curate` — open `taxonomy.curated.yaml` in `$EDITOR` (creates it via export if missing)
- `mulder taxonomy merge` — merge curated YAML into the database
- Export logic in `packages/taxonomy/src/export.ts`
- Merge logic in `packages/taxonomy/src/merge.ts`
- Zod validation schema for the curated YAML format
- Merge report (created/updated/deleted/unchanged counts + detail)
- `--dry-run` flag on merge to preview changes without applying

### Out of scope
- Entity management CLI (F3)
- Status overview (F4)
- Export commands for graph/stories/evidence (F5)
- Taxonomy table schema changes (current schema is sufficient)
- Multilingual `variants` field in YAML (§6.3 shows this for locations — deferred until the schema supports it; for now, cross-lingual aliases are flat in the `aliases` array)
- `wikidata` or external ID fields (future enrichment, not in current schema)

### Interfaces affected
- **CLI:** Three new subcommands under `mulder taxonomy`
- **Database:** Reads + writes `taxonomy` table (no schema changes)
- **Filesystem:** Reads/writes `taxonomy.curated.yaml` relative to config directory

## 3. Dependencies

### Requires (must exist)
- `packages/core` — config loader, database client, error classes, logger
- `packages/core/src/database/repositories/taxonomy.repository.ts` — CRUD operations
- `packages/taxonomy` — barrel exports, types
- `apps/cli/src/commands/taxonomy.ts` — existing taxonomy command group (F1)

### Required by (consumers)
- F3 (`entity management`) — users curate taxonomy before managing entities
- M10+ (production workflows) — taxonomy curation is prerequisite for reliable entity normalization

## 4. Blueprint

### 4.1 Files to create

#### `packages/taxonomy/src/export.ts`

Export taxonomy entries to the curated YAML format.

```typescript
export interface ExportOptions {
  pool: Pool;
  typeFilter?: string;
  logger: Logger;
}

export interface ExportResult {
  yaml: string;           // The rendered YAML content
  totalEntries: number;
  typeBreakdown: Record<string, number>;
}

export async function exportTaxonomy(options: ExportOptions): Promise<ExportResult>
```

**Flow:**
1. Load all taxonomy entries via `findAllTaxonomyEntries(pool)` (no pagination limit — export needs everything)
2. If `typeFilter` set, filter by entity type
3. Group entries by `entityType`
4. For each group, sort by: `confirmed` first, then `auto`, then `rejected`; within each status, alphabetical by `canonicalName`
5. Render as YAML using the curated format (see §4.3)
6. Return the YAML string and stats

**YAML output format** (one document, entries grouped by entity type):

```yaml
# Mulder Taxonomy — exported YYYY-MM-DDTHH:MM:SSZ
# Edit entries: change status, rename canonicals, add/remove aliases.
# Then run `mulder taxonomy merge` to apply changes.
#
# Status values: confirmed | auto | rejected
# - confirmed: human-verified, bootstrap won't touch these
# - auto: machine-generated, may be replaced by re-bootstrap
# - rejected: hidden from normalization, preserved for reference

person:
  - id: "550e8400-e29b-41d4-a716-446655440000"
    canonical: "Josef Allen Hynek"
    status: confirmed
    aliases:
      - "J. Allen Hynek"
      - "Dr. Hynek"
  - id: "550e8400-e29b-41d4-a716-446655440001"
    canonical: "Jacques Vallée"
    status: auto
    aliases:
      - "Vallee"

location:
  - id: "550e8400-e29b-41d4-a716-446655440002"
    canonical: "Roswell, New Mexico"
    status: confirmed
    category: "historical"
    aliases:
      - "Roswell"
      - "Roswell NM"
```

**Key decisions:**
- `id` is always included — it's the anchor for merge (enables renames without data loss)
- `category` is included only when non-null (keeps YAML clean)
- The comment header is always emitted (timestamp + instructions)
- Use `js-yaml` for serialization (already a dependency via config loader)

#### `packages/taxonomy/src/merge.ts`

Merge curated YAML changes back into the taxonomy table.

```typescript
export interface MergeOptions {
  pool: Pool;
  yamlContent: string;    // Raw YAML string
  dryRun?: boolean;
  logger: Logger;
}

export interface MergeChange {
  action: 'created' | 'updated' | 'deleted' | 'unchanged';
  entityType: string;
  canonicalName: string;
  id?: string;
  details?: string;       // What changed (e.g., "status: auto → confirmed")
}

export interface MergeResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  changes: MergeChange[];
  errors: string[];
}

export async function mergeTaxonomy(options: MergeOptions): Promise<MergeResult>
```

**Flow:**
1. Parse YAML string, validate against `CuratedTaxonomySchema` (Zod)
2. Load all current taxonomy entries from database
3. Build lookup maps: `byId` (for entries with `id` field) and `byNameType` (fallback)
4. For each entry in the curated YAML:
   a. **Has `id`:** look up by ID in database
      - Found: compare fields, update if changed
      - Not found: warn (ID referenced in YAML doesn't exist) — skip, add to errors
   b. **No `id`:** look up by `(canonical, entityType)` in database
      - Found: update if changed
      - Not found: create new entry
5. **Deletion detection:** entries in the database that are NOT in the curated YAML are candidates for deletion
   - Only delete entries whose `entityType` appears in the YAML (don't delete types the user didn't export)
   - Mark as deleted (actually DELETE from table — rejected entries should be kept with `status: rejected`, not deleted)
   - Exception: if the user removed an entry from YAML entirely, it means "delete this entry"
6. If `dryRun`: return the changes without executing any writes
7. Execute all writes in a transaction
8. Return `MergeResult` with detailed change log

**Merge semantics:**
- Rename detection: if an entry with known `id` has a different `canonical` in YAML → rename (update `canonical_name`)
- Status changes: `auto → confirmed`, `auto → rejected`, `confirmed → rejected`, etc. — all allowed
- Alias changes: YAML aliases replace the database aliases entirely (not additive)
- Category changes: updated if different
- New entries (no `id`): created with the specified status (default `confirmed` for manual additions)
- Removed entries: entries present in DB for types that appear in YAML but missing from YAML are deleted
- Duplicate detection: if YAML has two entries with same `(canonical, entityType)`, error

**Transaction discipline:**
- All changes in a single transaction (BEGIN/COMMIT)
- If any write fails, rollback everything and report

#### `packages/taxonomy/src/curated-schema.ts`

Zod schema for validating the curated YAML format.

```typescript
import { z } from 'zod';

const CuratedEntrySchema = z.object({
  id: z.string().uuid().optional(),
  canonical: z.string().min(1),
  status: z.enum(['confirmed', 'auto', 'rejected']).default('confirmed'),
  category: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});

export const CuratedTaxonomySchema = z.record(
  z.string(),                          // entity type as key
  z.array(CuratedEntrySchema),         // entries as values
);

export type CuratedEntry = z.infer<typeof CuratedEntrySchema>;
export type CuratedTaxonomy = z.infer<typeof CuratedTaxonomySchema>;
```

### 4.2 Files to modify

#### `packages/taxonomy/src/index.ts`

Add exports:
```typescript
export { exportTaxonomy } from './export.js';
export type { ExportOptions, ExportResult } from './export.js';
export { mergeTaxonomy } from './merge.js';
export type { MergeChange, MergeOptions, MergeResult } from './merge.js';
export type { CuratedEntry, CuratedTaxonomy } from './curated-schema.js';
export { CuratedTaxonomySchema } from './curated-schema.js';
```

#### `apps/cli/src/commands/taxonomy.ts`

Add three new subcommands to the existing taxonomy command group:

**`export`:**
```
mulder taxonomy export [--output <path>] [--type <type>]
```
- If `--output`: write to file, print path to stderr
- If no `--output`: write to stdout (pipeable: `mulder taxonomy export > taxonomy.curated.yaml`)
- `--type`: filter to a single entity type

**`curate`:**
```
mulder taxonomy curate
```
- If `taxonomy.curated.yaml` doesn't exist: run export to create it
- Open in `$EDITOR` (fall back to `vi`)
- After editor closes: prompt "Run merge now? [y/N]"
- If yes: run merge with dry-run preview first

**`merge`:**
```
mulder taxonomy merge [--input <path>] [--dry-run]
```
- If `--input`: read from specified path
- Default: read `taxonomy.curated.yaml` from config directory
- `--dry-run`: show what would change without applying
- Show summary table: created/updated/deleted/unchanged
- Show detailed change log for non-unchanged entries

#### `packages/core/src/database/repositories/taxonomy.repository.ts`

Add new function for loading all entries without pagination (for export):

```typescript
export async function findAllTaxonomyEntriesUnpaginated(pool: pg.Pool): Promise<TaxonomyEntry[]>
```

Returns all taxonomy entries ordered by `entity_type ASC, canonical_name ASC`. No limit/offset — export needs the full set.

Also add a transaction-wrapped batch update function:

```typescript
export async function applyTaxonomyChanges(
  pool: pg.Pool,
  changes: {
    creates: CreateTaxonomyEntryInput[];
    updates: Array<{ id: string; input: UpdateTaxonomyEntryInput }>;
    deletes: string[];  // IDs to delete
  },
): Promise<void>
```

Executes all changes in a single transaction. Throws `DatabaseError` on failure (auto-rollback).

### 4.3 YAML Format Specification

The curated YAML is a mapping of entity type names to arrays of entries:

```yaml
{entity_type}:
  - id: {uuid}              # Optional. Present on export, absent for new manual entries.
    canonical: {string}       # Required. The canonical/preferred name.
    status: {string}         # Optional. Default: "confirmed". Values: confirmed|auto|rejected.
    category: {string}       # Optional. Grouping category within the type.
    aliases:                 # Optional. Default: []. Alternative names.
      - {string}
```

**Validation rules (enforced by Zod schema):**
- Top-level keys must be non-empty strings (entity types)
- Each entry array must contain at least one entry
- `canonical` is required and non-empty
- `id`, if present, must be a valid UUID
- `status` must be one of `confirmed`, `auto`, `rejected`
- `aliases` must be an array of strings
- No duplicate `(canonical, entityType)` pairs within the file

### 4.4 Config

No config schema changes needed. The curated YAML file path is resolved relative to the config file location (same directory as `mulder.config.yaml`). Default filename: `taxonomy.curated.yaml`.

### 4.5 Database

No migrations needed. Uses existing `taxonomy` table and repository functions, plus two new repository functions (§4.2).

### 4.6 Phases

**Phase 1: Schema + export logic**
- `curated-schema.ts` — Zod schema for YAML format
- `export.ts` — export function
- `findAllTaxonomyEntriesUnpaginated()` repository function
- Barrel exports

**Phase 2: Merge logic**
- `merge.ts` — merge function with diff, validation, transaction
- `applyTaxonomyChanges()` repository function

**Phase 3: CLI integration**
- Add `export`, `curate`, `merge` subcommands to taxonomy CLI
- Wire into existing command group

## 5. QA Contract

### QA-01: Export produces valid YAML
**Given** taxonomy entries exist in the database,
**When** `mulder taxonomy export` runs,
**Then** stdout contains valid YAML that parses without error, entries are grouped by entity type, and each entry includes `id`, `canonical`, `status`, and `aliases`.

### QA-02: Export includes all entries
**Given** taxonomy entries of types `person`, `location`, and `organization` exist,
**When** `mulder taxonomy export` runs,
**Then** all three types appear as top-level keys, and all entries are included.

### QA-03: Export with --type filter
**Given** taxonomy entries of multiple types exist,
**When** `mulder taxonomy export --type person` runs,
**Then** only `person` entries appear in the output.

### QA-04: Export with --output writes to file
**Given** taxonomy entries exist,
**When** `mulder taxonomy export --output taxonomy.curated.yaml` runs,
**Then** the file `taxonomy.curated.yaml` is created with the same content as stdout export.

### QA-05: Export round-trips through merge unchanged
**Given** taxonomy entries exist,
**When** export is run, then merge is run on the exported file without edits,
**Then** merge reports 0 created, 0 updated, 0 deleted, N unchanged (all entries).

### QA-06: Merge creates new entries
**Given** a curated YAML with an entry that has no `id` and doesn't match any existing entry,
**When** `mulder taxonomy merge` runs,
**Then** a new taxonomy entry is created with the specified canonical name, status, and aliases.

### QA-07: Merge updates status
**Given** a curated YAML where an existing `auto` entry has been changed to `status: confirmed`,
**When** `mulder taxonomy merge` runs,
**Then** the database entry's status is updated to `confirmed`.

### QA-08: Merge renames canonical name
**Given** a curated YAML where an entry's `id` is preserved but `canonical` has changed,
**When** `mulder taxonomy merge` runs,
**Then** the database entry's `canonical_name` is updated to the new value.

### QA-09: Merge updates aliases
**Given** a curated YAML where an entry's `aliases` array has changed,
**When** `mulder taxonomy merge` runs,
**Then** the database entry's aliases are replaced with the YAML values (not merged).

### QA-10: Merge deletes removed entries
**Given** a curated YAML with type `person` that has 3 entries, but the database has 5 `person` entries,
**When** `mulder taxonomy merge` runs,
**Then** the 2 entries not present in the YAML are deleted from the database.

### QA-11: Merge does not delete entries of unexported types
**Given** a curated YAML that only contains `person` entries, but the database also has `location` entries,
**When** `mulder taxonomy merge` runs,
**Then** `location` entries are NOT deleted (only types present in the YAML are affected).

### QA-12: Merge --dry-run shows changes without applying
**Given** a curated YAML with modifications,
**When** `mulder taxonomy merge --dry-run` runs,
**Then** the output shows what would change, but the database is not modified.

### QA-13: Merge validates YAML structure
**Given** a curated YAML with invalid structure (e.g., missing `canonical` field),
**When** `mulder taxonomy merge` runs,
**Then** it exits with a validation error describing the issue, and the database is not modified.

### QA-14: Merge is transactional
**Given** a curated YAML with valid changes and one entry that would cause a constraint violation,
**When** `mulder taxonomy merge` runs,
**Then** no changes are applied (all-or-nothing), and the error is reported.

### QA-15: Merge detects duplicate entries
**Given** a curated YAML with two entries having the same `canonical` and entity type,
**When** `mulder taxonomy merge` runs,
**Then** it exits with a validation error about duplicates.

## 5b. CLI Test Matrix

| ID | Command | Flags | Expected |
|----|---------|-------|----------|
| CLI-01 | `mulder taxonomy export` | `--help` | Shows usage with --output, --type flags |
| CLI-02 | `mulder taxonomy export` | (no flags) | YAML to stdout |
| CLI-03 | `mulder taxonomy export` | `--type person` | Filtered output |
| CLI-04 | `mulder taxonomy export` | `--output taxonomy.curated.yaml` | Writes to file |
| CLI-05 | `mulder taxonomy merge` | `--help` | Shows usage with --input, --dry-run flags |
| CLI-06 | `mulder taxonomy merge` | `--dry-run` | Preview without changes |
| CLI-07 | `mulder taxonomy merge` | `--input custom.yaml` | Reads from custom path |
| CLI-08 | `mulder taxonomy curate` | `--help` | Shows usage |
