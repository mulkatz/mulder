---
spec: 53
title: Export Commands — graph/stories/evidence
roadmap_step: F5
functional_spec: §1 (export cmd), §5.3 (sparse graph degradation)
scope: single
created: 2026-04-10
issue: https://github.com/mulkatz/mulder/issues/137
---

## 1. Objective

Add the `mulder export` command group with three subcommands (`graph`, `stories`, `evidence`) that export knowledge graph data, stories, and evidence reports in multiple formats. All output goes to stdout (pipeable). This enables interoperability with external tools: Neo4j (Cypher), Gephi/yEd (GraphML), spreadsheets (CSV), and human review (Markdown/JSON).

## 2. Boundaries

### In scope

- `mulder export graph` — nodes (entities) + edges, formats: json, csv, graphml, cypher
- `mulder export stories` — story metadata + content references, formats: json, csv, markdown
- `mulder export evidence` — corroboration scores, contradiction edges, deduplication links, formats: json, csv, markdown
- `--filter` flag on graph export for entity type and edge type filtering
- `--format` flag on all subcommands (default: json)
- Sparse graph degradation: include `confidence` metadata in exports when data is sparse
- All data output to stdout, status messages to stderr

### Out of scope

- Evidence chains, source reliability, spatio-temporal clusters (M6 — Analyze step not yet implemented)
- File output flag (`--output`) — use shell redirection (`> file`)
- Streaming for very large exports — all data loaded into memory
- Import commands (reverse direction)
- Authentication/authorization on exported data

### Depends on

- Entity repository (`findAllEntities`, `findEntitiesByType`) — exists
- Edge repository (`findAllEdges`, `findEdgesByType`) — exists
- Story repository (`findAllStories`) — exists
- Entity alias repository (`findAliasesByEntityId`) — exists
- Story-entity repository (`findEntitiesByStoryId`, `findStoriesByEntityId`) — exists
- Chunk repository (`countChunks`) — exists
- CLI scaffold, output helpers — exists

## 3. Dependencies

### Requires (must exist before implementation)

- `packages/core/src/database/repositories/entity.repository.ts` — entity queries
- `packages/core/src/database/repositories/edge.repository.ts` — edge queries
- `packages/core/src/database/repositories/story.repository.ts` — story queries
- `packages/core/src/database/repositories/entity-alias.repository.ts` — alias lookup
- `packages/core/src/database/repositories/story-entity.repository.ts` — junction queries
- `apps/cli/src/lib/output.ts` — printJson, printError, printSuccess

### Produces (created by this spec)

- `apps/cli/src/commands/export.ts` — CLI command group
- `apps/cli/src/lib/formatters/graph.ts` — graph format converters (GraphML, Cypher, CSV)
- `apps/cli/src/lib/formatters/stories.ts` — stories format converters (Markdown, CSV)
- `apps/cli/src/lib/formatters/evidence.ts` — evidence format converters (Markdown, CSV)
- Registration in `apps/cli/src/index.ts`

## 4. Blueprint

### 4.1 CLI command: `apps/cli/src/commands/export.ts`

```
mulder export graph    --format json|csv|graphml|cypher [--filter type=<type>] [--filter edge=<edge-type>]
mulder export stories  --format json|csv|markdown [--source <id>] [--status <status>]
mulder export evidence --format json|csv|markdown
```

**Command group** registered via `registerExportCommands(program)`.

#### `export graph`

1. Load config, get worker pool
2. Fetch all entities (active only — `taxonomyStatus !== 'merged'`), optionally filtered by `--filter type=<type>`
3. Fetch all edges, optionally filtered by `--filter edge=<edge-type>`
4. Fetch aliases for all entities (batch query)
5. Format output:
   - **json**: `{ nodes: Entity[], edges: EntityEdge[], metadata: { exportedAt, nodeCount, edgeCount } }`
   - **csv**: Two sections separated by blank line — `## Nodes` header row + entity rows, `## Edges` header row + edge rows
   - **graphml**: Valid GraphML XML with `<node>` and `<edge>` elements, entity attributes as `<data>` elements
   - **cypher**: `CREATE` statements for nodes (`:Entity {props}`) and `MERGE`/`CREATE` for relationships. Importable via `neo4j-admin import` or browser console
6. Output to stdout

#### `export stories`

1. Load config, get worker pool
2. Fetch all stories, optionally filtered by `--source <id>` or `--status <status>`
3. For each story, fetch linked entities via story-entity junction
4. Format output:
   - **json**: `{ stories: StoryExport[], metadata: { exportedAt, storyCount } }`
   - **csv**: Flat rows — one per story with entity names joined by semicolons
   - **markdown**: One story per section with title, metadata table, entity list
