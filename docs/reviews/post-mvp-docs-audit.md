---
phase: 6
title: "Post-MVP Documentation Audit"
scope: User-facing + contributor docs (README, CLAUDE.md, roadmap, spec, config example, CLI help, error messages, devlog)
date: 2026-04-08
verdict: PASS_WITH_FINDINGS
---

# Post-MVP QA Gate — Phase 6: Documentation Audit

## Executive Summary

Documentation is generally accurate and well-maintained through M4. The progress bar and roadmap are fully green for M1–M4. CLI help text is clear and consistent across all commands. The one CRITICAL-level concern is structural: the `terraform/` directory referenced throughout CLAUDE.md and the README does not exist in the repository — Terraform infrastructure is designed but not yet committed. This is a known gap (MVP is CLI-only, no GCP deployment yet), but the documentation makes no mention of this, leaving contributors misled. Two warnings cover stale status badges and `@reserved` annotations on error codes that were implemented in M4. Four notes cover cosmetic and low-impact gaps.

**Verdict: PASS_WITH_FINDINGS** — no doc inaccuracy blocks using or contributing to the codebase, but the Terraform gap must be clarified before M5 contributors arrive.

---

## 1. README.md

**[P6-DOCS-README-01] Status badge still shows `building_M2`**
- **Severity:** WARNING
- **File:** `README.md:21`
- **Detail:** `<img src="https://img.shields.io/badge/status-building_M2-orange?style=flat-square" alt="Status" />` — M4 is complete.
- **Fix:** Change to `status-MVP_complete-green` (or `v1.0_complete`).

**[P6-DOCS-README-02] Status prose section still says "Currently building Milestone 2"**
- **Severity:** WARNING
- **File:** `README.md:197–200`
- **Detail:** "Currently building **Milestone 2** (ingest + extract: first GCP integration, Document AI, Cloud Storage)." and "See the [roadmap](./docs/roadmap.md) for all **9 milestones**" — M4 is done and the roadmap has 14 milestones (M1–M14 including addendum).
- **Fix:** Update status paragraph to reflect M4/v1.0 complete, update milestone count to 14.

**[P6-DOCS-README-03] Progress bar correct — no finding**
- `<!-- PROGRESS -->` markers present. Bar shows `41 / 112 steps`, M1–M4 all `✓`. Accurate.

**[P6-DOCS-README-04] Capabilities 11 and 12 listed as available with no "Phase 2" qualifier**
- **Severity:** NOTE
- **File:** `README.md:88–89`
- **Detail:** "Visual Intelligence" and "Pattern Discovery" are listed in the capabilities table without any indicator that they are Phase 2 / not yet implemented. CLAUDE.md correctly flags them as "designed for, not yet implemented."
- **Fix:** Add a "(v3.0 / Phase 2)" indicator in the table rows, consistent with how the pipeline diagram shows `Ground` and `Analyze` without separate Phase 2 caveats.

---

## 2. CLAUDE.md

**[P6-DOCS-CLAUDE-01] `terraform/modules/` referenced but directory does not exist**
- **Severity:** WARNING
- **File:** `CLAUDE.md` — "Architecture Decisions" section, line: `**Infra**: Terraform, modular (\`terraform/modules/\`)` and "Repo Structure" section listing `terraform/modules/` with submodule list.
- **Detail:** `ls /Users/franz/Workspace/mulder/terraform/` → directory does not exist. The repo currently has no Terraform code. The Infrastructure section also states "Terraform reads `mulder.config.yaml` directly via `yamldecode()`" — this is planned behaviour, not current reality.
- **Impact:** A contributor following CLAUDE.md to set up or inspect infrastructure will find nothing. Any CI step that tries to apply Terraform will fail immediately.
- **Fix:** Add a one-line caveat at the top of the Infrastructure section: "Note: Terraform modules are planned for M8 (Operations). The `terraform/` directory does not yet exist in the repository."

