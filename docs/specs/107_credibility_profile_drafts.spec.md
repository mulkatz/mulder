---
spec: 107
title: "Credibility Profile Drafts"
roadmap_step: "M11-L1"
functional_spec: "§A8, §A3, §A5"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/283"
created: 2026-05-06
---

# Spec 107: Credibility Profile Drafts

## 1. Objective

Complete M11-L1 by replacing the old single source reliability float as the primary trust surface with configurable, multi-dimensional source credibility profiles from §A8. Mulder must persist one profile per source, persist the configured dimension scores with rationales, and create an LLM-generated draft when a newly enriched source has no profile yet.

The profile is contextual, not censoring. It must not collapse dimensions into one aggregate score and it must not hide low-scoring sources. LLM-generated profiles are always `draft` and remain reviewable by later M11 review workflow work.

## 2. Boundaries

**Roadmap step:** M11-L1 - Credibility profile data model + LLM auto-generation.

**Base branch:** `milestone/11`. This spec is delivered to the M11 integration branch, not directly to `main`.

**Target branch:** `feat/283-credibility-profile-drafts`.

**Primary files:**

- `packages/core/src/database/migrations/037_source_credibility_profiles.sql`
- `packages/core/src/database/repositories/source-credibility.repository.ts`
- `packages/core/src/database/repositories/source-credibility.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/prompts/templates/source-credibility-profile.jinja2`
- `packages/pipeline/src/enrich/credibility.ts`
- `packages/pipeline/src/enrich/index.ts`
- `packages/pipeline/src/enrich/types.ts`
- `tests/specs/107_credibility_profile_drafts.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add `source_credibility_profiles` and `credibility_dimensions` tables with constrained source type, profile author, review status, dimension score, rationale, evidence refs, and known factors.
- Add `credibility` config with §A8 defaults, configurable dimensions, auto-generation flag, human-review requirement, report display flag, and agent instruction.
- Add public repository APIs for upserting, reading, and listing profiles with their dimension rows.
- Add a prompt-backed draft generator that accepts source context and configured dimensions, calls the shared LLM service, and persists a draft profile only when none exists.
- Wire Enrich to invoke draft generation after a successful story enrichment when `credibility.enabled` and `auto_profile_on_ingest` are true.
- Preserve existing reviewed or human-authored profiles by skipping auto-generation when a profile already exists.

**Out of scope:**

- Collaborative review queues, review events, reviewer assignment, or status mutation workflows. Those belong to M11-L3.
- Conflict density feedback into the `consistency` dimension. That belongs to M11-L2 integration and later review.
- Agent report rendering or export display. Later milestones consume the profile data.
- Removing `sources.reliability_score` or rewriting legacy reliability analysis. L1 supersedes it for new trust UI, but keeps backward compatibility.
- Versioning historical profile changes.

## 3. Dependencies

- M10-K2 / Spec 99 and M10-K8 / Spec 105: sources can carry provenance and collection/default credibility metadata.
- M10-K4 / Spec 101: assertion type vocabulary exists and informs later profile use.
- M10-K5 / Spec 102: sensitivity metadata exists; profile generation must not leak or widen access.
- Existing Enrich step, shared service registry, prompt renderer, and repository conventions.

L1 blocks M11-L2 consistency feedback, M11-L3 review queues for credibility profiles, and later agent/report trust display.

## 4. Blueprint

1. Add migration `037_source_credibility_profiles.sql`:
   - Create `source_credibility_profiles` with UUID primary key, unique `source_id`, `source_name`, constrained `source_type`, constrained `profile_author`, nullable `last_reviewed`, constrained `review_status`, timestamps, and foreign key to `sources`.
   - Create `credibility_dimensions` with UUID primary key, `profile_id`, `dimension_id`, `label`, numeric `score` constrained 0..1, required `rationale`, `evidence_refs TEXT[]`, `known_factors TEXT[]`, timestamps, and unique `(profile_id, dimension_id)`.
   - Add lookup indexes for source, review status, source type, dimension id, and low-score review targeting.

2. Add repository types and functions:
   - Export `CredibilitySourceType`, `CredibilityProfileAuthor`, `CredibilityReviewStatus`, `CredibilityDimension`, and `SourceCredibilityProfile`.
   - Provide `findSourceCredibilityProfileBySourceId`, `listSourceCredibilityProfiles`, and `upsertSourceCredibilityProfile`.
   - Upserts must be idempotent for `(source_id, dimension_id)` and must replace the dimension snapshot for the profile.
   - Validate score bounds and enum values before database writes; raise `DatabaseError` with context on invalid input.

3. Add config:
   - `credibility.enabled` default `true`.
   - `credibility.dimensions` default to the five §A8 dimension ids and labels.
   - `credibility.auto_profile_on_ingest` default `true`.
   - `credibility.require_human_review` default `true`.
   - `credibility.display_in_reports` default `true`.
   - `credibility.agent_instruction` default `weight_but_never_exclude`.

4. Add draft-generation module:
   - Build a prompt with source filename, source type, source metadata/provenance summary, and configured dimensions.
   - Generate structured output through `services.llm.generateStructured` with a Zod response validator.
   - Persist `profile_author = llm_auto`, `review_status = draft`, `last_reviewed = null`, and all configured dimensions.
   - Skip generation when a profile already exists for the source.
   - Return metadata describing whether a profile was created, skipped, or failed.

5. Wire Enrich integration:
   - After successful persistence and sensitivity propagation, call the draft generator for `story.sourceId`.
   - Treat profile-generation failure as non-fatal for the Enrich story result, but record a step error and log the cause.
   - Add `credibilityProfileCreated` to `EnrichmentData` so the behavior is observable.

6. Update roadmap state only after gates:
   - Keep L1 marked in progress while implementation is open.
   - Mark L1 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/11`.

