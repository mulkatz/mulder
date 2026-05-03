---
spec: "93"
title: "URL Rendering Playwright Fallback"
roadmap_step: M9-J9
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/249"
created: 2026-05-03
---

# Spec 93: URL Rendering Playwright Fallback

## 1. Objective

Add M9-J9 URL rendering fallback so a single JavaScript-rendered `http://` or `https://` page can use the same first-class `url` source path introduced by Spec 92. Static URL fetch remains the default. When the static HTML snapshot is a script shell or otherwise cannot produce meaningful readable Markdown, the ingest path should render the same safe public URL through a Playwright-backed service abstraction, snapshot the rendered DOM HTML under the canonical raw URL storage path, persist rendering metadata, and let the existing URL Readability extraction create story Markdown during `extract`.

This step is intentionally a fallback layer over the M9-J8 single-page URL path. It does not add crawling, link following, scheduled refresh, persistent freshness policy, or broader URL lifecycle behavior. Those remain M9-J10 or later work.

## 2. Boundaries

**Roadmap step:** M9-J9 - URL rendering: Playwright fallback for JS-rendered pages.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target files:**

- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/services.gcp.ts`
- `packages/core/src/shared/url-fetcher.ts`
- `packages/core/src/shared/url-renderer.ts`
- `packages/core/src/shared/url-safety.ts`
- `packages/core/src/shared/url-extractor.ts`
- `packages/core/src/shared/errors.ts`
- `packages/core/src/index.ts`
- `packages/core/package.json`
- `pnpm-lock.yaml`
- `packages/pipeline/src/ingest/source-type.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `tests/specs/92_url_ingestion_prestructured_path.test.ts`
- `tests/specs/93_url_rendering_playwright_fallback.test.ts`
- `docs/roadmap.md`

**In scope:**

- Keep M9-J8 static fetch as the fast/default path for normal readable HTML pages.
- Detect unreadable static URL snapshots before source creation using the existing deterministic URL extraction service or an equivalent service-bound readability probe.
- Fall back to Playwright rendering only for supported, safe, single-page `http://` or `https://` URL inputs.
- Render the same final safe URL that passed M9-J8 fetch and robots checks; redirects during browser navigation must remain bounded and safe.
- Serialize the rendered DOM HTML and use it as the immutable URL snapshot stored at `raw/{source_id}/original.html`.
- Preserve source semantics: `source_type = 'url'`, `page_count = 0`, `has_native_text = false`, `native_text_ratio = 0`, `segment` skipped, and downstream `enrich -> embed -> graph` unchanged.
- Store rendering metadata in `format_metadata` and compatibility `metadata`, including at least:
  - `rendering_method = "static" | "playwright"`
  - `rendering_engine`
  - `rendered_at`
  - `render_duration_ms`
  - `render_fallback_reason`
  - `static_readability_error`
  - `rendered_from_url`
  - `rendered_final_url`
  - `rendered_byte_size`
  - `blocked_render_request_count`
  - `snapshot_media_type = "text/html"`
- Preserve M9-J8 URL safety behavior for all browser navigation and subresource requests:
  - public HTTP(S) targets only,
  - no embedded credentials,
  - no localhost/private/link-local/multicast/documentation/unspecified addresses,
  - unsafe DNS answers rejected,
  - unsafe redirects rejected,
  - no downloads,
  - bounded timeout and rendered HTML byte size.
- Keep robots enforcement before rendered source creation. The page URL must still pass M9-J8 robots checks before Playwright rendering begins.
- Support deterministic tests without live internet and without requiring a real browser process when a fixture or injected renderer is used.
- Keep browser renderer failures clear and typed. If static extraction fails and rendering also fails, URL ingest must fail before source creation.

**Out of scope:**

- Crawling, link following, sitemap ingestion, RSS ingestion, or batch URL-list files.
- Scheduled refresh, freshness tracking, `etag`/`last_modified` lifecycle policy, persistent per-host rate-limit state, or re-fetch commands. That is M9-J10.
- Rendering screenshots, page images, PDFs, downloads, videos, or non-HTML resources.
- Authentication, cookies, forms, POST requests, user-supplied headers, or paywall handling.
- JavaScript interaction beyond loading the page and waiting for bounded idle/DOM readiness.
- Running enrichment, embedding, graph, or any LLM during ingest.
- Replacing the static URL path with always-on browser rendering.
- New direct GCP client usage in pipeline, CLI, API, or worker code.

**Architectural constraints:**

- PostgreSQL remains authoritative for source identity and pipeline state.
- Firestore remains write-only observability.
- Service abstractions remain the only boundary for storage, Firestore, URL fetch, URL rendering, and URL extraction effects.
- Pipeline and CLI code must not import Playwright directly.
- Renderer contexts must be ephemeral: no persisted browser profile, no saved cookies, no shared authenticated state.
- Browser network behavior must default closed for ambiguous targets and must not weaken M9-J8 SSRF protections.
- Rendered snapshots must be deterministic enough for tests: dev/test mode can inject or fixture renderer output without live internet.
- If the rendered DOM still cannot produce meaningful readable Markdown, extract must fail with the existing clear URL extraction error instead of creating an empty story.

