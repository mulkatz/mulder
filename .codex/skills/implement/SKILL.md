---
name: implement
description: "Launch Mulder's implementation worker from a spec, roadmap step, or issue. Use this when the task is to build a spec-aligned change with branch and PR traceability."
---

# Implement

Use this skill as a thin launcher for a fresh implementation worker.

Read these files before acting:

- `.codex/shared/agent-contracts/authority.md`
- `.codex/shared/agent-contracts/target-resolution.md`
- `.codex/shared/agent-contracts/handoff-schemas.md`
- `.codex/shared/agent-contracts/output-schemas.md`
- `.codex/shared/agent-contracts/workflow-invariants.md`
- `.codex/skills/implement/references/worker.md`

## Workflow

1. Resolve the target using the shared spec-resolution rules.
2. Build the implement handoff payload using the exact shared input schema, carrying through `TARGET_STEP`, `ISSUE_NUMBER`, and `ISSUE_URL` only when the resolved spec or launcher context can provide them.
3. Spawn a fresh `worker` agent with `fork_context: false`.
4. Instruct the worker to rebuild context from the repository and follow `references/worker.md`.
5. Validate the returned output against the shared implement output schema.
6. If the worker response is malformed, request one contract-only restatement. If it is still malformed, stop and report a blocked state.
7. Return only the compact handoff summary.

## Codex Adaptation Rules

- This skill always launches a fresh worker, even when invoked directly by the user.
- Do not rely on parent-thread memory; rely on repo files plus the structured handoff.
- Keep the output contract stable so `auto-pilot` and standalone invocations behave the same way.
- Keep `SKILL.md` lean; detailed implementation behavior lives in `references/worker.md`.

## Output

Return the exact implement output schema from `.codex/shared/agent-contracts/output-schemas.md`.
