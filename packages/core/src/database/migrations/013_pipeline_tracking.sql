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