5. Output to stdout

#### `export evidence`

1. Load config, get worker pool
2. Fetch all entities with `corroborationScore IS NOT NULL`
3. Fetch all contradiction edges (`POTENTIAL_CONTRADICTION`, `CONFIRMED_CONTRADICTION`, `DISMISSED_CONTRADICTION`)
4. Fetch all deduplication edges (`DUPLICATE_OF`)
5. Compute summary statistics
6. Format output:
   - **json**: `{ entities: EvidenceEntity[], contradictions: EntityEdge[], duplicates: EntityEdge[], summary: { ... }, metadata: { exportedAt } }`
   - **csv**: Three sections — entities with scores, contradictions, duplicates
   - **markdown**: Structured report with sections for top corroborated entities, contradictions, and deduplication findings
7. Include sparse graph degradation metadata: if entity count < `thresholds.corroboration_meaningful`, add warning in output

### 4.2 Format converters

Each format converter is a pure function: `(data) => string`. No side effects, no DB calls.

**`apps/cli/src/lib/formatters/graph.ts`**:
- `formatGraphJson(nodes, edges, aliases)` → JSON string
- `formatGraphCsv(nodes, edges)` → CSV string
- `formatGraphMl(nodes, edges, aliases)` → GraphML XML string
- `formatGraphCypher(nodes, edges, aliases)` → Cypher statements string

**`apps/cli/src/lib/formatters/stories.ts`**:
- `formatStoriesJson(stories)` → JSON string
- `formatStoriesCsv(stories)` → CSV string
- `formatStoriesMarkdown(stories)` → Markdown string

**`apps/cli/src/lib/formatters/evidence.ts`**:
- `formatEvidenceJson(data)` → JSON string
- `formatEvidenceCsv(data)` → CSV string
- `formatEvidenceMarkdown(data)` → Markdown string

### 4.3 Data types

```typescript
interface GraphExportNode {
  id: string;
  name: string;
  type: string;
  canonicalId: string | null;
  corroborationScore: number | null;
  sourceCount: number;
  taxonomyStatus: string;
  aliases: string[];
  attributes: Record<string, unknown>;
}

interface GraphExportEdge {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationship: string;
  edgeType: string;
  confidence: number | null;
  storyId: string | null;
  attributes: Record<string, unknown>;
}

interface StoryExport {
  id: string;
  sourceId: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  category: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  status: string;
  chunkCount: number;
  extractionConfidence: number | null;
  entities: Array<{ id: string; name: string; type: string; mentionCount: number }>;
}

interface EvidenceExportData {
  entities: Array<{
    id: string;
    name: string;
    type: string;
    corroborationScore: number;
    sourceCount: number;
  }>;
  contradictions: EntityEdge[];
  duplicates: EntityEdge[];
  summary: {
    totalEntities: number;
    scoredEntities: number;
    avgCorroboration: number;
    contradictionCount: number;
    duplicateCount: number;
    dataReliability: 'insufficient' | 'low' | 'moderate' | 'high';
  };
}
```

### 4.4 Filter parsing

`--filter` accepts `key=value` pairs. Supported keys:
- `type=<entity-type>` — filter nodes by entity type (e.g., `type=person`)
- `edge=<edge-type>` — filter edges by type (e.g., `edge=RELATIONSHIP`, `edge=DUPLICATE_OF`)

Multiple `--filter` flags can be combined: `--filter type=person --filter edge=RELATIONSHIP`.

### 4.5 Integration

- Register `registerExportCommands` in `apps/cli/src/index.ts`
- Import from `@mulder/core` for all repository functions and types
- No new repository functions needed — existing queries suffice
- `findAllEntities` with `EntityFilter` handles type filtering
- `findAllEdges` with `EdgeFilter` handles edge type filtering
- `findAliasesByEntityId` called per entity for graph export (batch if needed)
- `findEntitiesByStoryId` called per story for stories export

### 4.6 GraphML format reference

```xml
<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphstruct.org/graphml"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://graphml.graphstruct.org/graphml
         http://graphml.graphstruct.org/graphml/1.0/graphml.xsd">
  <key id="name" for="node" attr.name="name" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="relationship" for="edge" attr.name="relationship" attr.type="string"/>
  <key id="edgeType" for="edge" attr.name="edgeType" attr.type="string"/>
  <graph id="mulder" edgedefault="directed">
    <node id="entity-uuid">
      <data key="name">Entity Name</data>
      <data key="type">person</data>
    </node>
    <edge id="edge-uuid" source="entity-uuid-1" target="entity-uuid-2">
      <data key="relationship">MENTIONED_WITH</data>
      <data key="edgeType">RELATIONSHIP</data>
    </edge>
  </graph>
</graphml>
```

