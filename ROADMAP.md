# mulder — Implementation Roadmap

Linear implementation sequence. Each phase builds on the previous. Every step is spec-driven: `/project:architect` creates the spec, `/project:implement` builds it, `/project:verify` validates it.

## Phase 1: Infrastructure (Terraform)

Foundation — no application code.

- **1.1 GCP Project Base** — Terraform providers, enable APIs (Vertex AI, Document AI, Cloud SQL, Pub/Sub, Storage, Secret Manager, Eventarc)
- **1.2 Cloud SQL PostgreSQL** — Terraform module, single instance with pgvector + PostGIS + pg_trgm extensions
- **1.3 Cloud Storage** — Upload bucket for PDF documents
- **1.4 Pub/Sub + Eventarc** — Topics and subscriptions for pipeline orchestration
- **1.5 Cloud Run** — Service for API, Job definitions for pipeline workers
- **1.6 Firestore** — Metadata store
- **1.7 IAM + Networking** — Service accounts, VPC connector, Cloud SQL Auth Proxy for local dev

## Phase 2: Application Foundation

TypeScript project setup and core infrastructure code.

- **2.0 Monorepo Setup** — pnpm + Turborepo, tsconfig (strict, ESM), linting
- **2.1 Shared Infrastructure** — GCP client factory (`src/shared/gcp.ts`), custom Error classes, pino logger
- **2.2 Config Loader** — YAML parser + Zod validation for `mulder.config.yaml`
- **2.3 Database Schema (Core)** — Migrations for `sources`, `stories`, `entities`, `entity_aliases`, `entity_edges`
- **2.4 Prompt Template Engine** — Jinja2-style renderer with i18n injection
- **2.5 CLI Scaffold** — Commander.js setup with `mulder` entry point

## Phase 3: MVP Pipeline (Capabilities 1-4)

The 6-step pipeline that powers v1.0.

- **3.1 Ingest** — PDF upload -> Cloud Storage -> Eventarc trigger -> Pub/Sub message
- **3.2 Extract** — Document AI Layout Parser, Gemini Vision fallback on low confidence
- **3.3 Segment** — Gemini structured output: identify and isolate articles/stories from extracted content
- **3.4 Enrich** — Entity extraction from ontology config, taxonomy normalization, entity resolution (canonical_id merging)
- **3.5 Embed** — `gemini-embedding-001` embeddings, semantic chunking with question generation
- **3.6 Graph** — Entities + relationships -> PostgreSQL relational tables

## Phase 4: Taxonomy System

Domain taxonomy with auto-normalization (Capability 3).

- **4.1 Taxonomy Bootstrap** — Auto-generate taxonomy after ~25 docs via Gemini clustering
- **4.2 Taxonomy Normalization** — Inline normalization in Enrich step against curated taxonomy
- **4.3 CLI: `mulder taxonomy re-bootstrap`** — Regenerate taxonomy from all ingested documents
- **4.4 Taxonomy Curation** — `taxonomy.curated.yaml` format, confirmed/draft status, human-in-the-loop

## Phase 5: Retrieval (Capability 4)

Hybrid retrieval with LLM re-ranking.

- **5.1 Vector Search** — pgvector similarity queries
- **5.2 Full-Text Search** — tsvector/BM25 queries
- **5.3 Graph Traversal** — `WITH RECURSIVE` CTEs for entity relationship paths
- **5.4 RRF Fusion** — Reciprocal Rank Fusion combining all three strategies
- **5.5 LLM Re-Ranking** — Gemini Flash re-ranks fused results for final relevance
- **5.6 API Routes** — REST endpoints for search, entity lookup, graph queries

## Phase 6: Full Pipeline (Capabilities 5-7)

v2.0 additions: Ground and Analyze steps.

- **6.1 Ground** — Web enrichment via Gemini `google_search_retrieval` (locations -> coordinates, persons -> bio, orgs -> descriptions)
- **6.2 Evidence Schema** — Database tables for corroboration scores, contradiction edges, source reliability, evidence chains
- **6.3 Graph: Corroboration + Contradiction Flagging** — Independent source counting, attribute diff for potential contradictions (fast, no LLM)
- **6.4 Analyze: Contradiction Resolution** — Gemini semantic comparison, confirm or dismiss flagged contradictions
- **6.5 Analyze: Source Reliability** — Weighted PageRank over citation graph
- **6.6 Analyze: Evidence Chains** — Recursive CTE discovery with aggregated strength scores
- **6.7 Evidence API** — REST endpoints for corroboration, contradictions, reliability, chains
- **6.8 Spatio-Temporal Analysis** — PostGIS proximity queries, temporal clustering, pattern detection

## Phase 7: API + CLI Polish

Production-ready interfaces.

- **7.1 API Middleware** — Auth, rate limiting, error handling, request validation
- **7.2 CLI Commands** — `mulder ingest`, `mulder status`, `mulder query`, `mulder export`, `mulder taxonomy`
- **7.3 Config Validation** — `mulder config validate`, `mulder config show`
- **7.4 Observability** — Structured logging, health checks, metrics

---

## Workflow

Every step above follows the spec-driven workflow:

```
/project:architect "step description"  ->  spec + GitHub issue
/project:implement NN                  ->  code + PR
/project:verify NN                     ->  black-box tests + report
```

Specs live in `docs/specs/`. Issues track progress on GitHub. PRs reference their issue and spec.