**[P6-DOCS-CLAUDE-02] PIPELINE error codes still marked `@reserved` despite D6 being implemented**
- **Severity:** NOTE
- **File:** `packages/core/src/shared/errors.ts:26–32`
- **Detail:** `PIPELINE_SOURCE_NOT_FOUND`, `PIPELINE_WRONG_STATUS`, `PIPELINE_STEP_FAILED`, `PIPELINE_RATE_LIMITED` all carry `@reserved D6 pipeline orchestrator` JSDoc. Verified they are actively thrown in `packages/pipeline/src/pipeline/index.ts`. Same applies to `EMBED_*` codes (tagged `@reserved D4`) and `GRAPH_*` codes (tagged `@reserved D5`) — all implemented and actively thrown.
- **Impact:** The error-code coverage audit test (spec 37) classifies these as RESERVED, not ACTIVE, which inflates the "20 reserved" count from the baseline.
- **Fix:** Remove the `@reserved` tag from all D4/D5/D6 codes. Leave `@reserved` only on genuinely future codes (F1, M9, etc.).

**[P6-DOCS-CLAUDE-03] `feature-spec-addendum.md` referenced with wrong filename in architecture doc**
- **Severity:** NOTE
- **File:** `docs/architecture-core-vs-domain.md:5`
- **Detail:** "the feature spec addendum (`docs/feature-spec-addendum.md`)" — the actual filename is `docs/functional-spec-addendum.md`. CLAUDE.md itself uses the correct name.
- **Fix:** Correct the filename reference in `architecture-core-vs-domain.md` line 5.

---

## 3. mulder.config.example.yaml vs Zod schema

**[P6-DOCS-CONFIG-01] `ef_search` option present in Zod schema but absent from example config**
- **Severity:** NOTE
- **File:** `mulder.config.example.yaml` — `retrieval.strategies.vector` block (lines 141–142) lists only `weight: 0.5`.
- **Detail:** `packages/core/src/config/schema.ts:179` defines `ef_search: z.number().int().positive().default(40)` under `retrieval.strategies.vector`. This is a significant tuning lever (controls HNSW search-time recall/speed trade-off) that a power user would want to know about.
- **Fix:** Add `ef_search: 40 # HNSW recall tuning (default: 40)` to the `vector` block in the example config.

No other schema gaps found. The example config covers all major sections: `project`, `gcp`, `dev_mode`, `ontology`, `ingestion`, `extraction`, `enrichment`, `entity_resolution`, `deduplication`, `embedding`, `retrieval`, `grounding`, `analysis`, `thresholds`, `pipeline`, `vertex`, `safety`, plus Phase 2 reserved sections.

---

## 4. docs/roadmap.md

All M1–M4 steps are correctly marked 🟢. QA Gate steps are 🟢. M5–M14 steps are ⚪. Spec column references are accurate (spot-checked D5→§2.7, E4→§5.2, E6→§5). No findings.

**[P6-DOCS-ROADMAP-01] QA Gate and Post-MVP QA Gate phases not represented**
- **Severity:** NOTE
- **File:** `docs/roadmap.md`
- **Detail:** The roadmap tracks the Pre-Search QA Gate (QA-1 through QA-6) but has no entry for the Post-MVP QA Gate (Phases 1–7, this current gate). The gate deliverables (D1–D9) exist as files in `docs/reviews/` but are not referenced from the roadmap.
- **Fix:** Low priority — the roadmap covers production steps, not meta-QA. Either add a "Post-MVP QA Gate" section at the end with links to the review docs, or leave as-is with a comment in the roadmap header.

---

## 5. docs/architecture-core-vs-domain.md

§D1–§D5 principles are honored by the M4 codebase (verified via m4-review.md). No domain-specific terms found in retrieval code. Config-driven patterns throughout. The filename reference bug is captured as P6-DOCS-CLAUDE-03 above.

`docs/functional-spec-addendum.md` exists. No further check needed per scope.

---

## 6. CLI help text audit

