---
milestone: M5+M6
title: "M5 + M6 Review — Taxonomy, Grounding, and Analysis"
reviewed: 2026-04-13
steps_reviewed: [F1, F2, F3, F4, F5, G1, G2, G3, G4, G5, G6, G7]
spec_sections: [§1, §2, §2.5, §2.8, §4.3, §4.8, §5.3, §6, §6.1, §6.2, §6.3]
verdict: PASS_WITH_WARNINGS
---

# Milestone Review: M5 + M6 — Curation + Intelligence

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Warning  | 5 |
| Note     | 2 |

**Verdict:** PASS_WITH_WARNINGS

M5 and M6 are functionally in good shape: the taxonomy/entity-management CLI surface exists, the v2.0 schema migrations match the spec, grounding and analyze flows are implemented end to end, and the black-box spec suite for this scope is green (`12` test files, `265` passed, `8` skipped). The main gaps are contract drift and milestone-readiness issues rather than obvious runtime breakage. The highest-signal warnings are the missing grounding plausibility layer, source reliability using only entity co-occurrence instead of the spec's broader citation graph, evidence chains missing the sparse-data gate from §5.3, the curated taxonomy YAML contract being narrower than the functional spec, and the v2.0 analysis code living in `packages/pipeline` while the documented `packages/evidence` package is effectively a stub.

---

## Per-Section Divergences

### §1 — CLI Command Tree

No divergences found. Verified the milestone CLI surface exists and is wired as thin wrappers in:
- `apps/cli/src/commands/taxonomy.ts`
- `apps/cli/src/commands/entity.ts`
- `apps/cli/src/commands/status.ts`
- `apps/cli/src/commands/export.ts`
- `apps/cli/src/commands/ground.ts`
- `apps/cli/src/commands/analyze.ts`

### §2 — Pipeline Steps — Global Conventions

No milestone-specific divergences found. The M6 steps follow the established pattern: config is loaded centrally, DB writes stay in repositories, and the CLI layer remains thin.

### §2.5 — Ground (v2.0)

**[DIV-001] `skip_types` from the spec is not represented in config or execution**
- **Severity:** NOTE
- **Spec says:** Ground filters by configured `enrich_types` and `skip_types`. (`docs/functional-spec.md:383-384`)
- **Code does:** The grounding config only defines `enabled`, `mode`, `enrich_types`, `cache_ttl_days`, `min_confidence`, and `exclude_domains`, and the step only checks membership in `enrich_types`. (`packages/core/src/config/schema.ts:240-247`, `packages/core/src/config/defaults.ts:88-95`, `mulder.config.example.yaml:162-168`, `packages/pipeline/src/ground/index.ts:233-248`)
- **Evidence:** There is no `skip_types` field in the config schema/defaults/example, and no negative type filter in the Ground step.

**[DIV-002] Grounding "plausibility checks" are reduced to schema validation plus support-confidence threshold**
- **Severity:** WARNING
- **Spec says:** After calling Gemini with `google_search_retrieval`, the step should "Validate grounding results (plausibility checks)". (`docs/functional-spec.md:385-390`)
- **Code does:** The step validates JSON shape and rejects results below `grounding.min_confidence`, but otherwise merges the grounded payload directly into `entities.attributes` and optionally `entities.geom`. (`packages/pipeline/src/ground/index.ts:96-131`, `291-339`)
- **Evidence:** There are no type-specific plausibility guards for impossible coordinates, implausible verified dates, or mismatches between entity type and returned grounding fields before `persistEntityGroundingResult()` is called.

### §2.8 — Analyze (v2.0)

**[DIV-003] Source reliability graph uses only entity co-occurrence, not the broader citation graph described by the spec**
- **Severity:** WARNING
- **Spec says:** Source reliability should build a "citation graph (sources citing other sources, entity co-occurrence)", run weighted PageRank, and write `sources.reliability_score`. (`docs/functional-spec.md:493-497`)
- **Code does:** The reliability query builds edges only from shared entities across sources via `story_entities` and `stories`; no citation/reference signal is incorporated. (`packages/pipeline/src/analyze/reliability.ts:105-120`)
- **Evidence:** The SQL selects `COUNT(DISTINCT se1.entity_id)` for source pairs and never reads any source-to-source citation/reference field because none exists in the query or schema touched by this pass.

### §4.3 — Core Database Schema

