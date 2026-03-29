# Mulder

Config-driven Document Intelligence Platform on GCP. Transforms document collections (PDFs with complex layouts) into a searchable knowledge base with Knowledge Graph. One `mulder.config.yaml` defines the domain ontology, `terraform apply` deploys everything.

**This is a public open-source repository (Apache 2.0).** Never commit API keys, GCP credentials, service account JSON, `.env` files, or any secrets. All sensitive config goes through environment variables or GCP IAM — never in code or config files checked into git. The `.gitignore` blocks `.env*`, `terraform.tfstate*`, and `.mulder-cache.db`. If you spot a leaked secret, rotate it immediately.

## Implementation Workflow

The functional spec (`docs/functional-spec.md`) is 2500+ lines. **Never read it fully.** Use the roadmap as an index instead.

**For every implementation step:**
1. Read this file (CLAUDE.md) — loaded automatically, gives architecture + conventions + patterns
2. Read `docs/roadmap.md` — find the current step, check its **Spec** column for section references
3. Read **only the referenced sections** of `docs/functional-spec.md` (e.g., `§4.1` = Section 4.1)
4. Also read the milestone's **"Also read"** cross-references (shared context for all steps in that milestone)
5. Implement the step
6. **Update status** in `docs/roadmap.md` — `⚪` → `🟡` when starting, `🟡` → `🟢` when done

The roadmap is the source of truth for what's been built. Always check it before starting work to avoid duplicating effort.

## Architecture Decisions

- **TypeScript** throughout (pipeline, API, CLI, config loader) — ESM, strict mode
- **Monorepo**: pnpm + Turborepo
- **Infra**: Terraform, modular (`terraform/modules/`)
- **OCR**: Document AI Layout Parser → Structured JSON with spatial data. Gemini Vision fallback for low-confidence pages (circuit breaker at `max_vision_pages`)
- **LLM**: Gemini 2.5 Flash via Vertex AI — structured output for extraction. Only LLM provider (native PDF support + structured output)
- **Embeddings**: `text-embedding-004` — multilingual (100+ languages), 768-dim via Matryoshka `outputDimensionality` API parameter. NEVER truncate vectors manually.
- **Database**: Cloud SQL PostgreSQL — single instance for ALL data paradigms:
  - Vector Search: `pgvector` extension (HNSW index, not ivfflat)
  - Full-Text Search: generated `tsvector` column on `chunks` table (BM25 on same table as vectors)
  - Geospatial: `PostGIS` extension (`ST_Distance`, proximity queries)
  - Graph Traversal: `WITH RECURSIVE` CTEs on relational tables (`entities`, `entity_edges`) — no graph DB
  - Job Queue: `FOR UPDATE SKIP LOCKED` on `jobs` table — no Pub/Sub, no Redis
- **Storage Architecture**: Content in GCS, references/index in PostgreSQL. No long text in database columns.
- **State Tracking**: PostgreSQL is authoritative (`sources.status`, `stories.status`, `source_steps`, `pipeline_runs`). Firestore is a write-only observability projection for UI — workers never read from it.
- **Service Abstraction**: 3-layer hierarchy — `gcp.ts` (connection manager), `services.gcp.ts` (implementation), `registry.ts` (DI). Pipeline steps call interfaces, never GCP clients directly.
- **API**: Cloud Run Service — job producer for long-running ops, synchronous for queries
- **Config**: YAML + Zod validation (`mulder.config.yaml`)
- **Prompts**: Jinja2-style templates with i18n injection
- **i18n**: i18next for UI, custom system for LLM prompts, DE + EN initial
- **CLI**: Commander.js or oclif
- **License**: Apache 2.0

## Infrastructure

Mulder runs on a minimal GCP footprint. All capabilities are feature-flagged in `mulder.config.yaml` — enable what you need, disable what you don't. No tiers, no paywalls.

