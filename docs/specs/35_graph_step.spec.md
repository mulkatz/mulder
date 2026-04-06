---
spec: 35
title: "Graph Step — Dedup + Corroboration + Contradiction Flagging"
roadmap_step: M4-D5
functional_spec: ["§2.7", "§1 (graph cmd)", "§4.3 (entity_edges)", "§4.3.1 (cascading reset)", "§5.3 (sparse graph degradation)", "§14 (dedup before corroboration)"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/73
created: 2026-04-06
---

## 1. Objective

Implement the graph pipeline step (`mulder graph`), the seventh step in the pipeline. It writes entity relationship edges to the knowledge graph, detects near-duplicate stories via MinHash on chunk embeddings, calculates dedup-aware corroboration scores per entity, and flags potential contradictions via attribute diff (no LLM). The graph step is the final step in the v1.0 pipeline before the v2.0 Analyze step.

**Boundaries with embed (D4):** The embed step produces chunks with embeddings. The graph step reads these embeddings for deduplication but does not modify chunks.

**Boundaries with Analyze (v2.0):** The graph step flags `POTENTIAL_CONTRADICTION` edges. The Analyze step (G3) resolves them via Gemini. The graph step does not use any LLM calls.

## 2. Boundaries

**In scope:**
- Graph step execute function (`packages/pipeline/src/graph/index.ts`)
- Graph step types (`packages/pipeline/src/graph/types.ts`)
- Deduplication module (`packages/pipeline/src/graph/dedup.ts`) — MinHash on chunk embeddings
- Corroboration module (`packages/pipeline/src/graph/corroboration.ts`) — dedup-aware source counting
- Contradiction detection module (`packages/pipeline/src/graph/contradiction.ts`) — attribute diff
- `GraphError` class + `GRAPH_ERROR_CODES` in shared errors
- CLI command `mulder graph` with `--all`, `--source`, `--force` flags
- Barrel exports from `packages/pipeline/src/index.ts`
- Config additions: `pipeline.batch_size.graph`

**Out of scope:**
- LLM-based contradiction resolution (Analyze step, G3)
- Community detection / PageRank (Analyze step, G4)
- Evidence chains (Analyze step, G5)
- Web grounding (Ground step, G2)
- MinHash library selection — use `minhash` npm package or implement lightweight version

**CLI commands:**
- `mulder graph <story-id>` — graph a single story
- `mulder graph --all` — graph all stories with status=embedded
- `mulder graph --source <id>` — graph all stories from a source
- `mulder graph --force` — re-graph (cascading reset via `resetPipelineStep(source_id, 'graph')`)

## 3. Dependencies

### Requires (must exist):
- Edge repository (`packages/core/src/database/repositories/edge.repository.ts`) — spec 25 ✅
- Entity repository (`packages/core/src/database/repositories/entity.repository.ts`) — spec 24 ✅
- Story-entity repository (`packages/core/src/database/repositories/story-entity.repository.ts`) — spec 24 ✅
- Chunk repository (`packages/core/src/database/repositories/chunk.repository.ts`) — spec 32 ✅
- Embed step — stories must have status=embedded with chunks — spec 34 ✅
- `resetPipelineStep(source_id, 'graph')` — already handles graph reset (migration 014) ✅
- `updateStoryStatus`, `upsertSourceStep` from core ✅
- Service abstraction (services.firestore for observability) ✅
- Config: `deduplication` section with thresholds ✅

### Consumed by:
- Analyze step (G3-G7) — reads edges, corroboration scores, contradiction flags
- Retrieval graph traversal (E3) — reads entity_edges for graph-based search
- Pipeline orchestrator (D6) — calls graph step in sequence

## 4. Blueprint

### 4.1 Types — `packages/pipeline/src/graph/types.ts`

```typescript
import type { StepError } from '@mulder/core';

/** Input for the graph step execute function. */
export interface GraphInput {
  storyId: string;
  force?: boolean;
}

/** Result data from the graph step. */
export interface GraphData {
  storyId: string;
  edgesCreated: number;
  edgesUpdated: number;
  duplicatesFound: number;
  corroborationUpdates: number;
  contradictionsFlagged: number;
}

/** Full graph step result following StepResult pattern. */
export interface GraphResult {
  status: 'success' | 'partial' | 'failed';
  data: GraphData | null;
  errors: StepError[];
  metadata: {
    duration_ms: number;
    items_processed: number;
    items_skipped: number;
    items_cached: number;
  };
}

/** A duplicate pair detected by MinHash. */
export interface DuplicatePair {
  storyIdA: string;
  storyIdB: string;
  similarity: number;
  duplicateType: 'exact' | 'near' | 'reprint' | 'summary';
}

/** Corroboration result for a single entity. */
export interface CorroborationResult {
  entityId: string;
  independentSourceCount: number;
  corroborationScore: number;
}

/** A potential contradiction between two entity mentions. */
export interface ContradictionCandidate {
  entityId: string;
  storyIdA: string;
  storyIdB: string;
  attribute: string;
  valueA: string;
  valueB: string;
}
```

### 4.2 Dedup module — `packages/pipeline/src/graph/dedup.ts`

Computes MinHash signatures from chunk embeddings to detect near-duplicate stories.

**Algorithm:**
1. For each story, collect chunk embeddings (from `chunks` table)
2. Convert each 768-dim float vector to a set of discrete "shingles" by quantizing: round each dimension to nearest 0.1, concatenate dimension index + quantized value as string tokens
3. Compute MinHash signature (128 hash functions) over the shingle set
4. Compare signatures via Jaccard estimation: `|intersection| / |union|`
5. If similarity ≥ `deduplication.segment_level.similarity_threshold` (default 0.90): return as duplicate pair

**Classify duplicate type:**
- similarity ≥ 0.99 → `exact`
- similarity ≥ 0.95 → `reprint`
- similarity ≥ 0.90 → `near`
- Below threshold → not a duplicate

The `summary` type requires LLM analysis (v2.0 scope) — not assigned in this step.

**Exports:**
- `detectDuplicates(pool, storyId, threshold): Promise<DuplicatePair[]>`

### 4.3 Corroboration module — `packages/pipeline/src/graph/corroboration.ts`

Calculates dedup-aware corroboration scores for entities affected by the current story.

**Algorithm:**
1. Load entities linked to this story via `story_entities`
2. For each entity, find all stories it appears in via `story_entities` join
3. Group stories by `source_id` (each unique source_id = one independent source)
4. Apply dedup filter: if two stories from different sources are linked by a `DUPLICATE_OF` edge, collapse them to one source for counting purposes (config: `deduplication.corroboration_filter.similarity_above_threshold_is_one_source`)
5. `independent_source_count` = number of remaining unique sources after dedup
6. `corroboration_score = min(independent_source_count / min_independent_sources, 1.0)` where `min_independent_sources` defaults to 3
7. Update `entities.source_count` and `entities.corroboration_score` via `updateEntity`

**Sparse graph guard:** If total corpus size < `thresholds.corroboration_meaningful` (default 50), still compute scores but they will naturally be low. The threshold is for API confidence labeling (§5.3), not for blocking computation.

**Exports:**
- `updateCorroborationScores(pool, storyId, config): Promise<CorroborationResult[]>`

### 4.4 Contradiction detection — `packages/pipeline/src/graph/contradiction.ts`

Fast attribute-diff comparison to flag potential contradictions. No LLM.

**Algorithm:**
1. Load entities for this story with their attributes (from `entities.attributes` JSONB)
2. For each entity, find other stories mentioning the same entity
3. Compare key attributes: if the same entity has different values for the same attribute key across different stories, and both values are non-null/non-empty, flag as contradiction
4. Create `POTENTIAL_CONTRADICTION` edge between the two story_entities with:
   - `edge_type: 'POTENTIAL_CONTRADICTION'`
   - `attributes: { attribute, valueA, valueB, storyIdA, storyIdB }`
   - `confidence: null` (to be resolved by Analyze step)

**Exports:**
- `detectContradictions(pool, storyId): Promise<ContradictionCandidate[]>`

### 4.5 Execute function — `packages/pipeline/src/graph/index.ts`

Follows the same pattern as embed step (`packages/pipeline/src/embed/index.ts`):

1. Validate pool exists
2. Load story from DB, validate status ≥ `embedded`
3. Skip if already `graphed` and no `--force`
4. If `--force` and already processed: `forceCleanupStory(storyId, pool, logger)`
5. **Write edges:** Load entities + relationships from `story_entities` join; upsert `entity_edges` via `upsertEdge` for each relationship
6. **Deduplication:** Call `detectDuplicates()` — create `DUPLICATE_OF` edges for matches
7. **Corroboration:** Call `updateCorroborationScores()` — update entity source_count + corroboration_score
8. **Contradiction detection:** Call `detectContradictions()` — create `POTENTIAL_CONTRADICTION` edges
9. Update story status to `graphed`
10. Upsert `source_steps` record
11. Fire-and-forget Firestore observability update
12. Return `GraphResult`

**Force cleanup:**
- Per-story: delete edges for story, reset story status to `embedded`
- Per-source: `resetPipelineStep(pool, sourceId, 'graph')` — deletes all edges for source's stories, resets all to `embedded`

### 4.6 Error codes — `packages/core/src/shared/errors.ts`

```typescript
export const GRAPH_ERROR_CODES = {
  GRAPH_STORY_NOT_FOUND: 'GRAPH_STORY_NOT_FOUND',
  GRAPH_INVALID_STATUS: 'GRAPH_INVALID_STATUS',
  GRAPH_EDGE_WRITE_FAILED: 'GRAPH_EDGE_WRITE_FAILED',
  GRAPH_DEDUP_FAILED: 'GRAPH_DEDUP_FAILED',
  GRAPH_CORROBORATION_FAILED: 'GRAPH_CORROBORATION_FAILED',
  GRAPH_CONTRADICTION_FAILED: 'GRAPH_CONTRADICTION_FAILED',
} as const;

export class GraphError extends MulderError { ... }
```

### 4.7 CLI command — `apps/cli/src/commands/graph.ts`

Mirrors embed CLI command structure exactly:
- `mulder graph <story-id>` — single story
- `mulder graph --all` — all embedded stories
- `mulder graph --source <id>` — all stories from source
- `mulder graph --force` — re-graph with cascading reset
- `--all --force` blocked (too dangerous — use `--source <id> --force`)
- Mutually exclusive: `<story-id>` vs `--all` vs `--source`
- Results table: `Story ID | Edges | Duplicates | Contradictions | Status`
- Summary line with totals

### 4.8 Config addition

Add `graph` to the `batch_size` schema:

```typescript
const batchSizeSchema = z.object({
  extract: z.number().positive().int().default(10),
  segment: z.number().positive().int().default(5),
  embed: z.number().positive().int().default(50),
  graph: z.number().positive().int().default(50),   // NEW
});
```

Add `min_independent_sources` to deduplication or a new `corroboration` config:

```typescript
// In deduplication or as a sibling
const corroborationObj = z.object({
  min_independent_sources: z.number().positive().int().default(3),
});
```

### 4.9 Barrel exports — `packages/pipeline/src/index.ts`

```typescript
export type { GraphData, GraphInput, GraphResult, DuplicatePair, CorroborationResult, ContradictionCandidate } from './graph/index.js';
export { execute as executeGraph, forceCleanupSource as forceCleanupGraphSource } from './graph/index.js';
```

### 4.10 Integration points

- Register `graph` command in `apps/cli/src/index.ts`
- Add `GRAPH_ERROR_CODES`, `GraphError`, `GraphErrorCode` to barrel exports from `@mulder/core`

## 5. QA Contract

### QA-01: Single story graphing
**Given** a story with status `embedded` and entities linked via `story_entities`
**When** `mulder graph <story-id>` is run
**Then** entity_edges are created for the story's relationships, story status becomes `graphed`, and the command exits 0

### QA-02: Batch graphing with --all
**Given** multiple stories with status `embedded`
**When** `mulder graph --all` is run
**Then** all embedded stories are graphed, each moves to status `graphed`

### QA-03: Source-scoped graphing
**Given** a source with multiple embedded stories
**When** `mulder graph --source <id>` is run
**Then** all stories from that source are graphed

### QA-04: Skip already graphed
**Given** a story with status `graphed`
**When** `mulder graph <story-id>` is run without `--force`
**Then** the story is skipped (items_skipped=1), exits 0

### QA-05: Force re-graph
**Given** a story with status `graphed`
**When** `mulder graph <story-id> --force` is run
**Then** existing edges for the story are deleted, new edges created, status reset then set to `graphed`

### QA-06: Source-level force cleanup
**Given** a source with graphed stories
**When** `mulder graph --source <id> --force` is run
**Then** `resetPipelineStep(source_id, 'graph')` is called, all edges deleted, stories reset to `embedded`, then re-graphed

### QA-07: --all --force blocked
**When** `mulder graph --all --force` is run
**Then** the command prints an error and exits 1

### QA-08: Mutual exclusivity
**When** `mulder graph <id> --all` or `mulder graph <id> --source <x>` or `mulder graph --all --source <x>` is run
**Then** the command prints an error and exits 1

### QA-09: Corroboration scoring — dedup-aware
**Given** an entity mentioned in 3 stories across 2 sources, where 2 stories from different sources are linked by `DUPLICATE_OF`
**When** corroboration is calculated
**Then** `independent_source_count` = 1 (the two duplicated stories collapse to one source, leaving only 1 unique independent source)

### QA-10: Contradiction flagging
**Given** an entity with attribute `date: "1947-06-14"` in story A and `date: "1947-07-08"` in story B
**When** the graph step runs
**Then** a `POTENTIAL_CONTRADICTION` edge is created with the conflicting values

### QA-11: Invalid status rejected
**Given** a story with status `enriched` (not yet embedded)
**When** `mulder graph <story-id>` is run
**Then** the command fails with `GRAPH_INVALID_STATUS` error

### QA-12: No arguments
**When** `mulder graph` is run with no arguments and no flags
**Then** the command prints usage help and exits 1

## 5b. CLI Test Matrix

| ID | Command | Expected |
|----|---------|----------|
| CLI-01 | `mulder graph --help` | Shows help text with all options, exits 0 |
| CLI-02 | `mulder graph` (no args) | Error: provide story-id, --all, or --source |
| CLI-03 | `mulder graph <id> --all` | Error: mutually exclusive |
| CLI-04 | `mulder graph --all --force` | Error: not supported |
| CLI-05 | `mulder graph --all --source <id>` | Error: mutually exclusive |
