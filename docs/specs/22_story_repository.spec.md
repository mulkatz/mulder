---
spec: 22
title: Story Repository — CRUD with GCS URIs
roadmap_step: C1
functional_spec: ["§4.3 (stories table)", "§2.3 (Segment step — story model)"]
scope: single
created: 2026-04-02
issue: https://github.com/mulkatz/mulder/issues/47
---

# 22 — Story Repository

## 1. Objective

Implement a story repository providing full CRUD operations for the `stories` table. Stories represent individual articles/segments extracted from source documents, with content stored in GCS (Markdown + metadata JSON) and only references (GCS URIs) stored in PostgreSQL.

The repository follows the exact same pattern as the source repository: plain functions accepting a `pg.Pool`, parameterized SQL, idempotent inserts via `ON CONFLICT`, and camelCase TypeScript types mapped from snake_case database rows.

## 2. Boundaries

### In Scope
- TypeScript types for stories (`Story`, `CreateStoryInput`, `UpdateStoryInput`, `StoryFilter`, `StoryStatus`)
- CRUD functions: `createStory`, `findStoryById`, `findStoriesBySourceId`, `findAllStories`, `countStories`, `updateStory`, `updateStoryStatus`, `deleteStory`, `deleteStoriesBySourceId`
- Barrel export update in `packages/core/src/database/repositories/index.ts`

