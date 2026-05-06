CREATE TABLE IF NOT EXISTS archives (
  archive_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'other',
  institution TEXT,
  custodian TEXT,
  physical_address TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  structure_description TEXT,
  estimated_document_count INTEGER CHECK (estimated_document_count IS NULL OR estimated_document_count >= 0),
  languages TEXT[] NOT NULL DEFAULT '{}',
  date_range_earliest DATE,
  date_range_latest DATE,
  total_documents_known INTEGER CHECK (total_documents_known IS NULL OR total_documents_known >= 0),
  total_documents_ingested INTEGER NOT NULL DEFAULT 0 CHECK (total_documents_ingested >= 0),
  last_ingest_date TIMESTAMPTZ,
  completeness TEXT NOT NULL DEFAULT 'unknown',
  ingest_notes TEXT,
  access_restrictions TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT archives_name_unique UNIQUE (name),
  CONSTRAINT archives_type_check CHECK (type IN ('personal', 'institutional', 'digital', 'governmental', 'partner', 'other')),
  CONSTRAINT archives_status_check CHECK (status IN ('active', 'closed', 'destroyed', 'transferred', 'unknown')),
  CONSTRAINT archives_completeness_check CHECK (completeness IN ('unknown', 'partial', 'complete')),
  CONSTRAINT archives_date_range_check CHECK (
    date_range_earliest IS NULL OR date_range_latest IS NULL OR date_range_earliest <= date_range_latest
  )
);

CREATE TABLE IF NOT EXISTS acquisition_contexts (
  context_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_content_hash TEXT NOT NULL REFERENCES document_blobs(content_hash),
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  submitted_by_user_id TEXT NOT NULL,
  submitted_by_type TEXT NOT NULL,
  submitted_by_role TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  collection_id UUID,
  submission_notes TEXT,
  submission_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  authenticity_status TEXT NOT NULL DEFAULT 'unverified',
  authenticity_notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  deleted_at TIMESTAMPTZ,
  restored_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_contexts_channel_check CHECK (
    channel IN (
      'archive_import',
      'manual_upload',
      'email_submission',
      'web_research',
      'api_import',
      'bulk_import',
      're_scan',
      'partner_exchange'
    )
  ),
  CONSTRAINT acquisition_contexts_submitter_type_check CHECK (submitted_by_type IN ('human', 'system')),
  CONSTRAINT acquisition_contexts_submission_metadata_object_check CHECK (jsonb_typeof(submission_metadata) = 'object'),
  CONSTRAINT acquisition_contexts_authenticity_status_check CHECK (
    authenticity_status IN ('unverified', 'verified', 'disputed')
  ),
  CONSTRAINT acquisition_contexts_status_check CHECK (status IN ('active', 'deleted', 'restored'))
);

