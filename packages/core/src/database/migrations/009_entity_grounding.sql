CREATE TABLE entity_grounding (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  grounding_data JSONB NOT NULL,
  source_urls    TEXT[],
  grounded_at    TIMESTAMPTZ DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);