### 4.7 Cypher format reference

```cypher
// Nodes
CREATE (n:Entity {id: 'uuid', name: 'Entity Name', type: 'person', corroborationScore: 0.85, sourceCount: 3});

// Edges
MATCH (a:Entity {id: 'uuid-1'}), (b:Entity {id: 'uuid-2'})
CREATE (a)-[:MENTIONED_WITH {id: 'edge-uuid', confidence: 0.9, edgeType: 'RELATIONSHIP'}]->(b);
```

## 5. QA Contract

### Conditions

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Graph JSON export | Entities and edges exist in DB | `mulder export graph --format json` | stdout contains valid JSON with `nodes` array, `edges` array, `metadata` object |
| QA-02 | Graph CSV export | Entities and edges exist in DB | `mulder export graph --format csv` | stdout contains CSV with header rows and data rows for both nodes and edges |
| QA-03 | Graph GraphML export | Entities and edges exist in DB | `mulder export graph --format graphml` | stdout contains valid XML with `<graphml>` root, `<node>` and `<edge>` elements |
| QA-04 | Graph Cypher export | Entities and edges exist in DB | `mulder export graph --format cypher` | stdout contains `CREATE` statements for nodes and `MATCH`/`CREATE` for edges |
| QA-05 | Graph filter by type | Multiple entity types exist | `mulder export graph --filter type=person --format json` | Only entities with `type=person` appear in nodes; edges reference only those entities |
| QA-06 | Graph filter by edge type | Multiple edge types exist | `mulder export graph --filter edge=RELATIONSHIP --format json` | Only edges with `edgeType=RELATIONSHIP` appear |
| QA-07 | Stories JSON export | Stories exist in DB | `mulder export stories --format json` | stdout contains valid JSON with `stories` array, each with `entities` sub-array |
| QA-08 | Stories CSV export | Stories exist in DB | `mulder export stories --format csv` | stdout contains CSV with header row and one row per story |
| QA-09 | Stories Markdown export | Stories exist in DB | `mulder export stories --format markdown` | stdout contains Markdown with `#` headers and metadata |
| QA-10 | Stories filter by source | Stories from multiple sources exist | `mulder export stories --source <id> --format json` | Only stories from that source appear |
| QA-11 | Evidence JSON export | Entities with corroboration scores exist | `mulder export evidence --format json` | stdout contains valid JSON with `entities`, `contradictions`, `duplicates`, `summary` |
| QA-12 | Evidence Markdown export | Entities with corroboration scores exist | `mulder export evidence --format markdown` | stdout contains structured Markdown report |
| QA-13 | Evidence sparse warning | < 50 entities (below `corroboration_meaningful`) | `mulder export evidence --format json` | `summary.dataReliability` is `"insufficient"` or `"low"` |
| QA-14 | Default format is JSON | — | `mulder export graph` (no --format) | stdout contains valid JSON |
| QA-15 | Empty database | No entities/stories | `mulder export graph --format json` | Valid JSON with empty arrays, exit code 0, stderr warning |

### 5b. CLI Test Matrix

| ID | Command | Flags | Assert |
|----|---------|-------|--------|
| CLI-01 | `export graph` | `--help` | Shows format options, filter syntax |
| CLI-02 | `export stories` | `--help` | Shows format options, source/status filters |
| CLI-03 | `export evidence` | `--help` | Shows format options |
| CLI-04 | `export graph` | `--format invalid` | Exit code 1, error message about valid formats |
| CLI-05 | `export stories` | `--format invalid` | Exit code 1, error message about valid formats |
| CLI-06 | `export evidence` | `--format invalid` | Exit code 1, error message about valid formats |
| CLI-07 | `export graph` | `--format json` | Exit code 0, valid JSON to stdout |
| CLI-08 | `export stories` | `--format json` | Exit code 0, valid JSON to stdout |
| CLI-09 | `export evidence` | `--format json` | Exit code 0, valid JSON to stdout |
| CLI-10 | `export graph` | `--filter type=person --format json` | Only person entities in output |
| CLI-11 | `export graph` | `--filter edge=DUPLICATE_OF --format json` | Only DUPLICATE_OF edges in output |
