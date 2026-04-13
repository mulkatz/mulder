---
name: review
description: "Launch Mulder's architect-review worker for a PR, branch, or spec. Use this when a change needs the final architecture and spec-compliance gate."
---

# Review

Use this skill as a thin launcher for a fresh architect-review worker.

Read these files before acting:

- `.codex/shared/agent-contracts/authority.md`
- `.codex/shared/agent-contracts/target-resolution.md`
- `.codex/shared/agent-contracts/handoff-schemas.md`
- `.codex/shared/agent-contracts/output-schemas.md`
- `.codex/shared/agent-contracts/workflow-invariants.md`
- `.codex/skills/review/references/worker.md`

## Workflow

1. Resolve the target using the shared review-resolution rules.
2. Build the review handoff payload using the exact shared input schema, carrying `TARGET_STEP` only when the resolved target can provide it.
3. Spawn a fresh `worker` agent with `fork_context: false`.
4. Instruct the worker to rebuild review context from repo files and `references/worker.md`.
5. Validate the returned output against the shared review output schema.
6. If the response is malformed, request one contract-only restatement. If it is still malformed, stop and report a blocked state.

## Codex Adaptation Rules

- This skill always launches a fresh worker, even when invoked directly.
- Preserve findings-first reporting and the `APPROVED | CHANGES_REQUESTED` verdict vocabulary.
- Keep `SKILL.md` lean; detailed review behavior lives in `references/worker.md`.

## Output

Return the exact review output schema from `.codex/shared/agent-contracts/output-schemas.md`.
