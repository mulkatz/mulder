---
name: review
description: "Perform the Mulder architect review gate in Codex. Use this when the user wants the old Claude `/review` workflow: compare the PR or branch against the spec, architecture rules, and relevant functional-spec sections, then approve or request changes."
---

# Review

Use this skill for Mulder's final architect-level implementation review.

## Source Of Truth

Read `.claude/commands/review.md` before acting. Use it as the review contract while keeping Codex's review-reporting style.

Do not modify `.claude/commands/review.md`.

## Workflow

1. Resolve the target PR, branch, or spec.
2. Read `CLAUDE.md`, the spec, and the PR diff in the order defined by the Claude command.
3. Read functional-spec sections only when something in the diff or spec looks questionable.
4. Review for blocking issues first: spec compliance, architectural alignment, integration correctness, and material edge cases.
5. Keep non-blocking observations separate from real defects.
6. If running as a standalone review and the user wants merge behavior, follow the original workflow's post-review actions rather than inventing a new close-out path.

## Codex Adaptation Rules

- Follow the repository's review expectations: findings first, ordered by severity, with file and line references.
- Focus on real bugs, regressions, architectural drift, or missing integration.
- Do not turn the review into a style pass.
- Preserve the Claude workflow's selective-depth rule: start with spec and diff, then read functional spec only when needed.
- Preserve the original approval vocabulary: `APPROVED` or `CHANGES_REQUESTED`.

## Output

Return `APPROVED` or `CHANGES_REQUESTED`, with blocking findings first.
