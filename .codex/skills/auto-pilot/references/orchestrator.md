# Auto Pilot Orchestrator

## State Ledger

Track:

```text
TARGET_STEP
MILESTONE
SCOPE
SPEC_PATH
SPEC_NUMBER
ISSUE_NUMBER
ISSUE_URL
BRANCH_NAME
PR_URL
PR_NUMBER
ITERATION = 0
MAX_ITERATIONS = 3
VERDICT = pending
FAILURES = []
```

Maintain this task list:

```text
1. Pre-flight: clean state and pick roadmap step
2. Architect: read spec sections, generate spec, create issue
3. Implement: plan and build
4. Verify: write and run black-box tests
5. Review: architect-level correctness check
6. Finalize: merge, close issue, update roadmap
```

Keep the parent thread focused on this ledger plus short phase summaries. Do not drag full implementation, test, or review reasoning forward after each phase.

## Phase 0: Pre-Flight

Run inline:

- `git status --porcelain`
- `git branch --show-current`
- `git rev-parse HEAD`
- `git rev-parse origin/main`
- `gh auth status`

Gate conditions:

- dirty tree: stop and tell the user to start from a clean state
- on local branch `main`: allowed
- detached `HEAD` exactly at `origin/main`: allowed, especially for worktrees that are intentionally pinned to the current main tip
- detached `HEAD` not at `origin/main`: stop unless the user explicitly wants to start from that exact commit
- on any other branch: stop unless the user explicitly wants a different starting branch
- unauthenticated GitHub CLI: stop and surface the missing auth

If the gates pass:

- on local branch `main`: pull the latest `main`
- on detached `HEAD` at `origin/main`: do not block; treat the current commit as a valid main-aligned base and create the feature branch from it

This workflow must be runnable from a clean worktree that is detached at the current `origin/main` commit.

Record the starting mode for finalize:

- `START_MODE=main-branch`
- `START_MODE=main-aligned-detached`

## Phase 1: Architect

Run inline using `.codex/skills/architect/references/workflow.md`.

Requirements:

- resolve or auto-pick the roadmap step
- read only the required functional-spec sections plus milestone cross-references
- classify `single`, `phased`, or `multi-spec`
- stop for approval on `multi-spec`
- create or update the spec, issue, project metadata, and roadmap in-progress state
- ensure the issue title follows `[Domain] Observable system change — {TARGET_STEP}`

The architect phase is also responsible for preserving the original GitHub hygiene:

- domain and type labels
- project-board fields when configured
- functional-spec traceability in the spec and issue

Fold the results into the ledger:

```text
TARGET_STEP
MILESTONE
SCOPE
SPEC_PATH
SPEC_NUMBER
ISSUE_NUMBER
ISSUE_URL
```

## Phase 2: Implement

Increment `ITERATION`.

Spawn a fresh `worker` agent with `fork_context: false`. Pass only the implement handoff fields from the shared schema and tell the worker to:

- read `.codex/shared/agent-contracts/authority.md`
- read `.codex/shared/agent-contracts/workflow-invariants.md`
- read `.codex/shared/agent-contracts/output-schemas.md`
- read `.codex/skills/implement/references/worker.md`
- reconstruct all domain context from repository files and the handoff payload

The implement payload should include only the current structured state:

- `SPEC_PATH`
- `SPEC_NUMBER`
- optional `TARGET_STEP`
- optional `ISSUE_NUMBER`
- optional `ISSUE_URL`
- `ITERATION`
- optional `BRANCH_NAME`
- optional `FAILURES`

Parse only the required implement output fields back into the ledger.

The implementation branch must follow the typed Mulder naming scheme from the shared workflow invariants, with `feat/{issue-number}-{short-kebab-descriptor}` as the normal roadmap default.

If the output is malformed, ask once: "Restate your result in the exact implement output contract only." If it is still malformed, stop and report a blocked state.

## Phase 3: Verify

Spawn a fresh `worker` agent with `fork_context: false`. Pass only the verify handoff fields from the shared schema and tell the worker to:

- read `.codex/shared/agent-contracts/authority.md`
- read `.codex/shared/agent-contracts/workflow-invariants.md`
- read `.codex/shared/agent-contracts/output-schemas.md`
- read `.codex/skills/verify/references/worker.md`
- reconstruct context only from allowed repository files and the handoff payload

The verify payload should include:

- `SPEC_PATH`
- `SPEC_NUMBER`
- `BRANCH_NAME`
- `ITERATION`
- optional `TARGET_STEP`
- optional `TEST_MISMATCH`

Parse the verify contract.

This phase owns the QA gate:

- black-box QA conditions
- CLI matrix execution
- discovery-driven smoke coverage when the spec has CLI surface

Verdict handling:

- `PASS` -> review
- `PARTIAL` -> treat as pass only when every non-skipped condition passes
- `FAIL` with `ITERATION < MAX_ITERATIONS` -> store failure blocks and return to implement
- `FAIL` with iteration cap reached -> stop and report the blocked state

If implement reported `TEST_MISMATCH`, include it in the verify handoff so the verifier can inspect the assertion rather than force code to match a bad test.

If verify reports a regression in pre-existing tests, treat it as a real failure and loop back through implement when retries remain.

## Phase 4: Review

Spawn a fresh `worker` agent with `fork_context: false`. Pass only the review handoff fields from the shared schema and tell the worker to:

- read `.codex/shared/agent-contracts/authority.md`
- read `.codex/shared/agent-contracts/workflow-invariants.md`
- read `.codex/shared/agent-contracts/output-schemas.md`
- read `.codex/skills/review/references/worker.md`
- reconstruct context from the repo plus the handoff payload

The review payload should include:

- `SPEC_PATH`
- `SPEC_NUMBER`
- `BRANCH_NAME`
- optional `TARGET_STEP`
- optional `PR_NUMBER`
- optional `PR_URL`

Decision handling:

- `APPROVED` -> finalize
- `CHANGES_REQUESTED` with only warnings -> finalize and note warnings
- `CHANGES_REQUESTED` with blocking issues and retries left -> convert blocking issues into the next `FAILURES`, reset `VERDICT` to pending, then rerun implement -> verify -> review
- `CHANGES_REQUESTED` with blocking issues and no retries left -> stop and report the blocked state

Warnings alone must not trigger an extra implementation cycle.

Use the same malformed-output recovery rule as other workers.

## Phase 5: Finalize

Finalize inline only when the gates pass:

- merge the PR
- close or update issue state
- update roadmap from in-progress to complete
- preserve the issue auto-close path by keeping `Closes #{ISSUE_NUMBER}` in the PR body when an issue exists
- return the local checkout to a clean main-aligned state:
  - local `main` when the run started attached to `main`
  - detached at updated `origin/main` when the run started from a detached worktree base

If a devlog entry is warranted by repository practice, write it on the feature branch before merge using a professional `docs:` or `refactor:` style summary that reflects the actual change.

If the workflow is blocked instead of passed, do not force completion. Return the current ledger plus the blocking issues or failed conditions.

## Reporting

Keep progress updates short and operational.

Final report must include:

- selected roadmap step
- spec path
- issue and PR references
- final verdict
- whether roadmap and issue state advanced
- blocked or manual follow-up items
