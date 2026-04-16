---
spec: "78"
title: "Selective Reprocessing via Config-Hash Diffing"
roadmap_step: M8-I4
functional_spec: ["§3.5", "§4.3", "§16"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/204"
created: 2026-04-15
---

# Spec 78: Selective Reprocessing via Config-Hash Diffing

## 1. Objective

Implement `mulder reprocess` so Mulder can detect which already-ingested documents need work after relevant config changes and rerun only the affected pipeline steps. Per `§3.5`, this workflow uses `source_steps.config_hash` as the durable source of truth, compares stored hashes against the current config, builds the minimal rerun plan per source, and executes that plan without forcing a full re-ingest or full pipeline replay.

This step must close the operational gap left by the existing orchestrator. Today, Mulder can retry failures and rerun contiguous pipeline slices, but it does not persist meaningful per-step config hashes and cannot answer "what changed?" after ontology, taxonomy, extraction, or analysis configuration edits. `M8-I4` adds that missing selective-reprocessing layer while preserving the existing pipeline commands as the execution engine where appropriate.

This spec intentionally does not implement spend estimation math for `--cost-estimate`; that broader estimator surface remains the responsibility of `M8-I2`. For `M8-I4`, the command must expose the reprocess planning surface, integrate cleanly with current CLI conventions, and leave a clear seam for `M8-I2` to attach full cost calculations without re-architecting the workflow.

## 2. Boundaries

- **Roadmap Step:** `M8-I4` — Schema evolution / reprocessing
- **Target:** `apps/cli/src/commands/reprocess.ts`, `apps/cli/src/index.ts`, `packages/pipeline/src/reprocess/index.ts`, `packages/pipeline/src/reprocess/types.ts`, `packages/pipeline/src/index.ts`, `packages/core/src/config/reprocess-hash.ts`, `packages/core/src/config/index.ts`, `packages/core/src/database/repositories/source.repository.ts`, `packages/core/src/database/repositories/source.types.ts`, `packages/core/src/index.ts`, `packages/pipeline/src/extract/index.ts`, `packages/pipeline/src/segment/index.ts`, `packages/pipeline/src/enrich/index.ts`, `packages/pipeline/src/embed/index.ts`, `packages/pipeline/src/graph/index.ts`, `tests/specs/78_selective_reprocessing.test.ts`, `tests/cli-smoke.test.ts`
- **In scope:** adding a dedicated `reprocess` CLI command; persisting non-null config hashes for completed pipeline steps; defining stable step-relevant config hashing rules; loading existing `source_steps` rows and computing per-source reprocess plans; supporting `--dry-run`, `--step <step>`, and `--cost-estimate` command surfaces; executing selective reruns against existing sources by reusing the pipeline/step executors; and black-box verification of both planning and execution behavior
- **Out of scope:** re-ingest of raw files, automatic schema migrations, cost-estimation math or confirmation prompts beyond a clear placeholder seam for `M8-I2`, UI workflows, Firestore-driven planning, multi-format source skipping (`M9`), and dead-letter recovery (`M8-I5`)
- **Constraints:** PostgreSQL `source_steps` remains the sole planning source of truth; do not read Firestore for reprocess decisions; preserve the functional-spec reprocessing matrix in `§3.5`; keep business logic out of the CLI wrapper; and do not require a contiguous full pipeline rerun when the functional spec explicitly says intermediate artifacts can be preserved

## 3. Dependencies

- **Requires:** `M4-D6` pipeline orchestrator (`docs/specs/36_pipeline_orchestrator.spec.md`); source-step persistence from earlier pipeline steps; and reset semantics from `docs/specs/30_cascading_reset_function.spec.md`
- **Blocks:** `M8-I5` operational recovery work benefits from the same "re-run existing sources safely" infrastructure; `M8-I2` cost estimation can plug into this command once the reprocess planning data shape exists
- **Known milestone dependency note:** `M8-I2` is still open, so this spec must leave `--cost-estimate` as a stable interface with plan-aware output/seams rather than trying to absorb the full estimator feature into `I4`

## 4. Blueprint

### 4.1 Files

1. **`apps/cli/src/commands/reprocess.ts`** — Commander command group for `mulder reprocess`, argument parsing, help text, output formatting, and delegation into pipeline reprocess logic
2. **`apps/cli/src/index.ts`** — registers the new `reprocess` command
3. **`packages/pipeline/src/reprocess/types.ts`** — typed plan/result contracts for dry-run and execution
4. **`packages/pipeline/src/reprocess/index.ts`** — reprocess planner/executor that compares hashes, builds per-source plans, and invokes the existing step/orchestrator surfaces
5. **`packages/pipeline/src/index.ts`** — exports the new reprocess module
6. **`packages/core/src/config/reprocess-hash.ts`** — stable config-subset selection plus deterministic hashing helpers for each tracked pipeline step
7. **`packages/core/src/config/index.ts` and `packages/core/src/index.ts`** — barrel exports for the new hashing/reprocess helpers
8. **`packages/core/src/database/repositories/source.repository.ts` and `source.types.ts`** — queries/types to load source-step hashes in bulk for planning
9. **Pipeline step files (`extract`, `segment`, `enrich`, `embed`, `graph`)** — persist the correct config hash into `source_steps` on successful completion
10. **`tests/specs/78_selective_reprocessing.test.ts`** — black-box QA coverage for planning, dry-run, forced step execution, and selective rerun effects
11. **`tests/cli-smoke.test.ts`** — help/smoke assertions for the new command surface

### 4.2 Reprocess Command Contract

The command surface must match the functional-spec intent:

- `mulder reprocess --dry-run`
- `mulder reprocess`
- `mulder reprocess --step enrich`
- `mulder reprocess --cost-estimate`

Behavior requirements:

- no positional path argument; this command operates on already-known sources
- `--dry-run` prints the detected plan and makes no database or artifact changes
- plain `mulder reprocess` executes only the sources/steps that need reruns according to config-hash diffing
- `--step <step>` bypasses config diffing and forces that step for every eligible existing source, along with only the downstream cleanup/reruns required for correctness
- `--cost-estimate` must be accepted now, return plan-aware placeholder output, and avoid performing live reruns; detailed spend math is deferred to `M8-I2`

### 4.3 Config Hashing Rules

`source_steps.config_hash` must become meaningful for every completed tracked step. Hashes must be deterministic, SHA-256 based, and computed from canonical JSON over the relevant config subset only.

Tracked step subsets:

- `extract` — `extraction`
- `segment` — `extraction.segmentation`
- `enrich` — `ontology`, `enrichment`, `taxonomy`, `entity_resolution`
- `embed` — `embedding`
- `graph` — `deduplication`, `graph`, and any graph-only thresholds that change graph output
- reserved for future compatibility: `ground` from `grounding`, `analyze` from `analysis` plus relevant thresholds

Non-tracked config must not trigger reruns:

- retrieval/reranker settings are query-time only and must not mark sources dirty
- API/auth/UI config must not affect reprocess planning
- unrelated safety limits must not alter stored step hashes

### 4.4 Reprocess Planning Matrix

Planning must honor the `§3.5` matrix rather than blindly rerunning every later step in pipeline order.

Required minimum cases:

- extraction-hash change -> rerun `extract`, `segment`, `enrich`, `embed`, `graph`, and `analyze` only when enabled
- segmentation-only change -> rerun `segment`, `enrich`, `embed`, `graph`, and `analyze` only when enabled
- enrich-hash change from ontology/entity-extraction config -> rerun `enrich`, `graph`, and `analyze`; preserve `extract`, `segment`, and `embed`
- taxonomy-only enrich change -> same preservation rule as above; `embed` must remain preserved
- embed-hash change -> rerun `embed`, `graph`, and `analyze`
- graph-hash change -> rerun `graph` and `analyze`
- analysis-hash change -> rerun `analyze` only when analysis is enabled
- no relevant hash changes -> source is omitted from live execution and reported as up to date

The implementation may represent this as an explicit impact map rather than assuming the normal pipeline order.

### 4.5 Execution Strategy

Execution must reuse existing business logic rather than duplicating step internals:

- use the existing pipeline step executors (`executeExtract`, `executeSegment`, `executeEnrich`, `executeEmbed`, `executeGraph`, and `executeAnalyze` when enabled) as the source of truth
- allow sparse reprocess plans per source instead of only contiguous `--from/--up-to` slices
- use `force` only where necessary to trigger the correct cleanup/reset semantics before rerunning a step
- keep source/story status transitions correct when a preserved step is intentionally skipped
- create a `pipeline_runs` row for live execution so reprocess work remains observable through existing pipeline history

If a source has no recorded `source_steps` history for a requested step, treat it as needing that step rather than silently skipping it.

### 4.6 Repository Queries

Add repository support for efficient planning over many sources:

- list all sources together with their existing `source_steps`
- optionally filter to sources that have reached or passed a requested step when `--step` is used
- expose types that let the planner reason over `(source, sourceSteps[])` without raw SQL in the pipeline package

The repository layer must stay parameterized and typed, following existing Mulder repository conventions.

### 4.7 Implementation Phases

**Phase 1: hash persistence**
- add deterministic config-hash helpers
- update step executors to write non-null `config_hash` values on success

**Phase 2: planning**
- add repository reads and reprocess plan calculation
- implement dry-run output and no-op detection

**Phase 3: execution**
- execute sparse rerun plans against existing sources
- record a pipeline run and surface a summary through the CLI

**Phase 4: command polish**
- wire help text, `--step`, `--dry-run`, and `--cost-estimate`
- add smoke/spec coverage

## 5. QA Contract

1. **QA-01: completed pipeline steps persist non-null config hashes**
   - Given: a source processed through tracked steps
   - When: `source_steps` rows are inspected after successful execution
   - Then: each completed tracked step stores a non-null `config_hash` matching the current config subset for that step

2. **QA-02: `reprocess --dry-run` reports no-op when hashes match**
   - Given: existing sources whose stored hashes match the current config
   - When: `mulder reprocess --dry-run` is run
   - Then: the command exits successfully, reports that no sources require reruns, and makes no writes

3. **QA-03: extraction config changes trigger full downstream reprocessing**
   - Given: a processed source with stored step hashes
   - When: an extraction-relevant config value changes and `mulder reprocess --dry-run` is run
   - Then: the plan includes reruns for `extract`, `segment`, `enrich`, `embed`, and `graph` for that source

4. **QA-04: ontology/taxonomy changes preserve embeddings**
   - Given: a processed source with chunks already generated
   - When: an enrich-relevant ontology or taxonomy config value changes and `mulder reprocess --dry-run` is run
   - Then: the plan includes `enrich` and `graph` reruns, excludes `embed`, and preserves existing chunk records

5. **QA-05: `reprocess` executes only affected sources**
   - Given: one source with changed hashes and one source still up to date
   - When: `mulder reprocess` is run
   - Then: only the affected source is rerun and the up-to-date source is reported as skipped

6. **QA-06: `reprocess --step <step>` forces the requested step for all eligible sources**
   - Given: existing sources that have previously reached the requested step
   - When: `mulder reprocess --step enrich` is run
   - Then: each eligible source reruns the enrich step and any required dependent reruns, even if hashes still match

7. **QA-07: `--cost-estimate` is accepted without performing live work**
   - Given: any repository state
   - When: `mulder reprocess --cost-estimate` is run
   - Then: the command exits successfully with plan-aware placeholder output and does not perform step execution

8. **QA-08: live reprocess remains observable through pipeline run history**
   - Given: a non-empty reprocess plan
   - When: `mulder reprocess` completes
   - Then: a `pipeline_runs` row exists for that execution and the summary can be inspected through existing pipeline status/history mechanisms

## 5b. CLI Test Matrix

- `mulder reprocess --help`
- `mulder reprocess --dry-run`
- `mulder reprocess --step enrich --dry-run`
- `mulder reprocess --cost-estimate`
- `mulder reprocess --step bogus` -> validation error

## 6. Cost Considerations

- **Services called:** reprocess may invoke the same paid extraction/LLM/embedding services as normal pipeline execution, but only for sources whose relevant config changed
- **Operational goal:** reduce spend and runtime by avoiding full corpus reruns after narrow config edits
- **Safety requirement:** `--dry-run` and `--cost-estimate` must remain non-destructive; detailed dollar estimation and interactive confirmation stay owned by `M8-I2`
