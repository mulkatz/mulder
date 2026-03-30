---
spec: 9
title: Job Queue & Pipeline Tracking Migrations
roadmap_step: M1-A8
functional_spec: ["§4.3", "§4.3.1"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/18
created: 2026-03-30
---

# 1. Objective

Add database migrations 012–014 that create the job queue system (`jobs` table with `job_status` enum), pipeline run tracking (`pipeline_runs` + `pipeline_run_sources` tables), and the cascading reset PL/pgSQL functions (`reset_pipeline_step`, `gc_orphaned_entities`). These lay the groundwork for the async worker (M7) and the `--force` re-run capability.

Migration numbers 009–011 are reserved for v2.0 schema (M6-G1: grounding, evidence_chains, clusters).

# 2. Boundaries

**In scope:**
- Migration 012: `job_status` enum + `jobs` table + job queue index
- Migration 013: `pipeline_runs` + `pipeline_run_sources` tables
- Migration 014: `reset_pipeline_step()` + `gc_orphaned_entities()` PL/pgSQL functions

**Out of scope:**
- Worker logic (M7-H1/H2)
- Pipeline orchestrator (M4-D6)
- Repository layer for jobs/pipeline_runs (future steps)
- v2.0 schema migrations 009–011 (M6-G1)

# 3. Dependencies

**Requires:**
- Spec 08 — Core schema migrations 001–008 (tables referenced by `reset_pipeline_step`)
- Spec 07 — Database client + migration runner (runs these migrations)

**Enables:**
- M4-D6 — Pipeline orchestrator (uses `pipeline_runs` + `pipeline_run_sources`)
- M7-H1 — Job queue repository (uses `jobs` table)
- M7-H2 — Worker loop (dequeues from `jobs` via `FOR UPDATE SKIP LOCKED`)
- M8-I4 — Schema evolution / reprocessing (uses `source_steps` + `pipeline_runs`)

# 4. Blueprint

## 4.1 Files

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/database/migrations/012_job_queue.sql` | create | `job_status` enum, `jobs` table, partial index |
| `packages/core/src/database/migrations/013_pipeline_tracking.sql` | create | `pipeline_runs` + `pipeline_run_sources` tables |
| `packages/core/src/database/migrations/014_pipeline_functions.sql` | create | `reset_pipeline_step()` + `gc_orphaned_entities()` |

No TypeScript changes. No config changes. No package.json changes.

## 4.2 Migration 012: Job Queue

```sql
-- 012_job_queue.sql
-- Job queue for async API operations (§4.3, §10, §14)
-- Uses FOR UPDATE SKIP LOCKED for dequeue — no Pub/Sub, no Redis

CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'dead_letter');

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          job_status NOT NULL DEFAULT 'pending',
  attempts        INTEGER DEFAULT 0,
  max_attempts    INTEGER DEFAULT 3,
  error_log       TEXT,
  worker_id       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

-- Partial index for efficient dequeue: only pending jobs need fast lookup
CREATE INDEX idx_jobs_queue ON jobs(status, created_at) WHERE status = 'pending';
```

## 4.3 Migration 013: Pipeline Tracking

```sql
-- 013_pipeline_tracking.sql
-- Cursor-based pipeline run tracking (§4.3)
-- pipeline_runs: batch run metadata
-- pipeline_run_sources: per-source progress within a run

CREATE TABLE pipeline_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag             TEXT,
  options         JSONB DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'running',
  created_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE pipeline_run_sources (
  run_id          UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  source_id       UUID NOT NULL REFERENCES sources(id),
  current_step    TEXT NOT NULL DEFAULT 'ingested',
  status          TEXT NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_id, source_id)
);
```

## 4.4 Migration 014: Pipeline Functions

```sql
-- 014_pipeline_functions.sql
-- Cascading reset for --force re-runs + orphaned entity GC (§4.3.1)

