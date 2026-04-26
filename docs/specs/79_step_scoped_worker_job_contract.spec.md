---
spec: "79"
title: "Step-Scoped Worker Job Contract"
roadmap_step: ""
functional_spec: ["§10.2", "§10.3", "§10.4", "§10.5", "§13"]
scope: phased
issue: ""
created: 2026-04-18
---

# Spec 79: Step-Scoped Worker Job Contract

## 1. Objective

Replace the legacy monolithic `pipeline_run` execution contract inside the worker runtime with explicit step-scoped queue jobs. The functional spec is unambiguous in `§10.2`: async worker-backed execution must slice long-running work into one job per pipeline step per source, rather than claiming one job that runs the full pipeline in-process. This spec delivers the worker-side contract needed for that model without yet rewriting the API run/retry endpoints that produce jobs.

The goal of this spec is to make the worker capable of executing explicit `extract`, `segment`, `enrich`, `embed`, and `graph` jobs directly and observably, so the later API rewrite can stop depending on `pipeline_run` as the normal queue payload.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap M7 remediation follow-up for review divergence `DIV-001`
- **Target:** `packages/worker/src/worker.types.ts`, `packages/worker/src/dispatch.ts`, `packages/worker/src/runtime.ts`, `packages/worker/src/index.ts`, `tests/specs/79_step_scoped_worker_job_contract.test.ts`
- **In scope:** typed queue payloads for step-scoped jobs; dispatch/runtime support for directly executing one pipeline step per claimed job; observable success/failure handling for those step jobs; and compatibility handling so existing legacy `pipeline_run` rows can still be recognized during the transition
- **Out of scope:** rewriting `/api/pipeline/run` or `/api/pipeline/retry` to enqueue the new jobs, changing the public API acceptance envelope, automatic retry semantics beyond the current worker/repository behavior, and browser auth work
- **Constraints:** preserve the no-open-transaction execution rule from `§10.3`; keep the worker loop queue-driven and shell-observable; do not reintroduce direct route-to-pipeline execution; and keep a compatibility path for already-enqueued `pipeline_run` jobs until the API side is migrated

## 3. Dependencies

- **Requires:** Spec 67 (`M7-H1`) job queue repository, Spec 68 (`M7-H2`) worker loop, Spec 71 (`M7-H5`) current async pipeline API routes, and the existing pipeline step entrypoints under `@mulder/pipeline`
- **Blocks:** Spec 80 in this follow-up set, which rewrites the API producer path to enqueue the new step-scoped jobs by default

## 4. Blueprint

### 4.1 Files

1. **`packages/worker/src/worker.types.ts`** — define explicit payload contracts for step-scoped jobs (`extract`, `segment`, `enrich`, `embed`, `graph`) and retain typed legacy support for `pipeline_run` during the transition
2. **`packages/worker/src/dispatch.ts`** — route each step-scoped job type to the correct pipeline entrypoint with exact payload validation and step-specific error reporting
3. **`packages/worker/src/runtime.ts`** — keep claim/execute/complete-or-fail behavior correct for the new job types without long-lived transactions
4. **`packages/worker/src/index.ts`** — expose any updated worker type/runtime surface needed by the CLI or later API work
5. **`tests/specs/79_step_scoped_worker_job_contract.test.ts`** — black-box verification that the worker can consume and execute step-scoped jobs correctly

### 4.2 Queue Contract

Each async job row for pipeline execution should represent exactly one pipeline step. Source steps (`extract`, `segment`) require `sourceId`. Downstream story steps (`enrich`, `embed`, `graph`) support both direct story-scoped payloads with `storyId` and API-chained source-scoped payloads with `sourceId`, so the API can enqueue one first job per source without losing direct worker observability. The runtime contract must support:

- `extract`
- `segment`
- `enrich`
- `embed`
- `graph`

The payloads should be explicit enough that a worker can execute the step without reconstructing the entire pipeline intent from a monolithic `pipeline_run` job. Step payloads may also carry chaining metadata such as `runId`, `upTo`, `tag`, and `force`.

### 4.3 Compatibility Rule

During the migration window:

- the worker must still recognize existing `pipeline_run` jobs so already-accepted work is not stranded
- new step-scoped job types become the preferred execution model
- the compatibility path is transitional and should be removable after the API producer path is migrated

### 4.4 Integration Points

- the worker loop remains the single consumer of the PostgreSQL queue
- the pipeline step implementations under `@mulder/pipeline` remain the execution boundary
- later API producer work can enqueue step jobs without another runtime refactor
- queue observability through `jobs` and `pipeline_run_sources` must remain externally meaningful

### 4.5 Implementation Phases

**Phase 1: worker types + payload guards**
- define step-scoped job payloads
- keep legacy `pipeline_run` typing for compatibility

**Phase 2: direct step dispatch**
- map each step job to its pipeline handler
- preserve completion/failure observability

**Phase 3: transition-proofing + QA**
- keep compatibility with legacy `pipeline_run`
- add black-box tests for step-scoped execution paths

## 5. QA Contract

1. **QA-01: the worker executes a step-scoped extract job**
   - Given: a pending `extract` job with a valid source payload
   - When: the worker claims and runs that job
   - Then: the extract step executes and the job ends in `completed`

2. **QA-02: the worker executes a step-scoped downstream job**
   - Given: a pending `segment`, `enrich`, `embed`, or `graph` job with a valid payload
   - When: the worker claims and runs that job
   - Then: the corresponding step executes and the job ends in `completed`

3. **QA-03: malformed step payloads fail at the worker boundary**
   - Given: a pending step-scoped job missing a required payload field
   - When: the worker claims that job
   - Then: the job fails cleanly with an observable error instead of silently executing the wrong step

4. **QA-04: legacy pipeline_run compatibility remains intact during migration**
   - Given: an already-enqueued legacy `pipeline_run` job
   - When: the updated worker processes it
   - Then: the job is still recognized and handled through the compatibility path

5. **QA-05: step-scoped jobs do not require a long-lived transaction**
   - Given: a slow-running step job
   - When: the worker claims and executes it
   - Then: dequeue, execution, and completion/failure remain separated by the same transaction discipline required in `§10.3`

## 5b. CLI Test Matrix

N/A — no new CLI command surface is introduced or modified in this step.

## 6. Cost Considerations

- **Services called:** unchanged pipeline services for the executed step
- **Estimated cost per run:** unchanged relative to the step being executed
- **Dev mode alternative:** yes — worker execution can be verified in local/dev mode against existing fixtures and queue rows
- **Safety flags:** the compatibility path must not strand existing accepted work during the transition
