---
spec: "54"
title: "v2.0 Schema Migrations (009-011)"
roadmap_step: M6-G1
functional_spec: ["§4.3"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/139"
created: 2026-04-11
---

# Spec 54: v2.0 Schema Migrations (009-011)

## 1. Objective

Add the reserved v2.0 database migrations that extend Mulder's existing schema with persistence for web grounding, evidence-chain analysis, and spatio-temporal clustering. Per `§4.3`, this step creates the `entity_grounding`, `evidence_chains`, and `spatio_temporal_clusters` tables and adds the PostGIS-backed `entities.geom` column required by later M6 Ground and Analyze work.

## 2. Boundaries

- **Roadmap Step:** `M6-G1` — v2.0 schema migrations (009-011)
- **Target:** `packages/core/src/database/migrations/009_entity_grounding.sql`, `packages/core/src/database/migrations/010_evidence_chains.sql`, `packages/core/src/database/migrations/011_spatio_temporal_clusters.sql`
- **In scope:** forward-only SQL migrations for the three v2.0 tables, the `entities.geom` geospatial column, and the GIST index required for spatial queries
- **Out of scope:** Ground CLI and repository logic (`M6-G2`), Analyze sub-steps (`M6-G3` to `M6-G7`), any TypeScript repositories or services, config-schema changes, and data backfill for existing entities
- **Constraints:** preserve the reserved `009-011` numbering gap, keep the work schema-only unless a migration-runner defect blocks backfilled application, and match the `§4.3` DDL exactly where it is specified

## 3. Dependencies

- **Requires:** Spec 07 (`M1-A6`) database client + migration runner, Spec 08 (`M1-A7`) core schema migrations, and Spec 09 (`M1-A8`) because `012-018` already exist after this reserved gap
- **Blocks:** `M6-G2` Ground step, `M6-G5` Evidence chains, and `M6-G6` Spatio-temporal clustering

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/database/migrations/009_entity_grounding.sql`** — creates the `entity_grounding` cache table for grounded entity data, source URLs, grounding timestamps, and TTL expiry, with a foreign key to `entities(id)` using `ON DELETE CASCADE`
2. **`packages/core/src/database/migrations/010_evidence_chains.sql`** — creates the `evidence_chains` table used by Analyze to persist thesis text, UUID path arrays, support direction, strength, and computation time
3. **`packages/core/src/database/migrations/011_spatio_temporal_clusters.sql`** — creates the `spatio_temporal_clusters` table and adds the PostGIS `geom geometry(Point, 4326)` column plus `idx_entities_geom` GIST index on `entities`

### 4.2 Database Changes

```sql
-- 009_entity_grounding.sql
CREATE TABLE entity_grounding (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  grounding_data  JSONB NOT NULL,
  source_urls     TEXT[],
  grounded_at     TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

-- 010_evidence_chains.sql
CREATE TABLE evidence_chains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis          TEXT NOT NULL,
  path            UUID[] NOT NULL,
  strength        FLOAT NOT NULL,
  supports        BOOLEAN NOT NULL,
  computed_at     TIMESTAMPTZ DEFAULT now()
);

-- 011_spatio_temporal_clusters.sql
CREATE TABLE spatio_temporal_clusters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_lat      FLOAT,
  center_lng      FLOAT,
  time_start      TIMESTAMPTZ,
  time_end        TIMESTAMPTZ,
  event_count     INTEGER NOT NULL,
  event_ids       UUID[] NOT NULL,
  cluster_type    TEXT,
  computed_at     TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE entities ADD COLUMN geom geometry(Point, 4326);
CREATE INDEX idx_entities_geom ON entities USING GIST(geom);
```

### 4.3 Config Changes

None.

### 4.4 Integration Points

- `runMigrations()` and `getMigrationStatus()` must discover and apply the new `009-011` files without disturbing already-applied `012-018` migrations
- Future Ground and Analyze repositories may assume these tables exist after `mulder db migrate`
- Spatial analysis code in later M6 specs will write/query `entities.geom` through PostGIS functions such as `ST_DWithin`

### 4.5 Implementation Phases

Single phase:
- add the three SQL migration files in numeric order
- verify they apply on a fresh database and on a database that already has `012-018` recorded
- confirm status reporting remains idempotent on repeated migration runs

## 5. QA Contract

1. **QA-01: Fresh database applies the reserved v2.0 migrations in order**
   - Given: an empty local PostgreSQL instance with the current migration directory
   - When: `mulder db migrate` runs from scratch
   - Then: migrations `009_entity_grounding.sql`, `010_evidence_chains.sql`, and `011_spatio_temporal_clusters.sql` apply successfully between `008_indexes.sql` and `012_job_queue.sql`

2. **QA-02: Backfilled database accepts 009-011 after 012-018 already exist**
   - Given: a database where migrations `001-008` and `012-018` are already recorded as applied, but `009-011` are not
   - When: `mulder db migrate` runs again
   - Then: only `009-011` are applied, no previously applied migration is re-run, and the command exits successfully

3. **QA-03: Grounding cache schema matches the contract**
   - Given: the migrations have been applied
   - When: `information_schema.columns` and foreign-key metadata are queried for `entity_grounding`
   - Then: the table contains `id`, `entity_id`, `grounding_data`, `source_urls`, `grounded_at`, and `expires_at`, and deleting an entity cascades to its grounding rows

4. **QA-04: Evidence chains schema matches the contract**
   - Given: the migrations have been applied
   - When: `information_schema.columns` is queried for `evidence_chains`
   - Then: `thesis` is text, `path` is a UUID array, `strength` is float, `supports` is boolean, and `computed_at` defaults to the current timestamp

5. **QA-05: Spatio-temporal schema includes cluster storage and entity geometry support**
   - Given: the migrations have been applied
   - When: schema metadata is queried for `spatio_temporal_clusters`, `entities.geom`, and `pg_indexes`
   - Then: the cluster table columns match `§4.3`, `entities.geom` exists as `geometry(Point, 4326)`, and `idx_entities_geom` exists as a GIST index

6. **QA-06: Re-running migrations is idempotent after 009-011 are installed**
   - Given: the full migration set including `009-011` is already applied
   - When: `mulder db migrate` runs again
   - Then: the command succeeds without schema changes and reports no newly applied migrations

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None — this step adds schema only and does not call paid APIs.
