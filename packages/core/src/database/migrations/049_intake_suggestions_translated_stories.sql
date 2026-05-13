CREATE TABLE IF NOT EXISTS intake_enrichment_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_hash TEXT,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  suggested_payload JSONB NOT NULL,
  field_confidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_by JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intake_enrichment_suggestions_payload_object_check CHECK (jsonb_typeof(suggested_payload) = 'object'),
  CONSTRAINT intake_enrichment_suggestions_confidence_object_check CHECK (jsonb_typeof(field_confidence) = 'object'),
  CONSTRAINT intake_enrichment_suggestions_warnings_array_check CHECK (jsonb_typeof(warnings) = 'array'),
  CONSTRAINT intake_enrichment_suggestions_requested_by_object_check CHECK (jsonb_typeof(requested_by) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_intake_enrichment_suggestions_source
  ON intake_enrichment_suggestions(source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_intake_enrichment_suggestions_storage
  ON intake_enrichment_suggestions(storage_path, created_at DESC);

CREATE TABLE IF NOT EXISTS translated_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  translation_id UUID NOT NULL REFERENCES translated_documents(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  source_document_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  markdown TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  sensitivity_level TEXT NOT NULL DEFAULT 'internal',
  sensitivity_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT translated_stories_language_check CHECK (length(trim(source_language)) > 0 AND length(trim(target_language)) > 0),
  CONSTRAINT translated_stories_content_hash_check CHECK (length(trim(content_hash)) > 0),
  CONSTRAINT translated_stories_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT translated_stories_sensitivity_metadata_object_check CHECK (jsonb_typeof(sensitivity_metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_translated_stories_translation_story
  ON translated_stories(translation_id, story_id);

CREATE INDEX IF NOT EXISTS idx_translated_stories_translation
  ON translated_stories(translation_id);

CREATE INDEX IF NOT EXISTS idx_translated_stories_source
  ON translated_stories(source_document_id);

CREATE TABLE IF NOT EXISTS translated_story_entity_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  translated_story_id UUID NOT NULL REFERENCES translated_stories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  surface_text TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  confidence FLOAT,
  method TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT translated_story_entity_mentions_offsets_check CHECK (
    start_offset >= 0 AND end_offset > start_offset
  ),
  CONSTRAINT translated_story_entity_mentions_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT translated_story_entity_mentions_method_check CHECK (
    method IN ('llm_structured_verified')
  )
);

CREATE INDEX IF NOT EXISTS idx_translated_story_entity_mentions_story
  ON translated_story_entity_mentions(translated_story_id);

CREATE INDEX IF NOT EXISTS idx_translated_story_entity_mentions_entity
  ON translated_story_entity_mentions(entity_id);
