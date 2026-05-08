---
milestone: M12
title: "Discovery — Patterns & Similarity"
reviewed_at: 2026-05-07
reviewed_sha: e6261fa6639913290cd538123aef466c0b10d39c
review_branch: milestone/12
steps_reviewed: 4
spec_sections:
  - "§A10"
  - "§A11"
  - "§A12"
  - "§A12.1 Level 3"
  - "§D2.4"
  - "§D2.6"
verdict: PASS_WITH_WARNINGS
---

# M12 Milestone Review

## Summary

Verdict: **PASS_WITH_WARNINGS**.

M12 is complete on `milestone/12` at `e6261fa6639913290cd538123aef466c0b10d39c`. The roadmap marks N1-N4 complete, the related M12 issues are closed, the M12 PRs are merged, and the latest pre-review `milestone/12` CI run is green.

Severity counts:

| Severity | Count |
| --- | ---: |
| CRITICAL | 0 |
| WARNING | 4 |
| NOTE | 5 |

## Review Scope

Resolved milestone:

| Field | Value |
| --- | --- |
| MILESTONE_ID | M12 |
| MILESTONE_TITLE | Discovery — Patterns & Similarity |
| STEP_COUNT | 4 |

Section map:

| Source | Sections |
| --- | --- |
| SECTIONS_FROM_STEPS | `§A10`, `§A11`, `§A12` |
| CROSS_REFERENCES | `§A11`, roadmap "§D1 Rules 4 + 6" interpreted through `docs/architecture-core-vs-domain.md` as `§D2.4` and `§D2.6` |
| ALL_SECTIONS | `§A10`, `§A11`, `§A12`, `§A12.1 Level 3`, `§D2.4`, `§D2.6` |

Review batches:

1. Config, defaults, migrations, repository exports, and affected-test routing.
2. Similar entity discovery and taxonomy harmonization.
3. Internal temporal anomalies and hotspot clustering.
4. External source plugins and correlation persistence.
5. Cross-cutting architecture, tests, and `CLAUDE.md` consistency.

## Reviewed Tasks

| Step | Spec | Issue | PR | Status |
| --- | --- | --- | --- | --- |
| M12-N1 | `docs/specs/113_similar_entity_discovery.spec.md` | #299 | #300 | Closed / merged |
| M12-N2 | `docs/specs/114_classification_harmonization.spec.md` | #301 | #302 | Closed / merged |
| M12-N3 | `docs/specs/115_temporal_pattern_detection.spec.md` | #303 | #304 | Closed / merged |
| M12-N4 | `docs/specs/116_external_correlation_plugins.spec.md` | #305 | #306 | Closed / merged |

## Section Review

### §A10 — Similar Case Discovery

No blocking divergence found. M12-N1 implements a domain-neutral similar-entity surface with bounded candidate retrieval, separate core/domain dimensions, insufficient-data markers, optional persistence, sensitivity filtering, and review artifacts for auto-discovered links.

Evidence:

- Config defaults expose the four core dimensions, bounded candidate retrieval, deterministic explanations, and bounded auto-discovery (`packages/core/src/config/defaults.ts:35-69`; `mulder.config.example.yaml:294-325`).
- `similarity_cache` stores unordered entity pairs, JSONB core/domain scores, explanation fields, provenance, review status, sensitivity metadata, and active-pair uniqueness (`packages/core/src/database/migrations/043_similarity_cache.sql:1-83`).
- Query scoring keeps missing dimensions explicit as `insufficient_data` and persists raw dimensions rather than storing a single aggregate score (`packages/pipeline/src/analyze/similarity.ts:879-953`).
- Auto-discovery is bounded by threshold and `max_auto_links`, creates or updates generic `SIMILAR_TO` graph edges, and registers `similar_case_link` review artifacts (`packages/pipeline/src/analyze/similarity.ts:956-1038`).

NOTE: `SimilarEntityScore` exposes `weightedRankScore` to programmatic consumers (`packages/pipeline/src/analyze/types.ts:259-281`). It is not persisted in `similarity_cache` and is used for sorting, which matches Spec 113's phased design. Future API/reporting surfaces should still avoid presenting it as evidence strength because §A10 says users and agents should see individual dimensions plus explanations, not a hidden aggregate.

