---
spec: 115
title: "Temporal Pattern Detection"
roadmap_step: "M12-N3"
functional_spec: "§A12, §A11, §D2"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/303"
created: 2026-05-07
---

# Spec 115: Temporal Pattern Detection

## 1. Objective

Complete M12-N3 by adding Mulder's internal temporal pattern detection layer from §A12 Level 1 and Level 2. Researchers must be able to run deterministic analysis over already-ingested entities and persist statistically explainable temporal anomaly clusters plus hotspot cluster summaries. Results must carry enough context to be treated as weak signals: contributing entity ids, baseline and observed rates, corrected significance, density/persistence metadata, provenance, sensitivity metadata, and bias warnings.

This step is intentionally internal-data only. External data source plugins and correlation analysis from §A12 Level 3 belong to M12-N4. N3 keeps all terminology domain-neutral and builds on the existing M6 spatio-temporal clustering foundation without breaking its snapshot table or CLI behavior.

## 2. Boundaries

**Roadmap step:** M12-N3 - Temporal pattern detection - anomaly detection, hotspot clustering.

**Base branch:** `milestone/12`. This spec is delivered to the M12 integration branch, not directly to `main`.

**Target branch:** `feat/303-temporal-pattern-detection`.

**Primary files:**

- `packages/core/src/database/migrations/046_temporal_pattern_detection.sql`
- `packages/core/src/database/repositories/temporal-pattern.repository.ts`
- `packages/core/src/database/repositories/temporal-pattern.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/config/index.ts`
- `packages/core/src/index.ts`
- `packages/pipeline/src/analyze/temporal-patterns.ts`
- `packages/pipeline/src/analyze/index.ts`
- `packages/pipeline/src/analyze/types.ts`
- `packages/pipeline/src/index.ts`
- `mulder.config.example.yaml`
- `tests/lib/schema.ts`
- `scripts/test-lanes.mjs`
- `tests/specs/115_temporal_pattern_detection.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `temporal_pattern_detection` config defaults from §A12 for anomaly detection, hotspot clustering, and reporting-bias controls.
- Add persistence for `temporal_anomaly_clusters` and `spatiotemporal_hotspot_clusters` without modifying the existing M6 `spatio_temporal_clusters` snapshot contract.
- Add repository APIs to replace/list/find anomaly and hotspot snapshots with filters for time range, region key, review/signal status when present, and `maxSensitivityLevel`.
- Add deterministic Analyze-facing functions to:
  - bucket entity events by configured granularity and region strategy,
  - calculate historical baseline and observed rates,
  - apply Bonferroni correction across tested regions/windows,
  - persist only significant anomalies that meet `min_entities`,
  - compute hotspot density, persistence, recurrence metadata, related clusters, and contributing entity ids.
- Include dominant category metadata when configured entity/category attributes are present, using generic category refs from N2 rather than domain labels.
- Store reporting-bias warnings and mandatory weak-signal caveats on all persisted pattern results.
- Update affected-test mapping so N3 config/repository/analyze/migration changes select the N3 spec tests without full-suite fan-out.

**Out of scope:**

- External data source plugin interfaces, external series fetchers, and correlation results. Those are M12-N4.
- UI/API routes, maps, dashboards, scheduling, alerting, or recurring background jobs.
- Paid LLM/Gemini/Vertex calls, web grounding, or network access in tests.
- Replacing or changing the existing `mulder analyze --spatio-temporal` CLI behavior from Spec 64.
- Product decisions from §A12.4 such as detecting absences or choosing a canonical global region model.

**Architectural constraints:**

- Core and pipeline code must stay domain-agnostic. Use `region_key`, `category_ref`, `known_pattern_match`, and config-supplied labels only.
- N3 results are analytical weak signals, not evidence assertions. Persist `signal_strength = weak` and bias/caveat fields so later agent/reporting code cannot silently upgrade them.
- Statistical work must be bounded by config: minimum entity counts, baseline window, granularity, max regions/windows, and hotspot cluster size.
- Bonferroni correction must be observable in the persisted anomaly payload: raw significance, tested comparison count, corrected significance, and threshold.
- Sensitivity must propagate from contributing entities. A pattern containing a restricted entity must not be visible through internal-only reads.
- Fresh checkouts must work from example/default config and must not require a local `mulder.config.yaml`.

## 3. Dependencies

- M6-G6 / Spec 64: existing spatio-temporal event loading and clustering behavior.
- M10-K5 / Spec 102: sensitivity metadata exists on entities and must propagate.
- M11-L5 / Spec 111 and Spec 112: RBAC/sensitivity filtering contracts are present on `main`.
- M12-N2 / Spec 114: classification category refs can provide dominant category metadata.

N3 enables N4 external correlations, M13 observability over pattern outputs, and M14 agent exploration of underexplored or anomalous areas.

## 4. Blueprint

1. Add config support:
   - Define `temporal_pattern_detection.enabled`, `schedule`, `anomaly_detection`, `hotspot_clustering`, and `reporting_bias`.
   - Defaults should match §A12 intent while staying safe for tests: enabled by default, no scheduler side effects, bounded candidate windows, and no external correlation section beyond an explicit N4-reserved placeholder if necessary.
   - Keep `mulder.config.example.yaml` self-contained and domain-neutral.

2. Add migration `046_temporal_pattern_detection.sql`:
   - Create `temporal_anomaly_clusters` with UUID id, `region_key`, optional region GeoJSON, time bounds, entity count, baseline/observed rates, raw and Bonferroni-corrected significance, comparison count, peak date, dominant category ref, contributing entity ids, known pattern match, bias warning, signal strength, provenance, sensitivity level/metadata, computed_at, and `deleted_at`.
   - Create `spatiotemporal_hotspot_clusters` with UUID id, centroid, radius km, time window, entity count, density, constrained persistence (`transient`, `recurring`, `permanent`), recurrence pattern, related cluster ids, contributing entity ids, dominant category ref, bias warning, signal strength, provenance, sensitivity level/metadata, computed_at, and `deleted_at`.
   - Add active snapshot uniqueness/lookup indexes for region/time/type, computed_at, contributing ids, sensitivity, and provenance source ids.

3. Add repository module and exports:
   - Define anomaly/hotspot record, input, list-filter, and replace-snapshot types.
   - Implement `replaceTemporalPatternSnapshot`, `listTemporalAnomalyClusters`, `findTemporalAnomalyCluster`, `listSpatiotemporalHotspotClusters`, and `findSpatiotemporalHotspotCluster`.
   - Use transactions for snapshot replacement so anomaly and hotspot outputs remain consistent.
   - Support `maxSensitivityLevel` filters using the existing sensitivity lattice helpers.

4. Add Analyze integration:
   - Reuse or mirror the existing clusterable entity event loading contract: `entities.attributes.iso_date` and `entities.geom` are the current event signal.
   - Bucket events by configured granularity (`day`, `week`, `month`, `year`) and region strategy (`country`, `admin1`, `hex_grid_100km`). For N3, `country`/`admin1` may read generic entity attributes, and `hex_grid_100km` may use a deterministic rounded coordinate bucket.
   - Compute baseline rates from historical buckets within `baseline_window_years` and observed rates over sliding windows.
   - Use a deterministic Poisson/z-score style significance approximation and apply Bonferroni correction across tested comparisons.
   - Persist only anomalies with corrected significance at or below the configured threshold and at least `min_entities`.
   - Build hotspot clusters from time-windowed geocoded events using configured radius/min cluster size, then classify persistence as `transient`, `recurring`, or `permanent` from repeated window presence.

5. Add bias and provenance behavior:
   - Always set `signal_strength = weak`.
   - If `reporting_bias.correction_enabled` and `correction_field` is configured, add a warning when contributing entities contain elevated observation/reporting intensity values for that field.
   - Always include a generic caveat that patterns are hypothesis starters, not causal evidence.
   - Merge contributing entity sensitivity metadata into persisted pattern sensitivity.

6. Update affected-test mapping only if needed:
   - N3 migration/config/repository/analyze files should map to Spec 115 and narrow adjacent specs only.
   - Do not fan out to full DB/heavy lanes unless a shared helper change genuinely warrants it.

7. Update roadmap state only after gates:
   - Keep N3 marked in progress while the branch is open.
   - Mark N3 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/12`.

