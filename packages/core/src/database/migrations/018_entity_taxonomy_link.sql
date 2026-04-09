-- Link entities to their normalized taxonomy entry. The enrich step's
-- taxonomy normalization picks a canonical entry for each entity name; this
-- column persists that link so cross-story queries can group by taxonomy_id
-- (e.g. find every story mentioning "Allan Hendry" regardless of which
-- variant the source used).
--
-- ON DELETE SET NULL because deleting a taxonomy entry should not cascade
-- into the entities table — the entity row itself is still valid even if
-- its canonical taxonomy mapping is removed.
ALTER TABLE entities ADD COLUMN taxonomy_id UUID REFERENCES taxonomy(id) ON DELETE SET NULL;

-- Index for cross-story grouping queries by taxonomy entry.
CREATE INDEX idx_entities_taxonomy_id ON entities (taxonomy_id) WHERE taxonomy_id IS NOT NULL;
