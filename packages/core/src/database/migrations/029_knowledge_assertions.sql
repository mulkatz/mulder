CREATE TABLE IF NOT EXISTS knowledge_assertions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  assertion_type TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence_metadata JSONB NOT NULL,
  classification_provenance TEXT NOT NULL DEFAULT 'llm_auto',
  extracted_entity_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT knowledge_assertions_type_check CHECK (
    assertion_type IN ('observation', 'interpretation', 'hypothesis')
  ),
  CONSTRAINT knowledge_assertions_classification_provenance_check CHECK (
    classification_provenance IN ('llm_auto', 'human_reviewed', 'author_explicit')
  ),
  CONSTRAINT knowledge_assertions_confidence_metadata_object_check CHECK (
    jsonb_typeof(confidence_metadata) = 'object'
  ),
  CONSTRAINT knowledge_assertions_provenance_object_check CHECK (
    jsonb_typeof(provenance) = 'object'
  ),
  CONSTRAINT knowledge_assertions_quality_metadata_object_check CHECK (
    quality_metadata IS NULL OR jsonb_typeof(quality_metadata) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_assertions_active_upsert
  ON knowledge_assertions(source_id, story_id, content, assertion_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_source_id
  ON knowledge_assertions(source_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_story_id
  ON knowledge_assertions(story_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_assertion_type
  ON knowledge_assertions(assertion_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_provenance_source_ids
  ON knowledge_assertions USING GIN ((provenance -> 'source_document_ids'));

-- Keep source-level enrich force resets aligned with the assertion store.
CREATE OR REPLACE FUNCTION reset_pipeline_step(
  p_source_id UUID,
  p_step TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_step = 'extract' THEN
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name <> 'quality';
    UPDATE sources SET status = 'ingested' WHERE id = p_source_id;
  END IF;

  IF p_step = 'segment' THEN
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('segment', 'enrich', 'embed', 'graph');
    UPDATE sources SET status = 'extracted' WHERE id = p_source_id;
  END IF;

  IF p_step = 'enrich' THEN
    DELETE FROM knowledge_assertions
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM story_entities
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('enrich', 'embed', 'graph');
    UPDATE stories SET status = 'segmented' WHERE source_id = p_source_id;
    UPDATE sources SET status = 'segmented' WHERE id = p_source_id;
  END IF;

  IF p_step = 'embed' THEN
    DELETE FROM chunks
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('embed', 'graph');
    UPDATE stories SET status = 'enriched' WHERE source_id = p_source_id;
  END IF;

  IF p_step = 'graph' THEN
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name = 'graph';
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    UPDATE stories SET status = 'embedded' WHERE source_id = p_source_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
