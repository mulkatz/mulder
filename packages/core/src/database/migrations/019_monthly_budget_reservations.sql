-- Monthly reservation ledger for API budget gating.
-- Persists reserved, committed, and released spend per accepted API run.

CREATE TABLE monthly_budget_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_month DATE NOT NULL,
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  run_id UUID NOT NULL UNIQUE REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  job_id UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  retry_of_reservation_id UUID REFERENCES monthly_budget_reservations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released', 'reconciled')),
  planned_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  reserved_estimated_usd NUMERIC(12,4) NOT NULL,
  committed_usd NUMERIC(12,4) NOT NULL DEFAULT 0,
  released_usd NUMERIC(12,4) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);

CREATE INDEX idx_monthly_budget_reservations_month_status
  ON monthly_budget_reservations (budget_month, status, created_at DESC);

CREATE INDEX idx_monthly_budget_reservations_source_created
  ON monthly_budget_reservations (source_id, created_at DESC);
