---
spec: 23
title: Segment Step
roadmap_step: C2
functional_spec: ["§2.3", "§4.4"]
scope: single
created: 2026-04-02
issue: https://github.com/mulkatz/mulder/issues/49
---

# Spec 23 — Segment Step

## 1. Objective

Implement the `mulder segment <source-id>` command — the third pipeline step that takes extracted layout data and page images and identifies individual articles/stories within multi-article documents. Gemini receives page images + layout JSON, identifies story boundaries, and produces per-story Markdown + lean metadata JSON written to GCS. Story records are created in PostgreSQL via the story repository.

This is where documents stop being "pages of text" and become discrete, titled stories with language, category, and page ranges — the atomic unit for all downstream processing (enrich, embed, graph, retrieval).

## 2. Boundaries

### In scope
- Pipeline step module: `packages/pipeline/src/segment/index.ts`
- Input types: `SegmentInput`, output types: `SegmentResult`, `SegmentationData`, `SegmentedStory`
- Loading layout JSON + page images from GCS (`extracted/{doc-id}/`)
- Segmentation prompt template: existing `templates/segment.jinja2` (enhance with page text + layout context)
- Gemini structured output call via `LlmService.generateStructured()` with page images as media
- JSON Schema for segmentation response (Zod → `zod-to-json-schema`)
- Per-story Markdown generation (headings, paragraphs, bold preserved)
- Write to GCS: `segments/{doc-id}/{segment-id}.md` + `segments/{doc-id}/{segment-id}.meta.json`
- Story record creation in PostgreSQL via `createStory()` from story repository
- Source status update: `extracted` → `segmented` (PostgreSQL authoritative)
- Source step tracking via `upsertSourceStep()`
- Firestore observability projection (fire-and-forget)
- CLI command: `mulder segment <source-id>` with `--all`, `--force`
- `--force` deletes existing stories for the source + GCS segment artifacts before re-segmenting
- New error codes for segment-specific failures
- Structured logging (step start/complete, stories found, per-story details)
- Config: uses `extraction.segmentation.model` for Gemini model selection

### Out of scope
- Entity extraction from stories (M3-C8, Enrich step)
- `reset_pipeline_step()` PL/pgSQL function (M3-C9) — `--force` uses application-level cleanup
- Chunking/embedding stories (M4-D1-D4)
- Cost estimation on segment command (M8-I2)
- Multi-format source types (M9) — only PDF sources handled

### Deviation from functional spec
- **`--force` cascading reset:** Like the extract step, `--force` performs application-level cleanup (delete stories + GCS segments) rather than calling `reset_pipeline_step()` which doesn't exist yet (M3-C9). Downstream data (chunks, edges) will be cascade-deleted by PostgreSQL foreign keys when stories are deleted.
- **Prompt template:** The existing `segment.jinja2` template is minimal. This spec enhances it with page text injection and structured output instructions while preserving the existing i18n structure.

## 3. Dependencies

### Requires (must exist)
- `@mulder/core` — story repository (`createStory`, `findStoriesBySourceId`, `deleteStoriesBySourceId`) (spec 22)
- `@mulder/core` — source repository (`findSourceById`, `updateSourceStatus`, `upsertSourceStep`, `findAllSources`)
- `@mulder/core` — service interfaces (`StorageService`, `LlmService`, `FirestoreService`)
- `@mulder/core` — service registry (`createServiceRegistry`)
- `@mulder/core` — config loader (`loadConfig`) with `extraction.segmentation` section
- `@mulder/core` — error classes (`PipelineError`, `ExternalServiceError`)
- `@mulder/core` — logger (`createLogger`, `createChildLogger`)
- `@mulder/core` — prompt template engine (`renderPrompt`)
- `@mulder/pipeline` — extract step (sources must be extracted first, layout.json + page images in GCS)
- `packages/pipeline/src/extract/types.ts` — `LayoutDocument`, `LayoutPage` types
- CLI scaffold in `apps/cli/` with Commander.js
- Prompt template: `packages/core/src/prompts/templates/segment.jinja2`

### Required by (future steps)
- M3-C8: Enrich step — reads stories from DB, loads Markdown from GCS
- M4-D1-D3: Embed step — reads stories for chunking
- M4-D5: Graph step — reads stories for dedup

## 4. Blueprint

### 4.1 Config schema

No new config fields needed. The existing `extraction.segmentation.model` (default: `gemini-2.5-flash`) controls the Gemini model used for segmentation.

