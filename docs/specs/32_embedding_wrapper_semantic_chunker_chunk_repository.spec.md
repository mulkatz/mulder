---
spec: 32
title: Embedding Wrapper + Semantic Chunker + Chunk Repository
roadmap_step: M4-D1-D3
functional_spec: ["§2.6", "§4.3 (chunks table)", "§5.3"]
scope: single
created: 2026-04-04
issue: https://github.com/mulkatz/mulder/issues/67
---

# Spec 32 — Embedding Wrapper + Semantic Chunker + Chunk Repository

## 1. Objective

Build the three foundational modules needed by the Embed pipeline step (D4): a semantic chunker that splits story Markdown into overlap-aware chunks at paragraph/heading boundaries, an embedding wrapper that batches chunk texts through the existing `EmbeddingService`, and a chunk repository that persists chunks with their pgvector embeddings and auto-generated tsvector for BM25. These modules are building blocks — the orchestrating `execute()` function for the Embed step comes in D4.

## 2. Boundaries

### In scope
- Semantic chunker module: split Markdown by semantic boundaries, configurable chunk size/overlap
- Embedding wrapper: batch embed via `EmbeddingService`, question generation via `LlmService`
- Chunk repository: full CRUD for `chunks` table with pgvector insert/query and FTS query support
- Chunk types (TypeScript interfaces)
- Barrel exports from `packages/pipeline` and `packages/core`

### Out of scope
- The `execute()` function for the Embed step (D4)
- The `mulder embed` CLI command (D4)
- HNSW index tuning (already in migration 008)
- Full-text search wrapper module (D7/E2)
- Vector search wrapper module (E1)
- Retrieval orchestrator (E6)

### CLI commands affected
None — this step creates library modules only.

## 3. Dependencies

### Requires (must exist)
- `packages/core/src/shared/services.ts` — `EmbeddingService` and `LlmService` interfaces (spec 11, 13) ✅
- `packages/core/src/database/migrations/006_chunks.sql` — chunks table DDL (spec 08) ✅
- `packages/core/src/database/migrations/008_indexes.sql` — HNSW + GIN + story indexes (spec 08) ✅
- `packages/core/src/config/schema.ts` — `embedding.*` config section (spec 03) ✅
- `packages/core/src/database/repositories/story.repository.ts` — story lookup (spec 22) ✅

### Required by (future consumers)
- Spec 33 (D4): Embed step `execute()` — orchestrates chunker + wrapper + repository
- Spec 34 (D5): Graph step — reads chunks for dedup (MinHash on embeddings)
- Spec 36 (D7): Full-text search — queries `chunks.fts_vector`
- Spec 37 (E1): Vector search — queries `chunks.embedding`

## 4. Blueprint

### 4.1 Chunk Types — `packages/core/src/database/repositories/chunk.types.ts`

```typescript
export type ChunkRow = {
  id: string;
  story_id: string;
  content: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  embedding: string | null;       // pgvector returns as string '[0.1,0.2,...]'
  fts_vector: string | null;      // tsvector serialized (read-only, generated column)
  is_question: boolean;
  parent_chunk_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
};

export type Chunk = {
  id: string;
  storyId: string;
  content: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  embedding: number[] | null;
  isQuestion: boolean;
  parentChunkId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type CreateChunkInput = {
  storyId: string;
  content: string;
  chunkIndex: number;
  pageStart?: number | null;
  pageEnd?: number | null;
  embedding?: number[] | null;
  isQuestion?: boolean;
  parentChunkId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ChunkFilter = {
  storyId?: string;
  isQuestion?: boolean;
};

/** Result from vector similarity search. */
export type VectorSearchResult = {
  chunk: Chunk;
  distance: number;    // cosine distance (0 = identical, 2 = opposite)
  similarity: number;  // 1 - distance
};

/** Result from full-text search. */
export type FtsSearchResult = {
  chunk: Chunk;
  rank: number;        // ts_rank score
};
```

### 4.2 Chunk Repository — `packages/core/src/database/repositories/chunk.repository.ts`

Plain functions following the same pattern as `story.repository.ts` (pool as first arg, parameterized SQL, `ON CONFLICT` upserts).

**Functions:**

