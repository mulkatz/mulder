---
spec: "94"
title: "URL Lifecycle and Re-fetch Support"
roadmap_step: M9-J10
functional_spec: ["§2", "§2.1", "§3", "§4.5"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/252"
created: 2026-05-04
---

# Spec 94: URL Lifecycle and Re-fetch Support

## 1. Objective

Complete the M9 URL ingestion thread by adding durable lifecycle support for first-class `url` sources. A URL source should no longer be only a one-time snapshot: Mulder must record fetch freshness metadata, remember robots and per-host politeness state, and expose an explicit re-fetch path that can check or refresh an existing URL source without creating a duplicate source.

This spec builds on Spec 92 static URL ingestion and Spec 93 Playwright rendering fallback. It should preserve their safety and extraction behavior while adding the lifecycle layer those specs intentionally left out.

## 2. Boundaries

**Roadmap step:** M9-J10 - URL lifecycle: `robots.txt` respect, rate limiting, freshness tracking, re-fetch support.

**Base branch:** `milestone/9`. This spec is delivered to the M9 integration branch, not directly to `main`.

**Target branch:** `feat/252-url-lifecycle-refetch`.

**Target files:**

- `packages/core/src/database/migrations/023_url_lifecycle.sql`
- `packages/core/src/database/repositories/url-lifecycle.repository.ts`
- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/shared/services.ts`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/shared/url-fetcher.ts`
- `packages/core/src/shared/url-lifecycle.ts`
- `packages/core/src/index.ts`
- `packages/pipeline/src/ingest/index.ts`
- `packages/pipeline/src/url-lifecycle/index.ts`
- `packages/pipeline/src/index.ts`
- `apps/cli/src/commands/url.ts`
- `apps/cli/src/index.ts`
- `tests/specs/94_url_lifecycle_refetch.test.ts`
- Existing URL regression tests for Specs 92 and 93 as needed
- `docs/roadmap.md`

**In scope:**

- Persist URL lifecycle rows for `source_type = 'url'` sources.
- Persist per-host URL politeness state so rate-limit decisions survive process restarts.
- Continue enforcing URL safety and `robots.txt` before source creation and before re-fetch writes.
- Record robots decision metadata, including whether fetch was allowed, the robots URL used, check time, matched rule when available, and fetch errors when blocked.
- Record freshness metadata, including `etag`, `last_modified`, `last_fetched_at`, `last_checked_at`, `last_http_status`, `last_content_hash`, fetch counters, unchanged counters, changed counters, and `next_fetch_after`.
- Add conditional fetch support using `If-None-Match` and `If-Modified-Since` when previous `etag` or `last_modified` values exist.
- Add an explicit CLI lifecycle surface:
  - `mulder url status <source-id>` shows lifecycle state for one URL source.
  - `mulder url refetch <source-id>` checks the current URL and updates the source when content changed.
  - `mulder url refetch <source-id> --dry-run` reports the decision without writing source or lifecycle mutations, except no dry-run writes at all.
  - `mulder url refetch <source-id> --force` bypasses conditional request headers but still respects safety, robots, and rate limits.
- Handle `304 Not Modified` as an unchanged result that updates lifecycle freshness state without changing source hash, raw storage, extraction output, or pipeline step state.
- Handle changed HTML by updating the existing source's canonical raw snapshot, content hash, URL metadata, lifecycle counters, and extraction readiness so the next pipeline run re-processes the refreshed content.
- Support both static and rendered URL snapshots. If the refreshed static HTML still needs Playwright fallback, reuse the Spec 93 rendering path and persist the same rendering metadata keys.
- Fail clearly for missing sources, non-URL sources, blocked robots decisions, unsafe redirects, unsupported content types, and fetch/render failures.
- Keep tests hermetic by using local HTTP fixtures and injected/mock services where browser or network behavior would otherwise be flaky.

**Out of scope:**

- Crawling, link following, sitemap ingestion, RSS ingestion, or batch URL-list files.
- Background schedulers, cron workers, queue-driven refresh, or automatic refresh of stale URLs without an explicit command.
- Multi-version source history, diff views, or retaining every historical HTML snapshot.
- GCP-specific lifecycle services. Pipeline code must continue to use the service abstraction from §4.5.
- LLM, embedding, graph, taxonomy, or enrichment behavior changes beyond invalidating downstream work after an explicit changed re-fetch.

## 3. Data Model

Add a migration for two durable tables.

`url_lifecycle`

- One row per URL source, keyed by `source_id`.
- Stores original/final URL, host, robots decision fields, freshness fields, conditional request validators, counters, last content hash, last snapshot storage path, last error fields, and timestamps.
- Deleting a source deletes its lifecycle row.

`url_host_lifecycle`

- One row per normalized host.
- Stores the host's last request time, next allowed request time, minimum delay in milliseconds, last robots check time, and last error fields.
- Used by ingest and refetch to make per-host politeness durable.

The source table remains authoritative for source identity, current snapshot storage path, current content hash, source status, and format metadata. Lifecycle rows are operational metadata for URL behavior and should not become a second source record.

## 4. Behavior

### 4.1 Ingest

When a new URL source is ingested:

1. Normalize and safety-check the URL using the existing URL safety path.
2. Consult durable per-host politeness state before performing outbound HTTP work.
3. Fetch static HTML with robots enforcement.
4. Use Playwright fallback only when Spec 93 conditions require it.
5. Create the source as Specs 92 and 93 already define.
6. Upsert `url_lifecycle` and `url_host_lifecycle` with fetch, robots, validator, hash, rendering, and freshness data.

Duplicate URL snapshots should keep existing source de-duplication semantics. If ingest returns an existing source because the snapshot hash already exists, lifecycle state for that existing URL source should still be updated.

### 4.2 Status

`mulder url status <source-id>` must:

- Require an existing `url` source.
- Read the source and lifecycle row from PostgreSQL.
- Print source id, original/final URL, host, last fetch/check times, HTTP status, validators, hash, robots decision, next allowed fetch time, and counters.
- Exit non-zero for missing sources, non-URL sources, or missing lifecycle rows.

### 4.3 Re-fetch

`mulder url refetch <source-id>` must:

1. Require an existing `url` source.
2. Load lifecycle metadata and compute conditional request headers unless `--force` is used.
3. Respect durable host politeness state before making outbound HTTP work.
4. Re-run URL safety and robots checks.
5. Treat `304 Not Modified` or same content hash as unchanged.
6. For unchanged content, update lifecycle freshness fields and counters only.
7. For changed content, write the refreshed HTML snapshot to the source's canonical storage path, update source hash and URL metadata, mark the source ready for extraction, reset downstream pipeline progress as needed, and update lifecycle counters.
8. In dry-run mode, report what would happen and perform no database or storage mutations.

Changed re-fetch must be explicit and observable. It may mutate the current source snapshot because the user invoked a re-fetch command, but it must not silently create a second source or leave stale downstream pipeline state marked green.

## 5. Acceptance Criteria

1. URL ingest creates or updates a lifecycle row containing final URL, host, robots decision, validators, current content hash, last fetch/check timestamps, and counters.
2. Per-host politeness state is persisted and consulted by both URL ingest and re-fetch.
3. A re-fetch with `304 Not Modified` leaves source hash, storage, extraction output, and pipeline step state unchanged while updating freshness metadata.
4. A re-fetch with changed HTML updates the existing source snapshot/hash and invalidates downstream extraction work so the refreshed content is processed on the next pipeline run.
5. `--dry-run` reports unchanged/changed/blocked decisions without writing database rows or storage objects.
6. `--force` skips conditional request headers but does not bypass safety, robots, or rate limiting.
7. Robots-blocked and unsafe URL cases fail before writing source or lifecycle changes.
8. Non-URL sources are rejected by URL lifecycle commands with clear errors.
9. Spec 92 and Spec 93 URL behavior remains green.

## 6. Test Plan

- `tests/specs/94_url_lifecycle_refetch.test.ts`
  - ingest persists lifecycle and host state for a static URL source.
  - status command prints lifecycle fields for a URL source.
  - unchanged re-fetch using `etag`/`last_modified` and `304` updates lifecycle only.
  - changed re-fetch updates source hash/snapshot metadata and resets extraction readiness.
  - dry-run changed re-fetch performs no writes.
  - force re-fetch omits conditional headers.
  - robots-disallowed re-fetch fails without mutations.
  - non-URL source is rejected.
- Regression:
  - `tests/specs/92_url_ingestion_prestructured_path.test.ts`
  - `tests/specs/93_url_rendering_playwright_fallback.test.ts`

## 7. Review Checklist

- The implementation stays on the first-class URL source path and does not introduce crawling.
- Lifecycle state is durable in PostgreSQL; Firestore remains observability-only if touched at all.
- Pipeline steps use service abstractions, not direct GCP clients.
- Re-fetch has no LLM, embedding, or graph cost by itself.
- Changed re-fetch cannot leave stale extracted stories marked current.
- Tests do not rely on live internet, wall-clock sleep, or a real browser unless explicitly mocked/skipped.
