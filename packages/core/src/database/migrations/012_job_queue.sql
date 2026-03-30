-- Job queue for async API operations (§4.3, §10, §14)
-- Uses FOR UPDATE SKIP LOCKED for dequeue — no Pub/Sub, no Redis

CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'dead_letter');

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          job_status NOT NULL DEFAULT 'pending',
  attempts        INTEGER DEFAULT 0,
  max_attempts    INTEGER DEFAULT 3,
  error_log       TEXT,
  worker_id       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

-- Partial index for efficient dequeue: only pending jobs need fast lookup
CREATE INDEX idx_jobs_queue ON jobs(status, created_at) WHERE status = 'pending';
