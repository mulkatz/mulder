CREATE TABLE IF NOT EXISTS classification_taxonomies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  language TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source_ref TEXT,
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
  CONSTRAINT classification_taxonomies_id_required_check CHECK (length(trim(id)) > 0),
  CONSTRAINT classification_taxonomies_name_required_check CHECK (length(trim(name)) > 0),
  CONSTRAINT classification_taxonomies_status_check CHECK (
    status IN ('active', 'inactive', 'draft', 'deprecated')
  ),
  CONSTRAINT classification_taxonomies_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT classification_taxonomies_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT classification_taxonomies_sensitivity_metadata_shape_check CHECK (
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

CREATE TABLE IF NOT EXISTS classification_categories (
  id TEXT PRIMARY KEY,
  taxonomy_id TEXT NOT NULL REFERENCES classification_taxonomies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  translations JSONB NOT NULL DEFAULT '{}'::jsonb,
  definition TEXT,
  parent_id TEXT REFERENCES classification_categories(id) ON DELETE SET NULL,
  attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
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
  CONSTRAINT classification_categories_taxonomy_id_id_unique UNIQUE (taxonomy_id, id),
  CONSTRAINT classification_categories_id_required_check CHECK (length(trim(id)) > 0),
  CONSTRAINT classification_categories_code_required_check CHECK (length(trim(code)) > 0),
  CONSTRAINT classification_categories_label_required_check CHECK (length(trim(label)) > 0),
  CONSTRAINT classification_categories_parent_not_self_check CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT classification_categories_status_check CHECK (
    status IN ('active', 'inactive', 'draft', 'deprecated')
  ),
  CONSTRAINT classification_categories_translations_object_check CHECK (jsonb_typeof(translations) = 'object'),
  CONSTRAINT classification_categories_attributes_shape_check CHECK (
    jsonb_typeof(attributes) IN ('array', 'object')
  ),
  CONSTRAINT classification_categories_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT classification_categories_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT classification_categories_sensitivity_metadata_shape_check CHECK (
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

CREATE TABLE IF NOT EXISTS taxonomy_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_taxonomy_id TEXT NOT NULL,
  source_category_id TEXT NOT NULL,
  target_taxonomy_id TEXT NOT NULL,
  target_category_id TEXT NOT NULL,
  mapping_type TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  conditions TEXT,
  rationale TEXT NOT NULL,
  mapping_author TEXT NOT NULL DEFAULT 'human',
  review_status TEXT NOT NULL DEFAULT 'draft',
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
  CONSTRAINT taxonomy_mappings_source_category_fk FOREIGN KEY (source_taxonomy_id, source_category_id)
    REFERENCES classification_categories(taxonomy_id, id) ON DELETE CASCADE,
  CONSTRAINT taxonomy_mappings_target_category_fk FOREIGN KEY (target_taxonomy_id, target_category_id)
    REFERENCES classification_categories(taxonomy_id, id) ON DELETE CASCADE,
  CONSTRAINT taxonomy_mappings_distinct_categories_check CHECK (
    source_taxonomy_id <> target_taxonomy_id OR source_category_id <> target_category_id
  ),
  CONSTRAINT taxonomy_mappings_type_check CHECK (
    mapping_type IN ('equivalent', 'broader', 'narrower', 'overlapping', 'related')
  ),
  CONSTRAINT taxonomy_mappings_confidence_bounds_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT taxonomy_mappings_rationale_required_check CHECK (length(trim(rationale)) > 0),
  CONSTRAINT taxonomy_mappings_author_check CHECK (mapping_author IN ('llm_auto', 'human', 'hybrid')),
  CONSTRAINT taxonomy_mappings_review_status_check CHECK (review_status IN ('draft', 'reviewed', 'contested')),
  CONSTRAINT taxonomy_mappings_provenance_object_check CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT taxonomy_mappings_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT taxonomy_mappings_sensitivity_metadata_shape_check CHECK (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_taxonomies_active_id
  ON classification_taxonomies(id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_taxonomies_status
  ON classification_taxonomies(status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_taxonomies_source_ref
  ON classification_taxonomies(source_ref)
  WHERE source_ref IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_taxonomies_provenance
  ON classification_taxonomies USING GIN (provenance)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_taxonomies_provenance_source_ids
  ON classification_taxonomies USING GIN ((provenance->'source_document_ids'))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_taxonomies_sensitivity_level
  ON classification_taxonomies(sensitivity_level)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_categories_active_id
  ON classification_categories(id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_categories_active_taxonomy_code
  ON classification_categories(taxonomy_id, lower(code))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_taxonomy
  ON classification_categories(taxonomy_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_parent
  ON classification_categories(parent_id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_code
  ON classification_categories(code)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_status
  ON classification_categories(status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_provenance
  ON classification_categories USING GIN (provenance)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_provenance_source_ids
  ON classification_categories USING GIN ((provenance->'source_document_ids'))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_classification_categories_sensitivity_level
  ON classification_categories(sensitivity_level)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_taxonomy_mappings_active_pair_type_conditions
  ON taxonomy_mappings(
    source_taxonomy_id,
    source_category_id,
    target_taxonomy_id,
    target_category_id,
    mapping_type,
    (COALESCE(conditions, ''))
  )
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_source_taxonomy
  ON taxonomy_mappings(source_taxonomy_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_target_taxonomy
  ON taxonomy_mappings(target_taxonomy_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_source_category
  ON taxonomy_mappings(source_category_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_target_category
  ON taxonomy_mappings(target_category_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_mapping_type
  ON taxonomy_mappings(mapping_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_review_status
  ON taxonomy_mappings(review_status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_confidence
  ON taxonomy_mappings(confidence DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_provenance
  ON taxonomy_mappings USING GIN (provenance)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_provenance_source_ids
  ON taxonomy_mappings USING GIN ((provenance->'source_document_ids'))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_taxonomy_mappings_sensitivity_level
  ON taxonomy_mappings(sensitivity_level)
  WHERE deleted_at IS NULL;
