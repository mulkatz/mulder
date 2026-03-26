<p align="center"><img src="./icon.png" width="120" /></p>

# mulder

**Config-driven Document Intelligence Platform on GCP.**
Turn any document collection into a searchable knowledge base with a Knowledge Graph — defined by one config file, deployed by one command.

*The truth is in the documents.*

## What it does

mulder transforms unstructured document collections — PDFs with complex layouts like magazines, newspapers, government correspondence — into structured, searchable knowledge. You define your domain ontology (entity types, relationships, extraction strategy) in a single `mulder.config.yaml`, run `terraform apply`, and get a fully deployed GCP pipeline that ingests, extracts, enriches, and connects your documents.

There's no open-source tool that combines GCP-native Terraform deployment, a config-driven domain ontology, and unified Knowledge Graph + Vector Search. mulder fills that gap.

## Key Features

- **Config-driven** — One YAML file defines your entire domain: entities, relationships, extraction rules
- **Terraform-deployed** — Full GCP infrastructure from a single `terraform apply`, with three cost tiers
- **Complex layout support** — Document AI Layout Parser + Gemini Vision fallback for magazines, newspapers, multi-column layouts
- **Knowledge Graph** — Spanner Graph with GQL queries over extracted entities and relationships
- **Vector Search** — Semantic search via pgvector with multilingual Matryoshka embeddings
- **Multilingual** — German + English out of the box, extensible to any language
- **CLI-first** — Ingest, query, export, and manage everything from the terminal

## Quick Start

> Coming soon — the project is under active development.

## Architecture Overview

mulder processes documents through a six-stage pipeline, orchestrated by Cloud Workflows:

1. **Ingest** — PDFs land in Cloud Storage, triggering the pipeline via Eventarc + Pub/Sub
2. **Extract** — Document AI Layout Parser handles OCR and layout analysis; Gemini Vision falls back on low-confidence pages
3. **Segment** — Gemini structured output identifies and isolates individual articles/stories within a document
4. **Enrich** — Entities and relationships are extracted based on the ontology defined in your config, with cross-document entity resolution
5. **Embed** — Semantic chunking with question generation, embedded via `gemini-embedding-001` (3072-dim, multilingual)
6. **Graph** — Entities and relationships are written to Spanner Graph; schema is auto-generated from your config

Query via the API or CLI to search semantically, traverse the knowledge graph, or combine both.

## Configuration

All domain-specific logic lives in `mulder.config.yaml`. Here's a trimmed example for investigative journalism research:

```yaml
project:
  name: investigative-journalism
  gcp_project_id: my-gcp-project
  region: europe-west3
  tier: standard

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
```

## Infrastructure Tiers

| Tier | Monthly Cost | What's included |
|---|---|---|
| **budget** | ~37 EUR | Cloud SQL (pgvector), entities as relational tables, full pipeline, semantic search |
| **standard** | ~162 EUR | + Spanner Graph for native graph queries (GQL), cross-entity traversal |
| **advanced** | ~183+ EUR | + BigQuery Analytics, Vertex AI Search for managed retrieval |

All tiers include the complete ingest-to-query pipeline. The tier is set in `mulder.config.yaml` and controls which Terraform modules are deployed.

## Tech Stack

| Component | Technology |
|---|---|
| Language | TypeScript (ESM, strict) |
| Monorepo | pnpm + Turborepo |
| Infrastructure | Terraform (modular) |
| OCR | Document AI Layout Parser |
| LLM | Gemini 2.5 Flash via Vertex AI |
| Embeddings | gemini-embedding-001 (3072-dim) |
| Vector DB | Cloud SQL PostgreSQL + pgvector |
| Graph DB | Spanner Graph |
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