### 4.2 New error codes

Add segment-specific error codes to `packages/core/src/shared/errors.ts`:

```typescript
export const SEGMENT_ERROR_CODES = {
  SEGMENT_SOURCE_NOT_FOUND: 'SEGMENT_SOURCE_NOT_FOUND',
  SEGMENT_INVALID_STATUS: 'SEGMENT_INVALID_STATUS',
  SEGMENT_LAYOUT_NOT_FOUND: 'SEGMENT_LAYOUT_NOT_FOUND',
  SEGMENT_LLM_FAILED: 'SEGMENT_LLM_FAILED',
  SEGMENT_STORAGE_FAILED: 'SEGMENT_STORAGE_FAILED',
  SEGMENT_NO_STORIES_FOUND: 'SEGMENT_NO_STORIES_FOUND',
} as const;

export type SegmentErrorCode = (typeof SEGMENT_ERROR_CODES)[keyof typeof SEGMENT_ERROR_CODES];
```

Add `SegmentErrorCode` to the `MulderErrorCode` union. Create `SegmentError extends MulderError`.

### 4.3 Pipeline step types

**File:** `packages/pipeline/src/segment/types.ts`

```typescript
import type { StepError } from '@mulder/core';

export interface SegmentInput {
  sourceId: string;
  force?: boolean;
}

/** A single story identified by Gemini segmentation. */
export interface SegmentedStory {
  id: string;                    // UUID generated for this segment
  title: string;
  subtitle: string | null;
  language: string;              // ISO 639-1
  category: string;
  pageStart: number;
  pageEnd: number;
  dateReferences: string[];      // ISO dates mentioned
  geographicReferences: string[];
  extractionConfidence: number;  // 0-1
  gcsMarkdownUri: string;        // segments/{doc-id}/{segment-id}.md
  gcsMetadataUri: string;        // segments/{doc-id}/{segment-id}.meta.json
}

/** Aggregate segmentation data for a source. */
export interface SegmentationData {
  sourceId: string;
  storyCount: number;
  stories: SegmentedStory[];
}

/** Result of the segment pipeline step. */
export interface SegmentResult {
  status: 'success' | 'partial' | 'failed';
  data: SegmentationData | null;
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;    // Stories created
    items_skipped: number;      // Pages without stories
    items_cached: number;       // LLM cache hits (dev mode)
  };
}
```

### 4.4 Segmentation response schema (Zod)

**File:** `packages/pipeline/src/segment/schema.ts`

Define the Zod schema for the Gemini structured output response, then convert to JSON Schema via `zod-to-json-schema`:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const segmentedStorySchema = z.object({
  title: z.string().describe('The title of the article/story'),
  subtitle: z.string().nullable().describe('Subtitle if present, null otherwise'),
  language: z.string().describe('ISO 639-1 language code (e.g., "de", "en")'),
  category: z.string().describe('Category of the story (e.g., "sighting_report", "editorial", "news")'),
  page_start: z.number().int().describe('First page number (1-indexed) where this story appears'),
  page_end: z.number().int().describe('Last page number (1-indexed) where this story ends'),
  date_references: z.array(z.string()).describe('ISO 8601 dates mentioned in the story'),
  geographic_references: z.array(z.string()).describe('Place names mentioned in the story'),
  confidence: z.number().min(0).max(1).describe('Confidence in story boundary identification (0-1)'),
  content_markdown: z.string().describe('Full story text as Markdown with headings, paragraphs, and formatting preserved'),
});

export const segmentationResponseSchema = z.object({
  stories: z.array(segmentedStorySchema).describe('All identified stories/articles in the document'),
});

export type SegmentationResponse = z.infer<typeof segmentationResponseSchema>;

