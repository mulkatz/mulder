ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS parent_source_id UUID REFERENCES sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sources_parent_source_id ON sources(parent_source_id);
