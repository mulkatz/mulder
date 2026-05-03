---
spec: "92"
title: "URL Ingestion on the Pre-Structured Path"
roadmap_step: M9-J8
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/245"
created: 2026-05-01
---

# Spec 92: URL Ingestion on the Pre-Structured Path

## 1. Objective

Add M9-J8 URL ingestion so a single `http://` or `https://` page can enter Mulder as a first-class `url` source. URL sources are already represented in the M9 source type enum and in the pre-structured step planner; this step makes that path executable by accepting URL inputs at ingest time, fetching a static HTML snapshot through service abstractions, storing that immutable snapshot under canonical raw storage, extracting readable article/page content into story Markdown during `extract`, and letting downstream processing run `enrich -> embed -> graph` while `segment` is recorded as skipped.

This fulfills the roadmap requirement for URL fetch + snapshot + Readability extraction while preserving the split with later URL work: M9-J9 owns JavaScript-rendered Playwright fallback, and M9-J10 owns durable URL lifecycle features such as scheduled re-fetch, persistent freshness tracking, and fuller rate-limit policy. J8 still includes the minimum fetch-safety gates needed before Mulder can perform outbound HTTP requests: public HTTP(S) targets only, bounded response sizes, timeouts, and single-page robots.txt respect.

## 2. Boundaries

**Roadmap step:** M9-J8 - URL ingestion: fetch + snapshot to GCS, Readability extraction -> Markdown.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/types.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `packages/pipeline/src/extract/types.ts`
- `packages/pipeline/src/index.ts`
- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/services.gcp.ts`
- `packages/core/src/shared/url-fetcher.ts`
- `packages/core/src/shared/url-extractor.ts`
- `packages/core/src/shared/errors.ts`
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`
- `apps/cli/src/commands/ingest.ts`
- `apps/cli/src/lib/cost-estimate.ts`
- `packages/worker/src/dispatch.ts`
- `tests/specs/92_url_ingestion_prestructured_path.test.ts`
- `tests/specs/73_search_api_routes.test.ts`
- `docs/roadmap.md`

**In scope:**

- Accept a single URL input in CLI ingest and pipeline-run flows where the pipeline already delegates to ingest. URL strings must be detected before filesystem resolution so `mulder ingest https://example.com/article` does not fail as a missing path.
- Treat URL ingestion as source creation from a fetched snapshot, not as a browser upload. Existing browser/API upload initiation and finalization remain file-only in this step.
- Accept only `http://` and `https://` URLs with valid hostnames.
- Normalize URL inputs deterministically:
  - trim whitespace,
  - require absolute URLs,
  - remove fragments for fetch and duplicate comparisons,
  - preserve query strings,
  - preserve the original user-provided URL in metadata.
- Reject unsafe URL targets before source creation:
  - non-HTTP(S) schemes,
  - localhost names,
  - loopback, private, link-local, multicast, documentation, and unspecified IP ranges,
  - DNS results that resolve only to unsafe addresses,
  - redirect chains that leave HTTP(S) or land on unsafe hosts.
- Fetch through a `UrlFetcherService` or equivalent service interface. Pipeline and CLI code must not call `fetch()` directly.
- Use bounded network behavior:
  - deterministic user agent,
  - timeout,
  - redirect limit,
  - maximum response bytes using the existing ingest size limit as the upper bound,
  - HTML-only content types (`text/html` and `application/xhtml+xml`, with charset parameters allowed).
- Respect robots.txt for the single URL fetch in J8:
  - fetch `{origin}/robots.txt` with the same timeout/redirect safety,
  - treat missing `robots.txt` as allowed,
  - honor `User-agent: *` and Mulder-specific user-agent groups for `Disallow` path prefixes,
  - fail before source creation when the URL is disallowed.
- Store URL sources with `source_type = 'url'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, and `format_metadata` containing at least:
  - `original_url`
  - `normalized_url`
  - `final_url`
  - `fetch_date`
  - `last_fetched`
  - `http_status`
  - `content_type`
  - `etag`
  - `last_modified`
  - `byte_size`
  - `snapshot_media_type = "text/html"`
  - `snapshot_encoding`
  - `parser_engine`
  - `robots_allowed`
  - `robots_url`
  - `redirect_count`
  - `title` when detected.
- Upload the fetched static HTML snapshot under `raw/{source_id}/original.html` using `text/html`.
- Keep duplicate detection based on the fetched snapshot hash for this step. URL-title or cross-format deduplication remains M9-J12.
- Implement deterministic static Readability extraction that:
  - downloads the stored HTML snapshot through `services.storage`,
  - runs a Readability-style parser through a service interface,
  - converts readable article/page HTML to Markdown,
  - creates one story per URL source,
  - writes `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
  - creates a `stories` row in PostgreSQL,
  - marks `source_steps.extract` completed and the source status `extracted`.
