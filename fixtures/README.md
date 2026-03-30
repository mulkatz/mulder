# Test Fixtures

Real GCP API responses shared by **dev mode** and **unit tests**. Never invent response structures — always use these artifacts as the source of truth.

## Purpose

Document AI and Gemini have no local equivalent. Without pre-recorded real API responses, every iteration costs money and latency. This directory contains artifacts from a one-time GCP run against a small test corpus, consumed transparently by pipeline steps in dev mode and tests.

- **Dev mode** (`dev_mode: true` or `NODE_ENV=development`): fixture-based service implementations serve these artifacts instead of calling GCP
- **Tests** (`NODE_ENV=test`): test assertions validate against these real response structures
- **Production**: real GCP clients (fixtures are not used)

## Directory Layout

```
fixtures/
├── README.md                     # This file
├── raw/                          # Test PDFs (public domain or self-created)
│   ├── simple-layout.pdf
│   ├── complex-magazine.pdf
│   └── mixed-language.pdf
├── extracted/                    # Real Document AI Layout Parser outputs
│   ├── _schema.json              # Documents expected artifact shape
│   └── {source-slug}/
│       ├── layout.json           # Full Document AI response with spatial data
│       └── pages/
│           └── page-{NNN}.png    # Rendered page images for Gemini Vision fallback
├── segments/                     # Real Gemini segmentation outputs
│   ├── _schema.json
│   └── {source-slug}/
│       ├── {segment-id}.md       # Story content as Markdown
│       └── {segment-id}.meta.json # Segment metadata (page range, confidence, type)
├── entities/                     # Real Gemini entity extraction outputs
│   ├── _schema.json
│   └── {segment-id}.entities.json # Extracted entities with types and relationships
├── embeddings/                   # Real text-embedding-004 outputs
│   ├── _schema.json
│   └── {segment-id}.embeddings.json # Chunks with 768-dim embedding vectors
└── grounding/                    # Real Gemini Search Grounding outputs
    ├── _schema.json
    └── {entity-slug}.grounding.json # Web enrichment results with sources and confidence
```

Each subdirectory (except `raw/`) contains a `_schema.json` file that documents the expected artifact format for that pipeline step. These are documentation aids — not runtime schemas.

## API Version Tracking

| Directory | API | Version | Last Generated |
|-----------|-----|---------|----------------|
| `extracted/` | Google Document AI Layout Parser | v1 | — |
| `segments/` | Vertex AI Gemini | v1 | — |
| `entities/` | Vertex AI Gemini (structured output) | v1 | — |
| `embeddings/` | Vertex AI text-embedding-004 | v1 | — |
| `grounding/` | Vertex AI Gemini google_search_retrieval | v1 | — |

> **Note:** The "Last Generated" column is populated when fixtures are first generated via `mulder fixtures generate` (M2-B8).

## Usage Rules

1. **Pipeline step tests MUST load fixtures from `fixtures/`** — never invent response structures
2. **Fixtures are committed to the repo and version-controlled** — they are part of the codebase, not generated artifacts
3. **The README documents which API version produced each fixture** — see the API Version Tracking table above
4. **When an API response format changes, update the fixture AND the test** — stale fixtures cause false positives
5. **The `zod-to-json-schema` conversion in the Enrich step must be validated against the Gemini fixture** — if the generated schema does not match what Gemini actually accepts, the test fails
6. **`mulder fixtures generate` regenerates all fixtures from a real GCP run against test PDFs** — this is the canonical way to update fixtures

## Generating Fixtures

Fixtures are generated from a real GCP run:

```bash
npx mulder fixtures generate --input ./test-pdfs/ --output ./fixtures/
```

This command (implemented in M2-B8):

1. Runs each pipeline step against the test PDFs using real GCP services
2. Captures the raw API responses at each stage
3. Writes the artifacts to the appropriate subdirectory
4. Updates the API Version Tracking table in this README

Until `mulder fixtures generate` is implemented, the directories contain only `.gitkeep` placeholders and `_schema.json` documentation files.

## Adding New Fixture Types

When a new pipeline step or API integration is added:

1. Create a new subdirectory under `fixtures/` (e.g., `fixtures/new-step/`)
2. Add a `.gitkeep` file to preserve the directory in git
3. Add a `_schema.json` file documenting the expected artifact shape (follow the pattern in existing `_schema.json` files)
4. Update this README: add the directory to the layout diagram and the API Version Tracking table
5. Update `mulder fixtures generate` to capture the new artifact type
6. Update the dev-mode service implementation to serve fixtures from the new directory
