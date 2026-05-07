CREATE TABLE IF NOT EXISTS similarity_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id_a UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_id_b UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  pair_entity_id_low UUID GENERATED ALWAYS AS (LEAST(entity_id_a, entity_id_b)) STORED,
  pair_entity_id_high UUID GENERATED ALWAYS AS (GREATEST(entity_id_a, entity_id_b)) STORED,
  core_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  domain_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation TEXT NOT NULL DEFAULT '',
  shared_entity_ids UUID[] NOT NULL DEFAULT '{}',
  key_differences TEXT[] NOT NULL DEFAULT '{}',
  rank_position INTEGER,
  review_status TEXT NOT NULL DEFAULT 'pending',
  auto_discovered BOOLEAN NOT NULL DEFAULT false,
  auto_discovery_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
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
  CONSTRAINT similarity_cache_distinct_pair_check CHECK (entity_id_a <> entity_id_b),
  CONSTRAINT similarity_cache_core_scores_object_check CHECK (jsonb_typeof(core_scores) = 'object'),
  CONSTRAINT similarity_cache_domain_scores_array_check CHECK (jsonb_typeof(domain_scores) = 'array'),
  CONSTRAINT similarity_cache_auto_metadata_object_check CHECK (jsonb_typeof(auto_discovery_metadata) = 'object'),
  CONSTRAINT similarity_cache_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT similarity_cache_rank_position_check CHECK (rank_position IS NULL OR rank_position > 0),
  CONSTRAINT similarity_cache_review_status_check CHECK (
    review_status IN ('pending', 'approved', 'auto_approved', 'corrected', 'contested', 'rejected')
  ),
  CONSTRAINT similarity_cache_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT similarity_cache_sensitivity_metadata_shape_check CHECK (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_similarity_cache_active_pair
  ON similarity_cache(pair_entity_id_low, pair_entity_id_high)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_similarity_cache_entity_a
  ON similarity_cache(entity_id_a)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_similarity_cache_entity_b
  ON similarity_cache(entity_id_b)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_similarity_cache_review_status
  ON similarity_cache(review_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_similarity_cache_auto_discovered
  ON similarity_cache(auto_discovered)
  WHERE auto_discovered AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_similarity_cache_provenance
  ON similarity_cache USING GIN (provenance)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_similarity_cache_sensitivity_level
  ON similarity_cache(sensitivity_level)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_edges_similarity_active_pair
  ON entity_edges(LEAST(source_entity_id, target_entity_id), GREATEST(source_entity_id, target_entity_id), relationship, edge_type)
  WHERE relationship = 'SIMILAR_TO' AND edge_type = 'RELATIONSHIP' AND story_id IS NULL;
