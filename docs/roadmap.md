# Mulder — Implementation Roadmap

Tracer bullet development path. Build the pipeline synchronously via CLI first (M1-M6), defer distributed infrastructure until the core works (M7-M8). Optimize for time to first usable product checkpoint (M4).

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
| 🟢 | A8 | Job queue + pipeline tracking migrations (012-014) | §4.3 (jobs, pipeline_runs), §4.3.1 |
| 🟢 | A9 | Fixture directory structure — placeholders in `fixtures/` | §11 |
| 🟢 | A10 | Service abstraction — interfaces, registry, rate-limiter, retry | §4.5, §7.3 |
| 🟢 | A11 | Docker Compose — pgvector + Firestore emulator | §9.3 |

**Also read for all M1 steps:** §13 (source layout), §14 (design decisions — monorepo, repositories, single PostgreSQL, CLI-first)

**Testable:** `mulder config validate` + `mulder db migrate` + `mulder db status`. Dev registry returns fixture services. No GCP account needed.

---

## M2: "PDFs go in" — Ingest + Extract

First GCP integration. First real cost (Document AI).

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | B1 | GCP + dev service implementations | §4.5, §4.6 |
| 🟢 | B2 | Source repository — CRUD for `sources` table | §4.3 (sources table), §2.1 |
| 🟢 | B3 | Native text detection — `pdf-parse`, `has_native_text` flag | §2.1 |
| 🟢 | B4 | Ingest step — `mulder ingest <path>` | §2.1, §4.3 (sources table), §1 (ingest cmd) |
| 🟢 | B5 | Vertex AI wrapper + dev cache | §4.8 |
| 🟢 | B6 | Prompt template engine — `renderPrompt()` | §4.7 |
| 🟢 | B7 | Extract step — output to GCS | §2.2, §4.4 |
| 🟢 | B8 | Fixture generator — `mulder fixtures generate` | §11, §9.1 |
| 🟢 | B9 | Golden test set: extraction — 5-10 annotated pages, Vitest assertions | §15.1, §15.2 |

**Also read for all M2 steps:** §2 (global step conventions), §4.5 (service abstraction), §7.3 (retry), §8 (logging), §11 (fixtures)

**Testable:** Feed PDFs, inspect OCR quality. Dev mode works against fixtures (zero cost). Golden test pages validate extraction.

---

## M3: "Stories and entities appear" — Segment + Enrich

Core intelligence. Where Mulder becomes more than an OCR tool.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | C1 | Story repository — CRUD with GCS URIs | §4.3 (stories table), §2.3 |
| 🟢 | C2 | Segment step — output Markdown + metadata to GCS | §2.3, §4.4 |
| 🟢 | C3 | Entity + alias repositories — CRUD | §4.3 (entities, entity_aliases, story_entities), §2.4 |
| 🟢 | C4 | Edge repository — CRUD for `entity_edges` | §4.3 (entity_edges), §2.4 |
| 🟢 | C5 | JSON Schema generator — `zod-to-json-schema` | §2.4, §14 (why zod-to-json-schema) |
| 🟢 | C6 | Taxonomy normalization — `pg_trgm` matching | §6.2, §2.4 |
| 🟢 | C7 | Cross-lingual entity resolution — 3-tier | §2.4 (resolution strategy), §4.8 (embedding calls) |
| 🟢 | C8 | Enrich step — `mulder enrich <id>` | §2.4, §6 (especially §6.2), §1 (enrich cmd) |
| 🟢 | C9 | Cascading reset function — PL/pgSQL | §4.3.1, §3.4 |
| 🟢 | C10 | Golden test set: segmentation + entities — Vitest assertions | §15.1, §15.2 |

**Also read for all M3 steps:** §2 (global step conventions), §4.5 (service abstraction), §6 (taxonomy system), §7.3 (retry), §8 (logging)

**Testable:** Full extraction pipeline through entities. `--force` re-runs work cleanly. Cross-lingual entity merging verified. Golden tests catch prompt regressions.

---

## QA Gate: Pre-Search Verification Checkpoint

