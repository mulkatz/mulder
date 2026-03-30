---
spec: "08"
title: Core Schema Migrations (001-008)
roadmap_step: M1-A7
functional_spec: ["4.3"]
scope: single
created: 2026-03-30
issue: https://github.com/mulkatz/mulder/issues/16
---

# 08 — Core Schema Migrations (001-008)

## 1. Objective

Create the 8 foundational SQL migration files that define Mulder's core database schema. These migrations establish all tables, extensions, and indexes needed for the pipeline (ingest through graph) and retrieval system. They run via the existing migration runner (`mulder db migrate`) built in M1-A6.

**Excludes:** v2.0 tables (entity_grounding, evidence_chains, spatio_temporal_clusters — deferred to M6-G1 migrations 009-011), job queue and pipeline tracking tables (jobs, pipeline_runs, pipeline_run_sources — deferred to M1-A8 migrations 012-014), and the cascading reset function (§4.3.1 — deferred to M1-A8).

## 2. Boundaries

### In scope
- 8 SQL migration files in `packages/core/src/database/migrations/`
- Extensions: pgvector, PostGIS, pg_trgm
- Core tables: sources, source_steps, stories, entities, entity_aliases, story_entities, entity_edges, chunks, taxonomy
- All indexes from §4.3 for the core tables (excluding job queue indexes)
- HNSW vector index on chunks.embedding
- GIN indexes for FTS and trigram similarity
- Generated tsvector column on chunks

### Out of scope
- v2.0 tables (entity_grounding, evidence_chains, spatio_temporal_clusters) — M6-G1
- Job queue tables (jobs, pipeline_runs, pipeline_run_sources) — M1-A8
- Cascading reset function (reset_pipeline_step) — M1-A8
- PostGIS geom column on entities (v2.0 ALTER TABLE) — M6
- Repository layer (CRUD functions) — later milestones
- Any TypeScript code changes — migration runner already handles these files

## 3. Dependencies

### Requires
- M1-A6 database client + migration runner (🟢 complete) — provides `runMigrations()`, `getMigrationStatus()`, and the `mulder db migrate` / `mulder db status` CLI commands
- PostgreSQL with pgvector, PostGIS, pg_trgm extensions available (docker-compose in M1-A11 — but extensions can be tested against any compatible PostgreSQL instance)

### Produces
- Schema foundation consumed by every subsequent milestone (M2-M8) that writes to or reads from the database
- Migration files 001-008 that `mulder db migrate` discovers and applies

## 4. Blueprint

### 4.1 Migration Files

All files in `packages/core/src/database/migrations/`.

**001_extensions.sql** — PostgreSQL extensions (must come first, before any tables use their types)
```sql
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS postgis;   -- PostGIS for geospatial
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram similarity for taxonomy
```

**002_sources.sql** — Sources and source step tracking
```sql
CREATE TABLE sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          TEXT NOT NULL,
  storage_path      TEXT NOT NULL,
  file_hash         TEXT NOT NULL UNIQUE,
  page_count        INTEGER,
  has_native_text   BOOLEAN DEFAULT false,
  native_text_ratio FLOAT DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'ingested',
  reliability_score FLOAT,
  tags              TEXT[],
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE source_steps (
  source_id       UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  step_name       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  config_hash     TEXT,
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  PRIMARY KEY (source_id, step_name)
);
```

**003_stories.sql** — Stories (segments within a source)
```sql
CREATE TABLE stories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES sources(id),
  title                 TEXT NOT NULL,
  subtitle              TEXT,
  language              TEXT,
  category              TEXT,
  page_start            INTEGER,
  page_end              INTEGER,
  gcs_markdown_uri      TEXT NOT NULL,
  gcs_metadata_uri      TEXT NOT NULL,
  chunk_count           INTEGER DEFAULT 0,
  extraction_confidence FLOAT,
  status                TEXT NOT NULL DEFAULT 'segmented',
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
```

**004_entities.sql** — Entities and aliases
```sql
CREATE TABLE entities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id        UUID REFERENCES entities(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  attributes          JSONB DEFAULT '{}',
  corroboration_score FLOAT,
  source_count        INTEGER DEFAULT 0,
  taxonomy_status     TEXT DEFAULT 'auto',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE entity_aliases (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,
  source    TEXT,
  UNIQUE(entity_id, alias)
);
```

**005_relationships.sql** — Junction tables (story_entities + entity_edges)
```sql
CREATE TABLE story_entities (
  story_id    UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entity_id   UUID NOT NULL REFERENCES entities(id),
  confidence  FLOAT,
  mention_count INTEGER DEFAULT 1,
  PRIMARY KEY (story_id, entity_id)
);

CREATE TABLE entity_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id  UUID NOT NULL REFERENCES entities(id),
  target_entity_id  UUID NOT NULL REFERENCES entities(id),
  relationship      TEXT NOT NULL,
  attributes        JSONB DEFAULT '{}',
  confidence        FLOAT,
  story_id          UUID REFERENCES stories(id) ON DELETE CASCADE,
  edge_type         TEXT DEFAULT 'RELATIONSHIP',
  analysis          JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);
```

