---
milestone: M2
title: "PDFs go in" — Ingest + Extract
reviewed: 2026-04-02
steps_reviewed: [B1, B2, B3, B4, B5, B6, B7, B8, B9]
spec_sections: [§1, §1.1, §2, §2.1, §2.2, §4.3, §4.4, §4.5, §4.6, §4.7, §4.8, §7.3, §8, §9.1, §11, §15.1, §15.2]
verdict: PASS_WITH_WARNINGS
---

# Milestone Review: M2 — Ingest + Extract

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| Warning  | 7 |
| Note     | 6 |

**Verdict:** PASS_WITH_WARNINGS

M2 delivers a solid implementation of the ingest and extract pipeline with good architecture: clean service abstraction, concurrency-limited Vertex AI wrapper with dev cache, prompt template engine, fixture generator, and golden test set with CER/WER metrics. The one critical finding is a PDF bomb protection gap where `pdf-parse` decompresses the full PDF before page count validation. The warnings are mostly naming/path divergences from the spec that should be reconciled before M3 builds on these foundations.

---

## Per-Section Divergences

### §1 — CLI Command Tree

**[DIV-001] Ingest `--watch` flag not implemented**
- **Severity:** WARNING
- **Spec says:** `ingest <path>` has `--watch` flag: "Watch directory for new PDFs" (line 31)
- **Code does:** `apps/cli/src/commands/ingest.ts` registers `--dry-run`, `--tag`, `--cost-estimate` only (lines 40-42). No `--watch` option.
- **Evidence:** The `registerIngestCommands` function has no watch-related option or file watcher logic.

**[DIV-002] Cache command has extra `stats` subcommand**
- **Severity:** NOTE
- **Spec says:** `cache` has only `clear` subcommand (line 87)
- **Code does:** `apps/cli/src/commands/cache.ts` registers both `clear` and `stats` (lines 41-75)
- **Evidence:** Addition beyond spec, not a missing feature. Useful for debugging cache usage.

**[DIV-003] Fixtures command has extra subcommand and options**
- **Severity:** NOTE
- **Spec says:** `fixtures generate --input --output` (lines 130-132)
- **Code does:** `apps/cli/src/commands/fixtures.ts` adds `status` subcommand (line 124) and `--force`, `--step`, `--verbose` options (lines 46-48)
- **Evidence:** Additions beyond spec scope. All spec-required flags are present.

### §2 — Pipeline Steps — Functional Contracts

No divergences found. Both `IngestResult` and `ExtractResult` implement the `StepResult<T>` pattern with `status`, `data`, `errors`, and `metadata` fields matching the spec's interface (lines 200-212).

### §2.1 — Ingest

**[DIV-004] PDF bomb protection gap — uses pdf-parse instead of lightweight metadata check**
- **Severity:** CRITICAL
- **Spec says:** "Run lightweight metadata check via `pdfinfo` (poppler-utils) or equivalent BEFORE parsing content. Extract page count without decompressing the full PDF — this catches PDF bombs (decompression bombs that expand to gigabytes in memory)." (lines 231-232)
- **Code does:** `packages/pipeline/src/ingest/index.ts:133` reads the entire file into a Buffer, then at line 178 calls `detectNativeText(buffer)` which uses `pdf-parse` — a library that fully decompresses and parses the PDF content to extract text and page count.
- **Evidence:** The validation sequence is: read full file → magic bytes → file size → hash → **pdf-parse (full decompress)** → page count check. A malicious PDF that passes the 100MB raw size check but decompresses to gigabytes in memory would not be caught before `pdf-parse` processes it. The spec explicitly designed the `pdfinfo` check to prevent this.

**[DIV-005] Ingest validation order differs from spec**
- **Severity:** NOTE
- **Spec says:** Validation order: 1) file size, 2) pdfinfo page count, 3) magic bytes (lines 229-233)
- **Code does:** 1) magic bytes, 2) file size, 3) pdf-parse for page count (lines 135-188)
- **Evidence:** Magic bytes first is reasonable (cheapest check). The core issue is DIV-004 (no lightweight page count).

### §2.2 — Extract