**Core (always deployed):**
- Cloud SQL PostgreSQL (pgvector + tsvector + PostGIS) — single instance for all data + job queue
- Cloud Storage — document storage + pipeline artifacts (extracted JSON, page images, story Markdown)
- Cloud Run — API + pipeline workers
- Firestore — observability projection (UI monitoring only, not source of truth)

**Optional (enable via config):**
- BigQuery — analytics and reporting
- Vertex AI Search — managed retrieval alternative

Baseline cost: ~30-40 EUR/mo for a small Cloud SQL instance. Scales with instance size and Gemini API usage.

## The 12 Capabilities

### Core (v1.0 + v2.0)

1. **Complex Layout Extraction** — Document AI Layout Parser + Gemini Vision fallback. Output: Document AI Structured JSON with spatial data to GCS, NOT Markdown.
2. **Config-Driven Domain Ontology** — One YAML defines entities, relationships, extraction rules. Gemini structured output with dynamically generated JSON Schema from config (via `zod-to-json-schema`).
3. **Domain Taxonomy with Auto-Normalization** — Bootstrap taxonomy after ~25 docs via Gemini, incremental growth per document, human-in-the-loop curation (`taxonomy.curated.yaml`). Every entity gets a `canonical_id` at extraction time. Taxonomy entries are language-agnostic — ID + variants in any number of languages.
4. **Hybrid Retrieval with LLM Re-Ranking** — Vector search (pgvector) + BM25 full-text (tsvector on chunks table) + graph traversal (recursive CTEs), fused via Reciprocal Rank Fusion (RRF), then Gemini Flash re-ranks for final relevance.
5. **Web Grounding / Enrichment** — Gemini `google_search_retrieval` via Vertex AI. Three modes: `pipeline`, `on_demand`, `disabled`. Results cached with configurable TTL.
6. **Spatio-Temporal Analysis** — PostGIS for proximity queries, temporal clustering, pattern detection.
7. **Evidence Scoring & Contradiction Detection** — Two-phase: Graph step flags potential contradictions (attribute diff, no LLM), Analyze step resolves via Gemini. Dedup-aware corroboration scores.
8. **Cross-Lingual Entity Resolution** — 3-tier strategy: attribute match (deterministic), embedding similarity (statistical, `text-embedding-004`), LLM-assisted (semantic, Gemini). Works across all languages, not just `supported_locales`.
9. **Deduplification / Near-Duplicate Detection** — MinHash/SimHash on chunk embeddings. `DUPLICATE_OF` edges. Near-dupes excluded from corroboration scoring.
10. **Schema Evolution / Reprocessing** — `source_steps` table tracks `config_hash` per document per step. `mulder reprocess` detects what needs re-running after config changes.

### Phase 2 (designed for, not yet implemented)

11. **Visual Intelligence** — Image extraction, Gemini analysis, image embeddings, map/diagram parsing
12. **Proactive Pattern Discovery** — Cluster anomalies, temporal spikes, subgraph similarity, Insights API

## Pipeline Stages

### Full Pipeline — 8 steps

```
ingest → extract → segment → enrich → [ground] → embed → graph → [analyze]
```

1. **Ingest** — PDF → Cloud Storage, pre-flight validation (size, page count, PDF bombs)
2. **Extract** — Document AI Layout Parser → Structured JSON + page images → **GCS** (`extracted/`). NOT Markdown. Spatial data preserved for segmentation.
3. **Segment** — Gemini receives page images + layout JSON → identifies stories → Markdown + metadata JSON per segment → **GCS** (`segments/`). Markdown is the *end format* per story.
4. **Enrich** — Entity extraction from ontology config, taxonomy normalization, cross-lingual entity resolution (3-tier). Loads story Markdown from GCS.
5. **Ground** (v2.0) — Web enrichment via Gemini `google_search_retrieval`
6. **Embed** — `text-embedding-004` (768-dim), semantic chunking, question generation. Chunks stored inline in PostgreSQL (short, ~512 tokens).
7. **Graph** — Deduplication (MinHash/SimHash) → entity edges → dedup-aware corroboration scoring → contradiction flagging (attribute diff, no LLM)
8. **Analyze** (v2.0) — Contradiction resolution (Gemini), source reliability (PageRank), evidence chains, spatio-temporal clustering

