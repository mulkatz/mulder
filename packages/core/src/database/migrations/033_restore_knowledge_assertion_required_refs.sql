ALTER TABLE knowledge_assertions
  DROP CONSTRAINT IF EXISTS knowledge_assertions_source_id_fkey,
  DROP CONSTRAINT IF EXISTS knowledge_assertions_story_id_fkey,
  ALTER COLUMN source_id SET NOT NULL,
  ALTER COLUMN story_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_assertions_source_id_fkey'
      AND conrelid = 'knowledge_assertions'::regclass
  ) THEN
    ALTER TABLE knowledge_assertions
      ADD CONSTRAINT knowledge_assertions_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'knowledge_assertions_story_id_fkey'
      AND conrelid = 'knowledge_assertions'::regclass
  ) THEN
    ALTER TABLE knowledge_assertions
      ADD CONSTRAINT knowledge_assertions_story_id_fkey
      FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE;
  END IF;
END;
$$;
