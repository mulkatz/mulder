<p align="center"><img src="./icon.png" width="120" /></p>

# mulder

**Config-driven Document Intelligence Platform on GCP.**
Turn any document collection into a searchable knowledge base with a Knowledge Graph — defined by one config file, deployed by one command.

*The truth is in the documents.*

## What it does

mulder transforms unstructured document collections — PDFs with complex layouts like magazines, newspapers, government correspondence — into structured, searchable knowledge. You define your domain ontology (entity types, relationships, extraction strategy) in a single `mulder.config.yaml`, run `terraform apply`, and get a fully deployed GCP pipeline that ingests, extracts, enriches, and connects your documents.

There's no open-source tool that combines GCP-native Terraform deployment, a config-driven domain ontology, hybrid retrieval (vector + full-text + graph), web grounding, evidence scoring, and spatio-temporal analysis — all on a single PostgreSQL instance. mulder fills that gap.

## Key Features

- **Config-driven** — One YAML file defines your entire domain: entities, relationships, extraction rules
- **Terraform-deployed** — Full GCP infrastructure from a single `terraform apply`
- **Complex layout support** — Document AI Layout Parser + Gemini Vision fallback for magazines, newspapers, multi-column layouts
- **Hybrid Retrieval** — Vector search (pgvector) + BM25 full-text (tsvector) + graph traversal, fused via RRF and LLM re-ranking
- **Domain Taxonomy** — Auto-generated, incrementally growing taxonomy with human-in-the-loop curation for entity normalization
- **Web Grounding** — Gemini verifies and enriches entities against live web data (coordinates, bios, org descriptions)
- **Spatio-Temporal Analysis** — PostGIS proximity queries, temporal clustering, pattern detection across time and space
- **Evidence Scoring** — Corroboration scores, contradiction detection, source reliability via weighted PageRank, evidence chains
- **PostgreSQL All-in-One** — Single Cloud SQL instance handles vector search, full-text search, geospatial, and graph traversal (recursive CTEs)
- **Multilingual** — German + English out of the box, extensible to any language
- **CLI-first** — Ingest, query, export, and manage everything from the terminal

## Core Capabilities

### MVP (v1.0)

#### 1. Complex Layout Extraction
Document AI Layout Parser handles OCR and layout analysis for complex documents — magazines, newspapers, multi-column government correspondence. Gemini Vision falls back on pages where confidence is low, handling tables, sidebars, and mixed-layout content.

#### 2. Config-Driven Domain Ontology
A single `mulder.config.yaml` defines entity types, relationships, attributes, and extraction strategy. Gemini structured output uses dynamically generated JSON Schema from this config. Switch domains by editing one file — no code changes.

#### 3. Domain Taxonomy with Auto-Normalization
Solves the problem of entity matching across inconsistent terminology. After ~25 documents, Gemini bootstraps a taxonomy grouping entity variants under canonical terms. Each new document matches entities against the existing taxonomy. Auto-generated entries marked `auto`, manually confirmed entries marked `confirmed`. Curate via `taxonomy.curated.yaml` or the CLI. Re-bootstrap via `mulder taxonomy re-bootstrap` when the collection grows significantly.

#### 4. Hybrid Retrieval with LLM Re-Ranking
Three parallel retrieval strategies — vector search (pgvector cosine similarity), BM25 full-text search (PostgreSQL tsvector), and graph traversal (recursive CTEs) — fused via Reciprocal Rank Fusion (RRF). Gemini Flash re-ranks the fused results for final relevance in the query context.

### Full-Featured (v2.0)

#### 5. Web Grounding / Enrichment
Gemini's native `google_search_retrieval` tool via Vertex AI verifies and enriches extracted entities: locations → GPS coordinates and type, persons → biographical context, organizations → descriptions, events → date verification. Three modes: `pipeline` (auto during ingestion), `on_demand` (enrich specific entities or batches via API/CLI), or `disabled`. Config controls which entity types get enriched. Results cached with configurable TTL.

#### 6. Spatio-Temporal Analysis
Time and space as first-class dimensions. Temporal: normalized timestamps on events, fuzzy date normalization ("early 80s" → date range), temporal cluster detection. Geospatial: PostGIS for proximity queries, coordinates enriched via web grounding. Combined: graph algorithms (community detection, shortest path) filtered by time and space windows.

#### 7. Evidence Scoring & Contradiction Detection
Transforms the knowledge graph from a connection map into an assessment system. Two-phase contradiction detection: the Graph step flags potential contradictions immediately via attribute comparison (fast, no LLM — e.g., "March 1982" vs "July 1983" on the same event), then the Analyze step resolves them via Gemini semantic comparison (confirms real contradictions, dismisses precision differences like "early 1982" vs "March 1982"). Corroboration scores count independent sources per claim. Weighted PageRank scores source reliability. Evidence chains trace paths through the graph supporting or refuting a thesis.

## Quick Start

> Coming soon — the project is under active development.

## Architecture Overview

mulder processes documents through an eight-stage pipeline, orchestrated by Cloud Workflows:

