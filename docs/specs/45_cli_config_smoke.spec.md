---
spec: 45
title: CLI `mulder config` Smoke Coverage
roadmap_step: QA-Gate Phase 3 (coverage gap closure)
functional_spec: §1 (CLI surface), §4.1 (config loader)
scope: single
created: 2026-04-09
---

## 1. Objective

Retrospective QA contract for the `mulder config` command group (`validate`, `show`, `schema`) which closed the Phase-1 coverage finding `P1-COVERAGE-CLI-01` — before this test existed, `mulder config` was the only top-level CLI command without a dedicated black-box test. The goal is mechanical smoke: every subcommand runs, produces the expected output format, and fails correctly on invalid input.

## 2. Boundaries

### In scope
- `config --help` lists all three subcommands (`validate`, `show`, `schema`)
- `config validate <path>` exits 0 on the shipped `mulder.config.example.yaml`
- `config validate <path> --json` emits parseable JSON with `{valid: true}`
- `config validate <missing>` exits non-zero on a path that does not exist
- `config show <path>` exits 0 and emits the project name from the config
- `config schema <path>` exits 0 and emits a JSON Schema document

### Out of scope
- Config schema validation edge cases (minimal config, unknown keys, env overrides) — tracked separately as `P1-COVERAGE-CONFIG-EDGE-01`
- Deep validation of the JSON Schema contents
- `mulder db`, `mulder ingest`, `mulder pipeline`, `mulder query` — covered by their own specs

### Depends on
- Built CLI at `apps/cli/dist/index.js`
- `mulder.config.example.yaml` in the repo root
- Node.js `execFileSync` for subprocess invocation

## 5. QA Contract

Each `it()` in `tests/specs/45_cli_config_smoke.test.ts` maps 1:1 to a QA condition below.

### QA-01: `config --help` lists all subcommands
**Given** the built CLI
**When** `mulder config --help` runs
**Then** exit code is 0 and stdout contains `validate`, `show`, and `schema`

### QA-02: `config validate` passes on the shipped example
**Given** `mulder.config.example.yaml`
**When** `mulder config validate <path>` runs
**Then** exit code is 0 (the shipped example is the canonical valid config)

### QA-03: `config validate --json` emits parseable JSON with `valid: true`
**Given** `mulder.config.example.yaml`
**When** `mulder config validate <path> --json` runs
**Then** exit code is 0, stdout parses as JSON, and the parsed object's `valid` field is `true`

### QA-04: `config validate` fails on missing file
**Given** a path that does not exist on disk
**When** `mulder config validate <missing>` runs
**Then** exit code is non-zero

### QA-05: `config show` emits the project name
**Given** `mulder.config.example.yaml`
**When** `mulder config show <path>` runs
**Then** exit code is 0 and stdout contains the `project.name` value from the config

### QA-06: `config schema` emits a JSON Schema document
**Given** `mulder.config.example.yaml`
**When** `mulder config schema <path>` runs
**Then** exit code is 0 and stdout contains a JSON Schema document (recognizable by the presence of a `$schema` or `type` field at the root)

## 5b. CLI Test Matrix

This spec *is* the CLI test matrix for `mulder config`. Every row of QA-01 through QA-06 corresponds to one command invocation. No additional CLI matrix is needed.

| # | Command | Expected |
|---|---------|----------|
| CLI-01 | `mulder config --help` | exit 0, stdout contains `validate`, `show`, `schema` |
| CLI-02 | `mulder config validate mulder.config.example.yaml` | exit 0 |
| CLI-03 | `mulder config validate mulder.config.example.yaml --json` | exit 0, stdout is valid JSON with `valid: true` |
| CLI-04 | `mulder config validate /nonexistent/path.yaml` | exit non-zero |
| CLI-05 | `mulder config show mulder.config.example.yaml` | exit 0, stdout contains `project.name` |
| CLI-06 | `mulder config schema mulder.config.example.yaml` | exit 0, stdout is JSON Schema |

## Pass / Fail

- Pass: all 6 `it()` blocks in `tests/specs/45_cli_config_smoke.test.ts` assert green
- Fail: any subcommand fails to run, exits wrong, or produces malformed output

## Out of scope

Functional correctness of the Zod schema, env-variable substitution, and cross-field validation rules are tested implicitly via every other spec that calls `loadConfig()`. This spec covers only the CLI surface that wraps the loader.