No divergences found. The extract step correctly implements:
- Three extraction paths: native text (≥ threshold), Document AI, Gemini Vision fallback
- Circuit breaker for vision fallback (`max_vision_pages`)
- Output to GCS as `extracted/{doc-id}/layout.json` + `extracted/{doc-id}/pages/page-NNN.png`
- Source status update to `extracted`
- Firestore observability (fire-and-forget)
- `--force` cleanup logic
- `--fallback-only` mode

### §4.3 — Core Database Schema (sources table)

No divergences found for M2 scope. The `sources` table columns (`id`, `filename`, `storage_path`, `file_hash`, `page_count`, `has_native_text`, `native_text_ratio`, `status`, `tags`, `metadata`, `created_at`, `updated_at`) match the spec. `source_steps` table exists with correct structure. The `file_hash UNIQUE` constraint for dedup is correctly implemented.

### §4.4 — Storage Architecture

**[DIV-006] Raw PDF storage path diverges from spec**
- **Severity:** WARNING
- **Spec says:** Raw PDFs stored at `gs://mulder-{project}/raw/{doc-id}.pdf` (line 1150-1151)
- **Code does:** `packages/pipeline/src/ingest/index.ts:192` uses `sources/${sourceId}/original.pdf`
- **Evidence:** `const storagePath = \`sources/${sourceId}/original.pdf\`;` — different prefix (`sources/` vs `raw/`) and different filename pattern (`original.pdf` vs `{doc-id}.pdf`). The extracted output path `extracted/{doc-id}/` matches the spec correctly.

### §4.5 — Service Abstraction

No divergences found. Implementation matches spec:
- `services.ts` defines interfaces (`StorageService`, `DocumentAiService`, `LlmService`, `EmbeddingService`, `FirestoreService`)
- `registry.ts` implements `createServiceRegistry()` with correct mode detection logic
- `services.dev.ts` returns fixture-based implementations
- `services.gcp.ts` uses real GCP clients
- Pipeline steps depend only on interfaces, never concrete implementations

### §4.6 — GCP Clients (Connection Manager)

**[DIV-007] `getVertexAI()` renamed to `getGenAI()` with different SDK**
- **Severity:** WARNING
- **Spec says:** `getVertexAI(): VertexAI` (line 1232) — Vertex AI SDK singleton
- **Code does:** `packages/core/src/shared/gcp.ts:54` exports `getGenAI(project, location): GoogleGenAI` — uses `@google/genai` unified SDK instead of `@google-cloud/vertexai`
- **Evidence:** Different SDK choice (`@google/genai` vs `@google-cloud/vertexai`). The unified SDK is the newer approach, but the spec was written around the older SDK. Function signature also differs (takes parameters vs no parameters).

**[DIV-008] `getFirestore()` renamed to `getFirestoreClient()` with project parameter**
- **Severity:** NOTE
- **Spec says:** `getFirestore(): Firestore` (line 1233)
- **Code does:** `packages/core/src/shared/gcp.ts:65` exports `getFirestoreClient(project: string): Firestore`
- **Evidence:** Name change and added parameter. The project parameter is needed for Firestore initialization — the spec's parameterless version would need to read config internally.

**[DIV-009] Pool functions in database/client.ts instead of gcp.ts**
- **Severity:** WARNING
- **Spec says:** `getWorkerPool()` and `getQueryPool()` are listed under `gcp.ts` (lines 1237-1240)
- **Code does:** `packages/core/src/database/client.ts` contains `getWorkerPool()` and `getQueryPool()` (lines 28-29)
- **Evidence:** Architecturally sensible separation (PostgreSQL pools belong with database code, not GCP SDK clients), but diverges from the spec's explicitly documented layout of `gcp.ts`.

### §4.7 — Prompt Templates

**[DIV-010] Extra template file not listed in spec**
- **Severity:** NOTE
- **Spec says:** Templates: `segment.jinja2`, `extract-entities.jinja2`, `ground-entity.jinja2`, `resolve-contradiction.jinja2`, `generate-questions.jinja2`, `rerank.jinja2` (lines 1253-1258)
- **Code does:** All spec templates exist plus `vision-fallback.jinja2`
- **Evidence:** `packages/core/src/prompts/templates/vision-fallback.jinja2` is needed by the extract step's Gemini Vision fallback. This is a necessary addition. All spec-required templates are present. i18n files (`de.json`, `en.json`) also match.

### §4.8 — Vertex AI Wrapper + Dev Cache

