CREATE TABLE IF NOT EXISTS temporal_anomaly_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_key TEXT NOT NULL,
  region_geojson JSONB,
  anomaly_type TEXT NOT NULL DEFAULT 'frequency_spike',
  time_start TIMESTAMPTZ NOT NULL,
  time_end TIMESTAMPTZ NOT NULL,
  entity_count INTEGER NOT NULL,
  baseline_rate DOUBLE PRECISION NOT NULL,
  observed_rate DOUBLE PRECISION NOT NULL,
  raw_significance DOUBLE PRECISION NOT NULL,
  comparison_count INTEGER NOT NULL,
  corrected_significance DOUBLE PRECISION NOT NULL,
  significance_threshold DOUBLE PRECISION NOT NULL,
  peak_date TIMESTAMPTZ NOT NULL,
  dominant_category_ref JSONB,
  contributing_entity_ids UUID[] NOT NULL,
  known_pattern_match TEXT,
  bias_warning TEXT,
  signal_strength TEXT NOT NULL DEFAULT 'weak',
  caveats TEXT[] NOT NULL DEFAULT ARRAY['Patterns are hypothesis starters, not causal evidence.']::text[],
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
  CONSTRAINT temporal_anomaly_clusters_region_key_required_check CHECK (length(trim(region_key)) > 0),
  CONSTRAINT temporal_anomaly_clusters_anomaly_type_check CHECK (anomaly_type IN ('frequency_spike')),
  CONSTRAINT temporal_anomaly_clusters_time_order_check CHECK (time_end > time_start),
  CONSTRAINT temporal_anomaly_clusters_entity_count_check CHECK (entity_count >= 0),
  CONSTRAINT temporal_anomaly_clusters_rates_check CHECK (baseline_rate >= 0 AND observed_rate >= 0),
  CONSTRAINT temporal_anomaly_clusters_significance_check CHECK (
    raw_significance >= 0
    AND raw_significance <= 1
    AND corrected_significance >= 0
    AND corrected_significance <= 1
    AND significance_threshold > 0
    AND significance_threshold <= 1
    AND comparison_count > 0
  ),
  CONSTRAINT temporal_anomaly_clusters_region_geojson_object_check CHECK (
    region_geojson IS NULL OR jsonb_typeof(region_geojson) = 'object'
  ),
  CONSTRAINT temporal_anomaly_clusters_dominant_category_ref_object_check CHECK (
    dominant_category_ref IS NULL OR jsonb_typeof(dominant_category_ref) = 'object'
  ),
  CONSTRAINT temporal_anomaly_clusters_contributing_entity_ids_check CHECK (
    array_length(contributing_entity_ids, 1) IS NOT NULL
  ),
  CONSTRAINT temporal_anomaly_clusters_signal_strength_check CHECK (signal_strength = 'weak'),
  CONSTRAINT temporal_anomaly_clusters_caveats_check CHECK (array_length(caveats, 1) IS NOT NULL),
  CONSTRAINT temporal_anomaly_clusters_review_status_check CHECK (
    review_status IN ('pending', 'approved', 'rejected', 'contested')
  ),
  CONSTRAINT temporal_anomaly_clusters_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT temporal_anomaly_clusters_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT temporal_anomaly_clusters_sensitivity_metadata_shape_check CHECK (
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

CREATE TABLE IF NOT EXISTS spatiotemporal_hotspot_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_key TEXT NOT NULL,
  hotspot_type TEXT NOT NULL DEFAULT 'density_cluster',
  centroid geometry(Point, 4326) NOT NULL,
  radius_km DOUBLE PRECISION NOT NULL,
  time_start TIMESTAMPTZ NOT NULL,
  time_end TIMESTAMPTZ NOT NULL,
  entity_count INTEGER NOT NULL,
  density DOUBLE PRECISION NOT NULL,
  persistence TEXT NOT NULL,
  recurrence_pattern TEXT,
  related_cluster_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
  contributing_entity_ids UUID[] NOT NULL,
  dominant_category_ref JSONB,
  bias_warning TEXT,
  signal_strength TEXT NOT NULL DEFAULT 'weak',
  caveats TEXT[] NOT NULL DEFAULT ARRAY['Patterns are hypothesis starters, not causal evidence.']::text[],
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
  CONSTRAINT spatiotemporal_hotspot_clusters_region_key_required_check CHECK (length(trim(region_key)) > 0),
  CONSTRAINT spatiotemporal_hotspot_clusters_hotspot_type_check CHECK (hotspot_type IN ('density_cluster')),
  CONSTRAINT spatiotemporal_hotspot_clusters_radius_check CHECK (radius_km > 0),
  CONSTRAINT spatiotemporal_hotspot_clusters_time_order_check CHECK (time_end > time_start),
  CONSTRAINT spatiotemporal_hotspot_clusters_entity_count_check CHECK (entity_count >= 0),
  CONSTRAINT spatiotemporal_hotspot_clusters_density_check CHECK (density >= 0),
  CONSTRAINT spatiotemporal_hotspot_clusters_persistence_check CHECK (
    persistence IN ('transient', 'recurring', 'permanent')
  ),
  CONSTRAINT spatiotemporal_hotspot_clusters_contributing_entity_ids_check CHECK (
    array_length(contributing_entity_ids, 1) IS NOT NULL
  ),
  CONSTRAINT spatiotemporal_hotspot_clusters_dominant_category_ref_object_check CHECK (
    dominant_category_ref IS NULL OR jsonb_typeof(dominant_category_ref) = 'object'
  ),
  CONSTRAINT spatiotemporal_hotspot_clusters_signal_strength_check CHECK (signal_strength = 'weak'),
  CONSTRAINT spatiotemporal_hotspot_clusters_caveats_check CHECK (array_length(caveats, 1) IS NOT NULL),
  CONSTRAINT spatiotemporal_hotspot_clusters_review_status_check CHECK (
    review_status IN ('pending', 'approved', 'rejected', 'contested')
  ),
  CONSTRAINT spatiotemporal_hotspot_clusters_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT spatiotemporal_hotspot_clusters_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT spatiotemporal_hotspot_clusters_sensitivity_metadata_shape_check CHECK (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_active_region_time_type
  ON temporal_anomaly_clusters(region_key, time_start, time_end, anomaly_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_time
  ON temporal_anomaly_clusters(time_start, time_end)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_region_key
  ON temporal_anomaly_clusters(region_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_computed_at
  ON temporal_anomaly_clusters(computed_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_contributing_entity_ids
  ON temporal_anomaly_clusters USING GIN (contributing_entity_ids)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_sensitivity_level
  ON temporal_anomaly_clusters(sensitivity_level)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_provenance_source_ids
  ON temporal_anomaly_clusters USING GIN ((provenance->'source_document_ids'))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_temporal_anomaly_clusters_review_status
  ON temporal_anomaly_clusters(review_status)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_active_region_time_type
  ON spatiotemporal_hotspot_clusters(region_key, time_start, time_end, hotspot_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_centroid
  ON spatiotemporal_hotspot_clusters USING GIST (centroid)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_time
  ON spatiotemporal_hotspot_clusters(time_start, time_end)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_region_key
  ON spatiotemporal_hotspot_clusters(region_key)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_computed_at
  ON spatiotemporal_hotspot_clusters(computed_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_contributing_entity_ids
  ON spatiotemporal_hotspot_clusters USING GIN (contributing_entity_ids)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_related_cluster_ids
  ON spatiotemporal_hotspot_clusters USING GIN (related_cluster_ids)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_sensitivity_level
  ON spatiotemporal_hotspot_clusters(sensitivity_level)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_provenance_source_ids
  ON spatiotemporal_hotspot_clusters USING GIN ((provenance->'source_document_ids'))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_spatiotemporal_hotspot_clusters_review_status
  ON spatiotemporal_hotspot_clusters(review_status)
  WHERE deleted_at IS NULL;
