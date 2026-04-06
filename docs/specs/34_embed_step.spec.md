---
spec: 34
title: Embed Step
roadmap_step: M4-D4
functional_spec: ["§2.6", "§1 (embed cmd)"]
scope: single
created: 2026-04-06
issue: https://github.com/mulkatz/mulder/issues/71
---

# Spec 34 — Embed Step

## 1. Objective

Build the `execute()` function for the Embed pipeline step and the `mulder embed` CLI command. The execute function orchestrates the existing building blocks (semantic chunker, embedding wrapper, chunk repository — spec 32) into a complete pipeline step: load story Markdown from GCS, chunk it, generate questions, embed everything, persist chunks to PostgreSQL, and update story status to `embedded`. The CLI command provides single-story, batch (`--all`), source-scoped (`--source`), and force-reset (`--force`) modes following the established pattern from the enrich command.

## 2. Boundaries

### In scope
- `execute()` function for the Embed pipeline step (`packages/pipeline/src/embed/index.ts`)
- Embed step types (`packages/pipeline/src/embed/types.ts`)
- `mulder embed` CLI command (`apps/cli/src/commands/embed.ts`)
- Barrel export updates (`packages/pipeline/src/index.ts`, CLI registration)
- Force behavior: `--force` calls `resetPipelineStep(source_id, 'embed')` for source-level, per-story cleanup for single story

### Out of scope
- Semantic chunker, embedding wrapper, chunk repository (spec 32 — already built)
- HNSW index tuning (migration 008 — already exists)
- Full-text search wrapper (D7/E2)
- Vector search wrapper (E1)
- Graph step (D5)

### CLI commands affected
- `mulder embed <story-id>` — new command
- `mulder embed --all` — embed all enriched stories
- `mulder embed --source <id>` — embed all stories from a source
- `mulder embed --force` — re-embed (cascading reset deletes chunks, resets to `enriched`)

## 3. Dependencies

### Requires (must exist)
- `packages/pipeline/src/embed/semantic-chunker.ts` — `chunkStory()` (spec 32) ✅
- `packages/pipeline/src/embed/embedding-wrapper.ts` — `embedChunks()`, `generateQuestions()` (spec 32) ✅
- `packages/core/src/database/repositories/chunk.repository.ts` — `createChunks()`, `deleteChunksByStoryId()`, `deleteChunksBySourceId()` (spec 32) ✅
- `packages/core/src/database/repositories/story.repository.ts` — `findStoryById()`, `findAllStories()`, `findStoriesBySourceId()`, `updateStoryStatus()` (spec 22) ✅
- `packages/core/src/database/repositories/pipeline-reset.ts` — `resetPipelineStep()` (spec 30) ✅
- `packages/core/src/shared/errors.ts` — `EMBED_ERROR_CODES`, `EmbedError` (spec 04, reserved codes for D4) ✅
- `packages/core/src/shared/services.ts` — `EmbeddingService`, `LlmService`, `StorageService`, `FirestoreService` interfaces ✅

### Required by (future consumers)
- Spec 35 (D5): Graph step — requires stories with status `embedded`
- Spec 36 (D6): Pipeline orchestrator — calls `executeEmbed` as part of the full pipeline

## 4. Blueprint

### 4.1 Embed Types — `packages/pipeline/src/embed/types.ts`

```typescript
import type { StepError } from '@mulder/core';

/** Input for the embed pipeline step. */
export interface EmbedInput {
  storyId: string;
  force?: boolean;
}

/** Result from the embed pipeline step. */
export interface EmbedResult {
  status: 'success' | 'partial' | 'failed';
  data: EmbeddingData | null;
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;
    items_skipped: number;
    items_cached: number;
  };
}

/** Embedding data produced by the step. */
export interface EmbeddingData {
  storyId: string;
  chunksCreated: number;
  questionsGenerated: number;
  embeddingsCreated: number;
}
```

### 4.2 Execute Function — `packages/pipeline/src/embed/index.ts`

Add the `execute()` function and `forceCleanupSource()` to the existing barrel file, following the enrich step pattern.