- Include URL-visible hints in story metadata and Markdown for enrichment visibility:
  - original URL,
  - final URL,
  - canonical URL if discovered,
  - host/site name,
  - page title,
  - byline,
  - published/modified times from HTML metadata when available.
- Let Spec 86's planner record `segment` as skipped when pipeline runs include that step for `url` sources.
- Preserve all current PDF, image, text, DOCX, spreadsheet, and email ingest, extract, upload, cost, and pipeline behavior.

**Out of scope:**

- JavaScript rendering, browser automation, screenshot capture, or Playwright fallback. That is M9-J9.
- Scheduled refresh, re-fetch support, persistent freshness workflows, full crawl politeness queues, and configurable per-host rate-limit state. Those are M9-J10.
- Link following, crawling, sitemap ingestion, RSS ingestion, batch URL-list files, or recursive page discovery.
- Snapshotting non-HTML resources such as PDFs, images, videos, or downloads from URLs.
- Authentication, cookies, forms, POST requests, custom request headers, or paywall handling.
- LLM summarization during extract.
- Format-aware extract routing cleanup beyond the new URL branch in the existing extract step. The broader dispatch cleanup is M9-J11.
- Cross-format deduplication beyond existing file-hash duplicate handling. That is M9-J12.
- New source type enum values; Spec 85 already added `url`.
- New direct GCP client usage in pipeline, CLI, API, or worker code.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for storage, Firestore, and URL fetch/extraction effects.
- URL fetch must be deterministic enough for tests: dev/test mode must be able to provide local, fixture, or injected responses without live internet dependency.
- URL fetch failures must fail before source creation and should not leave partial storage artifacts.
- Readability extraction must be deterministic and cost-free: no Document AI, no Gemini Vision, no Segment step, and no LLM.
- Static HTML pages that cannot produce meaningful readable Markdown must fail during extract with a clear URL extraction error instead of producing empty stories.
- Security gates must default closed for ambiguous targets: invalid DNS, unsafe redirect targets, unsupported content types, over-size responses, and malformed robots rules that clearly disallow the path must not create a source.

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85: `source_type`, `format_metadata`, and URL detection scaffolding.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `url` skips `segment`.
- M9-J3 / Spec 87: broadened non-PDF ingest/upload patterns.
- M9-J4 / Spec 88: pre-structured text extraction pattern and direct story artifact creation.
- M9-J5 / Spec 89: service-bound deterministic document extraction pattern.
- M9-J6 / Spec 90: deterministic parser service pattern and compatibility baseline.
- M9-J7 / Spec 91: pre-structured email extraction and attachment child-source compatibility baseline.
- M2-B4 / Spec 16: existing ingest implementation.
- M3-C1 / Spec 22: story repository and story storage conventions.

**Blocks:**

- M9-J9 URL rendering fallback.
- M9-J10 URL lifecycle.
- M9-J11 format-aware extract routing.
- M9-J13 multi-format golden tests.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: URL input detection and ingest routing

1. Reuse the existing `detectSourceType(null, input)` URL-shape contract from Spec 85.
2. Add explicit URL-input helpers in `packages/pipeline/src/ingest/source-type.ts`:
   - `isSupportedUrlInput()`
   - `normalizeUrlInput()`
   - lightweight metadata builder for fetched URL snapshots.
3. Update ingest resolution so URL strings bypass filesystem `stat()` and produce a URL ingest item. Directory resolution remains file-only and must not scan text files for URLs.
4. Keep file ingest behavior unchanged for all existing supported extensions.
5. Update CLI cost profiling so URL inputs count as one zero-page source and do not reserve layout/segment OCR-style costs.

### Phase 2: URL fetch service

1. Add `UrlFetcherService` in `packages/core/src/shared/services.ts`.
2. Implement dev and GCP service registry entries that share deterministic local fetch logic where practical.
3. The service must return:
   - original URL,
   - normalized URL,
   - final URL,
   - HTTP status,
   - response headers needed for metadata,
   - raw HTML bytes,
   - content type,
   - redirect count,
   - fetched-at timestamp,
   - robots decision details.
4. Add public-target validation:
   - parse URL,
   - resolve DNS with Node APIs through the service boundary,
   - reject unsafe IP ranges and unsafe redirects,
   - reject unsupported schemes.
5. Add bounded fetch controls:
   - timeout via AbortController,
   - redirect limit,
   - maximum bytes based on `config.ingestion.max_file_size_mb`,
   - stable `User-Agent`.
