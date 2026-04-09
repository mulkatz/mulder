---
spec: 46
title: Taxonomy Bootstrap
roadmap_step: F1
functional_spec: ["6.1", "1"]
also_read: ["6", "5.3"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/109
created: 2026-04-09
---

## 1. Objective

Implement the `mulder taxonomy bootstrap` command that generates an initial taxonomy from all extracted entities using Gemini clustering. This is the first step of the human-in-the-loop taxonomy curation workflow: the system proposes canonical groupings, the user refines them later (F2). Includes `re-bootstrap` (regenerate while preserving confirmed entries) and `show` (inspect current taxonomy tree).

**Spec refs:** §6.1 (bootstrap flow), §1 (taxonomy CLI subtree), §5.3 (sparse graph degradation — taxonomy_bootstrap threshold).

## 2. Boundaries

### In scope
- `mulder taxonomy bootstrap` CLI command with `--min-docs` override
- `mulder taxonomy re-bootstrap` CLI command
- `mulder taxonomy show` CLI command with `--type` filter and `--json` output
- Bootstrap logic in `packages/taxonomy/src/bootstrap.ts`
- Gemini prompt template for entity clustering
- Threshold enforcement (§5.3: `thresholds.taxonomy_bootstrap`, default 25)
- i18n for prompt template (EN + DE)

### Out of scope
- `taxonomy export`, `taxonomy curate`, `taxonomy merge` (F2)
- Entity management CLI (F3)
- Modifications to the enrich step's normalization flow (already works via C6/C8)
- Taxonomy table schema changes (already correct from M3)
- Cross-lingual variant grouping within bootstrap (bootstrap groups by raw names; cross-lingual resolution happens at enrich time via C7)

### Interfaces affected
- **CLI:** New `taxonomy` command group with 3 subcommands
- **Database:** Reads `sources` (count), `entities` (load all). Writes `taxonomy` (upsert entries).
- **GCP:** Gemini structured output via Vertex AI wrapper
- **Config:** Reads `thresholds.taxonomy_bootstrap`, `taxonomy.normalization_threshold`, `vertex`

## 3. Dependencies

### Requires (must exist)
- `packages/core` — config loader, database client, vertex wrapper, prompt engine, error classes, logger
- `packages/taxonomy` — normalize.ts, barrel exports, types
- `packages/core/src/database/repositories/entity.repository.ts` — `findAllEntities()`
- `packages/core/src/database/repositories/taxonomy.repository.ts` — CRUD + `searchTaxonomyBySimilarity()`
- `apps/cli` — Commander.js CLI scaffold with command registration pattern

### Required by (consumers)
- F2 (`taxonomy export/curate/merge`) — operates on taxonomy entries created by bootstrap
- F3 (`entity management`) — entities reference taxonomy via normalization
- Retrieval confidence (`taxonomy_status`) — already reads taxonomy state

## 4. Blueprint

### 4.1 Files to create

#### `packages/taxonomy/src/bootstrap.ts`

Main bootstrap logic. Two exported functions:

```typescript
export interface BootstrapOptions {
  pool: Pool;
  vertexClient: VertexClient;
  config: MulderConfig;
  logger: Logger;
  minDocs?: number;          // Override thresholds.taxonomy_bootstrap
}

export interface BootstrapResult {
  entriesCreated: number;
  entriesUpdated: number;
  typesProcessed: string[];
  skippedTypes: string[];    // Types with all confirmed entries
  corpusSize: number;
}

export async function bootstrapTaxonomy(options: BootstrapOptions): Promise<BootstrapResult>
export async function rebootstrapTaxonomy(options: BootstrapOptions): Promise<BootstrapResult>
```

**`bootstrapTaxonomy` flow:**
1. Count sources with `status` in (`extracted`, `segmented`, `enriched`, `embedded`, `graphed`) — these are "processed documents"
2. Compare against `minDocs ?? config.thresholds.taxonomy_bootstrap`
3. If below threshold: throw `TaxonomyError` with code `TAXONOMY_BELOW_THRESHOLD` including corpus size and threshold
4. Load all entities via `findAllEntities(pool)` (no filter — we want all types)
5. Group entities by `type`
6. For each type group:
   a. Load existing `confirmed` taxonomy entries for this type
   b. If ALL entities in this type already have `confirmed` taxonomy entries → skip (add to `skippedTypes`)
   c. Build entity name list (deduplicated by name within type)
   d. Render prompt from `bootstrap-taxonomy` template with entity names + confirmed entries as context
   e. Call `vertexClient.generateStructured()` with Zod-derived JSON Schema
   f. Parse response: array of `{ canonical, aliases }` clusters
   g. For each cluster: upsert taxonomy entry with `status: 'auto'`, merge aliases
7. Return `BootstrapResult`

**`rebootstrapTaxonomy` flow:**
1. Delete all taxonomy entries with `status = 'auto'` (preserve `confirmed` and `rejected`)
2. Call `bootstrapTaxonomy(options)` — the bootstrap logic already handles confirmed entries as context

**Key decisions:**
- Process each entity type separately (natural batching, prevents token limit issues)
- Confirmed entries are passed to Gemini as context ("these are already confirmed, don't duplicate") but never modified
- Upsert semantics: if an `auto` entry with same `(canonical_name, entity_type)` exists, update aliases
- Entity deduplication: multiple entities with same name only counted once for clustering

#### `packages/taxonomy/src/show.ts`

Display taxonomy tree:

```typescript
export interface ShowOptions {
  pool: Pool;
  typeFilter?: string;
  json?: boolean;
  logger: Logger;
}

export async function showTaxonomy(options: ShowOptions): Promise<void>
```

- Load all taxonomy entries via `findAllTaxonomyEntries(pool, filter)`
- Group by `entityType`
- If `--json`: output structured JSON to stdout
- If text: format as tree with status indicators (confirmed/auto/rejected), alias count

#### `apps/cli/src/commands/taxonomy.ts`

New Commander.js command group:

```
mulder taxonomy bootstrap [--min-docs <n>] [--json]
mulder taxonomy re-bootstrap [--json]
mulder taxonomy show [--type <type>] [--json]
```

Follows existing CLI patterns from `apps/cli/src/commands/enrich.ts`:
- Load config via `loadConfig()`
- Get database pool via registry
- Get vertex client via registry
- Call taxonomy functions
- Format output (table or JSON)

#### `packages/core/src/prompts/templates/bootstrap-taxonomy.jinja2`

Gemini prompt for entity clustering:

```
{{ i18n.bootstrap.system_role }}

## Entity Type: {{ entity_type }}

### Entities to cluster ({{ entity_count }} unique names):
{{ entity_names }}

{% if confirmed_entries %}
### Already confirmed entries (DO NOT duplicate or modify these):
{{ confirmed_entries }}
{% endif %}

{{ i18n.bootstrap.task_description }}

{{ i18n.bootstrap.output_format }}

{{ i18n.common.json_instruction }}
```

#### `packages/core/src/prompts/i18n/en/bootstrap-taxonomy.json`

English i18n strings for the bootstrap prompt.

#### `packages/core/src/prompts/i18n/de/bootstrap-taxonomy.json`

German i18n strings for the bootstrap prompt.

### 4.2 Files to modify

#### `packages/taxonomy/src/index.ts`

Add exports:
```typescript
export { bootstrapTaxonomy, rebootstrapTaxonomy } from './bootstrap.js';
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';
export { showTaxonomy } from './show.js';
export type { ShowOptions } from './show.js';
```

#### `apps/cli/src/index.ts`

Register taxonomy command group (import and `.addCommand()`).

#### `packages/core/src/shared/errors.ts`

Add error code `TAXONOMY_BELOW_THRESHOLD` to TaxonomyError (if not already present — check first).

### 4.3 Gemini structured output schema

Zod schema for bootstrap response (converted via `zod-to-json-schema`):

```typescript
const BootstrapResponseSchema = z.object({
  clusters: z.array(z.object({
    canonical: z.string().describe('The canonical/preferred name for this entity'),
    aliases: z.array(z.string()).describe('Alternative names, abbreviations, misspellings'),
  })).describe('Grouped entity clusters for this type'),
});
```

Note: The spec (§6.1) shows `categories[].members[]` but since we process one type at a time, the response is a flat array of clusters per type. The `type` and `name` (category) fields from §6.1 are implicit from the per-type processing.

### 4.4 Config

No config schema changes needed. Uses existing:
- `config.thresholds.taxonomy_bootstrap` (default: 25)
- `config.taxonomy.normalization_threshold` (default: 0.4)
- `config.vertex` (for Gemini calls)

### 4.5 Database

No migrations needed. Uses existing `taxonomy` and `entities` tables.

New repository function needed in `taxonomy.repository.ts`:
```typescript
export async function deleteAutoTaxonomyEntries(pool: Pool): Promise<number>
```
Deletes all entries with `status = 'auto'`, returns count of deleted rows. Used by re-bootstrap.

### 4.6 Phases

**Phase 1: Core bootstrap logic**
- `bootstrap.ts` — main bootstrap + re-bootstrap functions
- Prompt template + i18n
- `deleteAutoTaxonomyEntries()` repository function
- Error code addition

**Phase 2: Show command**
- `show.ts` — taxonomy display logic

**Phase 3: CLI integration**
- `taxonomy.ts` CLI command group (bootstrap, re-bootstrap, show)
- Wire into CLI entry point

## 5. QA Contract

### QA-01: Threshold enforcement
**Given** a corpus with fewer documents than `thresholds.taxonomy_bootstrap` (default 25),
**When** `mulder taxonomy bootstrap` runs,
**Then** it exits with error code `TAXONOMY_BELOW_THRESHOLD` and a message including the current corpus size and required threshold.

### QA-02: Threshold override
**Given** a corpus with 5 documents and `--min-docs 3`,
**When** `mulder taxonomy bootstrap --min-docs 3` runs,
**Then** bootstrap proceeds (threshold overridden to 3).

### QA-03: Bootstrap creates auto entries
**Given** a corpus at or above threshold with entities in the database,
**When** `mulder taxonomy bootstrap` runs,
**Then** new taxonomy entries are created with `status = 'auto'`, each having a `canonical_name` and `aliases` array.

### QA-04: Bootstrap groups by type
**Given** entities of multiple types (e.g., person, location, organization),
**When** bootstrap runs,
**Then** each type is processed separately and taxonomy entries have the correct `entity_type`.

### QA-05: Confirmed entries preserved
**Given** existing taxonomy entries with `status = 'confirmed'`,
**When** `mulder taxonomy bootstrap` runs,
**Then** confirmed entries are NOT modified or deleted. They are passed to Gemini as context.

### QA-06: Re-bootstrap replaces auto, keeps confirmed
**Given** existing taxonomy with both `auto` and `confirmed` entries,
**When** `mulder taxonomy re-bootstrap` runs,
**Then** all `auto` entries are deleted before re-running bootstrap. `Confirmed` entries remain unchanged.

### QA-07: Show displays taxonomy
**Given** taxonomy entries exist in the database,
**When** `mulder taxonomy show` runs,
**Then** output shows entries grouped by type with status indicators and alias lists.

### QA-08: Show with --json
**Given** taxonomy entries exist,
**When** `mulder taxonomy show --json` runs,
**Then** output is valid JSON with entries grouped by type.

### QA-09: Show with --type filter
**Given** taxonomy entries of multiple types exist,
**When** `mulder taxonomy show --type person` runs,
**Then** only entries of type `person` are shown.

### QA-10: Bootstrap idempotency
**Given** bootstrap has already run successfully,
**When** bootstrap runs again,
**Then** existing `auto` entries are updated (upsert), not duplicated. Entry count does not grow unboundedly.

## 5b. CLI Test Matrix

| ID | Command | Flags | Expected |
|----|---------|-------|----------|
| CLI-01 | `mulder taxonomy bootstrap` | `--help` | Shows usage with --min-docs flag |
| CLI-02 | `mulder taxonomy bootstrap` | (no flags, < threshold docs) | Error with threshold message |
| CLI-03 | `mulder taxonomy bootstrap` | `--min-docs 3` | Proceeds with override |
| CLI-04 | `mulder taxonomy bootstrap` | `--json` | JSON output of results |
| CLI-05 | `mulder taxonomy re-bootstrap` | `--help` | Shows usage |
| CLI-06 | `mulder taxonomy show` | `--help` | Shows usage |
| CLI-07 | `mulder taxonomy show` | (no flags) | Formatted tree output |
| CLI-08 | `mulder taxonomy show` | `--type person` | Filtered by type |
| CLI-09 | `mulder taxonomy show` | `--json` | Valid JSON output |
