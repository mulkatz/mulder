---
description: "Full lifecycle — picks roadmap step, architects spec, implements, verifies, iterates until QA passes"
---

# Mulder — Auto-Pilot

You orchestrate the full feature lifecycle: pick a roadmap step → architect a spec → implement the code → verify with black-box tests → iterate until all QA conditions pass or you hit the iteration limit. At the end, the roadmap is updated and the issue is labeled for human review.

**Scope:** Auto-pilot handles **roadmap steps only** — it always creates a spec. For micro tasks (bug fixes, small refactors without spec), use `/implement` + `/verify` directly instead.

**The user's request:** $ARGUMENTS

---

## State Tracking

Track these variables throughout the pipeline. Update them after each phase.

```
TARGET_STEP    = (set in Phase 1)
MILESTONE      = (set in Phase 1)
SCOPE          = (set in Phase 1: single | phased | multi-spec)
SPEC_PATH      = (set in Phase 1)
SPEC_NUMBER    = (set in Phase 1)
ISSUE_NUMBER   = (set in Phase 1)
ISSUE_URL      = (set in Phase 1)
BRANCH_NAME    = (set in Phase 2)
PR_URL         = (set in Phase 2)
PR_NUMBER      = (set in Phase 2)
ITERATION      = 0
MAX_ITERATIONS = 3
VERDICT        = pending
FAILURES       = []
```

Create a task list at the start:

```
1. [ ] Pre-flight: clean state + pick roadmap step
2. [ ] Architect: read spec sections, generate spec, create issue
3. [ ] Implement: plan + build (iteration 1)
4. [ ] Verify: write + run black-box tests
5. [ ] Finalize: labels + roadmap update
```

---

## Phase 0: Pre-Flight

Verify the environment is ready:

```bash
# Clean working tree?
git status --porcelain

# On main?
git branch --show-current

# GitHub CLI authenticated?
gh auth status 2>&1 | head -3
```

**Gate conditions:**
- **Dirty working tree:** "There are uncommitted changes. Commit or stash before running auto-pilot."
- **Not on main:** "Currently on branch {X}. Auto-pilot needs to start from main to create a clean branch. Switch to main?"
- **gh not authenticated:** "GitHub CLI not authenticated. Run `gh auth login` first."

If all gates pass:
```bash
git pull origin main
```

Mark pre-flight task complete.

---

## Phase 1: Architect (Inline)

Run this phase yourself — you need direct tool access for file creation and `gh` commands.

### 1.1 Read context + pick step

1. Read `CLAUDE.md` (loaded automatically)
2. Read `docs/roadmap.md`
3. List `docs/specs/*.spec.md` for numbering

**Determine target step:**
- If user provided a step ID or description: use that
- If no arguments: auto-pick the next ⚪ step (first milestone with ⚪ → first ⚪ step in that milestone)
- Verify prior steps in the milestone are 🟢 (dependency gate)

### 1.2 Read functional spec sections

From the roadmap step's **Spec** column, extract `§` references.

**Read each section:**
1. Grep for the section header: `^#{2,4}\s*{number}\b` in `docs/functional-spec.md`
2. Read from that line with appropriate limit

Also read the milestone's "Also read" cross-references.

### 1.3 Scope assessment

Analyze the step and classify scope:
- **Single** (≤8 files, 1-2 concerns): 1 spec
- **Phased** (8-20 files, 2-3 concerns): 1 spec with implementation phases
- **Multi-spec** (>20 files, >3 concerns): multiple specs — **stop and present the split for user approval**

### 1.4 Generate spec

Create `docs/specs/NN_title.spec.md` following the template from the architect workflow:
- Frontmatter: spec number, title, roadmap_step, functional_spec sections, scope, created
- Sections: Objective, Boundaries, Dependencies, Blueprint (files, DB, config, integration, phases), QA Contract

### 1.5 Create GitHub labels + issue

