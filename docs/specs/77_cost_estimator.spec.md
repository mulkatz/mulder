---
spec: 77
title: Cost Estimator — Ingest, Pipeline, and Reprocess Flags
roadmap_step: M8-I2
functional_spec: §16.2, §16, §1 (ingest/pipeline/reprocess cmds)
scope: phased
issue: https://github.com/mulkatz/mulder/issues/198
created: 2026-04-15
---

# Spec 77 — Cost Estimator

## 1. Objective

Implement Mulder's reusable cost-estimation workflow for expensive CLI entrypoints so operators can see projected spend before they trigger OCR, LLM, grounding, or embedding work.

This step delivers three user-facing surfaces from the roadmap contract:

- `mulder ingest <path> --cost-estimate`
- `mulder pipeline run <path> --cost-estimate`
- `mulder reprocess --cost-estimate`

The implementation must stay heuristic and transparent rather than pretending to be billing-grade. The goal is "good enough to prevent surprise spend," with deterministic formulas, clear assumptions, and confirmation gates before high-cost execution.

## 2. Boundaries

### In scope

- Shared estimation module in `packages/core/src/shared/cost-estimator.ts`
- Shared config-fingerprint helpers for step-level `config_hash` persistence and reprocess planning
- Persisting meaningful `config_hash` values in `source_steps` for step executions that participate in reprocess planning
- CLI estimate rendering + confirmation helpers for cost-sensitive commands
- `apps/cli/src/commands/ingest.ts` integration for `--cost-estimate`
- `apps/cli/src/commands/pipeline.ts` integration for `pipeline run --cost-estimate`
- New `apps/cli/src/commands/reprocess.ts` command focused on planning + cost estimation
- `apps/cli/src/index.ts` registration for the new `reprocess` command
- Black-box QA coverage for estimate output, no-write dry runs, config-hash persistence, and reprocess planning

### Out of scope

- Exact Cloud Billing API parity or account-specific live pricing
- Terraform budget alerts (M8-I3)
- Full selective reprocessing execution engine beyond the planning / estimate surface required here
- New `--yes` / `--force-confirm` flags or non-interactive automation affordances
- Estimating v2.0-only steps that are not currently executable in the repo (`analyze`, full grounding-only flows) beyond explicit "not enabled / not included" reporting

### Architectural constraints

- No paid service calls are allowed during cost estimation
- CLI estimation must use repository state, local PDFs, database metadata, and config only
- The estimator must expose its assumptions in code and output; hidden magic numbers are not acceptable
- `reprocess` planning must derive from stored `source_steps.config_hash` plus current config projections, not from Firestore or ad hoc filesystem state

## 3. Dependencies

### Requires

- Spec 11 — service abstraction / shared core exports
- Spec 14 — source repository + `source_steps`
- Spec 16 — ingest command + local PDF validation patterns
- Spec 30 — reset / source-step lifecycle conventions
- Spec 36 — pipeline run command and step ordering
- Existing config schema/defaults for `safety`, `grounding`, `embedding`, `enrichment`, `extraction`, and `ontology`

### Required by

- M8-I4 reprocess execution can reuse the config-diff planner and command surface from this step
- Future ops work can reuse the estimator output contract for API/admin surfaces

## 4. Blueprint

### 4.1 Shared estimator core

**File:** `packages/core/src/shared/cost-estimator.ts`

Add a pure TypeScript estimator with explicit inputs and outputs:

```typescript
export type EstimatedStep = 'extract' | 'segment' | 'enrich' | 'ground' | 'embed';

export interface CostEstimateInput {
  mode: 'ingest' | 'pipeline' | 'reprocess';
  sourceProfiles: EstimatedSourceProfile[];
  plannedSteps: EstimatedStep[];
  groundingEnabled: boolean;
}

export interface EstimatedSourceProfile {
  sourceId?: string;
  filename: string;
  pageCount: number;
  nativeTextRatio: number | null;
  storyCount?: number | null;
}

export interface CostEstimate {
  sourceCount: number;
  totalPages: number;
  estimatedUsd: number;
  steps: Array<{
    step: EstimatedStep;
    estimatedUsd: number;
    basis: string;
  }>;
  warnings: string[];
}
```

