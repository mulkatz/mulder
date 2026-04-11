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
- If the legacy workflow calls for subagents, you may delegate because the user explicitly asked for the auto-pilot workflow. Use workers for implementation or QA only when delegation materially helps.
- If a referenced model name from the Claude prompt is unavailable, use the default current Codex model instead of inventing compatibility shims.
- Do not carry over Claude-specific commit trailers or identity strings unless the user explicitly wants them.
- Keep the state machine from the original command: target step, milestone, scope, spec path, issue, branch, PR, iteration count, verdict, failures.
- Preserve the Claude command's stop conditions. Only ask the user for approval where the original workflow requires it, such as multi-spec splits or a genuinely blocking fork.

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
   - Implement against the spec with roadmap, issue, branch, and PR traceability preserved.
   - Use Codex planning in place of Claude plan mode.
4. Verify:
   - Verification is black-box only.
   - Write or rerun spec tests and run the regression suite as the original workflow specifies.
5. Iterate:
   - If verification fails and `ITERATION < MAX_ITERATIONS`, feed the failure evidence back into implementation and rerun verification.
   - Preserve the original PASS, FAIL, and PARTIAL handling semantics.
6. Review:
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
