CREATE TABLE IF NOT EXISTS conflict_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_type TEXT NOT NULL,
  detection_method TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_by TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL,
  severity_rationale TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  legacy_edge_id UUID REFERENCES entity_edges(id) ON DELETE SET NULL,
  canonical_assertion_pair UUID[] NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  sensitivity_level TEXT NOT NULL DEFAULT 'internal',
  sensitivity_metadata JSONB NOT NULL DEFAULT jsonb_build_object(
    'level', 'internal',
    'reason', 'default_policy',
    'assigned_by', 'policy_rule',
    'assigned_at', to_jsonb(now()),
    'pii_types', '[]'::jsonb,
    'declassify_date', 'null'::jsonb
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT conflict_nodes_type_check CHECK (
    conflict_type IN ('factual', 'interpretive', 'taxonomic', 'temporal', 'spatial', 'attributive')
  ),
  CONSTRAINT conflict_nodes_detection_method_check CHECK (
    detection_method IN ('llm_auto', 'statistical', 'human_reported')
  ),
  CONSTRAINT conflict_nodes_resolution_status_check CHECK (
    resolution_status IN ('open', 'explained', 'confirmed_contradictory', 'false_positive')
  ),
  CONSTRAINT conflict_nodes_severity_check CHECK (
    severity IN ('minor', 'significant', 'fundamental')
  ),
  CONSTRAINT conflict_nodes_review_status_required_check CHECK (length(trim(review_status)) > 0),
  CONSTRAINT conflict_nodes_detected_by_required_check CHECK (length(trim(detected_by)) > 0),
  CONSTRAINT conflict_nodes_severity_rationale_required_check CHECK (length(trim(severity_rationale)) > 0),
  CONSTRAINT conflict_nodes_confidence_bounds_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT conflict_nodes_pair_shape_check CHECK (cardinality(canonical_assertion_pair) = 2),
  CONSTRAINT conflict_nodes_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT conflict_nodes_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT conflict_nodes_sensitivity_metadata_shape_check CHECK (
    jsonb_typeof(sensitivity_metadata) = 'object'
    AND sensitivity_metadata ? 'level'
    AND sensitivity_metadata ? 'reason'
    AND sensitivity_metadata ? 'assigned_by'
    AND sensitivity_metadata ? 'assigned_at'
    AND sensitivity_metadata ? 'pii_types'
    AND sensitivity_metadata ? 'declassify_date'
    AND sensitivity_metadata->>'level' = sensitivity_level
    AND sensitivity_metadata->>'level' IN ('public', 'internal', 'restricted', 'confidential')
    AND sensitivity_metadata->>'assigned_by' IN ('llm_auto', 'human', 'policy_rule')
    AND jsonb_typeof(sensitivity_metadata->'pii_types') = 'array'
    AND (
      sensitivity_metadata->'declassify_date' = 'null'::jsonb
      OR jsonb_typeof(sensitivity_metadata->'declassify_date') = 'string'
    )
  )
);

CREATE TABLE IF NOT EXISTS conflict_assertions (
  conflict_id UUID NOT NULL REFERENCES conflict_nodes(id) ON DELETE CASCADE,
  assertion_id UUID NOT NULL REFERENCES knowledge_assertions(id) ON DELETE CASCADE,
  source_document_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  assertion_type TEXT NOT NULL,
  claim TEXT NOT NULL,
  credibility_profile_id UUID REFERENCES source_credibility_profiles(profile_id) ON DELETE SET NULL,
  participant_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conflict_id, assertion_id),
  CONSTRAINT conflict_assertions_type_check CHECK (
    assertion_type IN ('observation', 'interpretation', 'hypothesis')
  ),
  CONSTRAINT conflict_assertions_claim_required_check CHECK (length(trim(claim)) > 0),
  CONSTRAINT conflict_assertions_participant_role_check CHECK (
    participant_role IN ('claim_a', 'claim_b', 'context')
  )
);

CREATE TABLE IF NOT EXISTS conflict_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_id UUID NOT NULL REFERENCES conflict_nodes(id) ON DELETE CASCADE,
  resolution_type TEXT NOT NULL,
  explanation TEXT NOT NULL,
  resolved_by TEXT NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_refs TEXT[] NOT NULL DEFAULT '{}',
  review_status TEXT NOT NULL DEFAULT 'pending',
  legacy_edge_id UUID REFERENCES entity_edges(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conflict_resolutions_type_check CHECK (
    resolution_type IN (
      'different_vantage_point',
      'different_time',
      'measurement_error',
      'source_unreliable',
      'scope_difference',
      'genuinely_contradictory',
      'duplicate_misidentification',
      'other'
    )
  ),
  CONSTRAINT conflict_resolutions_explanation_required_check CHECK (length(trim(explanation)) > 0),
  CONSTRAINT conflict_resolutions_resolved_by_required_check CHECK (length(trim(resolved_by)) > 0),
  CONSTRAINT conflict_resolutions_review_status_required_check CHECK (length(trim(review_status)) > 0),
  CONSTRAINT conflict_resolutions_evidence_refs_array_check CHECK (evidence_refs IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_nodes_active_pair_type
  ON conflict_nodes(conflict_type, canonical_assertion_pair)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_nodes_active_legacy_edge
  ON conflict_nodes(legacy_edge_id)
  WHERE legacy_edge_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_resolutions_conflict_legacy_edge
  ON conflict_resolutions(conflict_id, legacy_edge_id)
  WHERE legacy_edge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conflict_nodes_open
  ON conflict_nodes(detected_at DESC)
  WHERE resolution_status = 'open' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conflict_nodes_severity
  ON conflict_nodes(severity)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conflict_nodes_conflict_type
  ON conflict_nodes(conflict_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conflict_nodes_legacy_edge_id
  ON conflict_nodes(legacy_edge_id)
  WHERE legacy_edge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conflict_nodes_provenance_source_ids
  ON conflict_nodes USING GIN ((provenance -> 'source_document_ids'));
CREATE INDEX IF NOT EXISTS idx_conflict_nodes_sensitivity_level
  ON conflict_nodes(sensitivity_level)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conflict_nodes_resolution_status
  ON conflict_nodes(resolution_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conflict_assertions_assertion_id
  ON conflict_assertions(assertion_id);
CREATE INDEX IF NOT EXISTS idx_conflict_assertions_source_document_id
  ON conflict_assertions(source_document_id);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_conflict_id
  ON conflict_resolutions(conflict_id, resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_conflict_resolutions_resolution_type
  ON conflict_resolutions(resolution_type);

CREATE OR REPLACE FUNCTION reset_pipeline_step(
  p_source_id UUID,
  p_step TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_step = 'extract' THEN
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