No divergences found. M6's reserved migrations match the functional spec for:
- `entity_grounding` (`docs/functional-spec.md:940-948`; `packages/core/src/database/migrations/009_entity_grounding.sql:1-8`)
- `evidence_chains` (`docs/functional-spec.md:950-958`; `packages/core/src/database/migrations/010_evidence_chains.sql:1-8`)
- `spatio_temporal_clusters` plus `entities.geom` (`docs/functional-spec.md:960-971`; `packages/core/src/database/migrations/011_spatio_temporal_clusters.sql:1-14`)

### §4.8 — Vertex AI Wrapper + Dev Cache

No divergences found for the reviewed scope. Grounding correctly routes through the grounded-generation service interface with domain exclusions and optional geo bias. (`packages/pipeline/src/ground/index.ts:276-283`)

### §5.3 — Sparse Graph Degradation

**[DIV-004] Evidence-chain sparse-data gate from §5.3 is not implemented**
- **Severity:** WARNING
- **Spec says:** Below threshold, evidence chains are disabled and the API returns "501 Not Yet Available" with explanation. (`docs/functional-spec.md:1474-1478`)
- **Code does:** Evidence-chain execution checks only `analysis.enabled`, `analysis.evidence_chains`, and thesis input presence; it never consults any sparse-data threshold before tracing and persisting chains. (`packages/pipeline/src/analyze/index.ts:688-790`, `1024-1034`; `packages/pipeline/src/analyze/evidence-chains.ts:203-236`)
- **Evidence:** No threshold value from `config.thresholds` is read in the evidence-chain pass or computation path. The only threshold-aware M6 analyze passes are reliability and spatio-temporal.

### §6 — Taxonomy System

No additional divergences beyond §6.1 and §6.3. `packages/taxonomy` does contain bootstrap/export/merge/show behavior, and normalization remains inline in Enrich as required by §6.2.

### §6.1 — Bootstrap Flow

**[DIV-005] Bootstrap response contract differs from the functional spec**
- **Severity:** NOTE
- **Spec says:** Gemini returns `{ categories: [{ name, type, members: [{ canonical, aliases }] }] }`. (`docs/functional-spec.md:1518-1520`)
- **Code does:** Bootstrap expects and validates `{ clusters: [{ canonical, aliases }] }` per entity type. (`packages/taxonomy/src/bootstrap.ts:54-73`, `231-249`)
- **Evidence:** The bootstrap Zod/JSON-schema contract and write loop only know about `clusters`, not the spec's `categories[].members[]` structure.

### §6.2 — Normalization (inline in Enrich)

No divergences found in the reviewed scope. M5 did not alter the previously-reviewed normalization behavior, and the taxonomy FK support added by `018_entity_taxonomy_link.sql` remains consistent with the M3/M4 direction of travel.

### §6.3 — Curation Workflow

**[DIV-006] Curated taxonomy YAML contract is narrower than the spec example**
- **Severity:** WARNING
- **Spec says:** `taxonomy.curated.yaml` is wrapped under `categories:` and may carry richer entry metadata such as `id`, `wikidata`, locale `variants`, and `aliases`. (`docs/functional-spec.md:1539-1561`)
- **Code does:** Export emits a flat top-level mapping of `entityType -> entries`, and merge only accepts `id`, `canonical`, `status`, optional `category`, and `aliases`. (`packages/taxonomy/src/export.ts:85-99`, `151-169`; `packages/taxonomy/src/curated-schema.ts:18-30`)
- **Evidence:** There is no `categories` wrapper in the exported YAML, and fields like `wikidata` or locale-specific `variants` would be rejected by the merge schema.

---

## Cross-Cutting Convention Review

### Naming Conventions
All audited M5/M6 source files follow the repo's naming conventions: `kebab-case.ts` filenames, `PascalCase` types/interfaces, `camelCase` functions/variables, and `snake_case` SQL/config keys.

### TypeScript Strictness
- No `any`, `as any`, `console.log`, or generic `throw new Error()` usage surfaced in the audited M5/M6 command, taxonomy, ground, analyze, and repository files.
- The relevant packages are ESM (`"type": "module"`) and use TypeScript project references.
- Internal dependencies use `workspace:*`.

### Architecture Patterns
- The reviewed CLI commands use `loadConfig()` centrally and stay thin.
- Ground and Analyze call service interfaces; they do not import `gcp.ts` directly.
- Repository writes remain parameterized and transaction-scoped where needed (`mergeEntities`, taxonomy batch apply, grounding persistence, evidence-chain snapshot replacement, cluster snapshot replacement).

### Package Structure
**Finding:** The documented v2.0 package boundary does not match the implementation.

