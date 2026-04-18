---
spec: "81"
title: "Automatic Queue Retry Before Dead Letter"
roadmap_step: ""
functional_spec: ["§10.3", "§10.5"]
scope: single
issue: ""
created: 2026-04-18
---

# Spec 81: Automatic Queue Retry Before Dead Letter

## 1. Objective

Restore the retry lifecycle promised by `§10.5`: jobs should retry automatically until `max_attempts` is exhausted, and only then move to `dead_letter`. The current repository/runtime behavior leaves ordinary failures in `failed` without an automatic path back to runnable queue work, which breaks the intended PostgreSQL DLQ model.

This spec focuses narrowly on queue semantics, not the broader step-job rewrite. Once implemented, ordinary transient failures should retry without operator intervention, while truly exhausted work should become `dead_letter`.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap M7 remediation follow-up for review divergence `DIV-002`
- **Target:** `packages/core/src/database/repositories/job.repository.ts`, `packages/worker/src/runtime.ts`, `tests/specs/81_queue_retry_before_dead_letter.test.ts`
- **In scope:** automatic requeue behavior when a handler failure occurs and attempts remain; exhausted-job promotion to `dead_letter`; preservation of stale-running-job reap semantics; and black-box verification of transient failure, exhaustion, and DLQ behavior
- **Out of scope:** manual DLQ recovery CLI/API surfaces, browser auth, step-job producer rewrites, and new queue schema/migrations
- **Constraints:** keep the queue contract PostgreSQL-only; preserve externally inspectable job state; do not require operators to run a separate command for ordinary retry; and keep dead-letter reserved for exhausted work

## 3. Dependencies

- **Requires:** Spec 67 (`M7-H1`) job repository lifecycle rules and Spec 68 (`M7-H2`) worker loop
- **Blocks:** none directly, but this is required for a spec-clean queue model after the step-scoped job rewrite

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/database/repositories/job.repository.ts`** — update failure/requeue semantics so non-exhausted handler failures return to a runnable queue state and exhausted jobs become `dead_letter`
2. **`packages/worker/src/runtime.ts`** — keep runtime handling and status reporting correct under the updated retry contract
3. **`tests/specs/81_queue_retry_before_dead_letter.test.ts`** — black-box verification for transient retry, exhaustion, and stale-job recovery interactions

### 4.2 Retry Contract

When a worker-handled job throws:

- if attempts remain, the job must become runnable again automatically
- if no attempts remain, the job must move to `dead_letter`
- operators should not need to manually intervene for ordinary transient failures

The implementation may choose either:

- immediate reset to `pending`, or
- another internally consistent auto-retry state that still results in automatic re-execution without external intervention

But the final observable behavior must satisfy the functional spec’s retry-before-DLQ model.

### 4.3 Integration Points

- stale `running` reap remains a separate recovery path
- manual dead-letter recovery remains separate from ordinary automatic retries
- worker status and job-list views must remain understandable under the new retry behavior

### 4.4 Implementation Phases

Single phase — repository/runtime retry semantics plus black-box verification.

## 5. QA Contract

1. **QA-01: a transient failure retries automatically**
   - Given: a queued job whose handler fails once and has remaining attempts
   - When: the worker processes that job
   - Then: the job becomes runnable again automatically and is retried without operator intervention

2. **QA-02: an exhausted job moves to dead_letter**
   - Given: a queued job whose handler continues failing until attempts are exhausted
   - When: the worker processes that job through its final allowed attempt
   - Then: the job ends in `dead_letter`

3. **QA-03: dead_letter is reserved for exhausted work**
   - Given: one job with attempts remaining and one exhausted job
   - When: both fail
   - Then: only the exhausted job becomes `dead_letter`

4. **QA-04: stale running reap remains compatible**
   - Given: a stale `running` job older than the reap threshold
   - When: the reap flow runs
   - Then: the stale-running recovery still behaves correctly under the new retry contract

## 5b. CLI Test Matrix

N/A — no CLI command surface is introduced or modified in this step.

## 6. Cost Considerations

- **Services called:** unchanged queue execution path only
- **Estimated cost per run:** slightly higher only where retries actually occur, but aligned with the intended queue model
- **Dev mode alternative:** yes — retry behavior is verifiable locally with deterministic failing handlers or fixtures
- **Safety flags:** automatic retries must not create infinite retry loops beyond `max_attempts`
