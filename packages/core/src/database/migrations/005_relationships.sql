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
