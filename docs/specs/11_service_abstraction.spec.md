---
spec: 11
title: Service Abstraction — Interfaces, Registry, Rate-Limiter, Retry
roadmap_step: M1-A10
functional_spec: §4.5, §4.6, §7.3
scope: single
issue: https://github.com/mulkatz/mulder/issues/22
created: 2026-03-30
---

## 1. Objective

Establish the service abstraction layer that decouples pipeline steps from GCP SDK calls. After this step, pipeline steps can be written against typed interfaces without knowing whether they run against fixtures (dev mode) or real GCP services (production). Additionally, provide shared retry and rate-limiting utilities that all external service calls will use.

This is the final M1 foundation step before M2 introduces real GCP integrations. No GCP SDKs are imported — only the interfaces, dev implementations, registry, and cross-cutting utilities.

## 2. Boundaries

### In scope
- Service interfaces for all GCP-backed services (storage, document AI, LLM, embeddings, firestore)
- Dev-mode implementations that read from `fixtures/` directory
- Service registry that selects dev vs production based on config/env
- Token-bucket rate limiter (generic, per-service)
- Retry utility with exponential backoff + jitter
- Barrel exports from `@mulder/core`

### Out of scope
- `gcp.ts` connection manager (M2-B1 — requires GCP SDK dependencies)
- `services.gcp.ts` production implementations (M2-B1)
- `cost-estimator.ts` (M8-I2)
- `vertex.ts` Vertex AI wrapper (M2-B5)
- `llm-cache.ts` dev-mode LLM cache (M2-B5)
- Actual pipeline step implementations

## 3. Dependencies

### Requires (must exist)
- `packages/core/src/config/` — Config loader + `MulderConfig` type (M1-A2 🟢)
- `packages/core/src/shared/errors.ts` — `ExternalServiceError`, `isRetryableError` (M1-A3 🟢)
- `packages/core/src/shared/logger.ts` — `Logger` type (M1-A4 🟢)
- `fixtures/` directory structure (M1-A9 🟢)

### Enables (future steps depend on this)
- M2-B1: GCP service implementations (`services.gcp.ts`, `gcp.ts`)
- M2-B4+: All pipeline steps use service interfaces via registry
- M2-B5: Vertex AI wrapper uses retry + rate-limiter

## 4. Blueprint

### 4.1 `packages/core/src/shared/services.ts` — Service Interfaces

Defines TypeScript interfaces for every external service. Pipeline steps depend on these interfaces only — never on concrete implementations.

```typescript
// Interfaces to define:
StorageService        // upload, download, exists, list, delete from bucket
DocumentAiService     // processDocument (layout parsing)
LlmService            // generateStructured, generateText, groundedGenerate
EmbeddingService      // embed (batch text → vectors)
FirestoreService      // setDocument, getDocument (observability projection)
```

Each interface uses domain types (not GCP SDK types). Methods return Promises with typed results. Error cases throw `ExternalServiceError`.

Also export a `Services` aggregate type bundling all interfaces, plus `ServiceMode` type (`'dev' | 'gcp'`).

### 4.2 `packages/core/src/shared/services.dev.ts` — Dev-Mode Implementations

Fixture-based implementations of each service interface:

- `DevStorageService` — reads/writes to local `fixtures/` directory instead of GCS
- `DevDocumentAiService` — returns pre-recorded Document AI JSON from `fixtures/extracted/`
- `DevLlmService` — returns pre-recorded Gemini responses from fixtures
- `DevEmbeddingService` — returns pre-recorded embedding vectors from `fixtures/embeddings/`
- `DevFirestoreService` — no-op (logs instead of writing)

Each class receives `fixturesPath` (resolved from project root) and a logger. Methods log at debug level when returning fixture data.

Export `createDevServices(config: MulderConfig, logger: Logger): Services`.

### 4.3 `packages/core/src/shared/registry.ts` — Service Registry

The dependency injector. Selects dev or production implementations based on config.

```typescript
export function createServiceRegistry(config: MulderConfig, logger: Logger): Services
```

Logic:
- If `config.dev_mode === true` OR `process.env.NODE_ENV === 'development'` → `createDevServices()`
- If `process.env.NODE_ENV === 'test'` → `createDevServices()` (tests always use fixtures)
- Otherwise → throw `ConfigError` with code `CONFIG_INVALID` and message indicating that GCP services are not yet implemented (placeholder until M2-B1)

The registry is the ONLY place that decides which implementation to use. Pipeline steps never check `dev_mode` themselves.

### 4.4 `packages/core/src/shared/retry.ts` — Retry with Exponential Backoff

Generic retry utility used by all external service calls.

```typescript
export interface RetryOptions {
  maxAttempts: number;        // default: 3
  backoffBaseMs: number;      // default: 1000
  backoffMaxMs: number;       // default: 30000
  multiplier: number;         // default: 2
  isRetryable?: (error: unknown) => boolean;  // default: isRetryableError from errors.ts
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T>
```

