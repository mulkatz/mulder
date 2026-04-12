---
spec: "58"
title: "Deterministic CLI Artifact Refresh Before Black-Box Tests"
roadmap_step: ""
functional_spec: []
scope: single
issue: "https://github.com/mulkatz/mulder/issues/142"
created: 2026-04-12
---

# Spec 58: Deterministic CLI Artifact Refresh Before Black-Box Tests

## 1. Objective

Guarantee that Vitest-based black-box CLI specs execute current built artifacts even when the working tree has newer TypeScript sources than `dist/`. Issue `#142` exists because many spec suites correctly treat `apps/cli/dist/index.js` as the system boundary, but `pnpm test` currently trusts whatever was last built and can therefore validate stale behavior.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap tooling fix tracked by Issue `#142`
- **Target:** `vitest.config.ts`, a small pre-test artifact refresh entrypoint under `scripts/`, and one black-box verification suite under `tests/specs/`
- **In scope:** a deterministic pre-test rebuild for the CLI TypeScript project and its referenced workspace packages, wiring that rebuild into Vitest once per run, and black-box coverage proving stale CLI artifacts are refreshed while already-fresh trees still execute through current built artifacts
- **Out of scope:** changing CLI command behavior, replacing black-box tests with source imports, broad build-pipeline redesign, or refreshing unrelated package artifacts that are not in the CLI TypeScript project reference graph
- **Constraints:** preserve the built CLI boundary (`apps/cli/dist/index.js`), keep the refresh path deterministic for local and CI runs, and avoid unnecessary latency when the CLI project graph is already up to date

## 3. Dependencies

- **Requires:** the existing TypeScript project-reference build for `apps/cli`, Vitest as the root test runner, and the black-box CLI suites under `tests/specs/`
- **Blocks:** local and CI confidence for issue `#142`; no other roadmap specs depend on this work

## 4. Blueprint

### 4.1 Files

1. **`scripts/ensure-cli-test-artifacts.mjs`** — exports a deterministic entrypoint that runs a targeted `tsc --build --force apps/cli/tsconfig.json` so `apps/cli/dist/index.js` plus referenced package artifacts are current before black-box tests execute
2. **`vitest.config.ts`** — runs the refresh entrypoint once via Vitest global setup so `pnpm test` and direct `vitest run` invocations both refresh stale CLI artifacts before suites start
3. **`tests/specs/58_current_cli_artifact_refresh.test.ts`** — black-box verification of the refresh behavior by making source inputs newer than `dist`, invoking the refresh entrypoint as an external process, and asserting on observable filesystem timestamps plus CLI subprocess success

### 4.2 Database Changes

None.

### 4.3 Config Changes

None.

### 4.4 Integration Points

- The root Vitest config invokes the pre-test refresh once before any tests run
- The refresh entrypoint uses the existing CLI project-reference build graph so transitive dependencies such as `@mulder/core`, `@mulder/pipeline`, `@mulder/retrieval`, and `@mulder/taxonomy` stay aligned with the built CLI boundary
- The verification suite treats the refresh entrypoint and `apps/cli/dist/index.js` subprocesses as the only interfaces under test

### 4.5 Implementation Phases

Single phase — add the refresh entrypoint, wire it into Vitest global setup, and verify the stale-artifact and already-fresh paths with one spec suite.

## 5. QA Contract

1. **QA-01: Stale CLI source triggers a rebuild before black-box execution**
   - Given: `apps/cli/src/index.ts` is newer than `apps/cli/dist/index.js`
   - When: the pre-test refresh entrypoint runs
   - Then: the built CLI artifact reflects the new source content and `node apps/cli/dist/index.js --help` exits `0`

2. **QA-02: Already-fresh trees still execute through current built artifacts**
   - Given: the CLI project graph was just rebuilt successfully
   - When: the pre-test refresh entrypoint runs again without any newer inputs
   - Then: it exits `0` and `node apps/cli/dist/index.js export graph --help` still exposes the built export CLI surface

3. **QA-03: Referenced workspace packages refresh through the CLI build graph**
   - Given: a referenced dependency source such as `packages/core/src/index.ts` is newer than its `dist` output
   - When: the pre-test refresh entrypoint runs
   - Then: the referenced package artifact reflects the new source content and the CLI still runs from `apps/cli/dist/index.js`

## 5b. CLI Test Matrix

N/A — no user-facing CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None — this work changes only local and CI test/build orchestration.
