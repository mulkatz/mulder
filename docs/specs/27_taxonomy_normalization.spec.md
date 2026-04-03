---
spec: 27
title: Taxonomy normalization — pg_trgm matching
roadmap_step: C6
functional_spec: ["§6.2", "§2.4"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/57
created: 2026-04-03
---

# 27 — Taxonomy normalization — `pg_trgm` matching

## 1. Objective

Provide taxonomy repository CRUD operations and a normalization function that matches entity names against the `taxonomy` table using PostgreSQL trigram similarity (`pg_trgm`). This is the inline normalization layer called during the Enrich step (C8) — for each extracted entity, it finds the best taxonomy match or creates a new `auto` entry.

The normalization function is the bridge between raw Gemini-extracted entity names and the curated taxonomy. It ensures every entity gets a `canonical_id` pointing to its taxonomy entry, and adds discovered name variants as aliases.

## 2. Boundaries

**In scope:**
- Taxonomy repository: full CRUD for the `taxonomy` table (create, read, update, delete, search)
- Trigram similarity search: `pg_trgm` `similarity()` function with configurable threshold
- `normalizeTaxonomy()` function: match entity name+type against taxonomy, return match or create new entry
- Taxonomy types (TypeScript interfaces for taxonomy records)
- Config addition: `taxonomy.normalization_threshold` (default: 0.4)
- Barrel exports from `@mulder/core` (repository) and `@mulder/taxonomy` (normalize function)

**Out of scope:**
- Taxonomy bootstrap (C6 does not generate taxonomy from corpus — that's F1)
- Taxonomy export/curate/merge (F2)
- Cross-lingual entity resolution (C7 — separate 3-tier strategy)
- The Enrich step itself (C8 — calls `normalizeTaxonomy()` but is a separate step)
- CLI commands for taxonomy management (F1-F3)
- Aliases table for taxonomy entries (taxonomy.aliases column already exists as TEXT[])

**CLI surface:** None — this is a library-only step. No new CLI commands.

## 3. Dependencies

### Requires (must exist)
- A7: Core schema migrations — `taxonomy` table (007_taxonomy.sql), `pg_trgm` extension (001_extensions.sql), GIN indexes (008_indexes.sql)
- A10: Service abstraction — database pool access via registry
- C3: Entity + alias repositories — entity types used by normalize function

### Required by
- C7: Cross-lingual entity resolution — uses taxonomy repository for lookups
- C8: Enrich step — calls `normalizeTaxonomy()` inline during entity extraction
- F1-F3: Taxonomy CLI commands — use taxonomy repository for CRUD

## 4. Blueprint

### 4.1 Taxonomy types

**File:** `packages/core/src/database/repositories/taxonomy.types.ts`

```typescript
/** Taxonomy entry status. */
export type TaxonomyEntryStatus = 'auto' | 'confirmed' | 'rejected';

/** A taxonomy record from the database. */
export interface TaxonomyEntry {
  id: string;
  canonicalName: string;
  entityType: string;
  category: string | null;
  status: TaxonomyEntryStatus;
  aliases: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a taxonomy entry. */
export interface CreateTaxonomyEntryInput {
  canonicalName: string;
  entityType: string;
  category?: string;
  status?: TaxonomyEntryStatus;
  aliases?: string[];
}

/** Input for updating a taxonomy entry. Partial. */
export interface UpdateTaxonomyEntryInput {
  canonicalName?: string;
  entityType?: string;
  category?: string | null;
  status?: TaxonomyEntryStatus;
  aliases?: string[];
}

/** Filter for querying taxonomy entries. */
export interface TaxonomyFilter {
  entityType?: string;
  status?: TaxonomyEntryStatus;
  limit?: number;
  offset?: number;
}

/** Result of a trigram similarity search. */
export interface TaxonomySimilarityMatch {
  entry: TaxonomyEntry;
  similarity: number;
}

/** Result of taxonomy normalization for a single entity. */
export interface NormalizationResult {
  /** The matched or newly created taxonomy entry. */
  taxonomyEntry: TaxonomyEntry;
  /** Whether this was an existing match or a new entry. */
  action: 'matched' | 'created';
  /** Trigram similarity score (0-1) if matched, null if created. */
  similarity: number | null;
}
```

### 4.2 Taxonomy repository

**File:** `packages/core/src/database/repositories/taxonomy.repository.ts`

Same pattern as `entity.repository.ts` — plain functions, `pg.Pool` as first argument, parameterized SQL, idempotent via `ON CONFLICT`.

**Functions:**
- `createTaxonomyEntry(pool, input)` — INSERT with `ON CONFLICT (canonical_name, entity_type) DO UPDATE`
- `findTaxonomyEntryById(pool, id)` — SELECT by UUID
- `findTaxonomyEntryByName(pool, canonicalName, entityType)` — exact match lookup
- `findAllTaxonomyEntries(pool, filter?)` — filtered list with pagination
- `countTaxonomyEntries(pool, filter?)` — count with same filters
- `updateTaxonomyEntry(pool, id, input)` — partial update
- `deleteTaxonomyEntry(pool, id)` — delete by ID
- `searchTaxonomyBySimilarity(pool, name, entityType, threshold)` — trigram search, returns `TaxonomySimilarityMatch[]` sorted by similarity DESC

**Trigram search SQL:**
```sql
SELECT *, similarity(canonical_name, $1) AS sim
FROM taxonomy
WHERE entity_type = $2
  AND status != 'rejected'
  AND similarity(canonical_name, $1) >= $3
ORDER BY sim DESC
LIMIT 5
```

Also search aliases array:
```sql
-- Check if any alias matches via unnest + similarity
SELECT t.*, greatest(
  similarity(t.canonical_name, $1),
  (SELECT COALESCE(max(similarity(a, $1)), 0) FROM unnest(t.aliases) AS a)
) AS sim
FROM taxonomy t
WHERE t.entity_type = $2
  AND t.status != 'rejected'
  AND (
    similarity(t.canonical_name, $1) >= $3
    OR EXISTS (
      SELECT 1 FROM unnest(t.aliases) AS a
      WHERE similarity(a, $1) >= $3
    )
  )
ORDER BY sim DESC
LIMIT 5
```

### 4.3 Normalize function

**File:** `packages/taxonomy/src/normalize.ts`

```typescript
export async function normalizeTaxonomy(
  pool: pg.Pool,
  entityName: string,
  entityType: string,
  threshold: number,
): Promise<NormalizationResult>
```

**Logic (per §6.2):**
1. Search taxonomy by trigram similarity for the given name + type
2. If best match has similarity >= threshold:
   - If status is `confirmed`: assign but do NOT modify the entry
   - If status is `auto`: assign and add entity name as alias if not already present
   - Return `{ action: 'matched', taxonomyEntry, similarity }`
3. If no match >= threshold:
   - Create new taxonomy entry with `status: 'auto'`, entity name as canonical_name
   - Add the entity name to aliases array
   - Return `{ action: 'created', taxonomyEntry, similarity: null }`

### 4.4 Config addition

**File:** `packages/core/src/config/schema.ts` + `defaults.ts`

Add a `taxonomy` config section:

```typescript
// schema.ts
const taxonomyObj = z.object({
  normalization_threshold: z.number().min(0).max(1).default(0.4),
});
const taxonomySchema = taxonomyObj.default(defaults(taxonomyObj));

// In MulderConfigSchema:
taxonomy: taxonomySchema,
```

```typescript
// defaults.ts
taxonomy: {
  normalization_threshold: 0.4,
},
```

The threshold of 0.4 is appropriate for trigram similarity — trigram scores are lower than embedding cosine similarity. "J. Allen Hynek" vs "Josef Allen Hynek" scores ~0.35-0.45 with trigrams. A threshold of 0.4 catches common name variants while avoiding false matches.

### 4.5 Barrel exports

**Update `packages/core/src/database/repositories/index.ts`:**
- Export all taxonomy repository functions and types

**Update `packages/taxonomy/src/index.ts`:**
- Export `normalizeTaxonomy` from normalize.ts
- Export taxonomy types re-exported from core

### 4.6 File summary

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/database/repositories/taxonomy.types.ts` | Create | TypeScript types for taxonomy records |
| `packages/core/src/database/repositories/taxonomy.repository.ts` | Create | CRUD + trigram search for taxonomy table |
| `packages/core/src/database/repositories/index.ts` | Modify | Add taxonomy exports |
| `packages/core/src/config/schema.ts` | Modify | Add `taxonomy` config section |
| `packages/core/src/config/defaults.ts` | Modify | Add taxonomy defaults |
| `packages/taxonomy/src/types.ts` | Create | Re-export types if needed for taxonomy package |
| `packages/taxonomy/src/normalize.ts` | Create | Normalization function |
| `packages/taxonomy/src/index.ts` | Modify | Export normalize + types |

## 5. QA Contract

All conditions are testable via SQL and function calls against a running PostgreSQL instance with `pg_trgm` enabled.

### QA-01: Taxonomy CRUD — create and read

**Given** a running PostgreSQL with the taxonomy table and `pg_trgm` extension
**When** `createTaxonomyEntry(pool, { canonicalName: 'Josef Allen Hynek', entityType: 'person' })` is called
**Then** a taxonomy entry exists with `status = 'auto'`, `canonical_name = 'Josef Allen Hynek'`, `entity_type = 'person'`

### QA-02: Taxonomy CRUD — idempotent upsert

**Given** a taxonomy entry `('Josef Allen Hynek', 'person')` already exists
**When** `createTaxonomyEntry(pool, { canonicalName: 'Josef Allen Hynek', entityType: 'person', aliases: ['Hynek'] })` is called
**Then** only one row exists for that name+type combination (no duplicate), and the entry is returned

### QA-03: Taxonomy CRUD — update entry

**Given** a taxonomy entry exists with `status = 'auto'`
**When** `updateTaxonomyEntry(pool, id, { status: 'confirmed' })` is called
**Then** the entry's status is `confirmed` and `updated_at` is bumped

### QA-04: Taxonomy CRUD — delete entry

**Given** a taxonomy entry exists
**When** `deleteTaxonomyEntry(pool, id)` is called
**Then** the entry no longer exists in the database

### QA-05: Trigram search — finds similar names

**Given** taxonomy entries: `('Josef Allen Hynek', 'person')`, `('Jacques Vallée', 'person')`, `('Roswell', 'location')`
**When** `searchTaxonomyBySimilarity(pool, 'J. Allen Hynek', 'person', 0.3)` is called
**Then** results include `'Josef Allen Hynek'` with a similarity score > 0.3, and do NOT include `'Roswell'` (wrong type) or entries below threshold

### QA-06: Trigram search — matches aliases

**Given** a taxonomy entry `('Munich', 'location', aliases: ['München', 'Monaco di Baviera'])`
**When** `searchTaxonomyBySimilarity(pool, 'München', 'location', 0.3)` is called
**Then** results include `'Munich'` matched via alias with similarity > 0.3

### QA-07: Trigram search — excludes rejected entries

**Given** a taxonomy entry with `status = 'rejected'`
**When** any `searchTaxonomyBySimilarity` call would otherwise match it
**Then** the rejected entry is NOT included in results

### QA-08: Normalize — matches existing taxonomy entry

**Given** taxonomy entry `('Josef Allen Hynek', 'person', status: 'auto')`
**When** `normalizeTaxonomy(pool, 'J. Allen Hynek', 'person', 0.3)` is called
**Then** returns `{ action: 'matched', similarity: <number >= 0.3> }` with the Hynek taxonomy entry

### QA-09: Normalize — creates new entry when no match

**Given** an empty taxonomy table
**When** `normalizeTaxonomy(pool, 'Bob Lazar', 'person', 0.4)` is called
**Then** returns `{ action: 'created', similarity: null }` and a new taxonomy entry exists with `canonical_name = 'Bob Lazar'`, `entity_type = 'person'`, `status = 'auto'`

### QA-10: Normalize — does not modify confirmed entries

**Given** taxonomy entry `('Josef Allen Hynek', 'person', status: 'confirmed', aliases: ['Hynek'])`
**When** `normalizeTaxonomy(pool, 'Dr. J. Allen Hynek', 'person', 0.3)` is called and matches
**Then** the taxonomy entry's aliases array is NOT modified (still only `['Hynek']`), and the match is returned

### QA-11: Normalize — adds alias to auto entries on match

**Given** taxonomy entry `('Josef Allen Hynek', 'person', status: 'auto', aliases: [])`
**When** `normalizeTaxonomy(pool, 'J. Allen Hynek', 'person', 0.3)` is called and matches
**Then** the taxonomy entry's aliases array now includes `'J. Allen Hynek'`

### QA-12: Config — taxonomy normalization_threshold accessible

**Given** a valid `mulder.config.yaml` with no `taxonomy` section
**When** config is loaded
**Then** `config.taxonomy.normalization_threshold` equals `0.4` (default)

### QA-13: Taxonomy filter — by entity type

**Given** taxonomy entries for types `person`, `location`, `organization`
**When** `findAllTaxonomyEntries(pool, { entityType: 'person' })` is called
**Then** only `person` entries are returned

### QA-14: Taxonomy filter — by status

**Given** taxonomy entries with status `auto`, `confirmed`, `rejected`
**When** `findAllTaxonomyEntries(pool, { status: 'confirmed' })` is called
**Then** only `confirmed` entries are returned

## 5b. CLI Test Matrix

N/A — this step has no CLI surface.