**Labels (idempotent — safe to run every time):**

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
  "ai-done:AI complete, ready for human review:0E8A16" \
  "ai-needs-review:AI hit iteration limit, needs human help:D93F0B"; do
  IFS=: read -r name desc color <<< "$label"
  gh label create "$name" --description "$desc" --color "$color" 2>/dev/null || true
done
```

**Create the issue** with the `ai-in-progress` label. Follow the architect conventions for title format and body structure. After creation, update the issue body with the actual issue number and update the spec's `issue:` frontmatter.

**Add to GitHub Project** (same as architect workflow):

```bash
PROJECT_NUM=$(gh project list --owner mulkatz --format json --jq '.projects[] | select(.title=="Mulder Roadmap") | .number' 2>/dev/null)
if [ -z "$PROJECT_NUM" ]; then
  PROJECT_NUM=$(gh project create --owner mulkatz --title "Mulder Roadmap" --format json --jq '.number')
fi
gh project item-add "$PROJECT_NUM" --owner mulkatz --url "{ISSUE_URL}"
```

### 1.6 Update roadmap + commit

Change the step's status from ⚪ to 🟡 in `docs/roadmap.md`.

```bash
git add docs/specs/NN_*.spec.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: add spec NN — [short title] (TARGET_STEP)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

### 1.7 Update state + report

```
TARGET_STEP  = M1-A2
MILESTONE    = M1
SCOPE        = single
SPEC_PATH    = docs/specs/02_config_loader.spec.md
SPEC_NUMBER  = 02
ISSUE_NUMBER = 42
ISSUE_URL    = https://github.com/mulkatz/mulder/issues/42
```

Tell the user:
```
Phase 1 complete: Spec + issue created.
Spec:  docs/specs/02_config_loader.spec.md
Step:  M1-A2 — Config loader + Zod schemas
Issue: #42 — <URL>
Starting implementation...
```

Mark architect task complete. Mark implement task in-progress.

---

## Phase 2: Implement (Subagent)

Increment ITERATION. Spawn an implementation subagent with `model: "opus"`.

### Iteration 1 subagent prompt:

```
You are the implementation agent for mulder (mulkatz/mulder).

Read these files in this exact order:
1. `CLAUDE.md` — architecture, conventions, repo structure, key patterns
2. `{SPEC_PATH}` — the specification you must implement (all sections)
3. `docs/roadmap.md` — find step {TARGET_STEP}, note the milestone and its "Also read" sections
4. The functional spec sections listed in the spec's `functional_spec:` frontmatter — use Grep to find headers (pattern: `^#{2,4}\s*{number}\b`) in `docs/functional-spec.md`, then Read with offset
5. The milestone's "Also read" cross-reference sections from the roadmap

CRITICAL WORKFLOW — follow this exact sequence:

**Step 1: Study existing patterns.**
Find a file in the codebase structurally similar to what you're building. If building a pipeline step, read an existing pipeline step. If building config schemas, read existing Zod schemas. If nothing exists yet (greenfield), note this — you're establishing the pattern.

**Step 2: Plan in plan mode.**
Use the EnterPlanMode tool. Produce a full execution plan:
- File creation order (types first, logic second, integration last)
- For each file: path, exports, imports, which spec section it fulfills, which existing file it mirrors
- Database migrations: exact DDL from spec
- Config changes: YAML + Zod schema additions
- Integration wiring: where new code plugs into existing systems
- Commit sequence: one commit per logical phase
- Risk check: conflicts, missing deps, ambiguities

If the plan exceeds 15 files or 500 lines, propose splitting and ask. If risks are blocking, stop and report.

Exit plan mode with ExitPlanMode when the plan is solid.

**Step 3: Implement.**
Execute the plan phase by phase. Follow CLAUDE.md conventions strictly:
- TypeScript strict mode, ESM only
- Zod for all validation, custom Error classes with codes
- Pino structured logging, no console.log
- Service interfaces only, never direct GCP SDK calls
- Config via loader, prompts via templates
- Pipeline steps: idempotent with ON CONFLICT DO UPDATE
- Files: kebab-case.ts | Types: PascalCase | Functions: camelCase