**[DIV-011] `generateStructured` does not validate response with Zod**
- **Severity:** WARNING
- **Spec says:** "`generateStructured<T>(prompt, schema): T` — Gemini structured output with Zod validation of response" (line 1281)
- **Code does:** `packages/core/src/vertex.ts:171` does `JSON.parse(responseText)` and returns it directly. No Zod `parse()` or `safeParse()` call.
- **Evidence:** The JSON schema is sent to the Gemini API which enforces it server-side, but no client-side Zod validation occurs. If Gemini returns slightly non-conformant JSON (e.g., missing optional fields that should be required), it would pass through unvalidated.

**[DIV-012] `embed()` return type differs from spec**
- **Severity:** WARNING
- **Spec says:** `embed(texts: string[], dimensions?: number): number[][]` (line 1283)
- **Code does:** `embed(texts: string[], model: string, dimensions: number): Promise<EmbeddingResult[]>` where `EmbeddingResult = { text: string; vector: number[] }` (packages/core/src/vertex.ts:306, packages/core/src/shared/services.ts:133-137)
- **Evidence:** Return type wraps vectors with source text. Additional `model` parameter not in spec. This is an enhancement but changes the contract.

### §7.3 — Retry Strategy

**[DIV-013] maxAttempts semantics differ from spec's "max retries"**
- **Severity:** WARNING
- **Spec says:** "Max retries: 3" (line 1597) — implies 1 original + 3 retries = 4 total attempts
- **Code does:** `packages/core/src/shared/retry.ts:36` defaults to `maxAttempts: 3` — meaning 3 total attempts (1 original + 2 retries)
- **Evidence:** The spec says "Max retries: 3" but the code interprets this as "Max attempts: 3". One fewer retry than the spec intends.

**[DIV-014] Full jitter backoff instead of fixed delays**
- **Severity:** NOTE
- **Spec says:** "Base delay: 1s, multiplier: 2 (1s, 2s, 4s)" (line 1598)
- **Code does:** `packages/core/src/shared/retry.ts:56` calculates `Math.random() * min(base * multiplier^attempt, max)` — full jitter
- **Evidence:** Full jitter is actually better practice for preventing thundering herd effects. The spec lists fixed delays but mentions jitter conceptually elsewhere. The base delay and multiplier are correct.

### §8 — Logging

No divergences found. Implementation matches spec:
- Pino with structured JSON output
- ISO timestamps
- Custom error serializer for MulderError (preserves `code`, `context`, `cause` chain)
- Child loggers with bound context (`step`, `source_id`)
- Redaction of sensitive fields
- Pretty-print auto-detection for TTY/dev mode
- Logs to stderr, structured output to stdout

### §9.1 — Fixture-Based Dev Mode

No divergences found. Dev storage service correctly separates:
- Writes to `.local/storage/` (gitignored runtime data)
- Reads from `.local/storage/` first, falls back to `fixtures/` (checked-in test data)

Fixture generation via `mulder fixtures generate` is implemented with real GCP service calls.

### §11 — Test Fixtures

**[DIV-015] Fixture PDF names differ from spec examples**
- **Severity:** NOTE
- **Spec says:** `simple-layout.pdf`, `complex-magazine.pdf`, `mixed-language.pdf` (lines 1961-1963)
- **Code does:** `fixtures/raw/` contains `native-text-sample.pdf`, `scanned-sample.pdf`
- **Evidence:** Different naming convention and different test corpus. The extracted fixtures include more samples (5: mixed-language, multi-column, native-text, scanned, table-layout). The spec's examples are illustrative, not prescriptive.

**[DIV-016] Placeholder files are `_schema.json` instead of `.gitkeep`**
- **Severity:** NOTE
- **Spec says:** "Placeholder files (.gitkeep) for empty directories" (checklist)
- **Code does:** Empty fixture subdirectories (`segments/`, `entities/`, `embeddings/`, `grounding/`) contain `_schema.json` files
- **Evidence:** `_schema.json` serves the same purpose (keeps the directory tracked) while also providing schema documentation. Functionally equivalent.

### §15.1 — Golden Test Set

No major divergences. The golden test set exists at `eval/golden/extraction/` with 5 annotated pages covering different difficulty levels (simple, moderate, complex). The eval package provides `computeCER()`, `computeWER()`, and `runExtractionEval()`. Structure uses a subdirectory (`extraction/`) and different naming than the spec examples, but this is an organizational improvement.

