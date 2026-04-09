---
spec: 48
title: Layout-to-Markdown Converter
roadmap_step: "off-roadmap (demoability)"
functional_spec: "§2.2 (extract step), §4.5 (service abstraction)"
scope: single
issue: https://github.com/mulkatz/mulder/issues/125
created: 2026-04-09
---

# Spec 48: Layout-to-Markdown Converter

## 1. Objective

Convert Mulder's normalized `LayoutDocument` (produced by the Extract step) into a single human-readable, GitHub-Flavored Markdown document representing the whole source. Produced as a byproduct of every Extract run, cached in storage next to `layout.json`, and exposed via a new CLI flag that downloads it to a local file for preview.

This is the first feature that makes the pipeline's output directly consumable by a human. It enables a demoable "left: PDF / right: Markdown" view without a UI (users can open the downloaded `.md` in any editor), and it is the prerequisite for a future minimal viewer UI (to be specified separately). It is **not** a roadmap milestone step — it's a targeted, off-roadmap utility feature added between M4 and M5 to make the current pipeline state presentable.

**Why now:** The pipeline has been working end-to-end since M4, but its outputs live in GCS (JSON) and per-story Markdown fragments that only exist after the Segment step has run with Gemini. There is currently no way to extract a single PDF and **see what the tool got out of it** without running the full pipeline, paying for Gemini segmentation, and stitching together 8 per-story files. This spec closes that gap with one pure function, one storage write, and one CLI flag.

**Spec refs:** §2.2 (extract step contract — now gains a second output file), §4.5 (service abstraction — writes via `services.storage.upload()`, never direct GCS SDK).

## 2. Boundaries

### In scope

- New pure function `layoutToMarkdown(layout: LayoutDocument): string` in `packages/pipeline/src/extract/layout-to-markdown.ts`. Pure means: no I/O, no logger, no services, no mutation of input, no date-dependent output — same input always produces byte-identical output.
- Extract step writes `layout.md` alongside `layout.json` to `services.storage` on every successful run (both real GCP and dev-mode fixtures). The Markdown write is additive — it does not replace `layout.json`, and failures in the Markdown write must not fail the overall Extract result.
- CLI flag `mulder extract <source-id> --markdown-to <local-path>` that downloads the `layout.md` produced by that run and writes it to a local file path. Useful for demos and quick inspection.
- Running header/footer filtering via heuristic: blocks tagged `type: 'header'` or `type: 'footer'` are excluded from the Markdown output. (Cross-page repetition detection is handled by the Document AI parser, not this converter — see §2 Out of scope.)
- Heading rendering: blocks tagged `type: 'heading'` become `#` headings. For a first pass, all headings are level 1 (`#`). Rendering hierarchy from relative font size is a V2 concern.
- Table rendering: blocks tagged `type: 'table'` are parsed from their pipe-delimited `text` content into GitHub-Flavored Markdown tables (first row = header, `|---|` separator injected, rows padded). Tables that fail to parse fall back to a verbatim code block so no information is lost.
- Paragraph rendering: blocks tagged `type: 'paragraph'` are emitted as paragraphs with blank lines between them.
- Page boundaries: adjacent pages are separated by a `---` horizontal rule.
- Golden tests in `eval/golden/layout-markdown/` covering all five existing `fixtures/extracted/*/layout.json` inputs. Goldens are committed; the test diffs actual vs. golden.
- Idempotency: re-running Extract overwrites `layout.md` deterministically (same input → same bytes → same storage state).

### Out of scope (explicit, to prevent creep)

- **UI / Viewer / Web app** — a separate future spec will build a minimal Vite+React split-view consuming the `layout.md` produced here.
- **Document AI parser enrichment** — the current `parseDocumentAiResult` in `extract/index.ts` emits every block as `type: 'paragraph'`. Real Document AI extractions therefore produce flat, heading-free Markdown until a follow-up spec enriches the parser (heading detection via font size, table extraction via Document AI `tables[]`, header/footer detection via cross-page repetition). **This spec works against the existing fixture shape, which already uses the richer block types (`heading`, `table`, `header`, `footer`) as aspirational values.** See §7 Known Limitations.
- **Heading level hierarchy** — all headings render as level 1 (`#`). Multi-level detection (H1/H2/H3 by relative font size) is deferred.
- **List detection** — inline `- item` lines in paragraph text are passed through verbatim. Detecting and restructuring lists is deferred.
- **Footnote handling** — no special treatment. Passed through as paragraph text.
- **Image placement** — page images exist in storage at `extracted/{doc}/pages/page-NNN.png` but are NOT referenced from the Markdown. Image embedding is a future spec.
- **Modifications to the Segment step** — Segment continues to produce per-story Markdown independently. This spec's whole-document Markdown is a separate artifact.
- **`layoutToMarkdown` as a configurable function** — no config options, no feature flags. It is a pure function with one input and one output.
- **A one-shot `mulder preview <pdf>` command that ingests + extracts in memory without DB** — deferred. For now, users run `mulder ingest foo.pdf && mulder extract <id> --markdown-to foo.md`. Two commands, each fast, acceptable for demos.