Behavior:
- Exponential backoff: `min(backoffBaseMs * multiplier^attempt, backoffMaxMs)`
- Full jitter: actual delay = `random(0, calculated_delay)` — prevents thundering herd
- Only retries when `isRetryable(error)` returns true (default uses `isRetryableError` from errors.ts)
- Calls `onRetry` callback before each retry (for logging)
- After exhausting retries, throws the last error (preserving original error type)
- Reads defaults from config `pipeline.retry` when available

### 4.5 `packages/core/src/shared/rate-limiter.ts` — Token-Bucket Rate Limiter

Per-service rate limiter to prevent quota exhaustion.

```typescript
export interface RateLimiterOptions {
  maxTokens: number;          // bucket capacity
  refillRate: number;         // tokens per second
  name: string;               // for logging (e.g., "document-ai", "gemini")
}

export class RateLimiter {
  constructor(options: RateLimiterOptions)
  async acquire(tokens?: number): Promise<void>  // waits until tokens available
  tryAcquire(tokens?: number): boolean           // non-blocking, returns false if unavailable
  get availableTokens(): number
}
```

Behavior:
- Token bucket algorithm: starts full, refills at `refillRate` tokens/second
- `acquire()` returns immediately if tokens available, otherwise waits (using setTimeout + Promise)
- `tryAcquire()` returns immediately without blocking
- Tokens are consumed atomically
- No external dependencies — pure TypeScript implementation

### 4.6 Barrel Export Updates

Update `packages/core/src/index.ts` to export:
- All service interfaces and types from `services.ts`
- `createServiceRegistry` from `registry.ts`
- `withRetry` and `RetryOptions` from `retry.ts`
- `RateLimiter` and `RateLimiterOptions` from `rate-limiter.ts`

Do NOT export dev service internals (`createDevServices`, individual `Dev*Service` classes) — they are implementation details accessed only through the registry.

## 5. QA Contract

### QA-01: Registry returns dev services in dev mode
**Given** a config with `dev_mode: true`
**When** `createServiceRegistry(config, logger)` is called
**Then** the returned `Services` object has all service properties defined and non-null

### QA-02: Registry returns dev services in test environment
**Given** `NODE_ENV=test` (regardless of `dev_mode` value)
**When** `createServiceRegistry(config, logger)` is called
**Then** the returned `Services` object has all service properties defined and non-null

### QA-03: Registry throws for production mode without GCP implementation
**Given** a config with `dev_mode: false` and `NODE_ENV=production`
**When** `createServiceRegistry(config, logger)` is called
**Then** it throws a `ConfigError` with code `CONFIG_INVALID`

### QA-04: Retry succeeds after transient failure
**Given** a function that fails twice with a retryable error then succeeds
**When** `withRetry(fn, { maxAttempts: 3 })` is called
**Then** the function is called 3 times and returns the successful result

### QA-05: Retry does not retry on non-retryable errors
**Given** a function that throws a non-retryable error (e.g., `ConfigError`)
**When** `withRetry(fn)` is called
**Then** the error is thrown immediately without retry

### QA-06: Retry throws after exhausting all attempts
**Given** a function that always throws a retryable error
**When** `withRetry(fn, { maxAttempts: 3 })` is called
**Then** the function is called 3 times and the last error is thrown

### QA-07: Rate limiter allows requests within capacity
**Given** a `RateLimiter` with `maxTokens: 5`
**When** `tryAcquire()` is called 5 times
**Then** all 5 return `true`

### QA-08: Rate limiter blocks requests beyond capacity
**Given** a `RateLimiter` with `maxTokens: 2`
**When** `tryAcquire()` is called 3 times without waiting
**Then** the first 2 return `true` and the third returns `false`

### QA-09: Dev storage service reads from fixtures directory
**Given** a `DevStorageService` pointed at the fixtures directory
**When** `exists()` is called for a path that exists in fixtures
**Then** it returns `true`

### QA-10: Dev storage service returns false for missing fixtures
**Given** a `DevStorageService` pointed at the fixtures directory
**When** `exists()` is called for a non-existent path
**Then** it returns `false`

### QA-11: Services type has all required service properties
**Given** the `Services` type exported from `@mulder/core`
**When** a `Services` object is constructed
**Then** it has properties: `storage`, `documentAi`, `llm`, `embedding`, `firestore`

### QA-12: Retry applies exponential backoff with jitter
**Given** a function that fails with retryable errors
**When** `withRetry(fn, { maxAttempts: 3, backoffBaseMs: 100 })` is called
**Then** the `onRetry` callback receives increasing delay values capped by backoffMaxMs

### QA-13: Core package exports service abstraction types
**Given** `@mulder/core` is imported
**When** `createServiceRegistry`, `withRetry`, and `RateLimiter` are accessed
**Then** they are defined and callable
