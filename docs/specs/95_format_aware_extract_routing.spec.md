---
spec: "95"
title: "Format-Aware Extract Routing"
roadmap_step: M9-J11
functional_spec: ["§2.2", "§2", "§3", "§4.5"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/254"
created: 2026-05-04
---

# Spec 95: Format-Aware Extract Routing

## 1. Objective

Complete M9-J11 by making `source_type` the explicit routing contract for the Extract step. Mulder already accepts PDF, image, text, DOCX, spreadsheet, email, and URL sources; this step hardens the dispatch boundary so extraction behavior is selected by the persisted source type and only then validated with route-local media metadata or content detection.

This fulfills the Extract contract in functional spec §2.2 while preserving the pipeline composition rules from §3 and the service abstraction rule from §4.5. The outcome should be easier to reason about than a long branch chain: layout-capable sources use the layout extractor, pre-structured sources create story Markdown directly, and unsupported combinations fail clearly before writing partial artifacts.

## 2. Boundaries

**Roadmap step:** M9-J11 - Format-aware extract routing: dispatch to correct extractor by `source_type`.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target branch:** `feat/254-format-aware-extract-routing`.

**Target files:**

- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/extract/source-routing.ts`
- `packages/pipeline/src/index.ts`
- `tests/specs/95_format_aware_extract_routing.test.ts`
- Existing M9 regression tests as needed
- `docs/roadmap.md`

**In scope:**

- Add a small Extract routing layer keyed by `Source.sourceType`.
- Route `pdf` and `image` through the layout extraction path.
- Route `text`, `docx`, `spreadsheet`, `email`, and `url` through their pre-structured extractors.
- Keep media-type and magic-byte checks as validation inside the selected route, not as global dispatch inputs.
- Preserve `--fallback-only` only for layout-capable sources and fail clearly for pre-structured sources.
- Preserve pre-structured segment skipping and source/story status transitions.
- Keep pipeline code on service abstractions; no direct GCP clients.

**Out of scope:**

- New source formats.
- Changes to ingest detection, upload finalization, or URL lifecycle behavior.
- Rewriting the individual format extractors.
- Cross-format duplicate detection. That is M9-J12.
- Golden fixture breadth. That is M9-J13.

## 3. Dependencies

- M9-J1 / Spec 85: first-class `source_type` and `format_metadata`.
- M9-J2 / Spec 86: pre-structured source types skip `segment`.
- M9-J3 through M9-J10: all source formats have executable ingest/extract paths.

This spec blocks M9-J12 and M9-J13 because both rely on predictable multi-format extraction semantics.

## 4. Blueprint

1. Add `packages/pipeline/src/extract/source-routing.ts` with a typed routing helper:
   - accepted source types
   - route kind: `layout` or `prestructured`
   - fallback-only support
   - clear error metadata for unsupported combinations
2. Update `packages/pipeline/src/extract/index.ts` to select the route once after loading the source and before running extraction.
3. Replace the repeated source-type branch chain with route-based dispatch while keeping existing extractor functions intact.
4. Keep `resolveSourceMediaType` route-local to the layout path.
5. Export only helpers needed by tests from the package barrel.
6. Add black-box tests that exercise CLI behavior and public exports without peeking into private implementation details.
7. Run the relevant M9 regression matrix.

No database migration or config change is required.

## 5. QA Contract

1. **QA-01: Public routing helper reports every M9 source type**
   - Given: the pipeline package is imported from tests
   - When: each source type is passed to the routing helper
   - Then: `pdf` and `image` are classified as layout routes, while `text`, `docx`, `spreadsheet`, `email`, and `url` are classified as pre-structured routes.

2. **QA-02: Fallback-only is rejected for pre-structured sources**
   - Given: a valid pre-structured source exists in PostgreSQL
   - When: `mulder extract <source-id> --fallback-only` is run
   - Then: the command exits non-zero with a clear source-type fallback error and does not write extracted artifacts.

3. **QA-03: Source type controls extraction even when filenames are misleading**
   - Given: a text source whose filename looks like a PDF but whose persisted `source_type` is `text`
   - When: `mulder extract <source-id>` is run
   - Then: Mulder extracts the source as text, writes direct story Markdown, skips `segment`, and does not create layout page images.

4. **QA-04: Layout sources stay on the layout path**
   - Given: an image source is ingested
   - When: `mulder extract <source-id>` is run
   - Then: Mulder writes `extracted/<source-id>/layout.json` and page image artifacts, and `segment` is not marked skipped by extract itself.

5. **QA-05: Mixed-format extraction remains composable**
   - Given: one layout source and one pre-structured source are ingested
   - When: `mulder extract --all` or the equivalent pipeline route processes them
   - Then: each source reaches `extracted` using its route without causing the other route to fail.

6. **QA-06: M9 regression suite remains green**
   - Given: existing M9 URL, email, spreadsheet, DOCX, text, image, and step-skipping tests
   - When: the targeted spec tests are run
   - Then: all previously green behavior remains green.

## 5b. CLI Test Matrix

This step does not add a new command, but it changes `mulder extract` routing behavior.

| Command | Expected |
| --- | --- |
| `mulder extract <text-source>` | direct text extraction, story created, no layout artifacts |
| `mulder extract <text-source> --fallback-only` | non-zero, clear unsupported fallback message |
| `mulder extract <image-source>` | layout extraction artifacts written |
| `mulder extract --all` | mixed source types dispatch independently |

## 6. Cost Considerations

This step should not add new paid-service calls. It should reduce accidental cost risk by keeping pre-structured sources away from Document AI / Vision fallback routes and by making layout-only service calls explicit for `pdf` and `image` sources.
