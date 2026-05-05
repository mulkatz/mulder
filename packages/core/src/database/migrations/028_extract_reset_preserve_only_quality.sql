-- Tighten extract reset after adding the upstream quality step.
--
-- Extract resets should keep a completed quality assessment step, but must not
-- preserve older ingest/downstream source_steps rows.

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
