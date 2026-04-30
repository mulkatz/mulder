DO $$
BEGIN
  CREATE TYPE source_type AS ENUM ('pdf', 'image', 'text', 'docx', 'spreadsheet', 'email', 'url');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS source_type source_type NOT NULL DEFAULT 'pdf',
  ADD COLUMN IF NOT EXISTS format_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE sources
SET format_metadata = COALESCE(metadata, '{}'::jsonb)
WHERE source_type = 'pdf'
  AND format_metadata = '{}'::jsonb
  AND COALESCE(metadata, '{}'::jsonb) <> '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sources_source_type ON sources(source_type);
