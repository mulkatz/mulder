ALTER TABLE source_credibility_profiles
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT jsonb_build_object(
    'source_document_ids', '[]'::jsonb,
    'extraction_pipeline_run', 'null'::jsonb,
    'created_at', to_jsonb(now())
  ),
  ADD COLUMN IF NOT EXISTS sensitivity_level TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS sensitivity_metadata JSONB NOT NULL DEFAULT jsonb_build_object(
    'level', 'internal',
    'reason', 'default_policy',
    'assigned_by', 'policy_rule',
    'assigned_at', to_jsonb(now()),
    'pii_types', '[]'::jsonb,
    'declassify_date', 'null'::jsonb
  );

UPDATE source_credibility_profiles p
SET
  provenance = jsonb_build_object(
    'source_document_ids', jsonb_build_array(p.source_id::text),
    'extraction_pipeline_run', 'null'::jsonb,
    'created_at', to_jsonb(COALESCE(p.created_at, now()))
  ),
  sensitivity_level = COALESCE(s.sensitivity_level, p.sensitivity_level, 'internal'),
  sensitivity_metadata = jsonb_build_object(
    'level', COALESCE(s.sensitivity_level, p.sensitivity_level, 'internal'),
    'reason', COALESCE(NULLIF(s.sensitivity_metadata->>'reason', ''), 'source_policy'),
    'assigned_by', COALESCE(NULLIF(s.sensitivity_metadata->>'assigned_by', ''), 'policy_rule'),
    'assigned_at', COALESCE(NULLIF(s.sensitivity_metadata->>'assigned_at', ''), now()::text),
    'pii_types', CASE
      WHEN jsonb_typeof(s.sensitivity_metadata->'pii_types') = 'array'
        THEN s.sensitivity_metadata->'pii_types'
      ELSE '[]'::jsonb
    END,
    'declassify_date', COALESCE(s.sensitivity_metadata->'declassify_date', 'null'::jsonb)
  )
FROM sources s
WHERE s.id = p.source_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_credibility_profiles_provenance_object_check'
  ) THEN
    ALTER TABLE source_credibility_profiles
      ADD CONSTRAINT source_credibility_profiles_provenance_object_check CHECK (
        jsonb_typeof(provenance) = 'object'
        AND provenance ? 'source_document_ids'
        AND provenance ? 'extraction_pipeline_run'
        AND provenance ? 'created_at'
        AND jsonb_typeof(provenance->'source_document_ids') = 'array'
        AND (
          provenance->'extraction_pipeline_run' = 'null'::jsonb
          OR jsonb_typeof(provenance->'extraction_pipeline_run') = 'string'
        )
        AND jsonb_typeof(provenance->'created_at') = 'string'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_credibility_profiles_sensitivity_level_check'
  ) THEN
    ALTER TABLE source_credibility_profiles
      ADD CONSTRAINT source_credibility_profiles_sensitivity_level_check CHECK (
        sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'source_credibility_profiles_sensitivity_metadata_shape_check'
  ) THEN
    ALTER TABLE source_credibility_profiles
      ADD CONSTRAINT source_credibility_profiles_sensitivity_metadata_shape_check CHECK (
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
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_source_credibility_profiles_provenance_source_ids
  ON source_credibility_profiles USING GIN ((provenance -> 'source_document_ids'));

CREATE INDEX IF NOT EXISTS idx_source_credibility_profiles_sensitivity_level
  ON source_credibility_profiles(sensitivity_level);