### Out of Scope
- GCS read/write operations (that's the Segment step's job — C2)
- Entity relationships (`story_entities` junction — that's C3)
- Chunk operations (`chunks` table — that's D1-D3)
- The Segment step itself (C2)
- No CLI command for this step (repository only)

### CLI commands in scope
N/A — this is a data layer module, not a CLI feature.

## 3. Dependencies

### Requires (must exist)
- `packages/core/src/database/repositories/source.repository.ts` — pattern reference (exists, spec 14)
- `packages/core/src/shared/errors.ts` — `DatabaseError`, `DATABASE_ERROR_CODES` (exists, spec 04)
- `packages/core/src/shared/logger.ts` — `createLogger`, `createChildLogger` (exists, spec 05)
- Migration `003_stories.sql` — `stories` table DDL (exists, spec 08)

### Required by (downstream)
- C2 (Segment step) — writes stories via this repository
- C8 (Enrich step) — reads stories, updates status
- D1-D3 (Embed) — reads stories for chunking
- D5 (Graph step) — reads stories for dedup
- E6 (Retrieval) — reads stories for RAG context

## 4. Blueprint

### 4.1 Files to create

#### `packages/core/src/database/repositories/story.types.ts`

Type definitions mirroring the `stories` table schema:

```typescript
/** Story status lifecycle. */
export type StoryStatus = 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';

/** A story record from the database. */
export interface Story {
  id: string;
  sourceId: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  category: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  gcsMarkdownUri: string;
  gcsMetadataUri: string;
  chunkCount: number;
  extractionConfidence: number | null;
  status: StoryStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a new story. */
export interface CreateStoryInput {
  sourceId: string;
  title: string;
  subtitle?: string;
  language?: string;
  category?: string;
  pageStart?: number;
  pageEnd?: number;
  gcsMarkdownUri: string;
  gcsMetadataUri: string;
  extractionConfidence?: number;
  metadata?: Record<string, unknown>;
}

/** Input for updating a story. Partial — only provided fields are updated. */
export interface UpdateStoryInput {
  title?: string;
  subtitle?: string;
  language?: string;
  category?: string;
  pageStart?: number;
  pageEnd?: number;
  gcsMarkdownUri?: string;
  gcsMetadataUri?: string;
  chunkCount?: number;
  extractionConfidence?: number;
  status?: StoryStatus;
  metadata?: Record<string, unknown>;
}

/** Filters for querying stories. */
export interface StoryFilter {
  sourceId?: string;
  status?: StoryStatus;
  category?: string;
  language?: string;
  limit?: number;
  offset?: number;
}
```

#### `packages/core/src/database/repositories/story.repository.ts`

Repository functions following the source repository pattern:

| Function | Signature | SQL pattern |
|----------|-----------|-------------|
| `createStory` | `(pool, input: CreateStoryInput) => Promise<Story>` | INSERT ... ON CONFLICT (id) DO UPDATE SET updated_at = now() RETURNING * |
| `findStoryById` | `(pool, id: string) => Promise<Story \| null>` | SELECT * WHERE id = $1 |
| `findStoriesBySourceId` | `(pool, sourceId: string) => Promise<Story[]>` | SELECT * WHERE source_id = $1 ORDER BY page_start, created_at |
| `findAllStories` | `(pool, filter?: StoryFilter) => Promise<Story[]>` | SELECT with dynamic WHERE + ORDER BY created_at DESC + LIMIT/OFFSET |
| `countStories` | `(pool, filter?: StoryFilter) => Promise<number>` | SELECT COUNT(*) with same dynamic WHERE as findAllStories |
| `updateStory` | `(pool, id: string, input: UpdateStoryInput) => Promise<Story>` | UPDATE ... SET ... WHERE id = $1 RETURNING * |
| `updateStoryStatus` | `(pool, id: string, status: StoryStatus) => Promise<Story>` | UPDATE stories SET status = $1, updated_at = now() WHERE id = $2 |
| `deleteStory` | `(pool, id: string) => Promise<boolean>` | DELETE WHERE id = $1 |
| `deleteStoriesBySourceId` | `(pool, sourceId: string) => Promise<number>` | DELETE WHERE source_id = $1, returns count of deleted rows |

Key implementation details:
- Row mapper: `StoryRow` (snake_case) → `Story` (camelCase), same pattern as `mapSourceRow`
- Logger: `createChildLogger(logger, { module: 'story-repository' })`
- All errors wrapped in `DatabaseError` with `DATABASE_ERROR_CODES.DB_QUERY_FAILED` or `DB_NOT_FOUND`
- `createStory` is idempotent — uses `ON CONFLICT (id) DO UPDATE SET updated_at = now()` since stories don't have a natural unique key like file_hash. The segment step generates UUIDs and may re-run.
- `findStoriesBySourceId` orders by `page_start ASC NULLS LAST, created_at ASC` (stories from same source should appear in page order)
- `findAllStories` supports filtering by `sourceId`, `status`, `category`, `language`
- `deleteStoriesBySourceId` is critical for `--force` re-segmentation (delete all stories for a source before re-creating)

### 4.2 Files to modify

#### `packages/core/src/database/repositories/index.ts`

Add story repository exports:

```typescript
export {
  createStory,
  findStoryById,
  findStoriesBySourceId,
  findAllStories,
  countStories,
  updateStory,
  updateStoryStatus,
  deleteStory,
  deleteStoriesBySourceId,
} from './story.repository.js';
export type {
  CreateStoryInput,
  Story,
  StoryFilter,
  StoryStatus,
  UpdateStoryInput,
} from './story.types.js';
```

### 4.3 Database

No new migrations — `003_stories.sql` already creates the table with all required columns and the `idx_stories_source` + `idx_stories_status` indexes (created in `008_indexes.sql`).

### 4.4 Config changes

None.

### 4.5 Integration points

- The repository is consumed by pipeline steps (Segment, Enrich, Embed, Graph) and retrieval modules
- All access is through the barrel export at `packages/core/src/database/repositories/index.ts`
- The barrel re-exports through `packages/core/src/database/index.ts` → `packages/core/src/index.ts`

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Create story | A valid `CreateStoryInput` with sourceId, title, GCS URIs | `createStory(pool, input)` is called | Returns a `Story` with generated UUID, status `segmented`, chunkCount 0 |
| QA-02 | Create story idempotent | A story with a specific ID already exists | `createStory` is called with the same ID (re-segment scenario) | Returns the existing story with updated `updated_at`, no duplicate |
| QA-03 | Find by ID | A story exists in the database | `findStoryById(pool, id)` is called | Returns the `Story` with correct camelCase mapping |
| QA-04 | Find by ID not found | No story with the given ID | `findStoryById(pool, 'nonexistent')` | Returns `null` |
| QA-05 | Find by source ID | Multiple stories exist for a source | `findStoriesBySourceId(pool, sourceId)` | Returns stories ordered by page_start ASC |
| QA-06 | Find all with filters | Stories with different statuses and categories | `findAllStories(pool, { status: 'segmented', limit: 10 })` | Returns only matching stories, respects limit |
| QA-07 | Count stories | Stories exist with mixed statuses | `countStories(pool, { status: 'segmented' })` | Returns correct count matching filter |
| QA-08 | Update story | A story exists | `updateStory(pool, id, { title: 'New Title' })` | Returns updated story, `updated_at` changed |
| QA-09 | Update story not found | No story with given ID | `updateStory(pool, 'nonexistent', { title: 'X' })` | Throws `DatabaseError` with code `DB_NOT_FOUND` |
| QA-10 | Update status | A story with status `segmented` | `updateStoryStatus(pool, id, 'enriched')` | Returns story with new status, `updated_at` changed |
| QA-11 | Delete story | A story exists | `deleteStory(pool, id)` | Returns `true`, story no longer findable |
| QA-12 | Delete story not found | No story with given ID | `deleteStory(pool, 'nonexistent')` | Returns `false` |
| QA-13 | Delete by source ID | 3 stories exist for a source | `deleteStoriesBySourceId(pool, sourceId)` | Returns 3, all stories deleted |
| QA-14 | TypeScript types export | Package is built | Import `Story`, `StoryStatus`, `CreateStoryInput` from `@mulder/core` | Types are available, no compile error |

### 5b. CLI Test Matrix

N/A — no CLI commands in this step.
