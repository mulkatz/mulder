---
spec: "65"
title: "Analyze Full Orchestrator"
roadmap_step: M6-G7
functional_spec: ["§1", "§2.8", "§3.1", "§3.2"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/158"
created: 2026-04-12
---

# Spec 65: Analyze Full Orchestrator

## 1. Objective

Implement Mulder's `M6-G7` coordinator so `mulder analyze --full` and bare `mulder analyze` run the enabled Analyze sub-passes in a stable order, aggregate their outcomes into one user-facing result, and let the pipeline orchestrator invoke that full-graph analysis phase automatically after `graph` when analysis is enabled. Per `§2.8`, Analyze remains a modular full-graph step whose sub-analyses can run independently; this step adds the missing orchestration layer without re-implementing the existing contradiction, reliability, evidence-chain, or spatio-temporal engines. Per `§1`, `--full` is the intended default CLI surface, and per `§3.1`/`§3.2` the full document pipeline should be able to append optional global analysis after per-source graph work completes.

## 2. Boundaries

- **Roadmap Step:** `M6-G7` — Analyze orchestrator — `mulder analyze --full`
- **Target:** `packages/pipeline/src/analyze/types.ts`, `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`, `packages/pipeline/src/pipeline/types.ts`, `packages/pipeline/src/pipeline/index.ts`, `apps/cli/src/commands/analyze.ts`, `apps/cli/src/commands/pipeline.ts`
- **In scope:** full-mode Analyze input and aggregate result types; sequential orchestration of the existing G3-G6 Analyze sub-passes; CLI behavior where bare `mulder analyze` defaults to full mode; readable full-run summaries with skipped/pass/fail accounting; skipping disabled or currently unconfigured passes without treating them as fatal; and appending a global Analyze phase to `mulder pipeline run` when analysis is enabled and the run reaches `graph`
- **Out of scope:** new contradiction, reliability, evidence-chain, or clustering algorithms; schema migrations; new config fields; worker/job-queue behavior; per-source retry semantics for Analyze; UI/API presentation; or changing how the individual G3-G6 selectors behave when they are run explicitly
- **Constraints:** preserve the existing individual selector contracts; run full-mode passes in functional-spec order (`contradictions` → `reliability` → `evidence-chains` → `spatio-temporal`); treat `analysis.enabled=false` as a hard disable for full mode; treat `analysis.evidence_chains=true` with an empty thesis list as a full-mode skip rather than a fatal error; and invoke Analyze once per pipeline batch, never once per source

## 3. Dependencies

- **Requires:** Spec 36 (`M4-D6`) pipeline orchestrator, Specs 61-64 (`M6-G3` through `M6-G6`) for the individual Analyze sub-passes, and the existing `analysis` config surface in `packages/core/src/config/`
- **Blocks:** end-to-end v2.0 pipeline runs that are supposed to finish with global analysis, and any workflow that expects a single command to execute all currently implemented Analyze passes in sequence

## 4. Blueprint

### 4.1 Files

1. **`packages/pipeline/src/analyze/types.ts`** — extends Analyze inputs/results with a `full` mode plus typed per-pass summaries, skipped-pass reporting, and aggregate metadata suitable for CLI and pipeline consumers
2. **`packages/pipeline/src/analyze/index.ts`** — implements the full-mode coordinator by dispatching the existing contradiction, reliability, evidence-chain, and spatio-temporal branches in order, folding their `success`/`partial`/`failed` outcomes into one aggregate result, and skipping disabled or thesis-less passes with explicit reasons
3. **`packages/pipeline/src/index.ts`** — re-exports the expanded Analyze contract from the pipeline package barrel
4. **`apps/cli/src/commands/analyze.ts`** — makes bare `mulder analyze` behave like `--full`, allows explicit `--full`, preserves mutual exclusivity with individual selectors, prints a compact per-pass summary for full runs, and keeps the existing selector-specific tables for single-pass invocations
5. **`packages/pipeline/src/pipeline/types.ts`** — extends the pipeline result contract with a small global-Analyze summary so the CLI can report whether post-graph analysis ran and how it finished
6. **`packages/pipeline/src/pipeline/index.ts`** — appends a single global Analyze call after per-source graph processing when analysis is enabled and the pipeline run has not been limited to `--up-to graph` or earlier, then folds the global Analyze verdict into the overall pipeline result without trying to treat Analyze as a source-scoped step
7. **`apps/cli/src/commands/pipeline.ts`** — updates help text and user-facing descriptions so the “full pipeline” messaging matches the actual post-graph Analyze behavior when analysis is enabled

### 4.2 Database Changes

None. This step orchestrates the existing Analyze persistence surfaces:

- `entity_edges.analysis` and contradiction edge types from Spec 61
- `sources.reliability_score` from Spec 62
- `evidence_chains` snapshots from Spec 63
- `spatio_temporal_clusters` snapshots from Spec 64

The coordinator must not introduce new tables or write new ad hoc persistence records beyond what the existing sub-passes already own.

### 4.3 Config Changes

None. Full-mode orchestration uses the existing config:

- `analysis.enabled`
- `analysis.contradictions`
- `analysis.reliability`
- `analysis.evidence_chains`
- `analysis.evidence_theses`
- `analysis.spatio_temporal`

Behavior:

- If `analysis.enabled=false`, full Analyze fails fast with a clear disabled error
- Disabled sub-passes are skipped and reported in the aggregate result
- Evidence-chain analysis is skipped in full mode when `analysis.evidence_theses` is empty, with a clear “no thesis input configured” reason
- Explicit single-pass selectors (`--contradictions`, `--reliability`, `--evidence-chains`, `--spatio-temporal`) keep their current validation and failure semantics

### 4.4 Integration Points

- Full Analyze must reuse the existing single-pass branches rather than duplicating their internal logic; the coordinator should compose them through one shared executor path so later Analyze passes can slot in without a second control flow
- Full-mode ordering must match the functional spec: contradiction resolution first, then reliability scoring, then evidence chains, then spatio-temporal clustering
- Bare `mulder analyze` should map to full mode; explicit selectors should remain mutually exclusive with `--full`
- Full-mode CLI output should show each pass with its verdict (`success`, `partial`, `failed`, `skipped`) and a concise reason/summary, followed by an overall Analyze summary and non-zero exit only for invalid invocation or total failure
- `mulder pipeline run` should continue to track per-source work through `graph`, then invoke one global Analyze call for the batch when analysis is enabled; `--up-to graph` remains the way to skip analysis intentionally
- Pipeline result status should absorb the global Analyze verdict: a successful source batch with a partial full Analyze run becomes pipeline `partial`, while a total Analyze failure after successful graph work becomes pipeline `failed`

### 4.5 Implementation Phases

**Phase 1: Full-mode Analyze contract**
- Files: `packages/pipeline/src/analyze/types.ts`, `packages/pipeline/src/index.ts`
- Deliverable: a stable typed input/output shape for `full` Analyze runs, including per-pass and aggregate reporting

**Phase 2: Coordinator + CLI**
- Files: `packages/pipeline/src/analyze/index.ts`, `apps/cli/src/commands/analyze.ts`
- Deliverable: `mulder analyze --full` and bare `mulder analyze` run the enabled passes in sequence and report a usable aggregate summary

**Phase 3: Pipeline handoff**
- Files: `packages/pipeline/src/pipeline/types.ts`, `packages/pipeline/src/pipeline/index.ts`, `apps/cli/src/commands/pipeline.ts`
- Deliverable: `mulder pipeline run` can finish with one global Analyze phase when analysis is enabled, and its help/output accurately describe that behavior

## 5. QA Contract

1. **QA-01: Bare analyze runs the enabled full analysis sequence**
   - Given: `analysis.enabled=true`, at least one individual Analyze sub-pass is enabled and runnable, and the corpus contains data for at least one enabled pass
   - When: `mulder analyze` runs with no selector flags
   - Then: the command exits `0` or partial-success, executes the enabled passes in full-mode order, and prints an aggregate summary that includes each attempted or skipped pass

2. **QA-02: Explicit full mode matches bare analyze behavior**
   - Given: the same configuration and corpus state as QA-01
   - When: `mulder analyze --full` runs
   - Then: the command produces the same per-pass sequencing and overall verdict class as bare `mulder analyze`

3. **QA-03: Full mode skips disabled or thesis-less passes without aborting runnable ones**
   - Given: `analysis.enabled=true`, at least one Analyze pass is enabled and runnable, `analysis.evidence_chains=true`, and `analysis.evidence_theses=[]`
   - When: `mulder analyze --full` runs
   - Then: the command still executes the runnable passes, reports evidence chains as skipped with a clear reason, and does not fail solely because no thesis input is configured

4. **QA-04: Full mode fails fast when analysis is globally disabled**
   - Given: `analysis.enabled=false`
   - When: `mulder analyze --full` or bare `mulder analyze` runs
   - Then: the command exits non-zero with an Analyze disabled error before any contradiction, reliability, evidence-chain, or clustering writes occur

5. **QA-05: Explicit selector mode keeps existing single-pass semantics**
   - Given: `analysis.enabled=true` and the corpus contains data for contradiction resolution
   - When: `mulder analyze --contradictions` runs
   - Then: the command behaves as a single-pass contradiction run, not as full mode, and does not also execute reliability, evidence-chain, or spatio-temporal passes

6. **QA-06: Pipeline run appends global Analyze after graph when enabled**
   - Given: `analysis.enabled=true`, the pipeline can process at least one source through `graph`, and the run is not limited to `--up-to graph` or earlier
   - When: `mulder pipeline run <path>` completes
   - Then: the overall run includes one post-graph Analyze phase, and the final pipeline verdict reflects both per-source processing and the global Analyze result

7. **QA-07: Pipeline run can intentionally stop before analysis**
   - Given: `analysis.enabled=true`
   - When: `mulder pipeline run <path> --up-to graph` runs
   - Then: the run completes without invoking full Analyze, and the user-facing summary reflects a graph-terminal run rather than an analysis-inclusive one

## 5b. CLI Test Matrix

### `mulder analyze`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | *(no args)* | Executes full Analyze mode using the enabled passes and prints an aggregate summary |
| CLI-02 | `--full` | Same full-mode behavior as bare `mulder analyze` |
| CLI-03 | `--full --contradictions` | Exit non-zero, because full mode and explicit selectors are mutually exclusive |
| CLI-04 | `--full --reliability` | Exit non-zero, because full mode and explicit selectors are mutually exclusive |
| CLI-05 | `--contradictions` | Runs only contradiction resolution |
| CLI-06 | `--reliability` | Runs only reliability scoring |
| CLI-07 | `--evidence-chains` | Runs only evidence-chain analysis |
| CLI-08 | `--spatio-temporal` | Runs only spatio-temporal clustering |

### `mulder pipeline run`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-09 | `<path>` | Full pipeline help/output reflects that Analyze runs after graph when analysis is enabled |
| CLI-10 | `<path> --up-to graph` | Stops after graph and does not invoke Analyze |
| CLI-11 | `<path> --up-to enrich` | Stops before graph and never reaches Analyze |
| CLI-12 | `<path> --dry-run` | Planned output stays side-effect free and does not claim that Analyze already ran |

## 6. Cost Considerations

- **Services called:** none directly by the coordinator, but full mode may trigger the existing contradiction-resolution Gemini calls from Spec 61 when that pass is enabled and pending contradictions exist
- **Estimated incremental cost:** orchestration itself is free; any paid cost comes only from already-implemented sub-passes it invokes
- **Dev mode alternative:** yes — the existing dev fixtures for contradiction resolution and the database-backed Analyze passes remain available under full mode
- **Safety flags:** `analysis.enabled` hard-disables full mode, and full mode must skip thesis-less evidence-chain runs instead of forcing unnecessary failures
