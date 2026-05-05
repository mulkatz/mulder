DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources',
    'stories',
    'entities',
    'entity_aliases',
    'story_entities',
    'chunks',
    'entity_edges',
    'knowledge_assertions'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I
        ADD COLUMN IF NOT EXISTS sensitivity_level TEXT NOT NULL DEFAULT ''internal'',
        ADD COLUMN IF NOT EXISTS sensitivity_metadata JSONB NOT NULL DEFAULT jsonb_build_object(
          ''level'', ''internal'',
          ''reason'', ''default_policy'',
          ''assigned_by'', ''policy_rule'',
          ''assigned_at'', to_jsonb(now()),
          ''pii_types'', ''[]''::jsonb,
          ''declassify_date'', ''null''::jsonb
        )',
      table_name
    );

    EXECUTE format(
      'UPDATE %I
        SET
          sensitivity_level = COALESCE(sensitivity_level, ''internal''),
          sensitivity_metadata = jsonb_build_object(
            ''level'', COALESCE(sensitivity_level, ''internal''),
            ''reason'', COALESCE(NULLIF(sensitivity_metadata->>''reason'', ''''), ''default_policy''),
            ''assigned_by'', COALESCE(NULLIF(sensitivity_metadata->>''assigned_by'', ''''), ''policy_rule''),
            ''assigned_at'', COALESCE(NULLIF(sensitivity_metadata->>''assigned_at'', ''''), now()::text),
            ''pii_types'', CASE
              WHEN jsonb_typeof(sensitivity_metadata->''pii_types'') = ''array''
                THEN sensitivity_metadata->''pii_types''
              ELSE ''[]''::jsonb
            END,
            ''declassify_date'', COALESCE(sensitivity_metadata->''declassify_date'', ''null''::jsonb)
          )',
      table_name
    );

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_sensitivity_level_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I
          ADD CONSTRAINT %I CHECK (
            sensitivity_level IN (''public'', ''internal'', ''restricted'', ''confidential'')
          )',
        table_name,
        table_name || '_sensitivity_level_check'
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = table_name || '_sensitivity_metadata_shape_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I
          ADD CONSTRAINT %I CHECK (
            jsonb_typeof(sensitivity_metadata) = ''object''
            AND sensitivity_metadata ? ''level''
            AND sensitivity_metadata ? ''reason''
            AND sensitivity_metadata ? ''assigned_by''
            AND sensitivity_metadata ? ''assigned_at''
            AND sensitivity_metadata ? ''pii_types''
            AND sensitivity_metadata ? ''declassify_date''
            AND sensitivity_metadata->>''level'' = sensitivity_level
            AND sensitivity_metadata->>''level'' IN (''public'', ''internal'', ''restricted'', ''confidential'')
            AND sensitivity_metadata->>''assigned_by'' IN (''llm_auto'', ''human'', ''policy_rule'')
            AND jsonb_typeof(sensitivity_metadata->''pii_types'') = ''array''
            AND (
              sensitivity_metadata->''declassify_date'' = ''null''::jsonb
              OR jsonb_typeof(sensitivity_metadata->''declassify_date'') = ''string''
            )
          )',
        table_name,
        table_name || '_sensitivity_metadata_shape_check'
      );
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I (sensitivity_level)',
      'idx_' || table_name || '_sensitivity_level',
      table_name
    );
  END LOOP;
END;
$$;
