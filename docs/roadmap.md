# Mulder — Implementation Roadmap

Tracer bullet development path. Build the pipeline synchronously via CLI first (M1-M6), defer distributed infrastructure until the core works (M7-M8). Optimize for time to first demoable product (M4).

**Spec references:** Each step lists the exact sections of [`functional-spec.md`](./functional-spec.md) needed to implement it. Read only those sections — never the full 2500-line spec.

**Status:** &ensp; ⚪ not started &ensp; 🟡 in progress &ensp; 🟢 done

---

## M1: "Mulder runs locally" — Foundation

No GCP, no LLM, no cost. Pure TypeScript scaffolding.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | A1 | Monorepo setup — pnpm, turbo, tsconfig, biome | §13 |
| 🟢 | A2 | Config loader + Zod schemas — `loadConfig()` | §4.1 |
| 🟢 | A3 | Custom error classes — Error types with codes | §7.1, §7.2 |
| 🟢 | A4 | Logger setup — Pino structured JSON | §8 |
| 🟢 | A5 | CLI scaffold — `mulder` binary, `config validate`, `config show` | §1, §1.1 |
| 🟢 | A6 | Database client + migration runner — dual connection pools | §4.2, §4.3, §4.6 |
| 🟢 | A7 | Core schema migrations (001-008) — all tables, extensions, indexes | §4.3 |
| 🟡 | A8 | Job queue + pipeline tracking migrations (012-014) | §4.3 (jobs, pipeline_runs), §4.3.1 |
| ⚪ | A9 | Fixture directory structure — placeholders in `fixtures/` | §11 |
| ⚪ | A10 | Service abstraction — interfaces, registry, rate-limiter, retry | §4.5, §7.3 |
| ⚪ | A11 | Docker Compose — pgvector + Firestore emulator | §9.3 |

**Also read for all M1 steps:** §13 (source layout), §14 (design decisions — monorepo, repositories, single PostgreSQL, CLI-first)

**Testable:** `mulder config validate` + `mulder db migrate` + `mulder db status`. Dev registry returns fixture services. No GCP account needed.

---

## M2: "PDFs go in" — Ingest + Extract

First GCP integration. First real cost (Document AI).

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | B1 | GCP + dev service implementations | §4.5, §4.6 |
| ⚪ | B2 | Source repository — CRUD for `sources` table | §4.3 (sources table), §2.1 |
| ⚪ | B3 | Native text detection — `pdf-parse`, `has_native_text` flag | §2.1 |
| ⚪ | B4 | Ingest step — `mulder ingest <path>` | §2.1, §4.3 (sources table), §1 (ingest cmd) |
| ⚪ | B5 | Vertex AI wrapper + dev cache | §4.8 |
| ⚪ | B6 | Prompt template engine — `renderPrompt()` | §4.7 |
| ⚪ | B7 | Extract step — output to GCS | §2.2, §4.4 |
| ⚪ | B8 | Fixture generator — `mulder fixtures generate` | §11, §9.1 |
| ⚪ | B9 | Golden test set: extraction — 5-10 annotated pages, Vitest assertions | §15.1, §15.2 |

**Also read for all M2 steps:** §2 (global step conventions), §4.5 (service abstraction), §7.3 (retry), §8 (logging), §11 (fixtures)

**Testable:** Feed PDFs, inspect OCR quality. Dev mode works against fixtures (zero cost). Golden test pages validate extraction.

---

## M3: "Stories and entities appear" — Segment + Enrich

