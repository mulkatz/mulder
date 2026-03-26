---
description: "Full automation — architect, implement, verify, iterate until spec is satisfied, then label for human review"
---

# mulder — Ship Pipeline

You orchestrate the full feature lifecycle from idea to implementation-complete. You run the architect workflow, spawn an implementation agent, spawn a verification agent, and iterate until all QA conditions pass or you hit the iteration limit.

**The user's request:** $ARGUMENTS

---

## State Tracking

Track these variables throughout the pipeline. Update them after each phase.

```
SPEC_PATH     = (set in Phase 1)
ISSUE_NUMBER  = (set in Phase 1)
ISSUE_URL     = (set in Phase 1)
BRANCH_NAME   = (set in Phase 2)
PR_URL        = (set in Phase 2)
PR_NUMBER     = (set in Phase 2)
ITERATION     = 0
MAX_ITERATIONS = 3
VERDICT       = pending
FAILURES      = []
```

Create a task list at the start to give the user visibility:

```
1. [ ] Architect: Generate spec + create GitHub issue
2. [ ] Implement: Build feature (iteration 1)
3. [ ] Verify: Run black-box tests
4. [ ] Finalize: Label issue with result
```

---

## Phase 1: Architect (inline)

Run this phase yourself — not as a subagent. You need direct access to tools for file creation and `gh` commands.

### 1.1 Read context

Read these files:
- `CLAUDE.md` — architecture, conventions, pipeline stages
- `docs/specs/` — existing specs for numbering

### 1.2 Classify and generate

Follow the workflow from `.claude/commands/architect.md`:

1. Classify scale (Micro / Standard / Macro)
2. Assign priority (P0-P3)
3. If Standard or Macro: generate the `.spec.md` file in `docs/specs/`
4. If Macro: propose sub-tasks and wait for user approval before continuing

### 1.3 Create GitHub labels (idempotent)

```bash
for label in \
  "pipeline:Pipeline workers and stages:0E8A16" \
  "database:Schema, queries, migrations:1D76DB" \
  "api:API routes and services:D93F0B" \
  "infra:Terraform, GCP, CI/CD:FBCA04" \
  "ai-core:Gemini, extraction, embeddings:5319E7" \
  "config:Config schema and validation:C5DEF5" \
  "ui:Frontend and demo app:BFD4F2" \
  "taxonomy:Entity normalization, resolution:0D8C6F" \
  "retrieval:Hybrid search, RRF, re-ranking:D4C5F9" \
  "evidence:Corroboration, contradictions, scoring:F9D0C4" \
  "P0-critical:Blocks other work or production:B60205" \
  "P1-high:Core capability for current milestone:D93F0B" \
  "P2-medium:Important but not blocking:FBCA04" \
  "P3-low:Backlog, nice-to-have:C2E0C6" \
  "ai-in-progress:Being implemented by AI agents:6F42C1" \
  "ai-done:AI implementation complete, ready for human review:0E8A16" \
  "ai-needs-review:AI hit iteration limit, needs human help:D93F0B"; do
  IFS=: read -r name desc color <<< "$label"
  gh label create "$name" --description "$desc" --color "$color" 2>/dev/null || true
done
```

### 1.4 Create GitHub issue

Create the issue following the architect workflow conventions (title taxonomy, body format, labels). Add the `ai-in-progress` label.

### 1.5 Cross-reference

Update the spec's frontmatter `issue:` field with the issue URL.

### 1.6 Commit the spec

```bash
git add docs/specs/NN_*.spec.md
git commit -m "docs: add spec NN — [short title]

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

### 1.7 Update state and report

```
SPEC_PATH = docs/specs/NN_component_feature.spec.md
ISSUE_NUMBER = (from gh output)
ISSUE_URL = (from gh output)
```

Tell the user:
```
Phase 1 complete: Spec created + issue opened.
Spec: docs/specs/NN_component_feature.spec.md
Issue: #N — <URL>
Starting implementation...
```

Mark the architect task complete. Mark the implement task in-progress.

---

## Phase 2: Implement (subagent)

Increment ITERATION. Spawn an implementation agent:

```
Agent(
  description: "Implement spec NN (iteration {ITERATION})",
  model: "opus",
  prompt: see below
)
```

### Subagent prompt

Construct the prompt based on iteration number:

**Iteration 1:**

```
You are the implementation agent for mulder (mulkatz/mulder).

Read these files in order:
1. `.claude/commands/implement.md` — your workflow instructions
2. `CLAUDE.md` — architecture and code conventions
3. `{SPEC_PATH}` — the specification you must implement

