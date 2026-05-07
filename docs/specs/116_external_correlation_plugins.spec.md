---
spec: 116
title: "External Correlation Plugins"
roadmap_step: "M12-N4"
functional_spec: "§A12.1 Level 3, §D1 Rule 4, §D1 Rule 6"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/305"
created: 2026-05-07
---

# Spec 116: External Correlation Plugins

## 1. Objective

Complete M12-N4 by adding the Level 3 external correlation layer from §A12.1. Mulder must be able to register configurable external data source plugins, fetch bounded external series through a standard interface, correlate them with internal temporal pattern time series, and persist the results as weak signals with the mandatory "Correlation ≠ Causation" caveat.

This step must remain domain-agnostic. External source ids, labels, and semantics come from config or plugin registration, never from hard-coded source names. Tests must use deterministic in-memory/static plugins and must not call live networks.

## 2. Boundaries

**Roadmap step:** M12-N4 - External data source plugin interface + correlation analysis.

**Base branch:** `milestone/12`. This spec is delivered to the M12 integration branch, not directly to `main`.

**Target branch:** `feat/305-external-correlation`.

**Primary files:**

- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/database/migrations/047_external_correlations.sql`
- `packages/core/src/database/repositories/temporal-pattern.repository.ts`
- `packages/core/src/database/repositories/temporal-pattern.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/index.ts`
- `packages/pipeline/src/analyze/temporal-patterns.ts`
- `packages/pipeline/src/analyze/index.ts`
- `packages/pipeline/src/analyze/types.ts`
- `packages/pipeline/src/index.ts`
- `mulder.config.example.yaml`
- `tests/lib/schema.ts`
- `scripts/test-lanes.mjs`
- `tests/specs/116_external_correlation_plugins.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `temporal_pattern_detection.external_correlation` config with `enabled`, `series`, `methods`, `min_data_points`, `max_lag_days`, and `always_include_caveat`.
- Define a generic external data source plugin interface for time-series, event-list, and static-dataset sources.
- Provide a deterministic registry/fetch path so Analyze code can use registered plugins without hard-coded external sources.
- Add `external_correlations` persistence with internal series id/key, external source/series ids, method, coefficient, p-value, lag days, time window, caveat, provenance, sensitivity metadata, review status, signal strength, computed_at, and soft delete.
- Implement correlation methods required by §A12.1: Spearman and cross-correlation. Pearson may be supported as a helper if it keeps the implementation simpler; Granger causality may remain a typed/config-rejected future method unless implemented deterministically.
- Build internal series from N3 temporal pattern outputs or entity-derived regional time buckets, bounded by config.
- Propagate sensitivity from contributing internal records, and expose list/find repository reads with `maxSensitivityLevel`.
- Mark all external correlations as `signal_strength = weak`, preserve review status, and always persist the exact mandatory caveat when configured.
- Update affected-test mapping so N4 config/repository/analyze/migration changes select Spec 116 and narrow adjacent schema/testinfra specs only.

**Out of scope:**

- Live HTTP clients, paid APIs, background scheduling, credentials, secret management, or plugin marketplace packaging.
- Domain-specific external source examples in core code or tests.
- UI/API routes, dashboards, reporting, agent journal writes, and alerting.
- Changing N3 anomaly/hotspot semantics beyond the minimal internal series access needed for correlation.
- Final M12 milestone review.

**Architectural constraints:**

- External sources are plugins per §D1 Rule 4. Core code may ship interfaces and a test/static plugin implementation, but no domain-specific source is hard-coded.
- Plugin ids and series ids must be stable, queryable strings and must be validated as non-empty domain-neutral identifiers.
- Correlation results are weak signals only. They cannot upgrade evidence strength and must carry "Correlation ≠ Causation".
- Analysis must be bounded by config: selected series, min data points, max lag, enabled methods, max internal series/windows where needed.
- Fresh checkouts must work from example/default config and must not require a local `mulder.config.yaml`.

## 3. Dependencies