**Function signature:**
```typescript
export async function execute(
  input: EmbedInput,
  config: MulderConfig,
  services: Services,
  pool: pg.Pool | undefined,
  logger: Logger,
): Promise<EmbedResult>;
```

**Process flow:**
1. Validate `pool` exists — throw `EmbedError` with `EMBED_STORY_NOT_FOUND` if missing
2. Load story from DB via `findStoryById(pool, input.storyId)`
3. Validate status — must be at least `enriched`. Valid statuses: `enriched`, `embedded`, `graphed`, `analyzed`
4. Skip if already `embedded` (or beyond) and no `--force`
5. If `--force` and already processed: delete existing chunks for this story via `deleteChunksByStoryId(pool, storyId)`, then reset story status to `enriched`
6. Load story Markdown from GCS via `services.storage.download(story.gcsMarkdownUri)`
7. Semantic chunking: call `chunkStory(markdown, story.pageStart, story.pageEnd, chunkerConfig)` with config from `embedding.chunk_size_tokens` and `embedding.chunk_overlap_tokens`
8. Persist content chunks: call `createChunks(pool, ...)` — each chunk gets a UUID, `is_question=false`, no embedding yet
9. Embed content chunks: call `embedChunks(embeddingService, chunkInputs, batchSize)` using `EmbeddingService` from services
10. Update chunk embeddings: call `updateChunkEmbedding(pool, chunkId, embedding)` for each result
11. Generate questions: call `generateQuestions(llmService, chunkInputs, questionsPerChunk)` using `LlmService` from services
12. Persist question chunks: for each question, call `createChunks(pool, ...)` with `is_question=true`, `parent_chunk_id` pointing to the source chunk
13. Embed question chunks: call `embedChunks(embeddingService, questionInputs, batchSize)` and update embeddings
14. Update story status to `embedded` via `updateStoryStatus(pool, storyId, 'embedded')`
15. Track source step: `upsertSourceStep(pool, { sourceId, stepName: 'embed', status: 'completed' })`
16. Firestore observability (fire-and-forget): write status + metrics to `stories/{storyId}`
17. Return `EmbedResult` with counts

**Error handling:**
- Question generation failures are non-fatal — continue with content chunks only, report in `errors` array
- Embedding failures are fatal — throw `EmbedError` with `EMBED_EMBEDDING_FAILED` (already handled by the wrapper)
- Chunk write failures: catch, add to errors, mark as `partial` if some chunks succeeded

**Force cleanup helpers:**
```typescript
/** Cleanup for single story — delete chunks, reset to enriched. */
async function forceCleanupStory(storyId: string, pool: pg.Pool, logger: Logger): Promise<void>;

/** Cleanup for all stories of a source — uses resetPipelineStep. */
export async function forceCleanupSource(sourceId: string, pool: pg.Pool, logger: Logger): Promise<void>;
```

### 4.3 CLI Command — `apps/cli/src/commands/embed.ts`

Follows the exact pattern of `enrich.ts`:

```typescript
export function registerEmbedCommands(program: Command): void;
```

**Arguments and options:**
- `[story-id]` — optional positional: UUID of story to embed
- `--all` — embed all stories with `status=enriched`
- `--source <id>` — embed all stories from a specific source
- `--force` — re-embed even if already embedded (cascading reset)

**Validation rules (same as enrich):**
- Need at least one target (story-id, --all, or --source)
- story-id and --all/--source are mutually exclusive
- --all and --source are mutually exclusive
- --all --force is not supported (too dangerous — use --source --force)

**Output format:**
```
Story ID                              Chunks     Questions  Embeddings  Status
----------------------------------------------------------------------
<uuid>                                12         24         36          success
```

**Summary line:** `{N} chunks created, {M} questions generated, {K} embeddings stored, {X} skipped, {Y} failed ({Z}ms)`

### 4.4 Barrel Export Updates

**`packages/pipeline/src/embed/index.ts`** — add to existing exports:
```typescript
export { execute } from './index.js';  // the execute function lives in index.ts itself
export { forceCleanupSource } from './index.js';
export type { EmbedInput, EmbedResult, EmbeddingData } from './types.js';
```