**Step 3b: Build verification.**
Before committing, run:
- `pnpm turbo run build --filter='...[HEAD]' 2>&1 || npx tsc --noEmit` — fix any type errors
- `npx biome check .` — fix any lint/format issues (`npx biome check --write .` for auto-fix)
Do not proceed to Step 4 if either check fails.

**Step 4: Branch, commit, push, PR.**
- Create branch: feat/GH-{ISSUE_NUMBER}-{kebab-from-spec-title}
- Atomic commits per phase with semantic messages
- Include `Co-Authored-By: Claude <noreply@anthropic.com>` in every commit
- Push: git push -u origin {branch}
- Create PR: gh pr create --title "[Domain] Title" referencing issue #{ISSUE_NUMBER}
- Do NOT write tests — a separate verification agent handles that

**Report these values exactly:**
BRANCH_NAME: <branch>
PR_URL: <full URL>
PR_NUMBER: <number>
FILES_CHANGED: <comma-separated list>
DEVIATIONS: <any spec deviations, or "none">
```

### Iteration 2+ subagent prompt:

```
You are the implementation agent for mulder (mulkatz/mulder).

Read these files in order:
1. `CLAUDE.md` — conventions and patterns
2. `{SPEC_PATH}` — the specification
3. The test file at tests/specs/{SPEC_NUMBER}_*.test.ts — understand what's being asserted

This is iteration {ITERATION}. The previous implementation failed these QA conditions:

{FAILURES — formatted as numbered list:
1. **[Condition name]**
   - Expected: [from spec]
   - Actual: [what happened]
   - Evidence: [proof]}

WORKFLOW:
1. Check out branch: git checkout {BRANCH_NAME} && git pull
2. Read each failure carefully — understand WHY it failed, not just WHAT
3. Read the test file to understand exact assertions
4. Enter plan mode (EnterPlanMode): plan minimal fixes for each failure
5. Exit plan mode: apply fixes
6. Run tests locally: npx vitest run tests/specs/{SPEC_NUMBER}_*.test.ts --reporter=verbose
6b. Build verification: run `npx tsc --noEmit` and `npx biome check .` — fix any issues before committing
7. Commit: "fix: address QA failures — [brief description]" with Co-Authored-By trailer
8. Push to the same branch

IMPORTANT: Fix ONLY code that causes failing conditions. Do not rewrite everything.

Report:
BRANCH_NAME: {BRANCH_NAME}
PR_URL: {PR_URL}
PR_NUMBER: {PR_NUMBER}
FILES_CHANGED: <modified files>
FIXES_APPLIED: <what changed per failure>
LOCAL_TEST_RESULT: <pass/fail>
```

### After subagent returns

Parse the subagent's output for BRANCH_NAME, PR_URL, PR_NUMBER. Update state variables.

If iteration 1: mark implement task complete, mark verify task in-progress.

---

## Phase 3: Verify (Subagent)

Spawn a verification subagent with `model: "opus"`.

### Iteration 1 prompt (tests don't exist yet):

```
You are the QA verification agent for mulder (mulkatz/mulder).

Read these files in order:
1. `CLAUDE.md` — ONLY the Testing, Local Development, and Error Handling sections
2. `{SPEC_PATH}` — ONLY Sections 1 (Objective), 2 (Boundaries), and 5 (QA Contract)

CRITICAL: Do NOT read files under packages/, src/, or apps/. Do NOT read Section 4 of the spec. You are black-box only.

Checkout the implementation branch:
  git checkout {BRANCH_NAME} && git pull

Your task:
1. Check test infrastructure (docker compose, vitest, CLI availability)
2. Write black-box tests to tests/specs/{SPEC_NUMBER}_spec_name.test.ts
   - One `it()` per QA condition in Section 5
   - Use execFileSync for CLI commands (not exec — avoid shell injection)
   - Tests interact through system boundaries only: CLI, SQL, HTTP, filesystem
   - Never import from packages/ or src/
3. Run tests: npx vitest run tests/specs/{SPEC_NUMBER}_*.test.ts --reporter=verbose
4. Commit and push the test file with Co-Authored-By trailer

