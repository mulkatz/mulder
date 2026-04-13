---
name: auto-pilot
description: "Run Mulder's full roadmap-step delivery workflow in Codex. Use this to orchestrate spec creation, implementation, verification, review, and finalization for a roadmap step."
---

# Auto Pilot

Use this skill as the orchestrator for end-to-end roadmap delivery.

Read these files before acting:

- `.codex/shared/agent-contracts/authority.md`
- `.codex/shared/agent-contracts/handoff-schemas.md`
- `.codex/shared/agent-contracts/output-schemas.md`
- `.codex/shared/agent-contracts/workflow-invariants.md`
- `.codex/skills/auto-pilot/references/orchestrator.md`

## When To Use

Use `auto-pilot` when the user wants a roadmap step to move through the full lifecycle:
- pick or confirm a roadmap step
- create or update the implementation spec
- implement the code on a feature branch
- verify via black-box tests
- perform architect review
- finalize by merging, closing issue state, and updating roadmap state

Do not use this for small bug fixes or narrow edits that do not need a spec. Route those to `implement` or `verify`.

## Coordinator Model

Run `auto-pilot` as an orchestrator with a small explicit ledger:

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
ITERATION
MAX_ITERATIONS
VERDICT
FAILURES
```

The parent thread keeps only this ledger plus brief phase summaries.

## Required Workflow

1. Run pre-flight checks inline.
2. Run the architect phase inline using the local architect workflow.
3. Spawn fresh worker agents for implement, verify, and review using the shared handoff and output contracts.
4. Keep the retry loop and verdict handling defined in the local orchestrator reference.
5. Finalize inline only when the review and verification gates pass.

## Codex Adaptation Rules

- `.codex` is the active source of truth for orchestration behavior.
- Always spawn fresh workers for implement, verify, and review, even on standalone-like retries.
- Do not fork full parent context unless a narrow blocking detail cannot be reconstructed from repo state.
- On malformed worker output, request one contract-only restatement and stop if the schema is still broken.

## Reporting

At the end, report the selected roadmap step, spec path, issue and PR references, final verdict, state transitions, and any blocked follow-up.