**Not a feature milestone.** Quality gate verifying M1-M3 + D1-D3 (31 steps) are 100% spec-conformant before building search/retrieval on top. Deliverable is test code + triage document — no production code changes unless bugs are found.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | QA-1 | Schema conformance — DDL vs TypeScript types vs §4.3 | §4.3, §4.3.1, §6.2 |
| 🟢 | QA-2 | Status state machine — source + story transitions | §2.1–§2.4, §3.2, §3.4 |
| 🟢 | QA-3 | Cascading reset — all 5 reset paths end-to-end | §4.3.1, §3.4 |
| 🟢 | QA-4 | Cross-step pipeline integration — ingest→enrich→chunk round-trip | §2.1–§2.4, §2.6 |
| 🟢 | QA-5 | Error code coverage audit — defined vs thrown vs reserved | §7.1, §7.2 |
| 🟢 | QA-6 | Known issues triage + documentation | — |

**Also read for all QA steps:** §2 (global step conventions), §3 (pipeline composition), §4.3 (full schema), §7 (error handling)

**Gate criteria:** QA-1 through QA-5 tests pass. QA-6 produces triage document. No critical/high bugs remain. D4 begins only after gate passes.

---

## M4: "You can search" — v1.0 MVP

First version worth showing to anyone.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | D1-D3 | Embedding wrapper + semantic chunker + chunk repo | §2.6, §4.3 (chunks table) |
| 🟢 | D4 | Embed step — `mulder embed <id>` | §2.6, §1 (embed cmd) |
| 🟢 | D5 | Graph step — dedup + corroboration + contradiction flagging | §2.7, §1 (graph cmd) |
| 🟢 | D6 | Pipeline orchestrator — cursor-based | §3.1, §3.2, §3.3, §3.4, §3.5, §1 (pipeline cmd) |
| 🟢 | D7 | Full-text search — generated tsvector on chunks | §4.3 (chunks.fts_vector), §5.1 |
| 🟢 | E1 | Vector search — HNSW, pgvector cosine similarity | §5.1 (vector search), §4.3 (HNSW index) |
| 🟢 | E2 | Full-text search wrapper — BM25 queries | §5.1 (full-text search) |
| 🟢 | E3 | Graph traversal — recursive CTE, cycle detection | §5.1 (graph traversal SQL) |
| 🟢 | E4 | RRF fusion — configurable weights | §5.2 |
| 🟢 | E5 | LLM re-ranking — Gemini Flash | §5.2, §4.8 |
| 🟢 | E6 | Hybrid retrieval orchestrator — `mulder query` | §5 (full section), §1 (query cmd) |

**Also read for all M4 steps:** §2 (global step conventions), §5.3 (sparse graph degradation), §14 (design decisions — HNSW, 768-dim, dedup before corroboration)

**Testable: Full MVP end-to-end.** Ingest PDFs, process, query with natural language, ranked results. This is v1.0.

---

## QA Gate: Post-MVP Verification Checkpoint

**Not a feature milestone.** Exhaustive quality assessment of the M1–M4 MVP (48 roadmap steps) across six phases: baseline, milestone reviews M3 + M4, test gap closure, real-GCP smoketest, quality evaluation, documentation audit. Deliverable is a set of review documents (`docs/reviews/post-mvp-*.md`) + a triage report with 47 findings classified and prioritized. No production code changes were made during the gate — all findings are parked for a post-gate fix PR. See [`docs/reviews/post-mvp-qa-triage.md`](./reviews/post-mvp-qa-triage.md) for the gate verdict.

