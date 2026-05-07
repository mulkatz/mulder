---
spec: 112
title: "M11 Trust Layer Review Repair"
roadmap_step: "M11 post-review"
functional_spec: "§A3, §A5, §A6, §A8, §A13"
scope: "repair"
issue: "https://github.com/mulkatz/mulder/issues/295"
created: 2026-05-07
---

# Spec 112: M11 Trust Layer Review Repair

## 1. Objective

Close the M11 milestone review warnings without reopening the completed M11 roadmap steps. The repair makes credibility profiles first-class trust artifacts, removes the misleading implication that review metrics already auto-adjust review depth, and connects LLM-generated assertion classifications to the generic review workflow.

## 2. Boundaries

**Roadmap step:** M11 post-review repair. M11 remains `5/5`; this spec does not add a sixth roadmap task.

**Base branch:** `milestone/11`.

**Target branch:** `fix/m11-review-warnings`.

**In scope:**

- Add provenance and sensitivity fields to `source_credibility_profiles`.
- Backfill credibility profile trust metadata from the owning source.
- Add sensitivity-aware list/find options for credibility profiles.
- Include credibility profile provenance/sensitivity in review artifact context.
- Set `review_workflow.metrics.auto_adjust_depth` default to `false` and document it as reserved.
- Register `assertion_classification` review artifacts when `knowledge_assertions.classification_provenance = 'llm_auto'`.

**Out of scope:**

- A review-depth metrics worker or automatic policy loop.
- External query gate audit behavior for agents/exports.
- Agent-driven or human-reported conflict detection surfaces.
- UI/API review routes.

## 3. Blueprint

1. Add migration `042_source_credibility_trust_metadata.sql`:
   - Add `provenance JSONB`, `sensitivity_level TEXT`, and `sensitivity_metadata JSONB` to `source_credibility_profiles`.
   - Backfill profile provenance to include the owning source ID.
   - Backfill sensitivity from `sources.sensitivity_level` and `sources.sensitivity_metadata`.
   - Add shape checks and indexes for provenance source IDs and sensitivity level.

2. Update credibility repository APIs:
   - Extend `SourceCredibilityProfile` with provenance and sensitivity metadata.
   - Extend upsert input with optional provenance/sensitivity overrides.
   - Extend list/find options with `maxSensitivityLevel`.
   - Filter by both stored profile sensitivity and current owning source sensitivity.

3. Update review workflow integration:
   - Credibility profile review artifacts include `provenance`, `sensitivity_level`, and `sensitivity_metadata` in context.
   - LLM-generated assertion classifications create idempotent `assertion_classification` review artifacts.
   - Human-reviewed assertion classifications do not create new automatic review work.

4. Reserve review metrics auto-adjustment:
   - Change defaults/schema/example config to `auto_adjust_depth: false`.
   - Keep accuracy thresholds available for later reporting and worker implementation.

## 4. QA Contract

1. **Credibility trust metadata**
   - Given a migrated database
   - Then credibility profile schema exposes provenance and sensitivity constraints/indexes.

2. **Credibility access filtering**
   - Given a restricted source with a credibility profile
   - Then an internal-only profile list/find does not return it, while a restricted reader can access it.

3. **Review artifact context**
   - Given an LLM-generated credibility profile
   - Then its review artifact context carries source ID, provenance, sensitivity level, and sensitivity metadata.

4. **Metrics reservation**
   - Given a minimal config with `review_workflow` omitted
   - Then `review_workflow.metrics.auto_adjust_depth` defaults to `false`.

5. **Assertion classification review**
   - Given an LLM-auto knowledge assertion classification
   - Then an `assertion_classification` review artifact is created with current value and trust context.
   - Given a human-reviewed classification
   - Then no new automatic review artifact is created.

## 5. Follow-Up Tracking

Create follow-up GitHub issues instead of implementing these in M11 repair:

- External query gating/access audit for later agent/export safety specs: https://github.com/mulkatz/mulder/issues/296
- Agent-driven and human-reported conflict detection surfaces for later API/UI/agent specs: https://github.com/mulkatz/mulder/issues/297