## Storage Architecture

**Content in GCS, References/Index in Cloud SQL.**

```
gs://mulder-{project}/
├── raw/                    # Original PDFs (immutable)
├── extracted/              # Document AI Structured JSON + page images
│   └── {doc-id}/layout.json, pages/*.png
├── segments/               # Per story: Markdown + metadata JSON
│   └── {doc-id}/{segment-id}.md, {segment-id}.meta.json
└── taxonomy/               # Auto-generated + curated taxonomy
```

- `chunks.content` inline (~512 tokens) — needed for vector + BM25 in one query
- Full story Markdown in GCS — loaded on demand for RAG context
- No long text in PostgreSQL columns

## Service Abstraction

```
gcp.ts          → Connection Manager (raw SDK singletons, connection pools)
services.gcp.ts → Implementation Layer (uses gcp.ts, implements interfaces)
services.dev.ts → Dev Implementation (reads from fixtures/)
registry.ts     → Dependency Injector (selects dev or GCP based on mode)
```

Pipeline steps call service interfaces → registry selects implementation → GCP implementations use `gcp.ts` for raw clients. **Pipeline steps NEVER import `gcp.ts` directly.**

## Code Conventions

- TypeScript strict mode, ESM only
- Zod for all runtime validation
- Custom Error classes with error codes, no generic `throw new Error()`
- Structured JSON logging via pino
- No `any`, no `as` type assertions except for external API responses
- All GCP access via service interfaces (`src/shared/services.ts`), never direct SDK calls
- Config always via the loader, never parse YAML directly
- Prompts always from templates, never inline strings
- All external API calls use centralized `RateLimiter` + `withRetry` — steps never implement their own backoff

## Git Conventions

- **Atomic commits** — one logical change per commit
- **Semantic commit messages**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `ci:`
- Examples: `feat: add entity extraction pipeline step`, `fix: handle corrupt PDF in ingest`, `chore: update dependencies`
- Always include `Co-Authored-By` trailer when Claude contributes

## Naming Conventions

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/Variables: `camelCase`
- Terraform resources: `snake_case`
- Config keys: `snake_case`

## Repo Structure

```
mulder/
├── package.json                  # Root: pnpm workspace
├── turbo.json                    # Turborepo config
├── docker-compose.yaml           # Local dev: pgvector + Firestore emulator
├── mulder.config.yaml            # User's domain config
├── mulder.config.example.yaml    # Template
├── .mulder-cache.db              # Dev-mode LLM cache (gitignored)
│
├── fixtures/                     # Real GCP artifacts — shared by dev mode + tests
│   ├── raw/                      # Test PDFs
│   ├── extracted/                # Real Document AI outputs
│   ├── segments/                 # Real Gemini segmentation outputs
│   ├── entities/                 # Real entity extraction outputs
│   ├── embeddings/               # Real text-embedding-004 outputs
│   └── grounding/                # Real Search Grounding outputs
│
├── eval/                         # Quality framework
│   ├── golden/                   # Ground-truth annotations
│   └── metrics/                  # Eval results (baseline checked in)
│
├── devlog/                       # Public build log
│
├── packages/
│   ├── core/                     # Shared library
│   │   └── src/
│   │       ├── config/           # Config loader + Zod schemas
│   │       ├── database/         # Client, migrations, repositories
│   │       ├── shared/           # Service interfaces, registry, gcp.ts, errors, logger
│   │       │   ├── services.ts, services.dev.ts, services.gcp.ts
│   │       │   ├── registry.ts, gcp.ts, rate-limiter.ts, retry.ts
│   │       │   └── cost-estimator.ts, errors.ts, logger.ts, types.ts
│   │       ├── prompts/          # Template engine + templates
│   │       ├── vertex.ts         # Vertex AI wrapper (uses shared retry + rate limiter)
│   │       └── llm-cache.ts      # Dev-mode LLM response cache
│   ├── pipeline/                 # Pipeline steps
│   │   └── src/{ingest,extract,segment,enrich,ground,embed,graph,analyze}
│   ├── retrieval/                # Hybrid search: vector, fulltext, graph, fusion, reranker
│   ├── taxonomy/                 # Bootstrap, normalize, merge
│   ├── worker/                   # Job queue consumer (FOR UPDATE SKIP LOCKED)
│   └── evidence/                 # v2.0: Contradictions, reliability, chains, spatiotemporal
│
├── apps/
│   ├── cli/                      # CLI application (commands/ + lib/)
│   └── api/                      # HTTP API (routes/ + middleware/)
│
├── terraform/modules/            # GCP infrastructure
│   └── {cloud-sql,storage,cloud-run,pubsub,firestore,budget,iam,networking}
│
├── docs/
│   ├── functional-spec.md        # Comprehensive functional specification
│   └── improvements/             # Architecture delta documents
│
└── demo/                         # Demo UI
```

