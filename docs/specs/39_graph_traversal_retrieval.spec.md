---
spec: 39
title: Graph Traversal Retrieval
roadmap_step: M4-E3
functional_spec: "§5.1 (graph traversal SQL), §5.3 (sparse graph degradation)"
scope: single
issue: "https://github.com/mulkatz/mulder/issues/83"
created: 2026-04-07
---

# 39 — Graph Traversal Retrieval

## 1. Objective

Implement the graph traversal retrieval strategy (`graph.ts`) that traverses entity relationships via a recursive CTE with cycle detection and supernode pruning, returning chunks from connected stories ranked by path confidence. This is the third of three retrieval strategies (after vector and fulltext) that feed into RRF fusion (E4).

The strategy takes seed entity IDs, walks the `entity_edges` table up to `max_hops` depth with `NOT e2.id = ANY(t.path)` cycle prevention, prunes supernodes exceeding `supernode_threshold`, and returns the shared `RetrievalResult[]` shape.

## 2. Boundaries

**In scope:**
- `graphSearch()` wrapper in `packages/retrieval/src/graph.ts`
- `GraphSearchOptions` type in `packages/retrieval/src/types.ts`
- `traverseGraph()` repository function in `packages/core/src/database/repositories/graph-traversal.repository.ts` (recursive CTE query)
- Barrel exports in both packages
- Config-driven defaults from `retrieval.strategies.graph.*`

**Out of scope:**
- Entity extraction from natural language queries (step E6 — orchestrator responsibility)
- RRF fusion (E4) and re-ranking (E5)
- Gemini-based entity matching from query text
- CLI `mulder query` command (E6)

**Depends on:**
- `entity_edges` table (migration 005) — exists
- `story_entities` junction table (migration 005) — exists
- `chunks` table (migration 006/007) — exists
- `entities` table (migration 004) — exists
- `retrieval.strategies.graph` config schema — exists (max_hops, supernode_threshold, weight)

## 3. Dependencies

### Requires (must exist before implementation)
- `packages/core/src/database/repositories/edge.repository.ts` — entity_edges access (spec 25, done)
- `packages/core/src/database/repositories/chunk.repository.ts` — chunk types (spec 32, done)
- `packages/core/src/database/repositories/entity.types.ts` — Entity type (spec 24, done)
- `packages/core/src/shared/errors.ts` — RetrievalError + RETRIEVAL_ERROR_CODES (spec 37, done)
- `packages/retrieval/src/types.ts` — RetrievalResult, RetrievalStrategy (spec 37, done)
- Config schema `retrieval.strategies.graph` — max_hops, supernode_threshold (spec 03, done)

### Required by (will consume this)
- E4 — RRF fusion (consumes `graphSearch()` output)
- E6 — Hybrid retrieval orchestrator (calls `graphSearch()` with entity IDs extracted from query)

## 4. Blueprint

### 4.1 New types — `packages/retrieval/src/types.ts`

Add `GraphSearchOptions` alongside existing `VectorSearchOptions` and `FulltextSearchOptions`:

```typescript
/**
 * Options for graphSearch(). Requires seed entity IDs — the orchestrator (E6)
 * is responsible for extracting entities from the user's query text.
 */
export interface GraphSearchOptions {
  /** Seed entity IDs to start traversal from. Required, must be non-empty. */
  entityIds: string[];
  /** Maximum traversal depth. Default: retrieval.strategies.graph.max_hops (2). */
  maxHops?: number;
  /** Maximum total results. Default: retrieval.top_k from config (10). */
  limit?: number;
  /** Skip entities with source_count >= this value. Default: retrieval.strategies.graph.supernode_threshold (100). */
  supernodeThreshold?: number;
  /** Only return chunks from these stories. Optional filter. */
  storyIds?: string[];
}
```

### 4.2 New repository function — `packages/core/src/database/repositories/graph-traversal.repository.ts`

Single function implementing the recursive CTE from §5.1. Returns raw traversal results (entity IDs + path confidence) joined to chunks via `story_entities`.

```typescript
export interface GraphTraversalResult {
  chunk: {
    id: string;
    storyId: string;
    content: string;
    isQuestion: boolean;
  };
  entityId: string;
  entityName: string;
  entityType: string;
  depth: number;
  pathConfidence: number;
}

/**
 * Recursive CTE graph traversal from seed entities → entity_edges → story_entities → chunks.
 *
 * Cycle detection: NOT e2.id = ANY(t.path)
 * Supernode pruning: e2.source_count < $supernodeThreshold
 * Edge type filter: only RELATIONSHIP edges
 *
 * Returns chunks connected to traversed entities, ranked by path_confidence DESC.
 */
export async function traverseGraph(
  pool: pg.Pool,
  seedEntityIds: string[],
  maxHops: number,
  limit: number,
  supernodeThreshold: number,
  filter?: { storyIds?: string[] },
): Promise<GraphTraversalResult[]>
```

The SQL follows the functional spec §5.1 CTE exactly:
- Base case: seed entities
- Recursive step: join entity_edges (RELATIONSHIP type only), cycle detection via path array, supernode pruning via source_count
- After traversal: join story_entities to find stories, join chunks to get content
- Order by path_confidence DESC, DISTINCT ON chunk.id (best confidence wins)
- Apply optional storyIds filter
- LIMIT to hard cap

