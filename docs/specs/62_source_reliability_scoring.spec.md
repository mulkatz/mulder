---
spec: "62"
title: "Source Reliability Scoring"
roadmap_step: M6-G4
functional_spec: ["§2.8", "§5.3"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/152"
created: 2026-04-12
---

# Spec 62: Source Reliability Scoring

## 1. Objective

Implement the second Analyze sub-step so `mulder analyze --reliability` computes a single `sources.reliability_score` float using a weighted PageRank-style graph over already-ingested source relationships, then persists the result for downstream evidence, export, and UI consumers. Per `§2.8`, the analysis runs over the full corpus rather than a single story, and per `§5.3` it must surface when the corpus is too sparse for the score to be considered stable. This spec intentionally delivers the current roadmap model; if the later credibility-profile design supersedes it, the scoring engine should be isolated enough to be swapped out without rewriting the CLI surface.

## 2. Boundaries

- **Roadmap Step:** `M6-G4` — Source reliability scoring — `mulder analyze --reliability`
- **Target:** `packages/pipeline/src/analyze/types.ts`, `packages/pipeline/src/analyze/reliability.ts`, `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`, `apps/cli/src/commands/analyze.ts`
- **In scope:** building a source graph from current corpus data, running weighted PageRank, normalizing scores into `0..1`, writing `sources.reliability_score`, exposing the `--reliability` CLI flow, and warning when corpus size is below `thresholds.source_reliability`
- **Out of scope:** multi-dimensional credibility profiles (`M11-L1`), evidence chains (`M6-G5`), spatio-temporal clustering (`M6-G6`), the `--full` analyze orchestrator (`M6-G7`), schema changes, UI/API presentation work, or adding brand-new provenance/citation tables
- **Constraints:** stay within the existing Analyze package and CLI surface; reuse current repositories and database schema; keep the scoring module isolated from contradiction resolution so later replacement or expansion remains tractable; and treat sparse-corpus handling as a warning/degradation concern, not a reason to fail the step

## 3. Dependencies

- **Requires:** Spec 14 (`M2-B2`) source repository, Spec 22 (`M3-C1`) story repository, Spec 24 (`M3-C3`) story-entity repository, Spec 35 (`M4-D5`) graph step outputs, and Spec 61 (`M6-G3`) Analyze command/step scaffolding
- **Blocks:** evidence/report surfaces that want a persisted per-source reliability signal, and any future analyze orchestrator path that bundles reliability with other M6 analysis passes

## 4. Blueprint

### 4.1 Files

1. **`packages/pipeline/src/analyze/types.ts`** — extends the Analyze contract with reliability-selector input plus typed reliability outcomes and summary data
2. **`packages/pipeline/src/analyze/reliability.ts`** — implements source-graph construction from current corpus data, weighted PageRank iteration, sparse-corpus warning logic, and score normalization
3. **`packages/pipeline/src/analyze/index.ts`** — dispatches reliability analysis, persists `sources.reliability_score`, and returns a selector-specific result without breaking contradiction mode
4. **`packages/pipeline/src/index.ts`** — re-exports the updated Analyze types and executor surface
5. **`apps/cli/src/commands/analyze.ts`** — enables `--reliability`, prints a reliability table/summary, rejects unsupported selector combinations, and preserves current error handling for the still-unimplemented analysis modes

### 4.2 Database Changes

None. This step uses the existing `sources.reliability_score FLOAT` column introduced in the core schema.

### 4.3 Config Changes

None. The step uses existing config:

- `analysis.enabled`
- `analysis.reliability`
- `thresholds.source_reliability`

### 4.4 Integration Points

- Build the source graph from existing graph-era data already in PostgreSQL: sources, stories, and `story_entities`
- Represent source-to-source links as weighted edges based on shared entities across distinct sources; because the current schema has no dedicated citation table, entity co-occurrence is the authoritative graph input for this step
- Run weighted PageRank over that graph, normalize the converged values into `0..1`, and persist them with `updateSource(...)`
- The Analyze CLI must allow exactly one active implemented selector at a time: `--contradictions` or `--reliability`
- Sparse-corpus handling should annotate the result and CLI summary when eligible source count is below `thresholds.source_reliability`, but still persist computed scores so existing consumers can use the interim signal

### 4.5 Implementation Phases

Single phase — implement the typed reliability contract, scoring engine, Analyze-step wiring, and CLI support in one coherent change. The work is small enough to land as one vertical slice without a multi-PR split.

## 5. QA Contract

1. **QA-01: Reliability analysis scores graph-connected sources and persists results**
   - Given: the database contains at least three graph-ready sources with stories that share entities across source boundaries, and `analysis.enabled=true` with `analysis.reliability=true`
   - When: `mulder analyze --reliability` runs successfully
   - Then: the command exits `0`, prints a scored-source summary, and every scored source has a non-null `sources.reliability_score` between `0` and `1`

2. **QA-02: Re-running reliability analysis is idempotent for unchanged corpus data**
   - Given: the same graph-connected sources have already been scored once
   - When: `mulder analyze --reliability` runs again without any new stories, entities, or source links
   - Then: the command exits `0`, reports the same number of scored sources, and previously stored reliability scores remain unchanged within exact persisted precision

3. **QA-03: Sparse corpora succeed with a degradation warning**
   - Given: eligible source count is below `thresholds.source_reliability` but at least one graph-connected source pair exists
   - When: `mulder analyze --reliability` runs
   - Then: the command exits `0`, persists reliability scores, and clearly warns that the corpus is below the meaningful reliability threshold

4. **QA-04: Disabled reliability analysis fails before writing scores**
   - Given: `analysis.enabled=false` or `analysis.reliability=false`
   - When: `mulder analyze --reliability` runs
   - Then: the command exits non-zero with an Analyze-step disabled error, and no `sources.reliability_score` values are modified

5. **QA-05: No-op runs succeed when no source graph can be formed**
   - Given: the database has no graph-connected sources (for example, no stories, no story-entity links, or only isolated single-source entities)
   - When: `mulder analyze --reliability` runs
   - Then: the command exits `0`, prints a clear “nothing to analyze” style summary, and makes no score updates

## 5b. CLI Test Matrix

### `mulder analyze --reliability`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `--reliability` | Exit `0`, scores all eligible sources and prints a reliability table |
| CLI-02 | `--reliability` *(run twice)* | Exit `0`, second run preserves the first run’s scores |
| CLI-03 | `--contradictions --reliability` | Exit non-zero, because multi-selector analyze orchestration belongs to `M6-G7` |
| CLI-04 | `--reliability --full` | Exit non-zero, because `--full` is not implemented yet |

### Selector validation

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-05 | *(no args)* | Exit non-zero, usage/help indicates that an analysis selector is required |
| CLI-06 | `--full` | Exit non-zero, because the full Analyze orchestrator is not implemented yet |
| CLI-07 | `--evidence-chains` | Exit non-zero, because evidence chains belong to `M6-G5` |
| CLI-08 | `--spatio-temporal` | Exit non-zero, because clustering belongs to `M6-G6` |

## 6. Cost Considerations

None — no paid API calls. This step is pure PostgreSQL computation over existing graph data.