- M12-N2 / Spec 114: category refs may be used to group internal series generically.
- M12-N3 / Spec 115: internal temporal pattern event loading, anomaly/hotspot persistence, and weak-signal conventions.
- M10/M11 sensitivity, review, and provenance contracts.

N4 completes the M12 discovery feature set and prepares M13/M14 reporting and agent workflows to consume correlation weak signals.

## 4. Blueprint

1. Add config support:
   - Extend `temporal_pattern_detection` with `external_correlation`.
   - Support configured series entries with source id, series id, label, plugin id, enabled flag, optional time bounds, and optional region/category filters.
   - Keep defaults enabled but empty-series safe so ordinary runs do no external work.

2. Add plugin interface:
   - Define `ExternalDataSourcePlugin`, `ExternalDataPoint`, and registry functions in pipeline/analyze or a small shared module.
   - Support static fixture plugins for tests.
   - Validate plugin output shape and drop invalid points with warnings rather than throwing when possible.

3. Add migration and repository:
   - Create `external_correlations` with constrained method, signal strength, caveat, review status, sensitivity metadata, provenance, and soft-delete fields.
   - Add uniqueness/lookup indexes for active internal/external/method/window/lag rows, time window, source/series ids, sensitivity, review status, and provenance source ids.
   - Add `replaceExternalCorrelationSnapshot`, `listExternalCorrelations`, and `findExternalCorrelation` APIs.

4. Add Analyze integration:
   - Build bounded internal time series from existing entity event buckets using the N3 loader and region/category filters.
   - Fetch configured external series through registered plugins only.
   - Align series by bucket date, test configured lags up to `max_lag_days`, require `min_data_points`, compute correlation coefficient and a deterministic p-value approximation.
   - Persist only computed results and include warnings for skipped methods/series.

5. Add QA and affected mapping:
   - Spec 116 tests should cover config defaults, schema constraints/indexes, plugin registration/fetch validation, Spearman/cross-correlation with lag, weak-signal caveat persistence, sensitivity filtering, and scoped affected mapping.
   - N4 mapping must not fan out to full DB/heavy lanes.

6. Update roadmap state only after gates:
   - Keep N4 marked in progress while the branch is open.
   - Mark N4 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/12`.

## 5. QA Contract

1. **QA-01: Config exposes §A12.1 external correlation defaults**
   - Given example/default config
   - When config is loaded
   - Then `external_correlation` exists, defaults to an empty safe series list, supports bounded methods, and does not require local config.

2. **QA-02: External correlation schema is constrained and queryable**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `external_correlations` exists with method constraints, mandatory caveat, weak signal, review, provenance, sensitivity, soft delete, and lookup indexes.

3. **QA-03: External source plugins are registered and fetched generically**
   - Given static test plugins and configured series
   - When correlation analysis runs
   - Then data is fetched through plugin ids only, with no hard-coded external source names or network calls.

4. **QA-04: Spearman/cross-correlation computes bounded lagged results**
   - Given aligned internal and external time series with a known lag
   - When correlation analysis runs
   - Then persisted results include method, coefficient, p-value, lag days, and time window.

5. **QA-05: Weak-signal caveat and review state are mandatory**
   - Given persisted external correlations
   - When rows are read through repository APIs
   - Then `signal_strength = weak`, review status defaults to pending, and the caveat includes exactly "Correlation ≠ Causation".

6. **QA-06: Sensitivity filtering hides over-sensitive correlations**
   - Given an internal series containing restricted contributing records
   - When reads run with `maxSensitivityLevel = internal`
   - Then the correlation is omitted, while admin-level reads can see it.

7. **QA-07: Affected-test mapping stays scoped**
   - Given N4 config/repository/analyze/migration changes
   - When affected plan is computed
   - Then Spec 116 and narrow schema/testinfra neighbors are selected without broad DB/heavy fanout.

## 6. Cost Considerations

N4 must be deterministic and local-testable. Core implementation and tests must not call live networks, Gemini, Vertex, GCP APIs, or paid external data providers. Future real plugins can add network clients behind explicit configuration and test doubles.
