# mulder

Config-driven Document Intelligence Platform on GCP. Transforms document collections (PDFs with complex layouts) into a searchable knowledge base with Knowledge Graph. One `mulder.config.yaml` defines the domain ontology, `terraform apply` deploys everything.

## Architecture Decisions

- **TypeScript** throughout (pipeline, API, CLI, config loader) — ESM, strict mode
- **Monorepo**: pnpm + Turborepo
- **Infra**: Terraform, modular (`terraform/modules/`)
- **OCR**: Document AI Layout Parser (Gemini-based), Gemini Vision fallback for complex layouts
- **LLM**: Gemini 2.5 Flash via Vertex AI — structured output for extraction. Only LLM provider (native PDF support + structured output)
- **Embeddings**: `gemini-embedding-001` — multilingual, 3072-dim Matryoshka
- **Database**: Cloud SQL PostgreSQL — single instance for ALL data paradigms:
  - Vector Search: `pgvector` extension
  - Full-Text Search: native `tsvector` / BM25
  - Geospatial: `PostGIS` extension (`ST_Distance`, proximity queries)
  - Graph Traversal: `WITH RECURSIVE` CTEs on relational tables (`entities`, `entity_edges`) — no graph DB
- **Metadata**: Firestore
- **Orchestration**: Cloud Workflows + Cloud Run Jobs
- **API**: Cloud Run Service
- **Config**: YAML + Zod validation (`mulder.config.yaml`)
- **Prompts**: Jinja2-style templates with i18n injection
- **i18n**: i18next for UI, custom system for LLM prompts, DE + EN initial
- **CLI**: Commander.js or oclif
- **License**: Apache 2.0

## Infrastructure

mulder runs on a minimal GCP footprint. All capabilities are feature-flagged in `mulder.config.yaml` — enable what you need, disable what you don't. No tiers, no paywalls.

**Core (always deployed):**
- Cloud SQL PostgreSQL (pgvector + tsvector + PostGIS) — single instance for all data
- Cloud Storage — document storage
- Cloud Run — API + pipeline workers
- Pub/Sub + Eventarc — pipeline orchestration
- Firestore — metadata

**Optional (enable via config):**
- BigQuery — analytics and reporting
- Vertex AI Search — managed retrieval alternative

Baseline cost: ~30-40 EUR/mo for a small Cloud SQL instance. Scales with instance size and Gemini API usage.

## The 7 Core Capabilities

### MVP (v1.0)

1. **Complex Layout Extraction** — Document AI Layout Parser + Gemini Vision fallback for magazines, newspapers, multi-column layouts
2. **Config-Driven Domain Ontology** — One YAML defines entities, relationships, extraction rules. Gemini structured output with dynamically generated JSON Schema from config.
3. **Domain Taxonomy with Auto-Normalization** — Bootstrap taxonomy after ~25 docs via Gemini, incremental growth per document, human-in-the-loop curation (`taxonomy.curated.yaml`). Every entity gets a `canonical_id` at extraction time. Re-bootstrap via `mulder taxonomy re-bootstrap` when the collection grows significantly.
4. **Hybrid Retrieval with LLM Re-Ranking** — Vector search (pgvector) + BM25 full-text (tsvector) + graph traversal (recursive CTEs), fused via Reciprocal Rank Fusion (RRF), then Gemini Flash re-ranks for final relevance.

### Full-Featured (v2.0)

5. **Web Grounding / Enrichment** — Gemini `google_search_retrieval` via Vertex AI verifies and enriches entities (locations → coordinates, persons → bio context, orgs → descriptions). Config controls which entity types get enriched. Three modes: `pipeline` (auto during ingestion), `on_demand` (via API/CLI per entity or batch), or `disabled`. Results cached with configurable TTL.
6. **Spatio-Temporal Analysis** — PostGIS for proximity queries, normalized timestamps on events (fuzzy dates → ranges), temporal clustering, pattern detection via graph algorithms filtered by time and space.
7. **Evidence Scoring & Contradiction Detection** — Two-phase contradiction detection: Graph step flags potential contradictions via attribute comparison (fast, no LLM), Analyze step resolves them via Gemini (semantic comparison, confirms or dismisses). Plus corroboration scores (independent source count via SQL), weighted PageRank for source reliability, evidence chains with aggregated strength scores.

## Pipeline Stages

1. **Ingest** — PDF → Cloud Storage → Eventarc → Pub/Sub
2. **Extract** — Document AI Layout Parser, Gemini fallback on low confidence
3. **Segment** — Gemini structured output: identify and isolate articles/stories
4. **Enrich** — Entity extraction from ontology config, normalization against taxonomy, entity resolution
5. **Ground** — Web enrichment via Gemini `google_search_retrieval` (locations, persons, orgs, events)
6. **Embed** — `gemini-embedding-001`, semantic chunking with question generation
7. **Graph** — Entities + relationships → PostgreSQL relational tables, corroboration scoring (SQL aggregation), flag potential contradictions via attribute diff (no LLM)
8. **Analyze** — Resolve pending contradictions via Gemini (confirm or dismiss), spatio-temporal clustering, source reliability scoring (weighted PageRank), evidence chain computation

