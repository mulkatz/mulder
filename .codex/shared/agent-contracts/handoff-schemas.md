# Handoff Schemas

Use these exact field sets when a coordinator or launcher skill spawns a fresh worker.

## Implement Input

Required:

```text
SPEC_PATH
SPEC_NUMBER
ITERATION
```

Optional:

```text
TARGET_STEP
ISSUE_NUMBER
ISSUE_URL
BRANCH_NAME
FAILURES
```

`TARGET_STEP` is present for roadmap-backed work and may be empty for valid off-roadmap specs.
`ISSUE_NUMBER` and `ISSUE_URL` should be included when the resolved spec or launcher context can supply them, but must not be invented for legacy specs that lack issue metadata.
`FAILURES` is used only for retry iterations. Keep it limited to the concrete failure evidence needed for the next fix cycle.

## Verify Input

Required:

```text
SPEC_PATH
SPEC_NUMBER
BRANCH_NAME
ITERATION
```

Optional:

```text
TARGET_STEP
TEST_MISMATCH
```

`TARGET_STEP` is present for roadmap-backed work and may be empty for valid off-roadmap specs.
`TEST_MISMATCH` is evaluation input, not permission to inspect implementation internals.

## Review Input

Required:

```text
SPEC_PATH
SPEC_NUMBER
BRANCH_NAME
```

Optional:

```text
TARGET_STEP
PR_NUMBER
PR_URL
```

`TARGET_STEP` is present when the reviewed change maps cleanly to a roadmap step and may be empty for valid off-roadmap specs.
Provide `PR_NUMBER` or `PR_URL` when available so the reviewer can prefer the PR diff over a local branch diff.
