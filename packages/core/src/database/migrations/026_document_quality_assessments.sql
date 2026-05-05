CREATE TABLE IF NOT EXISTS document_quality_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assessment_method TEXT NOT NULL,
  overall_quality TEXT NOT NULL,
  processable BOOLEAN NOT NULL,
  recommended_path TEXT NOT NULL,
  dimensions JSONB NOT NULL,
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_quality_assessments_method_check CHECK (
    assessment_method IN ('automated', 'human')
  ),
  CONSTRAINT document_quality_assessments_quality_check CHECK (
    overall_quality IN ('high', 'medium', 'low', 'unusable')
  ),
  CONSTRAINT document_quality_assessments_path_check CHECK (
    recommended_path IN (
      'standard',
      'enhanced_ocr',
      'visual_extraction',
      'handwriting_recognition',
      'manual_transcription_required',
      'skip'
    )
  ),
  CONSTRAINT document_quality_assessments_dimensions_object_check CHECK (
    jsonb_typeof(dimensions) = 'object'
  ),
  CONSTRAINT document_quality_assessments_signals_object_check CHECK (
    jsonb_typeof(signals) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS idx_document_quality_assessments_source_assessed_at
  ON document_quality_assessments(source_id, assessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_quality_assessments_overall_quality
  ON document_quality_assessments(overall_quality);

CREATE INDEX IF NOT EXISTS idx_document_quality_assessments_recommended_path
  ON document_quality_assessments(recommended_path);

CREATE INDEX IF NOT EXISTS idx_document_quality_assessments_processable
  ON document_quality_assessments(processable);