## 5. QA Contract

1. **QA-01: Config exposes §A12 internal pattern defaults**
   - Given `mulder.config.example.yaml` and a minimal config without `temporal_pattern_detection`
   - When config is loaded through the public loader
   - Then anomaly detection, hotspot clustering, reporting-bias controls, bounded thresholds, and schedule defaults are present with no domain labels or external source plugins.

2. **QA-02: Temporal pattern schema is constrained and queryable**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `temporal_anomaly_clusters` and `spatiotemporal_hotspot_clusters` exist with statistical fields, weak-signal caveats, provenance, sensitivity metadata, soft-delete, and lookup indexes.

3. **QA-03: Anomaly detection applies Bonferroni correction**
   - Given historical entity events across multiple region/time buckets with one region showing a spike
   - When temporal pattern detection runs
   - Then one anomaly is persisted with baseline/observed rates, raw significance, comparison count, corrected significance, peak date, contributing ids, and `signal_strength = weak`.

4. **QA-04: Non-significant or sparse windows do not persist anomalies**
   - Given event counts below `min_entities` or corrected significance above threshold
   - When detection runs
   - Then no anomaly row is persisted and the result reports bounded comparisons without false-positive rows.

5. **QA-05: Hotspot clustering records density and persistence**
   - Given geocoded events recurring in the same region over multiple configured windows
   - When hotspot detection runs
   - Then hotspot rows contain centroid, radius, density, persistence, recurrence pattern, contributing ids, and related cluster ids where applicable.

6. **QA-06: Sensitivity filtering hides over-sensitive patterns**
   - Given a pattern whose contributing entities include restricted or confidential sensitivity
   - When repository reads run with `maxSensitivityLevel = internal`
   - Then the pattern is omitted, while admin-level reads can see it.

7. **QA-07: Bias warnings and dominant category metadata are preserved**
   - Given contributing entities contain a configured reporting-bias field and generic classification category refs
   - When patterns are persisted
   - Then bias warnings, weak-signal caveats, and dominant category refs are stored without hard-coded domain terms.

## 5b. CLI Test Matrix

N/A - no CLI command is added or changed in this step. Existing `mulder analyze --spatio-temporal` behavior from Spec 64 must remain intact.

## 6. Cost Considerations

N3 adds deterministic database and in-process statistical analysis only. It must not call Gemini, Vertex, GCP APIs, external data sources, or live networks in implementation or tests. Work is bounded by config so large corpora cannot accidentally trigger unbounded analysis during ingest or CI.
