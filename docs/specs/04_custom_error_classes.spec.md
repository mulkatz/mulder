---
spec: "04"
title: Custom error classes with typed error codes
roadmap_step: M1-A3
functional_spec: ["§7.1", "§7.2"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/8
created: 2026-03-29
---

## 1. Objective

Establish a structured error hierarchy for the Mulder platform. A base `MulderError` class with a mandatory `code` string and optional `context` record, plus domain-specific subclasses (`ConfigError`, `PipelineError`, `DatabaseError`, `ExternalServiceError`). All error codes are defined as a typed union so consumers can switch on `error.code` safely. The existing `ConfigValidationError` is migrated to extend `ConfigError` instead of bare `Error`.

## 2. Boundaries

**In scope:**
- Base `MulderError` class with `code`, `context`, and `cause` support
- Four domain subclasses: `ConfigError`, `PipelineError`, `DatabaseError`, `ExternalServiceError`
- Typed error code constants matching §7.2
- Migration of existing `ConfigValidationError` to extend `ConfigError`
- Barrel exports from `packages/core`

**Out of scope:**
- Retry logic (M1-A10, §7.3)
- Rate limiter (M1-A10)
- Logger integration (M1-A4)
- Service abstraction (M1-A10)
- Actual usage in pipeline steps (M2+)

## 3. Dependencies

### Requires
- M1-A1 (monorepo setup) — 🟢
- M1-A2 (config loader) — 🟢 (existing `ConfigValidationError` will be migrated)

### Enables
- M1-A4 (logger) — structured errors feed pino serializers
- M1-A5 (CLI) — CLI error handler maps error codes to exit codes and user messages
- M1-A10 (service abstraction, retry) — `ExternalServiceError` used by retry wrapper
- All pipeline steps (M2+) — `PipelineError` for step failures

## 4. Blueprint

### 4.1 Files

| Action | Path | Purpose |
|--------|------|---------|
| Create | `packages/core/src/shared/errors.ts` | Base `MulderError`, domain subclasses, error code constants |
| Modify | `packages/core/src/config/errors.ts` | `ConfigValidationError` extends `ConfigError` instead of `Error` |
| Modify | `packages/core/src/config/index.ts` | Re-export from shared errors if needed |
| Modify | `packages/core/src/index.ts` | Export all error classes and types from barrel |

### 4.2 Error class hierarchy

```typescript
// packages/core/src/shared/errors.ts

export class MulderError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, options?: {
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = 'MulderError';
    this.code = code;
    this.context = options?.context;
  }
}

export class ConfigError extends MulderError {
  constructor(message: string, code: ConfigErrorCode, options?: {
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(message, code, options);
    this.name = 'ConfigError';
  }
}

export class PipelineError extends MulderError {
  constructor(message: string, code: PipelineErrorCode, options?: {
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(message, code, options);
    this.name = 'PipelineError';
  }
}

export class DatabaseError extends MulderError {
  constructor(message: string, code: DatabaseErrorCode, options?: {
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(message, code, options);
    this.name = 'DatabaseError';
  }
}

export class ExternalServiceError extends MulderError {
  constructor(message: string, code: ExternalServiceErrorCode, options?: {
    context?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(message, code, options);
    this.name = 'ExternalServiceError';
  }
}
```

### 4.3 Error codes

Typed union constants matching §7.2:

```typescript
// Config domain
export const CONFIG_ERROR_CODES = {
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
} as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[keyof typeof CONFIG_ERROR_CODES];

// Pipeline domain
export const PIPELINE_ERROR_CODES = {
  PIPELINE_SOURCE_NOT_FOUND: 'PIPELINE_SOURCE_NOT_FOUND',
  PIPELINE_WRONG_STATUS: 'PIPELINE_WRONG_STATUS',
  PIPELINE_STEP_FAILED: 'PIPELINE_STEP_FAILED',
  PIPELINE_RATE_LIMITED: 'PIPELINE_RATE_LIMITED',
} as const;

export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[keyof typeof PIPELINE_ERROR_CODES];

// Database domain
export const DATABASE_ERROR_CODES = {
  DB_CONNECTION_FAILED: 'DB_CONNECTION_FAILED',
  DB_MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
} as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[keyof typeof DATABASE_ERROR_CODES];

// External service domain
export const EXTERNAL_SERVICE_ERROR_CODES = {
  EXT_DOCUMENT_AI_FAILED: 'EXT_DOCUMENT_AI_FAILED',
  EXT_VERTEX_AI_FAILED: 'EXT_VERTEX_AI_FAILED',
  EXT_STORAGE_FAILED: 'EXT_STORAGE_FAILED',
} as const;

export type ExternalServiceErrorCode = (typeof EXTERNAL_SERVICE_ERROR_CODES)[keyof typeof EXTERNAL_SERVICE_ERROR_CODES];

// Taxonomy domain (used by M3+, defined here for completeness)
export const TAXONOMY_ERROR_CODES = {
  TAXONOMY_BOOTSTRAP_TOO_FEW: 'TAXONOMY_BOOTSTRAP_TOO_FEW',
} as const;

export type TaxonomyErrorCode = (typeof TAXONOMY_ERROR_CODES)[keyof typeof TAXONOMY_ERROR_CODES];

// Union of all codes
export type MulderErrorCode =
  | ConfigErrorCode
  | PipelineErrorCode
  | DatabaseErrorCode
  | ExternalServiceErrorCode
  | TaxonomyErrorCode;
```

### 4.4 ConfigValidationError migration

`ConfigValidationError` currently extends `Error`. Migrate it to extend `ConfigError`:

```typescript
// packages/core/src/config/errors.ts
import { ConfigError } from '../shared/errors.js';
import type { ConfigIssue } from './types.js'; // move interface if needed

export class ConfigValidationError extends ConfigError {
  public readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      ConfigValidationError.formatMessage(issues),
      'CONFIG_INVALID',
      { context: { issueCount: issues.length } }
    );
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }

  private static formatMessage(issues: readonly ConfigIssue[]): string {
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    return `Config validation failed:\n${lines.join('\n')}`;
  }
}
```

### 4.5 Barrel exports

`packages/core/src/index.ts` exports:
- `MulderError`, `ConfigError`, `PipelineError`, `DatabaseError`, `ExternalServiceError`
- All error code constant objects and their type aliases
- `MulderErrorCode` union type
- `ConfigValidationError` (already exported, no change needed for consumers)
- `ConfigIssue` interface

### 4.6 Type guards (convenience)

```typescript
export function isMulderError(error: unknown): error is MulderError {
  return error instanceof MulderError;
}

export function isRetryableError(error: unknown): boolean {
  return (
    error instanceof ExternalServiceError ||
    (error instanceof PipelineError && error.code === 'PIPELINE_RATE_LIMITED')
  );
}
```

## 5. QA Contract

All conditions are testable via black-box imports from `@mulder/core`.

| ID | Condition | Given / When / Then |
|----|-----------|---------------------|
| QA-01 | MulderError has code and context | Given a `new MulderError('msg', 'CONFIG_INVALID', { context: { path: 'x' } })`, then `error.code === 'CONFIG_INVALID'` and `error.context.path === 'x'` and `error instanceof Error` |
| QA-02 | Domain subclasses are instanceof MulderError | Given `new ConfigError(...)`, `new PipelineError(...)`, `new DatabaseError(...)`, `new ExternalServiceError(...)`, then all are `instanceof MulderError` and `instanceof Error` |
| QA-03 | Subclasses enforce typed codes | Given `new ConfigError('msg', 'CONFIG_NOT_FOUND')`, then `error.code === 'CONFIG_NOT_FOUND'`. TypeScript should enforce that only `ConfigErrorCode` values are accepted. |
| QA-04 | ConfigValidationError extends ConfigError | Given a `new ConfigValidationError([{ path: 'a.b', message: 'bad', code: 'invalid_type' }])`, then `error instanceof ConfigError` and `error instanceof MulderError` and `error.code === 'CONFIG_INVALID'` |
| QA-05 | Error cause chain works | Given `new PipelineError('step failed', 'PIPELINE_STEP_FAILED', { cause: new Error('root') })`, then `error.cause instanceof Error` and `error.cause.message === 'root'` |
| QA-06 | isMulderError type guard | Given a `MulderError` and a plain `Error`, then `isMulderError(mulderErr) === true` and `isMulderError(plainErr) === false` |
| QA-07 | isRetryableError identifies retryable errors | Given an `ExternalServiceError` and a `PipelineError` with code `PIPELINE_RATE_LIMITED`, then both return `true`. A `ConfigError` returns `false`. |
| QA-08 | Error codes are exported as constants | Given an import of `CONFIG_ERROR_CODES`, `PIPELINE_ERROR_CODES`, `DATABASE_ERROR_CODES`, `EXTERNAL_SERVICE_ERROR_CODES`, then each object contains the expected keys matching §7.2 |
| QA-09 | Error name property is set correctly | Given each error subclass, `error.name` matches the class name (`'ConfigError'`, `'PipelineError'`, etc.) |
| QA-10 | Existing config loader still works | Given `loadConfig()` with an invalid config, it still throws `ConfigValidationError` with `.issues` populated. Backward compatible. |
