---
spec: 10
title: Fixture Directory Structure
roadmap_step: M1-A9
functional_spec: ["§11", "§9.1"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/20
created: 2026-03-30
---

# 10 — Fixture Directory Structure

## 1. Objective

Set up the `fixtures/` directory at the repo root with the complete directory structure specified in §11. Each subdirectory gets a `.gitkeep` placeholder and a typed placeholder file that documents the expected artifact format. A root `fixtures/README.md` documents API versions, field descriptions, and usage rules. This is the scaffold — actual GCP artifacts are generated later via `mulder fixtures generate` (M2-B8).

## 2. Boundaries

### In scope
- Create `fixtures/` directory tree: `raw/`, `extracted/`, `segments/`, `entities/`, `embeddings/`, `grounding/`
- Create `.gitkeep` files in each leaf directory to preserve structure in git
- Create typed placeholder JSON files that document expected schema shapes (one per subdirectory)
- Create `fixtures/README.md` documenting the fixture system, API versions, field descriptions, and usage rules

### Out of scope
- Actual GCP API responses (generated in M2-B8)
- Real test PDFs (added in M2-B8)
- Dev-mode service implementations that read from fixtures (M1-A10, M2-B1)
- `mulder fixtures generate` CLI command (M2-B8)
- Docker Compose setup (M1-A11)

## 3. Dependencies

### Requires
- M1-A1 (monorepo setup) — repo structure exists

### Enables
- M1-A10 (service abstraction) — dev service implementations will read from these paths
- M2-B1 (GCP + dev service implementations) — fixture-based dev services
- M2-B8 (fixture generator) — populates this structure with real artifacts
- All pipeline step tests — load fixtures from `fixtures/`

## 4. Blueprint

### 4.1 Directory structure

```
fixtures/
├── README.md
├── raw/
│   └── .gitkeep
├── extracted/
│   ├── .gitkeep
│   └── _schema.json         # Document AI Layout Parser output shape
├── segments/
│   ├── .gitkeep
│   └── _schema.json         # Segmentation output shape (Markdown + metadata)
├── entities/
│   ├── .gitkeep
│   └── _schema.json         # Entity extraction output shape
├── embeddings/
│   ├── .gitkeep
│   └── _schema.json         # Embedding output shape
└── grounding/
    ├── .gitkeep
    └── _schema.json          # Search Grounding output shape
```

### 4.2 Schema placeholder files

Each `_schema.json` file documents the expected artifact format for that pipeline step. These are documentation aids — not runtime schemas. They show the shape of real GCP API responses that will be stored as fixtures.

**`extracted/_schema.json`** — Document AI Layout Parser output:
```json
{
  "$schema": "fixture-schema",
  "description": "Document AI Layout Parser output — one directory per source document",
  "api": "Google Document AI Layout Parser",
  "api_version": "v1",
  "structure": {
    "{source-slug}/layout.json": "Full Document AI response with spatial data (bounding boxes, paragraphs, tables)",
    "{source-slug}/pages/page-{NNN}.png": "Rendered page images for Gemini Vision fallback"
  },
  "notes": "Spatial data preserved for segmentation step. NOT Markdown — raw structured JSON."
}
```

**`segments/_schema.json`** — Segmentation output:
```json
{
  "$schema": "fixture-schema",
  "description": "Gemini segmentation output — per-story Markdown + metadata",
  "api": "Vertex AI Gemini",
  "api_version": "v1",
  "structure": {
    "{source-slug}/{segment-id}.md": "Story content as Markdown (the end format per story)",
    "{source-slug}/{segment-id}.meta.json": "Segment metadata: page range, confidence, story type"
  },
  "notes": "Markdown is the end format per story. Metadata JSON has page boundaries and classification."
}
```

**`entities/_schema.json`** — Entity extraction output:
```json
{
  "$schema": "fixture-schema",
  "description": "Gemini entity extraction output — per-segment entity list",
  "api": "Vertex AI Gemini (structured output)",
  "api_version": "v1",
  "structure": {
    "{segment-id}.entities.json": "Array of extracted entities with types, attributes, and relationships"
  },
  "notes": "Schema generated dynamically from config via zod-to-json-schema. Entity types depend on domain ontology."
}
```

**`embeddings/_schema.json`** — Embedding output:
```json
{
  "$schema": "fixture-schema",
  "description": "text-embedding-004 output — per-segment chunk embeddings",
  "api": "Vertex AI text-embedding-004",
  "api_version": "v1",
  "structure": {
    "{segment-id}.embeddings.json": "Array of chunks with content, embedding vectors (768-dim), and metadata"
  },
  "notes": "768-dim via Matryoshka outputDimensionality parameter. Never truncate vectors manually."
}
```

**`grounding/_schema.json`** — Search Grounding output:
```json
{
  "$schema": "fixture-schema",
  "description": "Gemini Search Grounding output — web enrichment results",
  "api": "Vertex AI Gemini google_search_retrieval",
  "api_version": "v1",
  "structure": {
    "{entity-slug}.grounding.json": "Search grounding result with web sources, confidence, cached status"
  },
  "notes": "Three modes: pipeline, on_demand, disabled. Results cached with configurable TTL."
}
```

### 4.3 README content

`fixtures/README.md` covers:
1. Purpose — shared by dev mode + tests, never invent response structures
2. Directory layout with descriptions
3. API version tracking table (initially empty, populated in M2-B8)
4. Usage rules from §11.3 (6 rules)
5. Generation instructions (`mulder fixtures generate`)
6. Adding new fixture types

### 4.4 Files to create

| File | Purpose |
|------|---------|
| `fixtures/README.md` | Documentation hub for the fixture system |
| `fixtures/raw/.gitkeep` | Preserve directory for test PDFs |
| `fixtures/extracted/.gitkeep` | Preserve directory |
| `fixtures/extracted/_schema.json` | Document AI output shape |
| `fixtures/segments/.gitkeep` | Preserve directory |
| `fixtures/segments/_schema.json` | Segmentation output shape |
| `fixtures/entities/.gitkeep` | Preserve directory |
| `fixtures/entities/_schema.json` | Entity extraction output shape |
| `fixtures/embeddings/.gitkeep` | Preserve directory |
| `fixtures/embeddings/_schema.json` | Embedding output shape |
| `fixtures/grounding/.gitkeep` | Preserve directory |
| `fixtures/grounding/_schema.json` | Search Grounding output shape |

### 4.5 No code changes

This step is pure file creation — no TypeScript code, no config changes, no database migrations. Build and existing tests should not be affected.

## 5. QA Contract

### QA-01: Directory structure exists
- **Given** the repo is checked out
- **When** listing `fixtures/` recursively
- **Then** all 6 subdirectories exist: `raw/`, `extracted/`, `segments/`, `entities/`, `embeddings/`, `grounding/`

### QA-02: Git preserves empty directories
- **Given** a fresh `git clone`
- **When** listing the fixture directories
- **Then** all directories exist (via `.gitkeep` files)

### QA-03: Schema placeholders document expected formats
- **Given** the fixture structure
- **When** reading `_schema.json` in `extracted/`, `segments/`, `entities/`, `embeddings/`, `grounding/`
- **Then** each file is valid JSON with `description`, `api`, `structure` fields

### QA-04: README documents usage rules
- **Given** `fixtures/README.md`
- **When** reading its content
- **Then** it contains all 6 usage rules from §11.3

### QA-05: No regression — existing tests pass
- **Given** the fixture directory is added
- **When** running the full test suite
- **Then** all existing tests still pass

### QA-06: No regression — build succeeds
- **Given** the fixture directory is added
- **When** running `pnpm turbo run build`
- **Then** build completes without errors
