---
spec: "96"
title: "Cross-Format Ingest Dedup"
roadmap_step: M9-J12
functional_spec: ["§2.7", "§2", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/256"
created: 2026-05-04
---

# Spec 96: Cross-Format Ingest Dedup

## 1. Objective

Complete M9-J12 by adding a conservative early duplicate check for sources that have different raw bytes but the same normalized ingest-time content signal. Exact `file_hash` dedup already catches byte-identical uploads; this step adds a second, format-aware candidate path for cases such as the same short report saved as `.txt` and `.md`, or other pre-structured formats where Mulder can compute a deterministic normalized content hash cheaply during ingest.

The goal is to avoid unnecessary downstream extraction, enrichment, embedding, and graph work when the duplicate is obvious at ingest time. This must not replace graph-level MinHash from functional spec §2.7; graph dedup remains responsible for near duplicates, reprints, summaries, and evidence/corroboration semantics after stories and chunks exist.

## 2. Boundaries

**Roadmap step:** M9-J12 - Cross-format dedup: early dedup at ingest (title/hash matching) before graph-level MinHash.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target branch:** `feat/256-cross-format-ingest-dedup`.

**Target files:**

- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/database/repositories/source.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/pipeline/src/ingest/cross-format-dedup.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/index.ts`
- `tests/specs/96_cross_format_ingest_dedup.test.ts`
- Existing M9 regression tests as needed
- `docs/roadmap.md`

**In scope:**

- Keep exact raw `file_hash` dedup as the first and strongest check.
- Compute deterministic cross-format dedup metadata where ingest already has cheap textual content or structured rows available.
- Store dedup metadata in `sources.format_metadata` so no new migration is required.
- Add a repository lookup that can find an existing source by the stored cross-format dedup key.
- Use the cross-format lookup before upload/source creation when a new source has a strong key.
- Return the existing source in the normal duplicate result shape when a cross-format duplicate is found.
- Make the algorithm conservative: no title-only collapse, no fuzzy thresholds, no LLM, and no paid-service calls added only for dedup.
- Preserve URL lifecycle behavior and graph-level MinHash behavior unchanged.

**Out of scope:**

- Semantic similarity, MinHash, SimHash, or embedding-based ingest-time dedup.
- Cross-source merge records or duplicate-edge creation at ingest time.
- Rewriting Graph dedup/corroboration logic.
- Retrospective backfill of dedup metadata for old sources.
- Blocking ingestion on ambiguous candidate matches.

## 3. Dependencies

- M9-J1 / Spec 85: first-class `source_type` and `format_metadata`.
- M9-J4 through M9-J10: format-specific ingest paths.
- M9-J11 / Spec 95: predictable extract routing after ingest.

This spec blocks M9-J13 because the golden multi-format test should be able to assert that obvious cross-format duplicates do not inflate the source set.

## 4. Blueprint

1. Add `packages/pipeline/src/ingest/cross-format-dedup.ts` with pure helpers for:
   - normalizing text-like content
   - deriving a stable SHA-256 content key
   - deriving a normalized title key when a title-like field exists
   - adding metadata keys only when the content signal is strong enough
2. Add repository support for finding a source by `format_metadata->>'cross_format_dedup_key'`.
3. Wire file ingest after prepared metadata creation and before upload/source creation:
   - exact `file_hash` duplicate check remains first
   - cross-format dedup runs only when metadata contains a strong key
   - duplicate return shape stays compatible with existing ingest output
4. Apply dedup metadata to cheap pre-structured paths:
   - text/markdown from decoded text
   - CSV/spreadsheet from parsed tabular rows when available
   - email from parsed subject/body when available
   - URL from the selected snapshot/readability title when available
   - leave image/PDF/DOCX without a key unless a cheap textual signal already exists
5. Export only pure helpers needed for black-box/public contract tests.
6. Add tests for exact-hash preservation, text-vs-markdown cross-format dedup, title-only non-dedup, and M9 regression coverage.

No database migration or config change is required.

## 5. QA Contract

1. **QA-01: Existing exact file-hash dedup still wins**
   - Given: the same source file is ingested twice
   - When: the second ingest runs
   - Then: it reports duplicate behavior and only one source row exists for the raw `file_hash`.

2. **QA-02: Cross-format text duplicate is detected before second source creation**
   - Given: a plain text file and a Markdown file contain the same normalized report body but have different raw bytes
   - When: both files are ingested
   - Then: the second ingest reports duplicate behavior, returns the existing source id, and does not create a second source row.

3. **QA-03: Dedup metadata is durable and deterministic**
   - Given: an ingested source with a strong cross-format signal
   - When: `sources.format_metadata` is queried
   - Then: it contains `cross_format_dedup_key`, `cross_format_dedup_basis`, and, when available, `cross_format_title_key`.

4. **QA-04: Title-only matches do not collapse unrelated sources**
   - Given: two sources have the same title or filename but different normalized bodies
   - When: both are ingested
   - Then: both source rows are created and neither is reported as a duplicate by cross-format dedup.

5. **QA-05: Weak or unavailable signals preserve normal ingest**
   - Given: a source type without a strong ingest-time content key
   - When: ingest runs
   - Then: Mulder falls back to existing raw hash behavior and does not reject or guess.

6. **QA-06: Graph-level dedup remains unchanged**
   - Given: the graph dedup module and existing graph tests
   - When: the targeted graph/dedup tests are run
   - Then: existing MinHash duplicate behavior remains green.

7. **QA-07: M9 ingest/extract regressions remain green**
   - Given: the existing M9 format tests
   - When: the relevant M9 regression suite is run
   - Then: all previously green behavior remains green.

## 5b. CLI Test Matrix

This step does not add a new command, but it changes `mulder ingest` duplicate behavior.

| Command | Expected |
| --- | --- |
| `mulder ingest same.txt` twice | exact hash duplicate, one source row |
| `mulder ingest report.txt` then `mulder ingest report.md` with same normalized body | duplicate, one source row |
| `mulder ingest same-title-a.txt` then `mulder ingest same-title-b.txt` with different bodies | both sources created |

## 6. Cost Considerations

No new paid service calls are allowed for dedup. The implementation may reuse data already parsed during ingest, but it must not call Document AI, Gemini, embeddings, Playwright, or graph analysis solely to decide an ingest duplicate.
