---
name: milestone-review
description: "Run Mulder's milestone divergence review in Codex. Use this when a completed milestone needs a section-by-section spec-versus-implementation audit."
---

# Milestone Review

Use this skill after a Mulder milestone is complete or nearly complete and needs a spec-versus-implementation audit.

Read these files before acting:

- `.codex/shared/agent-contracts/authority.md`
- `.codex/shared/agent-contracts/target-resolution.md`
- `.codex/skills/milestone-review/references/workflow.md`

## Workflow

1. Resolve the milestone using the shared milestone rules.
2. Follow the local workflow reference to build the section map and review batches.
3. Read only the milestone's required spec sections and implementation files.
4. Record divergences with section references, severity, and evidence.
5. Write the report to `docs/reviews/{milestone-id}-review.md`.

## Codex Adaptation Rules

- `.codex` is the active source of truth for this workflow.
- Keep the functional spec as the source of truth even when the implementation seems reasonable.
- Be exhaustive within the milestone scope, but do not drift into unrelated areas.
- Keep `SKILL.md` lean; report structure and batch procedure live in `references/workflow.md`.

## Output

Report the review file path, verdict, and the most important divergences.