NOTE: `custom_scorer` is accepted as a config/source enum but currently returns `insufficient_data` from the deterministic scorer path. This is acceptable for the M12-N1 phased scope, which implements attribute comparison and later taxonomy mappings, but custom scorer execution should remain explicitly reserved until a plugin boundary exists.

### §A11 — Classification System Harmonization

The core harmonization model is implemented: generic taxonomies/categories, directed mapping rows, confidence/rationale/review/provenance/sensitivity metadata, review artifact registration for draft or LLM-authored mappings, and deterministic similarity scoring via taxonomy mappings.

Evidence:

- Config defaults add `taxonomy.harmonization` with generic taxonomy refs, auto-mapping policy, and extraction toggles (`packages/core/src/config/defaults.ts:73-88`; `packages/core/src/config/schema.ts:469-507`).
- `classification_taxonomies`, `classification_categories`, and `taxonomy_mappings` have constrained statuses, mapping types, confidence bounds, provenance, sensitivity metadata, soft delete, and lookup indexes (`packages/core/src/database/migrations/044_classification_harmonization.sql:1-257`).
- Same-taxonomy parent safety is enforced by the follow-up migration (`packages/core/src/database/migrations/045_classification_category_parent_taxonomy_constraint.sql:1-17`).
- Reverse mapping views preserve the original row while inverting `broader`/`narrower` when returned from the opposite side (`packages/core/src/database/repositories/classification-harmonization.repository.ts:204-236`).
- Similarity scoring consumes reviewed mappings through `scoreTaxonomyMappingSimilarity`, carries mapping evidence, and respects review/sensitivity filters (`packages/pipeline/src/analyze/similarity.ts:200-259`).

WARNING: Reverse `mappingType` filtering happens before broader/narrower inversion. `resolveTaxonomyMappings` first adds SQL filters through `addMappingListFilters`, where `mapping_type = ANY(...)` is applied to the stored row (`packages/core/src/database/repositories/classification-harmonization.repository.ts:827-830`, `packages/core/src/database/repositories/classification-harmonization.repository.ts:897-907`). A stored `broader` mapping queried from the target side correctly returns as `narrower` when unfiltered, but a reverse lookup filtered for `mappingType: "narrower"` will miss it because the database row is still `broader`. This is a divergence from the combined §A11/Spec 114 expectation that mappings are usable from either side and reverse views preserve inverted semantics. Unfiltered reverse lookup works; the risk is limited to callers that use type filters.

### §A12 — Temporal Pattern Detection

The internal pattern layer is mostly implemented. It loads timestamp-bearing entity events, groups them by configurable regions/windows, applies a Poisson-style significance test with Bonferroni correction, persists weak-signal anomaly/hotspot snapshots, propagates sensitivity from contributing entities, stores generic dominant category refs, and preserves reporting-bias warnings.

Evidence:

- Config exposes bounded anomaly and hotspot settings, including region/window caps, min entity counts, significance threshold, granularity, and reporting-bias controls (`packages/core/src/config/defaults.ts:90-130`; `packages/core/src/config/schema.ts:742-817`).
- `temporal_anomaly_clusters` and `spatiotemporal_hotspot_clusters` store statistical fields, weak-signal caveats, provenance, review status, sensitivity metadata, soft delete, and lookup indexes without changing the older M6 `spatio_temporal_clusters` table (`packages/core/src/database/migrations/046_temporal_pattern_detection.sql:1-281`).
- Bonferroni correction is observable in persisted anomaly inputs through raw significance, comparison count, corrected significance, and threshold (`packages/pipeline/src/analyze/temporal-patterns.ts:500-569`).
- Hotspot rows store centroid coordinates, density, persistence, recurrence metadata, related cluster ids, contributing entity ids, caveats, provenance, and propagated sensitivity (`packages/pipeline/src/analyze/temporal-patterns.ts:980-1056`).