### §15.2 — Metrics Per Step

No divergences for M2 scope. Extraction metrics (CER, WER) are implemented. Levenshtein distance computation is correct. Whitespace normalization is applied before comparison. Per-difficulty aggregation is supported.

---

## Cross-Cutting Convention Review

### Naming Conventions
All files follow conventions. Source files are `kebab-case.ts`, types are `PascalCase`, functions are `camelCase`, config keys are `snake_case`.

### TypeScript Strictness
- No `any` types found in `packages/` or `apps/` source files.
- No `console.log` found in any source file.
- No `throw new Error()` — all errors use custom error classes.
- `as` assertions found only in `packages/eval/src/eval-runner.ts` for parsing external JSON golden files — acceptable per the "external API responses" exception.
- ESM only: all `package.json` files have `"type": "module"`.

### Architecture Patterns
- **Service abstraction:** No files in `packages/pipeline/` or `apps/` import from `gcp.ts` directly. Only `services.gcp.ts` imports from `gcp.ts`. Correct.
- **Config via loader:** All CLI commands use `loadConfig()`. No direct YAML parsing.
- **Custom errors:** All throws use custom error classes (`IngestError`, `ExtractError`, `ExternalServiceError`, etc.).
- **Structured logging:** Pino throughout. No `console.log`.
- **Zod validation:** Config loader uses Zod. Pipeline step inputs don't validate with Zod (types are enforced at compile time).

### Package Structure
- Internal dependencies use `workspace:*` protocol. Correct.
- Barrel exports (`index.ts`) present in all packages. Correct.
- TypeScript project references configured in `tsconfig.json`. Correct.

### Test Coverage
- `tests/specs/16_ingest_step.test.ts` — black-box test for ingest step
- `tests/specs/19_extract_step.test.ts` — black-box test for extract step
- `tests/specs/20_fixture_generator.test.ts` — black-box test for fixture generator
- `tests/specs/21_golden_test_set_extraction.test.ts` — black-box test for golden test set
- All M2 steps have corresponding test files. Tests are black-box (no imports from source).

---

## CLAUDE.md Consistency

- **Storage Architecture:** CLAUDE.md states "raw/ — Original PDFs (immutable)" — now matches both spec and implementation after the storage path fix.
- All CLAUDE.md statements match the implementation: service abstraction pattern, fixture-based dev mode, dual connection pools, retry via shared `withRetry`, rate limiter, Pino logging.

---

## Post-Review Resolutions

The following divergences were resolved after the initial review:

| DIV | Resolution |
|-----|------------|
| DIV-006 | **Fixed in code:** Storage path changed from `sources/{id}/original.pdf` to `raw/{id}/original.pdf` to match spec §4.4 |
| DIV-007/008 | **Fixed in spec:** §4.6 updated to reflect `getGenAI()` and `getFirestoreClient()` naming |
| DIV-009 | **Fixed in spec:** §4.6 updated to show pool functions in `database/client.ts` |
| DIV-011 | **Fixed in code:** Added optional `responseValidator` to `StructuredGenerateOptions` for client-side validation |
| DIV-012 | **Fixed in spec:** §4.8 updated to reflect actual `embed()` signature and `EmbeddingResult` type |
| DIV-013 | **Fixed in spec:** §7.3 updated to "Max attempts: 3" with full jitter documentation |
| DIV-014 | **Fixed in spec:** §7.3 now documents the full jitter algorithm |
| DIV-004 | **Fixed in code (PR #45):** Added `pdf-lib` based metadata extractor that reads page count from document structure without decompressing page content. Ingest now gates page count check before `pdf-parse`. Tested against 10 diverse PDFs from 7 producers. Spec §2.1 updated. |

---

## Remaining Recommendations

### Should Fix (Warning)
1. **DIV-001:** Add `--watch` flag to ingest command (or explicitly defer to a later milestone and note in roadmap).

### For Consideration (Note)
3. **DIV-002/DIV-003:** Extra CLI subcommands (`cache stats`, `fixtures status`) are useful additions. Consider adding them to the spec for completeness.
4. **DIV-010:** `vision-fallback.jinja2` template should be added to spec §4.7 template list.
5. **DIV-015/DIV-016:** Fixture naming and placeholder approach are reasonable alternatives. No action needed unless standardization is desired.
