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