WARNING: CUSUM/changepoint detection from §A12 Level 1 is not implemented. The addendum calls for "Poisson-based anomaly detection ... CUSUM for changepoint detection" (`docs/functional-spec-addendum.md:1469`). The current implementation uses sliding windows and `poissonUpperTail` only (`packages/pipeline/src/analyze/temporal-patterns.ts:456-569`). Spec 115 intentionally scoped this to a deterministic Poisson/z-score style approximation, so this is not blocking M12 acceptance, but the full §A12 method remains incomplete unless CUSUM is later implemented or explicitly removed from the functional spec.

WARNING: The hotspot `algorithm` config accepts `dbscan` and `hdbscan`, defaulting to `hdbscan`, but the analyzer ignores the selected algorithm and uses radius-based connected components within time buckets (`packages/core/src/config/schema.ts:764-771`; `packages/pipeline/src/analyze/temporal-patterns.ts:594-623`, `packages/pipeline/src/analyze/temporal-patterns.ts:980-993`). §A12 says Level 2 should use DBSCAN or HDBSCAN on `(lat, lng, time)` tuples (`docs/functional-spec-addendum.md:1489`). The implementation is deterministic and bounded, but the config currently over-promises algorithm semantics.

NOTE: `always_include_caveat` exists under `temporal_pattern_detection.external_correlation`, but the repository/DDL always enforce the mandatory caveat. This aligns with §A12.2's mandatory-caveat rule; the config option should be documented as non-disableable or removed before it becomes user-facing.

### §A12.1 Level 3 and §D2.4 — External Correlation Plugins

The external correlation pipeline is functional and domain-neutral for M12-N4. It uses registered plugins only, fetches bounded configured series, computes Spearman and cross-correlation results, persists weak-signal correlation rows, preserves review status on deterministic recompute, and avoids destructive snapshot replacement when no correlation run produces computed rows.

Evidence:

- Config adds `external_correlation` with enabled flag, configured series, methods, min data points, max lag, and caveat control (`packages/core/src/config/defaults.ts:114-121`; `packages/core/src/config/schema.ts:782-806`).
- `external_correlations` constrains method, coefficient, p-value, lag, mandatory caveat, `signal_strength = weak`, review status, provenance, sensitivity, soft delete, and lookup indexes (`packages/core/src/database/migrations/047_external_correlations.sql:1-107`).
- Correlations are built through the registry, plugin ids, bounded min-data/max-lag settings, Spearman/cross-correlation computation, deterministic p-value approximation, and generic series filters (`packages/pipeline/src/analyze/temporal-patterns.ts:653-923`).
- `detectTemporalPatterns` only calls `replaceExternalCorrelationSnapshot` when computed correlation inputs exist, preserving prior active rows for disabled, empty, missing-plugin, sparse, or zero-aligned runs (`packages/pipeline/src/analyze/temporal-patterns.ts:1121-1126`).

WARNING: The public external plugin interface does not match the functional/architecture interface. §A12.1 and §D2.4 define `ExternalDataSource` with `id`, `name`, `description`, `type`, `update_frequency: "realtime" | "daily" | "weekly" | "monthly" | "yearly" | "manual"`, and `fetch()` (`docs/functional-spec-addendum.md:1509-1519`; `docs/architecture-core-vs-domain.md:44-53`). The implementation exposes `ExternalDataSourcePlugin` with `id`, `kind`, `updateFrequency`, and `fetch(request)`, but no `name` or `description`; its frequency union omits `realtime` and `yearly` while adding `static` and `unknown` (`packages/pipeline/src/analyze/external-correlation.ts:3-40`). The correlation engine works, but future plugin UI/config/reporting consumers cannot rely on the standardized metadata shape yet.

NOTE: The registry rejects empty plugin ids with a generic `Error` (`packages/pipeline/src/analyze/external-correlation.ts:46-50`). This is small, but it drifts from `CLAUDE.md`'s custom-error guidance for production paths.

### §D2.6 — Configurable Similarity Dimensions

No blocking divergence found. Core similarity dimensions are generic, and configured domain dimensions come from config refs rather than hard-coded taxonomy labels or domain vocabulary.

Evidence:

- Config schema validates domain dimensions with generic `id`, `label`, `source`, `config_ref`, optional `weight`, and metadata (`packages/core/src/config/schema.ts:626-641`).
- The scorer reads configured attributes and taxonomy refs from entity attributes, not from domain-specific names (`packages/pipeline/src/analyze/similarity.ts:659-732`).
- M12 tests explicitly check that new M12 defaults do not introduce UAP/medical/journalism-specific labels in the reviewed config surfaces.

## Cross-Cutting Convention Review

M12 broadly follows Mulder's architecture: TypeScript modules, config loader defaults, repository-style database access, Postgres-only persistence, sensitivity lattice filters, review artifact reuse, and scoped tests. The implemented artifacts carry provenance/sensitivity metadata and use generic entity/category/region/source identifiers. No live GCP, Vertex, Gemini, or external network dependency is introduced in M12 tests.

Affected-test routing remains scoped. M12 migrations and repository/analyze changes select their spec tests and narrow adjacent schema/test-infrastructure specs rather than fanning out to full DB/heavy lanes (`scripts/test-lanes.mjs:716-735`, `scripts/test-lanes.mjs:868-892`, `scripts/test-lanes.mjs:919-938`, `scripts/test-lanes.mjs:1150-1210`, `scripts/test-lanes.mjs:1260-1286`).

NOTE: The roadmap cross-reference says "§D1 Rules 4 + 6" (`docs/roadmap.md:337`), while the architecture document actually numbers those rules as `§D2.4` and `§D2.6`. The intent was followed, but the roadmap reference should be corrected to avoid future target-resolution ambiguity.

NOTE: `mulder.config.example.yaml` and older default config still contain pre-M12 example vocabulary such as `location_sighting`; this review did not count that as an M12 divergence because the new M12 surfaces themselves remain domain-neutral. It remains worth cleaning up as part of a separate domain-neutrality docs/config pass.

## `CLAUDE.md` Consistency

`CLAUDE.md` is consistent with the reviewed M12 architecture in the areas that matter most: domain-agnostic core, all-in-one PostgreSQL, central config loading, repository boundaries, scoped verification, and no live external services in tests. One small mismatch remains in emphasis: `CLAUDE.md` describes Phase 2 Pattern Discovery as "reserved" while M12 now implements concrete discovery pieces. That is not a functional conflict, but the Phase 2 paragraph should eventually be updated after M12 is promoted to `main`.

## Verification

Local verification used for M12 acceptance before this review:

- `pnpm test:scope run milestone M12 -- --reporter=verbose`
  - 4 files, 41 tests passed.
- `pnpm test:affected:plan -- origin/milestone/12`
  - Final synchronized branch state, 0 changed files.
- `MULDER_TEST_ISOLATED_DB=true pnpm test:affected -- origin/milestone/12 -- --reporter=verbose`
  - Final synchronized branch state, 0 changed files/no-op.

Remote verification before this review report:

- Latest pre-review `milestone/12` CI: run `25515255591`, head `e6261fa6639913290cd538123aef466c0b10d39c`, status `completed`, conclusion `success`.
- Open PRs against `milestone/12`: none.
- M12 issues #299, #301, #303, and #305 are closed.

No implementation tests were rerun for this docs-only review report.

## Recommendations

Must-fix before M12 can stand: none.

Should-fix:

- Apply `mappingType` filters in `resolveTaxonomyMappings` after reverse-view inversion, or document that type filters use stored direction only.
- Either implement CUSUM/changepoint detection or explicitly mark it deferred in §A12/Spec 115.
- Either implement true DBSCAN/HDBSCAN semantics for hotspot detection or rename/configure the current radius-connected-component algorithm honestly.
- Align `ExternalDataSourcePlugin` with the §A12.1/§D2.4 metadata contract by adding `name`, `description`, a spec-compatible type/update-frequency shape, and a custom error for invalid plugin registration.

For consideration:

- Keep `weightedRankScore` internal or clearly label it as sort-only if similar-entity results become API/UI visible.
- Clarify or remove `always_include_caveat` because the mandatory caveat is enforced regardless.
- Correct the M12 roadmap cross-reference from "§D1 Rules 4 + 6" to `§D2.4` and `§D2.6`.
- Update the Phase 2 Pattern Discovery text in `CLAUDE.md` after M12 is merged to `main`.
