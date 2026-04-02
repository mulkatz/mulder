-- Partial unique index for idempotent edge upsert.
-- Covers the common case: same relationship between same entities from the
-- same story should be upserted (Graph step re-runs). Different edge_types
-- between the same entities can coexist (e.g., RELATIONSHIP + POTENTIAL_CONTRADICTION).
-- Edges without story_id (analysis-created) are excluded — they use plain INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_edges_upsert
  ON entity_edges(source_entity_id, target_entity_id, relationship, edge_type, story_id)
  WHERE story_id IS NOT NULL;
