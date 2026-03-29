---
spec: 6
title: CLI Scaffold
roadmap_step: M1-A5
functional_spec: ["§1", "§1.1"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/12
created: 2026-03-29
---

# 06 — CLI Scaffold

## 1. Objective

Create the `mulder` CLI binary with Commander.js, implementing `config validate` and `config show` as the first two working commands. This establishes the CLI architecture pattern that all future commands follow: parse arguments → load config → call core library → format output.

## 2. Boundaries

### In scope
- Commander.js program setup with `mulder` binary entry point
- `mulder config validate` command — validates `mulder.config.yaml` against Zod schema, reports issues
- `mulder config show` command — prints resolved config with defaults applied
- `mulder --version` and `mulder --help` (Commander.js built-in)
- CLI output formatting utilities (tables, JSON mode, colors)
- CLI error handling with structured exit codes
- `bin` field in `package.json` for `mulder` binary

### Out of scope
- `config init` (interactive prompts — future step)
- All other command groups (`db`, `ingest`, `pipeline`, etc.)
- No business logic in the CLI layer — it calls `loadConfig()` from `@mulder/core`

### Constraints
- No new dependencies beyond Commander.js and chalk (for colors)
- CLI must work with `pnpm exec mulder` from the monorepo root
- Must handle missing config file gracefully (not a stack trace)
- `config show` outputs JSON by default, YAML with `--format yaml`

## 3. Dependencies

### Requires (must exist)
- `@mulder/core` — `loadConfig()`, `ConfigValidationError`, `MulderConfig`, `mulderConfigSchema`
- `@mulder/core` — `createLogger()` for structured logging
- `@mulder/core` — `MulderError`, `isMulderError` for error handling

### Required by (future steps that depend on this)
- M1-A6 (Database client) — adds `db` commands to the CLI
- M2-B4 (Ingest step) — adds `ingest` command
- All future CLI commands

## 4. Blueprint

### 4.1 Files to create

| File | Purpose |
|------|---------|
| `apps/cli/src/index.ts` | Entry point: `#!/usr/bin/env node`, Commander program, registers command groups |
| `apps/cli/src/commands/config.ts` | `config validate` and `config show` subcommands |
| `apps/cli/src/lib/output.ts` | Output formatting: JSON, YAML, tables, colors, stderr for errors |
| `apps/cli/src/lib/errors.ts` | CLI error handler: catches MulderError → formatted stderr + exit code |

### 4.2 Files to modify

| File | Change |
|------|--------|
| `apps/cli/package.json` | Add `bin` field, add `commander` + `chalk` + `yaml` dependencies |
| `apps/cli/tsconfig.json` | Remove references to packages that don't exist yet (pipeline, retrieval, taxonomy, evidence, worker) |

### 4.3 CLI Architecture

```
apps/cli/src/
├── index.ts              # #!/usr/bin/env node — creates Commander program, registers commands
├── commands/
│   └── config.ts         # config validate | config show
└── lib/
    ├── output.ts         # formatJson(), formatYaml(), formatTable(), stderr()
    └── errors.ts         # withErrorHandler() wrapper, exit codes
```

### 4.4 Entry point (`index.ts`)

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { registerConfigCommands } from './commands/config.js';

const program = new Command()
  .name('mulder')
  .description('Config-driven Document Intelligence Platform')
  .version('0.0.0');

registerConfigCommands(program);

program.parse();
```

### 4.5 Config commands (`commands/config.ts`)

**`mulder config validate [path]`**
- Calls `loadConfig(path)` from `@mulder/core`
- On success: prints "Config valid." to stdout, exit 0
- On `ConfigValidationError`: prints each issue to stderr (path + message), exit 1
- Optional `--json` flag: outputs validation result as JSON

**`mulder config show [path]`**
- Calls `loadConfig(path)` from `@mulder/core`
- Prints the resolved config (with all defaults applied)
- Default format: JSON (pretty-printed)
- `--format yaml` flag: outputs as YAML
- On error: same error handling as validate

### 4.6 Output utilities (`lib/output.ts`)

- `printJson(data: unknown): void` — `JSON.stringify` with 2-space indent to stdout
- `printYaml(data: unknown): void` — YAML stringify to stdout
- `printSuccess(message: string): void` — green checkmark + message to stderr
- `printError(message: string): void` — red cross + message to stderr

### 4.7 Error handler (`lib/errors.ts`)

```typescript
function withErrorHandler(fn: () => Promise<void>): () => Promise<void>
```

Wraps every command action:
- `ConfigValidationError` → print issues, exit 1
- `MulderError` → print code + message, exit 1
- Unknown error → print "Unexpected error:" + message, exit 2

Exit codes:
- 0: success
- 1: known error (validation, config, pipeline)
- 2: unexpected error (bug)

### 4.8 Package.json changes

```json
{
  "bin": {
    "mulder": "./dist/index.js"
  },
  "dependencies": {
    "@mulder/core": "workspace:*",
    "chalk": "^5.0.0",
    "commander": "^13.0.0",
    "yaml": "^2.7.0"
  }
}
```

Remove all workspace dependencies that don't exist yet (`@mulder/pipeline`, `@mulder/retrieval`, `@mulder/taxonomy`, `@mulder/evidence`, `@mulder/worker`).

### 4.9 tsconfig.json changes

Remove project references to packages that don't exist yet. Keep only `../../packages/core`.

## 5. QA Contract

Tests interact with the CLI through `execFileSync` (subprocess boundary). They never import from `apps/cli/src/`.

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Help output | CLI is built | `mulder --help` | Exits 0, stdout contains "mulder" and "config" |
| QA-02 | Version output | CLI is built | `mulder --version` | Exits 0, stdout contains version string |
| QA-03 | Config validate — valid | Valid `mulder.config.example.yaml` exists | `mulder config validate mulder.config.example.yaml` | Exits 0, stdout contains "valid" (case-insensitive) |
| QA-04 | Config validate — missing file | No file at given path | `mulder config validate /nonexistent.yaml` | Exits non-zero, stderr contains error about file |
| QA-05 | Config validate — invalid YAML | A file with `{{{invalid` content | `mulder config validate <temp-file>` | Exits non-zero, stderr contains error |
| QA-06 | Config validate — schema error | YAML with `project: 123` (wrong type) | `mulder config validate <temp-file>` | Exits non-zero, stderr contains validation error |
| QA-07 | Config show — JSON default | Valid config exists | `mulder config show mulder.config.example.yaml` | Exits 0, stdout is valid JSON, contains `project.name` |
| QA-08 | Config show — YAML format | Valid config exists | `mulder config show mulder.config.example.yaml --format yaml` | Exits 0, stdout is valid YAML, contains `project:` |
| QA-09 | Config validate — JSON output | Valid config exists | `mulder config validate mulder.config.example.yaml --json` | Exits 0, stdout is valid JSON with `valid: true` |
| QA-10 | Config subcommand help | CLI is built | `mulder config --help` | Exits 0, stdout lists "validate" and "show" |
