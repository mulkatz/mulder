---
spec: 20
title: Fixture Generator
roadmap_step: M2-B8
functional_spec: ["§11", "§9.1"]
scope: single
created: 2026-04-02
issue: https://github.com/mulkatz/mulder/issues/40
---

# Spec 20 — Fixture Generator

## 1. Objective

Implement `mulder fixtures generate` — a CLI command that runs real GCP services against test PDFs and captures API responses as committed fixtures. These fixtures serve both dev mode (zero-cost iteration) and tests (real response structures).

The command processes PDFs from `fixtures/raw/`, runs available pipeline steps using real GCP services (never dev mode), and writes captured artifacts to the appropriate `fixtures/` subdirectories. It also updates the API version tracking table in `fixtures/README.md`.

## 2. Boundaries

### In scope
- CLI command `mulder fixtures generate` with options for input/output paths and step filtering
- `mulder fixtures status` subcommand showing what fixtures exist and their staleness
- GCP-mode enforcement (always uses real services, ignoring `dev_mode` config)
- Incremental generation (skip sources with existing fixtures unless `--force`)
- Capture of extract step outputs (Document AI layout JSON + page images)
- API version metadata tracking in `fixtures/README.md`

### Out of scope
- Segment, enrich, embed, ground, or analyze fixture generation (those pipeline steps don't exist yet — they'll extend this command when implemented)
- Generating synthetic/fake fixtures
- Running fixtures against a database (fixture generation is file-only, no PostgreSQL)
- Cost estimation (the command runs real GCP calls — user accepts cost)

### Assumptions
- GCP credentials are configured (`GOOGLE_APPLICATION_CREDENTIALS` or ADC)
- Test PDFs exist in `fixtures/raw/`
- The user has a Document AI processor configured in `mulder.config.yaml`

## 3. Dependencies

### Requires
- M2-B1: GCP service implementations (`services.gcp.ts`) — for real Document AI calls
- M2-B7: Extract step — for Document AI + page image extraction logic
- M1-A5: CLI scaffold — for command registration

### Required by
- M2-B9: Golden test set — needs real fixtures to validate against
- M3-C2: Segment step — will extend this command to capture segmentation outputs
- M3-C8: Enrich step — will extend for entity extraction outputs

## 4. Blueprint

### 4.1 Files

| File | Action | Purpose |
|------|--------|---------|
| `apps/cli/src/commands/fixtures.ts` | create | CLI command registration (`generate` + `status`) |
| `packages/pipeline/src/fixtures/index.ts` | create | Fixture generation orchestrator |
| `packages/pipeline/src/fixtures/types.ts` | create | Types for fixture generation |
| `packages/pipeline/src/fixtures/writers.ts` | create | Artifact writers per pipeline step |

### 4.2 CLI Commands

#### `mulder fixtures generate`

```
mulder fixtures generate [options]

Options:
  --input <dir>     Source PDF directory (default: fixtures/raw)
  --output <dir>    Output fixtures directory (default: fixtures)
  --force           Regenerate all fixtures (ignore existing)
  --step <name>     Only run specific step (extract). More steps added as implemented.
  --verbose         Show detailed progress per file
```

**Behavior:**
1. Resolve input/output paths (default to `fixtures/raw` and `fixtures/`)
2. Scan input directory for PDF files
3. Force GCP service mode — create services with `createGcpServices()` directly, bypassing registry
4. For each PDF:
   a. Derive a source slug from filename (e.g., `scanned-sample.pdf` → `scanned-sample`)
   b. Check if fixtures already exist for this slug (skip unless `--force`)
   c. Run extract: call `DocumentAiService.processDocument()` with the PDF buffer
   d. Write layout JSON to `fixtures/extracted/{slug}/layout.json`
   e. Write page images to `fixtures/extracted/{slug}/pages/page-{NNN}.png`
5. Update `fixtures/README.md` API version tracking table with generation timestamp
6. Print summary: files processed, artifacts generated, skipped

**Error handling:**
- If a PDF fails Document AI processing, log the error, skip it, continue with remaining files
- Report all failures in the summary
- Exit with code 1 if any file failed, 0 if all succeeded

#### `mulder fixtures status`

```
mulder fixtures status
```

Shows a table of:
- Source PDFs in `fixtures/raw/`
- Which fixture types exist for each (extracted, segments, entities, embeddings, grounding)
- Last modified date of each fixture directory
- Whether the fixture is older than the source PDF (staleness indicator)

