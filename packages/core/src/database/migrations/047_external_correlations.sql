CREATE TABLE IF NOT EXISTS external_correlations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_series_key TEXT NOT NULL,
  external_source_id TEXT NOT NULL,
  external_series_id TEXT NOT NULL,
  method TEXT NOT NULL,
  coefficient DOUBLE PRECISION NOT NULL,
  p_value DOUBLE PRECISION NOT NULL,
  lag_days INTEGER NOT NULL DEFAULT 0,
  time_start TIMESTAMPTZ NOT NULL,
  time_end TIMESTAMPTZ NOT NULL,
  data_point_count INTEGER NOT NULL,
  contributing_entity_ids UUID[] NOT NULL,
  interpretation_caveat TEXT NOT NULL DEFAULT 'Correlation ≠ Causation',
  signal_strength TEXT NOT NULL DEFAULT 'weak',
  caveats TEXT[] NOT NULL DEFAULT ARRAY['Correlation ≠ Causation']::text[],
  review_status TEXT NOT NULL DEFAULT 'pending',
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
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT external_correlations_internal_series_key_required_check CHECK (length(trim(internal_series_key)) > 0),
  CONSTRAINT external_correlations_external_source_id_required_check CHECK (length(trim(external_source_id)) > 0),
  CONSTRAINT external_correlations_external_series_id_required_check CHECK (length(trim(external_series_id)) > 0),
  CONSTRAINT external_correlations_method_check CHECK (method IN ('spearman', 'cross_correlation')),
  CONSTRAINT external_correlations_coefficient_check CHECK (coefficient >= -1 AND coefficient <= 1),
  CONSTRAINT external_correlations_p_value_check CHECK (p_value >= 0 AND p_value <= 1),
  CONSTRAINT external_correlations_lag_days_check CHECK (lag_days >= 0),
  CONSTRAINT external_correlations_time_order_check CHECK (time_end > time_start),
  CONSTRAINT external_correlations_data_point_count_check CHECK (data_point_count > 0),
  CONSTRAINT external_correlations_contributing_entity_ids_check CHECK (
    array_length(contributing_entity_ids, 1) IS NOT NULL
  ),
  CONSTRAINT external_correlations_interpretation_caveat_check CHECK (interpretation_caveat = 'Correlation ≠ Causation'),
  CONSTRAINT external_correlations_signal_strength_check CHECK (signal_strength = 'weak'),
  CONSTRAINT external_correlations_caveats_check CHECK (
    array_length(caveats, 1) IS NOT NULL
    AND 'Correlation ≠ Causation' = ANY(caveats)
  ),
  CONSTRAINT external_correlations_review_status_check CHECK (
    review_status IN ('pending', 'approved', 'rejected', 'contested')
  ),
  CONSTRAINT external_correlations_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT external_correlations_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT external_correlations_sensitivity_metadata_shape_check CHECK (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_external_correlations_active_series_method_window_lag
  ON external_correlations(
    internal_series_key,
    external_source_id,
    external_series_id,
    method,
    time_start,
    time_end,
    lag_days
  )
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_external_source_series
  ON external_correlations(external_source_id, external_series_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_internal_series_key
  ON external_correlations(internal_series_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_time
  ON external_correlations(time_start, time_end)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_method
  ON external_correlations(method)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_review_status
  ON external_correlations(review_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_sensitivity_level
  ON external_correlations(sensitivity_level)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_provenance_source_ids
  ON external_correlations USING GIN ((provenance->'source_document_ids'))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_external_correlations_contributing_entity_ids
  ON external_correlations USING GIN (contributing_entity_ids)
  WHERE deleted_at IS NULL;
