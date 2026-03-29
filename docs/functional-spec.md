# Mulder — Functional Specification

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
│   ├── --cost-estimate   # Estimate pipeline cost before ingesting
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
│   │   ├── --cost-estimate # Estimate cost before executing
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
├── fixtures
│   └── generate          # Generate dev-mode fixtures from real GCP run
│       ├── --input <path>  # Input PDFs directory
│       └── --output <path> # Output fixtures directory
│
├── eval                  # Evaluate pipeline quality against golden test set
│   ├── --step <step>     # Evaluate a specific step only
│   ├── --compare baseline # Compare against saved baseline
│   └── --update-baseline # Save current results as new baseline
│
├── retry                 # Retry failed pipeline steps
│   ├── --document <id>   # Retry all failed steps for a document
│   └── --step <step>     # Retry a specific step for all failed documents
│
├── reprocess             # Selective reprocessing after config changes
│   ├── --dry-run         # Show what would reprocess without executing
│   ├── --step <step>     # Force reprocess a specific step
│   └── --cost-estimate   # Estimate reprocessing cost
│
└── status                # Overview: sources, stories, entities, pipeline health
    └── --failed          # Show only documents with failed steps
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
│   ├── status.ts         # status overview
│   ├── fixtures.ts       # fixtures generate
│   ├── eval.ts           # eval (quality framework)
│   ├── retry.ts          # retry failed steps
│   └── reprocess.ts      # selective reprocessing after config changes
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