| Command | Description | Options | Examples in help | Verdict |
|---------|------------|---------|-------------------|---------|
| `mulder` (root) | "Config-driven Document Intelligence Platform" | — | — | ✅ |
| `config validate` | "Validate mulder.config.yaml against Zod schema" | `--path` | — | ✅ |
| `config show` | "Print resolved config with defaults applied" | `--path` | — | ✅ |
| `config schema` | "Print generated JSON Schema for entity extraction structured output" | `--path` | — | ✅ |
| `db migrate` | "Run pending database migrations" | — | — | ✅ |
| `db status` | "Show database migration status" | — | — | ✅ |
| `db gc` | "Garbage-collect orphaned entities (no story references)" | options present | — | ✅ |
| `ingest` | "Ingest PDF(s) — file or directory" | `--dry-run`, `--tag`, `--cost-estimate` | — | ✅ |
| `extract` | "Extract layout data and page images from ingested PDFs" | `[source-id]` | — | ✅ |
| `segment` | "Segment extracted documents into individual stories" | `[source-id]` | — | ✅ |
| `enrich` | "Extract entities and relationships from stories" | `[story-id]` | — | ✅ |
| `embed` | "Generate embeddings for stories" | `[story-id]` | — | ✅ |
| `graph` | "Build knowledge graph edges, detect duplicates, score corroboration" | `[story-id]` | — | ✅ |
| `pipeline run` | "Run the full pipeline (ingest → extract → ... → graph)" | `--up-to`, `--from`, `--dry-run`, `--tag` | — | ✅ |
| `pipeline status` | "Show pipeline run status" | options present | — | ✅ |
| `pipeline retry` | "Retry the failed step for a source in a new run" | `[source-id]` | — | ✅ |
| `query` | "Hybrid retrieval query against the indexed corpus" | `--strategy`, `--top-k`, `--no-rerank`, `--explain`, `--json` | — | ✅ |
| `cache clear/stats` | Accurately described | — | — | ✅ |
| `fixtures generate/status` | Accurately described | — | — | ✅ |

**[P6-DOCS-CLI-01] No CLI command shows usage examples**
- **Severity:** NOTE
- **Detail:** All commands have accurate descriptions and option lists, but no command includes a usage example in the `--help` output. Commander.js supports `.addHelpText('after', '...')` for inline examples. The `query` command in particular benefits from an example (natural-language queries with quotes are non-obvious).
- **Fix:** Add 1–2 examples to `ingest`, `query`, and `pipeline run` help text. Post-gate.

---

## 7. Error messages

Spot-checked 8 error codes across 5 families:

| Code | Message pattern | Action-oriented? |
|------|----------------|-----------------|
| `INGEST_FILE_NOT_FOUND` | "File not found: {path}" | ✅ |
| `INGEST_FILE_TOO_LARGE` | Includes size limit + actual size | ✅ |
| `CONFIG_INVALID` | Zod error with field path | ✅ |
| `DB_MIGRATION_FAILED` | Includes migration filename + pg error | ✅ |
| `RETRIEVAL_DIMENSION_MISMATCH` | Includes expected vs actual dims | ✅ |
| `RETRIEVAL_ORCHESTRATOR_FAILED` | "All retrieval strategies failed or were skipped" | ✅ |
| `SEGMENT_NO_STORIES_FOUND` | Descriptive | ✅ |
| `TEMPLATE_VARIABLE_MISSING` | Includes variable name + template name | ✅ |

All checked error messages are action-oriented and include enough context. No findings.

---

## 8. Devlog coverage

| M4 Deliverable | Expected devlog | Exists? |
|----------------|----------------|---------|
| D4 Embed step | — | No entry — routine step, acceptable per devlog rules |
| D5 Graph step | Graph step (dedup, corroboration, contradiction) | No dedicated entry |
| D6 Pipeline orchestrator | `2026-04-07-pipeline-orchestrator.md` | ✅ |
| D7 Full-text search (tsvector) | — | No dedicated entry |
| E1 Vector search | `2026-04-07-vector-search-retrieval.md` | ✅ |
| E2 Full-text search wrapper (BM25) | — | No dedicated entry (covered briefly in E6 devlog) |
| E3 Graph traversal retrieval | — | No dedicated entry |
| E4 RRF fusion | `2026-04-08-hybrid-retrieval-orchestrator.md` mentions RRF | Mentioned, not dedicated |
| E5 LLM re-ranking | Same hybrid devlog | Mentioned, not dedicated |
| E6 Hybrid retrieval orchestrator | `2026-04-08-hybrid-retrieval-orchestrator.md` | ✅ |

