---
spec: "83"
title: "M7 Verification Lane Repair"
roadmap_step: ""
functional_spec: []
scope: single
issue: ""
created: 2026-04-18
---

# Spec 83: M7 Verification Lane Repair

## 1. Objective

Restore the intended verification commands so scoped checks can run without dying in unrelated failures before the intended assertions start. This is not product-surface work; it is a test-lane integrity fix so later auto-pilot implementations can verify remediation work through the repository’s intended commands instead of ad hoc local workarounds.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap verification/harness follow-up for M7 remediation
- **Target:** `apps/cli/src/lib/eval.ts`, `apps/cli/src/commands/eval.ts`, `scripts/test-scope.mjs`, `scripts/test-api-e2e.mjs`, `scripts/test-lanes.mjs`, config-dependent black-box tests, and `tests/specs/83_m7_verification_lane_repair.test.ts`
- **In scope:** fixing the current build/type issues that prevent scoped lanes from reaching their intended assertions; preventing docs-only PR head commits from replaying unrelated DB/heavy affected lanes; tightening config-dependent tests so fresh checkouts rely on `mulder.config.example.yaml` or a temporary explicit config; and black-box verification that the commands now reach suite startup or execution instead of failing early on unrelated compile/config errors
- **Out of scope:** changing the product behavior under test, broad eval-framework redesign, adding new CI workflows, or rewriting unrelated spec assertions
- **Constraints:** keep this repair as narrow as possible; preserve the existing command names and invocation shapes; and do not use verification-lane repair as a backdoor for unrelated feature work

## 3. Dependencies

- **Requires:** the current CLI/eval command surface and the existing `scripts/test-scope.mjs` / `scripts/test-api-e2e.mjs` lane definitions
- **Blocks:** clean verification of the follow-up M7 remediation specs in this set

## 4. Blueprint

### 4.1 Files

1. **`apps/cli/src/lib/eval.ts`** — repair the current build/type failures that block scoped verification commands
2. **`apps/cli/src/commands/eval.ts`** — make any narrow command-surface adjustments required by the library repair
3. **`scripts/test-scope.mjs`** and **`scripts/test-api-e2e.mjs`** — keep the milestone/API lane scripts aligned with the fixed CLI surface if needed
4. **`tests/specs/83_m7_verification_lane_repair.test.ts`** — black-box verification that the intended M7 test commands now reach their actual suites
5. **`scripts/test-lanes.mjs`** — keep affected-test selection broad for code changes but scope docs-only PR head commits to the actual documentation files changed
6. **Config-dependent black-box tests** — avoid assuming an ignored root `mulder.config.yaml` exists in a fresh checkout

### 4.2 Lane Contract

After this repair:

- `pnpm test:scope -- milestone M7` must reach M7 suite startup/execution rather than dying in unrelated eval build errors
- `pnpm test:api:e2e` must likewise reach its own setup/execution path
- `pnpm --filter @mulder/cli build` must be green enough that the verification commands are not blocked by unrelated TypeScript failures in eval code
- PR affected lanes must use the full base diff for code/test changes, but may use only the newest head commit when that commit changes documentation files only
- Black-box tests must not require a local ignored `mulder.config.yaml`; tests that need the example project config must point at `mulder.config.example.yaml` or create a temporary default config explicitly

### 4.3 Integration Points

- this spec exists to support trustworthy verification of the other M7 remediation specs
- the commands under repair remain the canonical M7 lanes rather than being replaced by one-off local commands

### 4.4 Implementation Phases

Single phase — fix the blocking compile path and verify the M7 lane commands reach the intended suites.

## 5. QA Contract

1. **QA-01: milestone-scoped M7 verification reaches the suite**
   - Given: the repository is in a buildable state
   - When: `pnpm test:scope -- milestone M7` runs
   - Then: it reaches M7 suite startup/execution instead of failing early on unrelated CLI/eval compile errors

2. **QA-02: API-focused M7 verification reaches the suite**
   - Given: the same repository state
   - When: `pnpm test:api:e2e` runs
   - Then: it reaches the API E2E lane setup/execution path instead of failing early on unrelated CLI/eval compile errors

3. **QA-03: CLI build health no longer blocks M7 verification**
   - Given: the repaired CLI/eval surfaces
   - When: the CLI build/type path used by the verification commands runs
   - Then: it succeeds far enough that the M7 verification commands are not preempted by unrelated eval TypeScript failures

4. **QA-04: docs-only PR head commits do not replay unrelated affected lanes**
   - Given: a PR whose latest commit changes only documentation
   - When: `scripts/test-lanes.mjs affected-plan` runs with PR head docs-only optimization enabled
   - Then: the affected plan is based on that docs-only head change, not the full historical PR diff

5. **QA-05: config-dependent tests are fresh-checkout safe**
   - Given: a checkout without a local ignored `mulder.config.yaml`
   - When: config schema or layout-to-markdown tests need project config
   - Then: they use `mulder.config.example.yaml` explicitly or create a temporary `mulder.config.yaml` for the specific default-resolution assertion

## 5b. CLI Test Matrix

### Verification commands

| # | Command | Expected Behavior |
|---|---------|-------------------|
| CLI-01 | `pnpm test:scope -- milestone M7` | Reaches M7 suite startup/execution instead of dying in unrelated eval compile errors |
| CLI-02 | `pnpm test:api:e2e` | Reaches API E2E suite startup/execution instead of dying in unrelated eval compile errors |
| CLI-03 | `pnpm --filter @mulder/cli build` | Succeeds far enough to stop blocking the two verification lanes |

## 6. Cost Considerations

None — this is local/CI verification-lane repair only.
