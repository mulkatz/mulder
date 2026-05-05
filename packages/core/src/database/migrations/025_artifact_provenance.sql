-- Structured provenance for currently persisted artifacts.

ALTER TABLE entities
  ADD COLUMN provenance JSONB NOT NULL DEFAULT jsonb_build_object(
    'source_document_ids', '[]'::jsonb,
    'extraction_pipeline_run', NULL,
    'created_at', to_jsonb(now())
  );

ALTER TABLE entity_aliases
  ADD COLUMN provenance JSONB NOT NULL DEFAULT jsonb_build_object(
    'source_document_ids', '[]'::jsonb,
    'extraction_pipeline_run', NULL,
    'created_at', to_jsonb(now())
  );

ALTER TABLE entity_edges
  ADD COLUMN provenance JSONB NOT NULL DEFAULT jsonb_build_object(
    'source_document_ids', '[]'::jsonb,
    'extraction_pipeline_run', NULL,
    'created_at', to_jsonb(now())
  );

ALTER TABLE story_entities
  ADD COLUMN provenance JSONB NOT NULL DEFAULT jsonb_build_object(
    'source_document_ids', '[]'::jsonb,
    'extraction_pipeline_run', NULL,
    'created_at', to_jsonb(now())
  );

ALTER TABLE chunks
  ADD COLUMN provenance JSONB NOT NULL DEFAULT jsonb_build_object(
    'source_document_ids', '[]'::jsonb,
    'extraction_pipeline_run', NULL,
    'created_at', to_jsonb(now())
  );

-- Preserve row creation timestamps where the artifact table already has one.
UPDATE entities
SET provenance = jsonb_build_object(
  'source_document_ids', '[]'::jsonb,
  'extraction_pipeline_run', NULL,
  'created_at', to_jsonb(COALESCE(created_at, now()))
);

UPDATE entity_edges
SET provenance = jsonb_build_object(
  'source_document_ids', '[]'::jsonb,
  'extraction_pipeline_run', NULL,
  'created_at', to_jsonb(COALESCE(created_at, now()))
);

UPDATE chunks
SET provenance = jsonb_build_object(
  'source_document_ids', '[]'::jsonb,
  'extraction_pipeline_run', NULL,
  'created_at', to_jsonb(COALESCE(created_at, now()))
);

-- Backfill story-scoped artifacts from their owning story source.
UPDATE chunks c
SET provenance = jsonb_set(
  c.provenance,
  '{source_document_ids}',
  jsonb_build_array(s.source_id::text),
  true
)
FROM stories s
WHERE s.id = c.story_id;

UPDATE story_entities se
SET provenance = jsonb_build_object(
  'source_document_ids', jsonb_build_array(s.source_id::text),
  'extraction_pipeline_run', NULL,
  'created_at', to_jsonb(now())
)
FROM stories s
WHERE s.id = se.story_id;

UPDATE entity_edges ee
SET provenance = jsonb_set(
  ee.provenance,
  '{source_document_ids}',
  jsonb_build_array(s.source_id::text),
  true
)
FROM stories s
WHERE s.id = ee.story_id;

-- Backfill shared entities from all story links, then let aliases inherit.
WITH entity_sources AS (
  SELECT
    se.entity_id,
    jsonb_agg(DISTINCT s.source_id::text ORDER BY s.source_id::text) AS source_document_ids
  FROM story_entities se
  JOIN stories s ON s.id = se.story_id
  GROUP BY se.entity_id
)
UPDATE entities e
SET provenance = jsonb_set(
  e.provenance,
  '{source_document_ids}',
  entity_sources.source_document_ids,
  true
)
FROM entity_sources
WHERE entity_sources.entity_id = e.id;

UPDATE entity_aliases ea
SET provenance = jsonb_build_object(
  'source_document_ids', COALESCE(e.provenance->'source_document_ids', '[]'::jsonb),
  'extraction_pipeline_run', NULL,
  'created_at', to_jsonb(now())
)
FROM entities e
WHERE e.id = ea.entity_id;

ALTER TABLE entities
  ADD CONSTRAINT entities_provenance_shape CHECK (
    provenance ? 'source_document_ids'
    AND provenance ? 'extraction_pipeline_run'
    AND provenance ? 'created_at'
    AND jsonb_typeof(provenance->'source_document_ids') = 'array'
    AND (jsonb_typeof(provenance->'extraction_pipeline_run') = 'string' OR provenance->'extraction_pipeline_run' = 'null'::jsonb)
    AND jsonb_typeof(provenance->'created_at') = 'string'
  );

ALTER TABLE entity_aliases
  ADD CONSTRAINT entity_aliases_provenance_shape CHECK (
    provenance ? 'source_document_ids'
    AND provenance ? 'extraction_pipeline_run'
    AND provenance ? 'created_at'
    AND jsonb_typeof(provenance->'source_document_ids') = 'array'
    AND (jsonb_typeof(provenance->'extraction_pipeline_run') = 'string' OR provenance->'extraction_pipeline_run' = 'null'::jsonb)
    AND jsonb_typeof(provenance->'created_at') = 'string'
  );

ALTER TABLE entity_edges
  ADD CONSTRAINT entity_edges_provenance_shape CHECK (
    provenance ? 'source_document_ids'
    AND provenance ? 'extraction_pipeline_run'
    AND provenance ? 'created_at'
    AND jsonb_typeof(provenance->'source_document_ids') = 'array'
    AND (jsonb_typeof(provenance->'extraction_pipeline_run') = 'string' OR provenance->'extraction_pipeline_run' = 'null'::jsonb)
    AND jsonb_typeof(provenance->'created_at') = 'string'
  );

ALTER TABLE story_entities
  ADD CONSTRAINT story_entities_provenance_shape CHECK (
    provenance ? 'source_document_ids'
    AND provenance ? 'extraction_pipeline_run'
    AND provenance ? 'created_at'
    AND jsonb_typeof(provenance->'source_document_ids') = 'array'
    AND (jsonb_typeof(provenance->'extraction_pipeline_run') = 'string' OR provenance->'extraction_pipeline_run' = 'null'::jsonb)
    AND jsonb_typeof(provenance->'created_at') = 'string'
  );

ALTER TABLE chunks
  ADD CONSTRAINT chunks_provenance_shape CHECK (
    provenance ? 'source_document_ids'
    AND provenance ? 'extraction_pipeline_run'
    AND provenance ? 'created_at'
    AND jsonb_typeof(provenance->'source_document_ids') = 'array'
    AND (jsonb_typeof(provenance->'extraction_pipeline_run') = 'string' OR provenance->'extraction_pipeline_run' = 'null'::jsonb)
    AND jsonb_typeof(provenance->'created_at') = 'string'
  );

CREATE INDEX idx_entities_provenance_source_ids
  ON entities USING gin ((provenance->'source_document_ids'));

CREATE INDEX idx_entity_aliases_provenance_source_ids
  ON entity_aliases USING gin ((provenance->'source_document_ids'));

CREATE INDEX idx_entity_edges_provenance_source_ids
  ON entity_edges USING gin ((provenance->'source_document_ids'));

CREATE INDEX idx_story_entities_provenance_source_ids
  ON story_entities USING gin ((provenance->'source_document_ids'));

CREATE INDEX idx_chunks_provenance_source_ids
  ON chunks USING gin ((provenance->'source_document_ids'));