## Code Conventions

- TypeScript strict mode, ESM only
- Zod for all runtime validation
- Custom Error classes with error codes, no generic `throw new Error()`
- Structured JSON logging via pino
- No `any`, no `as` type assertions except for external API responses
- All GCP clients via central factory (`src/shared/gcp.ts`)
- Config always via the loader, never parse YAML directly
- Prompts always from templates, never inline strings

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
├── terraform/modules/{storage,document-ai,cloud-sql,firestore,cloud-run,workflows,pubsub,networking,iam,secrets}
├── src/
│   ├── pipeline/{ingest,extract,segment,enrich,ground,embed,graph,analyze}
│   ├── taxonomy/        # Bootstrap, normalization, merging
│   ├── retrieval/       # Hybrid retrieval, RRF fusion, reranking
│   ├── evidence/        # Corroboration, contradiction, source scoring, evidence chains
│   ├── api/
│   │   ├── routes/      # Including evidence.ts
│   │   ├── services/    # Including fulltextStore.ts, reranker.ts, grounding.ts
│   │   └── middleware/
│   ├── config/          # Config loader + Zod schemas
│   ├── prompts/         # Jinja2-style templates
│   └── shared/          # GCP client factory, common types, errors
├── cli/commands/{init,deploy,ingest,status,query,export,taxonomy}
├── i18n/{de,en}
├── examples/{ufo-magazines,legal-correspondence,academic-papers}
├── docs/
├── mulder.config.yaml
└── mulder.config.example.yaml
```

## Key Patterns

- Pipeline steps are **idempotent** and can be re-run individually. Database upserts (`ON CONFLICT DO UPDATE`) are mandatory.
- Every pipeline step reads config via the central loader
- Entity extraction uses Gemini structured output with **dynamically generated JSON Schema from config**
- Terraform reads `mulder.config.yaml` directly via `yamldecode()`
- **PostgreSQL All-in-One**: Single Cloud SQL instance handles vector search, full-text search, geospatial queries, AND graph traversal (recursive CTEs). No separate graph database.
- Taxonomy normalization happens IN the extraction pipeline (Enrich step), not as post-processing
- Hybrid Retrieval combines three strategies (vector + BM25 + graph) in one query path, not as separate endpoints. RRF fusion in application memory (TypeScript), then Vertex AI Gemini for re-ranking.
- **Two-phase contradiction detection**: Graph step flags `POTENTIAL_CONTRADICTION` edges via simple attribute diff (fast, no LLM, in hot path). Analyze step resolves them via Gemini semantic comparison → `CONFIRMED` or `DISMISSED`. This ensures no silent gap where conflicting data sits untagged.
- Evidence scoring is its own pipeline step (Analyze), not part of query-time logic
- Pipeline workers run on Cloud Run, triggered by Pub/Sub messages
- All GCP-native — no third-party services. LLM calls via Vertex AI SDK. Web Grounding via Gemini `google_search_retrieval`.
- All capabilities are feature-flagged via config (`enabled: true/false`). Sensible defaults so minimal config gets you started — only configure what you deviate from.
- Graph traversal depth limited by `max_hops` config (default: 2). Recursive CTEs perform well at 2-3 hops; 4+ hops on large graphs (100K+ edges) will degrade — document this constraint.
- Web Grounding supports three modes: `pipeline` (auto during ingestion), `on_demand` (API/CLI), `disabled`. On-demand mode lets users enrich specific entities or batches without re-running the pipeline.

## Testing

- Vitest
- Focus areas: config validation, pipeline step isolation
- Each pipeline step testable in isolation with mock inputs

## Important Context

- Origin: UFO magazine analysis project, but designed fully **domain-agnostic**
- `mulder.config.yaml` is the central control — all domain-specific logic lives there
- No tiers, no paywalls — fully open source. Users enable/disable capabilities via config flags.
- Gemini is the only LLM provider (native PDF support + structured output) — also used for Web Grounding (`google_search_retrieval`)
- MVP (v1.0): Capabilities 1-4 (extraction, ontology, taxonomy, hybrid retrieval). Full-featured (v2.0): Capabilities 5-7 (grounding, spatio-temporal, evidence). All are part of the core design.
- **No Spanner** — architecture uses a single Cloud SQL PostgreSQL instance for everything (pgvector, tsvector, PostGIS, relational graph via recursive CTEs)