6. Add a minimal robots parser that supports `User-agent`, `Disallow`, `Allow`, comments, and path-prefix matching for `*` and the Mulder user agent. Full crawl-delay/rate-limit policy is M9-J10.

### Phase 3: URL source creation

1. Add `url` to the ingestible source types in `packages/pipeline/src/ingest/index.ts`.
2. When the input is a URL:
   - fetch the snapshot through `services.urls.fetchUrl()` or equivalent,
   - compute snapshot SHA-256 hash,
   - check duplicate snapshot hash before upload,
   - upload HTML to `raw/{source_id}/original.html`,
   - create a source row with `sourceType: 'url'`,
   - store fetch metadata in both `formatMetadata` and compatibility `metadata`,
   - set `pageCount = 0`, `hasNativeText = false`, `nativeTextRatio = 0`.
3. Use a deterministic source filename derived from the fetched page:
   - prefer readable title slug plus host,
   - fall back to normalized URL host/path,
   - end with `.html` for storage/display consistency.
4. Ensure dry-run URL ingest validates and fetches enough to report source type and metadata but does not upload or create DB rows.
5. Preserve existing duplicate race cleanup behavior for storage uploads.

### Phase 4: URL Readability extraction service

1. Add `UrlExtractorService` or equivalent typed service interface in `packages/core/src/shared/services.ts`.
2. Implement static HTML Readability extraction using deterministic parser dependencies such as `@mozilla/readability`, `jsdom`, and a deterministic HTML-to-Markdown converter.
3. Return a typed extraction result with:
   - title,
   - byline,
   - excerpt,
   - site name,
   - canonical URL if found,
   - published/modified timestamps when discoverable from common metadata tags,
   - readable Markdown,
   - plain text length,
   - parser engine,
   - warnings.
4. Reject blank, script-shell, unreadable, malformed, or unsupported HTML snapshots with typed URL extraction errors.
5. Add parser dependencies to the correct package manifest and update `pnpm-lock.yaml`.

### Phase 5: Markdown rendering and URL hints

1. Add deterministic Markdown rendering that:
   - starts with `# {title}`,
   - includes a compact metadata table with original URL, final URL, canonical URL, host/site name, byline, published/modified timestamps, and fetch date when available,
   - includes the readable Markdown body as primary evidence,
   - includes a `## URL Entity Hints` section only when hints exist.
2. Store hints in story metadata under `entity_hints` with hint type, field name, value, confidence, and source (`url`, `html_meta`, or `fetch_metadata`).
3. Include hints for URL, host/site name, title, byline, published date, modified date, canonical URL, and final URL.
4. Keep the readable page content as primary evidence; hints must not invent entities that are absent from the page or fetch metadata.

### Phase 6: URL extract path

1. Branch `packages/pipeline/src/extract/index.ts` by `source.sourceType`.
2. Preserve the existing PDF/image layout extract path, text path, DOCX path, spreadsheet path, and email path.
3. For `url` sources:
   - download `source.storagePath` through `services.storage`,
   - call the URL extraction service with the stored HTML and source format metadata,
   - create a story title from readability title or source filename,
   - write `segments/{source_id}/{story_id}.md` and `segments/{source_id}/{story_id}.meta.json`,
   - call `createStory()` with `pageStart = null`, `pageEnd = null`, `extractionConfidence = 1.0`, and metadata that records `source_type = url`, URL fields, parser fields, and `entity_hints`,
   - update the source format metadata with readability details when possible,
   - update the source status to `extracted`,
   - upsert `source_steps.extract = completed`,
   - write Firestore extract observability.
4. Do not write layout JSON or page images for URL sources.
5. Let pipeline/worker step planning skip `segment`; do not special-case `segment` inside URL extract.

### Phase 7: Worker, CLI, and QA compatibility

1. Update worker dispatch and finalizable/upload messaging only where needed. Browser upload remains file-only; URL ingest is not routed through `document_upload_finalize`.
2. Update CLI ingest help text and output handling so `mulder ingest https://... --dry-run` and `mulder ingest https://...` have clear behavior.
3. Add `tests/specs/92_url_ingestion_prestructured_path.test.ts`.
4. Use black-box boundaries: CLI subprocesses, public pipeline exports, SQL checks, storage artifacts, and service-registry injection. Tests must not rely on live internet.
5. Run the existing Spec 85 through Spec 91 compatibility suites or meaningful targeted subsets.

## 5. QA Contract

**QA-01: CLI dry-run accepts safe HTML URL sources without persistence**

