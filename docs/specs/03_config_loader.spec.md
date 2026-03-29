---
spec: 03
title: Config Loader + Zod Schemas
roadmap_step: M1-A2
functional_spec: ["§4.1"]
scope: single
created: 2026-03-29
issue: https://github.com/mulkatz/mulder/issues/6 https://github.com/mulkatz/mulder/issues/6
---

# Spec 03: Config Loader + Zod Schemas

## 1. Objective

Implement the config loader that reads `mulder.config.yaml`, validates it against a comprehensive Zod schema, fills in sensible defaults for all optional fields, and returns a frozen, typed `MulderConfig` object. After this step, every future CLI command and pipeline step can call `loadConfig()` as its first action and receive a fully validated, strongly typed configuration — or a descriptive `ConfigValidationError` with exact path and message.

## 2. Boundaries

**In scope:**
- Zod schemas for the entire `mulder.config.yaml` structure (all sections from the example config)
- TypeScript types derived from Zod schemas via `z.infer<>`
- Default values for all optional config fields (matching `mulder.config.example.yaml` defaults)
- `loadConfig(path?: string)` function — load, parse, validate, apply defaults, freeze
- `ConfigValidationError` custom error class with Zod issue path + message formatting
- Barrel export from `@mulder/core` so downstream packages can `import { loadConfig, MulderConfig } from '@mulder/core'`
- Unit tests for validation (valid config, missing required fields, invalid values, default application)

**Out of scope:**
- Logger (M1-A4) — config loader uses no logging, just throws on failure
- Database config usage (M1-A6) — schemas defined here, consumed later
- CLI integration (M1-A5) — CLI will call `loadConfig()` later
- Runtime config caching / singleton pattern — config is loaded once per process by the caller
- Config file creation / `mulder config init` — later step
- Custom error class infrastructure (M1-A3) — this spec defines `ConfigValidationError` inline, A3 will establish the broader error pattern

**Architecture constraints:**
- TypeScript strict mode, ESM only
- Zod for all validation — no manual type guards
- Types derived from schemas (`z.infer<>`) — never hand-written interfaces that duplicate schema structure
- Config object returned by `loadConfig()` is `Object.freeze()`-d (deep)
- YAML parsing via `yaml` package (not `js-yaml` — `yaml` has better TypeScript support and YAML 1.2 compliance)
- No `any`, no `as` type assertions

## 3. Dependencies

**Requires:**
- M1-A1 (Monorepo setup) — `@mulder/core` package exists ✅

**Required by:**
- Every subsequent step — all CLI commands and pipeline steps start with `loadConfig()`

**New dependencies to add to `packages/core/package.json`:**
- `zod` — schema validation
- `yaml` — YAML parsing (YAML 1.2 compliant)

## 4. Blueprint

### 4.1 Files

| File | Purpose | Exports |
|------|---------|---------|
| `packages/core/src/config/schema.ts` | Zod schemas for all config sections | `mulderConfigSchema`, all section schemas |
| `packages/core/src/config/defaults.ts` | Default values for optional fields | `CONFIG_DEFAULTS` |
| `packages/core/src/config/types.ts` | TypeScript types derived from Zod | `MulderConfig`, all section types |
| `packages/core/src/config/loader.ts` | `loadConfig()` implementation | `loadConfig` |
| `packages/core/src/config/errors.ts` | `ConfigValidationError` class | `ConfigValidationError` |
| `packages/core/src/config/index.ts` | Barrel export | Re-exports all public API |
| `packages/core/src/index.ts` | Updated barrel | Re-exports from `./config/index.js` |

### 4.2 Schema Structure

The Zod schema mirrors the `mulder.config.example.yaml` structure exactly. All top-level sections:

```
project         — required: name; optional: description, supported_locales
gcp             — required: project_id, region; nested: cloud_sql, storage
dev_mode        — optional boolean, default false
ontology        — required: entity_types (array), relationships (array)
ingestion       — optional, all fields have defaults
extraction      — optional, all fields have defaults
enrichment      — optional, all fields have defaults
entity_resolution — optional, all fields have defaults
deduplication   — optional, all fields have defaults
embedding       — optional, all fields have defaults
retrieval       — optional, all fields have defaults
grounding       — optional, all fields have defaults (v2.0, disabled by default)
analysis        — optional, all fields have defaults (v2.0, disabled by default)
thresholds      — optional, all fields have defaults
pipeline        — optional, all fields have defaults
safety          — optional, all fields have defaults
visual_intelligence — optional, all fields have defaults (Phase 2, disabled by default)
pattern_discovery — optional, all fields have defaults (Phase 2, disabled by default)
```