## 3. Dependencies

**Requires:**

- M9-J8 / Spec 92: URL ingestion with static fetch, public-target validation, robots checks, raw HTML snapshot storage, URL Readability extraction, and pre-structured pipeline skip behavior.
- M9-J2 / Spec 86: source-type-aware pipeline planning where `url` skips `segment`.
- M9-J4 through M9-J7: pre-structured extractor patterns and story artifact conventions.
- M2-B4 / Spec 16: existing ingest implementation.
- M3-C1 / Spec 22: story repository and story storage conventions.

**Blocks:**

- M9-J10 URL lifecycle, because lifecycle work should operate on URL sources that may have either static or rendered snapshots.
- M9-J13 multi-format golden tests.

No cross-milestone dependency blocks this step.

## 4. Blueprint

### Phase 1: Safety extraction and service contracts

1. Factor reusable URL safety helpers from `packages/core/src/shared/url-fetcher.ts` into `packages/core/src/shared/url-safety.ts`.
2. Keep the safety behavior identical to Spec 92 while making it reusable by both static fetch and browser rendering.
3. Add a `UrlRendererService` in `packages/core/src/shared/services.ts` with a method equivalent to:
   - input: final URL plus max bytes, timeout, redirect limit, and request-safety options,
   - output: rendered final URL, rendered HTML bytes, duration, engine name, blocked request count, warnings.
4. Add renderer metadata types without changing existing storage or source table schemas.
5. Export renderer and safety utilities only through package-level public surfaces that existing packages can consume.

### Phase 2: Playwright renderer implementation

1. Add `packages/core/src/shared/url-renderer.ts`.
2. Implement a Playwright Chromium renderer behind the service interface.
3. Use an ephemeral browser context with:
   - no persisted profile,
   - JavaScript enabled,
   - downloads blocked,
   - credentials and non-HTTP(S) requests blocked,
   - bounded navigation timeout,
   - bounded wait for DOM readiness/network idle,
   - deterministic user agent aligned with the URL fetcher.
4. Intercept every browser request and validate its URL with the shared safety helpers before allowing it.
5. Abort unsafe, non-HTTP(S), credentialed, local/private/link-local/multicast/documentation/unspecified, or oversize-prone requests.
6. Treat unsafe main-frame navigation or unsafe redirects as rendering failures.
7. Serialize `document.documentElement.outerHTML` and enforce the same ingest max-byte ceiling before returning.
8. Dev and GCP service registries should both expose the renderer service through the same interface. Test mode may use deterministic fixture/injected output where the black-box tests require no real browser process.

### Phase 3: Static readability probe and ingest fallback

1. In `packages/pipeline/src/ingest/index.ts`, keep URL fetch through `services.urls.fetchUrl()` as the first path.
2. Before creating the source row, probe the fetched static HTML with `services.urlExtractors.extractUrl()` or an equivalent deterministic readability check.
3. If static HTML is readable, keep the current Spec 92 behavior and record `rendering_method = "static"`.
4. If static HTML is unreadable with a URL extraction error, call `services.urlRenderers.renderUrl()` for the safe final URL.
5. Probe the rendered HTML for readability before upload. If it is still unreadable, fail before source creation with a URL rendering/extraction error.
6. Use the rendered HTML bytes as the source snapshot and compute duplicate hash from that selected snapshot.
7. Store render metadata with the URL fetch metadata in `format_metadata` and compatibility `metadata`.
8. Dry-run URL ingest should run the same static/probe/render decision but skip storage and DB writes.

### Phase 4: Extract compatibility

1. Keep URL extract reading the stored `raw/{source_id}/original.html` snapshot through `services.storage`.
2. No browser rendering occurs in `extract`; extract remains deterministic and cost-free after ingest has selected the immutable snapshot.
3. Ensure URL story metadata and Markdown expose rendering method/engine when available without making rendering hints primary evidence.
4. Preserve unreadable failure behavior: no empty story rows are created.

### Phase 5: QA and regression coverage

1. Add `tests/specs/93_url_rendering_playwright_fallback.test.ts`.
2. Use deterministic local HTTP servers and service-registry injection or fixture rendering so tests do not depend on live internet.
3. Cover static success without browser fallback, JS-shell fallback success, unsafe render request blocking, rendered snapshot immutability, dry-run behavior, duplicate-by-rendered-hash, and extract-through-story behavior.
4. Re-run Spec 92 URL ingestion coverage to prove the static path did not regress.
5. Run meaningful M9 compatibility subsets for file-based formats that could be affected by service registry or package wiring changes.

## 5. QA Contract