Your task:
- Create branch: feat/GH-{ISSUE_NUMBER}-{kebab-from-spec-title}
- Implement exactly what the spec describes, following CLAUDE.md conventions
- Make atomic commits with semantic messages
- Push the branch
- Create a PR with `gh pr create` referencing issue #{ISSUE_NUMBER}
- Do NOT write tests — a separate verification agent handles that

When done, report these values exactly in this format:
BRANCH_NAME: <the branch name>
PR_URL: <the full PR URL>
PR_NUMBER: <the PR number>
FILES_CHANGED: <comma-separated list of created/modified files>
DEVIATIONS: <any spec deviations, or "none">
```

**Iteration 2+:**

```
You are the implementation agent for mulder (mulkatz/mulder).

Read these files in order:
1. `.claude/commands/implement.md` — your workflow instructions
2. `CLAUDE.md` — architecture and code conventions
3. `{SPEC_PATH}` — the specification you must implement

This is iteration {ITERATION}. The previous implementation failed these QA conditions:

{FAILURES — formatted as a numbered list with condition name, expected, actual, and evidence}

Your task:
- Check out the existing branch: {BRANCH_NAME}
- Pull the latest changes
- Read the existing test file at tests/specs/NN_*.test.ts to understand what's being tested
- Fix ONLY the code that causes the failing conditions — do not rewrite everything
- Run the tests locally to verify your fixes: `npx vitest run tests/specs/NN_*.test.ts`
- Commit fixes with message: "fix: address QA failures — [brief description]"
- Push to the same branch (the PR updates automatically)

When done, report these values exactly in this format:
BRANCH_NAME: {BRANCH_NAME}
PR_URL: {PR_URL}
PR_NUMBER: {PR_NUMBER}
FILES_CHANGED: <comma-separated list of modified files>
FIXES_APPLIED: <what you changed to address each failure>
LOCAL_TEST_RESULT: <pass/fail — from running tests locally>
```

### After subagent returns

Parse the subagent's output for BRANCH_NAME, PR_URL, PR_NUMBER. Update state.

If this was iteration 1, mark implement task complete, mark verify task in-progress.

---

## Phase 3: Verify (subagent)

Spawn a verification agent:

```
Agent(
  description: "Verify spec NN (iteration {ITERATION})",
  model: "opus",
  prompt: see below
)
```

### Subagent prompt

**Iteration 1** (tests don't exist yet):

```
You are the QA verification agent for mulder (mulkatz/mulder).

Read these files in order:
1. `.claude/commands/verify.md` — your workflow instructions
2. `CLAUDE.md` — ONLY the Testing section
3. `{SPEC_PATH}` — ONLY Sections 1, 2, and 5

CRITICAL: Do NOT read any files under src/. Do NOT read Section 4 of the spec. You are black-box only.

Make sure you are on branch {BRANCH_NAME}:
  git checkout {BRANCH_NAME} && git pull

Your task:
- Write black-box tests to tests/specs/NN_spec_name.test.ts
- One `it()` block per QA condition in Section 5
- Tests interact with the system ONLY through: CLI commands, HTTP requests, direct SQL queries, filesystem checks
- Run the tests: `npx vitest run tests/specs/NN_*.test.ts --reporter=verbose`
- Commit the test file: "test: add black-box QA tests for spec NN"
- Push to the same branch

When done, report in this exact format:
TOTAL: <number of conditions>
PASSED: <count>
FAILED: <count>
SKIPPED: <count>
VERDICT: PASS | FAIL | PARTIAL

For each failure, include:
FAILURE: <condition name>
EXPECTED: <what should happen>
ACTUAL: <what happened>
EVIDENCE: <proof>
```

**Iteration 2+** (tests already exist):

```
You are the QA verification agent for mulder (mulkatz/mulder).

Read these files in order:
1. `.claude/commands/verify.md` — your workflow instructions
2. `CLAUDE.md` — ONLY the Testing section

Make sure you are on branch {BRANCH_NAME}:
  git checkout {BRANCH_NAME} && git pull

The implementation was updated to fix previous failures. The test file already exists at tests/specs/NN_*.test.ts.

CRITICAL: Do NOT read any files under src/. You are black-box only.

Your task:
- Re-run the existing tests: `npx vitest run tests/specs/NN_*.test.ts --reporter=verbose`
- Do NOT modify the tests unless a test itself had a bug (not an implementation issue)
- Report the results

When done, report in this exact format:
TOTAL: <number of conditions>
PASSED: <count>
FAILED: <count>
SKIPPED: <count>
VERDICT: PASS | FAIL | PARTIAL

