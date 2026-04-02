-- Partial unique index for idempotent entity upsert by name+type.
-- Only applies to canonical entities (canonical_id IS NULL).
-- Merged/alias entities may share the same name+type as their canonical.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type_canonical
  ON entities(name, type)
  WHERE canonical_id IS NULL;