**QA-01: Static readable URLs do not invoke Playwright**

Given a safe URL whose static HTML is readable, when URL ingest runs, then the source is created from the static snapshot, `format_metadata.rendering_method = "static"`, no renderer invocation is recorded, and existing Spec 92 metadata remains present.

**QA-02: JavaScript-shell URLs fall back to rendered HTML before source creation**

Given a safe URL whose static HTML is an unreadable JavaScript shell and whose deterministic renderer output contains readable article HTML, when URL ingest runs, then the source row exists with `source_type = 'url'`, storage path `raw/{source_id}/original.html`, `format_metadata.rendering_method = "playwright"`, and the stored raw snapshot contains the rendered article content rather than the original shell-only body.

**QA-03: Rendered snapshot is immutable input to extract**

Given a JS-shell URL ingested through rendering fallback, when the test server content changes after ingest and `mulder extract <source_id>` runs, then the story Markdown is produced from the stored rendered snapshot and does not include the later server content.

**QA-04: Rendered URL extraction creates one pre-structured story**

Given a rendered URL source, when extract runs, then exactly one story row exists, story Markdown and metadata objects exist under `segments/{source_id}/`, source status is `extracted`, `source_steps.extract` is `completed`, and no `extracted/{source_id}/layout.json` is written.

**QA-05: Unsafe browser requests are blocked**

Given a rendered page that attempts to load a subresource or redirect to localhost/private/link-local/documentation/unspecified/multicast or credentialed URLs, when rendering fallback runs, then unsafe requests are blocked or the main-frame render fails safely, no unsafe target is fetched, and no source row or storage object is created for unsafe main-frame outcomes.

**QA-06: Rendering failure does not create partial sources**

Given a JS-shell URL whose renderer times out, exceeds the byte limit, cannot launch, or returns unreadable HTML, when ingest runs, then the command fails with a URL rendering/extraction error before source creation and no raw storage object is written.

**QA-07: Dry-run performs the same fallback decision without persistence**

Given a JS-shell URL with deterministic rendered output, when `mulder ingest --dry-run <url>` runs, then the command exits successfully, reports `url` with `Pages` as `0`, includes validated metadata internally, and no `sources` row or storage object is created.

**QA-08: Duplicate detection uses the selected rendered snapshot hash**

Given two safe JS-shell URLs whose rendered HTML snapshots are byte-identical, when both are ingested, then the second ingest reports duplicate status, no second source row is created for that snapshot hash, and the duplicate preserves `source_type = 'url'`.

**QA-09: Pipeline skips segment for rendered URLs**

Given an ingested rendered URL source, when `mulder pipeline run --from extract --up-to enrich --source-id <source_id>` runs, then `extract` executes, `segment` is recorded as skipped, `enrich` runs against the created story, and no layout or segment job/artifact is created.

**QA-10: Static URL and non-URL format regressions stay green**

Given existing Spec 92 static URL tests and representative PDF, image, text, DOCX, spreadsheet, and email tests, when the targeted regression suites run after this change, then their current ingest/extract behavior remains unchanged.

## 5b. CLI Test Matrix

| Command | Input | Expected |
| --- | --- | --- |
| `mulder ingest --dry-run http://127.0.0.1:<safe-test-port>/static-article` | Deterministic static readable HTML through test safety override | Exit 0; output includes `url`, `Pages = 0`; metadata path remains static; no persistence. |
| `mulder ingest http://127.0.0.1:<safe-test-port>/js-shell` | Static unreadable shell with deterministic rendered article output | Exit 0; DB row has `source_type = url`; `format_metadata.rendering_method = playwright`; storage path ends in `original.html`. |
| `mulder extract <rendered-url-source-id>` | Ingested rendered URL source | Exit 0; one readable story is created from stored rendered HTML; no layout JSON is written. |
| `mulder pipeline run --from extract --up-to enrich --source-id <rendered-url-source-id>` | Ingested rendered URL source | Exit 0; `segment` is skipped; the story reaches `enriched`. |
| `mulder ingest http://localhost:8080/js-shell` | Unsafe local target without test override | Non-zero or failed result; no source row; unsafe URL error visible. |
| `mulder ingest http://127.0.0.1:<safe-test-port>/render-unsafe-mainframe` | Renderer attempts unsafe main-frame navigation | Non-zero or failed result; no source row; unsafe render error visible. |
| `mulder ingest http://127.0.0.1:<safe-test-port>/render-timeout` | Renderer timeout/failure fixture | Non-zero or failed result; no source row; render timeout/error visible. |

## 6. Cost Considerations

URL rendering adds local CPU and memory cost but must not call paid GCP, Document AI, Gemini Vision, Segment, or LLM services during ingest or extract. The fallback should only launch Playwright when static URL extraction cannot produce meaningful readable content. Cost estimation should continue to show URL sources as zero scanned/layout pages and should not reserve segment cost because URL remains pre-structured after extract.
