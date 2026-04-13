# Workflow Invariants

## General

- Preserve public entrypoints: `$auto-pilot`, `$architect`, `$implement`, `$verify`, `$review`, `$milestone-review`.
- Keep user-facing summaries compact and operational.
- Prefer fresh context reconstruction from repository files over inherited chat context.
- Only ask the user when a real blocking fork changes scope, cost, or architecture.

## Branch And PR Traceability

- Specs, issues, branches, and PRs must stay traceable to the roadmap step being delivered.
- Never create generic helper branches such as `codex/...` for Mulder delivery work.
- Roadmap and spec implementation branches should use `feat/{issue-number}-{short-kebab-descriptor}` when an issue exists.
- If no issue exists for a spec-driven implementation, use `feat/spec-{NN}-{short-kebab-descriptor}` only as a fallback.
- Non-feature follow-up work should use a typed branch prefix that matches the work when a new branch is actually needed: `fix/`, `refactor/`, `chore/`, or `docs/`.
- Implementation should not advance roadmap completion after coding alone; that happens only after the workflow gates pass.

## Naming Conventions

- Commit subjects must use professional conventional prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, or `test:`.
- Use `feat:` for main spec delivery phases.
- Use `fix:` for QA or review remediation, regressions, or bug fixes.
- Use `test:` for black-box QA test additions or targeted test-only corrections.
- Use `refactor:`, `chore:`, and `docs:` only when the work truly matches those categories.
- Commit summaries should be concise, imperative, and specific to the delivered phase.
- Issue titles created by architect or auto-pilot should follow the Mulder scheme: `[Domain] Observable system change — {TARGET_STEP}`.
- PR titles should stay domain-specific and traceable to the issue and spec; do not use generic agent-produced titles.

## Implement Worker Defaults

- Build only what the spec describes.
- Study adjacent implementation patterns before coding.
- Do not write spec tests unless the caller explicitly asks for that behavior.
- Stop on blocking ambiguities, unmet dependencies, or oversized scope that should be split.

## Verify Worker Defaults

- Verification is black-box by default.
- Do not read implementation internals under `packages/`, `src/`, or `apps/` unless a narrow exception is explicitly granted by the worker contract.
- Regressions in pre-existing spec tests count against the verdict.
- `PARTIAL` is treated as pass only when every non-skipped condition passes.

## Review Worker Defaults

- Findings first, ordered by severity.
- Report only real defects: bugs, regressions, architectural drift, integration mistakes, or spec violations.
- Use `blocking` and `warning` as the issue severities.
- Keep style-only commentary out of blocking findings.

## Malformed Output Recovery

- If a worker returns useful work but the output schema is malformed, ask once for a restatement in the exact required contract format.
- Do not guess missing fields after a failed restatement.
- If the second response is still malformed, stop and surface a blocked state with the raw deficiency.