**[P6-DOCS-DEVLOG-01] No devlog entry for D5 (Graph step)**
- **Severity:** NOTE
- **File:** `devlog/` — missing `*graph-step*` or `*dedup*` entry
- **Detail:** D5 implements the most architecturally novel step in M4 (MinHash deduplication, corroboration scoring, contradiction flagging). The devlog guidance says "Write entry when: new capability works, architecture decision made/revised, non-obvious problem solved." The co-occurrence fallback (DIV-003 from m4-review) and the self-loop contradiction encoding (DIV-004) both qualify. D7/E2/E3/E4/E5 are lower priority since they're covered by the E6 orchestrator entry.
- **Fix:** Add a devlog entry for the graph step covering the dedup/corroboration design and known divergences. Low priority post-gate.

---

## 9. Phase 3 spec.md gap

Phase 3 added three test files:

| Test file | Corresponding `docs/specs/*.spec.md` | Exists? |
|-----------|--------------------------------------|---------|
| `tests/specs/43_retrieval_metrics.test.ts` | `docs/specs/43_retrieval_metrics.spec.md` | ❌ |
| `tests/specs/44_e2e_pipeline_integration.test.ts` | `docs/specs/44_e2e_pipeline_integration.spec.md` | ❌ |
| `tests/specs/45_cli_config_smoke.test.ts` | `docs/specs/45_cli_config_smoke.spec.md` | ❌ |

**[P6-DOCS-SPEC-01] specs 43, 44, 45 have no corresponding `docs/specs/*.spec.md` files**
- **Severity:** WARNING
- **Detail:** Every other test file (01–42) has a matching spec file in `docs/specs/`. The three Phase 3 additions break that pattern. The spec files serve as the QA contract readable by reviewers who shouldn't need to parse test code.
- **Fix:** Create `docs/specs/43_retrieval_metrics.spec.md`, `44_e2e_pipeline_integration.spec.md`, `45_cli_config_smoke.spec.md` with frontmatter, QA contract, and pass/fail criteria. This is deliverable D10 for Phase 3 follow-up.

Note: P1-BASELINE-DUPNUM-01 (duplicate-numbered test files) is a known prior finding — not re-reported.

---

## 10. Phase 6 findings summary

| ID | Severity | Title | Phase for fix |
|----|----------|-------|---------------|
| P6-DOCS-README-01 | WARNING | Status badge still shows `building_M2` | Immediate / post-gate |
| P6-DOCS-README-02 | WARNING | Status prose says "building M2" and "9 milestones" | Immediate / post-gate |
| P6-DOCS-CLAUDE-01 | WARNING | `terraform/modules/` referenced but directory doesn't exist | Before M8 / add caveat now |
| P6-DOCS-SPEC-01 | WARNING | No `docs/specs/*.spec.md` for test files 43, 44, 45 | Post-gate (Phase 3 follow-up) |
| P6-DOCS-CLAUDE-02 | NOTE | D4/D5/D6 error codes still tagged `@reserved` despite being implemented | Post-gate hygiene |
| P6-DOCS-CLAUDE-03 | NOTE | `architecture-core-vs-domain.md` references wrong addendum filename | Post-gate hygiene |
| P6-DOCS-CONFIG-01 | NOTE | `ef_search` tuning parameter missing from example config | Post-gate |
| P6-DOCS-ROADMAP-01 | NOTE | Post-MVP QA Gate phases not referenced from roadmap | Low priority |
| P6-DOCS-CLI-01 | NOTE | No usage examples in any `--help` output | Post-gate |
| P6-DOCS-DEVLOG-01 | NOTE | No devlog entry for D5 Graph step | Post-gate |

**Total: 4 WARNING, 6 NOTE, 0 CRITICAL.**