## 5. QA Contract

1. **QA-01: Credibility tables are constrained**
   - Given a migrated database
   - When schema metadata is inspected
   - Then `source_credibility_profiles` and `credibility_dimensions` exist with unique source profiles, score bounds, enum checks, and lookup indexes.

2. **QA-02: Config exposes §A8 defaults**
   - Given minimal config
   - When it is loaded through the public config loader
   - Then credibility is enabled, the five default dimensions are present, auto-profile on ingest is enabled, human review is required, report display is enabled, and the agent instruction is `weight_but_never_exclude`.

3. **QA-03: Repository upserts a full dimension snapshot**
   - Given a source and a draft credibility profile input with configured dimensions
   - When `upsertSourceCredibilityProfile` runs twice with changed scores
   - Then one profile exists for the source and the latest dimension snapshot is returned without duplicate dimension rows.

4. **QA-04: Draft generation creates reviewable profiles**
   - Given an enriched source with no existing profile and a deterministic dev LLM response
   - When the draft generator runs
   - Then a profile is stored with `profile_author = llm_auto`, `review_status = draft`, `last_reviewed = null`, and one dimension row per configured dimension.

5. **QA-05: Existing profiles are preserved**
   - Given a source with an existing human-reviewed profile
   - When draft generation runs again
   - Then no LLM call is made and the existing profile values remain unchanged.

6. **QA-06: Enrich exposes profile-generation status**
   - Given a segmented story and credibility auto-generation enabled
   - When Enrich completes successfully
   - Then the result metadata includes whether a credibility profile was created or skipped, and profile-generation failures are reported as non-fatal errors.

## 5b. CLI Test Matrix

No new CLI commands are added.

| Command | Fixture | Expected |
| --- | --- | --- |
| `mulder config validate --config <minimal-config>` | Minimal config without `credibility` | Exit 0; default credibility config is accepted. |
| `mulder config show --config <minimal-config>` | Minimal config without `credibility` | Output includes the five default credibility dimensions. |
| `mulder enrich <source-id>` | Segmented source with no profile | Exit 0; source receives a draft credibility profile when enabled. |
| `mulder enrich <source-id>` | Source with reviewed profile | Exit 0; reviewed profile is preserved. |

## 6. Cost Considerations

L1 adds one optional LLM structured-output call per source when `credibility.auto_profile_on_ingest` is enabled and no profile exists. The call is skipped for existing profiles and can be disabled with `credibility.enabled: false` or `auto_profile_on_ingest: false`. Dev and test mode must remain fixture-backed and cost-free.