export function getSegmentationJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(segmentationResponseSchema, {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}
```

### 4.5 Pipeline step module

**File:** `packages/pipeline/src/segment/index.ts`

Exports a single `execute` function following the global step contract:

```typescript
export async function execute(
  input: SegmentInput,
  config: MulderConfig,
  services: Services,
  pool: pg.Pool | undefined,
  logger: Logger,
): Promise<SegmentResult>
```

**`execute()` flow:**

1. **Load source:** `findSourceById(pool, input.sourceId)` — fail with `SEGMENT_SOURCE_NOT_FOUND` if null.
2. **Validate status:** Source must have `status >= 'extracted'`. If already `segmented` (or beyond) and not `--force`, skip with info log. If `--force`, clean up first (see 4.7).
3. **Load layout JSON from GCS:** `services.storage.download(`extracted/${sourceId}/layout.json`)` → parse as `LayoutDocument`. Fail with `SEGMENT_LAYOUT_NOT_FOUND` if not found.
4. **Load page images from GCS:** For each page in layout.pages, download `extracted/${sourceId}/pages/page-${padded}.png` as Buffer. Collect as media array for Gemini.
5. **Build segmentation prompt:**
   - Render `segment.jinja2` template with `{ page_count, has_native_text }` plus inject page text from layout JSON
   - Set system instruction from i18n
6. **Call Gemini structured output:**
   ```typescript
   const response = await services.llm.generateStructured<SegmentationResponse>({
     prompt: renderedPrompt,
     schema: getSegmentationJsonSchema(),
     systemInstruction: i18n.segment.system_role,
     media: pageImages.map(img => ({ mimeType: 'image/png', data: img })),
     responseValidator: (data) => segmentationResponseSchema.parse(data),
   });
   ```
7. **For each identified story:**
   a. Generate UUID (`crypto.randomUUID()`)
   b. Build segment metadata JSON (lean — no content):
      ```json
      {
        "id": "seg-abc123",
        "document_id": "doc-xyz",
        "title": "...",
        "subtitle": null,
        "language": "de",
        "category": "sighting_report",
        "pages": [12, 13, 14],
        "date_references": ["1987-03-15"],
        "geographic_references": ["Bodensee", "Konstanz"],
        "extraction_confidence": 0.92
      }
      ```
   c. Write Markdown to GCS: `services.storage.upload(`segments/${sourceId}/${storyId}.md`, story.content_markdown, 'text/markdown')`
   d. Write metadata JSON to GCS: `services.storage.upload(`segments/${sourceId}/${storyId}.meta.json`, JSON.stringify(metadata), 'application/json')`
   e. Create story record in PostgreSQL via `createStory(pool, { sourceId, title, subtitle, language, category, pageStart, pageEnd, gcsMarkdownUri, gcsMetadataUri, extractionConfidence, metadata: { dateReferences, geographicReferences } })`
8. **Update database:**
   - `updateSourceStatus(pool, sourceId, 'segmented')`
   - `upsertSourceStep(pool, { sourceId, stepName: 'segment', status: 'completed' })`
9. **Firestore observability (fire-and-forget):**
   ```typescript
   services.firestore.setDocument('documents', sourceId, {
     status: 'segmented',
     segmentedAt: new Date().toISOString(),
     storyCount: stories.length,
   }).catch(() => { /* non-fatal */ });
   ```
10. **Return** `SegmentResult` with story details and timing metadata.

**Edge case:** If Gemini returns zero stories, set result status to `'failed'` with `SEGMENT_NO_STORIES_FOUND` error. Do not update source status — leave as `extracted` so the user can re-run with a different prompt or model.

### 4.6 Prompt template enhancement

**File:** `packages/core/src/prompts/templates/segment.jinja2`

Update the existing template to include page text and structured output instructions:

```
{{ i18n.segment.system_role }}

## Document Context
Pages: {{ page_count }}
Has native text: {{ has_native_text }}

## Page Content
{% for page in pages %}
### Page {{ page.pageNumber }}
{{ page.text }}
{% endfor %}

## Task
{{ i18n.segment.task_description }}

## Output Format
{{ i18n.segment.output_format }}

{{ i18n.common.language_instruction }}
{{ i18n.common.json_instruction }}
```

The `pages` variable is injected as an array of `{ pageNumber, text }` from the layout JSON.

### 4.7 Force re-segmentation

When `--force` is passed:
1. Delete all existing stories for the source via `deleteStoriesBySourceId(pool, sourceId)` — PostgreSQL cascading deletes handle chunks, story_entities, entity_edges
2. Delete GCS prefix `segments/${sourceId}/` via `services.storage.list()` + `services.storage.delete()` for each file
3. Update source status back to `extracted` (or let the segment step overwrite)
4. Delete the segment source_step record
5. Proceed with normal segmentation

### 4.8 Batch segmentation (`--all`)

When `--all` is passed instead of a `source-id`:
1. Query all sources with `status = 'extracted'` via `findAllSources(pool, { status: 'extracted' })`
2. Process each source sequentially (respects rate limits)
3. Per-source errors are caught — processing continues for remaining sources
4. Overall result: `success` if all pass, `partial` if some fail, `failed` if all fail

### 4.9 CLI command

**File:** `apps/cli/src/commands/segment.ts`

```
mulder segment <source-id>
  --all               Segment all sources with status=extracted
  --force             Re-segment even if already segmented
```

Thin wrapper following the exact pattern from `extract.ts`:
1. Parse arguments — `source-id` and `--all` are mutually exclusive
2. Load and validate config
3. Get database pool via `getWorkerPool(config)`
4. Create service registry
5. If `--all`: query sources, loop calling `execute()` for each
6. If single source-id: call `execute()` once
7. Format and print results (table: sourceId, stories found, status)
8. Close pools on exit

### 4.10 Package dependencies

Add to `packages/pipeline/package.json`:
- `zod-to-json-schema` — Zod → JSON Schema conversion for Gemini structured output

Note: `zod` is already a dependency of `@mulder/core` and will be available.

### 4.11 Barrel exports

Update `packages/pipeline/src/index.ts`:
```typescript
export type { SegmentInput, SegmentResult, SegmentationData, SegmentedStory } from './segment/index.js';
export { execute as executeSegment } from './segment/index.js';
```

### 4.12 Integration wiring

- `apps/cli/src/commands/segment.ts` — new CLI command file
- `apps/cli/src/index.ts` — register `registerSegmentCommands(program)`
- `packages/core/src/prompts/templates/segment.jinja2` — enhanced template

## 5. QA Contract

Black-box tests interact via CLI execution and database queries only. No imports from `packages/`.

### Conditions

**QA-01: Single source segmentation**
- Given: An extracted source with status `extracted` and layout.json + page images in GCS
- When: `mulder segment <source-id>` is executed
- Then: Exit code 0, source status in database is `segmented`

**QA-02: Stories created in database**
- Given: A successfully segmented source
- When: Querying `stories` table for the source
- Then: At least one story record exists with `source_id` matching, `status = 'segmented'`, non-null `gcs_markdown_uri` and `gcs_metadata_uri`

**QA-03: Story Markdown in GCS**
- Given: A successfully segmented source with stories
- When: Reading the GCS Markdown URI from a story record
- Then: The file exists and contains non-empty Markdown text

**QA-04: Story metadata JSON in GCS**
- Given: A successfully segmented source with stories
- When: Reading the GCS metadata URI from a story record
- Then: The file exists and contains valid JSON with `id`, `document_id`, `title`, `language`, `category`, `pages` array, `extraction_confidence`

**QA-05: Source step tracking**
- Given: A successfully segmented source
- When: Querying `source_steps` for the source
- Then: Row exists with `step_name='segment'`, `status='completed'`

**QA-06: Status validation — rejects non-extracted**
- Given: A source-id that does not exist (or has status < `extracted`)
- When: `mulder segment <invalid-id>` is executed
- Then: Exit code non-zero, output contains error about source not found or invalid status

**QA-07: Already segmented — skip without force**
- Given: A source that is already `segmented`
- When: `mulder segment <source-id>` is executed (no `--force`)
- Then: Exit code 0, output indicates source already segmented, no re-processing occurs

**QA-08: Force re-segmentation**
- Given: A source that is already `segmented` with existing stories
- When: `mulder segment <source-id> --force` is executed
- Then: Exit code 0, old stories are deleted, new stories are created, source status is `segmented`

**QA-09: Batch segmentation (--all)**
- Given: Multiple extracted sources in the database
- When: `mulder segment --all` is executed
- Then: Exit code 0, all extracted sources now have status `segmented`

**QA-10: Story page ranges**
- Given: A successfully segmented source with stories
- When: Querying story records
- Then: Each story has non-null `page_start` and `page_end` where `page_start <= page_end`

**QA-11: Idempotent segmentation with force**
- Given: A source segmented with `--force` twice
- When: Checking the final state
- Then: Source status is `segmented`, stories exist, no duplicate story records

**QA-12: GCS path convention**
- Given: A successfully segmented source
- When: Checking story GCS URIs
- Then: Markdown URIs match pattern `segments/{source-id}/{story-id}.md`, metadata URIs match `segments/{source-id}/{story-id}.meta.json`

### 5b. CLI Test Matrix

| ID | Command | Expected |
|----|---------|----------|
| CLI-01 | `mulder segment --help` | Shows help with `<source-id>`, `--all`, `--force` options |
| CLI-02 | `mulder segment` (no args) | Non-zero exit, error about missing source-id or --all |
| CLI-03 | `mulder segment <id> --all` | Non-zero exit, error about mutual exclusivity |
