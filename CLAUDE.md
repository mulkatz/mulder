# mulder

Config-driven Document Intelligence Platform on GCP. Transforms document collections (PDFs with complex layouts) into a searchable knowledge base with Knowledge Graph. One `mulder.config.yaml` defines the domain ontology, `terraform apply` deploys everything.

## Architecture Decisions

- **TypeScript** throughout (pipeline, API, CLI, config loader) — ESM, strict mode
- **Monorepo**: pnpm + Turborepo
- **Infra**: Terraform, modular (`terraform/modules/`)
- **OCR**: Document AI Layout Parser (Gemini-based), Gemini Vision fallback for complex layouts
- **LLM**: Gemini 2.5 Flash via Vertex AI — structured output for extraction. Only LLM provider (native PDF support + structured output)
- **Embeddings**: `gemini-embedding-001` — multilingual, 3072-dim Matryoshka
- **Vector DB**: Cloud SQL PostgreSQL + pgvector
- **Graph DB**: Spanner Graph (GQL + SQL + Vector in one DB)
- **Metadata**: Firestore
- **Orchestration**: Cloud Workflows + Cloud Run Jobs
- **API**: Cloud Run Service
- **Config**: YAML + Zod validation (`mulder.config.yaml`)
- **Prompts**: Jinja2-style templates with i18n injection
- **i18n**: i18next for UI, custom system for LLM prompts, DE + EN initial
- **CLI**: Commander.js or oclif
- **License**: Apache 2.0

## Infrastructure Tiers

- **budget** (~37 EUR/mo): Cloud SQL only, entities as relational tables
- **standard** (~162 EUR/mo): + Spanner Graph for graph queries
- **advanced** (~183+ EUR/mo): + BigQuery Analytics + Vertex AI Search

Tier is set in `mulder.config.yaml`, controls which Terraform modules are deployed.

## Pipeline Stages

1. **Ingest** — PDF → Cloud Storage → Eventarc → Pub/Sub
2. **Extract** — Document AI Layout Parser, Gemini fallback on low confidence
3. **Segment** — Gemini structured output: identify and isolate articles/stories
4. **Enrich** — Entity extraction from ontology config, entity resolution
5. **Embed** — `gemini-embedding-001`, semantic chunking with question generation
6. **Graph** — Entities + Relationships → Spanner Graph (schema from config)

## Code Conventions

- TypeScript strict mode, ESM only
- Zod for all runtime validation
- Custom Error classes with error codes, no generic `throw new Error()`
- Structured JSON logging via pino
- No `any`, no `as` type assertions except for external API responses
- All GCP clients via central factory (`src/shared/gcp.ts`)
- Config always via the loader, never parse YAML directly
- Prompts always from templates, never inline strings

## Naming Conventions

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/Variables: `camelCase`
- Terraform resources: `snake_case`
- Config keys: `snake_case`

## Repo Structure

```
mulder/
├── terraform/modules/{storage,document-ai,cloud-sql,spanner-graph,firestore,cloud-run,workflows,pubsub,networking,iam,secrets}
├── src/
│   ├── pipeline/{ingest,extract,segment,enrich,embed,graph}
│   ├── api/{routes,services,middleware}
│   ├── config/          # Config loader + Zod schemas
│   ├── prompts/         # Jinja2-style templates
│   └── shared/          # GCP client factory, common types, errors
├── cli/commands/{init,deploy,ingest,status,query,export}
├── i18n/{de,en}
├── examples/{ufo-magazines,legal-correspondence,academic-papers}
├── docs/
├── mulder.config.yaml
└── mulder.config.example.yaml
```

## Key Patterns

- Pipeline steps are **idempotent** and can be re-run individually
- Every pipeline step reads config via the central loader
- Spanner Graph schema is **generated from ontology config** (never hand-written)
- Entity extraction uses Gemini structured output with **dynamically generated JSON Schema from config**
- Terraform reads `mulder.config.yaml` directly via `yamldecode()`

## Testing

- Vitest
- Focus areas: config validation, pipeline step isolation
- Each pipeline step testable in isolation with mock inputs

## Important Context

- Origin: UFO magazine analysis project, but designed fully **domain-agnostic**
- `mulder.config.yaml` is the central control — all domain-specific logic lives there
- Three infra tiers (budget/standard/advanced) control which GCP services get deployed
- Gemini is the only LLM provider (native PDF support + structured output)
