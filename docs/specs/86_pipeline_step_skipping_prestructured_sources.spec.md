---
spec: "86"
title: "Pipeline Step Skipping for Pre-Structured Sources"
roadmap_step: M9-J2
functional_spec: ["§2", "§3.1", "§3.2", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/229"
created: 2026-04-30
---

# Spec 86: Pipeline Step Skipping for Pre-Structured Sources

## 1. Objective

Add the M9-J2 orchestration foundation that lets non-layout source formats bypass the `segment` step. PDF and image sources still follow the existing layout path (`extract -> segment -> enrich -> embed -> graph`), while pre-structured source types (`text`, `docx`, `spreadsheet`, `email`, `url`) can follow `extract -> enrich -> embed -> graph` once their extractors produce story Markdown directly.

This satisfies the roadmap requirement that pre-structured formats skip segmentation, keeps PostgreSQL authoritative for pipeline progress, and prepares M9-J4 through M9-J10 without accepting those formats yet. The implementation must preserve the current PDF pipeline behavior and avoid direct GCP client usage.

## 2. Boundaries

**Roadmap step:** M9-J2 - Pipeline step skipping: orchestrator supports `skip_to` so pre-structured formats bypass `segment`.

**Base branch:** `milestone/9`. This spec is intentionally delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/pipeline/src/pipeline/types.ts`
- `packages/pipeline/src/pipeline/index.ts`
- `packages/pipeline/src/pipeline/step-plan.ts`
- `packages/pipeline/src/index.ts`
- `apps/cli/src/commands/pipeline.ts`
- `apps/api/src/routes/pipeline.schemas.ts`
- `apps/api/src/lib/pipeline-jobs.ts`
- `packages/worker/src/worker.types.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/86_pipeline_step_skipping_prestructured_sources.test.ts`
- `tests/specs/36_pipeline_orchestrator.test.ts`
- `tests/specs/80_step_chained_pipeline_api_jobs.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add a shared step-planning helper that can compute effective pipeline steps for a source type.
- Treat `pdf` and `image` as layout sources that require `segment`.
- Treat `text`, `docx`, `spreadsheet`, `email`, and `url` as pre-structured sources that skip `segment`.
- Represent the skip in run planning, dry-run output, run persistence, and worker/API step chaining.
- Allow a pre-structured source whose extract step has produced stories to advance from `extracted` directly into story fanout steps.
- Record skipped step observability in PostgreSQL where the existing `source_steps` table can express it.
- Keep existing `--from` / `--up-to` validation and ordering predictable, including a clear error when a requested range contains no executable step for the source type.
- Preserve all current PDF behavior, including `segment` execution, existing CLI output, API acceptance, worker chaining, budget reservations, and status rows.

**Out of scope:**

- Accepting new source formats at ingest time. That begins with M9-J3/J4.
- Implementing text, DOCX, spreadsheet, email, URL, or image extractors.
- Changing the `sources.source_type` enum introduced by Spec 85.
- Removing the legacy `pipeline_run` worker payload parser.
- Reworking Firestore projection beyond existing best-effort step status payloads.
- Running `ground` or `analyze` as source-scoped steps.

**Architectural constraints:**

- PostgreSQL remains the source of truth for orchestration (`sources.status`, `stories.status`, `source_steps`, `pipeline_runs`, `pipeline_run_sources`, and `jobs`).
- Firestore stays write-only observability and must not be read for routing.
- Pipeline code must use existing service interfaces, not direct GCP clients.
- The skip rule must be source-type driven, deterministic, and reusable by CLI, API producer, worker chaining, and tests.
- PDF pipeline behavior is the compatibility baseline; no PDF run may skip `segment`.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `sources.source_type` and `format_metadata`.
- M7 follow-up Spec 80: step-chained async pipeline API jobs.
- M2-B4 / Spec 16 and M3-C1/C2/C3: existing PDF ingest, extract, segment, and story fanout steps.

**Blocks:**

- M9-J4 plain text ingestion.
- M9-J5 DOCX ingestion.
- M9-J6 CSV/Excel ingestion.
- M9-J7 email ingestion.
- M9-J8 URL ingestion.
- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

M9-J3 image ingestion can proceed with the existing segment path, but it should use the shared planner once this spec lands.

## 4. Blueprint

### Phase 1: Shared step planning

1. Add `packages/pipeline/src/pipeline/step-plan.ts`.
2. Export a source-type aware planner with the effective ordered steps for a source:

```typescript
type StepPlanInput = {
  sourceType: SourceType;
  from?: PipelineStepName;
  upTo?: PipelineStepName;
};

type StepPlan = {
  requestedSteps: PipelineStepName[];
  executableSteps: PipelineStepName[];
  skippedSteps: PipelineStepName[];
};
```

3. The default requested order remains `ingest -> extract -> segment -> enrich -> embed -> graph`.
4. For `pdf` and `image`, `executableSteps` equals the requested range.
5. For `text`, `docx`, `spreadsheet`, `email`, and `url`, remove `segment` from `executableSteps` and include it in `skippedSteps` when it falls inside the requested range.
6. Preserve ordering validation for unknown steps and `from > upTo`.
7. Return a typed error when the requested range contains only skipped steps for that source type, such as `--from segment --up-to segment` on a text source.

### Phase 2: CLI and synchronous orchestrator

1. Update `PipelineRunOptions` / result metadata to carry source-aware effective plans where needed.
2. Keep the existing global `plannedSteps` as the requested CLI/API range, but compute effective steps per source before execution.
3. In `enumerateSources()`, keep PDF ingest behavior unchanged. Resume/retry paths should use each source's persisted `sourceType`.
4. In `processSource()`, use the source-specific executable plan instead of blindly iterating the global requested steps.
5. When `segment` is skipped for a pre-structured source:
   - do not call `executeSegment()`
   - upsert `source_steps(source_id, 'segment')` as `skipped`
   - allow `enrich` eligibility when the source is `extracted` and stories already exist
   - keep `pipeline_run_sources.current_step` meaningful by advancing to the last executed step, not the skipped step
6. Update dry-run output so seeded/resume sources show that `segment` is skipped when source type is pre-structured.
7. Keep `mulder pipeline run <pdf> --up-to segment` behavior unchanged.

### Phase 3: API producer and worker chaining

1. Ensure API-created jobs use the same source-type planner when choosing the first executable step.
2. If a caller requests `from: "segment"` for a pre-structured source, enqueue the next executable step (`enrich`) when the range allows it; otherwise return a clear validation error.
3. Preserve `up_to` semantics as an inclusive boundary over the requested range, with skipped steps omitted from execution.
4. Update worker chaining so successful `extract` jobs for pre-structured sources enqueue `enrich` next, not `segment`.
5. Keep PDF/image worker chaining as `extract -> segment -> enrich -> embed -> graph`.
6. Keep budget reservation steps aligned with the executable plan so skipped `segment` work is not reserved or committed.

### Phase 4: QA and compatibility

1. Add `tests/specs/86_pipeline_step_skipping_prestructured_sources.test.ts` with black-box checks through the public package exports, CLI subprocesses, SQL, and API/worker queue boundaries.
2. Update existing orchestrator/API tests only where a new visible skip status or planner export changes expected output.
3. Run existing PDF-oriented pipeline tests to prove the default path still includes `segment`.

## 5. QA Contract

**QA-01: Shared planner preserves PDF layout path**

Given source type `pdf`, when a full pipeline plan is requested, then the executable steps are `ingest, extract, segment, enrich, embed, graph` and no step is marked skipped.

**QA-02: Shared planner skips segment for pre-structured formats**

Given each of `text`, `docx`, `spreadsheet`, `email`, and `url`, when a full pipeline plan is requested, then `segment` is absent from executable steps, present in skipped steps, and all later story fanout steps remain ordered after `extract`.

**QA-03: CLI dry-run exposes skipped segment for an existing text source**

Given a database source with `source_type = 'text'`, `status = 'extracted'`, and at least one story row, when `mulder pipeline run --from segment --up-to enrich --dry-run` is run against existing sources, then it exits 0, shows `segment` as skipped, and shows `enrich` as executable.

**QA-04: Synchronous pipeline executes enrich after extract for pre-structured sources**

Given a seeded pre-structured source whose extract output already includes story Markdown and a story row, when `mulder pipeline run --from segment --up-to enrich` is executed, then no segment artifacts are created, `source_steps.segment` is `skipped`, the story reaches `enriched`, and the run completes.

**QA-05: API acceptance skips segment when choosing the first job**

Given a pre-structured source with `status = 'extracted'`, when `POST /api/pipeline/run` requests `from: "segment", up_to: "enrich"`, then the response is `202`, the queued job type is `enrich`, and no `segment` job is queued.

**QA-06: Worker chaining skips segment after extract for pre-structured sources**

Given an `extract` job for a pre-structured source in a run whose `upTo` is `graph`, when the worker completes the job, then the next pending job is `enrich` rather than `segment`.

**QA-07: Segment-only request on a pre-structured source fails clearly**

Given a pre-structured source, when API or CLI requests only `segment`, then the request fails with a typed pipeline error explaining that `segment` is skipped for that source type, and no job is enqueued.

**QA-08: Existing PDF pipeline behavior remains unchanged**

Given the existing Spec 36 and Spec 80 PDF pipeline tests, when they run after this change, then PDF sources still execute or enqueue `segment` between `extract` and `enrich`.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder pipeline run <pdf-dir> --up-to segment --dry-run` | PDF directory | Planned steps include `segment`; no skipped segment. |
| `mulder pipeline run --from segment --up-to enrich --dry-run` | Existing seeded `text` source | Output shows `segment` skipped and `enrich` executable. |
| `mulder pipeline run --from segment --up-to enrich` | Existing seeded `text` source with a story | Exit 0; `source_steps.segment = skipped`; story reaches `enriched`. |
| `mulder pipeline run --from segment --up-to segment` | Existing seeded `text` source | Non-zero exit with typed skipped-step error; no work executed. |

## 6. Cost Considerations

This step reduces future cost by preventing pre-structured formats from running unnecessary segmentation. It must not introduce any new paid service calls. Budget reservation and finalization should exclude skipped `segment` work for pre-structured sources while preserving existing estimates for PDF and image layout sources.