### 4.3 New wrapper — `packages/retrieval/src/graph.ts`

Follows the exact pattern of `vector.ts` and `fulltext.ts`:

```typescript
export async function graphSearch(
  pool: pg.Pool,
  config: MulderConfig,
  options: GraphSearchOptions,
): Promise<RetrievalResult[]>
```

Responsibilities:
1. Validate input — `entityIds` must be non-empty array
2. Resolve config defaults (maxHops, supernodeThreshold, limit)
3. Call `traverseGraph()` repository function
4. Map results to `RetrievalResult[]` with `strategy: 'graph'`, `score: pathConfidence`
5. Wrap repository errors in `RetrievalError` with `RETRIEVAL_QUERY_FAILED`
6. Log with structured pino (module: `retrieval-graph`)
7. Return empty array (not error) when no connected chunks found

Does NOT need an embedding service (unlike vector search) — operates on entity IDs.

### 4.4 Barrel exports

**`packages/core/src/database/repositories/index.ts`** — add:
```typescript
export { traverseGraph } from './graph-traversal.repository.js';
export type { GraphTraversalResult } from './graph-traversal.repository.js';
```

**`packages/retrieval/src/index.ts`** — add:
```typescript
export { graphSearch } from './graph.js';
export type { GraphSearchOptions } from './types.js';
```

### 4.5 Error handling

- Empty `entityIds` → `RetrievalError` with `RETRIEVAL_INVALID_INPUT`
- No seed entities found in DB → return `[]` (not an error — honest sparse graph behavior per §5.3)
- DB query failure → `RetrievalError` with `RETRIEVAL_QUERY_FAILED`
- All results pruned by supernode threshold → return `[]` (not an error)

### 4.6 Config integration

All defaults come from existing config schema (no config changes needed):
- `config.retrieval.strategies.graph.max_hops` (default: 2)
- `config.retrieval.strategies.graph.supernode_threshold` (default: 100)
- `config.retrieval.top_k` (default: 10)

## 5. QA Contract

### QA-01: Empty seed returns empty array
**Given** an empty entityIds array
**When** `graphSearch()` is called
**Then** it throws `RetrievalError` with code `RETRIEVAL_INVALID_INPUT`

### QA-02: Seed entities with no edges return empty results
**Given** seed entity IDs that exist in `entities` but have no outgoing `RELATIONSHIP` edges in `entity_edges`
**When** `graphSearch()` is called
**Then** it returns `[]` (empty array, not an error)

### QA-03: Single-hop traversal returns connected chunks
**Given** entity A with a RELATIONSHIP edge to entity B, and entity B appears in story S with chunks
**When** `graphSearch(entityIds: [A.id])` is called with `maxHops: 1`
**Then** results contain chunks from story S with `strategy: 'graph'` and `score > 0`

### QA-04: Cycle detection prevents infinite loops
**Given** entities A → B → C → A (circular) in entity_edges
**When** `graphSearch(entityIds: [A.id])` is called with `maxHops: 10`
**Then** each entity appears at most once in the traversal (no duplicates, no hang)

### QA-05: Supernode pruning excludes high-degree entities
**Given** entity A connected to entity B, where B has `source_count >= supernodeThreshold`
**When** `graphSearch(entityIds: [A.id], supernodeThreshold: 5)` is called
**Then** entity B is excluded from traversal results

### QA-06: Max hops limits traversal depth
**Given** a chain A → B → C → D in entity_edges
**When** `graphSearch(entityIds: [A.id], maxHops: 1)` is called
**Then** results include chunks from B's stories but NOT from C's or D's stories

### QA-07: Results are RetrievalResult shaped
**Given** any successful graph search with results
**When** results are returned
**Then** each result has: chunkId (string), storyId (string), content (string), score (number ≥ 0), rank (number ≥ 1), strategy === 'graph', metadata with depth and entityId

### QA-08: Config defaults are applied
**Given** `graphSearch()` called without explicit maxHops/limit/supernodeThreshold
**When** config has `retrieval.strategies.graph.max_hops: 2`, `retrieval.top_k: 10`, `supernode_threshold: 100`
**Then** traversal uses maxHops=2, limit=10, supernodeThreshold=100

### QA-09: storyIds filter limits results
**Given** seed entities connected to stories S1 and S2
**When** `graphSearch(entityIds: [...], storyIds: [S1.id])` is called
**Then** results contain only chunks from S1, not S2

### QA-10: Only RELATIONSHIP edges are traversed
**Given** entity A with edges: RELATIONSHIP to B, DUPLICATE_OF to C, POTENTIAL_CONTRADICTION to D
**When** `graphSearch(entityIds: [A.id])` is called
**Then** results include B's chunks but NOT C's or D's

### QA-11: Path confidence decays with depth
**Given** A → B (confidence 0.9) → C (confidence 0.8)
**When** `graphSearch(entityIds: [A.id], maxHops: 2)` is called
**Then** C's path_confidence = 0.9 * 0.8 = 0.72, which is less than B's 0.9

### QA-12: DB error wrapped in RetrievalError
**Given** a database connection failure
**When** `graphSearch()` is called
**Then** it throws `RetrievalError` with code `RETRIEVAL_QUERY_FAILED`

## 5b. CLI Test Matrix

N/A — this step adds no CLI commands. Graph search is consumed programmatically by the hybrid retrieval orchestrator (E6).