Implementation rules:

- Keep pricing assumptions as named constants near the estimator with comments explaining their units
- Use deterministic heuristics based on page count, native-text ratio, optional story counts, and enabled features
- Treat native-text-heavy documents as lower/zero Document AI cost where the extract step would avoid OCR
- Return zero-cost lines only when they communicate something meaningful (`ground` disabled, no sources to reprocess, etc.)
- Round for display only; preserve numeric precision in the returned structure

### 4.2 Step config fingerprints

**Files:**

- `packages/core/src/shared/config-fingerprint.ts` (new)
- `packages/core/src/shared/index.ts` / `packages/core/src/index.ts` export wiring

Add step-specific config fingerprint helpers:

```typescript
export type ReprocessableStep = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

export function getStepConfigHash(config: MulderConfig, step: ReprocessableStep): string;
export function getReprocessPlanForHashes(args: {
  currentHashes: Record<ReprocessableStep, string>;
  storedHashes: Partial<Record<ReprocessableStep, string | null>>;
}): ReprocessableStep[];
```

Rules:

- Hash a normalized JSON projection of only the config subset relevant to each step
- The projection must be stable across key ordering
- `extract` should include extraction settings that affect OCR/layout behavior
- `segment` should include segmentation model/settings
- `enrich` should include ontology, taxonomy-affecting enrichment settings, and entity-resolution strategy config
- `embed` should include embedding/chunking settings
- `graph` should include deduplication and graph settings

### 4.3 Persist `config_hash` during step execution

Update the existing pipeline step modules so successful `upsertSourceStep(...)` calls record meaningful `configHash` values instead of leaving the field null where the step participates in reprocessing:

- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/segment/index.ts`
- `packages/pipeline/src/enrich/index.ts`
- `packages/pipeline/src/embed/index.ts`
- `packages/pipeline/src/graph/index.ts`

`ingest` may also persist a hash for completeness, but reprocess planning must key off the five reprocessable steps above.

### 4.4 CLI estimate rendering + confirmation

**Files:**

- `apps/cli/src/lib/cost-estimate.ts` (new) or equivalent helper module
- optional small additions to `apps/cli/src/lib/output.ts`

Add shared CLI helpers that:

- render a readable estimate summary with source count, page count, per-step lines, total, and warnings
- ask `Proceed? [y/N]` when the command is actually about to execute expensive work after showing the estimate
- abort safely on empty/EOF/no input

Behavior:

- Explicit `--cost-estimate` without `--dry-run` shows the estimate and then asks for confirmation before execution
- `--dry-run --cost-estimate` shows the estimate and exits without side effects
- Commands that exceed `config.safety.max_pages_without_confirm` or `config.safety.max_cost_without_confirm_usd` should also show the estimate and require confirmation before executing, even when `--cost-estimate` is omitted
- If there is nothing billable to do, the helper should say so plainly and skip the prompt

### 4.5 Ingest integration

**File:** `apps/cli/src/commands/ingest.ts`

Replace the existing placeholder behavior with real estimation:

- Scan the provided file/directory using the same PDF discovery rules as ingest
- Derive page counts and native-text ratios locally without any paid calls
- Estimate downstream ingest-triggered pipeline cost for the steps Mulder can actually execute today (`extract`, `segment`, `enrich`, `embed`, plus `ground` only when pipeline grounding is enabled in config and included in the live path)
- Keep `--dry-run` semantics intact: no uploads, no DB writes

### 4.6 Pipeline run integration

**File:** `apps/cli/src/commands/pipeline.ts`

Add `--cost-estimate` to `pipeline run` and compute estimates from the actual planned step slice:

- respect `--from` / `--up-to`
- base estimates on the same local path scan used to determine sources for a fresh run
- when resuming from a later step, exclude earlier-step costs
- dry-run + estimate must not create `pipeline_runs` rows

### 4.7 Reprocess command (planning + estimate surface)

**Files:**

- `apps/cli/src/commands/reprocess.ts` (new)
- optional planner helpers in `packages/pipeline/src/reprocess/` or `packages/core/src/database/`

Implement the command surface promised in the CLI tree, but scope this spec to planning/estimation rather than full re-execution:

```text
mulder reprocess
  --dry-run
  --step <step>
  --cost-estimate