**Required fields (no defaults — must be in user's config):**
- `project.name`
- `gcp.project_id`
- `gcp.region`
- `gcp.cloud_sql.instance_name`
- `gcp.cloud_sql.database`
- `gcp.storage.bucket`
- `ontology.entity_types` (at least one)
- `ontology.relationships` (can be empty array)

**Exception:** When `dev_mode: true`, the `gcp` section is NOT required (dev mode uses fixtures, no GCP).

### 4.3 Ontology Schema Details

Entity type schema:
- `name`: string (required, used as discriminator)
- `description`: string (required, used in LLM prompts)
- `attributes`: array of `{ name: string, type: "string" | "number" | "boolean" | "date" | "geo_point" | "string[]" }` (optional, defaults to empty)

Relationship schema:
- `name`: string (required, UPPER_SNAKE_CASE convention)
- `source`: string (required, must reference an entity type name)
- `target`: string (required, must reference an entity type name)

**Cross-reference validation (refinement):** After parsing, validate that all relationship `source` and `target` values reference entity type names defined in `ontology.entity_types`. Fail with `ConfigValidationError` if a relationship references a non-existent entity type.

### 4.4 `loadConfig()` Implementation

```typescript
export function loadConfig(path?: string): MulderConfig {
  // 1. Resolve path: argument > MULDER_CONFIG env var > ./mulder.config.yaml
  // 2. Read file (throw ConfigValidationError if not found)
  // 3. Parse YAML (throw ConfigValidationError if invalid YAML)
  // 4. Validate against mulderConfigSchema (Zod .parse())
  //    - Catch ZodError, transform to ConfigValidationError with formatted issues
  // 5. Apply cross-reference validation (ontology relationships → entity types)
  // 6. Deep freeze the result
  // 7. Return typed MulderConfig
}
```

Path resolution order:
1. Explicit `path` argument
2. `MULDER_CONFIG` environment variable
3. `./mulder.config.yaml` (CWD)

### 4.5 `ConfigValidationError`

```typescript
export class ConfigValidationError extends Error {
  public readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(ConfigValidationError.formatMessage(issues));
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }

  private static formatMessage(issues: ConfigIssue[]): string {
    // Format: "Config validation failed:\n  - path.to.field: error message\n  - ..."
  }
}

interface ConfigIssue {
  path: string;     // Dot-separated path like "ontology.entity_types[0].name"
  message: string;  // Human-readable error
  code: string;     // Zod error code or custom code like "invalid_reference"
}
```

### 4.6 Deep Freeze

Utility to recursively `Object.freeze()` the config object. Prevents accidental mutation of shared config state across pipeline steps.

```typescript
function deepFreeze<T extends object>(obj: T): Readonly<T>
```

### 4.7 Integration

**Barrel export chain:**
- `packages/core/src/config/index.ts` re-exports: `loadConfig`, `MulderConfig`, `ConfigValidationError`, `mulderConfigSchema`
- `packages/core/src/index.ts` re-exports from `./config/index.js`

## 5. QA Contract

All conditions must pass for this step to be marked complete.

### QA-01: Valid config loads successfully
- **Given** a valid `mulder.config.yaml` with all required fields
- **When** `loadConfig()` is called
- **Then** it returns a `MulderConfig` object with all fields populated (required + defaults for optional)

### QA-02: Missing required field throws ConfigValidationError
- **Given** a config file missing `project.name`
- **When** `loadConfig()` is called
- **Then** it throws `ConfigValidationError` with an issue pointing to `project.name`

### QA-03: Invalid field type throws ConfigValidationError
- **Given** a config with `ingestion.max_file_size_mb: "not-a-number"`
- **When** `loadConfig()` is called
- **Then** it throws `ConfigValidationError` with the correct path and type error

### QA-04: Default values applied for omitted optional fields
- **Given** a minimal config with only required fields (project, gcp, ontology)
- **When** `loadConfig()` is called
- **Then** the returned config has `dev_mode: false`, `ingestion.max_file_size_mb: 100`, `retrieval.default_strategy: "hybrid"`, etc.

### QA-05: Ontology cross-reference validation
- **Given** a config where a relationship references `source: "nonexistent_type"`
- **When** `loadConfig()` is called
- **Then** it throws `ConfigValidationError` with code `"invalid_reference"` and a message mentioning the invalid type

### QA-06: Config object is frozen
- **Given** a valid config loaded via `loadConfig()`
- **When** a property is assigned (e.g., `config.project.name = "changed"`)
- **Then** it throws a TypeError (strict mode freeze behavior)

### QA-07: File not found throws ConfigValidationError
- **Given** a path to a non-existent file
- **When** `loadConfig("/does/not/exist.yaml")` is called
- **Then** it throws `ConfigValidationError` (not a raw filesystem error)

### QA-08: MULDER_CONFIG environment variable
- **Given** `MULDER_CONFIG` is set to a valid config file path
- **When** `loadConfig()` is called without arguments
- **Then** it loads from the `MULDER_CONFIG` path

### QA-09: Dev mode relaxes GCP requirements
- **Given** a config with `dev_mode: true` and no `gcp` section
- **When** `loadConfig()` is called
- **Then** it succeeds (GCP fields are not required in dev mode)

### QA-10: TypeScript types match schema
- **Given** the exported `MulderConfig` type
- **When** used in TypeScript code
- **Then** all fields are correctly typed (string, number, boolean, arrays, nested objects) with no `any` types