| Status | Step | What | Deliverable |
|--------|------|------|-------------|
| 🟢 | QA-P1 | Baseline & coverage audit — build/typecheck/lint/test + 48-step coverage matrix | `post-mvp-baseline.md`, `post-mvp-coverage-matrix.md` |
| 🟢 | QA-P2 | Milestone reviews M3 + M4 — spec conformance, cross-cutting conventions, CLAUDE.md consistency | `m3-review.md`, `m4-review.md` |
| 🟢 | QA-P3 | Test gap closure — golden retrieval set + runner + E2E pipeline test + CLI smoke tests | `eval/golden/retrieval/`, `packages/eval/src/retrieval-{metrics,runner}.ts`, `tests/specs/43/44/45.test.ts` |
| 🟢 | QA-P4 | GCP smoketest — Frontiers of Science PDF through full pipeline on `mulder-platform`, 15 queries, cost ≪ €3 cap | `post-mvp-gcp-smoketest.md` |
| 🟢 | QA-P5 | Quality evaluation — extraction/segmentation/entity evals vs baseline; zero regression | `post-mvp-phase5-eval.md` |
| 🟢 | QA-P6 | Documentation audit — README, CLAUDE.md, roadmap, config example, CLI help, error messages, devlog | `post-mvp-docs-audit.md` |
| 🟢 | QA-P7 | Triage & gate verdict — 47 findings aggregated, classified, prioritized; gate verdict | `post-mvp-qa-triage.md` |

**Gate criteria:** Zero P0 findings, all exit criteria met, triage document complete.
**Verdict:** PASS_WITH_FINDINGS. 0 Critical, 18 Warning, 26 Note across the gate. 11 P1 findings flagged for a post-gate fix PR. **M5 may begin.**

---

## M5: "Curated knowledge" — Taxonomy + Entity Management

Human-in-the-loop taxonomy curation. Entity management for production use.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | F1 | Taxonomy bootstrap — `mulder taxonomy bootstrap` | §6.1, §1 (taxonomy cmd) |
| 🟢 | F2 | Taxonomy export/curate/merge | §6.3, §1 (taxonomy cmd) |
| 🟢 | F3 | Entity management CLI — list/show/merge/aliases | §1 (entity cmd) |
| 🟢 | F4 | Status overview — `mulder status` | §1 (status cmd) |
| 🟢 | F5 | Export commands — graph/stories/evidence | §1 (export cmd) |

**Also read for all M5 steps:** §6 (full taxonomy system), §5.3 (sparse graph degradation — bootstrap threshold)

**Testable:** Human-in-the-loop curation. Export to Neo4j/Gephi. Production entity management.

---

## M6: "Intelligence layer" — v2.0

Web grounding, contradiction resolution, evidence chains, spatial clustering. The analytical brain.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | G1 | v2.0 schema migrations (009-011) | §4.3 (grounding, evidence_chains, clusters tables) |
| 🟢 | G2 | Ground step — `mulder ground <entity-id>` | §2.5, §1 (ground cmd) |
| 🟢 | G3 | Contradiction resolution — `mulder analyze --contradictions` | §2.8 |
| 🟢 | G4 | Source reliability scoring — `mulder analyze --reliability` | §2.8, §5.3 |
| 🟢 | G5 | Evidence chains — `mulder analyze --evidence-chains` | §2.8, §4.3 (evidence_chains table) |
| 🟢 | G6 | Spatio-temporal clustering | §2.8, §4.3 (clusters table) |
| 🟢 | G7 | Analyze orchestrator — `mulder analyze --full` | §2.8, §1 (analyze cmd) |

**Also read for all M6 steps:** §2 (global step conventions), §4.8 (Vertex AI wrapper for Gemini calls)

**Testable:** Web-enriched entities, resolved contradictions, evidence chains, spatial clusters. Full v2.0 intelligence.

---

## M7: "API + workers" — Async Execution Layer

Move from CLI to HTTP. Job queue, async workers, a full REST API over the pipeline, and the first web UI consuming it.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | H1 | Job queue repository — enqueue/dequeue/reap | §4.3 (jobs table), §10.2, §10.3 |
| 🟢 | H2 | Worker loop — `mulder worker start/status/reap` | §10.3, §10.4, §10.5, §1 (worker cmd) |
| 🟢 | H3 | Hono server scaffold — app, node-server, health endpoint | §13 (apps/api/) |
| 🟢 | H4 | Middleware — auth, rate limiting, error handling, request context | §10.6 (rate limiting tiers) |
| 🟢 | H5 | Pipeline API routes (async) | §10.2, §10.6 |
| 🟢 | H6 | Job status API | §10.6 |
| 🟢 | H7 | Search API routes (sync) | §10.6, §5 |
| 🟢 | H8 | Entity API routes (sync) | §10.6 |
| 🟢 | H9 | Evidence API routes (sync) | §10.6 |
| 🟢 | H10 | Document retrieval routes — list/pdf/markdown sync routes | §10.6 |
| 🟢 | H11 | Browser app shell consuming H10 routes | §13, consumes H10 |

