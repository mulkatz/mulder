---
spec: 66
title: "[Evidence] Expose analyze via @mulder/evidence"
roadmap_step: "[Issue #160]"
functional_spec: "[§2.8, §10.6, §13]"
scope: "[single]"
issue: "https://github.com/mulkatz/mulder/issues/160"
created: 2026-04-13
---

# Spec 66: [Evidence] Expose analyze via @mulder/evidence

## 1. Objective

Make `@mulder/evidence` the explicit public package boundary for Mulder's Analyze capability without moving the current implementation out of `packages/pipeline/src/analyze/*`. Per `§2.8`, Analyze is a modular full-graph capability with multiple sub-passes; per `§10.6`, future API evidence routes must stay synchronous and avoid reaching into pipeline internals directly. This spec resolves issue #160 by giving M7-era consumers one unambiguous import surface while keeping the existing pipeline implementation intact.

## 2. Boundaries

- **Roadmap Step:** `Issue #160` — Resolve the `@mulder/evidence` package boundary before M7 consumers depend on analyze
- **Target:** `packages/evidence/src/index.ts`, `packages/evidence/package.json`, `packages/evidence/tsconfig.json`, `CLAUDE.md`, `docs/functional-spec.md`, `docs/specs/02_monorepo_setup.spec.md`, `tests/specs/02_monorepo_setup.test.ts`, `tests/specs/66_evidence_package_boundary.test.ts`
- **In scope:** turning `@mulder/evidence` into a real facade package for Analyze exports; wiring its package/project dependencies so it can legally re-export analyze types and runtime entry points; updating architecture/package-graph documentation to match that boundary; and adding black-box tests that prove the facade works
- **Out of scope:** moving Analyze implementation files out of `packages/pipeline`; changing CLI command ownership; introducing new API routes; refactoring retrieval/taxonomy boundaries; or redesigning the full package graph beyond the evidence/analyze seam
- **Constraints:** keep the current Analyze implementation in `packages/pipeline/src/analyze/*`; keep `apps/api` aligned with `§10.6` by consuming a stable package boundary rather than pipeline internals; preserve ESM-only workspace conventions; and avoid creating circular package references

## 3. Dependencies

- **Requires:** Spec 02 (monorepo package graph), Spec 61 (contradiction resolution), Spec 62 (source reliability scoring), Spec 63 (evidence chains), Spec 64 (spatio-temporal clustering), Spec 65 (analyze orchestrator)
- **Blocks:** M7 consumers that need Analyze or evidence-domain entry points, especially future `/api/evidence/*` surfaces and any worker/API code that would otherwise guess between `pipeline` and `evidence`

## 4. Blueprint

### 4.1 Files

1. **`packages/evidence/src/index.ts`** — replace the empty module with a deliberate re-export surface for Analyze runtime entry points and public types from `@mulder/pipeline`
2. **`packages/evidence/package.json`** — add the workspace dependency on `@mulder/pipeline` so the facade's runtime dependency graph matches its export surface
3. **`packages/evidence/tsconfig.json`** — add the TypeScript project reference to `../pipeline` so composite builds and declaration output stay valid
4. **`CLAUDE.md`** — update the repo structure and package dependency sections so the architecture doc no longer implies `packages/evidence` is an empty shell
5. **`docs/functional-spec.md`** — update the source-layout package dependency graph to show `packages/evidence` as the public evidence/analyze facade over pipeline
6. **`docs/specs/02_monorepo_setup.spec.md`** — correct the historical package graph documentation so spec-level package expectations match the implemented boundary
7. **`tests/specs/02_monorepo_setup.test.ts`** — update black-box dependency expectations for `packages/evidence`
8. **`tests/specs/66_evidence_package_boundary.test.ts`** — add focused black-box QA for the new facade import surface and the aligned docs/package graph

### 4.2 Database Changes

None.

### 4.3 Config Changes

None.

### 4.4 Integration Points

- `packages/evidence` becomes the stable import boundary for Analyze-facing consumers
- `packages/pipeline` remains the implementation owner for pipeline execution and internal orchestration
- documentation in `CLAUDE.md`, `docs/functional-spec.md`, and the monorepo setup spec must all describe the same dependency graph
- black-box tests must verify both the package facade and the documented graph so future M7 work cannot regress back into an ambiguous boundary

### 4.5 Implementation Phases

Single phase — implement all files in the order listed in §4.1.

## 5. QA Contract

1. **QA-01: `@mulder/evidence` exposes the Analyze runtime surface**
   - Given: the workspace has been built with `pnpm turbo run build`
   - When: an ESM script imports `executeAnalyze` from `@mulder/evidence`
   - Then: the import succeeds, `executeAnalyze` is a function, and no consumer needs to reach into `@mulder/pipeline` for Analyze execution

2. **QA-02: `@mulder/evidence` exposes key Analyze types**
   - Given: the workspace has been built
   - When: an ESM script imports `AnalyzeInput`, `AnalyzeResult`, and `AnalyzePassName` from `@mulder/evidence`
   - Then: the package resolves those named exports successfully from its public entry point

3. **QA-03: facade build and typecheck are stable on repeat runs**
   - Given: the package graph has already been built and typechecked once
   - When: `pnpm --filter @mulder/evidence build` and `pnpm --filter @mulder/evidence typecheck` are run again
   - Then: both commands exit `0` and the package continues to expose the same Analyze entry point without requiring any manual cleanup

4. **QA-04: documentation names one boundary for Analyze consumers**
   - Given: `CLAUDE.md`, `docs/functional-spec.md`, and `docs/specs/02_monorepo_setup.spec.md`
   - When: the package dependency sections are inspected
   - Then: each document states that `packages/evidence` depends on `packages/pipeline`, and none of them describe `@mulder/evidence` as an empty or misleading package boundary

5. **QA-05: workspace dependency tests reflect the real package graph**
   - Given: the repository test suite includes monorepo dependency assertions
   - When: `vitest` runs the monorepo dependency tests and the new spec-66 boundary test
   - Then: both pass with `packages/evidence` expecting `@mulder/pipeline` in its dependency graph and the facade import surface proving usable from the built package

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

None — no paid API calls.
