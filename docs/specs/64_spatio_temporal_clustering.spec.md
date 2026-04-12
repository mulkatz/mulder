---
spec: "64"
title: "Spatio-Temporal Clustering"
roadmap_step: M6-G6
functional_spec: ["§2.8", "§4.3"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/156"
created: 2026-04-12
---

# Spec 64: Spatio-Temporal Clustering

## 1. Objective

Implement Mulder's fourth Analyze sub-step so `mulder analyze --spatio-temporal` discovers event clusters that are close in time, close in space, or close in both dimensions, then persists those cluster snapshots in `spatio_temporal_clusters` for downstream evidence, export, and UI consumers. Per `§2.8`, the step runs over the full corpus rather than a single story, loads event-like entities with coordinates and timestamps, applies temporal grouping with `analysis.cluster_window_days`, uses PostGIS proximity checks for spatial grouping, and stores the resulting records with clear cluster typing.

## 2. Boundaries

- **Roadmap Step:** `M6-G6` — Spatio-temporal clustering — `mulder analyze --spatio-temporal`
- **Target:** `packages/core/src/database/repositories/spatio-temporal-cluster.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/core/src/index.ts`, `packages/pipeline/src/analyze/types.ts`, `packages/pipeline/src/analyze/spatio-temporal.ts`, `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`, `apps/cli/src/commands/analyze.ts`
- **In scope:** loading clusterable entity events from PostgreSQL using existing grounded coordinates plus timestamp attributes, computing temporal, spatial, and combined clusters, replacing persisted cluster snapshots idempotently, exposing `--spatio-temporal` through the existing Analyze CLI, and surfacing sparse-data degradation when the corpus is below the configured temporal clustering threshold
- **Out of scope:** the `--full` Analyze orchestrator (`M6-G7`), new schema migrations, new grounding or entity-extraction behavior, UI/API presentation work, map visualization, or new paid LLM and web-grounding calls
- **Constraints:** keep the step global rather than story-scoped per `§2.8`; treat `entities.geom` plus `attributes.iso_date` as the authoritative event input contract for this milestone; use PostgreSQL/PostGIS only, with no model calls; preserve idempotency by replacing previous cluster snapshots on each successful run instead of appending duplicates; and degrade gracefully when eligible event volume is below `thresholds.temporal_clustering`

## 3. Dependencies

- **Requires:** Spec 11 (`M1-A10`) service abstraction and shared exports, Spec 24 (`M3-C3`) entity repository types, Spec 54 (`M6-G1`) v2.0 schema migrations, Spec 60 (`M6-G2`) grounding-driven geometry persistence, and Specs 61-63 (`M6-G3`/`M6-G4`/`M6-G5`) Analyze scaffolding plus selector handling
- **Blocks:** `M6-G7` analyze orchestrator and any downstream review/export/UI flow that expects persisted clustering snapshots instead of ad hoc clustering logic at read time

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/database/repositories/spatio-temporal-cluster.repository.ts`** — defines typed cluster-row persistence helpers for clearing and inserting `spatio_temporal_clusters` snapshots plus any query helpers needed by Analyze
2. **`packages/core/src/database/repositories/index.ts`** — exports the new spatio-temporal cluster repository surface
3. **`packages/core/src/index.ts`** — re-exports the cluster repository types/functions for pipeline and CLI consumers
4. **`packages/pipeline/src/analyze/types.ts`** — extends the Analyze contract with `spatioTemporal` input plus typed event, cluster, and summary outcome shapes
5. **`packages/pipeline/src/analyze/spatio-temporal.ts`** — loads eligible events from entities, groups them into temporal, spatial, and combined clusters, computes centroids/time windows, and returns deduplicated cluster results
6. **`packages/pipeline/src/analyze/index.ts`** — dispatches the spatio-temporal mode, enforces config gates and sparse-threshold behavior, replaces persisted snapshots transactionally, and reports success/partial/failure alongside existing Analyze modes
7. **`packages/pipeline/src/index.ts`** — re-exports the expanded Analyze types and executor surface
8. **`apps/cli/src/commands/analyze.ts`** — enables `--spatio-temporal`, validates selector combinations, prints a concise cluster summary/table, and preserves the current Analyze error-handling ergonomics

### 4.2 Database Changes

None. This step uses the existing v2.0 schema introduced in Spec 54:

- `spatio_temporal_clusters.center_lat`
- `spatio_temporal_clusters.center_lng`
- `spatio_temporal_clusters.time_start`
- `spatio_temporal_clusters.time_end`
- `spatio_temporal_clusters.event_count`
- `spatio_temporal_clusters.event_ids`
- `spatio_temporal_clusters.cluster_type`
- `spatio_temporal_clusters.computed_at`
- `entities.geom`

Implementation must replace the prior cluster snapshot before inserting the newly computed rows so reruns stay idempotent.

### 4.3 Config Changes

None. This step uses existing config:

- `analysis.enabled`
- `analysis.spatio_temporal`
- `analysis.cluster_window_days`
- `thresholds.temporal_clustering`

Behavior:

- If `analysis.enabled=false` or `analysis.spatio_temporal=false`, fail fast with an Analyze-step disabled error before reading clusterable events
- If the count of timestamp-bearing eligible events is below `thresholds.temporal_clustering`, return a successful degraded result with a clear warning and do not persist misleading cluster rows

### 4.4 Integration Points

- Event loading should read from `entities` only, using grounded `geom` coordinates and `attributes.iso_date` as the current milestone's event signal
- Temporal grouping should cluster events whose timestamps fall within `analysis.cluster_window_days` of one another
- Spatial grouping should use PostGIS distance checks against `entities.geom`; center coordinates should be derived from the grouped event geometries
- Combined clusters should include only events that satisfy both the temporal window and spatial proximity rules
- Persistence must live behind repository helpers so Analyze does not issue ad hoc insert/delete SQL inline
- The Analyze CLI must continue to allow exactly one implemented selector at a time, now including `--spatio-temporal`
- CLI output should mirror the current Analyze ergonomics: table first when rows exist, summary second, non-zero exit only for invalid invocation or total failure

### 4.5 Implementation Phases

Single phase — implement the cluster repository, spatio-temporal computation, Analyze-step wiring, and CLI support as one coherent vertical slice. The work is bounded to eight files and one database-backed concern, so a single PR is the right size.

## 5. QA Contract

1. **QA-01: Spatio-temporal analysis persists combined clusters for eligible events**
   - Given: `analysis.enabled=true`, `analysis.spatio_temporal=true`, at least `thresholds.temporal_clustering` entities have both `attributes.iso_date` and `geom`, and at least one subset falls within the configured temporal window and spatial proximity
   - When: `mulder analyze --spatio-temporal` runs successfully
   - Then: the command exits `0`, writes one or more `spatio_temporal_clusters` rows with `cluster_type='spatio-temporal'`, non-empty `event_ids`, `event_count > 0`, and non-null center/time bounds

2. **QA-02: Re-running clustering is idempotent for unchanged event data**
   - Given: the same eligible events have already been clustered once
   - When: `mulder analyze --spatio-temporal` runs again without any changes to entity timestamps or geometry
   - Then: the command exits `0`, preserves the same cluster snapshot semantics, and does not accumulate duplicate rows across runs

3. **QA-03: Sparse corpora degrade gracefully without persisting misleading clusters**
   - Given: `analysis.enabled=true`, `analysis.spatio_temporal=true`, but the number of eligible timestamp-bearing events is below `thresholds.temporal_clustering`
   - When: `mulder analyze --spatio-temporal` runs
   - Then: the command exits `0`, reports that the corpus is below the clustering threshold, and leaves `spatio_temporal_clusters` empty

4. **QA-04: Disabled spatio-temporal analysis fails before any writes**
   - Given: `analysis.enabled=false` or `analysis.spatio_temporal=false`
   - When: `mulder analyze --spatio-temporal` runs
   - Then: the command exits non-zero with an Analyze-step disabled error, and no `spatio_temporal_clusters` rows are inserted, deleted, or updated

5. **QA-05: Events missing one dimension still contribute only to valid cluster types**
   - Given: some entities have only timestamps, some have only geometry, and some have both
   - When: `mulder analyze --spatio-temporal` runs with enough eligible data
   - Then: timestamp-only events may contribute only to `cluster_type='temporal'`, geometry-only events may contribute only to `cluster_type='spatial'`, and only dual-qualified events appear in `cluster_type='spatio-temporal'`

6. **QA-06: No-op runs succeed cleanly when no clusterable events exist**
   - Given: the database contains no entities with either usable timestamps or usable grounded coordinates
   - When: `mulder analyze --spatio-temporal` runs
   - Then: the command exits `0`, prints a clear “nothing to analyze” style summary, and makes no database changes

## 5b. CLI Test Matrix

### `mulder analyze --spatio-temporal`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `--spatio-temporal` | Exit `0`, computes and persists the current cluster snapshot |
| CLI-02 | `--spatio-temporal` *(run twice)* | Exit `0`, second run preserves snapshot semantics without duplicate rows |
| CLI-03 | `--spatio-temporal --reliability` | Exit non-zero, because running multiple Analyze selectors together is not implemented yet |
| CLI-04 | `--spatio-temporal --evidence-chains` | Exit non-zero, because running multiple Analyze selectors together is not implemented yet |
| CLI-05 | `--spatio-temporal --contradictions` | Exit non-zero, because running multiple Analyze selectors together is not implemented yet |
| CLI-06 | `--spatio-temporal --full` | Exit non-zero, because `--full` belongs to `M6-G7` |

### Selector validation

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-07 | *(no args)* | Exit non-zero, usage/help indicates that an analysis selector is required |
| CLI-08 | `--full` | Exit non-zero, because the full Analyze orchestrator is not implemented yet |

## 6. Cost Considerations

None — this step is pure PostgreSQL/PostGIS computation over already-grounded entity data and existing timestamp attributes.