| Function | Signature | SQL Pattern |
|----------|-----------|-------------|
| `createChunk` | `(pool, input: CreateChunkInput) => Promise<Chunk>` | `INSERT ... RETURNING *` |
| `createChunks` | `(pool, inputs: CreateChunkInput[]) => Promise<Chunk[]>` | Batched `INSERT` with `unnest` arrays for performance (50+ chunks per story) |
| `findChunkById` | `(pool, id: string) => Promise<Chunk \| null>` | `SELECT` by PK |
| `findChunksByStoryId` | `(pool, storyId: string, filter?: { isQuestion?: boolean }) => Promise<Chunk[]>` | `WHERE story_id = $1` + optional `is_question` filter, `ORDER BY chunk_index` |
| `findChunksBySourceId` | `(pool, sourceId: string) => Promise<Chunk[]>` | `JOIN stories ON stories.id = chunks.story_id WHERE stories.source_id = $1` |
| `countChunks` | `(pool, filter?: ChunkFilter) => Promise<number>` | `SELECT COUNT(*)` |
| `deleteChunksByStoryId` | `(pool, storyId: string) => Promise<number>` | `DELETE WHERE story_id = $1`, returns deleted count |
| `deleteChunksBySourceId` | `(pool, sourceId: string) => Promise<number>` | `DELETE FROM chunks WHERE story_id IN (SELECT id FROM stories WHERE source_id = $1)` |
| `searchByVector` | `(pool, queryEmbedding: number[], limit: number, filter?: { storyIds?: string[] }) => Promise<VectorSearchResult[]>` | `ORDER BY embedding <=> $1::vector LIMIT $2`, optional `WHERE story_id = ANY($3)` |
| `searchByFts` | `(pool, query: string, limit: number, filter?: { storyIds?: string[] }) => Promise<FtsSearchResult[]>` | `WHERE fts_vector @@ plainto_tsquery('simple', $1) ORDER BY ts_rank(fts_vector, ...) DESC LIMIT $2` |
| `updateChunkEmbedding` | `(pool, chunkId: string, embedding: number[]) => Promise<void>` | `UPDATE chunks SET embedding = $2::vector WHERE id = $1` |

**Key implementation notes:**
- `createChunks` uses a single multi-row INSERT with pgvector cast: `$N::vector(768)`. The dimension comes from config `embedding.storage_dimensions`.
- `embedding` column accepts `null` (chunk can be created first, embedded later).
- Vector search uses `<=>` operator (cosine distance) with HNSW index. Distance → similarity: `1 - distance`.
- FTS search uses `plainto_tsquery('simple', ...)` matching the generated column's `to_tsvector('simple', content)`.
- Parsing pgvector string `[0.1,0.2,...]` to `number[]`: strip brackets, split by comma, parse floats.

### 4.3 Semantic Chunker — `packages/pipeline/src/embed/semantic-chunker.ts`

Splits story Markdown into semantic chunks respecting heading/paragraph boundaries with configurable overlap.

```typescript
export type SemanticChunk = {
  content: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  metadata: {
    headings: string[];           // Active heading hierarchy at chunk start
    entityMentions: string[];     // Entity names mentioned in this chunk
  };
};

export type ChunkerConfig = {
  chunkSizeTokens: number;        // Default: 512
  chunkOverlapTokens: number;     // Default: 50
};

export function chunkStory(
  markdown: string,
  pageStart: number | null,
  pageEnd: number | null,
  config: ChunkerConfig,
): SemanticChunk[];
```

**Algorithm:**
1. Split Markdown into semantic blocks: headings, paragraphs, list items, code blocks.
2. Estimate token count per block (heuristic: `text.length / 4` — close enough for chunking).
3. Greedily accumulate blocks into chunks until `chunkSizeTokens` is reached.
4. On chunk boundary: backtrack to last paragraph/heading break (never split mid-paragraph).
5. Overlap: the next chunk starts `chunkOverlapTokens` worth of text before the current chunk's end boundary.
6. Track heading hierarchy — each chunk records which headings are "in scope" at its start.
7. Page mapping: if source pages are known, interpolate page ranges per chunk based on proportional offset.

**Edge cases:**
- Single block larger than `chunkSizeTokens`: force-split at sentence boundaries (`. `, `! `, `? `).
- Empty story: return empty array.
- Very short story (< `chunkSizeTokens`): return single chunk.

### 4.4 Embedding Wrapper — `packages/pipeline/src/embed/embedding-wrapper.ts`

Higher-level module orchestrating question generation and batch embedding.

```typescript
export type EmbedChunkInput = {
  chunkId: string;
  content: string;
  chunkIndex: number;
};

export type EmbedChunkResult = {
  chunkId: string;
  embedding: number[];
};

export type QuestionResult = {
  parentChunkId: string;
  questions: string[];
};

export type EmbeddingWrapperConfig = {
  questionsPerChunk: number;       // From config: embedding.questions_per_chunk
  batchSize: number;               // From config: rate_limits.batch_size.embeddings (default: 100)
};

/** Embed chunk texts in batches via the EmbeddingService. */
export async function embedChunks(
  embeddingService: EmbeddingService,
  chunks: EmbedChunkInput[],
  batchSize: number,
): Promise<EmbedChunkResult[]>;

/** Generate search questions for each chunk via LlmService. */
export async function generateQuestions(
  llmService: LlmService,
  chunks: EmbedChunkInput[],
  questionsPerChunk: number,
): Promise<QuestionResult[]>;
```

