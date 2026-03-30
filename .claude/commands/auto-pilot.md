---
description: "Full lifecycle — picks roadmap step, architects spec, implements, verifies, reviews, merges"
---

# Mulder — Auto-Pilot

You orchestrate the full feature lifecycle: pick a roadmap step → architect a spec → implement the code → verify with black-box tests → architect review → merge and close. Iterate on failures until QA passes or you hit the iteration limit.

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
5. [ ] Review: architect-level correctness check
6. [ ] Finalize: merge, close issue, update roadmap
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

**Labels** are for categorization only. Status, priority, and phase are tracked on the project board.

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
  "type\:feature:New feature or capability:1D76DB" \
  "type\:bug:Bug fix:B60205" \
  "type\:chore:Maintenance, tooling, config:C2E0C6"; do
  IFS=: read -r name desc color <<< "$label"
  gh label create "$name" --description "$desc" --color "$color" 2>/dev/null || true
done
```

**Create the issue.** Labels are domain + type only. The issue must be self-contained for reviewers:

```bash
gh issue create \
  --title "[Domain] Observable system change — TARGET_STEP" \
  --label "domain-label,type:feature" \
  --body "$(cat <<'EOF'
## Objective

[2-3 sentence summary from spec Section 1]

## Spec

[`docs/specs/NN_title.spec.md`](https://github.com/mulkatz/mulder/blob/main/docs/specs/NN_title.spec.md) — Roadmap step [TARGET_STEP]

## Acceptance Criteria

[Copy the QA conditions from spec Section 5 as a checklist:]
- [ ] QA-01: [condition name — Given/When/Then summary]
- [ ] QA-02: [condition name]
- ...

## Branch

`feat/{NUMBER}-short-descriptor`

---
*Architected from [`docs/specs/NN_title.spec.md`](https://github.com/mulkatz/mulder/blob/main/docs/specs/NN_title.spec.md)*
EOF
)"
```

After creation, update the spec's `issue:` frontmatter with the issue URL.

**Add to GitHub Project and set board fields:**

Status, priority, phase, step, and spec are tracked as project board fields — not labels.

```bash
# Uses GH_PROJECT_TOKEN (classic PAT with `project` scope) — skip if not set
if [ -n "$GH_PROJECT_TOKEN" ]; then
  PROJECT_ID=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project list --owner @me --format json --jq '.projects[] | select(.title=="Mulder") | .id' 2>/dev/null)
  PROJECT_NUM=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project list --owner @me --format json --jq '.projects[] | select(.title=="Mulder") | .number' 2>/dev/null)
  if [ -n "$PROJECT_ID" ]; then
    # Add issue to project
    GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-add "$PROJECT_NUM" --owner @me --url "{ISSUE_URL}" 2>/dev/null || true

    # Get the item ID
    ITEM_ID=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-list "$PROJECT_NUM" --owner @me --format json --jq '.items[] | select(.content.url=="{ISSUE_URL}") | .id' 2>/dev/null)
    if [ -n "$ITEM_ID" ]; then
      # IMPORTANT: --project-id requires the node ID (PVT_...), NOT the project number
      # Status → "In Progress"
      GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTSSF_lAHOAD_Rzc4BTIvwzhAdyRE" --single-select-option-id "08dd1a37" 2>&1 || true
      # Phase → set based on MILESTONE (use the matching option ID from the table below)
      GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTSSF_lAHOAD_Rzc4BTIvwzhAd0z8" --single-select-option-id "{PHASE_OPTION_ID}" 2>&1 || true
      # Priority → set based on step analysis (foundation steps = P1, critical path = P0)
      GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTSSF_lAHOAD_Rzc4BTIvwzhAd00A" --single-select-option-id "{PRIORITY_OPTION_ID}" 2>&1 || true
      # Step → text field
      GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTF_lAHOAD_Rzc4BTIvwzhAd01U" --text "{TARGET_STEP}" 2>&1 || true
      # Spec → text field
      GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTF_lAHOAD_Rzc4BTIvwzhAd02A" --text "{SPEC_PATH}" 2>&1 || true
    fi
  fi