Core intelligence. Where Mulder becomes more than an OCR tool.

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | C1 | Story repository — CRUD with GCS URIs | §4.3 (stories table), §2.3 |
| ⚪ | C2 | Segment step — output Markdown + metadata to GCS | §2.3, §4.4 |
| ⚪ | C3 | Entity + alias repositories — CRUD | §4.3 (entities, entity_aliases, story_entities), §2.4 |
| ⚪ | C4 | Edge repository — CRUD for `entity_edges` | §4.3 (entity_edges), §2.4 |
| ⚪ | C5 | JSON Schema generator — `zod-to-json-schema` | §2.4, §14 (why zod-to-json-schema) |
| ⚪ | C6 | Taxonomy normalization — `pg_trgm` matching | §6.2, §2.4 |
| ⚪ | C7 | Cross-lingual entity resolution — 3-tier | §2.4 (resolution strategy), §4.8 (embedding calls) |
| ⚪ | C8 | Enrich step — `mulder enrich <id>` | §2.4, §6 (especially §6.2), §1 (enrich cmd) |
| ⚪ | C9 | Cascading reset function — PL/pgSQL | §4.3.1, §3.4 |
| ⚪ | C10 | Golden test set: segmentation + entities — Vitest assertions | §15.1, §15.2 |

**Also read for all M3 steps:** §2 (global step conventions), §4.5 (service abstraction), §6 (taxonomy system), §7.3 (retry), §8 (logging)

**Testable:** Full extraction pipeline through entities. `--force` re-runs work cleanly. Cross-lingual entity merging verified. Golden tests catch prompt regressions.

---

## M4: "You can search" — v1.0 MVP

First version worth showing to anyone.

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | D1-D3 | Embedding wrapper + semantic chunker + chunk repo | §2.6, §4.3 (chunks table) |
| ⚪ | D4 | Embed step — `mulder embed <id>` | §2.6, §1 (embed cmd) |
| ⚪ | D5 | Graph step — dedup + corroboration + contradiction flagging | §2.7, §1 (graph cmd) |
| ⚪ | D6 | Pipeline orchestrator — cursor-based | §3.1, §3.2, §3.3, §3.4, §3.5, §1 (pipeline cmd) |
| ⚪ | D7 | Full-text search — generated tsvector on chunks | §4.3 (chunks.fts_vector), §5.1 |
| ⚪ | E1 | Vector search — HNSW, pgvector cosine similarity | §5.1 (vector search), §4.3 (HNSW index) |
| ⚪ | E2 | Full-text search wrapper — BM25 queries | §5.1 (full-text search) |
| ⚪ | E3 | Graph traversal — recursive CTE, cycle detection | §5.1 (graph traversal SQL) |
| ⚪ | E4 | RRF fusion — configurable weights | §5.2 |
| ⚪ | E5 | LLM re-ranking — Gemini Flash | §5.2, §4.8 |
| ⚪ | E6 | Hybrid retrieval orchestrator — `mulder query` | §5 (full section), §1 (query cmd) |

**Also read for all M4 steps:** §2 (global step conventions), §5.3 (sparse graph degradation), §14 (design decisions — HNSW, 768-dim, dedup before corroboration)

**Testable: Full MVP end-to-end.** Ingest PDFs, process, query with natural language, ranked results. This is v1.0.

---

## M5: "Curated knowledge" — Taxonomy + Entity Management

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | F1 | Taxonomy bootstrap — `mulder taxonomy bootstrap` | §6.1, §1 (taxonomy cmd) |
| ⚪ | F2 | Taxonomy export/curate/merge | §6.3, §1 (taxonomy cmd) |
| ⚪ | F3 | Entity management CLI — list/show/merge/aliases | §1 (entity cmd) |
| ⚪ | F4 | Status overview — `mulder status` | §1 (status cmd) |
| ⚪ | F5 | Export commands — graph/stories/evidence | §1 (export cmd) |

**Also read for all M5 steps:** §6 (full taxonomy system), §5.3 (sparse graph degradation — bootstrap threshold)

**Testable:** Human-in-the-loop curation. Export to Neo4j/Gephi. Production entity management.

---

## M6: "Intelligence layer" — v2.0

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | G1 | v2.0 schema migrations (009-011) | §4.3 (grounding, evidence_chains, clusters tables) |
| ⚪ | G2 | Ground step — `mulder ground <entity-id>` | §2.5, §1 (ground cmd) |
| ⚪ | G3 | Contradiction resolution — `mulder analyze --contradictions` | §2.8 |
| ⚪ | G4 | Source reliability scoring — `mulder analyze --reliability` | §2.8, §5.3 |
| ⚪ | G5 | Evidence chains — `mulder analyze --evidence-chains` | §2.8, §4.3 (evidence_chains table) |
| ⚪ | G6 | Spatio-temporal clustering | §2.8, §4.3 (clusters table) |
| ⚪ | G7 | Analyze orchestrator — `mulder analyze --full` | §2.8, §1 (analyze cmd) |

