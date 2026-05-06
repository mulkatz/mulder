CREATE TABLE IF NOT EXISTS collections (
  collection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'other',
  archive_id UUID REFERENCES archives(archive_id) ON DELETE SET NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  visibility TEXT NOT NULL DEFAULT 'private',
  tags TEXT[] NOT NULL DEFAULT '{}',
  default_sensitivity_level TEXT NOT NULL DEFAULT 'internal',
  default_language TEXT NOT NULL DEFAULT 'und',
  default_credibility_profile_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT collections_name_unique UNIQUE (name),
  CONSTRAINT collections_name_required_check CHECK (length(trim(name)) > 0),
  CONSTRAINT collections_created_by_required_check CHECK (length(trim(created_by)) > 0),
  CONSTRAINT collections_type_check CHECK (type IN ('archive_mirror', 'thematic', 'import_batch', 'curated', 'other')),
  CONSTRAINT collections_visibility_check CHECK (visibility IN ('private', 'team', 'public')),
  CONSTRAINT collections_tags_array_check CHECK (tags IS NOT NULL),
  CONSTRAINT collections_default_sensitivity_level_check CHECK (
    default_sensitivity_level IN ('public', 'internal', 'restricted', 'confidential')
  ),
  CONSTRAINT collections_default_language_required_check CHECK (length(trim(default_language)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_archive_mirror_unique
  ON collections(archive_id)
  WHERE type = 'archive_mirror' AND archive_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_collections_archive ON collections(archive_id);
CREATE INDEX IF NOT EXISTS idx_collections_type_visibility ON collections(type, visibility);
CREATE INDEX IF NOT EXISTS idx_collections_name_search ON collections USING GIN (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS idx_collections_tags ON collections USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_collections_created_at ON collections(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'acquisition_contexts'
      AND column_name = 'collection_id'
  ) THEN
    ALTER TABLE acquisition_contexts ADD COLUMN collection_id UUID;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'acquisition_contexts'::regclass
      AND conname = 'acquisition_contexts_collection_id_fkey'
      AND contype = 'f'
      AND confrelid <> 'collections'::regclass
  ) THEN
    ALTER TABLE acquisition_contexts
      DROP CONSTRAINT acquisition_contexts_collection_id_fkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'acquisition_contexts'::regclass
      AND conname = 'acquisition_contexts_collection_id_fkey'
      AND contype = 'f'
      AND confrelid = 'collections'::regclass
  ) THEN
    ALTER TABLE acquisition_contexts
      ADD CONSTRAINT acquisition_contexts_collection_id_fkey
      FOREIGN KEY (collection_id) REFERENCES collections(collection_id) ON DELETE SET NULL;
  END IF;
END;
$$;
