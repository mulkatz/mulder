CREATE TABLE evidence_chains (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis     TEXT NOT NULL,
  path       UUID[] NOT NULL,
  strength   FLOAT NOT NULL,
  supports   BOOLEAN NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now()
);
