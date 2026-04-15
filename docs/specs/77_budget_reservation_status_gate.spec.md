---
spec: 77
title: Monthly budget reservation ledger and API status gate
roadmap_step: ""
functional_spec: ["§3.2", "§4.3", "§10.6", "§16.2", "§16.3"]
scope: phased
issue: https://github.com/mulkatz/mulder/issues/194
created: 2026-04-15
---

# Spec 77: Monthly budget reservation ledger and API status gate

## 1. Objective

Define and implement the H11 monthly budget gate so accepted API work cannot consume the same estimated spend forever. The system must reserve estimated spend when a pipeline run is accepted, reconcile that reservation when the run finishes, release unused budget for canceled or unstarted work, and expose a deterministic budget snapshot from `GET /api/status`.

This spec fulfills the issue-driven H11 follow-up in [#194](https://github.com/mulkatz/mulder/issues/194). It uses the existing API and pipeline-run infrastructure from `§10.6`, the `pipeline_runs` / `pipeline_run_sources` progress model from `§3.2` and `§4.3`, and the cost-safety intent from `§16.2` and `§16.3`.

## 2. Boundaries

### In scope
- Authoritative monthly reservation storage in PostgreSQL
- A server-side estimate model for API-accepted pipeline runs
- Reservation lifecycle rules for accepted, completed, failed, partial, retried, and never-started work
- Deterministic budget gating for `POST /api/pipeline/run` and `POST /api/pipeline/retry`
- `GET /api/status` response contract for reserved, committed, released, and remaining budget
- Black-box and repository-level tests covering accepted, failed, partial, and retried runs

### Out of scope
- Browser upload transport, body-limit exceptions, or signed upload flows
- Browser auth/session design for `apps/web/v1`
- Observability/timeline aggregation beyond the budget fields in `GET /api/status`
- Provider-billing reconciliation against actual GCP invoices
- CLI cost estimation (`M8-I2`) or Terraform billing alerts (`M8-I3`)
- Multi-source batch reservations; this spec covers the current API shape of one source per accepted run

### Constraints
- The server, not the client, owns the estimate used for gating
- Budget math must be reproducible from persisted rows only
- Retries must not double-charge work already committed by a prior failed attempt
- Failed or partial runs must release unconsumed budget promptly enough that the gate reflects real remaining headroom

## 3. Dependencies

### Requires
- Spec 71 async pipeline API routes
- Spec 72 job status API
- Pipeline-run repository and worker execution flow
- Source metadata already stored on `sources` (`page_count`, `has_native_text`, `status`)

### Provides
- Monthly reservation ledger and reconciliation rules for H11
- `GET /api/status` budget contract
- A shared budget gate the future upload/auth/UI work can call without re-defining semantics

### Follow-up links
- Issue #193 remains the observability/timeline follow-up
- Issue #195 remains the browser auth follow-up
- Issue #197 remains the upload transport/body-limit follow-up

## 4. Blueprint

### 4.1 Authoritative storage model

Add a new PostgreSQL table `monthly_budget_reservations` with one row per accepted API run:

- `id UUID PRIMARY KEY`
- `budget_month DATE NOT NULL`
- `source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE`
- `run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE UNIQUE`
- `job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE UNIQUE`
- `retry_of_reservation_id UUID NULL REFERENCES monthly_budget_reservations(id) ON DELETE SET NULL`
- `status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released', 'reconciled'))`
- `planned_steps JSONB NOT NULL`
- `reserved_estimated_usd NUMERIC(12,4) NOT NULL`
- `committed_usd NUMERIC(12,4) NOT NULL DEFAULT 0`
- `released_usd NUMERIC(12,4) NOT NULL DEFAULT 0`
- `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `finalized_at TIMESTAMPTZ NULL`

Storage rules:
- `reserved_estimated_usd = committed_usd + released_usd` once the row leaves `reserved`
- `status='committed'` means the full reservation was consumed
- `status='released'` means none of the reservation was consumed
- `status='reconciled'` means some was consumed and some was released
- The table is the sole source of truth for monthly reserved/committed/released math

### 4.2 Server-side estimate model

Add `api.budget` config with these defaults:

```yaml
api:
  budget:
    enabled: true
    monthly_limit_usd: 50
    extract_per_page_usd: 0.0060
    segment_per_page_usd: 0.0020
    enrich_per_source_usd: 0.0150
    embed_per_source_usd: 0.0040
    graph_per_source_usd: 0.0010
```

Estimation rules for a single-source accepted run:
- `extract` contributes `page_count * extract_per_page_usd` only when the source still needs extract and native text does not skip the paid path
- `segment` contributes `page_count * segment_per_page_usd` only when the run can still reach segment
- `enrich`, `embed`, and `graph` contribute their per-source constants only when included in the planned step slice
- `retry` estimates only the explicitly retried step
- The estimate is rounded to 4 decimal places before persistence and gating

This model is intentionally conservative and deterministic. It is not a billing invoice; it is the gate input and reconciliation baseline.

### 4.3 Reservation lifecycle

State transitions:

1. `reserve on acceptance`
   - Inside the same DB transaction that creates the `pipeline_runs` row and queue job, calculate the estimate and insert a `reserved` ledger row
   - Reject the request before any write if `reserved + committed + new_estimate > monthly_limit_usd`

2. `commit on completed work`
   - When the accepted run reaches terminal `pipeline_runs.status='completed'`, set:
   - `status='committed'`
   - `committed_usd=reserved_estimated_usd`
   - `released_usd=0`

3. `release on canceled / rejected / not-started work`
   - If the request is rejected by the gate, do not create a row
   - If a reservation exists but the job never begins or the run cannot be found / never leaves the starting point, finalize as:
   - `status='released'`
   - `committed_usd=0`
   - `released_usd=reserved_estimated_usd`

4. `reconcile on failed or partial work`
   - When the run finishes `failed` or `partial`, compute committed spend from the highest successfully reached planned step for the source
   - `committed_usd` is the sum of the planned-step cost components that were actually completed
   - `released_usd = reserved_estimated_usd - committed_usd`
   - `status='released'` when `committed_usd=0`
   - `status='reconciled'` when `0 < committed_usd < reserved_estimated_usd`

5. `retry semantics`
   - A retry creates a brand-new reservation row linked through `retry_of_reservation_id`
   - The retry estimate covers only the retried step, so previously committed spend is not re-reserved
   - A failed step followed by a retry therefore produces:
   - first row: `reconciled` or `released`
   - retry row: `reserved` then terminal

### 4.4 Gate math and `/api/status`

Add `GET /api/status` with an authenticated JSON response:

```json
{
  "data": {
    "budget": {
      "month": "2026-04-01",
      "limit_usd": 50,
      "reserved_usd": 12.5,
      "committed_usd": 18.2,
      "released_usd": 4.3,
      "remaining_usd": 19.3
    },
    "jobs": {
      "pending": 1,
      "running": 2,
      "completed": 10,
      "failed": 3,
      "dead_letter": 0
    }
  }
}
```

Computation rules:
- `reserved_usd` = sum of `reserved_estimated_usd` for rows still in `status='reserved'` for the current month
- `committed_usd` = sum of `committed_usd` for all terminal rows in the current month
- `released_usd` = sum of `released_usd` for all terminal rows in the current month
- `remaining_usd = monthly_limit_usd - reserved_usd - committed_usd`
- `remaining_usd` may be zero but must not go negative in accepted responses; requests that would push it below zero are rejected

### 4.5 Files

Create or update:

- `docs/specs/77_budget_reservation_status_gate.spec.md`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/database/migrations/019_monthly_budget_reservations.sql`
- `packages/core/src/database/repositories/budget-reservation.types.ts`
- `packages/core/src/database/repositories/budget-reservation.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/index.ts`
- `apps/api/src/lib/pipeline-jobs.ts`
- `apps/api/src/lib/status.ts`
- `apps/api/src/routes/status.schemas.ts`
- `apps/api/src/routes/status.ts`
- `apps/api/src/app.ts`
- `packages/pipeline/src/pipeline/index.ts`
- `tests/specs/77_budget_reservation_status_gate.test.ts`

## 5. QA Contract

### QA-01: Accepted run reserves budget and returns 202
- **Given** a source whose estimated run cost fits within the current month limit
- **When** `POST /api/pipeline/run` is called
- **Then** the response is `202` and the database contains one `monthly_budget_reservations` row in `reserved` state for the created run/job

### QA-02: Gate rejects over-budget acceptance deterministically
- **Given** existing current-month reservations and commitments that leave less remaining budget than a new run needs
- **When** `POST /api/pipeline/run` is called for that source
- **Then** the response is a non-2xx budget error, no `pipeline_runs` row is created, no job is enqueued, and no reservation row is inserted

### QA-03: Failed run reconciles consumed vs released spend
- **Given** an accepted run whose source completes some planned steps and then fails
- **When** the run reaches terminal failed state and reconciliation runs
- **Then** the reservation row becomes `reconciled` or `released`, `committed_usd` matches the completed-step cost components, and the unused remainder moves to `released_usd`

### QA-04: Partial run preserves committed work without holding the full estimate
- **Given** a reservation row for a run that ends `partial`
- **When** reconciliation runs
- **Then** the row becomes `reconciled`, `committed_usd` is greater than zero, `released_usd` is greater than zero, and the two sum exactly to the original reservation

### QA-05: Retry creates a new reservation only for the retried step
- **Given** a failed prior reservation for a source
- **When** `POST /api/pipeline/retry` is accepted
- **Then** the new row links to the prior reservation via `retry_of_reservation_id`, reserves only the retried step cost, and does not re-reserve already committed spend

### QA-06: `/api/status` reports reserved, committed, released, and remaining from persisted rows
- **Given** a mix of reserved, committed, released, and reconciled rows in the current month
- **When** `GET /api/status` is called
- **Then** the response computes `reserved_usd`, `committed_usd`, `released_usd`, and `remaining_usd` exactly from those rows and also returns current job counts

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

This spec is itself a cost-safety feature. It adds one extra insert on acceptance, one extra update on terminal reconciliation, and one small aggregate query for `GET /api/status`. Those database costs are negligible. The important effect is behavioral: once the ledger is in place, API-driven work can enforce a hard monthly cap without permanently leaking reserved budget after failed or partial runs.