**Global conventions for all steps:**
- **No internal retry logic.** All external API calls (Document AI, Gemini, Embedding API) use the centralized `RateLimiter` (token bucket in `src/shared/rate-limiter.ts`) and `withRetry` wrapper (`src/shared/retry.ts`). Steps never implement their own backoff.
- **Firestore as observability projection.** Each step fires a write-only update to Firestore (`documents/{doc-id}`) with granular per-page progress. This is purely for UI/monitoring — **PostgreSQL remains the authoritative source of truth** for pipeline state (`sources.status`, `stories.status`, `pipeline_runs`). If Firestore and PostgreSQL diverge, PostgreSQL wins. Workers never read Firestore for orchestration decisions (see [Section 3.2](#32-full-pipeline-orchestrator)).
- **Service abstraction.** Steps call service interfaces (`src/shared/services.ts`), never GCP clients directly. In dev mode, fixture-based implementations are injected transparently (see [Section 9](#9-local-development-mode)).

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

**Purpose:** OCR and layout analysis — turn PDF pages into structured layout data with spatial information.

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
5. **Write to GCS** (not PostgreSQL):
   - `gs://{bucket}/extracted/{doc-id}/layout.json` — Document AI Structured JSON with bounding boxes, reading order, confidence scores, block types per text fragment. This is the spatial source of truth for magazine layout segmentation.
   - `gs://{bucket}/extracted/{doc-id}/pages/page-{NNN}.png` — Page images for the Segment step (Gemini needs visual layout context)
6. Update source status to `extracted` in PostgreSQL (authoritative). Fire Firestore observability update (fire-and-forget).

**Output:** `ExtractionResult` — GCS URIs for layout JSON and page images, confidence per page, extraction method per page

**Key design decision:** Extraction output is Document AI Structured JSON with spatial data — NOT Markdown. Markdown is the *end format* per story after segmentation. The spatial information (bounding boxes, block positions) is critical for the Segment step to identify story boundaries in complex magazine layouts.

**Cost impact:** For a 50,000 page collection where 70% are text-based PDFs, this heuristic saves ~$3,500 in Document AI costs.

**Standalone value:** Run extraction separately to inspect OCR quality before committing to segmentation. Debug Document AI vs Gemini Vision vs native text per page.

**Dependencies:** Document AI API (only for scanned docs), Vertex AI (Gemini Vision), Cloud Storage

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'extract')` which deletes GCS extracted artifacts, then cascading-deletes all stories (via segments in GCS), chunks, edges, and orphaned entities before re-extracting.

### 2.3 Segment

**Purpose:** Identify and isolate individual articles/stories from a multi-article document.

**Input:**
- `source_id` (must have status >= `extracted`)
- Page images + Layout JSON from GCS (`gs://{bucket}/extracted/{doc-id}/`)

**Process:**
1. Load page images and layout JSON from GCS
2. Build segmentation prompt from config (`extraction.segmentation` section)
3. Send to Gemini with **page images + layout JSON** as context. Gemini sees both the visual layout and the extracted text, enabling it to identify story boundaries, advertisements, captions, and multi-column flows. Spatial information is fully available at this stage.
4. Gemini returns structured output:
   ```
   { stories: [{ title, subtitle?, page_start, page_end, language, category }] }
   ```
5. For each identified story, generate the story text as **Markdown** (headings as `#`, paragraphs separated, bold preserved) — this is the final content format for downstream steps.
6. **Write to GCS** (not PostgreSQL):
   - `gs://{bucket}/segments/{doc-id}/{segment-id}.md` — Story text as Markdown
   - `gs://{bucket}/segments/{doc-id}/{segment-id}.meta.json` — Lean metadata JSON (no content):
     ```json
     {
       "id": "seg-abc123",
       "document_id": "doc-xyz",
       "title": "...",
       "author": "...",
       "language": "de",
       "category": "sighting_report",
       "pages": [12, 13, 14],
       "date_references": ["1987-03-15"],
       "geographic_references": ["Bodensee", "Konstanz"],
       "extraction_confidence": 0.92
     }
     ```
7. Create `stories` records in PostgreSQL with GCS URIs (no inline text), linked to source
8. Update source status to `segmented` in PostgreSQL (authoritative). Fire Firestore observability update (fire-and-forget).

**Key design decision:** Markdown is the *end format* per story, written once here. The metadata JSON is lean — no content duplication. Full story text lives only in GCS and is loaded on demand (e.g., for RAG answers with full context).

**Output:** `Story[]` — GCS URIs for Markdown + metadata, page ranges, language

**Standalone value:** Re-segment when improving segmentation prompts. Compare segmentation strategies.

**Dependencies:** Vertex AI (Gemini), Cloud Storage, PostgreSQL

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'segment')` which deletes ALL stories for this source and their GCS segment artifacts. Thanks to `ON DELETE CASCADE`, all chunks, story_entities junctions, and edges originating from those stories are automatically removed. Entities that become orphaned (zero story links) are NOT deleted inline — they are cleaned up later by `mulder db gc` to avoid race conditions with concurrent workers.

### 2.4 Enrich

**Purpose:** Extract entities and relationships from stories based on the config ontology. Normalize against taxonomy. Resolve cross-document entity matches.

**Input:**
- `story_id` (must have status >= `segmented`)
- Story Markdown from GCS (loaded via `gcs_markdown_uri`)
- Ontology definition from config
- Current taxonomy (if exists)

**Process:**
1. Load story Markdown from GCS
2. **Hard token-count check** (via `@google/generative-ai` tokenizer or `countTokens` API):
   - Count tokens in the loaded Markdown content
   - If tokens ≤ `enrichment.max_story_tokens` (default: 15,000): proceed normally (single LLM call)
   - If tokens > limit: **pre-chunk fallback** — split the story Markdown into logical sub-chunks (~10,000 tokens each, split at paragraph boundaries), run the extraction prompt on each sub-chunk individually, then aggregate and deduplicate the extracted entities in application code before writing to the database. This handles the case where the Segment step produces an oversized story (e.g., a 60-page chapter as one "story"). Without this guard, Gemini's structured output gets truncated mid-JSON (invalid response) or entity extraction quality degrades severely due to the "Lost in the Middle" phenomenon.
3. **Generate JSON Schema from config ontology** using `zod-to-json-schema` library (mandatory — do NOT hand-roll schema conversion). Build Zod schemas from config ontology definition, then convert to JSON Schema for Gemini structured output. This ensures schema validity and prevents subtle type mismatches that break structured output.
4. Build extraction prompt with generated schema + story text (or sub-chunk text)
5. Send to Gemini with structured output → get entities + relationships with confidence scores. If pre-chunked: send each sub-chunk separately, merge results.
6. **Taxonomy normalization** (inline):
   - For each extracted entity, search taxonomy for matching canonical entry (via `pg_trgm` similarity)
   - If match found (similarity > threshold): assign `canonical_id`, add as alias
   - If no match: create new taxonomy entry with status `auto`
7. **Cross-lingual entity resolution** (cross-document, language-agnostic):
   Three-tier strategy that works across all languages, not just `supported_locales`:
   - **Tier 1 — Attribute match** (deterministic): Entities with identical normalized attributes (GPS coordinates, ISO dates, Wikidata IDs) are merged. Grounding provides these attributes. Works for any language Google Search covers.
   - **Tier 2 — Embedding similarity** (statistical): Entity names are embedded via `text-embedding-004` and compared. The model supports 100+ languages in the same semantic space — "München" and "Munich" are already close. Above `entity_resolution.embedding_threshold` (default: 0.85) → merge candidate.
   - **Tier 3 — LLM-assisted** (semantic): Gemini receives candidate pairs and decides whether they represent the same entity. Works language-independently — Gemini understands 40+ languages production-grade.
   - If match found at any tier: merge → update `canonical_id`, add as language-specific alias variant
   - If no match: create new entity
   - **Taxonomy as cross-lingual anchor:** Canonical taxonomy entries have no language — they have an ID and variants in any number of languages. `supported_locales` controls UI/prompt language only, not entity resolution.
   - **Deadlock prevention:** Sort all entity upserts lexicographically by `(entity_type, canonical_name)` before writing to PostgreSQL. This guarantees consistent lock ordering when multiple CLI processes or workers enrich stories concurrently, preventing transaction deadlocks.
8. Write entities to `entities` table, relationships to `entity_edges` table
9. Write entity-story links to `story_entities` junction table
10. Update story status to `enriched`

**Output:** `EnrichmentResult` — entities extracted, entities resolved, relationships created, taxonomy entries added

**Standalone value:** Re-enrich after updating the ontology config. Re-run after taxonomy curation to improve normalization. Debug entity resolution decisions.

**Dependencies:** Vertex AI (Gemini), PostgreSQL, Config (ontology + taxonomy)

**Force behavior:** When called with `--source <id> --force`, calls `reset_pipeline_step(source_id, 'enrich')` which deletes story_entities junctions and entity_edges for all stories of that source. Story GCS URIs are preserved. Orphaned entities are cleaned up later by `mulder db gc`. When called with `<story-id> --force`, resets only that single story's entity links and edges (no source-level reset). The `--all --force` flag is not supported — too dangerous for bulk operations, use `--source` to scope the reset.

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
- Story Markdown from GCS (loaded via `gcs_markdown_uri`)
- Extracted entities from PostgreSQL

**Process:**
1. Load story Markdown from GCS and entity data from PostgreSQL
2. **Semantic chunking:**
   - Split story into chunks based on semantic boundaries (paragraph breaks, topic shifts)
   - Target chunk size from config (default: ~512 tokens, overlap: ~50 tokens)
   - Each chunk retains metadata: story_id, page range, entity references
3. **Question generation** (per chunk):
   - Generate 2-3 questions this chunk could answer (via Gemini)
   - These questions become additional embedding targets (improves retrieval for question-style queries)
4. **Embedding:**
   - Embed each chunk text via `text-embedding-004` (Matryoshka model, multilingual, 100+ languages)
   - Embed generated questions via same model
   - **Native Matryoshka dimension reduction via API parameter:**
     Pass `outputDimensionality: 768` in the Vertex AI API call. The API returns a mathematically correct 768-dim projection, already L2-normalized. This is critical for resource planning:
     - 3072-dim: 1M vectors × 3072 × 4 bytes = ~12GB data + ~24GB HNSW index = needs a 64GB Cloud SQL instance (~$500/mo)
     - 768-dim: 1M vectors × 768 × 4 bytes = ~3GB data + ~6GB HNSW index = fits a 16GB Cloud SQL instance (~$100/mo)
     - Quality loss at 768-dim is minimal for `text-embedding-004` (trained with Matryoshka Representation Learning)
   - **CRITICAL: NEVER truncate vectors manually in application code** (e.g., `array.slice(0, 768)`). Manual slicing destroys the semantic geometry because the dimensions are not independently meaningful. The `outputDimensionality` API parameter applies a learned projection that preserves semantic relationships. This must be enforced in code review.
5. Store in `chunks` table: content chunks as rows with `is_question=false`, generated questions as separate rows with `is_question=true` and `parent_chunk_id` pointing to their source chunk. pgvector does not support `vector[]` arrays — each embedding needs its own row.
6. Update story status to `embedded`

**Output:** `EmbeddingResult` — chunks created, embeddings stored, questions generated

**Standalone value:** Re-embed after changing chunking strategy. Re-embed with updated entity data. Generate embeddings for specific stories.

**Dependencies:** Vertex AI (Gemini for questions, `text-embedding-004` for embeddings), PostgreSQL (pgvector)

**Force behavior:** `--force` calls `reset_pipeline_step(source_id, 'embed')` which directly deletes all chunks (embeddings + FTS vectors live on the same table) for the source's stories, then resets story status to `enriched`. Stories, entities, and edges are preserved. No orphan risk since chunks only link to one story.

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
3. **Deduplication** (before corroboration — critical for score accuracy):
   - Run MinHash/SimHash on chunk embeddings for the story's segments
   - Compare against all existing segments to detect near-duplicates (reprints, updated versions, summaries of older reports)
   - If similarity > `deduplication.segment_level.similarity_threshold` (default: 0.90): create `DUPLICATE_OF` edge with `similarity_score` and `duplicate_type` (`exact` | `near` | `reprint` | `summary`)
   - Duplicates are **marked, not deleted** — original text is preserved but excluded from corroboration counting
   - Distinguish "same text reprinted" (= one source) from "different authors independently reporting on the same event" (= real corroboration). Signals: same author + identical passages + same source → one source. Different authors + different phrasing + different details → real corroboration.
5. **Corroboration scoring** (SQL aggregation, dedup-aware):
   - For each entity, count independent sources (different `source_id` values via `story_entities` → `stories` → `source_id`)
   - **Exclude near-duplicates:** Stories linked by `DUPLICATE_OF` edges count as one source, not multiple
   - Update `entities.source_count` with the independent source count
   - Calculate corroboration score: `min(source_count / min_independent_sources, 1.0)`
   - Update `entities.corroboration_score`
6. **Contradiction flagging** (attribute diff, no LLM):
   - For each entity with multiple source mentions, compare key attributes (date, location, description)
   - If attributes conflict (e.g., different dates for the same event): create `POTENTIAL_CONTRADICTION` edge between the two claims
   - Fast pass — no LLM, only string/date comparison
7. Update story status to `graphed`

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

**Source of truth: PostgreSQL.** Pipeline orchestration, crash recovery, and job state all rely on PostgreSQL (`sources.status`, `stories.status`, `pipeline_runs`, `jobs`). The orchestrator writes progress to the `pipeline_runs` table. Each source gets a row tracking which step it's on, so a crash at document 45,000 resumes from document 45,000 — not from the beginning. **Workers never read Firestore for orchestration decisions.**

**Observability projection: Firestore.** Each step fires a write-only, fire-and-forget update to Firestore (`documents/{doc-id}`) with granular per-page progress. This is purely for the UI/monitoring layer — it provides real-time detail (e.g., "95 of 100 pages extracted") that the batch-level PostgreSQL rows don't capture. If Firestore is unavailable or diverges, the pipeline is unaffected.

```typescript
// Firestore: documents/{doc-id} — OBSERVABILITY ONLY, not read by workers
interface DocumentProcessingState {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'partial' | 'failed';
  steps: {
    [step: string]: {
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
      config_hash: string;       // Projection from source_steps table (not read for orchestration)
      started_at?: Timestamp;
      completed_at?: Timestamp;
      error?: {
        code: string;            // e.g., 'EXTRACTION_LOW_CONFIDENCE', 'GEMINI_TIMEOUT'
        message: string;
        page?: number;           // Which page the error occurred on
        retries: number;
      };
      metrics?: {
        pages_processed?: number;
        entities_extracted?: number;
        duration_ms?: number;
      };
    };
  };
}
```

**Partial results are preserved.** If Extract succeeds for 95 of 100 pages and 5 fail: the 95 successful pages are written to GCS, the source is marked `partial` in PostgreSQL with error details, and the Segment step can run on the 95 pages (best-effort). The 5 failed pages can be retried individually later.

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
    → CASCADE: chunks (incl. FTS vectors), story_entities, entity_edges
  DELETE extracted artifacts from GCS (layout.json, page images)

segment --force:
  DELETE stories WHERE source_id = X
    → CASCADE: chunks (incl. FTS vectors), story_entities, entity_edges
  DELETE segment artifacts from GCS (*.md, *.meta.json)
  (extracted artifacts preserved — no need to re-extract)

enrich --force:
  DELETE story_entities, entity_edges for stories of source X
  (story GCS URIs, chunks preserved)

embed --force:
  DELETE chunks (incl. FTS vectors) for stories of source X
  (entities, edges preserved)

graph --force:
  DELETE entity_edges for stories of source X
  (entities, chunks, embeddings preserved)
```

**The entity trap:** Entities like "USA" appear in dozens of documents. `--force` resets delete the junction (`story_entities`) and edges from the specific source, but do NOT delete the entities themselves — even if they become orphaned (zero remaining story links). Orphaned entity cleanup runs separately via `mulder db gc` or as a scheduled background job. This prevents race conditions where a concurrent worker tries to link to an entity that's being deleted by another worker's `--force` reset.

**Implementation:** See `reset_pipeline_step()` in [Section 4.3](#43-core-database-schema).

**`--force` vs `reprocess` — when to use which:**
- **`--force`** is a destructive manual override. It cascading-deletes downstream data for a specific source/step and reruns from scratch. Use when you know a specific step produced bad output and want to redo it.
- **`reprocess`** is a smart, non-destructive state reconciliation. It detects which documents need which steps re-run based on config changes, and executes the minimal set. Use after updating the config (new entity types, changed prompts, etc.).

### 3.5 Schema Evolution & Selective Reprocessing

**The problem:** After 200+ documents are processed, a config change (new entity type, updated taxonomy, changed extraction settings) shouldn't require reprocessing everything from scratch.

**The solution:** Every pipeline step stores the `config_hash` (SHA-256 of the step-relevant config subset) in a dedicated PostgreSQL table (`source_steps`). When config changes, a diff determines which steps need re-running for which documents. Firestore receives a copy of this data strictly for UI observability, but the CLI and workers never read from it.

**Reprocessing Matrix:**

| Config Change | Steps to Re-run | Preserved |
|---|---|---|
| Ontology change (new entity type, relationship) | Enrich → Ground → Graph → Analyze | Extract, Segment |
| Taxonomy extended | Normalization (part of Enrich) → Graph | Extract, Segment, Embed |
| Retrieval config (weights, re-ranker) | **None** — takes effect at query time | Everything |
| Evidence config | Analyze only | Everything else |
| Extraction config (layout_complexity) | Extract → all downstream | Nothing |

**CLI integration:**
```bash
mulder reprocess --dry-run      # Show what needs reprocessing + estimated cost
mulder reprocess                # Run selective reprocessing
mulder reprocess --step enrich  # Force a specific step for all documents
mulder reprocess --cost-estimate # Show cost estimate without dry-run details
```

The `reprocess` command queries `source_steps` in PostgreSQL, compares each document's per-step `config_hash` against the current config, builds the minimal set of steps to re-run, and executes them in dependency order.

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
│   ├── 003_source_steps.sql        # Per-document, per-step config_hash tracking
│   ├── 004_stories.sql             # References + GCS URIs, no inline content
│   ├── 005_entities.sql
│   ├── 006_entity_edges.sql
│   ├── 007_chunks.sql              # Short chunk text inline (for vector + BM25)
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

-- Source Steps: Permanent tracking of step execution and config state per document.
-- This is the source of truth for `mulder reprocess` to determine if a step
-- needs to be re-run due to a config change. Separate from the transient
-- pipeline_run_sources table (which tracks a specific batch run's progress).
CREATE TABLE source_steps (
  source_id       UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  step_name       TEXT NOT NULL,                     -- 'extract', 'segment', 'enrich', etc.
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending', 'completed', 'failed', 'partial'
  config_hash     TEXT,                              -- SHA-256 of the step-relevant config subset
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  PRIMARY KEY (source_id, step_name)
);

-- NOTE: source_extractions table REMOVED. Extract step writes Document AI
-- Structured JSON + page images to GCS (gs://{bucket}/extracted/{doc-id}/).
-- No raw extraction text stored in PostgreSQL.

-- Stories: individual articles/segments within a source
-- Content lives in GCS (Markdown + Metadata JSON), not inline.
-- NOTE: ON DELETE CASCADE on all child tables ensures clean --force re-runs
CREATE TABLE stories (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         UUID NOT NULL REFERENCES sources(id),
  title             TEXT NOT NULL,
  subtitle          TEXT,
  language          TEXT,
  category          TEXT,
  page_start        INTEGER,
  page_end          INTEGER,
  gcs_markdown_uri  TEXT NOT NULL,          -- gs://bucket/segments/{doc-id}/{seg-id}.md
  gcs_metadata_uri  TEXT NOT NULL,          -- gs://bucket/segments/{doc-id}/{seg-id}.meta.json
  chunk_count       INTEGER DEFAULT 0,
  extraction_confidence FLOAT,
  status            TEXT NOT NULL DEFAULT 'segmented',
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
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
-- chunks.content is inline because chunks are small (~512 tokens) and needed
-- directly for retrieval (vector search + BM25 in one query). Full story
-- Markdown (multi-page) lives only in GCS, loaded on demand for RAG context.
CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id        UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,           -- Chunk text inline (short, ~512 tokens)
  chunk_index     INTEGER NOT NULL,
  page_start      INTEGER,
  page_end        INTEGER,
  embedding       vector(768),             -- text-embedding-004 with outputDimensionality: 768; configurable via embedding.storage_dimensions
  fts_vector      tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,  -- BM25 on same table as vectors
  is_question     BOOLEAN DEFAULT false,   -- true = generated question, false = content chunk
  parent_chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,  -- question → parent content chunk
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- NOTE: Full-text search lives on the chunks table (generated tsvector column),
-- not in a separate story_fts table. This keeps both vector search and BM25
-- on the same table for fast hybrid queries. See chunks table above.

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
CREATE TYPE job_status AS ENUM ('pending', 'running', 'completed', 'failed', 'dead_letter');

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
CREATE INDEX idx_chunks_story ON chunks(story_id);
CREATE INDEX idx_chunks_questions ON chunks(parent_chunk_id) WHERE is_question = true;
CREATE INDEX idx_chunks_fts ON chunks USING gin(fts_vector);
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
  -- EXTRACT: nuke everything (GCS extracted artifacts deleted by caller in application code)
  IF p_step = 'extract' THEN
    DELETE FROM stories WHERE source_id = p_source_id;        -- cascades to chunks, story_entities, edges
    DELETE FROM source_steps WHERE source_id = p_source_id;   -- clear ALL step state
    UPDATE sources SET status = 'ingested' WHERE id = p_source_id;
    -- NOTE: GCS cleanup (extracted/ + segments/) handled in application code after this function returns
  END IF;

  -- SEGMENT: nuke stories + downstream, keep extracted artifacts in GCS
  -- Deleting stories cascades to: chunks (incl. FTS vectors), story_entities, entity_edges
  IF p_step = 'segment' THEN
    DELETE FROM stories WHERE source_id = p_source_id;
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('segment', 'enrich', 'embed', 'graph');
    UPDATE sources SET status = 'extracted' WHERE id = p_source_id;
  END IF;

  -- ENRICH: keep story GCS URIs, delete entity links + edges
  IF p_step = 'enrich' THEN
    DELETE FROM story_entities
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM entity_edges
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('enrich', 'embed', 'graph');
    UPDATE stories SET status = 'segmented' WHERE source_id = p_source_id;
    UPDATE sources SET status = 'segmented' WHERE id = p_source_id;
  END IF;

  -- EMBED: keep entities and edges, delete chunks (vectors + FTS vectors live on same table)
  IF p_step = 'embed' THEN
    DELETE FROM chunks
      WHERE story_id IN (SELECT id FROM stories WHERE source_id = p_source_id);
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name IN ('embed', 'graph');
    UPDATE stories SET status = 'enriched' WHERE source_id = p_source_id;
  END IF;

  -- GRAPH: delete edges only (keep entities, chunks, embeddings)
  IF p_step = 'graph' THEN
    DELETE FROM source_steps WHERE source_id = p_source_id
      AND step_name = 'graph';
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

### 4.4 Storage Architecture

**Principle: Content in Cloud Storage, References/Index in Cloud SQL.**

No Markdown or long text in database columns. PostgreSQL stores references (GCS URIs) and the search index (short chunk text + embeddings + tsvector). All content artifacts live in GCS.

```
gs://mulder-{project}/
├── raw/                          # Original PDFs (immutable)
│   └── {doc-id}.pdf
├── extracted/                    # Document AI JSON (spatial, archival)
│   └── {doc-id}/
│       ├── layout.json           # Full Layout Parser result (bounding boxes, reading order)
│       └── pages/                # Page images (for Gemini Segment step)
│           ├── page-001.png
│           └── page-002.png
├── segments/                     # Per story: Markdown + Metadata (separated)
│   └── {doc-id}/
│       ├── {segment-id}.md       # Pure story text as Markdown
│       ├── {segment-id}.meta.json # Lean metadata JSON (no content)
│       └── {segment-id}/
│           └── images/           # Phase 2: extracted images
│               ├── img-001.png
│               └── img-001.meta.json
└── taxonomy/                     # Auto-generated + curated taxonomy
    ├── taxonomy.auto.yaml
    └── taxonomy.curated.yaml
```

**Why this split:**
- `chunks.content` is inline because chunks are small (~512 tokens) and directly needed for retrieval (vector search + BM25 in one query, no GCS round-trip)
- Full story Markdown (can span multiple pages) lives only in GCS and is loaded on demand (e.g., for RAG answer with full context)
- Segment metadata JSON is lean (no content) — structured fields only

### 4.5 Service Abstraction

Every GCP service is called through an interface. In dev mode, fixture-based implementations return pre-recorded responses. In production, real GCP clients are used. Pipeline steps never know the difference.

```
src/shared/
├── services.ts           # Service interfaces (DocumentExtractor, LlmService, etc.)
├── services.dev.ts       # Dev mode: reads from fixtures/
├── services.gcp.ts       # Production: real GCP API calls
├── registry.ts           # Service registry — selects implementation based on mode
├── rate-limiter.ts       # Central token-bucket rate limiter
├── retry.ts              # Retry with exponential backoff + jitter
└── cost-estimator.ts     # Cost estimation for pipeline operations
```

```typescript
// src/shared/registry.ts
export function createServices(config: MulderConfig): Services {
  if (config.dev_mode || process.env.NODE_ENV === 'development') {
    return createDevServices(config);   // Fixtures
  }
  return createGcpServices(config);     // Real GCP calls
}
```

**Rule:** Never instantiate GCP clients directly in pipeline code. Always go through the service registry. This makes local development free (no GCP costs) and testing deterministic.

### 4.6 GCP Clients (Connection Manager)

**Relationship to Section 4.5:** These are three distinct layers with clear responsibilities:

| Layer | File | Role |
|-------|------|------|
| **Connection Manager** | `gcp.ts` | Holds lazy-initialized, singleton raw GCP SDK clients + PostgreSQL connection pools. Knows how to connect, nothing else. |
| **Implementation Layer** | `services.gcp.ts` | Classes that inject raw clients from `gcp.ts` and implement the service interfaces from `services.ts`. Formats data, handles API specifics. |
| **Dependency Injector** | `registry.ts` | Hands the pipeline either `services.gcp.ts` (production) or `services.dev.ts` (dev mode). Pipeline steps only see the interfaces. |

Pipeline steps call service interfaces (Section 4.5) → registry selects implementation → GCP implementations use `gcp.ts` for raw clients.

```
src/shared/
├── gcp.ts                # Connection manager — raw GCP SDK clients (lazy singletons)
├── errors.ts             # Custom error classes with error codes
├── logger.ts             # Pino logger, structured JSON, configurable level
└── types.ts              # Shared TypeScript types
```

**`gcp.ts` connection manager:**

```typescript
// Lazy singletons — raw SDK clients, used by services.gcp.ts only
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

**Pipeline steps NEVER import `gcp.ts` directly.** They call service interfaces which are injected by the registry. Only `services.gcp.ts` imports from `gcp.ts`.

**Why two pools:** PostgreSQL's `FOR UPDATE SKIP LOCKED` (job queue) runs in microseconds but needs a connection always available. Vector search + recursive CTEs can take seconds and saturate the pool. If a single pool is shared, a burst of heavy search queries starves the worker — it can't dequeue jobs because all connections are occupied. Two pools guarantee the worker always has a connection available.

### 4.7 Prompt Templates

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

### 4.8 Vertex AI Wrapper + Dev Cache

```
src/shared/
├── vertex.ts             # Thin wrapper around Vertex AI SDK
└── llm-cache.ts          # Request-hash → response cache (dev mode only)
```

**Functions:**
- `generateStructured<T>(prompt, schema): T` — Gemini structured output with Zod validation of response
- `generateText(prompt): string` — Plain text generation
- `embed(texts: string[], dimensions?: number): number[][]` — Batch embedding via `text-embedding-004` with `outputDimensionality` parameter (default: 768). NEVER truncate vectors manually in application code.
- `groundedGenerate(prompt, entity): GroundingResult` — Gemini with google_search_retrieval tool

Wraps the Vertex AI SDK with the shared `withRetry` (`retry.ts`) and `RateLimiter` (`rate-limiter.ts`) modules, plus a process-level concurrency limiter (see below). All pipeline steps call these functions, never the Vertex AI SDK directly.

#### Vertex AI Concurrency Limiter (Thundering Herd Protection)

**The problem:** If 3 workers with `concurrency: 5` each run simultaneously, 15 jobs fire Gemini API calls in the same millisecond window. Google's Vertex AI quotas (requests per minute per project) are quickly exhausted → all 15 get `429 Too Many Requests` → exponential backoff → all 15 sleep ~2s → all 15 wake up simultaneously → another burst of 429s. This retry storm is self-sustaining and wastes minutes per batch.

**The solution:** A **process-level concurrency limiter** (e.g., `p-limit`) inside `vertex.ts`. Regardless of how many jobs a worker is processing concurrently, outgoing Vertex AI requests are throttled to `vertex.max_concurrent_requests` (default: 2) per worker process.

```typescript
import pLimit from 'p-limit'

// Max 2 concurrent Vertex AI requests per worker process.
// Additional requests queue in Node.js memory — zero cost, no network overhead.
const vertexLimiter = pLimit(2)

export async function generateStructured<T>(prompt: string, schema: ZodSchema<T>): Promise<T> {
  return vertexLimiter(async () => {
    // ... actual Vertex AI SDK call
  })
}
```

**Key points:**
- The limiter is per-process, not per-cluster. 3 workers = 6 total concurrent Vertex AI requests.
- This is proactive throttling — requests queue locally before hitting the network, preventing 429s entirely.
- The exponential backoff in the retry strategy (Section 7.3) remains as a safety net for genuine API errors, but should rarely trigger if the limiter is configured correctly.
- Embedding calls (`embed()`) also go through the limiter — they share the same Vertex AI quota.

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
SELECT c.id, c.story_id, c.content, 1 - (c.embedding <=> $1) AS score
FROM chunks c
ORDER BY c.embedding <=> $1
LIMIT $2
```

**Full-text search (`fulltext.ts`):**
```sql
-- BM25 on the same chunks table as vector search — no join, no separate FTS table.
-- The fts_vector column is a GENERATED ALWAYS column on chunks.content.
SELECT c.id, c.story_id, c.content, ts_rank(c.fts_vector, plainto_tsquery($1)) AS score
FROM chunks c
WHERE c.fts_vector @@ plainto_tsquery($1)
  AND c.is_question = false       -- only match content chunks, not generated questions
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

### 5.3 Sparse Graph Degradation

Features have minimum data thresholds below which they degrade gracefully instead of returning misleading results. Every API response includes a `confidence` object so consumers know how reliable the results are.

**Thresholds** (configurable in `mulder.config.yaml`):

```yaml
thresholds:
  taxonomy_bootstrap: 25           # Documents before taxonomy bootstrap runs
  corroboration_meaningful: 50     # Documents before corroboration scores are reliable
  graph_community_detection: 100   # Entities before community detection is meaningful
  temporal_clustering: 30          # Events with timestamps before clustering activates
  source_reliability: 50           # Documents before PageRank stabilizes
```

**Degradation behavior:**
- **Taxonomy** < threshold: Entities are extracted but not normalized. Raw entity names in the graph.
- **Corroboration** < threshold: Score returned as `null` / `"insufficient_data"`, not `1`.
- **Hybrid Retrieval** with sparse data: Falls back to pure vector search. BM25 and graph expansion remain active but with honest confidence ("graph expansion returned 0 additional results").
- **Evidence chains** < threshold: Feature disabled, API endpoint returns `501 Not Yet Available` with explanation.

**API response `confidence` object:**
```json
{
  "results": [...],
  "confidence": {
    "corpus_size": 12,
    "taxonomy_status": "bootstrapping",
    "corroboration_reliability": "low",
    "graph_density": 0.03
  }
}
```

Values for `taxonomy_status`: `"not_started"` | `"bootstrapping"` | `"active"` | `"mature"`. Values for `corroboration_reliability`: `"insufficient"` | `"low"` | `"moderate"` | `"high"`.

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

**Sparse graph guard:** Taxonomy bootstrap only runs when corpus size ≥ `thresholds.taxonomy_bootstrap` (default: 25 documents). Below that threshold, entities are extracted and stored with raw names but not normalized. The `mulder taxonomy bootstrap` command enforces this (can be overridden with `--min-docs`).

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

`taxonomy.curated.yaml` format (language-agnostic — canonical entries have no language, only variants):
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
    - canonical: "Munich"
      id: "loc:munich"
      wikidata: "Q1726"
      status: confirmed
      variants:
        de: ["München"]
        en: ["Munich"]
        it: ["Monaco di Baviera"]
      aliases: ["Roswell", "Roswell NM"]
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

### 9.1 Fixture-Based Dev Mode

Document AI and Gemini have no local equivalent. Without a dev story, every iteration costs money and latency. The solution: pre-recorded real API responses that pipeline steps consume transparently.

**`fixtures/` directory** in the repo with real, checked-in artifacts from a one-time GCP run against a small test corpus (3-5 pages of varying layout complexity):

```
fixtures/
├── raw/                           # 2-3 test PDFs (public domain or self-created)
│   ├── simple-layout.pdf
│   ├── complex-magazine.pdf
│   └── mixed-language.pdf
├── extracted/                     # Real Document AI Layout Parser outputs
│   ├── simple-layout/
│   │   └── layout.json
│   └── complex-magazine/
│       ├── layout.json
│       └── pages/
│           ├── page-001.png
│           └── page-002.png
├── segments/                      # Real Gemini segmentation outputs
│   └── complex-magazine/
│       ├── seg-001.md
│       ├── seg-001.meta.json
│       ├── seg-002.md
│       └── seg-002.meta.json
├── entities/                      # Real Gemini entity extraction outputs
│   └── seg-001.entities.json
├── embeddings/                    # Real text-embedding-004 outputs
│   └── seg-001.embeddings.json
└── grounding/                     # Real Gemini Search Grounding outputs
    └── loc-munich.grounding.json
```

Fixtures are generated from a real GCP run via:
```bash
npx mulder fixtures generate --input ./test-pdfs/ --output ./fixtures/
```

### 9.2 Service Abstraction

Pipeline steps call service interfaces, not GCP clients. The service registry selects the implementation based on mode (see [Section 4.5](#45-service-abstraction)):
- `dev_mode: true` or `NODE_ENV=development` → fixture-based implementations (zero GCP calls, zero cost)
- `NODE_ENV=test` → **actively blocks** real GCP calls (throws if a real client is instantiated, preventing CI/CD from accidentally generating costs)
- Production → real GCP clients via service registry

### 9.3 Local Infrastructure

```yaml
# docker-compose.yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    # + PostGIS via Dockerfile or init script
    ports: ["5432:5432"]
  firestore:
    image: google/cloud-sdk
    command: gcloud emulators firestore start --host-port=0.0.0.0:8080
    ports: ["8080:8080"]
```

Config:
```yaml
# mulder.config.yaml
dev_mode: true   # true → fixtures + local DB, no GCP calls
```

### 9.4 Dev-Mode LLM Cache

Still applies: a local SQLite cache (`.mulder-cache.db`) that hashes `(model + prompt + schema)` → stores the response. Reduces prompt iteration cost from O(docs × iterations) to O(docs) for the first run, then O(1) for subsequent runs. Enabled via `MULDER_LLM_CACHE=true`. See [Section 4.8](#48-vertex-ai-wrapper--dev-cache) for details.

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

#### Transaction Discipline (CRITICAL)

The `dequeueJob()` query MUST run as an **auto-commit** statement — NOT inside a `BEGIN ... COMMIT` block that wraps the entire job execution. This is the single most important implementation constraint for the worker.

**Why:** If the agent wraps `dequeue → execute pipeline step → mark completed` in one transaction, that transaction stays open for the duration of the pipeline step (minutes). Long-lived PostgreSQL transactions:
- Block `autovacuum` from cleaning up dead tuples in the `jobs` table
- Cause table bloat — the `jobs` table grows unboundedly as dead rows accumulate
- Eventually trigger "Transaction ID Wraparound" — PostgreSQL freezes to prevent data corruption

**Correct pattern:**
```
1. dequeueJob()          → auto-commit UPDATE (row locked, then immediately released)
2. execute pipeline step → NO active DB transaction (LLM calls, file I/O happen here)
3. markJobCompleted()    → auto-commit UPDATE (millisecond write)
```

Each of the three database touches is an independent, millisecond-duration auto-commit. The long-running pipeline work in step 2 happens with zero open database transactions.

**The agent MUST NOT:**
- Wrap the worker loop body in `pool.query('BEGIN')` ... `pool.query('COMMIT')`
- Use a transaction-wrapping ORM method around the job execution
- Hold a database connection checked out from the pool during LLM calls

### 10.4 Worker Loop

```typescript
// Pseudocode for mulder worker start
async function startWorker(options: WorkerOptions) {
  const workerId = `worker-${hostname()}-${process.pid}`
  logger.info({ workerId }, 'Worker started')

  while (!shuttingDown) {
    // Step 1: Dequeue (auto-commit, milliseconds)
    const job = await dequeueJob(workerId)

    if (!job) {
      await sleep(options.pollInterval)  // default: 5s
      continue
    }

    // Step 2: Execute (NO open DB transaction during this phase)
    try {
      logger.info({ jobId: job.id, type: job.type }, 'Processing job')

      switch (job.type) {
        case 'extract':
          await extract(job.payload.source_id)
          break
        case 'segment':
          await segment(job.payload.source_id)
          break
        case 'enrich':
          await enrich(job.payload.story_id)
          break
        // ... other step types
      }

      // Step 3a: Mark completed + enqueue next step (auto-commit, milliseconds)
      await markJobCompleted(job.id)
      await enqueueNextStep(job)  // chains to next pipeline step if applicable

    } catch (error) {
      // Step 3b: Mark failed (auto-commit, milliseconds)
      await markJobFailed(job.id, error.message)
    }
  }
}
```

### 10.5 Stuck Job Recovery (Reaper) + Dead Letter Queue

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

**Dead Letter Queue (DLQ):** Jobs that exhaust `max_attempts` retries are moved to `status = 'dead_letter'` instead of staying permanently as `failed`. This is a native PostgreSQL DLQ — no Pub/Sub, no additional infrastructure, consistent with the "PostgreSQL for everything" philosophy.

```sql
-- Worker marks job as dead_letter when max_attempts exhausted
UPDATE jobs SET status = 'dead_letter' WHERE id = $1;
```

```bash
mulder status --failed           # Show all documents with failed/dead_letter steps
mulder retry --document {id}     # Reset dead_letter jobs back to pending for a document
mulder retry --step enrich       # Reset dead_letter enrich jobs for all documents
```

The `retry` command simply resets `dead_letter` jobs to `pending` with `attempts = 0`, allowing the worker to pick them up again.

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

A single `fixtures/` directory at the repo root serves **both** local dev mode (see [Section 9](#9-local-development-mode)) and unit tests. Tests and dev mode use the exact same artifact pool — no duplication.

```
fixtures/
├── raw/                                  # Test PDFs (public domain or self-created)
│   ├── simple-layout.pdf
│   ├── complex-magazine.pdf
│   └── mixed-language.pdf
├── extracted/                            # Real Document AI Layout Parser outputs
│   ├── simple-layout/
│   │   └── layout.json
│   └── complex-magazine/
│       ├── layout.json
│       └── pages/
│           ├── page-001.png
│           └── page-002.png
├── segments/                             # Real Gemini segmentation outputs
│   └── complex-magazine/
│       ├── seg-001.md
│       ├── seg-001.meta.json
│       ├── seg-002.md
│       └── seg-002.meta.json
├── entities/                             # Real Gemini entity extraction outputs
│   └── seg-001.entities.json
├── embeddings/                           # Real embedding outputs
│   └── seg-001.embeddings.json
├── grounding/                            # Real Gemini Search Grounding outputs
│   └── loc-munich.grounding.json
└── README.md                             # API versions, field descriptions
```

### 11.3 Usage Rules

1. **Pipeline step tests MUST load fixtures from `fixtures/`** — never invent response structures
2. Fixtures are committed to the repo and version-controlled
3. The README documents which API version produced each fixture
4. When an API response format changes, update the fixture AND the test
5. The `zod-to-json-schema` conversion in Enrich step must be validated against the Gemini fixture — if the generated schema doesn't match what Gemini actually accepts, the test fails
6. `mulder fixtures generate` regenerates all fixtures from a real GCP run against test PDFs

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
| A7 | Core schema migrations (001-008) | Extensions, tables: sources, source_steps, stories, entities, edges, chunks, taxonomy | A6 |
| A8 | Job queue + pipeline tracking migrations (012-014) | Tables: jobs, pipeline_runs, reset_pipeline_step() function | A6 |
| A9 | Test fixtures | `fixtures/` with real API response samples (shared by tests + dev mode) | — |
| A10 | Service abstraction layer | `services.ts`, `registry.ts`, `rate-limiter.ts`, `retry.ts` | A1 |
| A11 | Docker Compose setup | `docker-compose.yaml` (pgvector + Firestore emulator) | — |

**Testable at this point:** `mulder config validate`, `mulder db migrate`, `mulder db status`, dev-mode service registry

### Phase B: Ingest + Extract (first GCP integration)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| B1 | GCP service implementations | `services.gcp.ts`, `services.dev.ts` | A10 |
| B2 | Source repository | CRUD for `sources` table | A7 |
| B3 | Native text detection | `pdf-parse` integration, `has_native_text` flag | A1 |
| B4 | Ingest step | `mulder ingest <path>` | B1, B2, B3 |
| B5 | Vertex AI wrapper + dev cache | `generateStructured()`, `generateText()`, `.mulder-cache.db` | B1 |
| B6 | Prompt template engine | `renderPrompt()` | A1 |
| B7 | Extract step (output to GCS) | `mulder extract <source-id>` → GCS layout.json + page images | B1, B2, B5, B3 |
| B8 | Fixture generator | `mulder fixtures generate` | B1-B7 |

**Testable at this point:** Ingest PDFs (native text detected), extract to GCS (Document AI skipped for text PDFs), inspect quality. Generate fixtures for dev mode.

### Phase C: Segment + Enrich (core intelligence)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| C1 | Story repository | CRUD for `stories` table (GCS URIs, no inline text) | A7 |
| C2 | Segment step (output to GCS) | `mulder segment <source-id>` → GCS Markdown + metadata | B5, B6, C1 |
| C3 | Entity repository | CRUD for `entities`, `entity_aliases`, `story_entities` | A7 |
| C4 | Edge repository | CRUD for `entity_edges` | A7 |
| C5 | JSON Schema generator (via `zod-to-json-schema`) | Dynamic schema for Gemini structured output | A2 |
| C6 | Taxonomy normalization | `normalize()` function | A7 |
| C7 | Cross-lingual entity resolution (3-tier) | `resolve()` with attribute match, embedding similarity, LLM-assisted | C3, B5 |
| C8 | Enrich step | `mulder enrich <story-id>` | B5, B6, C1-C7 |
| C9 | Cascading reset function | `reset_pipeline_step()` PL/pgSQL | A7 |

**Testable at this point:** Full extraction pipeline up to entities. `--force` re-runs clean up orphans. Cross-lingual entity merging works. Inspect entities, relationships, taxonomy.

### Phase D: Embed + Graph + Pipeline (searchable)

| # | What | Produces | Depends on |
|---|------|----------|------------|
| D1 | Embedding wrapper | `embed()` function | B1 |
| D2 | Semantic chunker | `chunk()` function | — |
| D3 | Chunk repository | CRUD for `chunks` table | A7 |
| D4 | Embed step | `mulder embed <story-id>` | D1-D3, B5, B6 |
| D5 | Graph step (dedup + edges + corroboration + contradiction flagging) | `mulder graph <story-id>` | C4 |
| D6 | Pipeline orchestrator (cursor-based) | `mulder pipeline run <path>` | B4, B7, C2, C8, D4, D5 |
| D7 | Full-text search | Generated `fts_vector` column on `chunks` table (auto-populated) | D3 |

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

### Phase I: Operational Infrastructure

| # | What | Produces | Depends on |
|---|------|----------|------------|
| I1 | Evaluation framework + golden test set | `eval/`, `mulder eval` | B7, C2, C8 |
| I2 | Cost estimator | `mulder ingest --cost-estimate`, `mulder reprocess --cost-estimate` | B4, D6 |
| I3 | Terraform budget alerts | `terraform/modules/budget/` | — |
| I4 | Schema evolution / reprocessing | `mulder reprocess`, config_hash tracking | D6 |
| I5 | Dead Letter Queue | `dead_letter` job status + `mulder retry` CLI | H2 |
| I6 | Devlog system | `devlog/` directory + conventions | — |

**Testable at this point:** Full operational safety net — eval against golden set, cost gates before expensive operations, selective reprocessing after config changes, DLQ recovery for failed jobs.

---

## 13. Source Layout

```
mulder/
├── package.json                    # Root: pnpm workspace
├── turbo.json                      # Turborepo config
├── tsconfig.base.json              # Shared TS config
├── mulder.config.yaml              # User's domain config
├── mulder.config.example.yaml      # Template
├── docker-compose.yaml             # Local dev: pgvector + Firestore emulator
├── .mulder-cache.db                # Dev-mode LLM cache (gitignored)
│
├── fixtures/                       # Real GCP artifacts — shared by dev mode + tests (checked in)
│   ├── raw/                        # Test PDFs
│   ├── extracted/                  # Real Document AI Layout Parser outputs
│   ├── segments/                   # Real Gemini segmentation outputs (Markdown + metadata)
│   ├── entities/                   # Real Gemini entity extraction outputs
│   ├── embeddings/                 # Real text-embedding-004 outputs
│   └── grounding/                  # Real Gemini Search Grounding outputs
│
├── eval/                           # Quality framework
│   ├── golden/                     # Ground-truth annotations
│   ├── metrics/                    # Eval results (baseline checked in)
│   └── run-eval.ts                 # Eval script
│
├── devlog/                         # Public build log, auto-deployed
│
├── packages/
│   ├── core/                       # Shared library
│   │   ├── package.json
│   │   └── src/
│   │       ├── config/             # Config loader + schemas
│   │       ├── database/           # Client, migrations, repositories
│   │       ├── shared/             # GCP factory, errors, logger, types
│   │       │   ├── services.ts     # Service interfaces
│   │       │   ├── services.dev.ts # Fixture-based implementations
│   │       │   ├── services.gcp.ts # Real GCP implementations
│   │       │   ├── registry.ts     # Service registry (dev vs GCP)
│   │       │   ├── rate-limiter.ts # Central token-bucket rate limiter
│   │       │   ├── retry.ts        # Retry with exponential backoff
│   │       │   └── cost-estimator.ts # Pipeline cost estimation
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
│   │       ├── commands/           # Command handlers (incl. worker.ts, fixtures.ts,
│   │       │                       #   eval.ts, retry.ts, reprocess.ts)
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
│       ├── budget/                 # GCP billing budget alerts
│       ├── iam/
│       └── networking/
│
├── docs/
│   ├── specs/                      # Spec-driven development
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

- `text-embedding-004` uses Matryoshka Representation Learning — requesting 768 dims via `outputDimensionality` API parameter preserves most of the semantic quality
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

### Why auto-commit job dequeue instead of wrapping in a transaction?

- A pipeline step (Extract, Enrich) can run for minutes. An open PostgreSQL transaction during that time blocks `autovacuum` on the `jobs` table.
- Blocked autovacuum causes table bloat — dead rows accumulate, query performance degrades
- In the worst case, long-lived transactions trigger "Transaction ID Wraparound" — PostgreSQL freezes entirely to prevent data corruption
- Auto-commit dequeue: the row lock is held for microseconds (just the UPDATE), then immediately released. The pipeline work happens with zero open transactions.
- This is the #1 implementation constraint for the worker — the agent must not wrap job execution in `BEGIN ... COMMIT`

### Why a process-level Vertex AI concurrency limiter?

- Multiple concurrent jobs in the same worker all fire Vertex AI requests simultaneously
- Google's per-project quotas (requests/minute) are quickly exhausted → mass 429 errors
- Exponential backoff with jitter doesn't solve this — all retries wake up in the same window (thundering herd)
- A `p-limit(2)` limiter queues excess requests in Node.js memory (zero network cost) and releases them one at a time
- This is proactive throttling vs reactive error handling — prevents 429s instead of recovering from them
- Per-process, not per-cluster: 3 workers × 2 concurrent = 6 total Vertex AI requests, well within most quotas

### Why content in GCS instead of PostgreSQL?

- Full story Markdown can span multiple pages — storing it in `TEXT` columns bloats the database and slows backups
- The Extract step produces Document AI Structured JSON with spatial data (bounding boxes) that's only needed by the Segment step — not worth indexing in SQL
- Page images for Gemini are binary blobs that belong in object storage, not a relational database
- `chunks.content` stays inline (~512 tokens) because it's queried directly by vector search + BM25 in the same SQL query — a GCS round-trip per chunk would kill retrieval latency
- GCS is immutable-friendly: `raw/` is never modified, `extracted/` is append-only, `segments/` is per-document — clean lifecycle management

### Why cross-lingual entity resolution by default?

- Multilingual corpora are the norm, not the exception. German UFO magazines cite English sources, reference Italian locations, and name Russian scientists
- Without cross-lingual resolution, "München", "Munich", and "Monaco di Baviera" are three separate entities — corroboration scores, cluster analysis, and cross-referencing are all broken
- `text-embedding-004` already maps 100+ languages into the same semantic space — the embedding-similarity tier is essentially free
- `supported_locales` controls UI and prompt language only — entity resolution works across all languages automatically

### Why deduplication before corroboration?

- Magazine content is frequently reprinted across issues. Without dedup, a reprinted article counts as multiple independent sources, inflating corroboration scores
- MinHash/SimHash on chunk embeddings is fast and deterministic — no LLM cost
- Duplicates are marked (`DUPLICATE_OF` edge) but never deleted — the original text is preserved for audit
- The semantic distinction between "same text reprinted" (one source) and "different authors independently reporting" (real corroboration) is the difference between meaningful and meaningless evidence scores

---

## 15. Evaluation & Quality Framework

Without evaluation, the pipeline is a black box. Changes to prompts, config, or model versions can silently degrade quality.

### 15.1 Golden Test Set

```
eval/
├── golden/
│   ├── page-simple-de.json        # Ground truth for simple German page
│   ├── page-complex-magazine.json # Ground truth for complex magazine layout
│   ├── page-mixed-language.json   # Ground truth for DE+EN mixed
│   ├── segments-magazine.json     # Expected segment boundaries for test magazine
│   └── entities-article.json      # Expected entities for test article
├── metrics/                       # Eval results (gitignored, baseline checked in)
│   └── baseline.json              # Result of initial eval run
└── run-eval.ts                    # Eval script
```

5-10 manually annotated pages covering different difficulty levels: simple layout, multi-column, text-over-image, mixed languages.

### 15.2 Metrics Per Step

| Step | Metrics |
|------|---------|
| Extract | Character Error Rate (CER), Word Error Rate (WER) against ground truth |
| Segment | Boundary Accuracy (start/end pages correct?), Segment Count Accuracy |
| Enrich | Entity Extraction Precision, Recall, F1 per entity type |
| Ground | Enrichment Coverage (% entities with grounding result), Coordinate Accuracy |
| Embed | Retrieval Accuracy (relevant chunks in top-K for test queries?) |
| Graph | Relationship Accuracy, Cross-Lingual Merge Precision |

### 15.3 CLI

```bash
npx mulder eval                    # Full eval run against golden set
npx mulder eval --step extract     # Evaluate extraction only
npx mulder eval --compare baseline # Compare against saved baseline
npx mulder eval --update-baseline  # Save current results as new baseline
```

Output is structured JSON + human-readable summary:
```
Extraction Quality:
  CER:  3.2% (baseline: 3.5%) ✓ improved
  WER:  8.1% (baseline: 7.9%) ⚠ slightly worse

Segmentation Quality:
  Boundary Accuracy: 91% (baseline: 89%) ✓ improved
  Segment Count:     exact in 8/10 documents

Entity Extraction:
  Location Precision: 94%  Recall: 87%  F1: 90.4%
  Person Precision:   88%  Recall: 72%  F1: 79.2%
```

**The golden test set must exist before the first batch run** — not as an afterthought. Initial 5-10 pages are created manually, coverage grows incrementally.

---

## 16. Cost Safety

### 16.1 Budget Alerts

Terraform module for GCP billing budget alerts:

```hcl
# terraform/modules/budget/main.tf
resource "google_billing_budget" "mulder" {
  billing_account = var.billing_account
  display_name    = "mulder-${var.project_name}"
  amount {
    specified_amount {
      currency_code = "USD"
      units         = var.monthly_budget_usd
    }
  }
  threshold_rules {
    threshold_percent = 0.5   # Alert at 50%
  }
  threshold_rules {
    threshold_percent = 0.9   # Alert at 90%
  }
}
```

### 16.2 Cost Estimation

Before expensive operations, the CLI shows an estimate and asks for confirmation:

```bash
npx mulder ingest ./pdfs/ --cost-estimate
# ┌─────────────────────────────────────────────┐
# │ Cost Estimate for 217 documents (est. 21,700 pages)
# ├─────────────────────────────────────────────┤
# │ Extract (Document AI):    ~$32.55
# │ Segment (Gemini Flash):   ~$12.00
# │ Enrich  (Gemini Flash):   ~$4.50
# │ Ground  (Search Grounding): ~$3.00
# │ Embed   (Embeddings):     ~$2.10
# │ ─────────────────────────────────────────────
# │ Total estimated:          ~$54.15
# └─────────────────────────────────────────────┘
# Proceed? [y/N]
```

### 16.3 Hard Limits

```yaml
safety:
  max_pages_without_confirm: 500     # Over 500 pages: CLI asks for confirmation
  max_cost_without_confirm_usd: 20   # Over $20 estimated: CLI asks for confirmation
  budget_alert_monthly_usd: 100      # GCP budget alert threshold
  block_production_calls_in_test: true # NODE_ENV=test: GCP calls blocked, fixture mode forced
```

**Test safety:** When `NODE_ENV=test`, real GCP calls are not just bypassed but actively blocked. The service registry throws an error if a real GCP client is instantiated in test mode. This prevents CI/CD from accidentally generating costs.

---

## 17. Devlog System

The `devlog/` directory contains short, structured entries about significant project progress. Auto-deployed to a website as a public build log.

**File format:** `devlog/{YYYY-MM-DD}-{slug}.md`

```markdown
---
date: 2026-03-28
type: architecture
title: "Short, concrete title"
tags: [relevant, technical, tags]
---

2-5 sentences. What was done or decided, and the result.
No filler, no "today I", no introduction. Direct to the point.
Technical enough for a developer, short enough for 15 seconds.
```

**Type values:** `architecture` | `implementation` | `breakthrough` | `decision` | `refactor` | `integration` | `milestone`

**When to log:** New capability works, architecture decision made/revised, non-obvious problem solved, GCP service first integrated, significant refactor, milestone reached.

**When NOT to log:** Routine refactoring, bug fixes, dependency updates, formatting, repeated iterations on the same feature.

---

## 18. Phase 2 Outlook

Design reservations for Phase 2 features. The data models and GCS structure already accommodate these — no schema migration needed when they activate.

### 18.1 Visual Intelligence (Phase 2)

Currently the pipeline extracts text and discards all visual information. In magazines, photos, sketches, diagrams, and maps are data in themselves.

**Planned:**
- Document AI identifies image regions on pages during the Segment step
- Images are extracted and stored in GCS (`segments/{doc-id}/{segment-id}/images/`)
- Gemini analyzes each image: description, recognizable entities, structured data extraction from maps/diagrams
- Image descriptions feed into the entity graph as an additional source
- Captions (from text extraction) are linked to their images
- Images get their own embeddings (Gemini multimodal) for visual similarity search

**Config (reserved but disabled):**
```yaml
visual_intelligence:
  enabled: false  # Phase 2
  extract_images: true
  analyze_images: true
  image_embedding: true
  extract_from_maps: true
  extract_from_diagrams: true
```

**Design impact now:** GCS segment structure includes `images/` directory. Graph schema reserves an `Image` node type. The `image_count` field is available in segment metadata.

### 18.2 Proactive Pattern Discovery (Phase 2)

Currently the system is purely reactive — someone asks, it answers. A research graph should proactively surface interesting patterns.

**Planned:**
- Runs as a sub-step of Analyze after each batch
- **Cluster anomalies:** New locations/entities that suddenly appear in clusters
- **Temporal spikes:** Unusual frequency of certain phenomena in time windows
- **Disconnected subgraphs:** Similar but unconnected entity clusters that might be related
- **High-impact pending:** Entities with high corroboration potential not yet enriched/verified
- Results stored as `insights` in Firestore, surfaced via API endpoint and optionally as periodic digest

**Config (reserved but disabled):**
```yaml
pattern_discovery:
  enabled: false  # Phase 2
  run_after_batch: true
  anomaly_detection: true
  temporal_spikes: true
  subgraph_similarity: true
  digest:
    enabled: false
    frequency: "weekly"
```

**Design impact now:** Firestore reserves an `insights` collection. API reserves a placeholder `routes/insights.ts`. The Analyze step is designed to be extensible.