Distinguish between:
- FAIL: system doesn't behave as specified (implementation bug)
- SKIP: can't verify due to missing infrastructure (not a failure)
- Test bugs: fix these immediately and re-run

Report in this exact format:
TOTAL: <number of conditions>
PASSED: <count>
FAILED: <count>
SKIPPED: <count>
VERDICT: PASS | FAIL | PARTIAL

For each failure:
FAILURE: <condition name>
EXPECTED: <what should happen per spec>
ACTUAL: <what happened>
EVIDENCE: <concrete proof — DB output, CLI stderr, HTTP response>
```

### Iteration 2+ prompt (tests exist, re-run):

```
You are the QA verification agent for mulder (mulkatz/mulder).

The implementation was updated to fix previous failures. Re-run existing tests.

Checkout: git checkout {BRANCH_NAME} && git pull

Run: npx vitest run tests/specs/{SPEC_NUMBER}_*.test.ts --reporter=verbose

Do NOT modify tests unless a test itself has a bug (wrong assertion logic, not an implementation mismatch). If you fix a test bug, commit and push.

Report in this exact format:
TOTAL: <number of conditions>
PASSED: <count>
FAILED: <count>
SKIPPED: <count>
VERDICT: PASS | FAIL | PARTIAL

For each failure:
FAILURE: <condition name>
EXPECTED: <what should happen>
ACTUAL: <what happened>
EVIDENCE: <proof>
```

### After subagent returns

Parse VERDICT and FAILURE blocks from the output.

**Decision tree:**

```
if VERDICT == "PASS":
    → Phase 5 (Finalize — success)

if VERDICT == "FAIL" and ITERATION < MAX_ITERATIONS:
    FAILURES = [parsed failure details]
    Tell user: "Iteration {ITERATION}: {FAILED_COUNT} QA conditions failed. Starting fix cycle..."
    → Phase 2 (next iteration)

if VERDICT == "FAIL" and ITERATION >= MAX_ITERATIONS:
    FAILURES = [parsed failure details]
    → Phase 5 (Finalize — needs review)

if VERDICT == "PARTIAL":
    If all non-skipped conditions PASS → treat as PASS
    If any non-skipped condition FAIL → treat as FAIL
    Skipped conditions don't count against the verdict
```

---

## Phase 4: Iterate

This is the loop between Phase 2 and Phase 3 — not a separate phase.

```
while VERDICT != PASS and ITERATION < MAX_ITERATIONS:
    ITERATION++
    Phase 2 (implement with failure context)
    Phase 3 (verify — re-run tests)
```

Update the task list on each iteration to keep the user informed of progress.

---

## Phase 5: Finalize

### On PASS

```bash
# Update issue labels
gh issue edit {ISSUE_NUMBER} --remove-label "ai-in-progress"
gh issue edit {ISSUE_NUMBER} --add-label "ai-done"

# Comment on the PR
gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
## AI Verification Complete

All QA conditions from the spec pass. Ready for human review.

- Spec: `{SPEC_PATH}`
- Roadmap: {TARGET_STEP}
- Iterations: {ITERATION}
- QA: {PASSED}/{TOTAL} conditions met ({SKIPPED} skipped due to infrastructure)

Please review the implementation and tests, then merge when satisfied.
EOF
)"
```

**Update roadmap** — change 🟡 to 🟢.

This commit goes on the **feature branch** intentionally — the 🟢 status lands on main only when the PR is merged, ensuring the roadmap never shows "complete" for unmerged work.

```bash
# Edit docs/roadmap.md: 🟡 → 🟢 for TARGET_STEP
git add docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: mark roadmap step {TARGET_STEP} complete

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

**Devlog check:** Read `docs/roadmap.md` and check if TARGET_STEP is the last step in its milestone (all other steps are now 🟢). If yes, write a devlog entry at `devlog/{YYYY-MM-DD}-{milestone-slug}.md` summarizing what the milestone achieved (per CLAUDE.md devlog conventions). Commit and push it on the feature branch alongside the roadmap update.