```

Behavior:

- Load all sources plus their `source_steps`
- Compare stored step hashes to current config hashes
- Build the minimal per-source reprocess plan using the functional-spec matrix from §3.5
- `--step <step>` forces that step (and downstream dependent cost) for all eligible sources
- `--dry-run` prints which sources/steps would rerun
- `--cost-estimate` prints the projected cost for that plan
- Running without `--dry-run` is allowed to stop with a clear "execution lands in M8-I4" message after printing the plan; this spec's contract is the planning + estimate workflow, not the execution engine

### 4.8 Tests

Add a dedicated black-box spec test, plus smoke-test updates where useful:

- `tests/specs/77_cost_estimator.test.ts` (new)
- `tests/cli-smoke.test.ts` updates for `pipeline run --cost-estimate` and `reprocess --help`

The black-box suite must interact only through CLI subprocesses, SQL, config files, and filesystem fixtures.

## 5. QA Contract

### QA-01: `ingest --dry-run --cost-estimate` prints an estimate and makes no writes

- Given: a valid fixture PDF path
- When: `mulder ingest <path> --dry-run --cost-estimate` is executed
- Then: exit code 0, output contains a total estimated cost, and no `sources` row is created

### QA-02: explicit cost-estimate prompts before live ingest execution

- Given: a valid fixture PDF path and stdin containing `n`
- When: `mulder ingest <path> --cost-estimate` is executed
- Then: output shows the estimate, prompts for confirmation, aborts safely, and no database writes occur

### QA-03: `pipeline run --dry-run --cost-estimate` respects the planned step slice

- Given: a valid fixture PDF path
- When: `mulder pipeline run <path> --from segment --up-to enrich --dry-run --cost-estimate` is executed
- Then: exit code 0, output only estimates the relevant step slice, and no `pipeline_runs` row is created

### QA-04: successful pipeline execution persists non-null config hashes for completed steps

- Given: a source processed through at least `extract`, `segment`, and `enrich`
- When: the corresponding step rows are queried from `source_steps`
- Then: `config_hash` is non-null for each completed reprocessable step

### QA-05: `reprocess --dry-run --cost-estimate` reports no-op when hashes match

- Given: sources whose stored step hashes match the current config
- When: `mulder reprocess --dry-run --cost-estimate` is executed
- Then: exit code 0, output clearly reports no documents require reprocessing, and the total estimated cost is zero

### QA-06: `reprocess --dry-run --cost-estimate` detects changed config and estimates only affected steps

- Given: an existing processed source and a temporary config file with an extraction-setting change
- When: `mulder reprocess --dry-run --cost-estimate <temp-config>` is executed
- Then: the output identifies `extract` plus downstream dependent work for that source and reports a non-zero estimated cost

## 5b. CLI Test Matrix

| Command | Expected behavior |
|---|---|
| `mulder ingest <path> --cost-estimate` | Prints estimate, prompts, honors confirmation answer |
| `mulder ingest <path> --dry-run --cost-estimate` | Prints estimate and exits with no writes |
| `mulder pipeline run <path> --dry-run --cost-estimate` | Prints estimate for the full live step slice, no `pipeline_runs` writes |
| `mulder pipeline run <path> --from segment --up-to enrich --dry-run --cost-estimate` | Prints estimate only for `segment` + `enrich` |
| `mulder reprocess --dry-run --cost-estimate` | Prints plan + estimate for config-driven reprocessing |
| `mulder reprocess --step enrich --dry-run --cost-estimate` | Forces `enrich`-from-here planning and estimates that slice |

## 6. Cost Considerations

- The estimator itself must never call paid services
- All price assumptions are heuristics and should be labeled as estimates in CLI output
- Dry-run + estimate paths must remain safe in `NODE_ENV=test`
- If the live pipeline currently skips a feature (for example grounding when disabled), the estimate should say so instead of silently charging for it
