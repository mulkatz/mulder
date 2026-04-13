# Target Resolution

## Architect

- If the user provides a roadmap step ID, use it directly.
- If the user provides multiple grouped step IDs, treat them as one scoped work item and assess whether the split should become multi-spec.
- If the user provides a description, map it to the closest roadmap step.
- If the user provides nothing, auto-pick the first eligible incomplete step from the first milestone that still has open work.
- Apply the milestone dependency gate before proceeding.

## Implement And Verify

Resolve in this order:

1. Spec number or zero-padded number
2. Spec filename
3. Full spec path
4. Roadmap step via `roadmap_step` frontmatter match
5. GitHub issue by extracting the spec path from the issue body
6. Most recent in-progress roadmap step when no argument is supplied

If no spec can be resolved, stop and report the missing target explicitly.

After resolving the spec:

- read `roadmap_step` from spec frontmatter when present; treat it as optional metadata rather than a guaranteed field
- read `issue` from spec frontmatter when present
- derive `ISSUE_NUMBER` from the issue URL when possible
- if either field is missing, preserve that absence in the handoff instead of inventing values

## Review

Resolve in this order:

1. PR number
2. Spec number
3. Branch name
4. Most recent open PR, or the most recent in-progress roadmap step branch when no argument is supplied

Prefer the PR diff when a PR exists. Fall back to `git diff main...{branch}` when working from branch context.

After resolving the review target:

- read `roadmap_step` from the spec when present; treat it as optional metadata rather than a guaranteed field
- preserve missing roadmap metadata for off-roadmap specs instead of inventing a step identifier

## Milestone Review

- If a milestone ID is provided, use it directly.
- If a step ID is provided, infer the milestone from its prefix.
- If nothing is provided, use the latest milestone whose steps are all complete.
- If the milestone is not fully complete, warn and continue only as a partial review.
