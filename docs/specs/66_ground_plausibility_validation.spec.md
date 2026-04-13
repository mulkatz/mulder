---
spec: "66"
title: "Ground Plausibility Validation Before Persistence"
roadmap_step: ""
functional_spec: ["§2.5"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/161"
created: 2026-04-13
---

# Spec 66: Ground Plausibility Validation Before Persistence

## 1. Objective

Close Issue `#161` by adding the missing plausibility gate required by `§2.5` before Ground persists grounded attributes or geometry. The step must continue rejecting malformed or low-confidence responses, and must now also fail cleanly when grounded coordinates or date-like attributes are implausible, leaving both `entity_grounding` and the entity row unchanged.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap Ground hardening tracked by Issue `#161`
- **Target:** `packages/pipeline/src/ground/index.ts` and `packages/core/src/shared/services.dev.ts`
- **In scope:** an explicit plausibility-validation phase between payload parsing and persistence, coordinate guardrails that reject impossible latitude/longitude values before any entity mutation, a concrete sanity check that grounded single-date attributes (`verified_date`, `founding_date`) must be real `YYYY-MM-DD` calendar dates that are not later than the grounding day, and deterministic dev-mode fixture behavior that lets black-box QA trigger both accepted and rejected grounding payloads without live Vertex calls
- **Out of scope:** new CLI flags, schema or migration changes, taxonomy/entity-resolution changes, broader Ground prompt redesign, or live-GCP behavior beyond preserving the same validation contract on real responses
- **Constraints:** keep all failures in the existing `GROUND_VALIDATION_FAILED` path, do not persist partial grounding rows on rejected payloads, preserve the current support-confidence gate and cache semantics, and keep the QA surface black-box friendly through CLI-observable behavior only

## 3. Dependencies

- **Requires:** Spec 60 (`M6-G2`) Ground step, the existing Ground CLI black-box suite, and the dev-mode grounded generation stub in `packages/core/src/shared/services.dev.ts`
- **Blocks:** closure of Issue `#161` and any future HTTP/worker exposure of Ground where invalid grounded attributes would become harder to contain after leaving the CLI-only path

## 4. Blueprint

### 4.1 Files

1. **`packages/pipeline/src/ground/index.ts`** — add a dedicated plausibility-validation step after payload parsing and before attribute merging/persistence; reject invalid coordinate payloads, reject grounded `verified_date` / `founding_date` values that are not real `YYYY-MM-DD` dates or fall after the grounding day, and keep rejected payloads from mutating `entity_grounding`, `entities.attributes`, or `entities.geom`
2. **`packages/core/src/shared/services.dev.ts`** — extend the deterministic grounded dev fixture behavior so QA can provoke one accepted payload plus targeted invalid-coordinate and invalid-date payloads through black-box CLI runs

### 4.2 Database Changes

None.

### 4.3 Config Changes

None.

### 4.4 Integration Points

- Ground keeps using the existing `GROUND_VALIDATION_FAILED` error path and must fail before `persistEntityGroundingResult()` is called
- The dev grounded-generation stub becomes the deterministic test hook for plausibility failures so the verification agent can exercise rejection paths without importing implementation code or requiring live Vertex AI
- Existing Ground cache behavior, CLI selectors, and support-confidence enforcement remain unchanged for valid payloads

### 4.5 Implementation Phases

Single phase — implement the plausibility gate in Ground and expose deterministic dev fixtures for black-box rejection scenarios.

## 5. QA Contract

1. **QA-01: Valid location grounding still persists coordinates and cache data**
   - Given: a location entity with no `geom` and a deterministic dev grounding response that contains valid coordinates
   - When: `mulder ground <entity-id>` runs successfully
   - Then: the command exits `0`, creates exactly one `entity_grounding` row, and updates the entity row so `geom` is no longer null

2. **QA-02: Invalid grounded coordinates are rejected without writes**
   - Given: an eligible entity whose deterministic dev grounding response contains out-of-range latitude or longitude values
   - When: `mulder ground <entity-id>` runs
   - Then: the command exits non-zero with `GROUND_VALIDATION_FAILED`, no `entity_grounding` row is created for that entity, and the entity row remains without grounded geometry changes

3. **QA-03: Implausible grounded date attributes are rejected without writes**
   - Given: an eligible entity whose deterministic dev grounding response contains `verified_date` or `founding_date` with an invalid `YYYY-MM-DD` value or a date later than the grounding day
   - When: `mulder ground <entity-id>` runs
   - Then: the command exits non-zero with `GROUND_VALIDATION_FAILED`, no `entity_grounding` row is created for that entity, and the entity attributes do not gain the invalid grounded date

4. **QA-04: Existing low-confidence rejection still wins before persistence**
   - Given: grounding metadata reports support confidence below the configured `grounding.min_confidence`
   - When: `mulder ground <entity-id>` runs
   - Then: the command exits non-zero with `GROUND_VALIDATION_FAILED`, and no new `entity_grounding` row or grounded entity mutation is persisted

## 5b. CLI Test Matrix

### `mulder ground <entity-id>`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `<valid-location-id>` | Exit `0`, persists one grounding row and applies geometry |
| CLI-02 | `<invalid-coordinates-id>` | Exit non-zero with `GROUND_VALIDATION_FAILED`, persists no grounding row, leaves geometry unchanged |
| CLI-03 | `<invalid-date-id>` | Exit non-zero with `GROUND_VALIDATION_FAILED`, persists no grounding row, leaves invalid grounded date absent |
| CLI-04 | `<low-confidence-id>` | Exit non-zero with `GROUND_VALIDATION_FAILED`, persists no grounding row |

## 6. Cost Considerations

- **Services called:** none beyond the existing Ground step contract; dev-mode verification remains zero-cost
- **Estimated cost per run:** zero in dev/test mode; unchanged for live grounding
- **Dev mode alternative:** yes — deterministic grounded dev fixtures are the primary verification path for this follow-up
- **Safety flags:** no new paid calls, and rejected payloads must fail before any persistence side effects
