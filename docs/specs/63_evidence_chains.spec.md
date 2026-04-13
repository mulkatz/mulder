---
spec: "63"
title: "Evidence Chains"
roadmap_step: M6-G5
functional_spec: ["§2.8", "§4.3"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/162"
created: 2026-04-12
---

# Spec 63: Evidence Chains

## 1. Objective

Implement Mulder's third Analyze sub-step so `mulder analyze --evidence-chains` resolves one or more thesis queries into deterministic graph traversals, stores the resulting evidence paths in `evidence_chains`, and exposes the results through the existing Analyze CLI surface. Per `§2.8`, the step operates on the full graph rather than a single story, uses recursive traversal with cycle detection to trace supporting paths, and persists each thesis/path/strength result for later evidence review and export. Per `§4.3`, the persisted output must land in the existing `evidence_chains` table using its `thesis`, `path`, `strength`, `supports`, and `computed_at` columns. Per `§5.3`, the feature must stay unavailable on sparse corpora: if the processed-source corpus is below `thresholds.corroboration_meaningful`, Analyze reports a degraded "not yet available" reason and must not traverse or write misleading `evidence_chains` rows.

## 2. Boundaries

- **Roadmap Step:** `M6-G5` — Evidence chains — `mulder analyze --evidence-chains`
- **Target:** `packages/core/src/config/schema.ts`, `packages/core/src/config/defaults.ts`, `mulder.config.example.yaml`, `packages/core/src/database/repositories/evidence-chain.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/core/src/shared/errors.ts`, `packages/core/src/index.ts`, `packages/pipeline/src/analyze/types.ts`, `packages/pipeline/src/analyze/evidence-chains.ts`, `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`, `apps/cli/src/commands/analyze.ts`
- **In scope:** config support for default thesis queries, deterministic thesis-to-seed resolution using existing alias/entity matching, recursive graph traversal for evidence-path discovery, persistence helpers for replacing chain snapshots per thesis, sparse-data availability gating before traversal or writes, Analyze-step orchestration and reporting for evidence-chain runs, and CLI support for `--evidence-chains` plus repeatable thesis overrides
- **Out of scope:** LLM-based thesis interpretation, the `--full` Analyze orchestrator (`M6-G7`), spatio-temporal clustering (`M6-G6`), UI/API evidence browsing, new schema migrations, or changes to retrieval ranking, reranking, or export surfaces beyond what is required to persist evidence-chain rows
- **Constraints:** keep the step global rather than source- or story-scoped; gate execution with `analysis.enabled` and `analysis.evidence_chains`; treat `thresholds.corroboration_meaningful` as the evidence-chain availability threshold, measured against processed sources beyond raw ingest; prefer deterministic SQL + alias matching over paid model calls; reuse the existing retrieval graph limits (`retrieval.strategies.graph.max_hops`, `retrieval.strategies.graph.supernode_threshold`) for traversal safety; and preserve idempotency by replacing previously stored rows for a thesis on recomputation rather than appending duplicates

## 3. Dependencies

- **Requires:** Spec 24 (`M3-C3`) entity + alias repositories, Spec 25 (`M3-C4`) edge repository, Spec 39 (`M4-E3`) graph traversal SQL pattern, Spec 42 (`M4-E6`) deterministic query-entity extraction, Spec 54 (`M6-G1`) v2.0 schema migrations, and Specs 61-62 (`M6-G3`/`M6-G4`) Analyze scaffolding and selector handling
- **Blocks:** `M6-G7` analyze orchestrator and any downstream evidence/export/UI work that expects persisted thesis-to-path records instead of ad hoc traversal at read time

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/config/schema.ts`** — extends `analysis` with an `evidence_theses` string array used when the CLI is invoked without explicit thesis overrides
2. **`packages/core/src/config/defaults.ts`** — defines the default empty evidence-thesis list
3. **`mulder.config.example.yaml`** — documents the new `analysis.evidence_theses` config surface with one or two concrete example thesis strings
4. **`packages/core/src/database/repositories/evidence-chain.repository.ts`** — adds persistence helpers for listing chains by thesis, deleting a thesis snapshot, and inserting computed rows into `evidence_chains`
5. **`packages/core/src/database/repositories/index.ts`** — exports the evidence-chain repository functions and types
6. **`packages/core/src/shared/errors.ts`** — adds Analyze-step error codes for missing thesis input, unresolved thesis seeds, and evidence-chain persistence/traversal failures
7. **`packages/core/src/index.ts`** — re-exports the new config, repository, and error symbols for pipeline/CLI consumers
8. **`packages/pipeline/src/analyze/types.ts`** — extends `AnalyzeInput` with `evidenceChains` and repeatable `theses`, and adds typed evidence-chain outcomes + summary data
9. **`packages/pipeline/src/analyze/evidence-chains.ts`** — computes evidence chains: resolve thesis queries to seed entities, run recursive traversal with cycle detection and supernode pruning, derive per-path strength, and emit both supporting and contradiction-backed outcomes
10. **`packages/pipeline/src/analyze/index.ts`** — dispatches the evidence-chain mode, enforces config plus sparse-data gates, replaces persisted rows per thesis only when the feature is available, and reports success/partial/failure alongside the existing contradiction and reliability modes
11. **`packages/pipeline/src/index.ts`** — re-exports the expanded Analyze contract
12. **`apps/cli/src/commands/analyze.ts`** — enables `--evidence-chains`, adds repeatable `--thesis <text>` overrides, validates selector combinations, and prints an evidence-chain summary/table

### 4.2 Database Changes

None. This step uses the existing `evidence_chains` table introduced in Spec 54:

- `thesis` stores the resolved thesis string for the run
- `path` stores the ordered UUID path for the discovered chain
- `strength` stores the computed path strength (edge-confidence product or contradiction confidence)
- `supports` distinguishes supporting chains from contradiction-backed chains
- `computed_at` records when the thesis snapshot was recomputed

Because the table has no uniqueness constraint, implementation must delete prior rows for a thesis before inserting the newly computed snapshot to keep re-runs idempotent.

### 4.3 Config Changes

Extend the existing `analysis` config block with:

- `enabled`
- `evidence_chains`
- `evidence_theses`

Behavior:

- If `--thesis` is provided one or more times, those thesis strings are the entire input set for the run
- If no `--thesis` flags are provided, use `analysis.evidence_theses`
- If neither source provides a non-empty thesis, fail fast with a clear Analyze-step validation error
- Evidence-chain availability reuses `thresholds.corroboration_meaningful`; when the processed-source corpus is below that threshold, the step reports a sparse-data skip and must not traverse or persist rows

Traversal should reuse the existing retrieval graph tuning already present in config:

- `retrieval.strategies.graph.max_hops`
- `retrieval.strategies.graph.supernode_threshold`

### 4.4 Integration Points

- Thesis-to-seed resolution should reuse `extractQueryEntities()` from `@mulder/retrieval` so the step stays deterministic and aligned with Mulder's existing query-entity matching behavior
- Sparse-data gating should reuse the shared processed-source corpus count so evidence chains, taxonomy bootstrap, and query confidence all reason about corpus size from the same source-of-truth metric
- Supporting chains should follow the established recursive-CTE traversal pattern from graph retrieval, including cycle detection and supernode pruning
- Contradiction-backed chains should reuse resolved contradiction edges (`CONFIRMED_CONTRADICTION`) for any thesis seed entity and persist those rows with `supports=false`
- Persistence should live behind repository helpers so Analyze does not issue ad hoc insert/delete SQL inline
- The Analyze CLI must continue to allow exactly one implemented selector at a time, now including `--evidence-chains`
- CLI output should mirror the current Analyze ergonomics: concise table first, summary second, sparse-data skips reported as warnings, and non-zero exit only for total failure or invalid invocation

### 4.5 Implementation Phases

**Phase 1: Config + contracts**
- Files: `packages/core/src/config/schema.ts`, `packages/core/src/config/defaults.ts`, `mulder.config.example.yaml`, `packages/core/src/shared/errors.ts`, `packages/core/src/index.ts`, `packages/pipeline/src/analyze/types.ts`
- Deliverable: the repo understands default thesis configuration, explicit thesis overrides, and the typed Analyze contract for evidence-chain runs

**Phase 2: Computation + persistence**
- Files: `packages/core/src/database/repositories/evidence-chain.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/pipeline/src/analyze/evidence-chains.ts`, `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`
- Deliverable: thesis queries can be resolved into deterministic graph evidence paths, persisted idempotently in `evidence_chains`, and reported as success/partial/failure with supporting vs contradiction-backed counts

**Phase 3: CLI surface**
- Files: `apps/cli/src/commands/analyze.ts`
- Deliverable: `mulder analyze --evidence-chains` works end to end with configured theses, repeatable `--thesis` overrides, validation feedback, and readable summary output

## 5. QA Contract

1. **QA-01: Sparse corpora skip evidence-chain traversal and writes**
   - Given: `analysis.enabled=true`, `analysis.evidence_chains=true`, at least one thesis input is available, and the processed-source corpus is below `thresholds.corroboration_meaningful`
   - When: `mulder analyze --evidence-chains` runs
   - Then: the command exits `0`, reports a clear sparse-data disabled/degraded reason, and does not insert or replace any `evidence_chains` rows

2. **QA-02: Configured evidence theses persist supporting chains**
   - Given: `analysis.enabled=true`, `analysis.evidence_chains=true`, `analysis.evidence_theses` contains a thesis whose terms resolve to at least one graph-connected entity, the processed-source corpus is at or above `thresholds.corroboration_meaningful`, and supporting relationship edges exist in the corpus
   - When: `mulder analyze --evidence-chains` runs successfully
   - Then: the command exits `0`, creates one or more `evidence_chains` rows for that thesis with non-empty `path`, `strength > 0`, and `supports=true`

3. **QA-03: Re-running the same thesis is idempotent**
   - Given: the same thesis has already been computed once against an unchanged corpus whose processed-source count stays at or above `thresholds.corroboration_meaningful`
   - When: `mulder analyze --evidence-chains` is run again with the same thesis input
   - Then: the command exits `0`, the thesis still has a single recomputed snapshot in `evidence_chains`, and no duplicate rows accumulate across runs

4. **QA-04: CLI thesis overrides work without config theses**
   - Given: `analysis.enabled=true`, `analysis.evidence_chains=true`, `analysis.evidence_theses` is empty, the processed-source corpus is at or above `thresholds.corroboration_meaningful`, and the corpus contains aliases matching a supplied thesis string
   - When: `mulder analyze --evidence-chains --thesis "Acme activity in Berlin"` runs
   - Then: the command exits `0`, computes chains for the supplied thesis, and persists rows whose `thesis` column matches the CLI-provided string

5. **QA-05: Confirmed contradiction evidence is persisted as non-supporting**
   - Given: a thesis resolves to an entity that already has at least one `CONFIRMED_CONTRADICTION` edge, and the processed-source corpus is at or above `thresholds.corroboration_meaningful`
   - When: `mulder analyze --evidence-chains` runs for that thesis
   - Then: at least one persisted `evidence_chains` row for the thesis has `supports=false` and a positive `strength`

6. **QA-06: Missing thesis input fails before traversal or writes**
   - Given: `analysis.enabled=true`, `analysis.evidence_chains=true`, `analysis.evidence_theses` is empty, and no `--thesis` flag is provided
   - When: `mulder analyze --evidence-chains` runs
   - Then: the command exits non-zero with an Analyze-step validation error, and no new rows are inserted into `evidence_chains`

7. **QA-07: Unresolvable theses report partial failure without blocking valid ones**
   - Given: one thesis resolves to graph-connected entities, another thesis resolves to no entities, and the processed-source corpus is at or above `thresholds.corroboration_meaningful`
   - When: `mulder analyze --evidence-chains --thesis "valid thesis" --thesis "unknown thesis"` runs
   - Then: the valid thesis persists rows successfully, the unresolved thesis is reported as a failure, and the overall command reports partial completion rather than rolling back the successful thesis

8. **QA-08: Disabled evidence-chain analysis fails before writes**
   - Given: `analysis.enabled=false` or `analysis.evidence_chains=false`
   - When: `mulder analyze --evidence-chains` runs
   - Then: the command exits non-zero with an Analyze-step disabled error, and no `evidence_chains` rows are modified

## 5b. CLI Test Matrix

### `mulder analyze --evidence-chains`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `--evidence-chains` *(corpus below `thresholds.corroboration_meaningful`)* | Exit `0`, reports sparse-data gating, and persists no evidence-chain rows |
| CLI-02 | `--evidence-chains` | Exit `0`, uses configured thesis strings and persists evidence-chain rows when the corpus is at or above the threshold |
| CLI-03 | `--evidence-chains --thesis "Acme activity in Berlin"` | Exit `0`, computes rows for the provided thesis only |
| CLI-04 | `--evidence-chains --thesis "A" --thesis "B"` | Exit `0` or partial, processes both thesis strings in one run |
| CLI-05 | `--evidence-chains` *(run twice)* | Exit `0`, recomputes the thesis snapshot without accumulating duplicate rows |
| CLI-06 | `--evidence-chains --reliability` | Exit non-zero, because running multiple Analyze selectors together is not implemented yet |
| CLI-07 | `--evidence-chains --contradictions` | Exit non-zero, because running multiple Analyze selectors together is not implemented yet |
| CLI-08 | `--evidence-chains --full` | Exit non-zero, because `--full` belongs to `M6-G7` |
| CLI-09 | `--evidence-chains --thesis ""` | Exit non-zero with thesis validation feedback |

### Selector validation

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-10 | *(no args)* | Exit non-zero, usage/help indicates that an analysis selector is required |
| CLI-11 | `--spatio-temporal` | Exit non-zero, because clustering belongs to `M6-G6` |

## 6. Cost Considerations

None — this step should remain deterministic and database-backed, reusing existing alias matching and recursive SQL instead of making paid LLM or web-grounding calls.