For each failure, include:
FAILURE: <condition name>
EXPECTED: <what should happen>
ACTUAL: <what happened>
EVIDENCE: <proof>
```

### After subagent returns

Parse the verify output for VERDICT and any FAILURE blocks.

If VERDICT is PASS:
```
VERDICT = pass
FAILURES = []
```
Go to Phase 5.

If VERDICT is FAIL and ITERATION < MAX_ITERATIONS:
```
FAILURES = [parsed failure details]
```
Tell the user: `Iteration {ITERATION}: {FAILED_COUNT} conditions failed. Starting fix cycle...`
Go to Phase 2 (next iteration).

If VERDICT is FAIL and ITERATION >= MAX_ITERATIONS:
```
VERDICT = needs-review
FAILURES = [parsed failure details]
```
Go to Phase 5.

If VERDICT is PARTIAL (some skipped due to infra):
Treat passed conditions as pass, failed as fail. Skipped conditions don't count against the verdict. If all non-skipped conditions pass, VERDICT = pass.

---

## Phase 4: Iterate

This is not a separate phase — it's the loop between Phase 2 and Phase 3.

```
while VERDICT != pass AND ITERATION < MAX_ITERATIONS:
    ITERATION++
    run Phase 2 (implement with failure context)
    run Phase 3 (verify — re-run tests)
```

Update the task list on each iteration:
- Rename or add tasks to reflect the current iteration
- Keep the user informed of progress

---

## Phase 5: Finalize

### On PASS

```bash
# Label the issue
gh issue edit {ISSUE_NUMBER} --remove-label "ai-in-progress"
gh issue edit {ISSUE_NUMBER} --add-label "ai-done"

# Comment on the PR
gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
## AI Verification Complete

All QA conditions from the spec pass. Ready for human review.

- Spec: `{SPEC_PATH}`
- Iterations: {ITERATION}
- QA: {PASSED}/{TOTAL} conditions met ({SKIPPED} skipped due to infrastructure)

Please review the implementation and tests, then merge when satisfied.
EOF
)"
```

### On NEEDS-REVIEW (max iterations)

```bash
# Label the issue
gh issue edit {ISSUE_NUMBER} --remove-label "ai-in-progress"
gh issue edit {ISSUE_NUMBER} --add-label "ai-needs-review"

# Comment on the PR with failure details
gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
## AI Verification Incomplete

Reached maximum iterations ({MAX_ITERATIONS}). Some QA conditions still failing.

- Spec: `{SPEC_PATH}`
- QA: {PASSED}/{TOTAL} conditions met
- Remaining failures:

{FAILURES — formatted as markdown list}

Manual intervention needed for the remaining conditions.
EOF
)"
```

### Final report to user

```
Ship complete.

  Spec:       {SPEC_PATH}
  Issue:      #{ISSUE_NUMBER} — {ISSUE_URL}
  PR:         #{PR_NUMBER} — {PR_URL}
  Branch:     {BRANCH_NAME}
  QA:         {PASSED}/{TOTAL} passed ({SKIPPED} skipped)
  Iterations: {ITERATION}
  Status:     ai-done | ai-needs-review

{If ai-done: "All QA conditions pass. Review the PR and merge when ready."}
{If ai-needs-review: "Remaining failures listed in the PR comment. Review needed."}
```

Mark all tasks complete.

---

## Macro Handling

If the architect classifies the request as Macro:

1. Complete Phase 1 (architect) — create umbrella issue + all sub-task specs + issues
2. For each sub-task in dependency order:
   - Run Phase 2 (implement) for this sub-task's spec
   - Run Phase 3 (verify) for this sub-task's spec
   - Iterate if needed (Phase 4)
   - On pass: close the sub-task issue, move to next
   - On needs-review: stop the pipeline, label umbrella as ai-needs-review
3. When all sub-tasks pass: label umbrella issue as ai-done

Track each sub-task's state independently. Report progress to the user between sub-tasks.

---

## Error Handling

**Agent fails to produce parseable output:** Re-read the agent's response carefully. Extract what you can. If the agent clearly failed (no code written, no PR created), tell the user and stop.

**`gh` commands fail:** Check auth status with `gh auth status`. Report the error to the user.

**Merge conflicts on push:** Tell the user — this likely means someone else pushed to the branch. Don't force-push.

**All dependencies unmet (greenfield):** If the implement agent reports that fundamental infrastructure is missing (no `src/`, no `package.json`), tell the user: "This spec depends on infrastructure that doesn't exist yet. Consider starting with an earlier roadmap phase."

**Spec is ambiguous or incomplete:** If the implement agent reports spec gaps, pause and ask the user whether to proceed with reasonable assumptions or update the spec first.