### On NEEDS-REVIEW (max iterations reached)

```bash
gh issue edit {ISSUE_NUMBER} --remove-label "ai-in-progress"
gh issue edit {ISSUE_NUMBER} --add-label "ai-needs-review"

gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
## AI Verification Incomplete

Reached maximum iterations ({MAX_ITERATIONS}). Some QA conditions still failing.

- Spec: `{SPEC_PATH}`
- Roadmap: {TARGET_STEP}
- QA: {PASSED}/{TOTAL} conditions met
- Remaining failures:

{FAILURES — formatted as markdown list with condition name, expected, actual}

Manual intervention needed for the remaining conditions.
EOF
)"
```

Roadmap stays 🟡 (not marked complete since QA didn't fully pass).

### Final report

```
Auto-pilot complete.

  Step:       {TARGET_STEP} — [description]
  Spec:       {SPEC_PATH}
  Issue:      #{ISSUE_NUMBER} — {ISSUE_URL}
  PR:         #{PR_NUMBER} — {PR_URL}
  Branch:     {BRANCH_NAME}
  QA:         {PASSED}/{TOTAL} passed ({SKIPPED} skipped)
  Iterations: {ITERATION}
  Status:     ai-done | ai-needs-review

{If ai-done: "All QA conditions pass. Review the PR and merge when ready."}
{If ai-needs-review: "Remaining failures listed in PR comment. Human review needed."}
```

Mark all tasks complete.

---

## Multi-Spec Handling

If Phase 1 classified the scope as **multi-spec** (and the user approved the split):

1. Phase 1 creates ALL sub-specs and issues

**Determining dependency order:**
   1. Read each sub-spec's Section 3 (Dependencies → Requires)
   2. Build a directed graph: if spec A requires spec B, add edge B → A (B must come first)
   3. Topological sort: process specs with no incoming edges (no unmet dependencies) first
   4. If a cycle is detected (A requires B, B requires C, C requires A), **stop:** "Circular dependency detected between specs {list}. The spec split needs revision."
   5. If multiple specs have no dependencies (independent), process in spec-number order

2. For each sub-spec **in dependency order**:
   - Reset ITERATION to 0
   - Run Phase 2 (implement) for this sub-spec
   - Run Phase 3 (verify) for this sub-spec
   - Phase 4 (iterate) if needed
   - **On pass:** label the sub-issue `ai-done`, update task list, proceed to next sub-spec
   - **On needs-review:** stop the pipeline. Label the failing sub-issue AND all remaining sub-issues as `ai-needs-review`. Report what passed and what didn't.
3. When ALL sub-specs pass: update the roadmap step to 🟢

Track each sub-spec's state independently. Report progress to the user between sub-specs:

```
Sub-spec 1/3 complete: [title] — all QA conditions pass.
Starting sub-spec 2/3: [title]...
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| **Subagent output unparseable** | Re-read the response. Extract what you can. If clearly failed (no code, no PR), tell user and stop. |
| **`gh` commands fail** | Run `gh auth status`. Report the error. |
| **Merge conflicts on push** | Tell the user. Don't force-push. Likely means someone else pushed to the branch. |
| **Missing infrastructure (greenfield)** | If the implement agent reports fundamental infrastructure is missing (`packages/` doesn't exist, no `package.json`), tell user: "This step depends on infrastructure from an earlier step. Start with {earlier step}." |
| **Spec is ambiguous** | Pause. Ask user: "The spec has a gap in {area}. Proceed with {assumption}, or update the spec first?" |
| **All dependencies unmet** | Don't proceed blindly. Tell user which dependencies are missing and suggest the correct starting point. |
| **Micro task / no-spec issue passed as input** | Auto-pilot requires a roadmap step, not a micro issue. Tell user: "This looks like a micro task (no spec needed). Use `/implement #{N}` + `/verify #{N}` directly instead of auto-pilot." |
| **Subagent crashes or times out** | Report what happened. Suggest running `/implement` or `/verify` manually to debug. |
