---
spec: "05"
title: Logger Setup — Pino Structured JSON
roadmap_step: M1-A4
functional_spec: ["§8"]
scope: single
created: 2026-03-29
issue: "https://github.com/mulkatz/mulder/issues/10"
---

# 05 — Logger Setup: Pino Structured JSON

## 1. Objective

Provide a centralized, structured logging module for the Mulder platform using Pino. Every log entry is JSON with mandatory contextual fields (level, timestamp, step, source_id). CLI output uses a separate human-readable formatter to stderr while structured JSON goes to stdout. The logger integrates with the existing error hierarchy so caught `MulderError` instances automatically include `code` and `context` in log output.

## 2. Boundaries

### In scope
- Pino logger factory with project-level defaults
- Child logger creation with bound context (step, source_id, story_id)
- Log levels: debug, info, warn, error (as per §8)
- Human-readable CLI transport (pretty-print to stderr)
- Structured JSON to stdout (production default)
- Error serializer that extracts `code` and `context` from `MulderError`
- `redact` configuration for sensitive fields (api keys, tokens)
- Duration helper for timing pipeline steps

### Out of scope
- CLI output formatting (colors, tables, progress bars) — that's M1-A5
- Log aggregation, shipping, or external sinks
- Request-scoped logging (that's M7 API middleware)

## 3. Dependencies

### Requires
- `@mulder/core` package exists (M1-A1 ✅)
- Custom error classes with `code` + `context` (M1-A3 ✅)

### Required by
- M1-A5 (CLI scaffold) — CLI uses logger for command output
- M1-A6+ (database, pipeline steps) — all modules use the logger
- All future pipeline steps and services

## 4. Blueprint

### 4.1 Files

| Action | Path | Purpose |
|--------|------|---------|
| Create | `packages/core/src/shared/logger.ts` | Logger factory, child logger creation, error serializer, duration helper |
| Modify | `packages/core/src/index.ts` | Re-export logger factory and types |
| Modify | `packages/core/package.json` | Add `pino` + `pino-pretty` dependencies |

### 4.2 Logger factory (`logger.ts`)

**`createLogger(options?)`** — creates a root Pino instance with Mulder defaults:
- `level`: from `MULDER_LOG_LEVEL` env var, default `"info"`
- `timestamp`: ISO 8601 format (`pino.stdTimeFunctions.isoTime`)
- `formatters.level`: output level as string label, not number
- `serializers.err`: custom serializer that extracts `code` and `context` from `MulderError`
- `redact`: paths array for sensitive fields (`["config.gcp.credentials", "*.api_key", "*.token", "*.secret"]`)
- Transport: when `MULDER_LOG_PRETTY=true` or stderr is a TTY in development, use `pino-pretty` targeting stderr. Otherwise, structured JSON to stdout.

**`createChildLogger(parent, context)`** — creates a child with bound fields:
- `step`: pipeline step name (e.g., `"ingest"`, `"extract"`, `"enrich"`)
- `source_id`: current document ID (optional)
- `story_id`: current story ID (optional)
- Additional arbitrary context fields

**`withDuration(logger, message, fn)`** — async helper that:
1. Records `performance.now()` start
2. Awaits `fn()`
3. Logs at `info` level with `duration_ms` field (rounded to integer)
4. Returns the function's result
5. On error: logs at `error` level with `duration_ms` and re-throws

**Type exports:**
- `Logger` — the Pino logger type (re-exported from pino)
- `LoggerOptions` — options for `createLogger`
- `ChildLoggerContext` — typed context for `createChildLogger`

### 4.3 Error serializer

Custom Pino serializer for the `err` key:
- If error is `MulderError`: include `type` (error class name), `message`, `code`, `context`, `stack`
- If error is standard `Error`: include `type`, `message`, `stack`
- Preserves `cause` chain if present

### 4.4 Barrel exports (`index.ts`)

Add to `packages/core/src/index.ts`:
```typescript
export { createLogger, createChildLogger, withDuration } from './shared/logger.js';
export type { Logger, LoggerOptions, ChildLoggerContext } from './shared/logger.js';
```

### 4.5 Dependencies

Add to `packages/core/package.json`:
- `pino: ^9.0.0`
- `pino-pretty: ^13.0.0` (devDependencies — only used in dev/CLI mode)

## 5. QA Contract

All conditions testable without reading implementation internals.

| ID | Condition | Given / When / Then |
|----|-----------|---------------------|
| QA-01 | Logger produces structured JSON | Given a logger created with `createLogger()`, when logging at info level, then stdout receives valid JSON with `level`, `time`, and `msg` fields |
| QA-02 | Log level filtering works | Given `MULDER_LOG_LEVEL=warn`, when logging at info and warn levels, then only warn-level messages appear in output |
| QA-03 | Child logger binds context | Given a child logger created with `{ step: "enrich", source_id: "abc-123" }`, when logging a message, then the output JSON includes `step` and `source_id` fields |
| QA-04 | MulderError serialization includes code and context | Given a caught `ConfigError` with code `CONFIG_NOT_FOUND` and context `{ path: "/missing" }`, when logged via `logger.error({ err }, "msg")`, then the output JSON `err` object contains `code`, `context`, and `type` fields |
| QA-05 | Sensitive fields are redacted | Given a logger, when logging an object containing a field matching a redact path (e.g., `api_key`), then the output shows `[Redacted]` for that field |
| QA-06 | Duration helper logs elapsed time | Given `withDuration()` wrapping an async function, when the function completes, then an info-level log entry includes `duration_ms` as a number |
| QA-07 | Duration helper logs on error | Given `withDuration()` wrapping an async function that throws, then an error-level log entry includes `duration_ms`, and the error is re-thrown |
| QA-08 | Pretty transport targets stderr | Given `MULDER_LOG_PRETTY=true`, when logging, then human-readable output goes to stderr (not stdout) |
| QA-09 | Package exports are accessible | Given `@mulder/core`, when importing `createLogger`, `createChildLogger`, `withDuration`, and type `Logger`, then all resolve without errors |