## Key Patterns

- Pipeline steps are **idempotent** and can be re-run individually. Database upserts (`ON CONFLICT DO UPDATE`) are mandatory.
- Every pipeline step reads config via the central loader
- Entity extraction uses Gemini structured output with **dynamically generated JSON Schema from config** (via `zod-to-json-schema` — mandatory, never hand-roll)
- Terraform reads `mulder.config.yaml` directly via `yamldecode()`
- **PostgreSQL All-in-One**: Single Cloud SQL instance handles vector search, full-text search, geospatial queries, graph traversal (recursive CTEs), AND the job queue (`FOR UPDATE SKIP LOCKED`). No Pub/Sub, no Redis.
- **Content in GCS, Index in PostgreSQL**: Extraction output is Document AI Structured JSON (spatial), NOT Markdown. Markdown is the end format per story after segmentation. Story Markdown lives in GCS, chunks (~512 tokens) are inline in PostgreSQL.
- **FTS on chunks table**: Generated `tsvector` column on `chunks.content` — both vector search and BM25 query the same table. No separate `story_fts` table.
- Taxonomy normalization happens IN the extraction pipeline (Enrich step), not as post-processing
- **Cross-lingual entity resolution**: 3-tier (attribute match → embedding similarity → LLM-assisted). `supported_locales` controls UI/prompts only, not resolution.
- **Deduplication before corroboration**: MinHash/SimHash on chunk embeddings creates `DUPLICATE_OF` edges. Near-dupes are marked but not deleted, excluded from corroboration counting.
- **Schema evolution**: `source_steps` table tracks `config_hash` per document per step. `mulder reprocess` compares hashes to determine minimal re-run set.
- **Two-phase contradiction detection**: Graph step flags `POTENTIAL_CONTRADICTION` edges via attribute diff (fast, no LLM). Analyze step resolves via Gemini → `CONFIRMED` or `DISMISSED`.
- **`--force` vs `reprocess`**: `--force` is destructive manual override (cascading delete + re-run). `reprocess` is smart non-destructive reconciliation after config changes.
- **Sparse graph degradation**: Features have minimum data thresholds. Below threshold, features return `null`/`"insufficient_data"`, not misleading scores. API responses include `confidence` object.
- Hybrid Retrieval combines three strategies (vector + BM25 + graph) in one query path. RRF fusion in application code, then Gemini for re-ranking.
- Evidence scoring is its own pipeline step (Analyze), not part of query-time logic
- All GCP-native — no third-party services. LLM calls via Vertex AI SDK. Web Grounding via Gemini `google_search_retrieval`.
- All capabilities are feature-flagged via config. Sensible defaults so minimal config gets you started.
- Graph traversal depth limited by `max_hops` config (default: 2).
- Phase 2 features (Visual Intelligence, Pattern Discovery) are reserved in the data model (GCS structure, Firestore collections, graph node types) but not implemented.

