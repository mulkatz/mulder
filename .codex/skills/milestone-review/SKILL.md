---
name: milestone-review
description: "Run Mulder's exhaustive milestone divergence review in Codex. Use this when the user wants the old Claude `/milestone-review` workflow: compare a completed milestone section by section against the functional spec and write the review report under docs/reviews."
---

# Milestone Review

Use this skill after a Mulder milestone is complete or nearly complete and needs a spec-versus-implementation audit.

## Source Of Truth

Read `.claude/commands/milestone-review.md` before acting. Treat it as the review procedure to preserve.

Do not modify `.claude/commands/milestone-review.md`.

## Workflow

1. Resolve the milestone from the user's request or from the latest completed milestone.
2. Build the section map from `docs/roadmap.md` and the functional-spec references.
3. Group the work into review batches as the original command describes.
4. Read `CLAUDE.md`, the required functional-spec sections, and the actual implementation files for each batch.
5. Record divergences with section references, severity, and concrete evidence.
6. Write the report to `docs/reviews/{milestone-id}-review.md`.

## Codex Adaptation Rules

- Keep the functional spec as the source of truth even when the implementation seems reasonable.
- Be exhaustive within the milestone scope, but do not drift into unrelated areas.
- Preserve the original report shape so the output remains comparable to prior Claude-generated reviews.

## Output

Report the review file path, verdict, and the most important divergences.