CREATE TABLE IF NOT EXISTS original_sources (
  original_source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID NOT NULL UNIQUE REFERENCES acquisition_contexts(context_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_description TEXT NOT NULL,
  source_date DATE,
  source_author TEXT,
  source_language TEXT NOT NULL DEFAULT 'und',
  source_institution TEXT,
  foia_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT original_sources_source_type_check CHECK (
    source_type IN (
      'witness_report',
      'government_document',
      'academic_paper',
      'news_article',
      'correspondence',
      'field_notes',
      'measurement_data',
      'photograph',
      'audio_recording',
      'video_recording',
      'other'
    )
  ),
  CONSTRAINT original_sources_description_required_check CHECK (length(trim(source_description)) > 0)
);

CREATE TABLE IF NOT EXISTS custody_steps (
  custody_step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID NOT NULL REFERENCES acquisition_contexts(context_id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL CHECK (step_order > 0),
  holder TEXT NOT NULL,
  holder_type TEXT NOT NULL DEFAULT 'unknown',
  received_from TEXT,
  held_from DATE,
  held_until DATE,
  actions TEXT[] NOT NULL DEFAULT '{}',
  location TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT custody_steps_context_order_unique UNIQUE (context_id, step_order),
  CONSTRAINT custody_steps_holder_required_check CHECK (length(trim(holder)) > 0),
  CONSTRAINT custody_steps_holder_type_check CHECK (holder_type IN ('person', 'institution', 'archive', 'unknown')),
  CONSTRAINT custody_steps_actions_check CHECK (
    actions <@ ARRAY[
      'received',
      'copied',
      'digitized',
      'annotated',
      'translated',
      'redacted',
      'restored',
      'transferred',
      'archived'
    ]::TEXT[]
  ),
  CONSTRAINT custody_steps_date_order_check CHECK (held_from IS NULL OR held_until IS NULL OR held_from <= held_until)
);

CREATE TABLE IF NOT EXISTS archive_locations (
  location_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_content_hash TEXT NOT NULL REFERENCES document_blobs(content_hash),
  archive_id UUID NOT NULL REFERENCES archives(archive_id),
  original_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  path_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
  physical_location JSONB,
  source_status TEXT NOT NULL DEFAULT 'current',
  source_status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT archive_locations_path_segments_array_check CHECK (jsonb_typeof(path_segments) = 'array'),
  CONSTRAINT archive_locations_physical_location_object_check CHECK (
    physical_location IS NULL OR jsonb_typeof(physical_location) = 'object'
  ),
  CONSTRAINT archive_locations_source_status_check CHECK (
    source_status IN ('current', 'moved', 'deleted_from_source', 'archive_destroyed', 'digitized_only', 'unknown')
  ),
  CONSTRAINT archive_locations_validity_check CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_locations_unique_path
  ON archive_locations(blob_content_hash, archive_id, original_path, original_filename);

CREATE INDEX IF NOT EXISTS idx_archives_status ON archives(status);
CREATE INDEX IF NOT EXISTS idx_archives_type ON archives(type);
CREATE INDEX IF NOT EXISTS idx_acquisition_contexts_blob ON acquisition_contexts(blob_content_hash);
CREATE INDEX IF NOT EXISTS idx_acquisition_contexts_source ON acquisition_contexts(source_id);
CREATE INDEX IF NOT EXISTS idx_acquisition_contexts_active_blob
  ON acquisition_contexts(blob_content_hash, submitted_at DESC)
  WHERE status IN ('active', 'restored');
CREATE INDEX IF NOT EXISTS idx_acquisition_contexts_collection ON acquisition_contexts(collection_id);
CREATE INDEX IF NOT EXISTS idx_original_sources_context ON original_sources(context_id);
CREATE INDEX IF NOT EXISTS idx_custody_steps_context_order ON custody_steps(context_id, step_order);
CREATE INDEX IF NOT EXISTS idx_archive_locations_blob ON archive_locations(blob_content_hash);
CREATE INDEX IF NOT EXISTS idx_archive_locations_archive ON archive_locations(archive_id);
CREATE INDEX IF NOT EXISTS idx_archive_locations_path_segments ON archive_locations USING GIN (path_segments);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'acquisition_contexts'::regclass
      AND contype = 'f'
      AND confrelid = 'document_blobs'::regclass
  ) THEN
    ALTER TABLE acquisition_contexts
      ADD CONSTRAINT acquisition_contexts_blob_content_hash_fkey
      FOREIGN KEY (blob_content_hash) REFERENCES document_blobs(content_hash);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'acquisition_contexts'::regclass
      AND contype = 'f'
      AND confrelid = 'sources'::regclass
  ) THEN
    ALTER TABLE acquisition_contexts
      ADD CONSTRAINT acquisition_contexts_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'original_sources'::regclass
      AND contype = 'f'
      AND confrelid = 'acquisition_contexts'::regclass
  ) THEN
    ALTER TABLE original_sources
      ADD CONSTRAINT original_sources_context_id_fkey
      FOREIGN KEY (context_id) REFERENCES acquisition_contexts(context_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'custody_steps'::regclass
      AND contype = 'f'
      AND confrelid = 'acquisition_contexts'::regclass
  ) THEN
    ALTER TABLE custody_steps
      ADD CONSTRAINT custody_steps_context_id_fkey
      FOREIGN KEY (context_id) REFERENCES acquisition_contexts(context_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'archive_locations'::regclass
      AND contype = 'f'
      AND confrelid = 'document_blobs'::regclass
  ) THEN
    ALTER TABLE archive_locations
      ADD CONSTRAINT archive_locations_blob_content_hash_fkey
      FOREIGN KEY (blob_content_hash) REFERENCES document_blobs(content_hash);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'archive_locations'::regclass
      AND contype = 'f'
      AND confrelid = 'archives'::regclass
  ) THEN
    ALTER TABLE archive_locations
      ADD CONSTRAINT archive_locations_archive_id_fkey
      FOREIGN KEY (archive_id) REFERENCES archives(archive_id);
  END IF;
END;
$$;
