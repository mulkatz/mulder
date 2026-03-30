CREATE TABLE stories (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id             UUID NOT NULL REFERENCES sources(id),
  title                 TEXT NOT NULL,
  subtitle              TEXT,
  language              TEXT,
  category              TEXT,
  page_start            INTEGER,
  page_end              INTEGER,
  gcs_markdown_uri      TEXT NOT NULL,
  gcs_metadata_uri      TEXT NOT NULL,
  chunk_count           INTEGER DEFAULT 0,
  extraction_confidence FLOAT,
  status                TEXT NOT NULL DEFAULT 'segmented',
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
