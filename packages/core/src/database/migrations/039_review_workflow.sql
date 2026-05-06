CREATE TABLE IF NOT EXISTS review_artifacts (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  subject_table TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'llm_auto',
  review_status TEXT NOT NULL DEFAULT 'pending',
  current_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT review_artifacts_type_check CHECK (
    artifact_type IN (
      'assertion_classification',
      'credibility_profile',
      'taxonomy_mapping',
      'similar_case_link',
      'agent_finding',
      'conflict_node',
      'conflict_resolution'
    )
  ),
  CONSTRAINT review_artifacts_subject_table_required_check CHECK (length(trim(subject_table)) > 0),
  CONSTRAINT review_artifacts_created_by_check CHECK (created_by IN ('llm_auto', 'human', 'agent')),
  CONSTRAINT review_artifacts_status_check CHECK (
    review_status IN ('pending', 'approved', 'auto_approved', 'corrected', 'contested', 'rejected')
  ),
  CONSTRAINT review_artifacts_current_value_object_check CHECK (jsonb_typeof(current_value) = 'object'),
  CONSTRAINT review_artifacts_context_object_check CHECK (jsonb_typeof(context) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_artifacts_active_subject
  ON review_artifacts(artifact_type, subject_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_artifacts_pending_scan
  ON review_artifacts(review_status, due_at, priority DESC, created_at ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_artifacts_status
  ON review_artifacts(review_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_artifacts_type
  ON review_artifacts(artifact_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_artifacts_source
  ON review_artifacts(source_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_review_artifacts_due
  ON review_artifacts(due_at)
  WHERE due_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS review_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES review_artifacts(artifact_id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  confidence TEXT NOT NULL DEFAULT 'likely',
  rationale TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_events_reviewer_required_check CHECK (length(trim(reviewer_id)) > 0),
  CONSTRAINT review_events_action_check CHECK (action IN ('approve', 'correct', 'reject', 'comment', 'escalate')),
  CONSTRAINT review_events_confidence_check CHECK (confidence IN ('certain', 'likely', 'uncertain')),
  CONSTRAINT review_events_rationale_required_check CHECK (
    action NOT IN ('correct', 'reject', 'escalate')
    OR (rationale IS NOT NULL AND length(trim(rationale)) > 0)
  ),
  CONSTRAINT review_events_tags_array_check CHECK (tags IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_review_events_artifact_history
  ON review_events(artifact_id, created_at ASC, event_id ASC);
CREATE INDEX IF NOT EXISTS idx_review_events_action
  ON review_events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_events_reviewer
  ON review_events(reviewer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_queues (
  queue_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  artifact_types TEXT[] NOT NULL DEFAULT '{}',
  assignees TEXT[] NOT NULL DEFAULT '{}',
  priority_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_queues_key_required_check CHECK (length(trim(queue_key)) > 0),
  CONSTRAINT review_queues_name_required_check CHECK (length(trim(name)) > 0),
  CONSTRAINT review_queues_artifact_types_array_check CHECK (artifact_types IS NOT NULL),
  CONSTRAINT review_queues_assignees_array_check CHECK (assignees IS NOT NULL),
  CONSTRAINT review_queues_priority_rules_object_check CHECK (jsonb_typeof(priority_rules) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_review_queues_active
  ON review_queues(active)
  WHERE active;

INSERT INTO review_queues (queue_key, name, artifact_types, priority_rules)
VALUES
  (
    'credibility_profiles',
    'Credibility profiles',
    ARRAY['credibility_profile'],
    '{"default_statuses":["pending"]}'::jsonb
  ),
  (
    'conflicts',
    'Conflicts',
    ARRAY['conflict_node','conflict_resolution'],
    '{"default_statuses":["pending"]}'::jsonb
  ),
  (
    'contested_artifacts',
    'Contested artifacts',
    ARRAY[
      'assertion_classification',
      'credibility_profile',
      'taxonomy_mapping',
      'similar_case_link',
      'agent_finding',
      'conflict_node',
      'conflict_resolution'
    ],
    '{"default_statuses":["contested"]}'::jsonb
  )
ON CONFLICT (queue_key) DO UPDATE SET
  name = EXCLUDED.name,
  artifact_types = EXCLUDED.artifact_types,
  priority_rules = EXCLUDED.priority_rules,
  active = true,
  updated_at = now();

CREATE OR REPLACE FUNCTION mark_review_artifacts_for_source_deleted(
  p_source_id UUID,
  p_deleted_at TIMESTAMPTZ DEFAULT now()
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE review_artifacts
    SET deleted_at = COALESCE(deleted_at, p_deleted_at), updated_at = now()
    WHERE (
        source_id = p_source_id
        OR (
          artifact_type = 'conflict_node'
          AND subject_id IN (
            SELECT ca.conflict_id
            FROM conflict_assertions ca
            WHERE ca.source_document_id = p_source_id
          )
        )
        OR (
          artifact_type = 'conflict_resolution'
          AND subject_id IN (
            SELECT cr.id
            FROM conflict_resolutions cr
            JOIN conflict_assertions ca ON ca.conflict_id = cr.conflict_id
            WHERE ca.source_document_id = p_source_id
          )
        )
      )
      AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mark_review_artifacts_for_pipeline_reset_deleted(
  p_source_id UUID,
  p_step TEXT,
  p_deleted_at TIMESTAMPTZ DEFAULT now()
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH reset_conflict_nodes AS (
    SELECT cn.id
    FROM conflict_nodes cn
    WHERE (
        p_step IN ('extract', 'segment', 'enrich')
        AND (
          cn.id IN (
            SELECT ca.conflict_id
            FROM conflict_assertions ca
            JOIN knowledge_assertions ka ON ka.id = ca.assertion_id
            WHERE ka.story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
          )
          OR cn.legacy_edge_id IN (
            SELECT id FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
          )
        )
      )
      OR (
        p_step = 'graph'
        AND cn.legacy_edge_id IN (
          SELECT id
          FROM entity_edges
          WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
            OR attributes->>'storyIdA' IN (SELECT id::text FROM stories WHERE source_id = p_source_id)
            OR attributes->>'storyIdB' IN (SELECT id::text FROM stories WHERE source_id = p_source_id)
        )
      )
  ),
  reset_assertions AS (
    SELECT ka.id
    FROM knowledge_assertions ka
    WHERE p_step IN ('extract', 'segment', 'enrich')
      AND ka.story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
  )
  UPDATE review_artifacts
    SET deleted_at = COALESCE(deleted_at, p_deleted_at), updated_at = now()
    WHERE (
        (
          artifact_type = 'conflict_node'
          AND subject_id IN (SELECT id FROM reset_conflict_nodes)
        )
        OR (
          artifact_type = 'conflict_resolution'
          AND subject_id IN (
            SELECT cr.id
            FROM conflict_resolutions cr
            WHERE cr.conflict_id IN (SELECT id FROM reset_conflict_nodes)
          )
        )
        OR (
          artifact_type = 'assertion_classification'
          AND subject_id IN (SELECT id FROM reset_assertions)
        )
      )
      AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reset_pipeline_step(
  p_source_id UUID,
  p_step TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_step = 'extract' THEN
    PERFORM mark_review_artifacts_for_pipeline_reset_deleted(p_source_id, p_step);
    DELETE FROM conflict_nodes
      WHERE id IN (
        SELECT ca.conflict_id
        FROM conflict_assertions ca
        JOIN knowledge_assertions ka ON ka.id = ca.assertion_id
        WHERE ka.story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
      )
      OR legacy_edge_id IN (
        SELECT id FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
      );
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name <> 'quality';
    UPDATE sources SET status = 'ingested' WHERE id = p_source_id;
  END IF;

  IF p_step = 'segment' THEN
    PERFORM mark_review_artifacts_for_pipeline_reset_deleted(p_source_id, p_step);
    DELETE FROM conflict_nodes
      WHERE id IN (
        SELECT ca.conflict_id
        FROM conflict_assertions ca
        JOIN knowledge_assertions ka ON ka.id = ca.assertion_id
        WHERE ka.story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
      )
      OR legacy_edge_id IN (
        SELECT id FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
      );
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('segment', 'enrich', 'embed', 'graph');
    UPDATE sources SET status = 'extracted' WHERE id = p_source_id;
  END IF;

  IF p_step = 'enrich' THEN
    PERFORM mark_review_artifacts_for_pipeline_reset_deleted(p_source_id, p_step);
    DELETE FROM conflict_nodes
      WHERE id IN (
        SELECT ca.conflict_id
        FROM conflict_assertions ca
        JOIN knowledge_assertions ka ON ka.id = ca.assertion_id
        WHERE ka.story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
      )
      OR legacy_edge_id IN (
        SELECT id FROM entity_edges WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
      );
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
    PERFORM mark_review_artifacts_for_pipeline_reset_deleted(p_source_id, p_step);
    DELETE FROM conflict_nodes
      WHERE legacy_edge_id IN (
        SELECT id
        FROM entity_edges
        WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id)
          OR attributes->>'storyIdA' IN (SELECT id::text FROM stories WHERE source_id = p_source_id)
          OR attributes->>'storyIdB' IN (SELECT id::text FROM stories WHERE source_id = p_source_id)
      );
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name = 'graph';
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    UPDATE stories SET status = 'embedded' WHERE source_id = p_source_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
