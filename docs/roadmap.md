# Mulder — Implementation Roadmap

Tracer bullet development path. Build the pipeline synchronously via CLI first (M1-M6), defer distributed infrastructure until the core works (M7-M8). Optimize for time to first demoable product (M4).

---

## M1: "mulder runs locally" — Foundation

No GCP, no LLM, no cost. Pure TypeScript scaffolding.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| A1 | Monorepo setup | pnpm, turbo, tsconfig, eslint | — |
| A2 | Config loader + Zod schemas | `loadConfig()`, validated against `mulder.config.example.yaml` | A1 |
| A3 | Custom error classes | Error types with codes | A1 |
| A4 | Logger setup | Pino structured JSON logger | A1 |
| A5 | CLI scaffold | `mulder` binary, `config validate`, `config show` | A1-A4 |
| A6 | Database client + migration runner | `getWorkerPool()`, `getQueryPool()`, `mulder db migrate` | A1, A5 |
| A7 | Core schema migrations (001-008) | Tables: sources, source_steps, stories, entities, edges, chunks, taxonomy | A6 |
| A8 | Job queue + pipeline tracking migrations (012-014) | Tables: jobs, pipeline_runs, reset_pipeline_step() function | A6 |
| A9 | Fixture directory structure | Placeholder structure in `fixtures/` | — |
| A10 | Service abstraction layer | `services.ts`, `registry.ts`, `rate-limiter.ts`, `retry.ts` | A1 |
| A11 | Docker Compose setup | pgvector + Firestore emulator | — |

**Testable:** `mulder config validate` + `mulder db migrate` + `mulder db status`. Dev registry returns fixture services. No GCP account needed.

---

## M2: "PDFs go in" — Ingest + Extract

First GCP integration. First real cost (Document AI).

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| B1 | GCP + dev service implementations | `services.gcp.ts`, `services.dev.ts` | A10 |
| B2 | Source repository | CRUD for `sources` table | A7 |
| B3 | Native text detection | `pdf-parse` integration, `has_native_text` flag | A1 |
| B4 | Ingest step | `mulder ingest <path>` | B1, B2, B3 |
| B5 | Vertex AI wrapper + dev cache | `generateStructured()`, `.mulder-cache.db` | B1 |
| B6 | Prompt template engine | `renderPrompt()` | A1 |
| B7 | Extract step (output to GCS) | `mulder extract <id>` → layout.json + page images in GCS | B1, B2, B5, B3 |
| B8 | Fixture generator | `mulder fixtures generate` | B1-B7 |
| B9 | **Golden test set: extraction** | 5-10 annotated test pages with expected OCR output. Vitest assertions against fixtures. | B7, B8 |

**Testable:** Feed PDFs, inspect OCR quality. Dev mode works against fixtures (zero cost). Golden test pages validate extraction before moving forward.

---

## M3: "Stories and entities appear" — Segment + Enrich

Core intelligence. Where mulder becomes more than an OCR tool.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| C1 | Story repository (GCS URIs) | CRUD for `stories` table | A7 |
| C2 | Segment step (output to GCS) | `mulder segment <id>` → Markdown + metadata per segment | B5, B6, C1 |
| C3 | Entity + alias repositories | CRUD for `entities`, `entity_aliases`, `story_entities` | A7 |
| C4 | Edge repository | CRUD for `entity_edges` | A7 |
| C5 | JSON Schema generator (zod-to-json-schema) | Dynamic schema for Gemini structured output | A2 |
| C6 | Taxonomy normalization | `normalize()` via `pg_trgm` | A7 |
| C7 | Cross-lingual entity resolution (3-tier) | `resolve()` with attribute match, embedding similarity, LLM-assisted | C3, B5 |
| C8 | Enrich step | `mulder enrich <id>` | B5, B6, C1-C7 |
| C9 | Cascading reset function | `reset_pipeline_step()` PL/pgSQL | A7 |
| C10 | **Golden test set: segmentation + entities** | 3-5 annotated articles with expected segment boundaries + entities. Vitest assertions. | C2, C8 |

**Testable:** Full extraction pipeline through entities. `--force` re-runs work cleanly. Cross-lingual entity merging verified. Golden tests catch prompt regressions.

---

## M4: "You can search" — Embed + Graph + Pipeline + Retrieval (v1.0 MVP)

First version worth showing to anyone.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| D1-D3 | Embedding wrapper + semantic chunker + chunk repository | `embed()`, `chunk()`, CRUD for `chunks` | B1, A7 |
| D4 | Embed step | `mulder embed <id>` → chunks with vectors + FTS in PostgreSQL | D1-D3, B5, B6 |
| D5 | Graph step (dedup + corroboration + contradiction flagging) | `mulder graph <id>` | C4 |
| D6 | Pipeline orchestrator (cursor-based) | `mulder pipeline run <path>` | B4, B7, C2, C8, D4, D5 |
| D7 | Full-text search (generated tsvector on chunks) | BM25 queries on same table as vectors | D3 |
| E1 | Vector search (HNSW) | pgvector cosine similarity queries | D3 |
| E2 | Full-text search wrapper | tsvector BM25 queries | D7 |
| E3 | Graph traversal (recursive CTE with cycle detection) | Connected entity queries | C4 |
| E4 | RRF fusion | Combined results from all strategies | E1-E3 |
| E5 | LLM re-ranking | Gemini Flash re-ranks top N | B5, B6 |
| E6 | Hybrid retrieval orchestrator | `mulder query <question>` | E1-E5 |