**Also read for all M6 steps:** §2 (global step conventions), §4.8 (Vertex AI wrapper for Gemini calls)

**Testable:** Web-enriched entities, resolved contradictions, evidence chains, spatial clusters. Full v2.0 intelligence.

---

## M7: "API + workers" — Async Execution Layer

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | H1 | Job queue repository — enqueue/dequeue/reap | §4.3 (jobs table), §10.2, §10.3 |
| ⚪ | H2 | Worker loop — `mulder worker start/status/reap` | §10.3, §10.4, §10.5, §1 (worker cmd) |
| ⚪ | H3 | Hono server scaffold | §13 (apps/api/) |
| ⚪ | H4 | Pipeline API routes (async) | §10.2, §10.6 |
| ⚪ | H5 | Job status API | §10.6 |
| ⚪ | H6 | Search API routes (sync) | §10.6, §5 |
| ⚪ | H7 | Entity API routes (sync) | §10.6 |
| ⚪ | H8 | Evidence API routes (sync) | §10.6 |
| ⚪ | H9 | Middleware — auth, rate limiting, validation | §10.6 (rate limiting tiers) |

**Also read for all M7 steps:** §10 (full job queue section — especially §10.3 transaction discipline), §14 (design decisions — PostgreSQL queue, auto-commit dequeue, per-step job slicing)

**Testable:** HTTP API for everything. Workers process jobs asynchronously. Deployable to Cloud Run.

---

## M8: "Production-safe" — Operational Infrastructure

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | I1 | `mulder eval` CLI + reporter | §15, §1 (eval cmd) |
| ⚪ | I2 | Cost estimator — `--cost-estimate` flag | §16.2, §1 (ingest/pipeline/reprocess cmds) |
| ⚪ | I3 | Terraform budget alerts | §16.1 |
| ⚪ | I4 | Schema evolution / reprocessing — `mulder reprocess` | §3.5, §4.3 (source_steps table) |
| ⚪ | I5 | Dead letter queue — `mulder retry` | §10.5, §1 (retry cmd) |
| ⚪ | I6 | Devlog system — conventions established | §17 |

**Also read for all M8 steps:** §16 (full cost safety section)

**Testable:** Eval against golden set with CLI reporter. Cost gates before expensive operations. Selective reprocessing. DLQ recovery.

---

## M9: "Beyond PDFs" — Multi-Format Ingestion

Extend ingest + extract to handle images, text documents, Office files, spreadsheets, emails, and web URLs. Everything from segment onward is already format-agnostic (Markdown + entities). This milestone adds format-specific extractors that converge to the same intermediate representation, plus the pipeline branching needed to skip steps for pre-structured formats.

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | J1 | Source type discriminator — `source_type` column, JSONB `format_metadata`, magic-byte detection | §4.3 (sources table), §2.1 |
| ⚪ | J2 | Pipeline step skipping — orchestrator supports `skip_to` so pre-structured formats bypass segment | §3.1, §3.2 |
| ⚪ | J3 | Image ingestion — JPG, PNG, TIFF via Document AI / Gemini Vision | §2.1, §2.2 |
| ⚪ | J4 | Plain text ingestion — .txt, .md pass-through (no OCR, no segment) | §2.1 |
| ⚪ | J5 | DOCX ingestion — Office document extraction via `mammoth` / `docx-parser` | §2.1 |
| ⚪ | J6 | CSV/Excel ingestion — tabular data → Markdown tables, row-level entity hints | §2.1 |
| ⚪ | J7 | Email ingestion — .eml/.msg parsing, header metadata → entities (sender, recipient, date, thread) | §2.1 |
| ⚪ | J8 | URL ingestion — fetch + snapshot to GCS, Readability extraction → Markdown | §2.1 |
| ⚪ | J9 | URL rendering — Playwright fallback for JS-rendered pages | §2.1 |
| ⚪ | J10 | URL lifecycle — `robots.txt` respect, rate limiting, freshness tracking, re-fetch support | §2.1 |
| ⚪ | J11 | Format-aware extract routing — dispatch to correct extractor by `source_type` | §2.2 |
| ⚪ | J12 | Cross-format dedup — early dedup at ingest (title/hash matching) before graph-level MinHash | §2.7 |
| ⚪ | J13 | Golden tests: multi-format — one fixture per format, Vitest assertions | §15.1, §15.2 |