Given a safe `https://` URL served by a deterministic test HTTP server with allowed robots.txt and HTML content, when `mulder ingest --dry-run <url>` runs, then the command exits 0, prints `Type` as `url`, prints `Pages` as `0`, and no `sources` row or storage object is created.

**QA-02: URL ingest persists snapshot metadata**

Given a safe HTML URL, when `mulder ingest <url>` runs, then a source row exists with `source_type = 'url'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, storage path `raw/{source_id}/original.html`, and `format_metadata` containing original/final URLs, fetch date, HTTP status, content type, byte size, robots decision, and parser engine.

**QA-03: URL ingest snapshots raw HTML**

Given a safe HTML URL, when ingest completes, then the fetched HTML bytes are stored under the source raw path with `text/html`, and the stored snapshot remains the input to extract even if the test server content changes later.

**QA-04: URL ingest rejects unsafe targets**

Given URLs using unsupported schemes, localhost, loopback/private IPs, unsafe DNS results, or unsafe redirect targets, when ingest runs, then it fails before source creation and no storage object is written.

**QA-05: URL ingest rejects robots-disallowed pages**

Given a URL whose test-server robots.txt disallows the requested path for Mulder or `*`, when ingest runs, then it fails before source creation with a robots/URL fetch error and no storage object is written.

**QA-06: URL ingest rejects non-HTML and oversized responses**

Given a URL returning non-HTML content or a response larger than the configured ingest size limit, when ingest runs, then it fails before source creation and no storage object is written.

**QA-07: URL duplicate ingest returns existing source**

Given the same fetched HTML snapshot is ingested twice, when the second ingest runs, then it reports duplicate status, does not create a second source row for the same snapshot hash, and preserves `source_type = 'url'`.

**QA-08: URL extract creates a pre-structured readable story**

Given an ingested URL source in dev/test mode, when `mulder extract <source_id>` runs, then the source reaches `extracted`, exactly one story row exists for the source, story Markdown and metadata objects exist under `segments/{source_id}/`, the Markdown contains readable page content, no `extracted/{source_id}/layout.json` is written, and `source_steps.extract` is `completed`.

**QA-09: URL entity hints are exposed to enrich**

Given an HTML page with title, canonical URL, byline, site name, and published/modified metadata, when extract runs, then story metadata contains `entity_hints` for those facts and the story Markdown includes a `URL Entity Hints` section with the same visible values.

**QA-10: Static Readability fails clearly for unreadable pages**

Given a static HTML page with no meaningful readable content, when extract runs, then it fails with a URL extraction error before story creation instead of creating an empty story.

**QA-11: Pipeline skips segment for URLs after extract**

Given an ingested URL source, when `mulder pipeline run --from extract --up-to enrich --source-id <source_id>` or the equivalent existing-source path runs, then `extract` executes, `segment` is recorded as skipped, `enrich` runs against the created story, and no layout or segment job/artifact is created.

**QA-12: URL input does not regress file ingest**

Given existing PDF, image, text, DOCX, spreadsheet, and email fixtures, when the existing Spec 85 through Spec 91 tests run after this change, then those source types keep their current ingest, extract, duplicate, upload finalization, and pipeline planning behavior.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run https://127.0.0.1:<safe-test-port>/article` | Deterministic test server treated as allowed by test injection | Exit 0; output includes `url`, `Pages` = `0`; no DB/storage persistence. |
| `mulder ingest https://127.0.0.1:<safe-test-port>/article` | Safe HTML URL through test injection | Exit 0; DB row has `source_type = url`; storage path ends in `original.html`. |
| `mulder ingest https://example.invalid/article` | Unresolvable/invalid URL | Non-zero or failed result; no source row; URL fetch error visible. |
| `mulder ingest http://localhost:8080/article` | Unsafe local target without test override | Non-zero or failed result; no source row; unsafe URL error visible. |
| `mulder ingest https://safe.test/disallowed` | robots.txt disallowed path via test service | Non-zero or failed result; no source row; robots error visible. |
| `mulder extract <url-source-id>` | Ingested URL source | Exit 0; one readable story is created from stored HTML; no layout JSON is written. |
| `mulder pipeline run --from extract --up-to enrich --source-id <url-source-id>` | Ingested URL source | Exit 0; `segment` is skipped; the story reaches `enriched`. |

## 6. Cost Considerations

URL ingestion and URL extract are deterministic network/storage/database/parser operations. They must not call Document AI, Gemini Vision, Segment, or any LLM. Cost estimation should show URL sources as zero scanned/layout pages for extract and should avoid reserving segment cost for URL sources because Spec 86 skips `segment` for pre-structured formats. Downstream `enrich`, `embed`, and `graph` costs remain unchanged once URL extract has produced story Markdown.
