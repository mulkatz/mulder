-- Add name embedding column for Tier 2 entity resolution (cross-lingual).
-- text-embedding-004 produces 768-dim vectors.
ALTER TABLE entities ADD COLUMN name_embedding vector(768);

-- HNSW index for cosine similarity search (same strategy as chunks table).
CREATE INDEX idx_entities_name_embedding ON entities
  USING hnsw (name_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