### Interfaces affected

- **New file:** `packages/pipeline/src/extract/layout-to-markdown.ts` (pure function).
- **Modified:** `packages/pipeline/src/extract/index.ts` — after the existing `storage.upload(layoutUri, layoutJson)` call, add a sibling call `storage.upload('extracted/{id}/layout.md', markdown)`. Failure must not fail Extract.
- **Modified:** `packages/pipeline/src/extract/index.ts` barrel — export `layoutToMarkdown` from `@mulder/pipeline`.
- **Modified:** `apps/cli/src/commands/extract.ts` — add `--markdown-to <path>` option and post-extract download logic.
- **New fixtures:** `eval/golden/layout-markdown/{native-text,multi-column,table-layout,scanned,mixed-language}-sample.md` — one golden per existing input fixture.
- **New tests:** `tests/specs/48_layout_to_markdown.test.ts` — QA + CLI matrix + smoke.
- **No database changes.**
- **No config changes.**
- **No new dependencies.** String templating, no markdown library — hand-roll the emitter (it's small).

## 3. Dependencies

### Requires (must exist)

- `packages/pipeline/src/extract/types.ts` — `LayoutDocument`, `LayoutPage`, `LayoutBlock` types.
- `packages/pipeline/src/extract/index.ts` — existing Extract step with storage integration.
- `fixtures/extracted/*/layout.json` — five existing fixtures covering native text, multi-column, table layout, scanned (Document AI), mixed language.
- `@mulder/core` service abstraction (`services.storage.upload()`, `services.storage.download()`).
- `apps/cli` — Commander.js CLI scaffold with existing `extract` command.

### Required by (consumers)

- Future **Viewer UI** spec (next in the demoability sequence). Depends on `layout.md` being a stable, deterministic artifact in storage.
- Future **Document AI parser enrichment** spec — will enhance the inputs to this converter (richer block types for real GCP runs). Not a hard dependency in either direction; this spec ships first.

## 4. Blueprint

### 4.1 Files to create

#### `packages/pipeline/src/extract/layout-to-markdown.ts`

Pure function, no I/O, no dependencies on services or logger.

```typescript
import type { LayoutDocument, LayoutPage, LayoutBlock } from './types.js';

/**
 * Converts a normalized LayoutDocument into a GitHub-Flavored Markdown
 * representation of the whole source document.
 *
 * Deterministic and side-effect-free: same input always produces byte-identical
 * output. Safe to call in hot paths, safe to cache on content hash.
 *
 * @see docs/specs/48_layout_to_markdown.spec.md §4.3
 */
export function layoutToMarkdown(layout: LayoutDocument): string;
```

Emitter rules (§4.3 below has the full table):

- Walk `layout.pages` in order.
- Within each page, walk `page.blocks` in order.
- Skip blocks with `type === 'header'` or `type === 'footer'`.
- Skip blocks with empty/whitespace-only `text`.
- Render each block according to its `type` (see §4.3).
- Insert a single blank line between consecutive blocks.
- Insert `\n\n---\n\n` between pages (except before the first page).
- Trim trailing whitespace from the final output, ensure exactly one trailing newline.

#### `eval/golden/layout-markdown/native-text-sample.md`
#### `eval/golden/layout-markdown/multi-column-sample.md`
#### `eval/golden/layout-markdown/table-layout-sample.md`
#### `eval/golden/layout-markdown/scanned-sample.md`
#### `eval/golden/layout-markdown/mixed-language-sample.md`

One golden Markdown file per fixture. Hand-reviewed, committed, diffed in tests.

#### `tests/specs/48_layout_to_markdown.test.ts`

Black-box QA tests. Imports `layoutToMarkdown` from `@mulder/pipeline` (barrel), loads fixtures from `fixtures/extracted/`, diffs against goldens.

### 4.2 Files to modify

#### `packages/pipeline/src/extract/index.ts`

After the existing `layout.json` upload, add the Markdown write. The new code is roughly:

```typescript
// After: await services.storage.upload(layoutUri, JSON.stringify(layoutDoc, null, 2), 'application/json');

try {
    const markdown = layoutToMarkdown(layoutDoc);
    const markdownUri = `extracted/${input.sourceId}/layout.md`;
    await services.storage.upload(markdownUri, markdown, 'text/markdown');
    log.info({ markdownUri, bytes: markdown.length }, 'Layout Markdown written');
} catch (mdErr) {
    // Markdown write must never fail the Extract step.
    log.warn({ err: mdErr }, 'Layout Markdown write failed — extract still succeeded');
}
```

- Import `layoutToMarkdown` from `./layout-to-markdown.js`.
- Add export: `export { layoutToMarkdown } from './layout-to-markdown.js';` at the top of `index.ts`.

#### `packages/pipeline/src/index.ts` (barrel)

Export `layoutToMarkdown` so it's reachable as `import { layoutToMarkdown } from '@mulder/pipeline'`.

#### `apps/cli/src/commands/extract.ts`

Add the `--markdown-to <path>` option. Integration logic:

```typescript
.option('--markdown-to <path>', 'after extraction, download layout.md to this local path')

// In the action handler, after a successful extract:
if (options.markdownTo && result.data) {
    if (options.all) {
        printError('--markdown-to cannot be used with --all (ambiguous destination)');
        process.exit(1);
    }
    const markdownUri = `extracted/${sourceId}/layout.md`;
    const buffer = await services.storage.download(markdownUri);
    await fs.writeFile(options.markdownTo, buffer);
    printSuccess(`Markdown written to ${options.markdownTo}`);
}
```

- Validates that `--markdown-to` and `--all` are mutually exclusive (a single destination path can't receive N documents).
- Validates that the parent directory exists; emits a clear error otherwise.
- Uses `node:fs/promises` for the local write.

### 4.3 The converter contract (emitter rules)

| `block.type` | Markdown output |
|---|---|
| `'heading'` | `# {text}\n\n` (trimmed text; level 1 in V1) |
| `'paragraph'` | `{text}\n\n` (preserves internal newlines as paragraph breaks — split on `\n\n` and emit each as its own paragraph) |
| `'table'` | Parse `text` as pipe-delimited rows (split on `\n`, then on ` \| ` or `\|`). First row → header. Emit as GFM table with `\| --- \|` separator. If parsing fails (irregular column counts, < 2 rows, empty cells everywhere), fall back to a fenced code block: ` ```\n{text}\n``` ` |
| `'header'` | Skipped (filtered out). |
| `'footer'` | Skipped (filtered out). |
| `'caption'` | `_{text}_\n\n` (italic) |
| any other value or missing type | Treated as `'paragraph'` |

Empty or whitespace-only blocks are skipped regardless of type.

Between pages: `\n\n---\n\n` separator. Not emitted before the first page or after the last page.

### 4.4 Integration points

- **Extract step** — writes `layout.md` to `services.storage` via `upload()` after the existing `layout.json` upload.
- **Dev mode** — the dev storage service writes to `.local/storage/extracted/{id}/` and already works with the `upload()` interface. No changes needed; dev runs automatically produce `layout.md`.
- **Fixture generator (`mulder fixtures generate`)** — inherits automatically because it invokes the Extract step with the same service interface.
- **Service abstraction (§4.5)** — the converter is a pure function, does not touch services. The Extract step calls it, then uses the storage interface. Matches CLAUDE.md "Service Abstraction" rules.
- **CLI** — post-extract, downloads `layout.md` from `services.storage` and writes to a local path.

### 4.5 Implementation phases

Scope is single but small enough that a sensible commit order helps review:

**Phase 1: Pure converter + goldens**
- Files: `layout-to-markdown.ts`, all five files in `eval/golden/layout-markdown/`, `tests/specs/48_layout_to_markdown.test.ts` (QA-01 through QA-09).
- Deliverable: `layoutToMarkdown()` tested against goldens. No Extract step changes, no CLI changes. Standalone, testable in isolation.

**Phase 2: Extract step integration + idempotency**
- Files: `packages/pipeline/src/extract/index.ts`, `packages/pipeline/src/index.ts` (barrel).
- Adds the `layout.md` storage write after `layout.json`. Adds QA-10 (idempotency) and QA-11 (failure isolation).
- Deliverable: `mulder extract <id>` produces `layout.md` in storage.

**Phase 3: CLI `--markdown-to` flag**
- Files: `apps/cli/src/commands/extract.ts`.
- Adds the CLI option and post-extract download. Adds CLI-01 through CLI-06.
- Deliverable: `mulder extract <id> --markdown-to out.md` writes a local file.

Each phase is independently committable and must not break the build.

## 5. QA Contract

Each condition must be verifiable by a QA agent WITHOUT reading implementation code. Tests load fixtures from `fixtures/extracted/` and goldens from `eval/golden/layout-markdown/`, invoke the exported `layoutToMarkdown` function, run CLI commands via `execFileSync`, and inspect storage via the dev storage directory (`.local/storage/extracted/{id}/`).

### QA-01: Converter is a pure function
**Given** any `LayoutDocument` from `fixtures/extracted/`,
**When** `layoutToMarkdown(layout)` is called twice with the same input,
**Then** both calls return byte-identical strings and the input object is not mutated (deep equality on input before/after).

### QA-02: Heading blocks render as `#` headings
**Given** a `LayoutDocument` with a block of `type: 'heading'` and `text: "Test Heading"`,
**When** `layoutToMarkdown` is called,
**Then** the output contains `# Test Heading` on its own line, followed by a blank line.

### QA-03: Paragraph blocks render with paragraph breaks
**Given** a `LayoutDocument` with a block of `type: 'paragraph'` and `text: "First para.\n\nSecond para."`,
**When** `layoutToMarkdown` is called,
**Then** the output contains `First para.` and `Second para.` as separate paragraphs (separated by at least one blank line), and neither paragraph has leading or trailing whitespace on its content line.

### QA-04: Table blocks render as GitHub-Flavored Markdown tables
**Given** a `LayoutDocument` with a block of `type: 'table'` and pipe-delimited `text` (header row + 2+ data rows, consistent column count),
**When** `layoutToMarkdown` is called,
**Then** the output contains a valid GFM table: first row, `| --- | --- | ... |` separator, subsequent rows. The table parses correctly when rendered by a standard GFM parser (e.g. `marked` with `gfm: true`).

### QA-05: Malformed table falls back to a code block
**Given** a `LayoutDocument` with a block of `type: 'table'` and `text` that cannot be parsed as a table (e.g., inconsistent column counts, single row, empty content),
**When** `layoutToMarkdown` is called,
**Then** the output contains the original text inside a triple-backtick fenced code block. No data is lost.

### QA-06: Header and footer blocks are filtered out
**Given** a `LayoutDocument` with blocks of `type: 'header'` with text "Page 1" and `type: 'footer'` with text "Confidential",
**When** `layoutToMarkdown` is called,
**Then** the output contains neither "Page 1" nor "Confidential".

### QA-07: Page boundaries render as horizontal rules
**Given** a `LayoutDocument` with 2+ pages each containing at least one non-empty block,
**When** `layoutToMarkdown` is called,
**Then** consecutive pages are separated by `\n\n---\n\n`, and no `---` appears before the first page or after the last page.

### QA-08: Reading order is preserved
**Given** a `LayoutDocument` where `page.blocks` are in document reading order,
**When** `layoutToMarkdown` is called,
**Then** the text content of each block appears in the output in the same order as in the input.

### QA-09: Golden fixtures match
**Given** each of the five fixtures in `fixtures/extracted/*/layout.json`,
**When** `layoutToMarkdown` is called on each,
**Then** the output exactly matches the corresponding golden file in `eval/golden/layout-markdown/*.md` (byte-for-byte after trailing-newline normalization).

### QA-10: Extract step writes layout.md alongside layout.json
**Given** `dev_mode: true`, a valid ingested source with native text, and the dev storage directory `.local/storage/extracted/{id}/` is empty for this source,
**When** `mulder extract <id>` runs,
**Then** after the command exits 0, both `.local/storage/extracted/{id}/layout.json` and `.local/storage/extracted/{id}/layout.md` exist, and the `.md` file is non-empty valid UTF-8.

### QA-11: Markdown write failure does not fail the Extract step
**Given** an Extract run where the storage service would succeed on the `.json` upload but fail on the `.md` upload (simulated via a storage service stub that throws on `.md` uploads),
**When** `executeExtract` is called,
**Then** the result status is `'success'` (not `'failed'` or `'partial'`), `layout.json` was written, and a warning log entry records the Markdown failure. The overall pipeline is not blocked.

### QA-12: Extract idempotency preserves layout.md
**Given** a source already extracted once (both `layout.json` and `layout.md` exist in storage),
**When** `mulder extract <id> --force` is run,
**Then** after the command exits 0, both files still exist and `layout.md` has the same byte content as a fresh `layoutToMarkdown` call against the freshly written `layout.json` (converter is deterministic).

### QA-13: All five fixtures produce valid Markdown
**Given** each of the five fixtures in `fixtures/extracted/*/layout.json`,
**When** `layoutToMarkdown` is called on each,
**Then** the output is non-empty, contains no unresolved placeholders like `undefined` or `[object Object]`, and the entire output is valid UTF-8.

## 5b. CLI Test Matrix

### `mulder extract <source-id> [--markdown-to <path>]`

Given: dev_mode, PostgreSQL running, a source pre-ingested from `fixtures/raw/native-text-sample.pdf` yielding a known source ID (stored in a variable `SRC_ID`), and a temp directory for `--markdown-to` outputs.

| # | Args / Flags | Expected Behavior |
|---|-------------|-------------------|
| CLI-01 | `extract $SRC_ID` | Exit 0, `layout.md` exists in `.local/storage/extracted/$SRC_ID/`. No local `.md` file written (no `--markdown-to`). |
| CLI-02 | `extract $SRC_ID --markdown-to /tmp/qa-48/out.md` | Exit 0, `/tmp/qa-48/out.md` exists, content matches `.local/storage/extracted/$SRC_ID/layout.md` byte-for-byte. |
| CLI-03 | `extract $SRC_ID --force --markdown-to /tmp/qa-48/out2.md` | Exit 0, `/tmp/qa-48/out2.md` exists, same content as CLI-02's output (deterministic). |
| CLI-04 | `extract --all --markdown-to /tmp/qa-48/many.md` | Exit 1, stderr contains `"--markdown-to cannot be used with --all"` or equivalent. No file written at `/tmp/qa-48/many.md`. |
| CLI-05 | `extract $SRC_ID --markdown-to /nonexistent-parent-dir/out.md` | Exit 1, stderr mentions the parent directory or path error. Extract step still succeeded (storage has `layout.md`) but local write failed cleanly. |
| CLI-06 | `extract $SRC_ID --markdown-to /tmp/qa-48/idem.md` *(run twice)* | Both runs exit 0, second run produces byte-identical `/tmp/qa-48/idem.md` compared to first. |

Plus the existing CLI tests for `extract` from spec 19 must all still pass (no regressions).

## 6. Cost Considerations

**None — no paid API calls.** The converter is pure TypeScript string manipulation. The Extract step's cost profile is unchanged: it still runs Document AI or native text extraction exactly as today. The only additional work is serializing a string and uploading it to storage (a single `upload()` call, bytes in the low kilobytes range per document). Storage write cost for the `.md` file is negligible (< €0.0001 per document).

## 7. Known limitations (shipped intentionally)

Documenting these here so future reviewers don't file them as bugs:

1. **Real Document AI extractions currently produce only `type: 'paragraph'` blocks.** `parseDocumentAiResult` in `extract/index.ts` does not yet extract headings, tables, headers, or footers from the raw Document AI response — it tags every paragraph as `'paragraph'`. Real scanned-PDF runs will therefore produce flat, heading-free Markdown. Fixtures use the richer types aspirationally. A follow-up spec will enrich the parser. **This is not a regression introduced by this spec; it is the current state of the Extract step.**
2. **All headings render as level 1 (`#`).** No H1/H2/H3 hierarchy. Deferred.
3. **No list detection.** `- item` lines in paragraph text pass through verbatim. Deferred.
4. **No image embedding.** Page images exist in storage but are not referenced from the Markdown. Deferred to the viewer UI spec.
5. **No footnote handling.** Deferred.
6. **No TOC, no frontmatter, no metadata block.** The Markdown starts directly with the first block. Deferred.
7. **`layout.md` is derived, not authoritative.** If a consumer modifies it, the next Extract run overwrites the modification. This is by design (idempotency).

## 8. Architecture alignment

- **Service Abstraction** (CLAUDE.md): the Extract step calls `services.storage.upload()` for the Markdown write, never the GCS SDK directly. The pure converter takes no services — it's a function.
- **Idempotency** (CLAUDE.md): re-running Extract overwrites `layout.md` deterministically. Same input → same bytes.
- **Content in GCS, Index in PostgreSQL** (CLAUDE.md): `layout.md` is content and lives in storage. No database columns added.
- **TypeScript strict, ESM, no `any`/`as`** (CLAUDE.md): the converter is a pure function with fully-typed input and `string` output.
- **No new dependencies** (CLAUDE.md "latest deps" preference): the converter hand-rolls Markdown emission. No `marked`, no `remark`, no templating library.
- **Structured logging via pino** (CLAUDE.md): the Extract step logs the Markdown write (success path: `info`, failure path: `warn`).