1. **Ingest** — PDFs land in Cloud Storage, triggering the pipeline via Eventarc + Pub/Sub
2. **Extract** — Document AI Layout Parser handles OCR and layout analysis; Gemini Vision falls back on low-confidence pages
3. **Segment** — Gemini structured output identifies and isolates individual articles/stories within a document
4. **Enrich** — Entities and relationships extracted based on your config ontology, normalized against the domain taxonomy, with cross-document entity resolution
5. **Ground** — Web enrichment via Gemini `google_search_retrieval` — verifies and enriches entities with real-world data (coordinates, bios, descriptions)
6. **Embed** — Semantic chunking with question generation, embedded via `gemini-embedding-001` (3072-dim, multilingual)
7. **Graph** — Entities and relationships written to PostgreSQL relational tables; corroboration scoring (SQL aggregation); flags potential contradictions via attribute diff (no LLM)
8. **Analyze** — Resolves pending contradictions via Gemini (confirm or dismiss), spatio-temporal clustering, source reliability scoring (weighted PageRank), evidence chain computation

Every step is idempotent and can be re-run individually. Ground can run independently when web data changes. Analyze can run after each new batch without retriggering the full pipeline.

Query via the API or CLI using hybrid retrieval (vector + full-text + graph), with LLM re-ranking for optimal results.

## Configuration

All domain-specific logic lives in `mulder.config.yaml`. Here's a trimmed example for investigative journalism research:

```yaml
project:
  name: investigative-journalism
  gcp_project_id: my-gcp-project
  region: europe-west3

ontology:
  entities:
    - name: person
      description: Individual mentioned in documents
      attributes:
        - name: role
          type: string
          description: Role or title (e.g., politician, whistleblower, journalist)
        - name: affiliation
          type: string
          description: Organization or group affiliation

    - name: organization
      description: Company, agency, or institution
      attributes:
        - name: type
          type: enum
          values: [government, corporate, ngo, media, other]

    - name: event
      description: A specific incident, meeting, or occurrence
      attributes:
        - name: date
          type: date
        - name: location
          type: string

    - name: document_ref
      description: Reference to an external document, law, or filing
      attributes:
        - name: doc_type
          type: enum
          values: [court_filing, legislation, report, memo, correspondence]
        - name: identifier
          type: string

    - name: location
      description: Geographic place
      attributes:
        - name: coordinates
          type: geo_point
          optional: true

  relationships:
    - name: involved_in
      from: person
      to: event
      attributes:
        - name: role
          type: string

    - name: affiliated_with
      from: person
      to: organization

    - name: references
      from: event
      to: document_ref

    - name: occurred_at
      from: event
      to: location

extraction:
  language: [en, de]
  segmentation:
    strategy: llm
    model: gemini-2.5-flash
  entity_extraction:
    model: gemini-2.5-flash
    confidence_threshold: 0.8
  entity_resolution:
    enabled: true
    similarity_threshold: 0.85

taxonomy:
  auto_generate: true
  bootstrap_after_n_documents: 25
  allow_re_bootstrap: true
  normalization_model: "gemini-2.5-flash"
  curated_file: "taxonomy.curated.yaml"

retrieval:
  strategies:
    vector: { weight: 0.4, top_k: 20 }
    fulltext: { weight: 0.3, top_k: 20 }
    graph: { weight: 0.3, max_hops: 2 }
  reranker:
    enabled: true
    model: "gemini-2.5-flash"
    top_k: 10

enrichment:
  enabled: true
  mode: "on_demand"  # "pipeline" | "on_demand" | "disabled"
  provider: "gemini_search_grounding"
  enrich_types: ["Location", "Person", "Organization", "Event"]
  skip_types: ["Phenomenon", "ObjectDescription"]
  cache_ttl_days: 90

analysis:
  temporal:
    enabled: true
    cluster_window_days: 30
    normalize_dates: true
  geospatial:
    enabled: true
    proximity_default_km: 50
    enrich_coordinates: true

evidence:
  corroboration:
    enabled: true
    min_independent_sources: 2
  contradiction:
    enabled: true
    detection_model: "gemini-2.5-flash"
    compare_attributes: ["date", "location", "description", "witness_count"]
  source_scoring:
    enabled: true
    algorithm: "weighted_pagerank"
```

## Infrastructure & Cost

mulder runs on a minimal GCP footprint. All capabilities are feature-flagged — enable what you need, disable what you don't.

**Core (always deployed):**
- Cloud SQL PostgreSQL (pgvector + tsvector + PostGIS) — single instance for all data
- Cloud Storage — document storage
- Cloud Run — API + pipeline workers
- Pub/Sub + Eventarc — pipeline orchestration
- Firestore — metadata

**Optional (enable via config):**
- BigQuery — analytics and reporting
- Vertex AI Search — managed retrieval alternative

Baseline cost: **~30-40 EUR/mo** for a small Cloud SQL instance. Scales with instance size and Gemini API usage. All capabilities are included — you choose what to enable based on your needs and budget.

## Tech Stack

| Component | Technology |
|---|---|
| Language | TypeScript (ESM, strict) |
| Monorepo | pnpm + Turborepo |
| Infrastructure | Terraform (modular) |
| OCR | Document AI Layout Parser |
| LLM | Gemini 2.5 Flash via Vertex AI |
| Web Grounding | Gemini `google_search_retrieval` (Vertex AI) |
| Embeddings | gemini-embedding-001 (3072-dim) |
| Database | Cloud SQL PostgreSQL (pgvector + tsvector + PostGIS) |
| Metadata | Firestore |
| Orchestration | Cloud Workflows + Cloud Run Jobs |
| API | Cloud Run Service |
| Config Validation | Zod |
| CLI | Commander.js / oclif |
| Testing | Vitest |

## Status

mulder is in active early development. The architecture is defined, implementation is underway.

Contributions, feedback, and ideas are welcome — open an issue or start a discussion.

## License

[Apache 2.0](LICENSE)