## Local Development

- `dev_mode: true` in config or `NODE_ENV=development` → no GCP calls, fixture-based
- `fixtures/` contains real GCP artifacts for every pipeline step (shared by dev mode + tests)
- Service interfaces in `src/shared/services.ts`, dev implementation in `services.dev.ts`, GCP in `services.gcp.ts`
- Service registry in `src/shared/registry.ts` selects based on mode
- docker-compose: PostgreSQL (pgvector + PostGIS) + Firestore Emulator
- `npx mulder fixtures generate` creates fixtures from a real GCP run
- `NODE_ENV=test` actively **blocks** all real GCP calls (throws, not fallback)
- Dev-mode LLM cache (`.mulder-cache.db`) saves tokens during prompt iteration

## Error Handling

- Per-document, per-step status tracking in `source_steps` table (PostgreSQL, authoritative)
- States: pending | completed | failed | partial
- Partial results are preserved (95 of 100 pages OK → 95 pages in GCS)
- Dead Letter Queue: `dead_letter` status on `jobs` table (native PostgreSQL, no Pub/Sub)
- Retry: exponential backoff with jitter via shared `withRetry`, retryable (429, 503) vs fatal (400, 404)
- Retry logic in `src/shared/retry.ts`, not in pipeline steps
- Rate limiting in `src/shared/rate-limiter.ts` (token bucket per GCP service)
- CLI: `mulder status --failed`, `mulder retry --document {id}`

## Quality Evaluation

- Golden test set in `eval/golden/` — manually annotated ground truth
- Metrics: CER/WER (Extract), Boundary Accuracy (Segment), Precision/Recall/F1 (Enrich)
- `npx mulder eval` against golden set, `--compare baseline` for regression detection
- Baseline checked in at `eval/metrics/baseline.json`
- Must exist before first batch run — not an afterthought

## Cost Safety

- `safety.max_pages_without_confirm` — CLI confirmation for large batches
- `safety.max_cost_without_confirm_usd` — CLI confirmation for estimated cost
- `--cost-estimate` flag on `ingest` / `pipeline run` / `reprocess` commands
- Terraform budget alert module in `terraform/modules/budget/`
- `NODE_ENV=test` blocks real GCP calls (throw, not fallback)

## Devlog

- Directory: `devlog/`, files: `{YYYY-MM-DD}-{slug}.md`
- Frontmatter: `date`, `type`, `title`, `tags`
- Types: architecture | implementation | breakthrough | decision | refactor | integration | milestone
- Write entry when: new capability works, architecture decision made/revised, non-obvious problem solved, GCP service first integrated, significant refactor, milestone reached
- Skip when: routine refactoring, bug fixes, dependency updates, formatting, repeated iterations
- Style: English, direct, technical, max 5 sentences, no filler

## Testing

- Vitest
- Fixtures from `fixtures/` — never invent API response structures
- Focus areas: config validation, pipeline step isolation
- Each pipeline step testable in isolation with fixture inputs
- `zod-to-json-schema` conversion validated against Gemini fixtures

## Important Context

- Origin: UFO magazine analysis project, but designed fully **domain-agnostic**
- `mulder.config.yaml` is the central control — all domain-specific logic lives there
- No tiers, no paywalls — fully open source. Users enable/disable capabilities via config flags.
- Gemini is the only LLM provider (native PDF support + structured output) — also used for Web Grounding (`google_search_retrieval`)
- **No Spanner** — single Cloud SQL PostgreSQL instance for everything
- **No Pub/Sub for job queue** — PostgreSQL `FOR UPDATE SKIP LOCKED` is the job broker
- Comprehensive functional spec at `docs/functional-spec.md` — the authoritative reference for all implementation decisions
