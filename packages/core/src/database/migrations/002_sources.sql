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
