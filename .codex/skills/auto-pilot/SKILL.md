---
name: auto-pilot
description: "Run Mulder's full roadmap-step delivery workflow in Codex. Use this when the user wants the old Claude `/auto-pilot` behavior: pre-flight checks, spec creation, implementation, black-box verification, review, and finalization for a roadmap step."
---

# Auto Pilot

Use this skill for Mulder roadmap work that should follow the full Claude-style pipeline end to end.

## Source Of Truth

Read `.claude/commands/auto-pilot.md` before acting. Treat it as the workflow contract you are migrating, not as literal tool syntax.

Read these supporting command files when you need their detailed behavior:
- `.claude/commands/architect.md`
- `.claude/commands/implement.md`
- `.claude/commands/verify.md`
- `.claude/commands/review.md`

Do not modify or delete anything under `.claude/commands/`.

Read the supporting skills or command sources for detailed sub-workflow behavior:
- `.claude/commands/architect.md`
- `.claude/commands/implement.md`
- `.claude/commands/verify.md`
- `.claude/commands/review.md`

## When To Use

Use `auto-pilot` when the user wants a roadmap step to move through the full lifecycle:
- pick or confirm a roadmap step
- create or update the implementation spec
- implement the code on a feature branch
- verify via black-box tests
- perform architect review
- finalize by merging, closing issue state, and updating roadmap state

Do not use this for small bug fixes or narrow edits that do not need a spec. Route those to `implement` or `verify`.

## Codex Adaptation Rules

- Preserve the workflow and decision gates from the Claude command, but adapt them to Codex tools and policies.
- Replace Claude-specific plan-mode wording with Codex planning. Use `update_plan` for substantial work and keep it current.
- Treat `auto-pilot` as a thin coordinator. Keep the main thread focused on workflow state, decisions, and summaries rather than detailed implementation or QA context.
- Architect and finalize stay inline unless a blocking constraint forces a pause.
- Implement, verify, and review run via fresh sub-agents by default because the user explicitly asked for the auto-pilot workflow and this workflow benefits from bounded phase context.
- Prefer fresh sub-agents over reusing a long-lived worker across phases. For iteration retries, spawn a new phase agent with the latest structured failure evidence instead of carrying full prior chat history.
- Do not fork the full parent context into phase agents unless a narrow blocking detail truly cannot be reconstructed from the repo plus the handoff payload.
- If a referenced model name from the Claude prompt is unavailable, use the default current Codex model instead of inventing compatibility shims.
- Do not carry over Claude-specific commit trailers or identity strings unless the user explicitly wants them.
- Keep the state machine from the original command: target step, milestone, scope, spec path, issue, branch, PR, iteration count, verdict, failures.
- Preserve the Claude command's stop conditions. Only ask the user for approval where the original workflow requires it, such as multi-spec splits or a genuinely blocking fork.

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

The main agent should hold only this ledger plus brief phase summaries. Do not keep full implementation, test, or review reasoning in the parent thread once a phase is complete.

## Phase Handoffs

When spawning a phase sub-agent, pass only the minimum state it needs:

- Implement handoff:
  - `SPEC_PATH`
  - `SPEC_NUMBER`
  - `TARGET_STEP`
  - `ISSUE_NUMBER`
  - `ISSUE_URL`
  - `BRANCH_NAME` if resuming
  - `ITERATION`
  - `FAILURES` only for iteration 2+
- Verify handoff:
  - `SPEC_PATH`
  - `SPEC_NUMBER`
  - `TARGET_STEP`
  - `BRANCH_NAME`
  - `ITERATION`
  - any `TEST_MISMATCH` details reported by implementation
- Review handoff:
  - `SPEC_PATH`
  - `SPEC_NUMBER`
  - `TARGET_STEP`
  - `BRANCH_NAME`
  - `PR_NUMBER` or `PR_URL` when available

Each handoff should tell the sub-agent to reconstruct domain context from repository files rather than parent-thread memory.

## Required Sub-Agent Outputs

Sub-agents must return compact, parseable summaries so the coordinator can update its ledger without inheriting the full phase context.

- Implement must return:
  - `BRANCH_NAME`
  - `PR_URL`
  - `PR_NUMBER`
  - `FILES_CHANGED`
  - `DEVIATIONS`
  - `TEST_MISMATCH` when applicable
- Verify must return:
  - `TOTAL`
  - `PASSED`
  - `FAILED`
  - `SKIPPED`
  - `VERDICT`
  - one failure block per failed condition
- Review must return:
  - `REVIEW_VERDICT`
  - blocking `ISSUE` blocks when present

After each phase, fold the result back into the ledger and continue from the summary only.

## State Tracking

Track and update these values explicitly during the run:

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

Create and maintain a task list equivalent to the original workflow:

```text
1. Pre-flight: clean state and pick roadmap step
2. Architect: read spec sections, generate spec, create issue
3. Implement: plan and build
4. Verify: write and run black-box tests
5. Review: architect-level correctness check
6. Finalize: merge, close issue, update roadmap
```

## Required Workflow

1. Pre-flight:
   - Check clean git state.
   - Check the current branch is `main`.
   - Check GitHub CLI authentication.
   - Pull latest `main` before starting if the gates pass.
2. Architect:
   - Resolve or auto-pick the roadmap step.
   - Read only the required functional-spec sections and milestone cross-references.
   - Apply the same scope classification as the Claude workflow: `single`, `phased`, `multi-spec`.
   - Stop for user approval on `multi-spec`.
   - Create the spec, create or update the GitHub issue, update project metadata if configured, and move roadmap state to in-progress when the workflow calls for it.
3. Implement:
   - Spawn a fresh implementation sub-agent.
   - Implement against the spec with roadmap, issue, branch, and PR traceability preserved.
   - Use Codex planning in place of Claude plan mode.
4. Verify:
   - Spawn a fresh verification sub-agent.
   - Verification is black-box only.
   - Write or rerun spec tests and run the regression suite as the original workflow specifies.
5. Iterate:
   - If verification fails and `ITERATION < MAX_ITERATIONS`, feed only the failure evidence back into a new implementation sub-agent and rerun verification with a new verification sub-agent.
   - Preserve the original PASS, FAIL, and PARTIAL handling semantics.
6. Review:
   - Spawn a fresh review sub-agent after QA passes.
   - Run the architect review gate before any merge or close-out.
7. Finalize:
   - Merge, close, and update roadmap or issue state only when the workflow's gates pass.
   - If the iteration cap is hit or a blocking review issue remains, stop and return the current state to the user instead of forcing completion.

## Verification Loop

Use the original decision logic:
- `PASS` moves to review.
- `PARTIAL` is treated as pass only when all non-skipped checks pass.
- `FAIL` triggers another implement and verify cycle until `MAX_ITERATIONS` is reached.
- If the implementation agent identifies a test-vs-spec mismatch, route that back into verification rather than forcing code to match an incorrect test.

## Reporting

During execution, keep updates short and operational. At the end, report:
- selected roadmap step
- spec path
- issue and PR references
- final verdict
- whether roadmap and issue state were advanced
- any blocked or manual follow-up items