### 4.3 Fixture Generation Orchestrator

```typescript
// packages/pipeline/src/fixtures/types.ts
export interface FixtureGenerateInput {
  inputDir: string;
  outputDir: string;
  force: boolean;
  step?: string;
}

export interface FixtureGenerateResult {
  status: 'success' | 'partial' | 'failed';
  generated: FixtureArtifact[];
  skipped: string[];
  errors: FixtureError[];
}

export interface FixtureArtifact {
  sourceSlug: string;
  step: string;
  paths: string[];
}

export interface FixtureError {
  sourceSlug: string;
  step: string;
  message: string;
}
```

```typescript
// packages/pipeline/src/fixtures/index.ts
export async function generateFixtures(
  input: FixtureGenerateInput,
  services: Services,
  config: MulderConfig,
  logger: Logger,
): Promise<FixtureGenerateResult>;
```

The orchestrator:
1. Lists PDFs in `inputDir`
2. For each PDF, checks existing fixtures in `outputDir/extracted/{slug}/`
3. Calls the appropriate service method directly (not the full pipeline step — no database needed)
4. Delegates to step-specific writers to save artifacts

### 4.4 Artifact Writers

```typescript
// packages/pipeline/src/fixtures/writers.ts
export async function writeExtractFixtures(
  slug: string,
  result: DocumentAiResult,
  outputDir: string,
  logger: Logger,
): Promise<string[]>;
```

The extract writer:
1. Creates `{outputDir}/extracted/{slug}/` directory
2. Writes `layout.json` (pretty-printed JSON of `DocumentAiResult.document`)
3. Creates `pages/` subdirectory
4. Writes each page image as `page-{NNN}.png` (1-indexed, zero-padded to 3 digits)
5. Returns list of paths written

### 4.5 README Update

After generation, update the `fixtures/README.md` API version tracking table:
- Parse the existing markdown table
- Update the "Last Generated" column for affected rows
- Use ISO 8601 date format (`YYYY-MM-DD`)

### 4.6 Integration

- Export `generateFixtures` from `@mulder/pipeline` barrel
- Register `fixtures` command group in CLI entry point
- The command creates GCP services directly via `createGcpServices()` — it must bypass the dev-mode registry since fixture generation always needs real GCP

### 4.7 Phases

**Phase 1 (this spec):** Extract-only fixture generation
- Document AI layout JSON + page images

**Phase 2 (future specs):** As pipeline steps are implemented
- Segment: Gemini segmentation outputs
- Enrich: Entity extraction outputs
- Embed: Embedding vectors
- Ground: Web grounding results

Each future step extends `generateFixtures` and adds a new writer function.

## 5. QA Contract

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | CLI registration | CLI is built | `mulder fixtures --help` | Shows `generate` and `status` subcommands with descriptions |
| QA-02 | Generate with defaults | PDFs exist in `fixtures/raw/` | `mulder fixtures generate` (dev mode, no GCP) | Command starts, discovers PDF files, attempts processing (may fail without GCP credentials — the discovery and orchestration logic is verified) |
| QA-03 | Skip existing | Fixture already exists for a slug | `mulder fixtures generate` (without `--force`) | Slug is reported as skipped, no API call made for it |
| QA-04 | Force regenerate | Fixture already exists for a slug | `mulder fixtures generate --force` | Existing fixture is overwritten |
| QA-05 | Status display | Mix of fixtures present and missing | `mulder fixtures status` | Table shows all raw PDFs with fixture presence indicators per step |
| QA-06 | Step filter | Multiple steps could run | `mulder fixtures generate --step extract` | Only extract fixtures are generated |
| QA-07 | Slug derivation | PDF named `complex-magazine.pdf` | Fixture generation runs | Output lands in `extracted/complex-magazine/` |
| QA-08 | Writer creates correct structure | Document AI returns layout + 3 pages | Extract writer runs | Creates `layout.json` + `pages/page-001.png`, `page-002.png`, `page-003.png` |
| QA-09 | Partial failure handling | 2 PDFs, second fails | `mulder fixtures generate` | First PDF's fixtures are written, error reported for second, exit code 1 |
| QA-10 | Build succeeds | All code is implemented | `pnpm turbo run build` | Zero type errors |
