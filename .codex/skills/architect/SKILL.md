---
name: architect
description: "Generate Mulder implementation specs from roadmap steps in Codex. Use this when the user wants the old Claude `/architect` workflow: pick a roadmap step, read the referenced functional-spec sections, assess scope, and create the implementation spec and issue."
---

# Architect

Use this skill for roadmap-driven specification work in Mulder.

## Source Of Truth

Read `.claude/commands/architect.md` before acting. Use it as the behavior contract while adapting tool usage to Codex.

Do not modify `.claude/commands/architect.md`.

## Workflow

1. Read `CLAUDE.md`, `docs/roadmap.md`, and existing `docs/specs/*.spec.md` numbering context as directed by the Claude command.
2. Resolve the target roadmap step from the user's request or auto-pick the next eligible step.
3. Read only the functional spec sections and milestone cross-references required by that step.
4. Assess scope using the same single, phased, and multi-spec rules as the original workflow.
5. Create the new spec file in `docs/specs/` using the same template structure as the Claude workflow:
   - frontmatter with `spec`, `title`, `roadmap_step`, `functional_spec`, `scope`, `issue`, and `created`
   - sections for Objective, Boundaries, Dependencies, Blueprint, QA Contract, CLI Test Matrix when applicable, and Cost Considerations when applicable
6. Create or update the linked GitHub issue and any project-board metadata expected by the workflow.
7. Move roadmap state forward when the workflow says to do so.

## Codex Adaptation Rules

- Use Codex planning and direct shell/tool access instead of Claude-specific plan-mode language.
- Keep the original step-picking and dependency-gate behavior.
- Stop for user approval on multi-spec splits just like the original command.
- Maintain exact traceability between roadmap step, functional-spec sections, spec file, and issue.
- Ask at most one targeted question, and only for a real blocking fork that materially changes scope or architecture.
- Read only the functional-spec sections referenced by the roadmap step plus milestone cross-references. Do not broaden the read scope casually.
- Preserve the original GitHub issue and project-board intent: labels for categorization, board fields for status or phase if configured in the repo workflow.

## Output

Report the selected step, scope classification, spec path, and issue reference.
