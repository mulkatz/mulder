# Architect Workflow

## Context Read Order

1. `CLAUDE.md`
2. `docs/roadmap.md`
3. Existing `docs/specs/*.spec.md` files for numbering and dependency awareness

## Step Selection

- Resolve the target with the shared target rules.
- Apply the dependency gate before proceeding:
  - Prior steps in the same milestone must be complete before auto-picking a later step.
  - If an explicit target depends on incomplete earlier work, warn before proceeding.
  - Cross-milestone dependencies matter only when the roadmap step calls them out.

Record:

```text
TARGET_STEP: <step>
MILESTONE: <milestone>
STEP_TITLE: <roadmap title>
```

## Functional Spec Reading

- Extract `§` references from the roadmap step's spec column.
- Read only those sections from `docs/functional-spec.md`.
- Also read the milestone-wide "Also read" cross-references from `docs/roadmap.md`.
- Do not broaden the read scope unless a blocking inconsistency forces it.

Use header searches like `^#{2,4}\s*4\.1\b` to locate sections and stop at the next header of equal or higher level.

## Scope Classification

- `single`: up to 8 files and 1-2 concerns
- `phased`: 8-20 files or 2-3 concerns
- `multi-spec`: more than 20 files, more than 3 distinct concerns, or grouped work that should split

For grouped roadmap steps, default to one spec per sub-step unless tight shared types or schemas make that impractical.

If the result is `multi-spec`, stop and present the proposed split for approval before generating files.

## Spec Generation

Create `docs/specs/NN_snake_case_title.spec.md` with this structure:

```markdown
---
spec: NN
title: "[Observable System Change]"
roadmap_step: "[M1-A2]"
functional_spec: "[§4.1, §13]"
scope: "[single | phased | multi-spec]"
issue: ""
created: YYYY-MM-DD
---

# Spec NN: [Same Title]

## 1. Objective
## 2. Boundaries
## 3. Dependencies
## 4. Blueprint
## 5. QA Contract
## 5b. CLI Test Matrix
## 6. Cost Considerations
```

Requirements:

- `Objective` explains what is being built, why it matters, and the exact functional-spec requirements being fulfilled.
- `Boundaries` names roadmap step, target files, in-scope work, out-of-scope work, and architectural constraints.
- `Dependencies` lists required prior specs or steps and what this spec blocks.
- `Blueprint` includes ordered files, database changes, config changes, integration points, and implementation phases when needed.
- `QA Contract` must be black-box verifiable and concrete.
- `CLI Test Matrix` is required only when the step adds or changes CLI commands. Otherwise say `N/A — no CLI commands in this step.`
- `Cost Considerations` is required when the step touches paid services or cost-sensitive execution.

## Issue And Project Metadata

Create or update the linked GitHub issue so it is self-contained:

- title format: `[Domain] Observable system change — {TARGET_STEP}`
- concise objective summary
- spec path and roadmap step
- QA conditions as acceptance checklist
- expected branch reference using `feat/{issue-number}-{short-kebab-descriptor}`

Preserve the repository's label and project-board conventions when they exist:

- labels for domain and type
- board fields for status, phase, priority, step, and spec path

After creating the issue, write its URL back into the spec frontmatter.

## Roadmap State

- Move the target roadmap step to in-progress when the workflow is meant to advance state.
- Do not mark the step complete here.

## Final Report

Return:

```text
TARGET_STEP: <step>
SCOPE: <single | phased | multi-spec>
SPEC_PATH: <path>
ISSUE: <issue number or URL>
```
