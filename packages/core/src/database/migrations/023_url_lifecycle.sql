CREATE TABLE IF NOT EXISTS url_host_lifecycle (
  host TEXT PRIMARY KEY,
  minimum_delay_ms INTEGER NOT NULL DEFAULT 1000 CHECK (minimum_delay_ms >= 0),
  last_request_at TIMESTAMPTZ,
  next_allowed_at TIMESTAMPTZ,
  last_robots_checked_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS url_lifecycle (
  source_id UUID PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  host TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at TIMESTAMPTZ NOT NULL,
  last_checked_at TIMESTAMPTZ NOT NULL,
  next_fetch_after TIMESTAMPTZ,
  last_http_status INTEGER,
  robots_allowed BOOLEAN NOT NULL DEFAULT true,
  robots_url TEXT,
  robots_checked_at TIMESTAMPTZ,
  robots_matched_user_agent TEXT,
  robots_matched_rule TEXT,
  redirect_count INTEGER NOT NULL DEFAULT 0 CHECK (redirect_count >= 0),
  content_type TEXT,
  rendering_method TEXT,
  snapshot_encoding TEXT,
  last_content_hash TEXT NOT NULL,
  last_snapshot_storage_path TEXT NOT NULL,
  fetch_count INTEGER NOT NULL DEFAULT 0 CHECK (fetch_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  changed_count INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  last_change_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_url_lifecycle_host ON url_lifecycle(host);
CREATE INDEX IF NOT EXISTS idx_url_lifecycle_next_fetch_after ON url_lifecycle(next_fetch_after);
CREATE INDEX IF NOT EXISTS idx_url_host_lifecycle_next_allowed_at ON url_host_lifecycle(next_allowed_at);
