---
name: verify
description: "Launch Mulder's verification worker from a spec or roadmap step. Use this when black-box QA, regression checks, and parseable failure evidence are required."
---

# Verify

Use this skill as a thin launcher for a fresh verification worker.

Read these files before acting:

- `.codex/shared/agent-contracts/authority.md`
- `.codex/shared/agent-contracts/target-resolution.md`
- `.codex/shared/agent-contracts/handoff-schemas.md`
- `.codex/shared/agent-contracts/output-schemas.md`
- `.codex/shared/agent-contracts/workflow-invariants.md`
- `.codex/skills/verify/references/worker.md`

## Workflow

1. Resolve the target using the shared spec-resolution rules.
2. Build the verify handoff payload using the exact shared input schema, carrying `TARGET_STEP` only when the resolved spec or launcher context can provide it.
3. Spawn a fresh `worker` agent with `fork_context: false`.
4. Instruct the worker to rebuild context only from allowed files and `references/worker.md`.
5. Validate the returned output against the shared verify output schema.
6. If the response is malformed, request one contract-only restatement. If it is still malformed, stop and report a blocked state.

## Codex Adaptation Rules

- This skill always launches a fresh worker, even when invoked directly.
- Preserve the black-box boundary and verdict vocabulary.
- Keep `SKILL.md` lean; detailed QA behavior lives in `references/worker.md`.

## Output

Return the exact verify output schema from `.codex/shared/agent-contracts/output-schemas.md`.
