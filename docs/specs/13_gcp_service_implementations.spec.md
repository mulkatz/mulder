---
spec: 13
title: GCP + Dev Service Implementations
roadmap_step: M2-B1
functional_spec: ["4.5", "4.6"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/26
created: 2026-03-30
---

# 1. Objective

Create the GCP connection manager (`gcp.ts`) and production service implementations (`services.gcp.ts`) that fulfill the service interfaces defined in M1. Wire them into the registry so that `dev_mode: false` activates real GCP API calls. Add the necessary GCP SDK dependencies and config fields (Document AI processor ID).

After this step, the service abstraction layer is complete: dev mode uses fixtures (M1), production mode uses real GCP clients (this step). Pipeline steps remain unchanged — they only see the interfaces.

# 2. Boundaries

**In scope:**
- `gcp.ts` — Connection manager with lazy-initialized singleton GCP SDK clients
- `services.gcp.ts` — GCP implementations of all 5 service interfaces (Storage, DocumentAI, LLM, Embedding, Firestore)
- Registry update — replace the `ConfigError` throw with `createGcpServices()`
- Config schema addition — `gcp.document_ai.processor_id` field
- GCP SDK package dependencies in `packages/core/package.json`
- Barrel export updates in `packages/core/src/index.ts`

**Out of scope:**
- Vertex AI wrapper with concurrency limiter (`vertex.ts`) — B5
- Dev-mode LLM cache (`llm-cache.ts`) — B5
- Prompt template engine — B6
- Repositories (sources, stories, etc.) — B2+
- Actual pipeline step implementations — B4, B7
- Terraform infrastructure — separate milestone
- GCP project setup (manual prerequisite)

# 3. Dependencies

**Requires:**
- Service interfaces (`services.ts`) — M1-A10 (done)
- Dev services (`services.dev.ts`) — M1-A10 (done)
- Registry (`registry.ts`) — M1-A10 (done)
- Rate limiter (`rate-limiter.ts`) — M1-A10 (done)
- Retry utility (`retry.ts`) — M1-A10 (done)
- Config loader + Zod schemas — M1-A2 (done)
- Error classes — M1-A3 (done)
- Logger — M1-A4 (done)

**Required by:**
- B4 (Ingest step) — needs Storage service
- B5 (Vertex AI wrapper) — builds on gcp.ts clients
- B7 (Extract step) — needs DocumentAI + Storage services
- All subsequent pipeline steps

# 4. Blueprint

## 4.1 GCP SDK Dependencies

Add to `packages/core/package.json`:

```json
{
  "@google-cloud/storage": "^7.x",
  "@google-cloud/documentai": "^8.x",
  "@google-cloud/vertexai": "^1.x",
  "@google-cloud/firestore": "^7.x"
}
```

Note: `@google-cloud/vertexai` covers both Gemini generative models and text embeddings via the Vertex AI API. A separate `@google-cloud/aiplatform` package is not required.

## 4.2 Config Schema Addition

Add `document_ai` section to the GCP config schema in `packages/core/src/config/schema.ts`:

```typescript
const documentAiSchema = z.object({
  processor_id: z.string().min(1),
});

const gcpSchema = z.object({
  project_id: z.string().min(1),
  region: z.string().min(1),
  cloud_sql: cloudSqlSchema,
  storage: storageSchema,
  document_ai: documentAiSchema,
});
```

Update `mulder.config.example.yaml` with the new field:

```yaml
gcp:
  project_id: "my-gcp-project"
  region: "europe-west1"
  document_ai:
    processor_id: "abc123def456"  # Document AI Layout Parser processor ID
```

Export `DocumentAiConfig` type from `types.ts` and barrel.

## 4.3 Connection Manager (`gcp.ts`)

File: `packages/core/src/shared/gcp.ts`

Lazy-initialized singleton pattern. Each getter creates the client on first call, returns the cached instance on subsequent calls. Pipeline steps NEVER import this file — only `services.gcp.ts` does.

```typescript
// Lazy singletons — raw SDK clients
export function getStorageClient(): Storage
export function getDocumentAIClient(): DocumentProcessorServiceClient
export function getVertexAI(project: string, location: string): VertexAI
export function getFirestoreClient(project: string): Firestore

// Cleanup for graceful shutdown
export async function closeGcpClients(): Promise<void>
```

Key design points:
- Uses Application Default Credentials (ADC) — no service account JSON in code
- VertexAI and Firestore need project/location at init time — passed from config
- `closeGcpClients()` for graceful shutdown (close Firestore, terminate storage client)
- No PostgreSQL pools here — those live in `database/client.ts` (already implemented in M1)

## 4.4 GCP Service Implementations (`services.gcp.ts`)

File: `packages/core/src/shared/services.gcp.ts`

Five classes implementing the interfaces from `services.ts`. Each class:
- Receives raw SDK clients from `gcp.ts` via constructor injection
- Uses `withRetry` from `retry.ts` for all API calls
- Uses `RateLimiter` from `rate-limiter.ts` for quota management
- Throws `ExternalServiceError` with appropriate error codes on failure
- Logs operations via the injected logger

### GcpStorageService

```typescript
class GcpStorageService implements StorageService {
  constructor(
    private readonly storage: Storage,
    private readonly bucket: string,
    private readonly logger: Logger
  ) {}

  async upload(bucketPath, content, contentType?): Promise<void>
  async download(bucketPath): Promise<Buffer>
  async exists(bucketPath): Promise<boolean>
  async list(prefix): Promise<StorageListResult>
  async delete(bucketPath): Promise<void>
}
```

### GcpDocumentAiService

```typescript
class GcpDocumentAiService implements DocumentAiService {
  constructor(
    private readonly client: DocumentProcessorServiceClient,
    private readonly processorName: string,  // projects/{id}/locations/{region}/processors/{pid}
    private readonly logger: Logger
  ) {}

  async processDocument(pdfContent: Buffer, sourceId: string): Promise<DocumentAiResult>
}
```

Constructs the full processor resource name from config: `projects/${projectId}/locations/${region}/processors/${processorId}`.

### GcpLlmService

```typescript
class GcpLlmService implements LlmService {
  constructor(
    private readonly vertexAi: VertexAI,
    private readonly logger: Logger
  ) {}

  async generateStructured<T>(options: StructuredGenerateOptions): Promise<T>
  async generateText(options: TextGenerateOptions): Promise<string>
  async groundedGenerate(options: GroundedGenerateOptions): Promise<GroundedGenerateResult>
}
```

Uses `vertexAi.getGenerativeModel()` for Gemini calls. Model name defaults to `gemini-2.5-flash`.

### GcpEmbeddingService

```typescript
class GcpEmbeddingService implements EmbeddingService {
  constructor(
    private readonly vertexAi: VertexAI,
    private readonly dimensions: number,
    private readonly logger: Logger
  ) {}

  async embed(texts: string[]): Promise<EmbeddingResult[]>
}
```

Uses `text-embedding-004` via the Vertex AI SDK. Passes `outputDimensionality` parameter (from config, default 768). NEVER truncates vectors manually.

### GcpFirestoreService

```typescript
class GcpFirestoreService implements FirestoreService {
  constructor(
    private readonly firestore: Firestore,
    private readonly logger: Logger
  ) {}

  async setDocument(collection, documentId, data): Promise<void>
  async getDocument(collection, documentId): Promise<Record<string, unknown> | null>
}
```

Write-only projection for observability. Fire-and-forget pattern (log errors, don't throw).

### Factory Function

```typescript
export function createGcpServices(config: MulderConfig, logger: Logger): Services
```

Constructs all GCP clients via `gcp.ts` getters, then creates service instances with retry/rate-limiter wrappers. Returns the `Services` bundle.

## 4.5 Registry Update

File: `packages/core/src/shared/registry.ts`

Replace the `ConfigError` throw in the `gcp` branch with:

```typescript
import { createGcpServices } from './services.gcp.js';

// In createServiceRegistry:
if (mode === 'gcp') {
  return createGcpServices(config, logger);
}
```

The `NODE_ENV=test` guard remains — test mode always uses dev services.

## 4.6 Barrel Export Updates

File: `packages/core/src/index.ts`

Add:
- `closeGcpClients` from `gcp.ts` (for graceful shutdown)
- `DocumentAiConfig` type from config types

## 4.7 File Summary

| Action | File | What |
|--------|------|------|
| Create | `packages/core/src/shared/gcp.ts` | Connection manager |
| Create | `packages/core/src/shared/services.gcp.ts` | GCP service implementations |
| Modify | `packages/core/src/shared/registry.ts` | Wire GCP services |
| Modify | `packages/core/src/config/schema.ts` | Add document_ai config |
| Modify | `packages/core/src/config/types.ts` | Export DocumentAiConfig |
| Modify | `packages/core/src/index.ts` | Barrel exports |
| Modify | `packages/core/package.json` | GCP SDK dependencies |
| Modify | `mulder.config.example.yaml` | Add document_ai section |

# 5. QA Contract

**QA-01: Registry mode selection**
Given `dev_mode: false` and `NODE_ENV` unset, when `createServiceRegistry()` is called, then it returns a `Services` bundle (does not throw `ConfigError`).

**QA-02: Dev mode preserved**
Given `dev_mode: true`, when `createServiceRegistry()` is called, then it returns dev (fixture-based) services, not GCP services.

**QA-03: Test mode blocks GCP**
Given `NODE_ENV=test`, when `createServiceRegistry()` is called, then it returns dev services regardless of `dev_mode` setting.

**QA-04: Config accepts document_ai**
Given a config YAML with `gcp.document_ai.processor_id: "test-processor"`, when `loadConfig()` is called, then validation passes and the field is accessible on the config object.

**QA-05: Config rejects missing processor_id**
Given a config YAML with `gcp.document_ai` present but `processor_id` missing, when `loadConfig()` is called, then it throws a validation error.

**QA-06: GCP services implement interfaces**
Given the `services.gcp.ts` module, when imported, then `createGcpServices()` is exported and returns an object satisfying the `Services` interface (all 5 service properties present).

**QA-07: Build succeeds**
Given all changes applied, when `pnpm turbo run build` is executed, then it completes with zero errors.

**QA-08: Example config valid**
Given the updated `mulder.config.example.yaml`, when loaded with `loadConfig()`, then it passes validation.
