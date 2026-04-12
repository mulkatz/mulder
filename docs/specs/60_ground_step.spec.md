---
spec: "60"
title: "Ground Step"
roadmap_step: M6-G2
functional_spec: ["§1", "§2.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/148"
created: 2026-04-12
---

# Spec 60: Ground Step

## 1. Objective

Implement Mulder's v2.0 Ground step so entities can be web-enriched on demand or in batches using Gemini with Google Search grounding, with cache-aware persistence in PostgreSQL. Per `§2.5`, the step must filter entities by the configured grounding types, respect TTL-based caching unless `--refresh` is used, persist grounding results in `entity_grounding`, and update entity attributes such as location coordinates when grounded data yields higher-confidence facts.

## 2. Boundaries

- **Roadmap Step:** `M6-G2` — Ground step — `mulder ground <entity-id>`
- **Target:** `packages/core/src/database/repositories/entity-grounding.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/core/src/database/repositories/entity.types.ts`, `packages/core/src/shared/errors.ts`, `packages/core/src/index.ts`, `packages/core/src/prompts/templates/ground-entity.jinja2`, `packages/pipeline/src/ground/index.ts`, `packages/pipeline/src/ground/types.ts`, `packages/pipeline/src/index.ts`, `apps/cli/src/commands/ground.ts`, `apps/cli/src/index.ts`
- **In scope:** repository support for grounding cache reads/writes, Ground-step orchestration for single-entity and batch execution, cache TTL + refresh handling, prompt rendering for grounded generation, persistence into `entity_grounding`, selective entity attribute updates, CLI wiring for `mulder ground` with `--all`, `--type`, `--batch`, and `--refresh`
- **Out of scope:** pipeline-orchestrator integration for automatic grounding in `pipeline run`, Analyze sub-steps (`M6-G3` to `M6-G7`), new database migrations, UI/API exposure, taxonomy or entity-resolution redesign, and non-Gemini web-search providers
- **Constraints:** preserve service abstraction by routing all grounding calls through `services.llm.groundedGenerate`, keep the step idempotent via upsert behavior in `entity_grounding`, avoid inline SDK calls or ad hoc retry logic, and treat web results as time-sensitive data that bypasses the dev LLM cache per `§4.8`

## 3. Dependencies

- **Requires:** Spec 11 (`M1-A10`) service abstraction, Spec 24 (`M3-C3`) entity repositories, Spec 54 (`M6-G1`) v2.0 schema migrations, and the existing prompt/template infrastructure from Specs 18 and 29
- **Blocks:** `M6-G3` contradiction resolution, `M6-G4` source reliability scoring, and any future pipeline mode that includes the optional Ground stage

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/database/repositories/entity-grounding.repository.ts`** — CRUD helpers for `entity_grounding`, including lookup by entity, expiry-aware cache checks, and idempotent upsert of grounded payloads and source URLs
2. **`packages/core/src/database/repositories/index.ts`** — exports the new repository functions and types
3. **`packages/core/src/database/repositories/entity.types.ts`** — extends repository types with grounding records and any grounded-attribute helpers shared between the repo and step
4. **`packages/core/src/shared/errors.ts`** — introduces `GROUND_ERROR_CODES` and `GroundError` aligned with the existing step-specific error hierarchy
5. **`packages/core/src/index.ts`** — re-exports the new grounding repository APIs and error types for CLI/pipeline consumers
6. **`packages/core/src/prompts/templates/ground-entity.jinja2`** — replaces the placeholder template with the real grounding prompt contract, including entity context and JSON-only output instructions
7. **`packages/pipeline/src/ground/types.ts`** — defines `GroundInput`, `GroundResult`, grounded payload types, and batch-facing result metadata
8. **`packages/pipeline/src/ground/index.ts`** — executes the Ground step: validate the entity/status, enforce configured type filters, consult TTL cache, render the prompt, call grounded Gemini, validate/normalize results, persist cache rows, and update entity attributes such as coordinates
9. **`packages/pipeline/src/index.ts`** — exports the Ground step from the pipeline package barrel
10. **`apps/cli/src/commands/ground.ts`** — thin Commander wrapper for `mulder ground <entity-id>` with single-entity, `--all`, and `--type` batch modes plus `--batch` and `--refresh`
11. **`apps/cli/src/index.ts`** — registers the new `ground` command with the CLI entry point

### 4.2 Database Changes

None. This step uses the schema introduced by Spec 54:

- `entity_grounding` stores the cached grounding payload, source URLs, grounding timestamp, and TTL expiry
- `entities.geom` is updated when grounded coordinates are available and pass plausibility checks

### 4.3 Config Changes

None. The existing `grounding` config block already provides:

- `enabled`
- `mode`
- `enrich_types`
- `cache_ttl_days`

Implementation should read those values through `loadConfig()` and not introduce new config keys in this step.

### 4.4 Integration Points

- CLI wiring mirrors the existing `enrich`, `embed`, and `graph` command structure, but targets entities instead of stories
- The Ground step uses the existing prompt engine (`renderPrompt`) and `services.llm.groundedGenerate()` API rather than direct Vertex SDK calls
- Repository writes must upsert into `entity_grounding` and update the corresponding entity row in `entities` when grounded attributes become available
- Core barrel exports must expose the new repository and error symbols so both CLI and future API/worker code can reuse the step

### 4.5 Implementation Phases

**Phase 1: Grounding persistence + contracts**
- Files: `packages/core/src/database/repositories/entity-grounding.repository.ts`, `packages/core/src/database/repositories/index.ts`, `packages/core/src/database/repositories/entity.types.ts`, `packages/core/src/shared/errors.ts`, `packages/core/src/index.ts`, `packages/pipeline/src/ground/types.ts`
- Deliverable: grounding records can be read/written idempotently, and the step has typed contracts plus a dedicated error surface

**Phase 2: Step execution + prompt contract**
- Files: `packages/core/src/prompts/templates/ground-entity.jinja2`, `packages/pipeline/src/ground/index.ts`, `packages/pipeline/src/index.ts`
- Deliverable: a reusable Ground step that filters eligible entities, honors TTL/refresh semantics, calls grounded Gemini, persists results, and updates entity attributes

**Phase 3: CLI surface**
- Files: `apps/cli/src/commands/ground.ts`, `apps/cli/src/index.ts`
- Deliverable: `mulder ground` works for single entities and batch modes with observable summaries, validation errors, and refresh support

## 5. QA Contract

1. **QA-01: Single-entity grounding enriches an eligible entity and stores cache metadata**
   - Given: a database entity of a configured grounding type exists with no current `entity_grounding` row, and the system is configured for grounding
   - When: `mulder ground <entity-id>` runs successfully
   - Then: the command exits `0`, reports one grounded entity, creates an `entity_grounding` row for that entity, and persists at least one source URL plus a future `expires_at` timestamp

2. **QA-02: Cached grounding is reused until TTL expiry**
   - Given: an eligible entity already has a non-expired `entity_grounding` row
   - When: `mulder ground <entity-id>` runs without `--refresh`
   - Then: the command exits `0`, reports the entity as skipped or cached rather than re-grounded, and the existing grounding timestamp remains unchanged

3. **QA-03: Refresh bypasses the cache and replaces grounding data**
   - Given: an eligible entity already has a non-expired `entity_grounding` row
   - When: `mulder ground <entity-id> --refresh` runs
   - Then: the command exits `0`, performs a new grounding call, and updates the stored grounding timestamp and/or payload for that entity

4. **QA-04: Type filters exclude entities outside configured or requested scope**
   - Given: one entity of an allowed grounding type and one entity of a disallowed type exist
   - When: `mulder ground --all` or `mulder ground --type <allowed-type>` runs
   - Then: only eligible entities are processed, disallowed entities are reported as skipped or omitted, and no `entity_grounding` row is created for the excluded entity

5. **QA-05: Grounded coordinates propagate to the entity record when a location is resolved**
   - Given: an eligible location entity has no `geom` value before grounding
   - When: grounding returns plausible coordinates for that entity
   - Then: the entity row is updated with coordinate-bearing attributes and `geom` is no longer null

6. **QA-06: Missing entity IDs fail cleanly without partial state**
   - Given: no entity exists for a requested UUID
   - When: `mulder ground <missing-uuid>` runs
   - Then: the command exits non-zero with a Ground-step error code, and no new row is inserted into `entity_grounding`

7. **QA-07: Batch mode respects the requested batch size**
   - Given: more eligible entities exist than the chosen batch size
   - When: `mulder ground --all --batch 2` runs
   - Then: the command processes no more than two entities in that invocation and reports the limited batch size in its observable results

8. **QA-08: Grounding writes are idempotent per entity**
   - Given: the same eligible entity is grounded successfully once
   - When: the same command is run again under the same cache/refresh conditions
   - Then: there is still exactly one `entity_grounding` row for that entity, and the entity record remains consistent instead of duplicating state

## 5b. CLI Test Matrix

### `mulder ground <entity-id>`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `<entity-id>` | Exit `0`, grounds the single eligible entity |
| CLI-02 | `<entity-id> --refresh` | Exit `0`, bypasses cache and refreshes stored grounding |
| CLI-03 | `<entity-id> --batch 5` | Exit non-zero, because `--batch` is only valid with batch modes |
| CLI-04 | `<entity-id> --type location` | Exit non-zero, because `<entity-id>` is mutually exclusive with `--type` |
| CLI-05 | `<entity-id> --all` | Exit non-zero, because `<entity-id>` and `--all` are mutually exclusive |
| CLI-06 | `<missing-uuid>` | Exit non-zero with a Ground-step error |

### `mulder ground --all`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-07 | `--all` | Exit `0`, processes eligible entities up to the default batch size |
| CLI-08 | `--all --batch 2` | Exit `0`, processes at most 2 eligible entities |
| CLI-09 | `--all --refresh` | Exit `0`, refreshes eligible entities even when cached |
| CLI-10 | `--all --type person` | Exit non-zero, because `--all` and `--type` are mutually exclusive selectors |

### `mulder ground --type <type>`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-11 | `--type location` | Exit `0`, processes eligible location entities only |
| CLI-12 | `--type location --batch 1` | Exit `0`, limits processing to 1 location entity |
| CLI-13 | `--type location --refresh` | Exit `0`, refreshes cached location entities |
| CLI-14 | `--type location --all` | Exit non-zero, because `--type` and `--all` are mutually exclusive selectors |
| CLI-15 | `--type ""` | Exit non-zero with validation feedback |

### Selector validation

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-16 | *(no args)* | Exit non-zero, usage/help indicates that `<entity-id>`, `--all`, or `--type` is required |
| CLI-17 | `--batch 0 --all` | Exit non-zero, because batch size must be a positive integer |

## 6. Cost Considerations

- **Services called:** Gemini via Vertex AI with `google_search_retrieval`
- **Estimated cost per entity:** low but variable by search depth and prompt size; every fresh grounding call is a paid web-grounded LLM request
- **Dev mode alternative:** yes — fixture/dev mode can exercise the step structure without requiring production orchestration, though real web-grounding quality still depends on live Vertex AI results
- **Safety flags:** honor `grounding.enabled`, `grounding.mode`, and cache TTL so repeated runs do not re-spend tokens unnecessarily unless `--refresh` is explicitly requested