**[DIV-007] `packages/evidence` is effectively a stub while v2.0 analysis logic lives in `packages/pipeline`**
- **Severity:** WARNING
- **Spec says:** The documented package graph and repo structure place v2.0 contradictions/reliability/chains/spatiotemporal in `packages/evidence`, with `apps/cli` and `apps/api` depending on it. (`docs/functional-spec.md:2270-2275`; `CLAUDE.md:199-204`)
- **Code does:** `packages/evidence/src/index.ts` exports nothing, while the real implementation lives in `packages/pipeline/src/analyze/*`. `apps/cli/package.json` depends on `@mulder/core`, `@mulder/pipeline`, `@mulder/retrieval`, and `@mulder/taxonomy`, but not `@mulder/evidence`. (`packages/evidence/src/index.ts:1`, `apps/cli/package.json`)
- **Evidence:** This is not a runtime bug today, but it leaves the public package boundary for M7's API/workers underspecified.

### Test Coverage
Coverage for the milestone scope is strong and currently green:
- `tests/specs/46_taxonomy_bootstrap.test.ts`
- `tests/specs/50_taxonomy_export_curate_merge.test.ts`
- `tests/specs/51_entity_management_cli.test.ts`
- `tests/specs/52_status_overview.test.ts`
- `tests/specs/53_export_commands.test.ts`
- `tests/specs/54_v2_schema_migrations.test.ts`
- `tests/specs/60_ground_step.test.ts`
- `tests/specs/61_contradiction_resolution.test.ts`
- `tests/specs/62_source_reliability_scoring.test.ts`
- `tests/specs/63_evidence_chains.test.ts`
- `tests/specs/64_spatio_temporal_clustering.test.ts`
- `tests/specs/65_analyze_full_orchestrator.test.ts`

Observed local result during this review: `12` files passed, `265` tests passed, `8` skipped.

---

## CLAUDE.md Consistency

- **Consistent:** CLAUDE.md's grounding, taxonomy, and analyze capability descriptions are broadly reflected in the codebase.
- **Inconsistent:** CLAUDE.md says `packages/evidence` is the v2.0 analysis package, but the implementation keeps the real logic in `packages/pipeline/src/analyze/*` while `packages/evidence/src/index.ts` is empty. (`CLAUDE.md:199-204`; `packages/evidence/src/index.ts:1`)

---

## Next Milestone Readiness

### Can Do Now
1. Tighten the functional-spec/docs contract where the implementation is clearly intentional: bootstrap JSON shape, curated taxonomy YAML shape, and the current package boundary for analyze code.
2. Add focused tests for grounding plausibility rules before changing behavior, so future grounding refinements do not destabilize the passing M6 suite.
3. Decide whether `skip_types` is still part of the intended grounding surface; if not, remove it from the functional spec to avoid another stale contract.
4. Make `packages/evidence` either the real public home of analyze primitives or explicitly document it as deferred, so M7 implementation does not start from a misleading package map.

### Need Before M7
1. Decide the source-reliability contract and align code/spec: either extend the graph to include citation-like signals, or narrow the spec from "citation graph + entity co-occurrence" to the co-occurrence-only model that is actually implemented.
2. Implement or explicitly waive the grounding plausibility layer. M7 will expose more of this through HTTP/job surfaces, and unvalidated grounded dates/coordinates become harder to reason about once they leave the CLI-only world.
3. Implement the sparse-data gate for evidence chains, or revise §5.3 to match the intended CLI behavior. The current mismatch will leak into any future API surface and UI messaging.
4. Standardize the curated taxonomy YAML contract before any API/UI curation work starts. The current reduced schema is workable for CLI users, but the spec promises richer multilingual/external-ID structure than the tool can currently round-trip.
5. Resolve the `packages/evidence` boundary before building M7 API routes. Without that, the API layer will either depend on `@mulder/pipeline` for graph-wide read/analysis concerns or we will refactor under schedule pressure during the milestone.

---

## Recommendations

### Must Fix (Critical)
None.

### Should Fix (Warning)
1. **DIV-002:** Add explicit plausibility validation to the Ground step before grounded attributes and geometry are persisted.
2. **DIV-003:** Reconcile the source-reliability implementation with the spec's broader citation-graph contract.
3. **DIV-004:** Add sparse-data gating for evidence chains or update §5.3 to reflect the intended behavior.
4. **DIV-006:** Decide and freeze the curated taxonomy YAML contract, then align export/merge/spec together.
5. **DIV-007:** Resolve the `packages/evidence` package boundary before M7 introduces API and worker consumers.

### For Consideration (Note)
1. **DIV-001:** Either add `skip_types` to grounding config or remove it from the spec.
2. **DIV-005:** Align the taxonomy bootstrap response contract with the functional spec or document the simplified `clusters` shape as authoritative.
