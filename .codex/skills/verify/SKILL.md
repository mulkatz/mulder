---
name: verify
description: "Run Mulder black-box verification in Codex. Use this when the user wants the old Claude `/verify` workflow: derive QA checks from a spec, write black-box tests without reading implementation internals, run them, and report clear failures with evidence."
---

# Verify

Use this skill for Mulder QA verification against a spec.

## Source Of Truth

Read `.claude/commands/verify.md` before acting. Treat it as the authoritative QA workflow and adapt only the tool mechanics to Codex.

Do not modify `.claude/commands/verify.md`.

## Workflow

1. Resolve the target spec exactly as the Claude command describes.
2. Read only the allowed sections of the spec and `CLAUDE.md`.
3. Respect the black-box boundary. Do not read implementation files under `packages/`, `src/`, or `apps/` unless the original workflow explicitly allows a narrow exception.
4. Check test infrastructure first, but still write the tests even when infrastructure is partially unavailable.
5. Write or rerun the spec tests in `tests/specs/`.
6. Generate CLI smoke coverage when the spec's CLI matrix is not `N/A`.
7. Run both the targeted spec tests and the full test suite when the original workflow calls for it.
8. Distinguish implementation failures, skipped infrastructure-dependent checks, regressions, and test bugs.

## Codex Adaptation Rules

- Keep the QA contract, CLI matrix handling, and smoke-test behavior from the Claude command.
- Assume this skill may run in a fresh sub-agent. Build context only from the allowed spec sections, the allowed `CLAUDE.md` sections, the branch under test, and any narrow mismatch note from the coordinator.
- If invoked from `auto-pilot`, treat implementation failure evidence and any `TEST_MISMATCH` note as inputs to evaluate, not as extra permission to read implementation internals.
- Report evidence in a way that an implementation agent can act on directly.
- If a test is wrong relative to the spec, fix the test and state the mismatch explicitly instead of forcing the implementation to match a bad assertion.
- Preserve the verdict structure from the Claude workflow:
  - totals
  - passed, failed, skipped
  - `PASS | FAIL | PARTIAL`
  - one evidence block per failing condition
- Preserve the rule that previous spec regressions count as failures against the verdict.

## Output

Return the verdict in a compact parseable form:

```text
TOTAL: <number of conditions>
PASSED: <count>
FAILED: <count>
SKIPPED: <count>
VERDICT: PASS | FAIL | PARTIAL
```

For each failure, include:

```text
FAILURE: <condition name>
EXPECTED: <what should happen>
ACTUAL: <what happened>
EVIDENCE: <proof>
```

If you correct a bad test assertion, also report:

```text
TEST_FIX: <what assertion changed and why>
```