**`embedChunks` implementation:**
1. Split chunks into batches of `batchSize`.
2. For each batch, call `embeddingService.embed(texts)`.
3. Map results back to chunk IDs.
4. Return all results (no partial — the `EmbeddingService` already handles retry).

**`generateQuestions` implementation:**
1. For each chunk, call `llmService.generateStructured()` with a prompt asking for `questionsPerChunk` questions.
2. Prompt: "Given the following text, generate {N} questions that this text could answer. Return as JSON array of strings."
3. Parse response as `string[]`.
4. Return question-to-chunk mapping.

### 4.5 Barrel Exports

**`packages/pipeline/src/embed/index.ts`:**
```typescript
export { chunkStory } from './semantic-chunker.js';
export type { ChunkerConfig, SemanticChunk } from './semantic-chunker.js';
export { embedChunks, generateQuestions } from './embedding-wrapper.js';
export type { EmbedChunkInput, EmbedChunkResult, EmbeddingWrapperConfig, QuestionResult } from './embedding-wrapper.js';
```

**Update `packages/pipeline/src/index.ts`:** Add re-exports from `./embed/index.js`.

**Update `packages/core/src/database/repositories/index.ts`:** Add chunk repository functions and types.

### 4.6 Integration Points

- **Config:** Reads `embedding.chunk_size_tokens`, `embedding.chunk_overlap_tokens`, `embedding.questions_per_chunk` from `MulderConfig`.
- **Services:** Uses `EmbeddingService.embed()` and `LlmService.generateStructured()` from the service registry.
- **Database:** Chunk repository uses the same `pg.Pool` pattern as all other repositories.

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Semantic chunking splits Markdown | A 2000-word Markdown story | `chunkStory()` with default config (512 tokens) | Returns 4-5 chunks, each ≤ 512 tokens, no mid-paragraph splits |
| QA-02 | Chunk overlap works | A multi-chunk story | `chunkStory()` with overlap=50 | Adjacent chunks share ~50 tokens of overlapping text |
| QA-03 | Short story single chunk | A 100-word Markdown story | `chunkStory()` | Returns exactly 1 chunk containing full text |
| QA-04 | Empty story returns empty | Empty string | `chunkStory()` | Returns empty array |
| QA-05 | Heading tracking | Markdown with `## Section` headings | `chunkStory()` | Each chunk's `metadata.headings` reflects active heading hierarchy |
| QA-06 | Chunk repository createChunks | 10 chunk inputs with embeddings | `createChunks()` against test DB | All 10 rows in `chunks` table, `fts_vector` auto-generated |
| QA-07 | Chunk repository findByStoryId | Chunks exist for story X | `findChunksByStoryId(pool, storyX)` | Returns chunks ordered by `chunk_index`, content chunks only |
| QA-08 | Chunk repository deleteByStoryId | Chunks exist for story X | `deleteChunksByStoryId(pool, storyX)` | All chunks (content + questions) deleted, returns count |
| QA-09 | Vector search returns results | Chunks with embeddings exist | `searchByVector(pool, queryVec, 5)` | Returns ≤5 results sorted by cosine similarity descending |
| QA-10 | FTS search returns results | Chunks with text content exist | `searchByFts(pool, "search term", 5)` | Returns ≤5 results with rank scores |
| QA-11 | Embedding wrapper batches | 150 chunk texts, batch size 50 | `embedChunks()` | Calls `EmbeddingService.embed()` exactly 3 times (3 batches) |
| QA-12 | Question generation | 3 chunks, questionsPerChunk=2 | `generateQuestions()` | Returns 3 QuestionResults, each with 2 question strings |
| QA-13 | Cascade delete chunks on story delete | Chunks exist for story X | `DELETE FROM stories WHERE id = storyX` | All chunks for that story are cascade-deleted |
| QA-14 | Question chunks link to parent | Content chunk + question chunks | `createChunks()` with `parentChunkId` | Question chunks reference parent via FK, `is_question=true` |
| QA-15 | Barrel exports accessible | — | Import from `@mulder/pipeline` and `@mulder/core` | All public functions and types resolve without error |

### 5b. CLI Test Matrix

N/A — no CLI commands in this spec.

## 6. Estimation

- **Files created:** 6 (chunk.types.ts, chunk.repository.ts, semantic-chunker.ts, embedding-wrapper.ts, embed/index.ts, plus updates to 2 barrel files)
- **Complexity:** Medium — semantic chunker algorithm is the most complex piece, repository is pattern-following
- **Risk:** pgvector string parsing edge cases; token estimation heuristic accuracy