**Also read for all M9 steps:** §2 (global step conventions), §3 (pipeline orchestration — step skipping), §4.5 (service abstraction — format extractors follow same interface pattern)

**Design notes:**

*Data model:*
- `sources.source_type` enum: `pdf | image | text | docx | spreadsheet | email | url`
- `sources.format_metadata` JSONB replaces PDF-specific columns — each format stores what it needs (e.g., URL: `original_url`, `fetch_date`, `http_status`; image: `dimensions`, `exif`; email: `from`, `to`, `subject`, `thread_id`)
- Format detection uses magic bytes first, file extension as fallback — never trust extension alone

*Pipeline branching:*
- Pre-structured formats (text, DOCX, spreadsheet, email, URL) skip the segment step — extract produces stories directly
- The `sources.status` state machine needs a `skip_to` mechanism: `ingested → extracted → enriched` (bypassing `segmented`)
- Orchestrator checks `source_type` to determine which steps apply

*Format-specific concerns:*
- **Images** — Single-page PDF path essentially. Same Document AI / Gemini Vision pipeline, simpler
- **CSV/Excel** — Each sheet becomes a story. Rows with entity-like data (names, dates, locations) get extraction hints passed to enrich. Large spreadsheets chunked by row groups
- **Email** — Header metadata (sender, recipient, date, subject) maps directly to entities and temporal edges. Thread ID enables conversation grouping. Attachments recursively ingested as their own sources with `parent_source_id`
- **URLs** — Fundamentally different from files: mutable, may disappear. Snapshotted to GCS at ingest time for immutability. Re-fetch tracked via `format_metadata.last_fetched` / `format_metadata.etag`. No link-following (that's crawling, out of scope). Rate limiting and `robots.txt` respect mandatory
- **Cross-format dedup** — Same report may exist as PDF + DOCX + web page. Early detection at ingest via content hash / title similarity before expensive pipeline processing. Graph-level MinHash still catches what early dedup misses

**Testable:** Ingest an image, a .txt file, a DOCX, a CSV, an .eml, and a URL. All six produce stories and entities identical in structure to PDF-sourced ones. Full pipeline works end-to-end regardless of input format. Cross-format dedup correctly links a PDF and its DOCX equivalent.

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
             ├→ M8 Operations
             └→ M9 Multi-Format Ingestion
```

M1-M4 is the critical path. Everything after M4 can be reordered based on user feedback.

## Key decisions baked into this order

1. **CLI-first, API later.** Debug pipeline logic synchronously before adding async job state.
2. **Golden tests before prompts.** Annotate expected outputs before writing Gemini prompts (B9, C10). Prevents silent regressions during prompt iteration.
3. **Dev cache early (B5).** LLM response cache in M2 saves hundreds of dollars during M3 prompt iteration.
4. **Defer job queue (M7).** `FOR UPDATE SKIP LOCKED` is tricky. Build it after pipeline functions are bulletproof.
5. **Eval CLI last, eval data first.** The `mulder eval` reporter is M8 polish. The golden test data and Vitest assertions are M2/M3 necessities.
6. **M4 is the pivot point.** If search results are bad, revisit extraction prompts (M3) before building APIs (M7).
7. **Multi-format after MVP.** The PDF pipeline validates the full architecture. Adding formats is additive — only ingest/extract change, everything downstream stays identical.
