---
spec: 28
title: Cross-lingual entity resolution — 3-tier
roadmap_step: C7
functional_spec: ["§2.4", "§4.8"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/59
created: 2026-04-03
---

# 28 — Cross-lingual entity resolution — 3-tier

## 1. Objective

Implement a 3-tier cross-lingual entity resolution module that detects when newly extracted entities refer to the same real-world thing as existing entities — across languages, name variants, and documents. The three tiers are:

1. **Attribute match** (deterministic) — exact match on structured identifiers (Wikidata IDs, GPS coordinates, ISO dates)
2. **Embedding similarity** (statistical) — entity name embedding via `text-embedding-004`, cosine similarity above configurable threshold
3. **LLM-assisted** (semantic) — Gemini decides for ambiguous candidate pairs

On match at any tier, the new entity is merged: its `canonical_id` points to the existing entity and its name is added as an alias. This is called during the Enrich step (C8) for every extracted entity, after taxonomy normalization (C6).

## 2. Boundaries

**In scope:**
- `resolveEntity()` function: runs 3-tier resolution against existing entities
- `mergeEntities()` function: sets canonical_id on resolved entity + adds alias
- Tier 1: attribute match queries against `entities.attributes` JSONB
- Tier 2: embedding similarity via pgvector cosine distance on `entities.name_embedding`
- Tier 3: LLM-assisted via Gemini structured output (entity resolution prompt template)
- Migration 017: add `name_embedding vector(768)` column + HNSW index to `entities` table
- Entity repository additions: `findCandidatesByAttributes()`, `findCandidatesByEmbedding()`
- Prompt template: `resolve-entity.jinja2` for Tier 3
- Config-driven: strategies enabled/disabled via `entity_resolution.strategies`
- Dev mode support: fixture-based embedding + LLM via service abstraction

**Out of scope:**
- Full Enrich step integration (C8 wires this in)
- Enrich CLI command `mulder enrich <id>` (C8)
- Taxonomy bootstrap (F1)
- Grounding-provided attributes like Wikidata IDs (G2 — Ground step populates these)
- Deduplication (D5 — Graph step)

**Dependencies:**
- C3: Entity + alias repositories (CRUD) ✅
- C4: Edge repository (not directly used — resolution merges via canonical_id, not edges) ✅
- C6: Taxonomy normalization (runs before resolution) ✅
- B5: Vertex AI wrapper + dev cache (EmbeddingService, LlmService) ✅
- A10: Service abstraction (registry provides services) ✅

## 3. Dependencies

### Requires (must exist before implementation)
- `packages/core/src/database/repositories/entity.repository.ts` — entity CRUD (C3) ✅
- `packages/core/src/database/repositories/entity-alias.repository.ts` — alias CRUD (C3) ✅
- `packages/core/src/shared/services.ts` — EmbeddingService + LlmService interfaces (A10) ✅
- `packages/core/src/prompts/engine.ts` — prompt template engine (B6) ✅
- `packages/core/src/config/schema.ts` — entity_resolution config (A2) ✅

### Produces (created by this spec)
- `packages/core/src/database/migrations/017_entity_name_embedding.sql`
- `packages/pipeline/src/enrich/resolution.ts`
- `packages/pipeline/src/enrich/resolution-types.ts`
- `packages/core/src/prompts/templates/resolve-entity.jinja2`
- Updated: `packages/core/src/database/repositories/entity.repository.ts` (new query functions)
- Updated: `packages/pipeline/src/enrich/index.ts` (barrel exports)

## 4. Blueprint

### 4.1 Migration — `017_entity_name_embedding.sql`

```sql
-- Add name embedding column for Tier 2 entity resolution
ALTER TABLE entities ADD COLUMN name_embedding vector(768);

-- HNSW index for cosine similarity search (same strategy as chunks table)
CREATE INDEX idx_entities_name_embedding ON entities
  USING hnsw (name_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### 4.2 Types — `packages/pipeline/src/enrich/resolution-types.ts`

```typescript
import type { Entity } from '@mulder/core';

/** Which resolution tier produced the match. */
export type ResolutionTier = 'attribute_match' | 'embedding_similarity' | 'llm_assisted';

/** A candidate entity match with its resolution metadata. */
export interface ResolutionCandidate {
  entity: Entity;
  tier: ResolutionTier;
  /** Similarity/confidence score (0-1). */
  score: number;
  /** What matched — attribute name, embedding distance, or LLM reasoning. */
  evidence: string;
}

/** Result of resolving a single entity. */
export interface ResolutionResult {
  /** 'merged' if matched an existing entity, 'new' if no match found. */
  action: 'merged' | 'new';
  /** The canonical entity (existing match or the entity itself). */
  canonicalEntity: Entity;
  /** The resolution candidate if merged, null if new. */
  match: ResolutionCandidate | null;
  /** Tiers that were actually executed (disabled tiers are skipped). */
  tiersExecuted: ResolutionTier[];
}

/** Options passed to resolveEntity(). */
export interface ResolveEntityOptions {
  /** The entity to resolve. Must already exist in the DB. */
  entity: Entity;
  /** PostgreSQL connection pool. */
  pool: import('pg').Pool;
  /** Service registry for embedding + LLM calls. */
  services: import('@mulder/core').Services;
  /** Entity resolution config. */
  config: import('@mulder/core').EntityResolutionConfig;
}
```

### 4.3 Resolution module — `packages/pipeline/src/enrich/resolution.ts`

Main export: `resolveEntity(options: ResolveEntityOptions): Promise<ResolutionResult>`

**Flow:**

```
for each enabled tier in config order:
  1. attribute_match → findCandidatesByAttributes()
  2. embedding_similarity → embed name → findCandidatesByEmbedding()
  3. llm_assisted → take Tier 2 near-misses → Gemini decides
  if candidate found with score above tier threshold:
    → mergeEntities() and return
return { action: 'new' }
```

**Tier 1 — Attribute match:**
- Query `entities` table for same type with matching structured attributes
- Match keys: `wikidata_id`, `geo_point` (within ~100m via PostGIS `ST_DWithin`), `iso_date`
- Only run if the incoming entity has at least one matchable attribute
- Score = 1.0 for exact matches (deterministic)

**Tier 2 — Embedding similarity:**
- Embed entity name via `services.embedding.embed([entity.name])`
- Store embedding in `entities.name_embedding` for the new entity
- Query pgvector: `SELECT * FROM entities WHERE type = $1 AND id != $2 AND name_embedding IS NOT NULL AND 1 - (name_embedding <=> $3) > $4`
- Use threshold from config (`entity_resolution.strategies[1].threshold`, default 0.85)
- Return best candidate above threshold
- Score = cosine similarity

**Tier 3 — LLM-assisted:**
- Only run if Tier 2 found candidates scoring between `threshold * 0.8` and `threshold` (near-misses), OR if explicitly configured to run independently
- If no near-miss candidates from Tier 2, find candidates via name similarity (trigram) as fallback input
- Render `resolve-entity.jinja2` prompt with the entity pair
- Send to Gemini via `services.llm.generateStructured()` with response schema
- Response schema: `{ same_entity: boolean, confidence: number, reasoning: string }`
- If `same_entity && confidence > 0.7` → merge
- Score = LLM confidence

**Merge operation (`mergeEntities`):**
- Set `canonical_id` on the new entity pointing to the matched entity
- Add the new entity's name as an alias on the canonical entity (via `createEntityAlias`)
- Update `source_count` on the canonical entity (increment)
- Log the merge decision with tier, score, and evidence

**Deadlock prevention:**
- When called in batch (multiple entities from one enrichment), the caller (C8) must sort entities lexicographically by `(type, name)` before passing to `resolveEntity()`. The resolution module itself handles one entity at a time.

### 4.4 Prompt template — `resolve-entity.jinja2`

```jinja2
You are an entity resolution expert. Determine whether two entities refer to the same real-world thing.

Entity A:
- Name: {{ entity_a.name }}
- Type: {{ entity_a.type }}
- Attributes: {{ entity_a.attributes }}
{% if entity_a.aliases %}- Known aliases: {{ entity_a.aliases }}{% endif %}

Entity B:
- Name: {{ entity_b.name }}
- Type: {{ entity_b.type }}
- Attributes: {{ entity_b.attributes }}
{% if entity_b.aliases %}- Known aliases: {{ entity_b.aliases }}{% endif %}

Consider:
- Names may be in different languages (e.g., "München" = "Munich")
- Names may be abbreviated or have different transliterations
- Attributes like dates, locations, and identifiers are strong signals
- Same name + different type = different entities

Respond with your assessment.
```

### 4.5 Entity repository additions

Add to `packages/core/src/database/repositories/entity.repository.ts`:

**`findCandidatesByAttributes(pool, entityType, attributes, limit?)`**
- Searches `entities` table for same-type entities with overlapping JSONB attributes
- Uses `attributes @> $2` for exact attribute containment on identifier keys
- For `geo_point`: uses `ST_DWithin(ST_MakePoint((attributes->>'lng')::float, (attributes->>'lat')::float)::geography, ST_MakePoint($lng, $lat)::geography, 100)` (100m radius)
- Returns entities with match details

**`findCandidatesByEmbedding(pool, entityType, embedding, threshold, excludeId, limit?)`**
- Queries pgvector: cosine similarity on `name_embedding` column
- Filters by type, excludes the entity itself
- Returns entities with similarity score above threshold
- Uses `1 - (name_embedding <=> $1)` for cosine similarity (pgvector convention)

**`updateEntityEmbedding(pool, entityId, embedding)`**
- Sets `name_embedding` on an existing entity
- Simple UPDATE query

### 4.6 Barrel exports

Update `packages/pipeline/src/enrich/index.ts`:
```typescript
export { resolveEntity } from './resolution.js';
export type { ResolutionResult, ResolutionCandidate, ResolutionTier, ResolveEntityOptions } from './resolution-types.js';
```

### 4.7 Integration wiring

- `@mulder/pipeline` already depends on `@mulder/core` — no new package.json dependency
- The resolution module uses `@mulder/core` services (EmbeddingService, LlmService) via the passed `services` object — no direct GCP SDK imports
- Dev mode: `services.dev.ts` already provides fixture-based EmbeddingService and LlmService. The resolution module works identically in dev/test.

### 4.8 Config usage

Already defined in `packages/core/src/config/schema.ts`:
```typescript
entity_resolution: {
  strategies: [
    { type: 'attribute_match', enabled: true },
    { type: 'embedding_similarity', enabled: true, threshold: 0.85 },
    { type: 'llm_assisted', enabled: true, model: 'gemini-2.5-flash' },
  ],
  cross_lingual: true,
}
```

The resolution module reads `config.entity_resolution.strategies` to determine which tiers are enabled and their thresholds. A disabled strategy is completely skipped (no API calls, no DB queries).

## 5. QA Contract

All conditions are testable via function calls and SQL against a running PostgreSQL instance with `pgvector` and `pg_trgm` extensions. Tier 2 and Tier 3 use the dev service registry (fixture-based).

### QA-01: Tier 1 — attribute match on Wikidata ID

**Given** entity A `('Munich', 'location', attributes: { wikidata_id: 'Q1726' })` exists in the database
**When** `resolveEntity()` is called for entity B `('München', 'location', attributes: { wikidata_id: 'Q1726' })`
**Then** result is `{ action: 'merged' }` with `match.tier = 'attribute_match'` and `match.score = 1.0`

### QA-02: Tier 1 — attribute match on geo_point proximity

**Given** entity A `('Roswell', 'location', attributes: { geo_point: { lat: 33.3943, lng: -104.5230 } })` exists
**When** `resolveEntity()` is called for entity B `('Roswell NM', 'location', attributes: { geo_point: { lat: 33.3944, lng: -104.5231 } })`
**Then** result is `{ action: 'merged' }` with `match.tier = 'attribute_match'` (within 100m)

### QA-03: Tier 1 — no match when attributes differ

**Given** entity A `('Munich', 'location', attributes: { wikidata_id: 'Q1726' })` exists
**When** `resolveEntity()` is called for entity B `('Munich', 'person', attributes: { wikidata_id: 'Q9999' })`
**Then** Tier 1 does NOT match (different type and different wikidata_id)

### QA-04: Tier 2 — embedding similarity finds candidate above threshold

**Given** entity A `('Josef Allen Hynek', 'person')` exists with a stored `name_embedding`
**When** `resolveEntity()` is called for entity B `('J. Allen Hynek', 'person')` and the embedding service returns vectors with cosine similarity > 0.85
**Then** result is `{ action: 'merged' }` with `match.tier = 'embedding_similarity'`

### QA-05: Tier 2 — embedding similarity rejects candidate below threshold

**Given** entity A `('Josef Allen Hynek', 'person')` exists with a stored `name_embedding`
**When** `resolveEntity()` is called for entity B `('Jacques Vallée', 'person')` and the embedding service returns vectors with cosine similarity < 0.85
**Then** Tier 2 does NOT match (below threshold)

### QA-06: Tier 2 — stores name embedding for new entity

**Given** entity B has no `name_embedding` stored
**When** `resolveEntity()` runs Tier 2 for entity B
**Then** entity B's `name_embedding` column is populated (not null) after resolution

### QA-07: Tier 3 — LLM resolves ambiguous pair

**Given** entity A `('Munich', 'location')` exists, entity B `('Monaco di Baviera', 'location')` is the candidate
**When** Tier 3 runs with the dev LLM service returning `{ same_entity: true, confidence: 0.9, reasoning: '...' }`
**Then** result is `{ action: 'merged' }` with `match.tier = 'llm_assisted'` and `match.score = 0.9`

### QA-08: Merge operation — sets canonical_id and adds alias

**Given** `resolveEntity()` matched entity B to entity A
**Then** entity B's `canonical_id` equals entity A's `id`, AND an alias record exists for entity A with `alias = entity B's name`

### QA-09: Resolution with no match — creates new entity

**Given** no entities exist in the database for the given type
**When** `resolveEntity()` is called for a new entity
**Then** result is `{ action: 'new' }` with `match = null` and the entity's `canonical_id` remains null

### QA-10: Disabled strategy is skipped

**Given** config has `embedding_similarity` strategy with `enabled: false`
**When** `resolveEntity()` is called
**Then** `tiersExecuted` does NOT include `'embedding_similarity'` and no embedding API call is made

### QA-11: All strategies disabled returns new

**Given** config has all three strategies disabled
**When** `resolveEntity()` is called
**Then** result is `{ action: 'new' }` with `tiersExecuted = []`

### QA-12: Migration 017 — name_embedding column exists

**Given** migrations have run through 017
**When** `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'name_embedding'` is executed
**Then** one row is returned

### QA-13: Resolution respects entity type boundary

**Given** entity A `('Phoenix', 'location')` and entity B `('Phoenix', 'organization')` both exist
**When** `resolveEntity()` is called for entity B
**Then** entity A is NOT a candidate (different type — Tier 1 and Tier 2 both filter by type)

## 5b. CLI Test Matrix

N/A — this step has no CLI surface. Resolution is a library module called by the Enrich step (C8).
