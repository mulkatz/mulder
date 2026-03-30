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