**`packages/pipeline/src/index.ts`** — add:
```typescript
export { execute as executeEmbed, forceCleanupSource as forceCleanupEmbedSource } from './embed/index.js';
export type { EmbedInput, EmbedResult, EmbeddingData } from './embed/index.js';
```

**`apps/cli/src/index.ts`** (or main CLI registration) — register `registerEmbedCommands(program)`.

### 4.5 Config Usage

The execute function reads from the existing config schema:
- `config.embedding.chunk_size_tokens` — default 512
- `config.embedding.chunk_overlap_tokens` — default 50
- `config.embedding.questions_per_chunk` — default 2
- `config.pipeline.batch_size.embed` (or `config.rate_limits.batch_size.embeddings`) — default 50

### 4.6 Integration Points

- **Storage:** `services.storage.download()` to load story Markdown from GCS
- **Embedding:** `services.embedding.embed()` via `embedChunks()` wrapper
- **LLM:** `services.llm.generateStructured()` via `generateQuestions()` wrapper
- **Database:** Chunk repository functions + story repository + pipeline reset
- **Firestore:** Write-only observability projection (fire-and-forget)
- **Config:** Via central loader, never parse YAML directly

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Embed step creates chunks | A story with status `enriched` and Markdown in GCS | `mulder embed <story-id>` | Chunks appear in `chunks` table with `is_question=false`, story status becomes `embedded` |
| QA-02 | Question chunks created | A story with Markdown and `questions_per_chunk > 0` | `mulder embed <story-id>` | Question chunks appear with `is_question=true` and `parent_chunk_id` referencing content chunk |
| QA-03 | Embeddings stored | A story with Markdown | `mulder embed <story-id>` | All content and question chunks have non-null `embedding` vectors |
| QA-04 | Skip already embedded | A story with status `embedded` | `mulder embed <story-id>` (no --force) | Returns success with `items_skipped=1`, no new chunks created |
| QA-05 | Force re-embed | A story with status `embedded` and existing chunks | `mulder embed <story-id> --force` | Old chunks deleted, new chunks created, status back to `embedded` |
| QA-06 | Batch embed all enriched | Multiple stories with status `enriched` | `mulder embed --all` | All enriched stories get embedded, stories with other statuses untouched |
| QA-07 | Source-scoped embed | Source with 3 stories (2 enriched, 1 segmented) | `mulder embed --source <id>` | Only the 2 enriched stories get embedded |
| QA-08 | Source-scoped force | Source with embedded stories | `mulder embed --source <id> --force` | `resetPipelineStep` called, all stories re-embedded |
| QA-09 | Invalid status rejected | A story with status `segmented` | `mulder embed <story-id>` | Error: story must be at least `enriched` |
| QA-10 | Source step tracking | A successful embed | `mulder embed <story-id>` | `source_steps` row exists with `step_name='embed'`, `status='completed'` |
| QA-11 | Mutual exclusion validated | No arguments | `mulder embed` | Error message about providing story-id, --all, or --source |
| QA-12 | All-force blocked | — | `mulder embed --all --force` | Error message: not supported, use --source --force |

### 5b. CLI Test Matrix

| ID | Command | Expected |
|----|---------|----------|
| CLI-01 | `mulder embed --help` | Shows usage with story-id, --all, --source, --force options |
| CLI-02 | `mulder embed` (no args) | Error: provide story-id, --all, or --source |
| CLI-03 | `mulder embed <id> --all` | Error: mutually exclusive |
| CLI-04 | `mulder embed --all --source <id>` | Error: mutually exclusive |
| CLI-05 | `mulder embed --all --force` | Error: not supported |

## 6. Estimation

- **Files created:** 2 (types.ts, embed CLI command) + updates to 3 (embed/index.ts, pipeline/index.ts, CLI registration)
- **Complexity:** Medium — orchestration of existing building blocks, follows established enrich step pattern closely
- **Risk:** Low — all building blocks are tested (spec 32), pattern is well-established
