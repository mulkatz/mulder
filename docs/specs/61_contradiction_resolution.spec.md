---
spec: "61"
title: "Contradiction Resolution"
roadmap_step: M6-G3
functional_spec: ["§2.8"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/150"
created: 2026-04-12
---

# Spec 61: Contradiction Resolution

## 1. Objective

Implement Mulder's first Analyze sub-step so `mulder analyze --contradictions` resolves previously flagged `POTENTIAL_CONTRADICTION` edges with Gemini, updates each edge to `CONFIRMED_CONTRADICTION` or `DISMISSED_CONTRADICTION`, and stores the model's explanation on the edge record for downstream evidence and review workflows. Per `§2.8`, the step runs against the full graph rather than a single story, builds a comparison prompt from both conflicting claims plus source context, and treats contradiction resolution as a modular analysis pass that can be rerun after new documents or manual entity curation.

## 2. Boundaries

- **Roadmap Step:** `M6-G3` — Contradiction resolution — `mulder analyze --contradictions`
- **Target:** `packages/core/src/shared/errors.ts`, `packages/core/src/shared/services.dev.ts`, `packages/core/src/prompts/templates/resolve-contradiction.jinja2`, `packages/core/src/index.ts`, `packages/pipeline/src/analyze/types.ts`, `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`, `apps/cli/src/commands/analyze.ts`, `apps/cli/src/index.ts`
- **In scope:** loading unresolved contradiction edges, hydrating the prompt with both sides of the conflict and supporting story/source context, calling Gemini structured output through the shared LLM service, persisting per-edge verdicts and explanations, adding a standalone Analyze pipeline entry point for contradictions, and exposing the CLI command surface for `mulder analyze --contradictions`
- **Out of scope:** source reliability scoring (`M6-G4`), evidence chains (`M6-G5`), spatio-temporal clustering (`M6-G6`), the `--full` orchestrator (`M6-G7`), schema migrations beyond the existing `entity_edges.analysis` support, UI/API exposure, and any new contradiction-detection logic in the Graph step
- **Constraints:** keep the step global rather than story-scoped per `§2.8`; use the existing service abstraction and prompt engine instead of direct SDK calls or inline prompts; preserve idempotency by only processing unresolved `POTENTIAL_CONTRADICTION` edges unless a future step explicitly adds refresh semantics; and store enough structured analysis on each edge to support later evidence, export, and review flows

## 3. Dependencies

- **Requires:** Spec 11 (`M1-A10`) service abstraction, Spec 18 (`M2-B6`) prompt template engine, Spec 25 (`M3-C4`) edge repository CRUD, Spec 35 (`M4-D5`) graph contradiction flagging, and Spec 54 (`M6-G1`) v2.0 schema migrations
- **Blocks:** `M6-G7` analyze orchestrator and any downstream workflow that expects contradiction edges to carry confirmed or dismissed verdicts instead of only raw `POTENTIAL_CONTRADICTION` flags

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/shared/errors.ts`** — defines Analyze-step error codes and a dedicated error class for disabled analysis, malformed contradiction context, and persistence/LLM failures
2. **`packages/core/src/shared/services.dev.ts`** — returns deterministic contradiction-resolution fixtures through `generateStructured()` so black-box verification can exercise the step without live Gemini calls
3. **`packages/core/src/prompts/templates/resolve-contradiction.jinja2`** — upgrades the placeholder template to the real comparison contract, including both claims, source snippets, and JSON-only verdict instructions
4. **`packages/core/src/index.ts`** — re-exports the new Analyze error surface for pipeline and CLI consumers
5. **`packages/pipeline/src/analyze/types.ts`** — defines contradiction-resolution input, structured LLM response, per-edge outcome, and aggregate Analyze result types
6. **`packages/pipeline/src/analyze/index.ts`** — implements the contradiction-resolution step: load unresolved contradiction edges, gather story/source context, render the prompt, call Gemini structured output, map the verdict to a final edge type, persist the explanation/metadata, and return an aggregate result
7. **`packages/pipeline/src/index.ts`** — exports the Analyze step from the pipeline package barrel
8. **`apps/cli/src/commands/analyze.ts`** — thin Commander wrapper for `mulder analyze --contradictions`, including flag validation, step execution, tabular output, and exit-code handling
9. **`apps/cli/src/index.ts`** — registers the new `analyze` command

### 4.2 Database Changes

None. This step uses the existing `entity_edges` schema introduced earlier:

- `edge_type` transitions from `POTENTIAL_CONTRADICTION` to either `CONFIRMED_CONTRADICTION` or `DISMISSED_CONTRADICTION`
- `analysis` stores the structured Gemini verdict, explanation, and any supporting metadata needed for later export/review

### 4.3 Config Changes

None. The step uses the existing `analysis` config block:

- `analysis.enabled`
- `analysis.contradictions`

Implementation should fail fast with a clear Analyze-step error when contradiction analysis is disabled by config.

### 4.4 Integration Points

- The step must use `renderPrompt('resolve-contradiction', ...)` so prompt content stays template-driven
- Gemini calls must go through `services.llm.generateStructured()` with both server-side schema enforcement and client-side validation
- Edge persistence should reuse the existing repository APIs to update `edge_type` and `analysis` in place rather than creating new edges
- CLI wiring should follow the existing `ground` and `graph` command pattern: validate flags, load config, create services, run the pipeline step, print a concise results table and summary, then close pools
- The pipeline barrel export should make the new Analyze executor available to the CLI now and to the future orchestrator in `M6-G7`

### 4.5 Implementation Phases

**Phase 1: Contracts + prompt**
- Files: `packages/core/src/shared/errors.ts`, `packages/core/src/shared/services.dev.ts`, `packages/core/src/prompts/templates/resolve-contradiction.jinja2`, `packages/core/src/index.ts`, `packages/pipeline/src/analyze/types.ts`
- Deliverable: the Analyze step has a stable typed contract, dev/test fixture behavior, and a concrete prompt/schema for contradiction verdicts

**Phase 2: Resolution engine**
- Files: `packages/pipeline/src/analyze/index.ts`, `packages/pipeline/src/index.ts`
- Deliverable: unresolved contradiction edges can be resolved and persisted with confirmed/dismissed verdicts plus stored explanations

**Phase 3: CLI surface**
- Files: `apps/cli/src/commands/analyze.ts`, `apps/cli/src/index.ts`
- Deliverable: `mulder analyze --contradictions` runs end to end with clear summaries and non-zero exits for invalid invocations or total failure

## 5. QA Contract

1. **QA-01: Contradiction analysis resolves pending edges into final verdicts**
   - Given: the database contains at least one `POTENTIAL_CONTRADICTION` edge whose related stories and sources exist, and `analysis.enabled=true` with `analysis.contradictions=true`
   - When: `mulder analyze --contradictions` runs successfully
   - Then: the command exits `0`, the targeted edge no longer has `edge_type='POTENTIAL_CONTRADICTION'`, its new `edge_type` is either `CONFIRMED_CONTRADICTION` or `DISMISSED_CONTRADICTION`, and its `analysis` column contains a non-empty explanation payload

2. **QA-02: Re-running the step is idempotent after all pending contradictions are resolved**
   - Given: the same contradiction edges have already been resolved once
   - When: `mulder analyze --contradictions` is run again without adding new `POTENTIAL_CONTRADICTION` edges
   - Then: the command exits `0`, reports that zero pending contradictions were processed, and previously resolved edge verdicts remain unchanged

3. **QA-03: No-op runs succeed cleanly when there is nothing to resolve**
   - Given: the database contains no `POTENTIAL_CONTRADICTION` edges
   - When: `mulder analyze --contradictions` runs
   - Then: the command exits `0`, prints a clear “nothing to analyze” style summary, and makes no database changes

4. **QA-04: Disabled contradiction analysis fails before any LLM work**
   - Given: `analysis.enabled=false` or `analysis.contradictions=false`
   - When: `mulder analyze --contradictions` runs
   - Then: the command exits non-zero with an Analyze-step error code/message explaining that contradiction analysis is disabled, and no `entity_edges` rows are modified

5. **QA-05: Missing contradiction context fails without partial updates**
   - Given: a `POTENTIAL_CONTRADICTION` edge exists but one of its referenced stories or sources is missing
   - When: `mulder analyze --contradictions` runs
   - Then: the command exits non-zero with an Analyze-step error code for missing context, and the affected edge remains `POTENTIAL_CONTRADICTION` with no partial verdict written

6. **QA-06: Mixed batches preserve successful verdicts and report partial failure**
   - Given: one pending contradiction edge has valid context and another pending contradiction edge has invalid or missing context
   - When: `mulder analyze --contradictions` runs
   - Then: the valid edge is resolved and persisted, the invalid edge remains pending, and the command reports partial failure rather than rolling back the successful resolution

## 5b. CLI Test Matrix

### `mulder analyze --contradictions`

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `--contradictions` | Exit `0`, resolves all pending contradiction edges and prints a summary table |
| CLI-02 | `--contradictions` *(run twice)* | Exit `0`, second run reports zero processed contradictions and preserves the first run’s verdicts |
| CLI-03 | `--contradictions --json` | Exit non-zero, because JSON output is not part of this step’s CLI surface |
| CLI-04 | `--contradictions --full` | Exit non-zero, because `--full` belongs to `M6-G7`, not `M6-G3` |

### Selector validation

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-05 | *(no args)* | Exit non-zero, usage/help indicates that an analysis selector such as `--contradictions` is required |
| CLI-06 | `--full` | Exit non-zero, because the full Analyze orchestrator is not implemented yet |
| CLI-07 | `--reliability` | Exit non-zero, because source reliability scoring belongs to `M6-G4` |
| CLI-08 | `--evidence-chains` | Exit non-zero, because evidence chains belong to `M6-G5` |
| CLI-09 | `--spatio-temporal` | Exit non-zero, because clustering belongs to `M6-G6` |

## 6. Cost Considerations

- **Services called:** Gemini via Vertex AI structured generation
- **Estimated cost per contradiction edge:** low but non-zero; each unresolved contradiction requires one Gemini comparison call
- **Dev mode alternative:** yes — deterministic contradiction fixtures in `services.dev.ts` allow end-to-end verification without live Vertex spend
- **Safety flags:** respect `analysis.enabled` and `analysis.contradictions` so the step does not make paid calls when contradiction analysis is disabled
