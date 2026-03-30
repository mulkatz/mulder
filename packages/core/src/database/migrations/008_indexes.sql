-- Sources
CREATE INDEX idx_sources_status ON sources(status);

-- Stories
CREATE INDEX idx_stories_source ON stories(source_id);
CREATE INDEX idx_stories_status ON stories(status);

-- Entities
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_canonical ON entities(canonical_id);

-- Entity edges
CREATE INDEX idx_entity_edges_source ON entity_edges(source_entity_id);
CREATE INDEX idx_entity_edges_target ON entity_edges(target_entity_id);
CREATE INDEX idx_entity_edges_type ON entity_edges(edge_type);

-- Chunks
CREATE INDEX idx_chunks_story ON chunks(story_id);
CREATE INDEX idx_chunks_questions ON chunks(parent_chunk_id) WHERE is_question = true;
CREATE INDEX idx_chunks_fts ON chunks USING gin(fts_vector);

-- HNSW vector index (NOT ivfflat — see §14 for rationale)
CREATE INDEX idx_chunks_embedding ON chunks
  USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Trigram indexes for taxonomy similarity search
CREATE INDEX idx_entities_name_trgm ON entities USING gin(name gin_trgm_ops);
CREATE INDEX idx_taxonomy_name_trgm ON taxonomy USING gin(canonical_name gin_trgm_ops);
