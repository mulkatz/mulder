CREATE TABLE IF NOT EXISTS document_blobs (
  content_hash TEXT PRIMARY KEY,
  mulder_blob_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  storage_path TEXT NOT NULL UNIQUE,
  storage_uri TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
  storage_class TEXT NOT NULL DEFAULT 'standard' CHECK (storage_class IN ('standard', 'nearline', 'coldline', 'archive')),
  storage_status TEXT NOT NULL DEFAULT 'active' CHECK (storage_status IN ('active', 'cold_storage', 'pending_deletion', 'deleted')),
  original_filenames TEXT[] NOT NULL DEFAULT '{}',
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  integrity_verified_at TIMESTAMPTZ,
  integrity_status TEXT NOT NULL DEFAULT 'unverified' CHECK (integrity_status IN ('verified', 'unverified', 'corrupted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_blobs_storage_status ON document_blobs(storage_status);
CREATE INDEX IF NOT EXISTS idx_document_blobs_last_accessed_at ON document_blobs(last_accessed_at);
