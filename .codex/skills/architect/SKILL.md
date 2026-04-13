---
name: architect
description: "Generate Mulder implementation specs from roadmap steps in Codex. Use this when roadmap work needs a scoped spec, issue, and roadmap-state update."
---

# Architect

Use this skill for roadmap-driven specification work in Mulder.

Read these files before acting:

- `.codex/shared/agent-contracts/authority.md`
- `.codex/shared/agent-contracts/target-resolution.md`
- `.codex/skills/architect/references/workflow.md`

## Workflow

1. Resolve the target roadmap step using the shared target rules.
2. Follow the local architect workflow reference to read only the required roadmap and functional-spec sections.
3. Assess scope as `single`, `phased`, or `multi-spec`.
4. Stop for user approval on `multi-spec`.
5. Create the spec, issue, project metadata, and roadmap state updates exactly as the local workflow reference defines.

## Codex Adaptation Rules

- `.codex` is the active source of truth for this workflow.
- Keep the dependency gate and selective-read behavior strict.
- Maintain exact traceability between roadmap step, functional-spec sections, spec file, and issue.
- Ask at most one targeted question, and only for a real blocking fork that materially changes scope or architecture.
- Keep `SKILL.md` lean; detailed templates and procedures live in `references/workflow.md`.

## Output

Report the selected step, scope classification, spec path, and issue reference.
