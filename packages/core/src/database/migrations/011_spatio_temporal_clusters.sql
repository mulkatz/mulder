CREATE TABLE spatio_temporal_clusters (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_lat   FLOAT,
  center_lng   FLOAT,
  time_start   TIMESTAMPTZ,
  time_end     TIMESTAMPTZ,
  event_count  INTEGER NOT NULL,
  event_ids    UUID[] NOT NULL,
  cluster_type TEXT,
  computed_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE entities ADD COLUMN geom geometry(Point, 4326);
CREATE INDEX idx_entities_geom ON entities USING GIST(geom);
