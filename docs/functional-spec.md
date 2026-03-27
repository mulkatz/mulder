# mulder — Functional Specification

## Guiding Principles

1. **CLI-first** — Every capability is a CLI command. The API is a job producer, not a direct executor (see [Section 10: Job Queue](#10-job-queue--worker-architecture)).
2. **Each step standalone** — Every pipeline step runs independently with explicit inputs/outputs. No step assumes another ran before it (beyond its declared dependencies).
3. **Full pipeline composes steps** — `mulder pipeline run` chains steps together. The composition is config-driven — skip disabled steps, retry failed ones.
4. **Idempotent inserts, cascading resets** — New data uses `ON CONFLICT DO UPDATE`. But `--force` re-runs are NOT simple upserts — they trigger a cascading delete of all downstream data before rewriting (see [Section 3.4: Force Re-runs](#34-force-re-runs--cascading-reset)). Without this, orphaned stories, chunks, and embeddings corrupt search results.
5. **Config as contract** — `mulder.config.yaml` is the single source of truth for domain logic. Pipeline steps read it, never hardcode domain assumptions.
6. **Cost-aware by default** — Document AI costs ~$10/1000 pages, Gemini tokens add up fast during prompt iteration. Every external API call must be skippable (native text detection), cacheable (dev-mode LLM cache), or batchable. The spec must make the cheap path the default path.
7. **Defensive SQL** — Recursive CTEs must have cycle detection. Concurrent entity writes must be ordered to prevent deadlocks. Vector indexes must handle incremental inserts (HNSW, not ivfflat).

---

## 1. CLI Command Tree

```
mulder
├── config
│   ├── validate          # Validate mulder.config.yaml against Zod schema
│   ├── show              # Print resolved config (with defaults filled in)
│   └── init              # Generate mulder.config.yaml from interactive prompts
│
├── db
│   ├── migrate           # Run all pending database migrations
│   ├── reset             # Drop and recreate all tables (dangerous, requires --confirm)
│   ├── gc                # Garbage-collect orphaned entities (zero story links)
│   └── status            # Show migration status
│
├── ingest <path>         # Ingest PDF(s) — file or directory
│   ├── --watch           # Watch directory for new PDFs
│   ├── --dry-run         # Validate without uploading
│   └── --tag <tag>       # Tag ingested sources for batch operations
│
├── extract <source-id>   # Run extraction on a specific source
│   ├── --all             # Extract all sources with status=ingested
│   ├── --force           # Re-extract even if already extracted (cascading reset)
│   └── --fallback-only   # Only run Gemini Vision fallback (skip Document AI)
│
├── segment <source-id>   # Segment extracted content into stories
│   ├── --all             # Segment all sources with status=extracted
│   └── --force           # Re-segment even if already segmented (cascading reset)
│
├── enrich <story-id>     # Enrich a specific story (entity extraction + resolution)
│   ├── --all             # Enrich all stories with status=segmented
│   ├── --source <id>     # Enrich all stories from a specific source
│   └── --force           # Re-enrich even if already enriched (cascading reset)
│
├── ground <entity-id>    # Web-enrich a specific entity
│   ├── --all             # Ground all ungrounded entities of configured types
│   ├── --type <type>     # Ground all entities of a specific type
│   ├── --batch <n>       # Process in batches of n (default: 10)
│   └── --refresh         # Re-ground even if cached (ignore TTL)
│
├── embed <story-id>      # Generate embeddings for a specific story
│   ├── --all             # Embed all stories with status=enriched
│   ├── --source <id>     # Embed all stories from a specific source
│   └── --force           # Re-embed even if already embedded (cascading reset)
│
├── graph <story-id>      # Write entities/relationships to graph for a story
│   ├── --all             # Graph all stories with status=embedded
│   ├── --source <id>     # Graph all stories from a specific source
│   └── --force           # Re-graph even if already graphed (cascading reset)
│
├── analyze               # Run analysis on the full graph
│   ├── --contradictions   # Only run contradiction resolution
│   ├── --reliability      # Only run source reliability scoring
│   ├── --evidence-chains  # Only run evidence chain computation
│   ├── --spatio-temporal  # Only run spatio-temporal clustering
│   └── --full             # Run all analysis (default)
│
├── pipeline
│   ├── run <path>        # Full pipeline: ingest → extract → segment → enrich → [ground] → embed → graph → [analyze]
│   │   ├── --up-to <step>  # Run pipeline up to a specific step (e.g., --up-to enrich)
│   │   ├── --from <step>   # Resume pipeline from a specific step
│   │   ├── --dry-run       # Show what would happen without executing
│   │   └── --tag <tag>     # Tag this pipeline run
│   ├── status            # Show pipeline status for all sources
│   │   ├── --source <id>  # Status for a specific source
│   │   └── --tag <tag>    # Status for a tagged batch
│   └── retry <source-id> # Retry failed step for a source
│       └── --step <step> # Retry a specific step
│
├── cache
│   └── clear             # Wipe dev-mode LLM cache (.mulder-cache.db)
│
├── worker
│   ├── start             # Start background job worker (polls jobs table)
│   │   ├── --concurrency <n>  # Max parallel jobs (default: 1)
│   │   └── --poll-interval <ms>  # Polling interval (default: 5000)
│   ├── status            # Show running workers and pending jobs
│   └── reap              # Reset stuck jobs (running > 2h) back to pending
│
├── taxonomy
│   ├── bootstrap         # Generate taxonomy from all ingested documents
│   │   └── --min-docs <n> # Minimum documents required (default: 25)
│   ├── re-bootstrap      # Regenerate taxonomy (replaces auto entries, keeps confirmed)
│   ├── show              # Print current taxonomy tree
│   ├── export            # Export taxonomy to YAML
│   ├── curate            # Open taxonomy.curated.yaml in $EDITOR
│   └── merge             # Merge curated taxonomy into active taxonomy
│
├── query <question>      # Hybrid retrieval query
│   ├── --strategy <s>    # vector | fulltext | graph | hybrid (default: hybrid)
│   ├── --top-k <n>       # Number of results (default: 10)
│   ├── --no-rerank       # Skip LLM re-ranking
│   ├── --explain         # Show retrieval strategy breakdown (scores per strategy)
│   └── --json            # Output as JSON
│
├── entity
│   ├── list              # List all entities
│   │   ├── --type <type>  # Filter by entity type
│   │   └── --search <q>   # Search by name
│   ├── show <entity-id>  # Show entity details + relationships
│   ├── merge <id1> <id2> # Manually merge two entities
│   └── aliases <entity-id> # List/manage entity aliases
│
├── export
│   ├── graph             # Export knowledge graph (nodes + edges)
│   │   ├── --format <f>   # json | csv | graphml | cypher
│   │   └── --filter <q>   # Filter by entity type, relationship, etc.
│   ├── stories           # Export stories
│   │   └── --format <f>   # json | csv | markdown
│   └── evidence          # Export evidence report
│       └── --format <f>   # json | csv | markdown
│
└── status                # Overview: sources, stories, entities, pipeline health
```

### CLI Architecture

```
cli/
├── index.ts              # Entry point: #!/usr/bin/env node, registers all commands
├── commands/
│   ├── config.ts         # config validate | show | init
│   ├── db.ts             # db migrate | reset | status
│   ├── ingest.ts         # ingest <path>
│   ├── extract.ts        # extract <source-id>
│   ├── segment.ts        # segment <source-id>
│   ├── enrich.ts         # enrich <story-id>
│   ├── ground.ts         # ground <entity-id>
│   ├── embed.ts          # embed <story-id>
│   ├── graph.ts          # graph <story-id>
│   ├── analyze.ts        # analyze
│   ├── pipeline.ts       # pipeline run | status | retry
│   ├── cache.ts          # cache clear
│   ├── worker.ts         # worker start | status | reap
│   ├── taxonomy.ts       # taxonomy bootstrap | show | curate | merge
│   ├── query.ts          # query <question>
│   ├── entity.ts         # entity list | show | merge | aliases
│   ├── export.ts         # export graph | stories | evidence
│   └── status.ts         # status overview
└── lib/
    ├── output.ts         # Formatting: tables, JSON, progress bars, colors
    ├── prompts.ts        # Interactive prompts (for config init, confirmations)
    └── errors.ts         # CLI-specific error handling and exit codes
```

Each CLI command is a thin wrapper that:
1. Parses arguments
2. Loads and validates config
3. Calls the corresponding function from `packages/pipeline/`, `packages/retrieval/`, etc.
4. Formats output for the terminal

**No business logic lives in the CLI layer.** The CLI imports and calls the same functions the worker and API call.

---

## 2. Pipeline Steps — Functional Contracts

Each pipeline step is a module exporting a single `execute` function with a strict contract:

```typescript
// Pattern for every pipeline step
interface StepResult<T> {
  status: 'success' | 'partial' | 'failed'
  data: T
  errors: StepError[]
  metadata: {
    duration_ms: number
    items_processed: number
    items_skipped: number
    items_cached: number      // LLM cache hits (dev mode)
  }
}
```

### 2.1 Ingest

**Purpose:** Accept PDF documents and register them as sources in the system.

**Input:**
- File path (single PDF or directory)
- Optional: tags, metadata overrides

**Process:**
1. **Pre-flight validation (security gate):**
   - Check file size against `ingestion.max_file_size_mb` (default: 100MB). Reject immediately if exceeded.
   - Run lightweight metadata check via `pdfinfo` (poppler-utils) or equivalent BEFORE parsing content. Extract page count without decompressing the full PDF — this catches PDF bombs (decompression bombs that expand to gigabytes in memory).
   - Check page count against `ingestion.max_pages` (default: 2000). Reject if exceeded.
   - Validate PDF header (magic bytes `%PDF-`). Reject non-PDF files with PDF extension.
2. **Native text detection:** Extract text via `pdf-parse` (or similar). Store boolean `has_native_text` and `native_text_ratio` (% of pages with extractable text) on the source record. This determines whether Document AI is needed in the Extract step.
3. Upload to Cloud Storage (`gs://{bucket}/sources/{source_id}/original.pdf`)
4. Create `sources` record in PostgreSQL (status: `ingested`, includes `has_native_text`)
5. Create metadata record in Firestore (original filename, upload time, file hash for dedup)
6. If `--watch`: set up file watcher, re-run on new files

**Output:** `SourceRecord[]` — IDs, storage paths, native text flags

**Standalone value:** Users can batch-upload documents without running any processing. Useful for staging a collection before processing.

**Dependencies:** Cloud Storage, PostgreSQL, Firestore

### 2.2 Extract

**Purpose:** OCR and layout analysis — turn PDF pages into structured text with layout metadata.

**Input:**
- `source_id` (must have status >= `ingested`)
- Source PDF from Cloud Storage

**Process:**
1. Download PDF from Cloud Storage (or use local path in dev mode)
2. **Cost gate — native text check:**
   - Load `has_native_text` and `native_text_ratio` from source record
   - If `native_text_ratio >= 0.9` (configurable via `extraction.native_text_threshold`): extract text locally via `pdf-parse`, skip Document AI entirely. This saves ~$10/1000 pages.
   - If `native_text_ratio < 0.9`: send to Document AI Layout Parser → get per-page text blocks with bounding boxes, reading order, and confidence scores
3. For pages with confidence < threshold (from config): send page image to Gemini Vision with layout-aware prompt → get corrected text.
   **Circuit breaker:** Cap Gemini Vision fallback at `extraction.max_vision_pages` (default: 20) per document. If more pages need fallback than the limit allows, the remaining low-confidence pages use the Document AI text as-is (best effort). The source proceeds to `extracted` status normally, but `metadata.vision_fallback_capped: true` is set for auditing. This prevents a single badly-scanned 500-page PDF from burning $50+ in Gemini Vision tokens and hitting GCP request quotas.
4. Merge results: prefer Document AI where confident, Gemini Vision where not, local text where native
5. Store extracted content in PostgreSQL (`source_extractions` table) — full text + per-page layout metadata + extraction method per page (`native` | `document_ai` | `gemini_vision`)
6. Update source status to `extracted`

**Output:** `ExtractionResult` — structured text with page-level layout metadata, confidence per page, extraction method per page

**Cost impact:** For a 50,000 page collection where 70% are text-based PDFs, this heuristic saves ~$3,500 in Document AI costs.

**Standalone value:** Run extraction separately to inspect OCR quality before committing to segmentation. Debug Document AI vs Gemini Vision vs native text per page.

**Dependencies:** Document AI API (only for scanned docs), Vertex AI (Gemini Vision), Cloud Storage, PostgreSQL

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'extract')` which deletes all source_extractions, then cascading-deletes all stories, chunks, edges, and orphaned entities before re-extracting.

### 2.3 Segment

**Purpose:** Identify and isolate individual articles/stories from a multi-article document.

**Input:**
- `source_id` (must have status >= `extracted`)
- Extracted text + layout metadata from PostgreSQL

**Process:**
1. Load extracted content for source
2. Build segmentation prompt from config (`extraction.segmentation` section) + extracted text
3. Send to Gemini with structured output schema:
   ```
   { stories: [{ title, subtitle?, page_start, page_end, text, summary, language }] }
   ```
4. Validate output against extracted page count and text
5. Create `stories` records in PostgreSQL, linked to source
6. Update source status to `segmented`

**Output:** `Story[]` — isolated articles with title, text, page range, language

**Standalone value:** Re-segment when improving segmentation prompts. Compare segmentation strategies.

**Dependencies:** Vertex AI (Gemini), PostgreSQL

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'segment')` which deletes ALL stories for this source. Thanks to `ON DELETE CASCADE`, all chunks, story_entities junctions, and edges originating from those stories are automatically removed. Entities that become orphaned (zero story links) are NOT deleted inline — they are cleaned up later by `mulder db gc` to avoid race conditions with concurrent workers.

### 2.4 Enrich

**Purpose:** Extract entities and relationships from stories based on the config ontology. Normalize against taxonomy. Resolve cross-document entity matches.

**Input:**
- `story_id` (must have status >= `segmented`)
- Story text from PostgreSQL
- Ontology definition from config
- Current taxonomy (if exists)

**Process:**
1. Load story text
2. **Generate JSON Schema from config ontology** using `zod-to-json-schema` library (mandatory — do NOT hand-roll schema conversion). Build Zod schemas from config ontology definition, then convert to JSON Schema for Gemini structured output. This ensures schema validity and prevents subtle type mismatches that break structured output.
3. Build extraction prompt with generated schema + story text
4. Send to Gemini with structured output → get entities + relationships with confidence scores
5. **Taxonomy normalization** (inline):
   - For each extracted entity, search taxonomy for matching canonical entry (via `pg_trgm` similarity)
   - If match found (similarity > threshold): assign `canonical_id`, add as alias
   - If no match: create new taxonomy entry with status `auto`
6. **Entity resolution** (cross-document):
   - For each entity, search existing entities by name, aliases, type, and attributes
   - If match found (similarity > `entity_resolution.similarity_threshold`): merge → update `canonical_id`, add aliases
   - If no match: create new entity
   - **Deadlock prevention:** Sort all entity upserts lexicographically by `(entity_type, canonical_name)` before writing to PostgreSQL. This guarantees consistent lock ordering when multiple CLI processes or workers enrich stories concurrently, preventing transaction deadlocks.
7. Write entities to `entities` table, relationships to `entity_edges` table
8. Write entity-story links to `story_entities` junction table
9. Update story status to `enriched`

**Output:** `EnrichmentResult` — entities extracted, entities resolved, relationships created, taxonomy entries added

**Standalone value:** Re-enrich after updating the ontology config. Re-run after taxonomy curation to improve normalization. Debug entity resolution decisions.

**Dependencies:** Vertex AI (Gemini), PostgreSQL, Config (ontology + taxonomy)

**Force behavior:** When called with `--source <id> --force`, calls `reset_pipeline_step(source_id, 'enrich')` which deletes story_entities junctions and entity_edges for all stories of that source. Story texts are preserved. Orphaned entities are cleaned up later by `mulder db gc`. When called with `<story-id> --force`, resets only that single story's entity links and edges (no source-level reset). The `--all --force` flag is not supported — too dangerous for bulk operations, use `--source` to scope the reset.

### 2.5 Ground (v2.0)

**Purpose:** Enrich entities with real-world data from the web — coordinates, biographical context, organization descriptions, date verification.

**Input:**
- `entity_id` or batch of entities
- Entity type and current attributes
- Config: which types to enrich, cache TTL

**Process:**
1. Filter entities by configured `enrich_types` (skip `skip_types`)
2. Check cache: skip entities with valid cached grounding (within TTL)
3. For each entity, call Gemini with `google_search_retrieval` tool:
   - Location → coordinates (lat/lng), place type, region
   - Person → biographical context, active dates, key affiliations
   - Organization → description, founding date, type
   - Event → date verification, location verification
4. Validate grounding results (plausibility checks)
5. Store grounding data in `entity_grounding` table (with timestamp, source URLs, TTL)
6. Update entity attributes with grounded data (e.g., fill in `coordinates` for locations)

**Output:** `GroundingResult` — entities enriched, cache hits, grounding failures

**Standalone value:** Run independently to enrich entities after initial pipeline. Refresh grounding when cache expires. Batch-ground entities of a specific type.

**Dependencies:** Vertex AI (Gemini + google_search_retrieval), PostgreSQL

### 2.6 Embed

**Purpose:** Generate vector embeddings for semantic search. Chunk stories intelligently and generate search-optimized representations.

**Input:**
- `story_id` (must have status >= `enriched`)
- Story text + extracted entities from PostgreSQL

**Process:**
1. Load story text and entity data
2. **Semantic chunking:**
   - Split story into chunks based on semantic boundaries (paragraph breaks, topic shifts)
   - Target chunk size from config (default: ~512 tokens, overlap: ~50 tokens)
   - Each chunk retains metadata: story_id, page range, entity references
3. **Question generation** (per chunk):
   - Generate 2-3 questions this chunk could answer (via Gemini)
   - These questions become additional embedding targets (improves retrieval for question-style queries)
4. **Embedding:**
   - Embed each chunk text via `gemini-embedding-001` (produces 3072-dim)
   - Embed generated questions via same model
   - **Matryoshka truncation at write time:** Truncate vectors from 3072 to `embedding.storage_dimensions` (default: 768) BEFORE storing in PostgreSQL. This is critical for resource planning:
     - 3072-dim: 1M vectors × 3072 × 4 bytes = ~12GB data + ~24GB HNSW index = needs a 64GB Cloud SQL instance (~$500/mo)
     - 768-dim: 1M vectors × 768 × 4 bytes = ~3GB data + ~6GB HNSW index = fits a 16GB Cloud SQL instance (~$100/mo)
     - Quality loss at 768-dim is minimal for `gemini-embedding-001` (Matryoshka models are designed for this)
   - Normalize vectors after truncation (L2 normalize the truncated prefix)
5. Store in `chunks` table: content chunks as rows with `is_question=false`, generated questions as separate rows with `is_question=true` and `parent_chunk_id` pointing to their source chunk. pgvector does not support `vector[]` arrays — each embedding needs its own row.
6. Update story status to `embedded`

**Output:** `EmbeddingResult` — chunks created, embeddings stored, questions generated

**Standalone value:** Re-embed after changing chunking strategy. Re-embed with updated entity data. Generate embeddings for specific stories.

**Dependencies:** Vertex AI (Gemini for questions, gemini-embedding-001 for embeddings), PostgreSQL (pgvector)

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'embed')` which directly deletes all chunks and full-text index entries for the source's stories, then resets story status to `enriched`. Stories, entities, and edges are preserved. No orphan risk since chunks only link to one story.

### 2.7 Graph

**Purpose:** Write entity relationships to the graph structure. Score corroboration. Flag potential contradictions (fast, no LLM).

**Input:**
- `story_id` (must have status >= `embedded`) or all enriched stories
- Entities + relationships from PostgreSQL

**Process:**
1. Load entities and relationships for story
2. **Write edges:**
   - Upsert `entity_edges` records with relationship type, attributes, source story, confidence
   - Handle bidirectional relationships (store both directions)
3. **Corroboration scoring** (SQL aggregation):
   - For each entity, count independent sources (different `source_id` values via `story_entities` → `stories` → `source_id`)
   - Update `entities.source_count` with the independent source count
   - Calculate corroboration score: `min(source_count / min_independent_sources, 1.0)`
   - Update `entities.corroboration_score`
4. **Contradiction flagging** (attribute diff, no LLM):
   - For each entity with multiple source mentions, compare key attributes (date, location, description)
   - If attributes conflict (e.g., different dates for the same event): create `POTENTIAL_CONTRADICTION` edge between the two claims
   - Fast pass — no LLM, only string/date comparison
5. Update story status to `graphed`

**Output:** `GraphResult` — edges created, corroboration scores updated, contradictions flagged

**Standalone value:** Re-run after entity merges to recalculate corroboration. Inspect flagged contradictions before running Analyze.

**Dependencies:** PostgreSQL

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'graph')` which deletes all entity_edges originating from the source's stories, then resets story status to `embedded`. Entities, chunks, and embeddings are preserved. Corroboration scores and contradiction flags are recalculated as part of the re-run.

### 2.8 Analyze (v2.0)

**Purpose:** Deep analysis — resolve contradictions, score source reliability, compute evidence chains, detect spatio-temporal patterns.

**Input:**
- The full graph (runs against all data, not per-story)
- Config: which analysis features are enabled

**Process (modular — each sub-analysis can run independently):**

1. **Contradiction resolution:**
   - Load all `POTENTIAL_CONTRADICTION` edges
   - For each: build comparison prompt with both claims, source context
   - Send to Gemini → `CONFIRMED` or `DISMISSED` with explanation
   - Update edge status + store Gemini analysis

2. **Source reliability scoring:**
   - Build citation graph (sources citing other sources, entity co-occurrence)
   - Run weighted PageRank algorithm
   - Score each source on a 0-1 scale
   - Update `sources.reliability_score`

3. **Evidence chains:**
   - For configurable "thesis" queries (or user-defined): trace paths through the graph
   - Recursive CTE with cycle detection (see [Section 5.1](#51-three-strategies) for SQL pattern)
   - Aggregate path strength (product of edge confidences)
   - Store as `evidence_chains` records

4. **Spatio-temporal clustering:**
   - Load events with coordinates and timestamps
   - Temporal: cluster events within `cluster_window_days`
   - Spatial: PostGIS `ST_DWithin` for proximity grouping
   - Combined: identify clusters that are close in both time and space
   - Store as `spatio_temporal_clusters` records

**Output:** `AnalysisResult` — contradictions resolved, reliability scores, evidence chains, clusters

**Standalone value:** Run after each batch of new documents. Run specific sub-analyses independently. Re-run after manual entity curation.

**Dependencies:** Vertex AI (Gemini for contradiction resolution), PostgreSQL (PostGIS for spatial, recursive CTEs for chains)

---

## 3. Pipeline Composition

### 3.1 Step Dependencies

```
ingest ──→ extract ──→ segment ──→ enrich ──→ ground* ──→ embed ──→ graph ──→ analyze*
                                                │                      │
                                                └── (optional) ────────┘

* = v2.0 steps, skipped if disabled in config
```

Each step transitions the source/story through a status lifecycle:

```
Source:  ingested → extracted → segmented → [all stories enriched] → [all stories embedded] → [all stories graphed]
Story:  segmented → enriched → embedded → graphed
Entity: created → [grounded] → [analyzed]
```

### 3.2 Full Pipeline Orchestrator

`mulder pipeline run` is a coordinator, not a step itself. It uses **cursor-based progress tracking** — not a naive for-loop that loses state on crash.

**Progress table:** The orchestrator writes progress to the `pipeline_runs` table. Each source gets a row tracking which step it's on, so a crash at document 45,000 resumes from document 45,000 — not from the beginning.

```typescript
// Pseudocode for pipeline orchestrator with cursor-based resume
async function runPipeline(path: string, options: PipelineOptions): Promise<PipelineResult> {
  const config = loadConfig()
  const runId = await createPipelineRun(options)

  // Phase 1: Ingest all sources (or resume from cursor)
  const sources = options.from
    ? await getSourcesFromCursor(runId)
    : await ingest(path, options)

  // Phase 2: Process each source with transactional progress
  for (const source of sources) {
    try {
      const currentStep = await getCurrentStep(runId, source.id)

      if (shouldRun('extract', currentStep, options)) {
        await extract(source.id)
        await updateProgress(runId, source.id, 'extracted')
      }

      if (shouldRun('segment', currentStep, options)) {
        const stories = await segment(source.id)
        await updateProgress(runId, source.id, 'segmented')
      }

      const stories = await getStoriesForSource(source.id)
      for (const story of stories) {
        if (shouldRun('enrich', currentStep, options)) {
          await enrich(story.id)
        }
      }
      if (shouldRun('enrich', currentStep, options)) {
        await updateProgress(runId, source.id, 'enriched')
      }

      if (config.enrichment.enabled && config.enrichment.mode === 'pipeline') {
        if (shouldRun('ground', currentStep, options)) {
          const entities = await getEntitiesForSource(source.id)
          await ground(entities)
          await updateProgress(runId, source.id, 'grounded')
        }
      }

      if (shouldRun('embed', currentStep, options)) {
        for (const story of stories) await embed(story.id)
        await updateProgress(runId, source.id, 'embedded')
      }

      if (shouldRun('graph', currentStep, options)) {
        for (const story of stories) await graph(story.id)
        await updateProgress(runId, source.id, 'graphed')
      }

    } catch (error) {
      // Mark source as failed, continue with next source
      await markSourceFailed(runId, source.id, error)
      logger.error({ source_id: source.id, error }, 'Source processing failed')
      continue  // Don't crash the whole pipeline
    }
  }

  // Phase 3: Global analysis (runs against full graph, not per-source)
  if (config.analysis.enabled && shouldRun('analyze', null, options)) {
    await analyze({ full: true })
  }

  return await finalizePipelineRun(runId)
}
```

**Key differences from the naive approach:**
- Progress is persisted per-source in `pipeline_runs` after each step completes
- A failed source doesn't crash the batch — it's marked `failed` and skipped
- `--from` resumes from the cursor, not from the beginning
- Rate limit exhaustion (after retries) marks the source as `failed` with a retriable error code, so `mulder pipeline retry` can pick it up later

### 3.3 Partial Pipeline Runs

The `--from` and `--up-to` flags let users run subsets:

```bash
# Just ingest and extract — inspect OCR quality
mulder pipeline run ./pdfs --up-to extract

# Resume from where it failed
mulder pipeline run ./pdfs --from enrich

# Process everything but skip analysis
mulder pipeline run ./pdfs --up-to graph
```

The orchestrator checks source/story status to determine what needs processing. If a story is already `enriched` and the user runs `--from embed`, it skips ingest/extract/segment/enrich.

### 3.4 Force Re-runs & Cascading Reset

**The problem:** `--force` with naive upserts creates orphaned data. If a new segmentation prompt produces 2 stories instead of 3, the third story and all its chunks, embeddings, edges, and entity links become ghost data polluting search results and the knowledge graph.

**The solution:** Every `--force` call invokes `reset_pipeline_step(source_id, step)` — an atomic PostgreSQL function that cascading-deletes all downstream data before the step re-runs.

**Cascade chain:**
```
extract --force:
  DELETE stories WHERE source_id = X
    → CASCADE: chunks, story_entities, entity_edges, story_fts
  DELETE source_extractions WHERE source_id = X

segment --force:
  DELETE stories WHERE source_id = X
    → CASCADE: chunks, story_entities, entity_edges, story_fts
  (source_extractions preserved — no need to re-extract)

enrich --force:
  DELETE story_entities, entity_edges for stories of source X
  (story texts, chunks, and source_extractions preserved)

embed --force:
  DELETE chunks, story_fts for stories of source X
  (entities, edges, and source_extractions preserved)

graph --force:
  DELETE entity_edges for stories of source X
  (entities, chunks, embeddings preserved)
```

**The entity trap:** Entities like "USA" appear in dozens of documents. `--force` resets delete the junction (`story_entities`) and edges from the specific source, but do NOT delete the entities themselves — even if they become orphaned (zero remaining story links). Orphaned entity cleanup runs separately via `mulder db gc` or as a scheduled background job. This prevents race conditions where a concurrent worker tries to link to an entity that's being deleted by another worker's `--force` reset.

**Implementation:** See `reset_pipeline_step()` in [Section 4.3](#43-core-database-schema).

---

## 4. Shared Infrastructure

### 4.1 Config Loader

```
src/config/
├── loader.ts             # Load + validate mulder.config.yaml
├── schema.ts             # Zod schemas for all config sections
├── defaults.ts           # Default values for optional config
└── types.ts              # TypeScript types derived from Zod schemas
```

**Core function:** `loadConfig(path?: string): MulderConfig`

- Reads `mulder.config.yaml` (or path override)
- Validates against Zod schema
- Fills in defaults for omitted optional fields
- Returns frozen, typed config object
- Throws `ConfigValidationError` with detailed path + message on failure

Every CLI command and pipeline step calls `loadConfig()` as its first action. Config is loaded once per process, not per step.

### 4.2 Database

```
src/database/
├── client.ts             # PostgreSQL connection pool (pg or postgres.js)
├── migrations/           # Numbered SQL migration files
│   ├── 001_extensions.sql          # pgvector, PostGIS, pg_trgm
│   ├── 002_sources.sql
│   ├── 003_source_extractions.sql
│   ├── 004_stories.sql
│   ├── 005_entities.sql
│   ├── 006_entity_edges.sql
│   ├── 007_chunks.sql
│   ├── 008_taxonomy.sql
│   ├── 009_grounding.sql           # v2.0
│   ├── 010_evidence.sql            # v2.0
│   ├── 011_spatio_temporal.sql     # v2.0
│   ├── 012_jobs_queue.sql          # Job queue for async API
│   ├── 013_pipeline_runs.sql       # Cursor-based pipeline progress
│   └── 014_reset_functions.sql     # reset_pipeline_step() PL/pgSQL
├── migrate.ts            # Migration runner
└── repositories/         # Data access layer
    ├── sources.ts
    ├── stories.ts
    ├── entities.ts
    ├── edges.ts
    ├── chunks.ts
    ├── taxonomy.ts
    ├── grounding.ts
    ├── evidence.ts
    └── jobs.ts           # Job queue operations (enqueue, dequeue, reap)
```

**Repositories** provide typed CRUD operations. Pipeline steps never write raw SQL — they call repository functions. This keeps SQL in one place and makes schema changes manageable.

### 4.3 Core Database Schema

```sql
-- Sources: ingested documents
CREATE TABLE sources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          TEXT NOT NULL,
  storage_path      TEXT NOT NULL,           -- gs://bucket/path
  file_hash         TEXT NOT NULL UNIQUE,    -- SHA-256 for dedup
  page_count        INTEGER,
  has_native_text   BOOLEAN DEFAULT false,   -- PDF contains extractable text
  native_text_ratio FLOAT DEFAULT 0,         -- % of pages with native text (0-1)
  status            TEXT NOT NULL DEFAULT 'ingested',
  reliability_score FLOAT,                   -- v2.0: weighted PageRank score
  tags              TEXT[],
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- Source extractions: raw extracted text + layout metadata per page
-- Populated by the Extract step, consumed by Segment
CREATE TABLE source_extractions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_number     INTEGER NOT NULL,
  text            TEXT NOT NULL,
  extraction_method TEXT NOT NULL,         -- 'native' | 'document_ai' | 'gemini_vision'
  confidence      FLOAT,
  layout_metadata JSONB DEFAULT '{}',      -- bounding boxes, reading order, block types
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_id, page_number)
);

-- Stories: individual articles/segments within a source
-- NOTE: ON DELETE CASCADE on all child tables ensures clean --force re-runs
CREATE TABLE stories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID NOT NULL REFERENCES sources(id),
  title           TEXT NOT NULL,
  subtitle        TEXT,
  text            TEXT NOT NULL,
  summary         TEXT,
  language        TEXT,
  page_start      INTEGER,
  page_end        INTEGER,
  status          TEXT NOT NULL DEFAULT 'segmented',
  confidence      FLOAT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Entities: extracted and resolved entities
CREATE TABLE entities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id        UUID REFERENCES entities(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  attributes          JSONB DEFAULT '{}',
  corroboration_score FLOAT,
  source_count        INTEGER DEFAULT 0,
  taxonomy_status     TEXT DEFAULT 'auto',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE entity_aliases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias           TEXT NOT NULL,
  source          TEXT,
  UNIQUE(entity_id, alias)
);

-- Entity-Story junction — CASCADE ensures cleanup when stories are deleted
CREATE TABLE story_entities (
  story_id        UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entity_id       UUID NOT NULL REFERENCES entities(id),
  confidence      FLOAT,
  mention_count   INTEGER DEFAULT 1,
  PRIMARY KEY (story_id, entity_id)
);

-- Relationships between entities (graph edges)
-- story_id CASCADE: when a story is deleted, edges originating from it are removed
CREATE TABLE entity_edges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id  UUID NOT NULL REFERENCES entities(id),
  target_entity_id  UUID NOT NULL REFERENCES entities(id),
  relationship      TEXT NOT NULL,
  attributes        JSONB DEFAULT '{}',
  confidence        FLOAT,
  story_id          UUID REFERENCES stories(id) ON DELETE CASCADE,
  edge_type         TEXT DEFAULT 'RELATIONSHIP',
  analysis          JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Embedding chunks — CASCADE ensures vectors are cleaned up with stories
-- NOTE: pgvector does NOT support vector[] (arrays of vectors).
-- Question embeddings are stored as separate rows with is_question=true.
CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id        UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  page_start      INTEGER,
  page_end        INTEGER,
  embedding       vector(768),             -- Matryoshka-truncated from 3072; dimension configurable via embedding.storage_dimensions
  is_question     BOOLEAN DEFAULT false,   -- true = generated question, false = content chunk
  parent_chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,  -- question → parent content chunk
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Full-text search — CASCADE with story
CREATE TABLE story_fts (
  story_id        UUID PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  fts_vector      tsvector NOT NULL
);

-- Taxonomy
CREATE TABLE taxonomy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  category        TEXT,
  status          TEXT DEFAULT 'auto',
  aliases         TEXT[],
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(canonical_name, entity_type)
);

-- v2.0: Entity grounding cache
CREATE TABLE entity_grounding (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  grounding_data  JSONB NOT NULL,
  source_urls     TEXT[],
  grounded_at     TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

-- v2.0: Evidence chains
CREATE TABLE evidence_chains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis          TEXT NOT NULL,
  path            UUID[] NOT NULL,
  strength        FLOAT NOT NULL,
  supports        BOOLEAN NOT NULL,
  computed_at     TIMESTAMPTZ DEFAULT now()
);

-- v2.0: Spatio-temporal clusters
CREATE TABLE spatio_temporal_clusters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  center_lat      FLOAT,
  center_lng      FLOAT,
  time_start      TIMESTAMPTZ,
  time_end        TIMESTAMPTZ,
  event_count     INTEGER NOT NULL,
  event_ids       UUID[] NOT NULL,
  cluster_type    TEXT,
  computed_at     TIMESTAMPTZ DEFAULT now()
);

-- Job queue for async API (see Section 10)
CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed');

CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL,              -- e.g., 'pipeline_run', 'ground_batch'
  payload         JSONB NOT NULL,             -- e.g., {"source_id": "...", "up_to": "embed"}
  status          job_status NOT NULL DEFAULT 'pending',
  attempts        INTEGER DEFAULT 0,
  max_attempts    INTEGER DEFAULT 3,
  error_log       TEXT,
  worker_id       TEXT,                       -- identifies the Node.js process
  created_at      TIMESTAMPTZ DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

-- Pipeline run progress tracking (cursor-based resume)
CREATE TABLE pipeline_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag             TEXT,
  options         JSONB DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'running',
  created_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE TABLE pipeline_run_sources (
  run_id          UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  source_id       UUID NOT NULL REFERENCES sources(id),
  current_step    TEXT NOT NULL DEFAULT 'ingested',
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending|processing|completed|failed
  error_message   TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_id, source_id)
);

-- v2.0: Geospatial column on entities (PostGIS)
-- ALTER TABLE entities ADD COLUMN geom geometry(Point, 4326);
-- CREATE INDEX idx_entities_geom ON entities USING GIST(geom);

-- Required extensions (must be created before indexes)
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS postgis;     -- PostGIS for geospatial
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram similarity for taxonomy normalization

-- Indexes
CREATE INDEX idx_sources_status ON sources(status);
CREATE INDEX idx_stories_source ON stories(source_id);
CREATE INDEX idx_stories_status ON stories(status);
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_canonical ON entities(canonical_id);
CREATE INDEX idx_entity_edges_source ON entity_edges(source_entity_id);
CREATE INDEX idx_entity_edges_target ON entity_edges(target_entity_id);
CREATE INDEX idx_entity_edges_type ON entity_edges(edge_type);
CREATE INDEX idx_source_extractions_source ON source_extractions(source_id);
CREATE INDEX idx_chunks_story ON chunks(story_id);
CREATE INDEX idx_chunks_questions ON chunks(parent_chunk_id) WHERE is_question = true;
CREATE INDEX idx_story_fts ON story_fts USING gin(fts_vector);
CREATE INDEX idx_entities_name_trgm ON entities USING gin(name gin_trgm_ops);  -- for taxonomy similarity search
CREATE INDEX idx_taxonomy_name_trgm ON taxonomy USING gin(canonical_name gin_trgm_ops);
CREATE INDEX idx_jobs_queue ON jobs(status, created_at) WHERE status = 'pending';

-- IMPORTANT: Use HNSW, NOT ivfflat for vector index.
-- ivfflat requires the table to be well-populated BEFORE index creation (it pre-computes
-- cluster centers). If documents trickle in incrementally, ivfflat's recall degrades
-- catastrophically because the initial clusters become stale.
-- HNSW is slightly more memory-intensive but handles incremental inserts perfectly —
-- no rebuild required as new vectors arrive.
--
-- Parameters tuned for 768-dim vectors:
--   m=16: connections per node (default, good for 768-dim)
--   ef_construction=64: build-time search width (higher = better recall, slower build)
-- At query time, set ef_search via SET hnsw.ef_search = 40 (default) or higher for better recall.
CREATE INDEX idx_chunks_embedding ON chunks
  USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### 4.3.1 Cascading Reset Function

Atomic PostgreSQL function for `--force` re-runs. Called by every pipeline step's `--force` flag BEFORE re-processing.

```sql
CREATE OR REPLACE FUNCTION reset_pipeline_step(
  p_source_id UUID,
  p_step TEXT  -- 'extract' | 'segment' | 'enrich' | 'embed' | 'graph'
) RETURNS VOID AS $$
BEGIN
  -- EXTRACT: nuke everything including raw extractions
  IF p_step = 'extract' THEN
    DELETE FROM stories WHERE source_id = p_source_id;        -- cascades to chunks, story_entities, edges, fts
    DELETE FROM source_extractions WHERE source_id = p_source_id;
    UPDATE sources SET status = 'ingested' WHERE id = p_source_id;
  END IF;

  -- SEGMENT: nuke stories + downstream, keep raw extractions
  -- Deleting stories cascades to: chunks, story_entities, entity_edges, story_fts
  IF p_step = 'segment' THEN
    DELETE FROM stories WHERE source_id = p_source_id;
    UPDATE sources SET status = 'extracted' WHERE id = p_source_id;
  END IF;

  -- ENRICH: keep story texts, delete entity links + edges
  IF p_step = 'enrich' THEN
    DELETE FROM story_entities
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    UPDATE stories SET status = 'segmented' WHERE source_id = p_source_id;
    UPDATE sources SET status = 'segmented' WHERE id = p_source_id;
  END IF;

  -- EMBED: keep entities and edges, delete chunks (vectors) + FTS
  IF p_step = 'embed' THEN
    DELETE FROM chunks
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM story_fts
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    UPDATE stories SET status = 'enriched' WHERE source_id = p_source_id;
  END IF;

  -- GRAPH: delete edges only (keep entities, chunks, embeddings)
  IF p_step = 'graph' THEN
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    UPDATE stories SET status = 'embedded' WHERE source_id = p_source_id;
  END IF;

  -- NOTE: Orphaned entity cleanup is NOT done here.
  -- See gc_orphaned_entities() below for why.
END;
$$ LANGUAGE plpgsql;

-- SEPARATE FUNCTION: Garbage-collect orphaned entities.
-- This runs ASYNCHRONOUSLY (via a scheduled job or `mulder db gc`), NOT inline
-- during --force resets. Why:
--
-- Race condition: If Worker A resets Source X and deletes Entity Y (orphaned),
-- while Worker B is simultaneously enriching Source Z and tries to link to
-- Entity Y (found via taxonomy match), Worker B gets a foreign key violation.
-- By decoupling GC from reset, we eliminate this entire class of errors.
--
-- entity_aliases and entity_grounding have ON DELETE CASCADE from entities,
-- so they are cleaned up automatically.
CREATE OR REPLACE FUNCTION gc_orphaned_entities() RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM entities WHERE id IN (
    SELECT e.id FROM entities e
    LEFT JOIN story_entities se ON e.id = se.entity_id
    WHERE se.entity_id IS NULL
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
```

**Why a PL/pgSQL function instead of application-level logic:**
- **Atomicity:** Entire reset happens in one database transaction. A crash mid-reset leaves the DB in a consistent state (the transaction rolls back).
- **No race conditions:** No risk of TypeScript async code interleaving with concurrent writes.
- **Performance:** One round-trip to the database instead of dozens of sequential queries.

### 4.4 GCP Clients

```
src/shared/
├── gcp.ts                # Client factory — lazy-initialized, singleton clients
├── errors.ts             # Custom error classes with error codes
├── logger.ts             # Pino logger, structured JSON, configurable level
└── types.ts              # Shared TypeScript types
```

**`gcp.ts` client factory:**

```typescript
// Lazy singletons — created on first access
export function getStorageClient(): Storage
export function getDocumentAIClient(): DocumentProcessorServiceClient
export function getVertexAI(): VertexAI
export function getFirestore(): Firestore

// Two separate connection pools — critical for mixed OLTP/OLAP workloads.
// Without separation, a heavy vector search or recursive CTE blocks the job queue poller.
export function getWorkerPool(): Pool    // Small pool (2-3 connections), for job queue OLTP
                                         // No statement_timeout — pipeline steps can run long
export function getQueryPool(): Pool     // Larger pool (5-10 connections), for retrieval/search OLAP
                                         // statement_timeout = 10s — queries that take longer are killed
```

All GCP clients created through this factory. No direct instantiation anywhere else. This makes testing easy (mock the factory) and ensures connection pooling.

**Why two pools:** PostgreSQL's `FOR UPDATE SKIP LOCKED` (job queue) runs in microseconds but needs a connection always available. Vector search + recursive CTEs can take seconds and saturate the pool. If a single pool is shared, a burst of heavy search queries starves the worker — it can't dequeue jobs because all connections are occupied. Two pools guarantee the worker always has a connection available.

### 4.5 Prompt Templates

```
src/prompts/
├── engine.ts             # Jinja2-style template renderer
├── templates/
│   ├── segment.jinja2    # Story segmentation prompt
│   ├── extract-entities.jinja2  # Entity extraction prompt
│   ├── ground-entity.jinja2     # Web grounding prompt
│   ├── resolve-contradiction.jinja2  # Contradiction analysis prompt
│   ├── generate-questions.jinja2     # Question generation for embeddings
│   └── rerank.jinja2     # Re-ranking prompt
└── i18n/
    ├── de.json           # German prompt fragments
    └── en.json           # English prompt fragments
```

Templates use variables injected at render time:
- `{{ ontology }}` — dynamically generated from config
- `{{ story_text }}` — the content to process
- `{{ language }}` — target language from config
- `{{ i18n.* }}` — translated fragments

No inline prompt strings in pipeline code. Every LLM call uses a template.

### 4.6 Vertex AI Wrapper + Dev Cache

```
src/shared/
├── vertex.ts             # Thin wrapper around Vertex AI SDK
└── llm-cache.ts          # Request-hash → response cache (dev mode only)
```

**Functions:**
- `generateStructured<T>(prompt, schema): T` — Gemini structured output with Zod validation of response
- `generateText(prompt): string` — Plain text generation
- `embed(texts: string[]): number[][]` — Batch embedding via gemini-embedding-001
- `groundedGenerate(prompt, entity): GroundingResult` — Gemini with google_search_retrieval tool

Centralizes retry logic, error handling, rate limiting, and token counting. All pipeline steps call these functions, never the Vertex AI SDK directly.

#### Dev-Mode LLM Cache

**The problem:** During prompt development, you'll re-run Segment or Enrich dozens of times over hundreds of documents. Each run burns Gemini tokens. For a 1000-document collection, iterating on the segmentation prompt 10 times costs ~$200 in tokens alone — and the actual content hasn't changed.

**The solution:** A local SQLite cache (`.mulder-cache.db`) that hashes `(model + prompt + schema)` → stores the response. On cache hit, the Vertex AI call is skipped entirely.

```typescript
// Enabled via env var or config
// MULDER_LLM_CACHE=true or config.dev.llm_cache: true

interface CacheEntry {
  request_hash: string    // SHA-256 of (model + prompt + schema JSON)
  response: string        // serialized response
  model: string
  tokens_saved: number
  created_at: number
}
```

**Rules:**
- Cache is LOCAL only (`.mulder-cache.db` in project root, gitignored)
- Enabled via `MULDER_LLM_CACHE=true` env var — never enabled in production
- Cache key is deterministic: same prompt + same model + same schema = cache hit
- `mulder cache clear` command to wipe it
- Embeddings are cached too (same hash logic)
- Cache entries have no TTL (manual clear only — prompt iteration is the use case)

**Impact:** Reduces prompt iteration cost from O(docs * iterations) to O(docs) for the first run, then O(1) for subsequent runs with the same prompt.

---

## 5. Retrieval System

### 5.1 Three Strategies

```
src/retrieval/
├── vector.ts             # pgvector cosine similarity search
├── fulltext.ts           # tsvector BM25 search
├── graph.ts              # Recursive CTE traversal from query entities
├── fusion.ts             # Reciprocal Rank Fusion
├── reranker.ts           # Gemini Flash re-ranking
└── index.ts              # Hybrid retrieval orchestrator
```

**Vector search (`vector.ts`):**
```sql
SELECT c.id, c.story_id, c.text, 1 - (c.embedding <=> $1) AS score
FROM chunks c
ORDER BY c.embedding <=> $1
LIMIT $2
```

**Full-text search (`fulltext.ts`):**
```sql
SELECT s.id, s.title, s.text, ts_rank(f.fts_vector, plainto_tsquery($1)) AS score
FROM stories s
JOIN story_fts f ON f.story_id = s.id
WHERE f.fts_vector @@ plainto_tsquery($1)
ORDER BY score DESC
LIMIT $2
```

**Graph traversal (`graph.ts`):**
1. Extract entities from query (via Gemini or simple keyword matching)
2. Find matching entities in database
3. Traverse relationships via recursive CTE with **mandatory cycle detection and per-level limits**

```sql
-- Graph traversal with cycle detection and per-level limits
-- Without CYCLE detection, a dense node like "USA" (connected to thousands of
-- entities) causes the CTE to explode exponentially or loop infinitely.
WITH RECURSIVE traversal AS (
  -- Base case: start from seed entities
  SELECT
    e.id,
    e.name,
    e.type,
    0 AS depth,
    ARRAY[e.id] AS path,
    1.0::float AS path_confidence
  FROM entities e
  WHERE e.id = ANY($1)  -- seed entity IDs

  UNION ALL

  -- Recursive step with per-level limit and cycle detection
  SELECT
    e2.id,
    e2.name,
    e2.type,
    t.depth + 1,
    t.path || e2.id,
    t.path_confidence * ee.confidence
  FROM traversal t
  JOIN entity_edges ee ON ee.source_entity_id = t.id
  JOIN entities e2 ON e2.id = ee.target_entity_id
  WHERE t.depth < $2              -- max_hops from config (default: 2)
    AND NOT e2.id = ANY(t.path)   -- cycle detection: skip already-visited nodes
    AND ee.edge_type = 'RELATIONSHIP'
    AND e2.source_count < $4      -- supernode pruning: skip high-degree entities (default: 100)
                                  -- Entities like "USA" or "WWII" connect everything to everything
                                  -- and are worthless for evidence chains. Pruning them prevents
                                  -- exponential fan-out even at depth=2.
)
-- Final: rank by path confidence, limit total results
SELECT DISTINCT ON (id) *
FROM traversal
ORDER BY id, path_confidence DESC
LIMIT $3;  -- hard result limit (default: 100)
-- $4 = retrieval.graph.supernode_threshold (default: 100)
```

4. Return connected stories ranked by path distance and edge confidence

### 5.2 Fusion + Re-ranking

```
Query → [Vector Search] ──→ results + scores ──┐
      → [Full-Text]     ──→ results + scores ──├──→ RRF Fusion ──→ Gemini Re-rank ──→ Final Results
      → [Graph]         ──→ results + scores ──┘
```

**RRF Fusion:**
- Each strategy returns ranked results with scores
- RRF score per result: `Σ (weight_i / (k + rank_i))` where k=60 (standard)
- Weights from config (`retrieval.strategies.vector.weight`, etc.)
- Deduplicate results across strategies

**Re-ranking:**
- Top N results from RRF (default: 20) sent to Gemini Flash
- Prompt includes original query + result texts
- Gemini returns re-ranked list with relevance scores
- Return top_k (default: 10) to user

---

## 6. Taxonomy System

```
src/taxonomy/
├── bootstrap.ts          # Generate initial taxonomy from documents
├── normalize.ts          # Match entities against taxonomy
├── merge.ts              # Merge curated YAML into active taxonomy
└── types.ts              # Taxonomy types
```

### 6.1 Bootstrap Flow

```
All entities (after ~25 docs) → Gemini clustering prompt → Taxonomy tree
```

1. Load all entities from database
2. Group by type
3. Send to Gemini: "Group these entities into canonical categories. Identify duplicates and variants."
4. Gemini returns: `{ categories: [{ name, type, members: [{ canonical, aliases }] }] }`
5. Write to `taxonomy` table with status `auto`

### 6.2 Normalization (inline in Enrich)

For each extracted entity during enrichment:
1. Search `taxonomy` table by name similarity (trigram: `pg_trgm`)
2. If match > threshold: assign `canonical_id` from taxonomy entry, add as alias
3. If no match: create new `auto` entry
4. Never modify `confirmed` entries automatically

### 6.3 Curation Workflow

```bash
mulder taxonomy export > taxonomy.curated.yaml   # Export current state
# User edits: rename, merge, confirm, reject
mulder taxonomy merge                             # Apply curated changes
```

`taxonomy.curated.yaml` format:
```yaml
categories:
  person:
    - canonical: "Josef Allen Hynek"
      status: confirmed
      aliases: ["J. Allen Hynek", "Dr. Hynek", "Hynek"]
    - canonical: "Jacques Vallée"
      status: confirmed
      aliases: ["Vallee", "J. Vallée"]
  location:
    - canonical: "Roswell, New Mexico"
      status: confirmed
      aliases: ["Roswell", "Roswell NM"]
```

---

## 7. Error Handling

### 7.1 Error Classes

```typescript
// Base error with code
class MulderError extends Error {
  constructor(
    message: string,
    public code: string,           // e.g., 'CONFIG_INVALID', 'EXTRACTION_FAILED'
    public context?: Record<string, unknown>
  ) {}
}

// Specific errors
class ConfigError extends MulderError { /* code: CONFIG_* */ }
class PipelineError extends MulderError { /* code: PIPELINE_* */ }
class DatabaseError extends MulderError { /* code: DB_* */ }
class ExternalServiceError extends MulderError { /* code: EXT_* */ }
```

### 7.2 Error Codes

| Code | Meaning |
|------|---------|
| `CONFIG_NOT_FOUND` | mulder.config.yaml not found |
| `CONFIG_INVALID` | Config validation failed (includes Zod path) |
| `DB_CONNECTION_FAILED` | Cannot connect to PostgreSQL |
| `DB_MIGRATION_FAILED` | Migration error |
| `PIPELINE_SOURCE_NOT_FOUND` | Source ID doesn't exist |
| `PIPELINE_WRONG_STATUS` | Source/story not in required status for step |
| `PIPELINE_STEP_FAILED` | A pipeline step failed (wraps cause) |
| `PIPELINE_RATE_LIMITED` | Gemini rate limit exhausted after retries (retriable) |
| `EXT_DOCUMENT_AI_FAILED` | Document AI API error |
| `EXT_VERTEX_AI_FAILED` | Gemini API error (rate limit, timeout, etc.) |
| `EXT_STORAGE_FAILED` | Cloud Storage error |
| `TAXONOMY_BOOTSTRAP_TOO_FEW` | Not enough documents for bootstrap |

### 7.3 Retry Strategy

External service calls (Gemini, Document AI, Cloud Storage) use exponential backoff:
- Max retries: 3
- Base delay: 1s, multiplier: 2 (1s, 2s, 4s)
- Retry on: rate limits (429), server errors (500-503), network timeouts
- No retry on: validation errors (400), auth errors (401/403), not found (404)

**After retry exhaustion:** The pipeline orchestrator marks the source/story as `failed` with error code `PIPELINE_RATE_LIMITED`. The `mulder pipeline retry` command can pick up these items later without reprocessing the entire batch.

---

## 8. Logging

All logging via pino, structured JSON. Every log entry includes:

```json
{
  "level": "info",
  "timestamp": "2026-03-27T10:00:00.000Z",
  "step": "enrich",
  "source_id": "abc-123",
  "story_id": "def-456",
  "message": "Entity extraction complete",
  "entities_found": 12,
  "duration_ms": 3420
}
```

Log levels:
- `debug` — detailed step internals (chunk boundaries, similarity scores, prompt snippets)
- `info` — step start/complete, item counts, durations
- `warn` — fallbacks triggered (e.g., Gemini Vision fallback), low confidence results, cache hits (dev mode)
- `error` — step failures, external service errors

CLI output uses a separate formatter (colors, tables, progress bars). Logs go to stderr, structured output to stdout.

---

## 9. Local Development Mode

For development and testing without GCP:

```bash
# Use local PostgreSQL instead of Cloud SQL
export MULDER_DB_HOST=localhost
export MULDER_DB_PORT=5432

# Use local file storage instead of Cloud Storage
export MULDER_STORAGE_LOCAL=true
export MULDER_STORAGE_PATH=./data/storage

# Skip Document AI, use Gemini Vision for all pages
export MULDER_EXTRACT_GEMINI_ONLY=true

# Enable LLM response cache (saves tokens during prompt iteration)
export MULDER_LLM_CACHE=true
```

The GCP client factory checks these env vars and returns local implementations when set. Pipeline steps don't need to know the difference.

---

## 10. Job Queue & Worker Architecture

### 10.1 The Problem

The original design said "The API is a thin HTTP layer on top of the same functions." This breaks in production: a 200-page PDF takes minutes to process through Extract → Segment → Enrich → Embed. Cloud Run kills the HTTP request after 60 minutes (default: 60 seconds). The browser shows a timeout. But the process may still be running in the background — an unmanageable state.

### 10.2 The Solution: PostgreSQL as Task Broker

Instead of adding Pub/Sub, Cloud Tasks, or Redis (infrastructure overhead for a small OSS community), we use PostgreSQL's `FOR UPDATE SKIP LOCKED` to turn the existing database into a concurrency-safe job queue.

**Architecture:**

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  API (Cloud Run) │────→│  jobs table  │←────│  Worker (mulder  │
│  POST /pipeline  │     │  (Postgres)  │     │  worker start)   │
│  → 202 Accepted  │     └──────────────┘     │  → polls + runs  │
│  + job_id        │                          │    pipeline fns  │
└─────────────────┘                          └─────────────────┘
       │                                            │
       │  GET /jobs/:id                             │
       └── Client polls for status ─────────────────┘
```

1. **API** validates the request, writes to `jobs` table, returns `202 Accepted` + `job_id` immediately
2. **Worker** (`mulder worker start`) polls `jobs` table, picks up pending jobs, executes pipeline functions
3. **Client** polls `GET /api/jobs/:id` for progress

#### Job Slicing: Per-Step, Not Per-Pipeline

A monolithic "run entire pipeline" job is dangerous: a 1000-page document through Extract → Segment → Enrich → Embed can take hours, exceeding Cloud Run's timeout (max 60 min). If the process dies mid-pipeline, the entire expensive computation is lost.

**Solution:** The orchestrator creates **one job per pipeline step per source**, not one job for the entire pipeline. When a step completes, it enqueues the next step as a new job.

```
POST /api/pipeline/run (source_id: "abc")
  → creates job: { type: "extract", payload: { source_id: "abc", run_id: "xyz" } }

Worker picks up "extract" job, runs extract("abc"), on success:
  → creates job: { type: "segment", payload: { source_id: "abc", run_id: "xyz" } }

Worker picks up "segment" job, runs segment("abc"), on success:
  → creates job: { type: "enrich", payload: { source_id: "abc", run_id: "xyz" } }

... and so on through the pipeline
```

**Benefits:**
- Each job runs one step — fast enough for any Cloud Run timeout
- A crash loses only the current step, not the entire pipeline
- Multiple workers can process different sources' steps concurrently
- Progress is visible per-step in the `jobs` table
- `--up-to` is trivial: just don't enqueue the next step

**In CLI mode** (direct invocation, not via worker), the orchestrator still chains steps synchronously in-process — no job queue overhead. Job slicing only applies when running via the worker.

### 10.3 Concurrency-Safe Job Dequeue

The secret to preventing multiple workers from grabbing the same job:

```typescript
// packages/worker/dequeue.ts
async function dequeueJob(workerId: string): Promise<Job | null> {
  const pool = getWorkerPool()  // dedicated OLTP pool, not shared with queries
  const result = await pool.query(`
    UPDATE jobs
    SET status = 'running',
        started_at = now(),
        attempts = attempts + 1,
        worker_id = $1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending' AND attempts < max_attempts
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED   -- if another worker locked this row, skip it
      LIMIT 1
    )
    RETURNING *;
  `, [workerId]);

  return result.rows[0] || null;
}
```

`FOR UPDATE SKIP LOCKED` means: "Lock this row for my transaction. If another worker already locked it, don't wait — just grab the next one." Zero contention, zero deadlocks.

### 10.4 Worker Loop

```typescript
// Pseudocode for mulder worker start
async function startWorker(options: WorkerOptions) {
  const workerId = `worker-${hostname()}-${process.pid}`
  logger.info({ workerId }, 'Worker started')

  while (!shuttingDown) {
    const job = await dequeueJob(workerId)

    if (!job) {
      await sleep(options.pollInterval)  // default: 5s
      continue
    }

    try {
      logger.info({ jobId: job.id, type: job.type }, 'Processing job')

      switch (job.type) {
        case 'pipeline_run':
          await runPipeline(job.payload.path, job.payload.options)
          break
        case 'ground_batch':
          await ground(job.payload.entities, job.payload.options)
          break
        // ... other job types
      }

      await markJobCompleted(job.id)
    } catch (error) {
      await markJobFailed(job.id, error.message)
    }
  }
}
```

### 10.5 Stuck Job Recovery (Reaper)

If a worker crashes (OOM, GCP preemption), its job stays `running` forever. The reaper fixes this:

```bash
mulder worker reap  # Reset jobs running > 2 hours back to pending
```

```sql
UPDATE jobs
SET status = 'pending', worker_id = NULL, started_at = NULL
WHERE status = 'running'
  AND started_at < now() - interval '2 hours';
```

### 10.6 API Contract (Phase H)

The API never calls pipeline functions directly. It's a pure job producer.

| Endpoint | Method | Action |
|----------|--------|--------|
| `/api/pipeline/run` | POST | Create job, return `202 { job_id }` |
| `/api/jobs/:id` | GET | Return job status, progress, errors |
| `/api/jobs` | GET | List recent jobs (filterable) |
| `/api/search` | POST | Synchronous — hybrid retrieval (fast, no job needed) |
| `/api/entities` | GET | Synchronous — entity listing/search |
| `/api/entities/:id` | GET | Synchronous — entity detail |
| `/api/evidence/*` | GET | Synchronous — pre-computed evidence data |

**Rule:** Only long-running operations (pipeline steps, batch grounding, analysis) go through the job queue. Read-only queries (search, entity lookup, evidence) are synchronous — they hit the database directly and return in milliseconds.

#### Rate Limiting (critical for LLM-calling endpoints)

`POST /api/search` is synchronous but triggers LLM re-ranking (Gemini Flash). Without rate limiting, a simple script sending 100 queries/second burns Gemini tokens uncontrollably and saturates the database with concurrent vector + fulltext + graph queries.

**Two-tier rate limiting:**

| Tier | Endpoints | Limit | Reason |
|------|-----------|-------|--------|
| **Strict** | `/api/search` (with reranking) | 10 req/min per IP | Each request calls Gemini Flash |
| **Standard** | `/api/search?no_rerank=true`, `/api/entities`, `/api/evidence` | 60 req/min per IP | DB-only, no LLM cost |
| **Relaxed** | `/api/jobs`, `/api/jobs/:id` | 120 req/min per IP | Lightweight status polling |

Implementation: Token bucket algorithm in middleware (e.g., `hono-rate-limiter` or custom). Stored in-memory per-process (no Redis needed for single-instance deployments). Returns `429 Too Many Requests` with `Retry-After` header.

---

## 11. Test Fixtures

### 11.1 The Problem

When implementing pipeline steps, the agent (Claude) will need to write tests against realistic external API responses. Without real examples, the agent will invent mock data that doesn't match actual Document AI or Gemini output structures — tests pass but production breaks.

### 11.2 The Solution

Provide real (anonymized) response fixtures that tests MUST use.

```
docs/fixtures/
├── document-ai/
│   ├── layout-parser-response.json       # Real Document AI Layout Parser output (1 page)
│   ├── layout-parser-multipage.json      # Multi-page response (3 pages, mixed confidence)
│   └── README.md                         # Field descriptions, version info
├── gemini/
│   ├── segment-response.json             # Real Gemini structured output for segmentation
│   ├── extract-entities-response.json    # Real Gemini structured output for entity extraction
│   ├── grounding-response.json           # Real Gemini google_search_retrieval response
│   └── README.md                         # Model version, schema version
└── pdfs/
    ├── native-text.pdf                   # PDF with extractable text (for native text detection)
    ├── scanned-magazine.pdf              # Scanned document requiring OCR (1-2 pages)
    └── mixed-layout.pdf                  # Multi-column layout with images
```

### 11.3 Usage Rules

1. **Pipeline step tests MUST load fixtures from `docs/fixtures/`** — never invent response structures
2. Fixtures are committed to the repo and version-controlled
3. Each fixture has a README documenting which API version produced it
4. When an API response format changes, update the fixture AND the test
5. The `zod-to-json-schema` conversion in Enrich step must be validated against the Gemini fixture — if the generated schema doesn't match what Gemini actually accepts, the test fails

---

## 12. Implementation Order

The build sequence follows dependencies. Each step is independently testable.

### Phase A: Foundation (no GCP, no LLM)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| A1 | Monorepo setup | pnpm, turbo, tsconfig, eslint | — |
| A2 | Config loader + Zod schemas | `loadConfig()` | A1 |
| A3 | Custom error classes | Error types | A1 |
| A4 | Logger setup | `logger` | A1 |
| A5 | CLI scaffold | `mulder` binary, `config validate`, `config show` | A1-A4 |
| A6 | Database client + migration runner | `getWorkerPool()`, `getQueryPool()`, `mulder db migrate` | A1, A5 |
| A7 | Core schema migrations (001-008) | Extensions, tables: sources, source_extractions, stories, entities, edges, chunks, taxonomy | A6 |
| A8 | Job queue + pipeline tracking migrations (012-014) | Tables: jobs, pipeline_runs, reset_pipeline_step() function | A6 |
| A9 | Test fixtures | `docs/fixtures/` with real API response samples | — |

**Testable at this point:** `mulder config validate`, `mulder db migrate`, `mulder db status`

### Phase B: Ingest + Extract (first GCP integration)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| B1 | GCP client factory | `getStorageClient()`, `getDocumentAIClient()`, etc. | A1-A4 |
| B2 | Source repository | CRUD for `sources` table | A7 |
| B3 | Native text detection | `pdf-parse` integration, `has_native_text` flag | A1 |
| B4 | Ingest step | `mulder ingest <path>` | B1, B2, B3 |
| B5 | Vertex AI wrapper + dev cache | `generateStructured()`, `generateText()`, `.mulder-cache.db` | B1 |
| B6 | Prompt template engine | `renderPrompt()` | A1 |
| B7 | Extract step (with native text gate) | `mulder extract <source-id>` | B1, B2, B5, B3 |

**Testable at this point:** Ingest PDFs (native text detected), extract text (Document AI skipped for text PDFs), inspect quality.

### Phase C: Segment + Enrich (core intelligence)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| C1 | Story repository | CRUD for `stories` table | A7 |
| C2 | Segment step | `mulder segment <source-id>` | B5, B6, C1 |
| C3 | Entity repository | CRUD for `entities`, `entity_aliases`, `story_entities` | A7 |
| C4 | Edge repository | CRUD for `entity_edges` | A7 |
| C5 | JSON Schema generator (via `zod-to-json-schema`) | Dynamic schema for Gemini structured output | A2 |
| C6 | Taxonomy normalization | `normalize()` function | A7 |
| C7 | Entity resolution (with lexicographic ordering) | `resolve()` function | C3 |
| C8 | Enrich step | `mulder enrich <story-id>` | B5, B6, C1-C7 |
| C9 | Cascading reset function | `reset_pipeline_step()` PL/pgSQL | A7 |

**Testable at this point:** Full extraction pipeline up to entities. `--force` re-runs clean up orphans. Inspect entities, relationships, taxonomy.

### Phase D: Embed + Graph + Pipeline (searchable)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| D1 | Embedding wrapper | `embed()` function | B1 |
| D2 | Semantic chunker | `chunk()` function | — |
| D3 | Chunk repository | CRUD for `chunks` table | A7 |
| D4 | Embed step | `mulder embed <story-id>` | D1-D3, B5, B6 |
| D5 | Graph step (edges + corroboration + contradiction flagging) | `mulder graph <story-id>` | C4 |
| D6 | Pipeline orchestrator (cursor-based) | `mulder pipeline run <path>` | B4, B7, C2, C8, D4, D5 |
| D7 | Full-text index builder | Populate `story_fts` table | C1 |

**Testable at this point:** Full MVP pipeline end-to-end. All data in PostgreSQL. Cursor-based resume works.

### Phase E: Retrieval (queryable)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| E1 | Vector search (HNSW index) | pgvector queries | D3 |
| E2 | Full-text search | tsvector queries | D7 |
| E3 | Graph traversal (with cycle detection) | Recursive CTE queries | C4 |
| E4 | RRF fusion | Combine results | E1-E3 |
| E5 | LLM re-ranking | Gemini re-rank | B5, B6 |
| E6 | Hybrid retrieval orchestrator | `mulder query <question>` | E1-E5 |

**Testable at this point: Full MVP — ingest, process, query. This is v1.0.**

### Phase F: Taxonomy + Entity Management (curation)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| F1 | Taxonomy bootstrap | `mulder taxonomy bootstrap` | C3, B5 |
| F2 | Taxonomy export/import/merge | `mulder taxonomy export/curate/merge` | F1 |
| F3 | Entity management CLI | `mulder entity list/show/merge/aliases` | C3 |
| F4 | Status overview | `mulder status` | B2, C1, C3 |
| F5 | Export commands | `mulder export graph/stories/evidence` | C3, C4 |

### Phase G: v2.0 — Ground + Analyze (intelligence layer)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| G1 | v2.0 schema migrations (009-011) | Tables: grounding, evidence_chains, clusters | A6 |
| G2 | Ground step | `mulder ground <entity-id>` | B5, G1 |
| G3 | Contradiction resolution (Analyze sub-step) | `mulder analyze --contradictions` | B5, B6, D5 |
| G4 | Source reliability scoring (Analyze sub-step) | `mulder analyze --reliability` | D5 |
| G5 | Evidence chains (Analyze sub-step) | `mulder analyze --evidence-chains` | D5, G1 |
| G6 | Spatio-temporal clustering (Analyze sub-step) | `mulder analyze --spatio-temporal` | G1, G2 |
| G7 | Analyze orchestrator | `mulder analyze --full` | G3-G6 |

### Phase H: Worker + API (async execution layer)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| H1 | Job queue repository | `enqueue()`, `dequeue()`, `reap()` | A8 |
| H2 | Worker loop | `mulder worker start/status/reap` | H1 |
| H3 | Hono/Express server scaffold | HTTP server | A1 |
| H4 | Pipeline API routes (async) | `POST /api/pipeline/run` → job | H1, H2, D6 |
| H5 | Job status API | `GET /api/jobs/:id` | H1 |
| H6 | Search API routes (sync) | `POST /api/search` | E6 |
| H7 | Entity API routes (sync) | `GET /api/entities/*` | C3 |
| H8 | Evidence API routes (sync) | `GET /api/evidence/*` | G7 |
| H9 | Middleware | Auth, rate limiting, error handling, validation | H3 |

**Key change from original spec:** The API no longer calls pipeline functions directly. Long-running operations go through the job queue. Only read-only queries (search, entities, evidence) are synchronous.

---

## 13. Source Layout

```
mulder/
├── package.json                    # Root: pnpm workspace
├── turbo.json                      # Turborepo config
├── tsconfig.base.json              # Shared TS config
├── mulder.config.yaml              # User's domain config
├── mulder.config.example.yaml      # Template
├── .mulder-cache.db                # Dev-mode LLM cache (gitignored)
│
├── packages/
│   ├── core/                       # Shared library
│   │   ├── package.json
│   │   └── src/
│   │       ├── config/             # Config loader + schemas
│   │       ├── database/           # Client, migrations, repositories
│   │       ├── shared/             # GCP factory, errors, logger, types
│   │       ├── prompts/            # Template engine + templates
│   │       ├── vertex.ts           # Vertex AI wrapper
│   │       └── llm-cache.ts        # Dev-mode LLM response cache
│   │
│   ├── pipeline/                   # Pipeline steps
│   │   ├── package.json
│   │   └── src/
│   │       ├── ingest/
│   │       ├── extract/
│   │       ├── segment/
│   │       ├── enrich/
│   │       ├── ground/
│   │       ├── embed/
│   │       ├── graph/
│   │       ├── analyze/
│   │       └── orchestrator.ts     # Pipeline composition (cursor-based)
│   │
│   ├── retrieval/                  # Search + retrieval
│   │   ├── package.json
│   │   └── src/
│   │       ├── vector.ts
│   │       ├── fulltext.ts
│   │       ├── graph.ts            # Recursive CTE with cycle detection
│   │       ├── fusion.ts
│   │       ├── reranker.ts
│   │       └── index.ts
│   │
│   ├── taxonomy/                   # Taxonomy management
│   │   ├── package.json
│   │   └── src/
│   │       ├── bootstrap.ts
│   │       ├── normalize.ts
│   │       └── merge.ts
│   │
│   ├── worker/                     # Job queue consumer
│   │   ├── package.json
│   │   └── src/
│   │       ├── dequeue.ts          # FOR UPDATE SKIP LOCKED polling
│   │       ├── loop.ts             # Worker event loop
│   │       └── reaper.ts           # Stuck job recovery
│   │
│   └── evidence/                   # v2.0: Evidence analysis
│       ├── package.json
│       └── src/
│           ├── contradictions.ts
│           ├── reliability.ts
│           ├── chains.ts
│           └── spatiotemporal.ts
│
├── apps/
│   ├── cli/                        # CLI application
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts            # Entry point
│   │       ├── commands/           # Command handlers (incl. worker.ts)
│   │       └── lib/                # CLI utilities
│   │
│   └── api/                        # HTTP API (Phase H)
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── routes/             # Job producer (async) + query (sync)
│           └── middleware/
│
├── terraform/                      # GCP infrastructure
│   ├── main.tf
│   ├── variables.tf
│   └── modules/
│       ├── cloud-sql/
│       ├── storage/
│       ├── cloud-run/
│       ├── pubsub/
│       ├── firestore/
│       ├── iam/
│       └── networking/
│
├── docs/
│   ├── specs/                      # Spec-driven development
│   ├── fixtures/                   # Real API response samples for testing
│   │   ├── document-ai/
│   │   ├── gemini/
│   │   └── pdfs/
│   └── functional-spec.md          # This document
│
└── demo/                           # Demo UI (existing)
```

### Package Dependencies

```
apps/cli     → packages/core, packages/pipeline, packages/retrieval, packages/taxonomy, packages/evidence, packages/worker
apps/api     → packages/core, packages/retrieval, packages/taxonomy, packages/evidence, packages/worker
packages/pipeline  → packages/core
packages/retrieval → packages/core
packages/taxonomy  → packages/core
packages/evidence  → packages/core
packages/worker    → packages/core, packages/pipeline
```

---

## 14. Key Design Decisions

### Why CLI-first, not API-first?

- CLI is testable without HTTP overhead
- CLI is usable in scripts, CI/CD, local dev
- CLI forces clean function boundaries (no request/response coupling)
- The API is NOT a thin layer — it's a job producer. Long-running operations go through the queue.
- Users can process documents locally before deploying to GCP

### Why monorepo with packages, not a flat src/?

- Each package has clear boundaries and can be tested independently
- Turborepo caches builds — change `packages/pipeline` without rebuilding `packages/retrieval`
- Packages can be versioned independently later if needed
- Clear dependency graph prevents circular imports

### Why repositories instead of raw SQL?

- SQL stays in one place per table — schema changes need one update, not hunting through pipeline code
- Repository functions are typed (input and output) — compile-time safety
- Easy to mock for unit tests
- Query optimization happens in one place

### Why a single PostgreSQL instance?

- pgvector, tsvector, PostGIS, recursive CTEs, AND the job queue all run on one connection
- No network hops between vector search and graph traversal
- Transactions across all data types (entity + embedding + edge in one commit)
- One backup, two connection pools (worker OLTP + query OLAP), one monitoring setup
- Cost: one Cloud SQL instance (~$100-150/month for 16GB RAM handling 768-dim HNSW) instead of three+ services
- The job queue (`FOR UPDATE SKIP LOCKED`) eliminates the need for Pub/Sub, Redis, or Cloud Tasks

### Why HNSW instead of ivfflat?

- ivfflat pre-computes cluster centers at index creation time. If documents trickle in (the normal case), the clusters become stale and recall degrades catastrophically
- HNSW handles incremental inserts natively — no index rebuild needed
- Slightly more memory per vector, but correctness > memory for our scale

### Why Gemini as the only LLM?

- Native PDF support (no intermediate conversion)
- Structured output (JSON mode with schema)
- google_search_retrieval tool (web grounding without third-party APIs)
- Vertex AI SDK (no API keys, just GCP IAM)
- One provider = one rate limit strategy, one retry policy, one cost model

### Why `zod-to-json-schema` instead of hand-rolled conversion?

- JSON Schema generation from TypeScript types is notoriously error-prone
- Subtle type mismatches (e.g., `additionalProperties`, `required` arrays) silently break Gemini structured output
- A battle-tested library eliminates an entire class of bugs
- The Zod schemas already exist (config validation) — reuse them

### Why a PostgreSQL job queue instead of Pub/Sub?

- Zero additional infrastructure — uses the existing Cloud SQL instance
- `FOR UPDATE SKIP LOCKED` is purpose-built for exactly this pattern
- Transactional consistency — job status and pipeline data in the same database
- For 2-10 concurrent users, PostgreSQL handles this trivially
- If we ever outgrow it (unlikely), migrating to Pub/Sub is a swap of the `dequeue()` function

### Why 768-dim instead of full 3072-dim vectors?

- `gemini-embedding-001` uses Matryoshka Representation Learning — truncating to 768 dims preserves most of the semantic quality
- 3072-dim HNSW at 1M vectors needs ~24GB RAM (the index must fit in memory for decent performance). A Cloud SQL instance with 64GB costs ~$500/month.
- 768-dim HNSW at 1M vectors needs ~6GB RAM. Fits comfortably on a 16GB instance (~$100/month).
- 75% cost reduction for minimal quality loss — the right trade-off for an OSS tool
- The raw 3072-dim embedding can be regenerated from the same text if ever needed (the text is stored alongside)

### Why async garbage collection instead of inline?

- `--force` resets run concurrently with enrichment workers in production
- Inline GC during reset deletes orphaned entities. A concurrent worker trying to link to one of those entities gets a FK violation.
- Decoupling GC from reset eliminates the race condition entirely
- Orphaned entities cost negligible storage — running `mulder db gc` daily or weekly is sufficient
- In single-user CLI mode, `mulder db gc` can be run immediately after a `--force` reset if desired

### Why per-step job slicing instead of monolithic pipeline jobs?

- Cloud Run has a hard timeout (max 60 min, default much less). A 1000-page document through the full pipeline can take hours.
- A monolithic job that dies at the Enrich step loses all the Extract + Segment work
- Per-step jobs mean each job completes in minutes, well within any timeout
- Failed steps can be retried individually without reprocessing earlier steps
- Multiple workers can process different steps for different sources concurrently