fi
```

**CRITICAL:** `--project-id` requires the **node ID** (`PVT_kwHOAD_Rzc4BTIvw`), NOT the project number. Use `.id` from the JSON, not `.number`. The number is only used for `item-add` and `item-list`.

**Board field IDs reference** (from project setup):

| Field | ID | Type | Options |
|-------|-----|------|---------|
| Status | `PVTSSF_...dyRE` | single-select | Backlog `d0c8a535`, Spec `1ac591d0`, Ready `638e78e3`, In Progress `08dd1a37`, In Review `a7f130a1`, Done `fa785559` |
| Phase | `PVTSSF_...d0z8` | single-select | M1 `f15b9c6c`, M2 `e5fbbc12`, M3 `1e83885d`, M4 `3de6a7d4`, M5 `2da286d2`, M6 `268ec9a1`, M7 `2affaccc`, M8 `453f2da6` |
| Priority | `PVTSSF_...d00A` | single-select | P0 `5988f848`, P1 `b1a604f6`, P2 `07c6dcf8`, P3 `7a548448` |
| Step | `PVTF_...d01U` | text | — |
| Spec | `PVTF_...d02A` | text | — |

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

**Step 3b: Build + integration verification.**
Before committing, run ALL of these in order — fix any issues before proceeding:
1. `pnpm turbo run build 2>&1` — fix any type errors (build ALL packages, not just changed)
2. `npx biome check .` — fix any lint/format issues (`npx biome check --write .` for auto-fix)
3. `npx vitest run tests/ --reporter=verbose` — run the FULL test suite (all existing tests)

This catches regressions early. If an existing test fails because of your changes, you must fix it. Common causes:
- Biome lint rules (no `any` in source, no `as` assertions) — fix the code, don't suppress
- Type signature changes that break consumers — update call sites
- Barrel export ordering or naming conflicts

Do not proceed to Step 4 if any check fails.

**Step 4: Branch, commit, push, PR.**
- Create branch: feat/{ISSUE_NUMBER}-{kebab-from-spec-title}
- Atomic commits per phase with semantic messages
- Include `Co-Authored-By: Claude <noreply@anthropic.com>` in every commit
- Push: git push -u origin {branch}
- Create PR with `Closes #{ISSUE_NUMBER}` in the body
- Do NOT write tests — a separate verification agent handles that
- Do NOT update docs/roadmap.md — that happens after QA passes

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
6. Run the full test suite: npx vitest run tests/ --reporter=verbose
   (This runs ALL tests, not just the spec's tests — catches regressions)
6b. Build verification: run `pnpm turbo run build` and `npx biome check .` — fix any issues before committing
7. Commit: "fix: address QA failures — [brief description]" with Co-Authored-By trailer
8. Push to the same branch
9. Do NOT update docs/roadmap.md

IMPORTANT: Fix ONLY code that causes failing conditions. Do not rewrite everything.

ESCAPE HATCH: If a failing test contradicts the spec (e.g., test asserts 200 but spec says 201),
do NOT change code to match a wrong test. Instead, report:
TEST_MISMATCH: <test file:line> asserts <X>, but spec Section 5 says <Y>
The orchestrator will route this back to the verify agent for test correction.

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

**TEST_MISMATCH handling:** If the implement agent reports `TEST_MISMATCH`, do NOT proceed to Phase 3 with the same tests. Instead, pass the mismatch details to the verify agent in the next Phase 3 run so it can correct the test assertion. Include the mismatch in the verify prompt: "The implement agent flagged a test-vs-spec mismatch: {details}. Review the assertion and fix if warranted."

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
3. Run your new tests: npx vitest run tests/specs/{SPEC_NUMBER}_*.test.ts --reporter=verbose
4. Run the FULL test suite for regression check: npx vitest run tests/ --reporter=verbose
   - If any EXISTING test (from a previous spec) fails, this is a regression caused by the new feature
   - Report regressions as FAIL conditions — they count against the verdict
5. Commit and push the test file with Co-Authored-By trailer

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

Run the spec's tests first, then the FULL test suite for regression check:
1. npx vitest run tests/specs/{SPEC_NUMBER}_*.test.ts --reporter=verbose
2. npx vitest run tests/ --reporter=verbose

If any EXISTING test (from a previous spec) fails, report it as a regression FAIL condition.

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
    → Phase 4 (Review)

if VERDICT == "FAIL" and ITERATION < MAX_ITERATIONS:
    FAILURES = [parsed failure details]
    Tell user: "Iteration {ITERATION}: {FAILED_COUNT} QA conditions failed. Starting fix cycle..."
    → Phase 2 (next iteration)

if VERDICT == "FAIL" and ITERATION >= MAX_ITERATIONS:
    FAILURES = [parsed failure details]
    → Phase 6 (Finalize — needs review)

if VERDICT == "PARTIAL":
    If all non-skipped conditions PASS → treat as PASS → Phase 4
    If any non-skipped condition FAIL → treat as FAIL
    Skipped conditions don't count against the verdict
```

---

## Phase 3b: Iterate

This is the loop between Phase 2 and Phase 3 — not a separate phase.

```
while VERDICT != PASS and ITERATION < MAX_ITERATIONS:
    ITERATION++
    Phase 2 (implement with failure context)
    Phase 3 (verify — re-run tests)
```

Update the task list on each iteration to keep the user informed of progress.

---

## Phase 4: Review (Subagent)

After QA passes, spawn an architect-level review agent to check for correctness before merging. This is the "red hat" — a final sanity check that catches architectural drift, spec violations, and edge cases that black-box tests can't see.

Spawn a review subagent with `model: "opus"`.

```
You are the Lead Architect reviewing a feature implementation for mulder (mulkatz/mulder).

Your job: verify the implementation is architecturally sound and spec-compliant before it merges. You are the last gate before this lands on main.

**Read in this order:**
1. `CLAUDE.md` — architecture decisions, key patterns, conventions
2. `{SPEC_PATH}` — the full spec (all sections including Blueprint)
3. The PR diff: `git diff main...{BRANCH_NAME} -- ':!pnpm-lock.yaml'`
4. If anything looks off, read the relevant section of `docs/functional-spec.md` for authoritative requirements

**Review checklist — check each, report only real issues:**

1. **Spec compliance** — Does the implementation match the spec's Blueprint (Section 4)?
   - All files listed in the spec created?
   - Exports/imports match the spec's description?
   - Database DDL matches exactly?
   - Config additions match?

2. **Architecture alignment** — Does the code follow CLAUDE.md patterns?
   - Service abstraction (no direct GCP SDK calls from pipeline steps)
   - Config via loader (no direct YAML parsing)
   - Error handling (custom error classes, not generic throws)
   - Idempotency (ON CONFLICT DO UPDATE where required)
   - ESM, strict mode, no `any`/`as`

3. **Integration correctness** — Are the wiring points correct?
   - Barrel exports updated?
   - Package dependencies declared in package.json?
   - TypeScript project references in tsconfig.json?

4. **Edge cases that matter** — Only flag edge cases that:
   - Would cause data loss or corruption
   - Would break other pipeline steps
   - Are explicitly called out in the functional spec
   - Would fail silently (no error, wrong result)

**DO NOT flag:**
- Style preferences (that's Biome's job)
- Missing error handling for scenarios that can't happen
- Missing tests (that's verify's job)
- Hypothetical future requirements
- Minor naming nitpicks

**Output format:**

REVIEW_VERDICT: APPROVED | CHANGES_REQUESTED

If APPROVED:
"Implementation is architecturally sound and spec-compliant. No blocking issues found."
[Optional: non-blocking observations for future improvement]

If CHANGES_REQUESTED:
For each issue:
ISSUE: [short title]
SEVERITY: blocking | warning
FILE: [path:line]
PROBLEM: [what's wrong]
FIX: [specific fix needed]
SPEC_REF: [which spec section or CLAUDE.md pattern is violated]
```

### After review subagent returns

**Decision tree:**

```
if REVIEW_VERDICT == "APPROVED":
    → Phase 5 (Finalize — merge)

if REVIEW_VERDICT == "CHANGES_REQUESTED":
    Count blocking issues only (ignore warnings)
    if blocking_count == 0:
        → Phase 5 (Finalize — merge, note warnings in PR)
    if blocking_count > 0 and ITERATION < MAX_ITERATIONS:
        Tell user: "Review found {N} blocking issues. Sending back to implement..."
        Format blocking issues as FAILURES
        Set VERDICT = "pending"   ← MUST reset — fixes may break existing tests
        → Phase 2 (fix) → Phase 3 (re-verify) → Phase 4 (re-review)
    if blocking_count > 0 and ITERATION >= MAX_ITERATIONS:
        → Phase 5 (Finalize — needs review)
```

Mark review task complete.

---

## Phase 5: Finalize

### On PASS (QA passed + review approved)

**1. Update roadmap** — change 🟡 to 🟢 on the feature branch:

```bash
git checkout {BRANCH_NAME} && git pull
# Edit docs/roadmap.md: 🟡 → 🟢 for TARGET_STEP
git add docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs: mark roadmap step {TARGET_STEP} complete

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
git push
```

**2. Devlog check:** Evaluate whether THIS step warrants a devlog entry — per CLAUDE.md devlog conventions, not per milestone. Write an entry when any of these apply to the just-completed step:
- A new capability works (e.g., service abstraction, pipeline step, search)
- An architecture decision was made or revised
- A non-obvious problem was solved
- A GCP service was first integrated
- A significant refactor landed
- A milestone was fully completed (all steps 🟢)

Skip when: routine refactoring, bug fixes, dependency updates, formatting, repeated iterations.

If a devlog entry is warranted, write it at `devlog/{YYYY-MM-DD}-{step-slug}.md` summarizing what this specific step achieved, key decisions, and anything non-obvious. Use type from: architecture | implementation | breakthrough | decision | refactor | integration | milestone. Commit and push it on the feature branch.

**3. Squash merge + close:**

```bash
gh pr merge {PR_NUMBER} --merge --delete-branch
```

Merge commit preserves the atomic commit history (types, logic, integration, QA fixes) while `git log --first-parent` still gives a clean high-level view.

The PR body already contains `Closes #{ISSUE_NUMBER}`, so the issue closes automatically on merge.

**4. Update board status → Done:**

```bash
if [ -n "$GH_PROJECT_TOKEN" ]; then
  PROJECT_ID=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project list --owner @me --format json --jq '.projects[] | select(.title=="Mulder") | .id' 2>/dev/null)
  PROJECT_NUM=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project list --owner @me --format json --jq '.projects[] | select(.title=="Mulder") | .number' 2>/dev/null)
  ITEM_ID=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-list "$PROJECT_NUM" --owner @me --format json --jq '.items[] | select(.content.url=="{ISSUE_URL}") | .id' 2>/dev/null)
  if [ -n "$ITEM_ID" ]; then
    # Status → "Done" (option id: fa785559) — MUST use PROJECT_ID (node ID), not PROJECT_NUM
    GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTSSF_lAHOAD_Rzc4BTIvwzhAdyRE" --single-select-option-id "fa785559" 2>&1 || true
  fi
fi
```

**5. Return to main:**

```bash
git checkout main && git pull
```

### On NEEDS-REVIEW (max iterations reached)

```bash
# Update board status → "In Review" (needs human attention)
if [ -n "$GH_PROJECT_TOKEN" ]; then
  PROJECT_ID=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project list --owner @me --format json --jq '.projects[] | select(.title=="Mulder") | .id' 2>/dev/null)
  PROJECT_NUM=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project list --owner @me --format json --jq '.projects[] | select(.title=="Mulder") | .number' 2>/dev/null)
  ITEM_ID=$(GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-list "$PROJECT_NUM" --owner @me --format json --jq '.items[] | select(.content.url=="{ISSUE_URL}") | .id' 2>/dev/null)
  if [ -n "$ITEM_ID" ]; then
    GH_TOKEN="$GH_PROJECT_TOKEN" gh project item-edit --project-id "$PROJECT_ID" --id "$ITEM_ID" --field-id "PVTSSF_lAHOAD_Rzc4BTIvwzhAdyRE" --single-select-option-id "a7f130a1" 2>&1 || true
  fi
fi

gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
## Verification Incomplete

Reached maximum iterations ({MAX_ITERATIONS}). Some conditions still failing.

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

Return to main:
```bash
git checkout main
```

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
  Result:     merged | needs-review

{If merged: "Merged to main. Issue closed. Roadmap updated."}
{If needs-review: "Remaining failures listed in PR comment. Manual intervention needed."}
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
   - Phase 3b (iterate) if needed
   - Phase 4 (review)
   - **On pass:** update task list, proceed to next sub-spec
   - **On needs-review:** stop the pipeline. Set the failing sub-issue's board status to "In Review". Report what passed and what didn't.
3. When ALL sub-specs pass: squash merge all PRs, update the roadmap step to 🟢

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
| **Merge conflicts on squash merge** | Tell the user. The branch likely diverged from main. |
| **Missing infrastructure (greenfield)** | If the implement agent reports fundamental infrastructure is missing (`packages/` doesn't exist, no `package.json`), tell user: "This step depends on infrastructure from an earlier step. Start with {earlier step}." |
| **Spec is ambiguous** | Pause. Ask user: "The spec has a gap in {area}. Proceed with {assumption}, or update the spec first?" |
| **All dependencies unmet** | Don't proceed blindly. Tell user which dependencies are missing and suggest the correct starting point. |
| **Micro task / no-spec issue passed as input** | Auto-pilot requires a roadmap step, not a micro issue. Tell user: "This looks like a micro task (no spec needed). Use `/implement #{N}` + `/verify #{N}` directly instead of auto-pilot." |
| **Subagent crashes or times out** | Report what happened. Suggest running `/implement` or `/verify` manually to debug. |