CREATE OR REPLACE FUNCTION reset_pipeline_step(
  p_source_id UUID,
  p_step TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_step = 'extract' THEN
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id;
    UPDATE sources SET status = 'ingested' WHERE id = p_source_id;
  END IF;

  IF p_step = 'segment' THEN
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('segment', 'enrich', 'embed', 'graph');
    UPDATE sources SET status = 'extracted' WHERE id = p_source_id;
  END IF;

  IF p_step = 'enrich' THEN
    DELETE FROM story_entities
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('enrich', 'embed', 'graph');
    UPDATE stories SET status = 'segmented' WHERE source_id = p_source_id;
    UPDATE sources SET status = 'segmented' WHERE id = p_source_id;
  END IF;

  IF p_step = 'embed' THEN
    DELETE FROM chunks
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('embed', 'graph');
    UPDATE stories SET status = 'enriched' WHERE source_id = p_source_id;
  END IF;

  IF p_step = 'graph' THEN
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name = 'graph';
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    UPDATE stories SET status = 'embedded' WHERE source_id = p_source_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gc_orphaned_entities() RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM entities WHERE id IN (
    SELECT e.id FROM entities e
    LEFT JOIN story_entities se ON e.id = se.entity_id
    WHERE se.entity_id IS NULL
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
```

# 5. QA Contract

Tests verify migrations via the existing database client + migration runner (Spec 07).

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Migrations apply cleanly | PostgreSQL with migrations 001–008 applied | Run all migrations | Migrations 012–014 apply without error |
| QA-02 | Job status enum exists | Migrations applied | Query `pg_type` for `job_status` | Enum exists with values: pending, running, completed, failed, dead_letter |
| QA-03 | Jobs table structure | Migrations applied | Query `information_schema.columns` for `jobs` | All columns present with correct types and defaults |
| QA-04 | Jobs queue index exists | Migrations applied | Query `pg_indexes` for `idx_jobs_queue` | Partial index exists on `(status, created_at) WHERE status = 'pending'` |
| QA-05 | Pipeline runs table structure | Migrations applied | Query `information_schema.columns` for `pipeline_runs` | All columns present with correct types and defaults |
| QA-06 | Pipeline run sources table structure | Migrations applied | Query `information_schema.columns` for `pipeline_run_sources` | All columns present, composite PK on `(run_id, source_id)`, FK to `pipeline_runs` and `sources` with CASCADE on `run_id` |
| QA-07 | Reset pipeline step — extract | Source with stories, entities, edges, chunks exists | Call `reset_pipeline_step(source_id, 'extract')` | Stories deleted (cascading to chunks, story_entities, edges), source_steps cleared, source status = 'ingested' |
| QA-08 | Reset pipeline step — segment | Source with stories exists | Call `reset_pipeline_step(source_id, 'segment')` | Stories deleted, relevant source_steps cleared, source status = 'extracted' |
| QA-09 | Reset pipeline step — enrich | Source with story_entities and entity_edges exists | Call `reset_pipeline_step(source_id, 'enrich')` | story_entities and entity_edges deleted, source_steps for enrich/embed/graph cleared, stories status = 'segmented', source status = 'segmented' |
| QA-10 | Reset pipeline step — embed | Source with chunks exists | Call `reset_pipeline_step(source_id, 'embed')` | Chunks deleted, source_steps for embed/graph cleared, stories status = 'enriched' |
| QA-11 | Reset pipeline step — graph | Source with entity_edges exists | Call `reset_pipeline_step(source_id, 'graph')` | Entity edges deleted, source_steps for graph cleared, stories status = 'embedded' |
| QA-12 | GC orphaned entities | Entity with no story_entities references | Call `gc_orphaned_entities()` | Orphaned entity deleted, returns count = 1. Non-orphaned entities untouched. |
| QA-13 | Idempotent migration | Migrations already applied | Run migrations again | No error (migration runner skips already-applied migrations) |
| QA-14 | FK cascade — pipeline_run_sources | Pipeline run with sources exists | Delete the pipeline_run | Associated pipeline_run_sources rows deleted |