**006_chunks.sql** — Embedding chunks with vector and FTS columns
```sql
CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id        UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  page_start      INTEGER,
  page_end        INTEGER,
  embedding       vector(768),
  fts_vector      tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  is_question     BOOLEAN DEFAULT false,
  parent_chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

**007_taxonomy.sql** — Taxonomy table
```sql
CREATE TABLE taxonomy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  category        TEXT,
  status          TEXT DEFAULT 'auto',
  aliases         TEXT[],
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(canonical_name, entity_type)
);
```

**008_indexes.sql** — All indexes for core tables
```sql
-- Sources
CREATE INDEX idx_sources_status ON sources(status);

-- Stories
CREATE INDEX idx_stories_source ON stories(source_id);
CREATE INDEX idx_stories_status ON stories(status);

-- Entities
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_canonical ON entities(canonical_id);

-- Entity edges
CREATE INDEX idx_entity_edges_source ON entity_edges(source_entity_id);
CREATE INDEX idx_entity_edges_target ON entity_edges(target_entity_id);
CREATE INDEX idx_entity_edges_type ON entity_edges(edge_type);

-- Chunks
CREATE INDEX idx_chunks_story ON chunks(story_id);
CREATE INDEX idx_chunks_questions ON chunks(parent_chunk_id) WHERE is_question = true;
CREATE INDEX idx_chunks_fts ON chunks USING gin(fts_vector);

-- HNSW vector index (NOT ivfflat — see §14 for rationale)
CREATE INDEX idx_chunks_embedding ON chunks
  USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Trigram indexes for taxonomy similarity search
CREATE INDEX idx_entities_name_trgm ON entities USING gin(name gin_trgm_ops);
CREATE INDEX idx_taxonomy_name_trgm ON taxonomy USING gin(canonical_name gin_trgm_ops);
```

### 4.2 No Code Changes Required

The migration runner from M1-A6 already:
- Discovers `.sql` files from the migrations directory (sorted by filename)
- Applies them sequentially in individual transactions
- Tracks applied migrations in `mulder_migrations`
- Supports `mulder db migrate` and `mulder db status` CLI commands

The migration files are pure SQL — no TypeScript changes needed.

## 5. QA Contract

All conditions verified via `mulder db migrate` against a PostgreSQL instance with pgvector, PostGIS, and pg_trgm extensions available.

| ID | Condition | Given / When / Then |
|----|-----------|---------------------|
| QA-01 | Extensions created | Given a fresh database / When `mulder db migrate` runs / Then pgvector, PostGIS, and pg_trgm extensions exist (`SELECT extname FROM pg_extension`) |
| QA-02 | All 8 migrations applied | Given a fresh database / When `mulder db migrate` runs / Then 8 migrations are reported as applied, 0 skipped |
| QA-03 | Sources table exists | Given migrations applied / When querying `information_schema.columns` / Then `sources` table has all columns: id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, created_at, updated_at |
| QA-04 | Source_steps table exists | Given migrations applied / When querying `information_schema.columns` / Then `source_steps` table has columns: source_id, step_name, status, config_hash, completed_at, error_message with composite PK |
| QA-05 | Stories table exists | Given migrations applied / Then `stories` table has all columns including gcs_markdown_uri, gcs_metadata_uri, with FK to sources |
| QA-06 | Entities + aliases tables exist | Given migrations applied / Then `entities` table has self-referential canonical_id FK; `entity_aliases` has UNIQUE(entity_id, alias) |
| QA-07 | Relationship tables exist | Given migrations applied / Then `story_entities` has composite PK (story_id, entity_id); `entity_edges` has FKs to entities and stories |
| QA-08 | Chunks table with vector + FTS | Given migrations applied / Then `chunks` table has `embedding vector(768)` column and `fts_vector tsvector` generated column |
| QA-09 | Taxonomy table exists | Given migrations applied / Then `taxonomy` has UNIQUE(canonical_name, entity_type) |
| QA-10 | Indexes created | Given migrations applied / When querying `pg_indexes` / Then all expected indexes exist (idx_sources_status, idx_chunks_embedding, idx_chunks_fts, idx_entities_name_trgm, etc.) |
| QA-11 | HNSW index (not ivfflat) | Given migrations applied / When querying `pg_indexes` for idx_chunks_embedding / Then index method is `hnsw`, not `ivfflat` |
| QA-12 | Idempotent re-run | Given migrations already applied / When `mulder db migrate` runs again / Then 0 applied, 8 skipped, no errors |
| QA-13 | Migration status correct | Given migrations applied / When `mulder db status` runs / Then all 8 migrations show as applied with timestamps |
| QA-14 | FK cascades work | Given migrations applied / When a source row is deleted / Then its source_steps rows are also deleted (ON DELETE CASCADE) |
| QA-15 | File_hash uniqueness enforced | Given migrations applied / When inserting two sources with the same file_hash / Then the second insert fails with a unique constraint violation |
