UPDATE classification_categories child
SET parent_id = NULL,
    updated_at = now()
WHERE child.parent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM classification_categories parent
    WHERE parent.taxonomy_id = child.taxonomy_id
      AND parent.id = child.parent_id
  );

ALTER TABLE classification_categories
  DROP CONSTRAINT IF EXISTS classification_categories_parent_id_fkey;

ALTER TABLE classification_categories
  DROP CONSTRAINT IF EXISTS classification_categories_parent_same_taxonomy_fk;

ALTER TABLE classification_categories
  ADD CONSTRAINT classification_categories_parent_same_taxonomy_fk
  FOREIGN KEY (taxonomy_id, parent_id)
  REFERENCES classification_categories(taxonomy_id, id)
  ON DELETE SET NULL (parent_id);
