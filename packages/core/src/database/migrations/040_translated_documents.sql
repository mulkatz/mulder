CREATE TABLE IF NOT EXISTS translated_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_document_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  translation_engine TEXT NOT NULL,
  translation_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current',
  pipeline_path TEXT NOT NULL,
  output_format TEXT NOT NULL DEFAULT 'markdown',
  sensitivity_level TEXT NOT NULL DEFAULT 'internal',
  sensitivity_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT translated_documents_source_language_required_check CHECK (length(trim(source_language)) > 0),
  CONSTRAINT translated_documents_target_language_required_check CHECK (length(trim(target_language)) > 0),
  CONSTRAINT translated_documents_engine_required_check CHECK (length(trim(translation_engine)) > 0),
  CONSTRAINT translated_documents_content_hash_required_check CHECK (length(trim(content_hash)) > 0),
  CONSTRAINT translated_documents_status_check CHECK (status IN ('current', 'stale')),
  CONSTRAINT translated_documents_pipeline_path_check CHECK (pipeline_path IN ('full', 'translation_only')),
  CONSTRAINT translated_documents_output_format_check CHECK (output_format IN ('markdown', 'html')),
  CONSTRAINT translated_documents_sensitivity_level_check CHECK (
    sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT translated_documents_sensitivity_metadata_object_check CHECK (jsonb_typeof(sensitivity_metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_translated_documents_current_source_target
  ON translated_documents(source_document_id, target_language)
  WHERE status = 'current';

CREATE INDEX IF NOT EXISTS idx_translated_documents_source
  ON translated_documents(source_document_id);
CREATE INDEX IF NOT EXISTS idx_translated_documents_target_status
  ON translated_documents(target_language, status);
CREATE INDEX IF NOT EXISTS idx_translated_documents_stale
  ON translated_documents(source_document_id, updated_at DESC)
  WHERE status = 'stale';
CREATE INDEX IF NOT EXISTS idx_translated_documents_content_hash
  ON translated_documents(content_hash);
