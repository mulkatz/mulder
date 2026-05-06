DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'acquisition_contexts'::regclass
      AND conname = 'acquisition_contexts_blob_content_hash_fkey'
      AND contype = 'f'
      AND confrelid = 'document_blobs'::regclass
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE acquisition_contexts
      DROP CONSTRAINT acquisition_contexts_blob_content_hash_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'acquisition_contexts'::regclass
      AND contype = 'f'
      AND confrelid = 'document_blobs'::regclass
  ) THEN
    ALTER TABLE acquisition_contexts
      ADD CONSTRAINT acquisition_contexts_blob_content_hash_fkey
      FOREIGN KEY (blob_content_hash) REFERENCES document_blobs(content_hash) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'archive_locations'::regclass
      AND conname = 'archive_locations_blob_content_hash_fkey'
      AND contype = 'f'
      AND confrelid = 'document_blobs'::regclass
      AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE archive_locations
      DROP CONSTRAINT archive_locations_blob_content_hash_fkey;
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
      FOREIGN KEY (blob_content_hash) REFERENCES document_blobs(content_hash) ON DELETE CASCADE;
  END IF;
END;
$$;
