CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id        UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  page_start      INTEGER,
  page_end        INTEGER,
  embedding       vector(768),
  fts_vector      tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  is_question     BOOLEAN DEFAULT false,
  parent_chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);
