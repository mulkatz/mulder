ALTER TABLE sources
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deletion_status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE sources
  ADD COLUMN active_source BOOLEAN GENERATED ALWAYS AS (
    deletion_status IN ('active', 'restored')
  ) STORED;

ALTER TABLE sources
  ADD CONSTRAINT sources_deletion_status_check CHECK (
    deletion_status IN ('active', 'soft_deleted', 'purging', 'purged', 'restored')
  );

CREATE TABLE source_deletions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  deleted_by TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'soft_deleted',
  undo_deadline TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_deletions_status_check CHECK (
    status IN ('soft_deleted', 'purging', 'purged', 'restored')
  ),
  CONSTRAINT source_deletions_reason_required_check CHECK (length(trim(reason)) > 0)
);

CREATE UNIQUE INDEX idx_source_deletions_current
  ON source_deletions(source_id)
  WHERE status IN ('soft_deleted', 'purging');

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_id TEXT,
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_sources_active_source ON sources(active_source);
CREATE INDEX idx_sources_deletion_status ON sources(deletion_status);
CREATE INDEX idx_source_deletions_status_undo_deadline
  ON source_deletions(status, undo_deadline);
CREATE INDEX idx_source_deletions_source_id ON source_deletions(source_id);
CREATE INDEX idx_audit_log_source_created_at ON audit_log(source_id, created_at DESC);
CREATE INDEX idx_audit_log_event_type_created_at ON audit_log(event_type, created_at DESC);
