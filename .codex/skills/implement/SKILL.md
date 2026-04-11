---
name: implement
description: "Implement a Mulder spec in Codex. Use this when the user wants the old Claude `/implement` workflow: resolve the spec, study the codebase, plan carefully, implement the required files, verify build and lint integrity, and prepare the branch and PR."
---

# Implement

Use this skill when the task is to build a specific Mulder spec or roadmap step.

## Source Of Truth

Read `.claude/commands/implement.md` before acting. Treat it as the implementation contract, adapted for Codex tools and policies.

Do not modify `.claude/commands/implement.md`.

## Workflow

1. Resolve the spec reference exactly as the Claude command describes, including spec number, filename, full path, roadmap step, issue, or the most recent in-progress roadmap step.
2. Read the spec, `CLAUDE.md`, roadmap context, required functional-spec sections, and milestone cross-references.
3. Study adjacent implementation patterns before planning.
4. Create an explicit execution plan with `update_plan` before writing code.
5. Implement only the scoped work from the spec, file by file and phase by phase.
6. Run the build and lint verification required by the original command.
7. Create or resume the feature branch and prepare the PR with the same traceability the old workflow expects.

## Codex Adaptation Rules

- Replace EnterPlanMode or ExitPlanMode instructions with Codex planning and `update_plan`.
- Do not write tests unless the user explicitly asks or the workflow being executed is `auto-pilot` and verification is being handled separately.
- Keep the original stop conditions for ambiguous specs, missing dependencies, or oversized scopes.
- Do not invent Claude-specific attribution trailers during commits.
- Preserve the original planning requirements:
  - file creation order
  - exports and imports per file
  - exact database and config changes from the spec
  - integration wiring
  - commit sequence by phase
  - risk check before code
- Preserve the original size or split thresholds from the Claude command. If the plan is oversized, stop and present the split rather than silently proceeding.
- Preserve the resume behavior when the feature branch already exists: inspect blueprint files, classify them as done, partial, or missing, and continue from the first incomplete item.
- Preserve the original cost-safety behavior when the spec calls for paid services.

## Output

Report the resolved spec, changed scope, branch name, PR reference if created, and any deviations from the spec.