**Also read for all M7 steps:** [`docs/api-architecture.md`](./api-architecture.md) (framework choice, route structure, middleware stack, OpenAPI strategy, key trade-offs), §10 (full job queue section — especially §10.3 transaction discipline), §14 (design decisions — PostgreSQL queue, auto-commit dequeue, per-step job slicing)

**Verification guidance for M7:** use package-local builds plus step- or milestone-scoped spec tests while iterating (`pnpm test:scope -- step M7-Hx` / `pnpm test:scope -- milestone M7`). For HTTP work, use `pnpm test:api:e2e` as the API-focused end-to-end lane for M7-H3 through M7-H10. Do not default to the full CI-equivalent suite for routine API milestone work.

**Testable:** HTTP API for everything. Workers process jobs asynchronously. Deployable to Cloud Run. First browser app shell consuming the real API.

**Note on H11 (Document Viewer):** Current browser app work lives in `apps/app` and should follow the app documents. An earlier off-roadmap attempt was reverted in commit 90bee3a (issue #127 closed) because the clean path requires a real HTTP API to sit on, not a dev-only Vite filesystem plugin that would have bypassed the service abstraction.

---

## M7.5: Browser App Track

Current browser app work is governed by `apps/app`, [`docs/app-design-strategy.md`](./app-design-strategy.md), [`docs/app-api-integration.md`](./app-api-integration.md), and [`docs/app-deployment.md`](./app-deployment.md).

Do not start new implementation from old visual language or checked-in static data. Public examples, if needed later, must be separate from the production app and must not point at a private production project.

**Current app verification:** `pnpm --filter @mulder/app dev`, `pnpm --filter @mulder/app build`, and browser checks against `apps/app`.

**Current target:** App acceptance is governed by the app strategy, API integration notes, and deployment runbook.

---

## M8: "Production-safe" — Operational Infrastructure

Eval framework, cost gates, schema evolution, dead letter recovery. Safe to run on real data at scale.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | I1 | `mulder eval` CLI + reporter | §15, §1 (eval cmd) |
| 🟢 | I2 | Cost estimator — `--cost-estimate` flag | §16.2, §1 (ingest/pipeline/reprocess cmds) |
| 🟢 | I3 | Terraform budget alerts | §16.1 |
| 🟢 | I4 | Schema evolution / reprocessing — `mulder reprocess` | §3.5, §4.3 (source_steps table) |
| 🟢 | I5 | Dead letter queue — `mulder retry` | §10.5, §1 (retry cmd) |
| 🟢 | I6 | Devlog system — conventions established | §17 |

**Also read for all M8 steps:** §16 (full cost safety section)

**Testable:** Eval against golden set with CLI reporter. Cost gates before expensive operations. Selective reprocessing. DLQ recovery.

---

## M9: "Beyond PDFs" — Multi-Format Ingestion

Images, Office docs, emails, URLs — every format converges to the same Markdown + entities. Only ingest/extract change; everything downstream stays identical.

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | J1 | Source type discriminator — `source_type` column, JSONB `format_metadata`, magic-byte detection | §4.3 (sources table), §2.1 |
| 🟢 | J2 | Pipeline step skipping — orchestrator supports `skip_to` so pre-structured formats bypass segment | §3.1, §3.2 |
| 🟢 | J3 | Image ingestion — JPG, PNG, TIFF via Document AI / Gemini Vision | §2.1, §2.2 |
| 🟢 | J4 | Plain text ingestion — .txt, .md pass-through (no OCR, no segment) | §2.1 |
| 🟢 | J5 | DOCX ingestion — Office document extraction via `mammoth` / `docx-parser` | §2.1 |
| 🟢 | J6 | CSV/Excel ingestion — tabular data → Markdown tables, row-level entity hints | §2.1 |
| 🟢 | J7 | Email ingestion — .eml/.msg parsing, header metadata → entities (sender, recipient, date, thread) | §2.1 |
| 🟢 | J8 | URL ingestion — fetch + snapshot to GCS, Readability extraction → Markdown | §2.1 |
| 🟢 | J9 | URL rendering — Playwright fallback for JS-rendered pages | §2.1 |
| 🟢 | J10 | URL lifecycle — `robots.txt` respect, rate limiting, freshness tracking, re-fetch support | §2.1 |
| 🟢 | J11 | Format-aware extract routing — dispatch to correct extractor by `source_type` | §2.2 |
| 🟢 | J12 | Cross-format dedup — early dedup at ingest (title/hash matching) before graph-level MinHash | §2.7 |
| 🟢 | J13 | Golden tests: multi-format — one fixture per format, Vitest assertions | §15.1, §15.2 |

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

## M10: "Provenance & Quality" — Pre-Archive Foundations

Must complete before first real archive data ingest. Without these foundations, bulk imports create provenance gaps that are extremely expensive to backfill. Spec references point to [`functional-spec-addendum.md`](./functional-spec-addendum.md).

| Status | Step | What | Spec |
|--------|------|------|------|
| 🟢 | K1 | Content-addressed storage — GCS layout migration, SHA-256 dedup | §A2 |
| 🟢 | K2 | Provenance tracking — `source_document_ids` on all artifacts | §A6.1 |
| 🟢 | K3 | Document quality assessment step | §A4 |
| 🟢 | K4 | Assertion classification in Enrich step | §A3 |
| 🟢 | K5 | Sensitivity level tagging + auto-detection | §A5 |
| ⚪ | K6 | Source rollback — soft-delete + cascading purge | §A6 |
| ⚪ | K7 | Ingest provenance data model — AcquisitionContext, ArchiveLocation, Archive, CustodyChain | §A2.3 |
| ⚪ | K8 | Collection management — create, tag, defaults | §A2.3 |
| ⚪ | K9 | Golden tests — quality routing + assertion classification | §A3, §A4 |

**Also read for all M10 steps:** §A1 (architecture principle), §A2 (storage design)

**Testable:** Ingest documents with provenance metadata. Quality assessment routes documents to correct extraction path. Assertions are classified. Sensitivity detection flags PII. Soft-delete hides sources, purge removes downstream artifacts.

---

## M11: "Trust Layer" — Credibility, Contradictions, Review

Builds the trust infrastructure. Depends on M10 foundations (provenance, assertions, sensitivity).

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | L1 | Credibility profile data model + LLM auto-generation | §A8 |
| ⚪ | L2 | Contradiction management — ConflictNode entities, severity, resolution | §A9 |
| ⚪ | L3 | Review workflow infrastructure — ReviewableArtifact, queues, events | §A13 |
| ⚪ | L4 | Translation service — two paths, caching | §A7 |
| ⚪ | L5 | RBAC implementation — roles, permissions, sensitivity-based filtering | §A5.3 |

**Also read for all M11 steps:** §A3 (assertion types), §A5 (sensitivity)

**Testable:** Credibility profiles auto-generated on ingest. Contradictions detected and modeled as graph entities. Review queues populated. Documents translatable. Role-based access filtering works.

---

## M12: "Discovery" — Patterns & Similarity

Analysis features that generate research value from the combined data. Depends on M11.

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | N1 | Similar case discovery — multi-dimensional scoring, auto-discovery | §A10 |
| ⚪ | N2 | Classification harmonization — cross-taxonomy mappings | §A11 |
| ⚪ | N3 | Temporal pattern detection — anomaly detection, hotspot clustering | §A12 |
| ⚪ | N4 | External data source plugin interface + correlation analysis | §A12 |

**Also read for all M12 steps:** §A11 (taxonomy mappings), §D1 Rules 4 + 6

**Testable:** Similar entities found across dimensions. Cross-taxonomy mappings enable cross-system queries. Temporal anomalies detected. External correlations computed with caveats.

---

## M13: "Observability & Exchange" — Versioning, Export, Import

Graph audit trail and data interchange. Depends on M11, M10.

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | P1 | Graph change event log | §A14 |
| ⚪ | P2 | Graph snapshots + diff queries | §A14 |
| ⚪ | P3 | Export framework — formats, sensitivity filtering, audit | §A15 |
| ⚪ | P4 | Import adapter framework — field mapping, dry run, post-import report | §A15 |
| ⚪ | P5 | Stable ID architecture — external ID mapping | §A15 |

**Also read for all M13 steps:** §A5 (sensitivity in export), §A4 (quality for imports)

**Testable:** Graph changes logged. Exports in multiple formats. Imports through full pipeline. External IDs mapped.

---

## M14: "Research Agent" — Autonomous Analysis

The agent system. Depends on all prior milestones.

| Status | Step | What | Spec |
|--------|------|------|------|
| ⚪ | Q1 | Research journal — data model, session briefing | §A16.4 |
| ⚪ | Q2 | Agentic research loop — tool interface, LLM orchestration | §A16.2 |
| ⚪ | Q3 | Exploration scheduler — heuristic + stochastic | §A16.3 |
| ⚪ | Q4 | Source integration strategy — equal treatment, hypothesis testing | §A16.5 |
| ⚪ | Q5 | External web research — Gemini grounding, evidence tiers | §A16.6 |
| ⚪ | Q6 | Report generator — 4 report types, multi-format | §A16.7 |
| ⚪ | Q7 | Agent safety controls — cost cap, iteration limit | §A16.8 |
| ⚪ | Q8 | Agent golden tests + eval | §A16.9 |

**Also read for all M14 steps:** §A5 (query gate), §A8 (credibility), §A3 (assertions)

**Testable:** Agent explores graph autonomously. Findings persisted in journal. Web research respects sensitivity gate. Reports generated. Cost cap enforced.

---

## Critical path

```
M1 Foundation
 └→ M2 Ingest+Extract (+golden extraction tests)
     └→ M3 Segment+Enrich (+golden entity tests)
         └→ QA Gate: Pre-Search (verification checkpoint)
             └→ M4 Search (v1.0 MVP) ← FIRST USABLE PRODUCT CHECKPOINT
                 └→ QA Gate: Post-MVP (verification checkpoint) ← we are here
                     ├→ M5 Curation
                     ├→ M6 Intelligence (v2.0)
                     ├→ M7 API+Workers
                    │   └→ App Track ← API-backed browser work
                     ├→ M8 Operations
                     ├→ M9 Multi-Format Ingestion
                     └→ M10 Provenance & Quality ← BEFORE FIRST REAL ARCHIVE INGEST
                         ├→ M11 Trust Layer
                         │   ├→ M12 Discovery
                         │   └→ M14 Research Agent (last)
                         └→ M13 Observability & Exchange
```

M1-M4 is the critical path to MVP. M10 is the critical path to production archive ingest. Everything after M4 can be reordered based on user feedback, except M10 must precede real data.

## Key decisions baked into this order

1. **CLI-first, API later.** Debug pipeline logic synchronously before adding async job state.
2. **Golden tests before prompts.** Annotate expected outputs before writing Gemini prompts (B9, C10). Prevents silent regressions during prompt iteration.
3. **Dev cache early (B5).** LLM response cache in M2 saves hundreds of dollars during M3 prompt iteration.
4. **Defer job queue (M7).** `FOR UPDATE SKIP LOCKED` is tricky. Build it after pipeline functions are bulletproof.
5. **Eval CLI last, eval data first.** The `mulder eval` reporter is M8 polish. The golden test data and Vitest assertions are M2/M3 necessities.
6. **M4 is the pivot point.** If search results are bad, revisit extraction prompts (M3) before building APIs (M7).
7. **Multi-format after MVP.** The PDF pipeline validates the full architecture. Adding formats is additive — only ingest/extract change, everything downstream stays identical.
8. **QA gate before search.** Verified M1-M3 foundation before building retrieval on top. Cross-step integration tests, schema audit, and cascade verification catch compounding errors early.
9. **Provenance before archive ingest (M10).** Content-addressed storage, assertion classification, sensitivity tagging, and quality assessment must all be in place before bulk archive data enters the system. Retrofitting is prohibitively expensive.
10. **Agent last (M14).** The research agent consumes everything — retrieval, credibility, contradictions, similarity, temporal patterns. It can only be built after the full data infrastructure is in place.
