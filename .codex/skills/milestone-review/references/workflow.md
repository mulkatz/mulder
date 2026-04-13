# Milestone Review Workflow

## Resolve The Milestone

- Use the shared target rules to resolve the milestone.
- If any milestone steps are still incomplete, warn and proceed only as a partial review.

The functional spec remains the source of truth even when the implementation seems more reasonable.

Record:

```text
MILESTONE_ID
MILESTONE_TITLE
STEPS
STEP_COUNT
```

## Build The Section Map

- Read `docs/roadmap.md`.
- Extract every functional-spec `§` reference from the milestone's steps.
- Add the milestone-wide "Also read" references.
- Deduplicate the final section list.
- Map each section to a line range in `docs/functional-spec.md` by locating the header and the next header of equal or higher level.

Record the results explicitly so the review can reference them later:

```text
SECTIONS_FROM_STEPS
CROSS_REFERENCES
ALL_SECTIONS
```

## Build Review Batches

- Group the sections into 3-5 related review batches.
- Keep each batch small enough to review inline with context intact.
- Batch by shared implementation scope rather than by arbitrary section number.

Prefer batches like:

- config + CLI
- database + migrations
- shared services + infrastructure
- repo structure + cross-cutting conventions

## Review Execution

Read `CLAUDE.md` once before running the batches.

For each batch:

1. Read the relevant functional-spec sections.
2. Read the actual implementation files in scope.
3. Compare the implementation against the spec and repository conventions.
4. Record divergences with:
   - section reference
   - severity: `CRITICAL`, `WARNING`, or `NOTE`
   - what the spec says
   - what the code does
   - concrete evidence

Run the review inline. Do not split the milestone review across workers.

Use systematic per-section checks where relevant:

- types and signatures
- DDL and indexes
- config keys and defaults
- CLI flags and usage
- error codes and failure behavior
- architecture pattern compliance

## Cross-Cutting Checks

After the section-by-section review, perform a cross-cutting pass for:

- naming conventions
- TypeScript strictness
- architecture patterns from `CLAUDE.md`
- package structure and workspace references
- existence and black-box nature of spec tests where relevant

Also compare `CLAUDE.md` against the reviewed implementation and functional-spec sections:

- repo structure accuracy
- architecture pattern accuracy
- contradictions or drift

## Report

Write `docs/reviews/{milestone-id}-review.md` with:

- frontmatter for milestone, title, reviewed date, steps reviewed, spec sections, and verdict
- severity counts
- per-section divergences
- cross-cutting review notes
- overall verdict: `PASS`, `PASS_WITH_WARNINGS`, or `NEEDS_ATTENTION`

Recommended report shape:

- frontmatter
- summary with severity counts
- per-section divergences
- cross-cutting convention review
- `CLAUDE.md` consistency section
- recommendations grouped into must-fix, should-fix, and for-consideration

When this workflow persists a review report, use a professional `docs:` commit prefix.

Milestone review does not use retry loops or sub-workers. Keep the evaluation inline so cross-section context stays intact across the whole milestone.

## Final Output

Return:

```text
REVIEW_PATH: <path>
VERDICT: <verdict>
HIGHLIGHTS: <top divergences>
```
