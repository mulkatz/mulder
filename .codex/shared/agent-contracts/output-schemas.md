# Output Schemas

Workers must return compact, parseable summaries with these exact field names.

## Implement Output

```text
BRANCH_NAME: <branch>
PR_URL: <full URL or empty>
PR_NUMBER: <number or empty>
FILES_CHANGED: <comma-separated list>
DEVIATIONS: <spec deviations or "none">
```

Optional on retries:

```text
TEST_MISMATCH: <test file:line> asserts <X>, but spec says <Y>
```

## Verify Output

```text
TOTAL: <number>
PASSED: <count>
FAILED: <count>
SKIPPED: <count>
VERDICT: PASS | FAIL | PARTIAL
```

For each failing condition:

```text
FAILURE: <condition name>
EXPECTED: <what should happen>
ACTUAL: <what happened>
EVIDENCE: <proof>
```

Optional when correcting a bad assertion:

```text
TEST_FIX: <what assertion changed and why>
```

## Review Output

```text
REVIEW_VERDICT: APPROVED | CHANGES_REQUESTED
```

When changes are requested, emit one block per issue:

```text
ISSUE: <short title>
SEVERITY: blocking | warning
FILE: <path:line>
PROBLEM: <what's wrong>
FIX: <specific fix needed>
SPEC_REF: <violated spec section or CLAUDE.md rule>
```