**Testable: Full MVP end-to-end.** Ingest PDFs → process → query with natural language → ranked results. Demo-worthy. Blog-post-worthy. This is v1.0.

---

## M5: "Curated knowledge" — Taxonomy + Entity Management

Polish and curation tools.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| F1 | Taxonomy bootstrap | `mulder taxonomy bootstrap` | C3, B5 |
| F2 | Taxonomy export/curate/merge | `mulder taxonomy export/curate/merge` | F1 |
| F3 | Entity management CLI | `mulder entity list/show/merge/aliases` | C3 |
| F4 | Status overview | `mulder status` | B2, C1, C3 |
| F5 | Export commands | `mulder export graph/stories/evidence` | C3, C4 |

**Testable:** Human-in-the-loop curation. Export to Neo4j/Gephi. Production entity management.

---

## M6: "Intelligence layer" — Ground + Analyze (v2.0)

The differentiating capabilities.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| G1 | v2.0 schema migrations (009-011) | Tables: grounding, evidence_chains, clusters | A6 |
| G2 | Ground step | `mulder ground <entity-id>` | B5, G1 |
| G3 | Contradiction resolution | `mulder analyze --contradictions` | B5, B6, D5 |
| G4 | Source reliability scoring | `mulder analyze --reliability` | D5 |
| G5 | Evidence chains | `mulder analyze --evidence-chains` | D5, G1 |
| G6 | Spatio-temporal clustering | `mulder analyze --spatio-temporal` | G1, G2 |
| G7 | Analyze orchestrator | `mulder analyze --full` | G3-G6 |

**Testable:** Web-enriched entities, resolved contradictions, evidence chains, spatial clusters. Full v2.0 intelligence.

---

## M7: "API + workers" — Async Execution Layer

Makes mulder deployable as a service.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| H1 | Job queue repository | `enqueue()`, `dequeue()`, `reap()` | A8 |
| H2 | Worker loop | `mulder worker start/status/reap` | H1 |
| H3 | Hono server scaffold | HTTP server | A1 |
| H4 | Pipeline API routes (async) | `POST /api/pipeline/run` → 202 + job_id | H1, H2, D6 |
| H5 | Job status API | `GET /api/jobs/:id` | H1 |
| H6 | Search API routes (sync) | `POST /api/search` | E6 |
| H7 | Entity API routes (sync) | `GET /api/entities/*` | C3 |
| H8 | Evidence API routes (sync) | `GET /api/evidence/*` | G7 |
| H9 | Middleware (auth, rate limiting, validation) | API safety layer | H3 |

**Testable:** HTTP API for everything. Workers process jobs asynchronously. Deployable to Cloud Run.

---

## M8: "Production-safe" — Operational Infrastructure

Safety nets for running at scale.

| Step | What | Produces | Depends on |
|------|------|----------|------------|
| I1 | `mulder eval` CLI + reporter | `mulder eval --compare baseline`, CER/WER metrics, regression detection | B9, C10 |
| I2 | Cost estimator | `mulder ingest --cost-estimate`, `mulder reprocess --cost-estimate` | B4, D6 |
| I3 | Terraform budget alerts | `terraform/modules/budget/` | — |
| I4 | Schema evolution / reprocessing | `mulder reprocess --dry-run`, config_hash comparison | D6 |
| I5 | Dead letter queue | `dead_letter` job status + `mulder retry` CLI | H2 |
| I6 | Devlog system | `devlog/` conventions established | — |

**Testable:** Eval against golden set with CLI reporter. Cost gates before expensive operations. Selective reprocessing after config changes. DLQ recovery.

---

## Critical path

```
M1 Foundation
 └→ M2 Ingest+Extract (+golden extraction tests)
     └→ M3 Segment+Enrich (+golden entity tests)
         └→ M4 Search (v1.0 MVP) ← FIRST DEMO POINT
             ├→ M5 Curation
             ├→ M6 Intelligence (v2.0)
             ├→ M7 API+Workers
             └→ M8 Operations
```

M1→M4 is the critical path. Everything after M4 can be reordered based on user feedback. M5-M8 are largely independent of each other.

## Key decisions baked into this order

1. **CLI-first, API later.** Debug pipeline logic synchronously before adding async job state.
2. **Golden tests before prompts.** Annotate expected outputs before writing Gemini prompts (B9, C10). Prevents silent regressions during prompt iteration.
3. **Dev cache early (B5).** LLM response cache in M2 saves hundreds of dollars during M3 prompt iteration.
4. **Defer job queue (M7).** `FOR UPDATE SKIP LOCKED` is tricky. Build it after pipeline functions are bulletproof.
5. **Eval CLI last, eval data first.** The `mulder eval` reporter is M8 polish. The golden test data and Vitest assertions are M2/M3 necessities.
6. **M4 is the pivot point.** If search results are bad, revisit extraction prompts (M3) before building APIs (M7).
