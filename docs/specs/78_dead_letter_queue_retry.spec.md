---
spec: "78"
title: "Dead Letter Queue Retry CLI"
roadmap_step: M8-I5
functional_spec: ["§1 (retry cmd)", "§10.5", "§16"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/203"
created: 2026-04-15
---

# Spec 78: Dead Letter Queue Retry CLI

## 1. Objective

Add the operator-facing dead-letter recovery flow for Mulder's PostgreSQL job queue by introducing a top-level `mulder retry` command that resets eligible `dead_letter` jobs back to `pending` with `attempts = 0`. Per `§10.5`, this command must support document-scoped and step-scoped recovery without adding new infrastructure, and it must preserve the existing worker model where recovered jobs are picked up by the normal queue loop.

This step closes the gap left by Spec 67 and Spec 68: the database and worker can already mark exhausted jobs as `dead_letter`, but operators still lack the CLI surface to inspect and recover that work safely. The delivery should make the cheap, targeted path the default by resetting only matching DLQ jobs rather than re-running broad pipeline flows.

## 2. Boundaries

- **Roadmap Step:** `M8-I5` — Dead letter queue — `mulder retry`
- **Target:** `packages/core/src/database/repositories/job.types.ts`, `packages/core/src/database/repositories/job.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/core/src/index.ts`, `apps/cli/src/commands/retry.ts`, `apps/cli/src/index.ts`, `tests/specs/78_dead_letter_queue_retry.test.ts`
- **In scope:** queue-level filter and reset helpers for `dead_letter` jobs; job-payload matching for source-scoped and step-scoped retries; a new top-level `mulder retry` command with document and step selectors plus JSON/operator output; public export wiring for the new repository surface; and black-box tests that verify only eligible DLQ jobs are reset and that they re-enter the worker lifecycle as pending work
- **Out of scope:** changes to the existing `pipeline retry` command or API retry routes, new worker job types, schema migrations beyond the current `jobs` table, bulk queue dashboards, automatic retries, or roadmap work for schema evolution / reprocessing (`M8-I4`)
- **Constraints:** preserve the existing PostgreSQL queue contract; do not reset non-`dead_letter` jobs; keep CLI handlers thin and repository-driven; support the current queue payload shapes (`extract`, `segment`, `enrich`, `embed`, `graph`, `pipeline_run`) without inventing new payload schemas; and keep the recovery path cost-safe by default through targeted selectors and dry, shell-observable output

## 3. Dependencies

- **Requires:** Spec 67 (`M7-H1`) job repository lifecycle semantics, Spec 68 (`M7-H2`) worker queue consumption, Spec 52 (`F4`) status/output conventions for CLI operator surfaces, and the existing pipeline/job payload contracts under `packages/worker` and `apps/api`
- **Blocks:** no direct follow-on roadmap step, but this completes the operational DLQ recovery loop promised by `§10.5` and gives later production-safe operations work a real manual recovery path

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/database/repositories/job.types.ts`** — adds typed filter/result contracts for dead-letter lookup and reset operations
2. **`packages/core/src/database/repositories/job.repository.ts`** — implements dead-letter filtering by source and optional step, plus the reset-to-pending update that clears worker ownership, timestamps, and error state while zeroing attempts
3. **`packages/core/src/database/repositories/index.ts`** — re-exports the new repository helpers and types
4. **`packages/core/src/index.ts`** — exposes the new queue recovery surface through `@mulder/core`
5. **`apps/cli/src/commands/retry.ts`** — registers the top-level `mulder retry` command, parses selectors, loads config/pool state, invokes the repository helper, and prints human-readable or JSON summaries
6. **`apps/cli/src/index.ts`** — registers the new command alongside the existing CLI surface
7. **`tests/specs/78_dead_letter_queue_retry.test.ts`** — black-box coverage for repository resets and the new CLI command behavior

### 4.2 Queue Recovery Contract

The new recovery helper operates only on rows with `status = 'dead_letter'`.

Selector rules:

- `--document <source-id>` matches jobs whose payload references the source via `sourceId` / `source_id`
- `--step <step>` narrows the reset set to jobs for the named pipeline step
- when both are present, the reset must satisfy both filters
- jobs outside the filter remain untouched

Reset semantics for each recovered row:

- `status` becomes `pending`
- `attempts` becomes `0`
- `worker_id`, `started_at`, and `finished_at` become `NULL`
- `error_log` becomes `NULL`

Payload interpretation must cover current queue shapes:

- source-step jobs: `extract` / `segment` use `payload.sourceId`
- story-step jobs are matched indirectly through `pipeline_run` jobs only in this step; direct story-job recovery by source is out of scope unless the payload already carries a source identifier
- `pipeline_run` jobs match by `payload.sourceId` and derive step scope from `payload.from` / `payload.upTo` when those represent a single-step retry job

If no rows match, the command succeeds with a zero-reset result rather than treating the request as an error.

### 4.3 CLI Surface

The new top-level command is:

```bash
mulder retry --document <source-id> [--step <step>] [--json]
mulder retry --step <step> [--json]
```

Rules:

- at least one selector is required: `--document` and/or `--step`
- `--step` accepts the same retryable pipeline steps as the existing retry flows: `extract`, `segment`, `enrich`, `embed`, `graph`
- the command prints how many dead-letter jobs were reset and which selectors were applied
- `--json` emits a stable summary with the reset count and recovered job identifiers
- invalid selectors or missing DB config fail with the existing CLI error conventions and non-zero exit codes

### 4.4 Integration Points

- the helper must compose cleanly with `dequeueJob` so reset rows immediately become runnable for the existing worker loop
- the new command must not change the semantics of `mulder pipeline retry`, which remains a pipeline-run orchestrator concern rather than a raw DLQ reset
- repository filtering should be implemented centrally rather than duplicated in the CLI layer
- public exports should make the recovery helper available to later API or status surfaces without another refactor

### 4.5 Implementation Phases

**Phase 1: repository recovery surface**
- add filter/result types for DLQ recovery
- implement dead-letter discovery and reset helpers in the job repository
- wire the helpers through the repository and package barrels

**Phase 2: CLI command**
- add `apps/cli/src/commands/retry.ts`
- register the top-level `retry` command in the CLI root
- provide concise operator output and `--json` support

**Phase 3: QA coverage**
- add black-box tests for repository filtering and reset semantics
- add CLI tests for selector validation, human-readable output, and JSON output

## 5. QA Contract

1. **QA-01: document-scoped retry resets only matching dead-letter jobs**
   - Given: dead-letter jobs for two different source IDs
   - When: `mulder retry --document <source-a>` runs
   - Then: only dead-letter rows whose payload targets `<source-a>` return to `pending` with `attempts = 0`

2. **QA-02: step-scoped retry resets only the requested dead-letter step**
   - Given: dead-letter jobs across multiple retryable step types
   - When: `mulder retry --step enrich` runs
   - Then: only dead-letter jobs for the `enrich` step are reset and all other dead-letter jobs remain unchanged

3. **QA-03: combined selectors intersect rather than broaden the reset scope**
   - Given: dead-letter jobs for the same source across multiple steps
   - When: `mulder retry --document <source-id> --step graph` runs
   - Then: only dead-letter jobs matching both that source and the `graph` step are reset

4. **QA-04: non-dead-letter jobs are never mutated**
   - Given: pending, running, failed, completed, and dead-letter jobs that all match the same selector
   - When: the retry command runs
   - Then: only the dead-letter rows change and the others keep their original state

5. **QA-05: reset rows are ready for normal worker pickup**
   - Given: a dead-letter job with attempts exhausted and terminal metadata populated
   - When: it is reset through the new helper
   - Then: the row becomes `pending`, `attempts` is `0`, and worker/timestamp/error fields are cleared so `dequeueJob` can claim it again

6. **QA-06: zero-match retries return a successful no-op summary**
   - Given: no dead-letter jobs match the provided selector
   - When: the retry command runs
   - Then: the command exits successfully and reports `0` jobs reset

7. **QA-07: selector validation prevents ambiguous broad resets**
   - Given: the user runs `mulder retry` with no `--document` and no `--step`
   - When: argument parsing completes
   - Then: the command exits with a usage error explaining that at least one selector is required

8. **QA-08: public exports and CLI registration compile cleanly**
   - Given: the repository and CLI files are wired into the workspace
   - When: the targeted TypeScript/test suite runs
   - Then: the new recovery helpers are importable from `@mulder/core` and the `mulder retry` command is available without type errors

## 5b. CLI Test Matrix

| Command | Scenario | Expected |
|--------|----------|----------|
| `mulder retry --document <source-id>` | matching dead-letter jobs exist | matching jobs reset to `pending`; count is printed |
| `mulder retry --step enrich` | dead-letter jobs span multiple steps | only `enrich` jobs reset |
| `mulder retry --document <source-id> --step graph --json` | combined selector | JSON includes one filtered reset summary |
| `mulder retry --document <source-id>` | no matching dead-letter jobs | successful no-op with `0` reset |
| `mulder retry` | no selectors | usage error |

## 6. Cost Considerations

This step does not add paid service calls. It is still part of the M8 cost-safety milestone because it gives operators a cheap recovery path after failures instead of forcing broad re-runs or manual database edits. The command must stay narrowly scoped so retrying one dead-letter step does not accidentally trigger extra document processing cost across unrelated jobs.
