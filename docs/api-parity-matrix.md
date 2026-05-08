# API Parity Matrix

**Status:** Active architecture guardrail for CLI, API, and `apps/app`
**Last audited:** 2026-05-08
**Related:** [`api-architecture.md`](./api-architecture.md), [`app-api-integration.md`](./app-api-integration.md), [`app-implementation-roadmap.md`](./app-implementation-roadmap.md)

This document tracks whether Mulder capabilities are available through the CLI, the
core/domain packages, the HTTP API, and the browser app. It exists to prevent a
critical product mistake: showing app functionality that only exists in the CLI
or in backend packages without a stable browser-safe HTTP contract.

## Architecture Rule

Every product-facing capability must eventually have both:

1. A reusable domain/package implementation.
2. A stable HTTP contract for the app and remote clients.

The CLI may call the domain implementation directly for local/operator use. The
API should call the same domain implementation and expose app-safe commands and
read models. Business logic must not move into UI-shaped API handlers.

There is one important exception: low-level operator/dev commands do not
automatically need public product HTTP routes. Examples include database
migrations, fixture generation, local cache clearing, and worker process
startup. These may remain CLI-only unless the product needs an admin surface for
them.

## Parity States

| State | Meaning | App rule |
| --- | --- | --- |
| `HTTP ready` | Mounted route exists and is usable for the product surface. | Active UI may bind to it. |
| `HTTP partial` | Mounted route exists, but the app still lacks enough data/actions for the full product workflow. | UI may be active only with honest partial states. |
| `Backend ready, no HTTP` | Core/CLI/repository implementation exists, but no stable app route is mounted. | UI must stay disabled or stubbed. |
| `CLI/operator only` | Capability is useful operationally, but not a normal product surface. | Keep out of the app unless an admin workflow is designed. |
| `Future/undecided` | Capability is planned or implied, but not implemented enough to classify. | Keep disabled and documented. |

## Current Mounted HTTP Routes

This list is based on `apps/api/src/routes/*` and `apps/api/src/app.ts`.

| Area | Method | Route | Parity note |
| --- | --- | --- | --- |
| Health | `GET` | `/api/health` | HTTP ready. Public liveness route. |
| Auth | `POST` | `/api/auth/login` | HTTP ready. Browser session login. |
| Auth | `POST` | `/api/auth/logout` | HTTP ready. Browser session logout. |
| Auth | `GET` | `/api/auth/session` | HTTP ready. App session bootstrap. |
| Auth | `POST` | `/api/auth/invitations/accept` | HTTP ready. Invitation acceptance. |
| Auth | `POST` | `/api/auth/invitations` | HTTP partial. Invite creation exists; full member/admin management does not. |
| Status | `GET` | `/api/status` | HTTP partial. Good pulse, not a full usage/cost/admin read model. |
| Jobs | `GET` | `/api/jobs` | HTTP ready for processing list. |
| Jobs | `GET` | `/api/jobs/:id` | HTTP partial. Detail/progress exists; app-shaped artifacts and recovery affordances are still limited. |
| Pipeline | `POST` | `/api/pipeline/run` | HTTP ready as a queue command, but product use is gated by ingest/provenance UX. |
| Pipeline | `POST` | `/api/pipeline/retry` | HTTP partial. Retry exists; broader recovery/reprocess surface is missing. |
| Uploads | `POST` | `/api/uploads/documents/initiate` | HTTP partial. Transport exists; product Add Sources UX is still gated. |
| Uploads | `PUT` | `/api/uploads/documents/dev-upload` | Dev/local transport, not a production product primitive. |
| Uploads | `POST` | `/api/uploads/documents/complete` | HTTP partial. Completes upload and enqueues work; provenance-first workflow still missing. |
| Documents | `GET` | `/api/documents` | HTTP ready for All Sources list. |
| Documents | `GET` | `/api/documents/:id` | HTTP ready for reader-safe source detail: provenance, original-source language, quality, sensitivity, collection, credibility, and reader links are present when available. |
| Documents | `GET` | `/api/documents/:id/pdf` | HTTP ready for authenticated original-document reader. |
| Documents | `GET` | `/api/documents/:id/layout` | HTTP ready for extracted layout text. |
| Documents | `GET` | `/api/documents/:id/pages` | HTTP ready for page metadata/images. |
| Documents | `GET` | `/api/documents/:id/pages/:num` | HTTP ready for page image stream. |
| Documents | `GET` | `/api/documents/:id/stories` | HTTP ready for document-scoped stories. |
| Documents | `GET` | `/api/documents/:id/observability` | HTTP ready for secondary processing background. |
| Source Quality | `GET` | `/api/documents/:id/quality` | HTTP ready for document-quality assessment history and latest assessment. |
| Source Credibility | `GET` | `/api/documents/:id/credibility` | HTTP ready for source credibility profile detail when available. |
| Source Credibility | `GET` | `/api/source-credibility` | HTTP ready for credibility profile lists. |
| Claims | `GET` | `/api/claims` | HTTP ready for first-class assertion/claim list with filters. |
| Claims | `GET` | `/api/claims/:claimId` | HTTP ready for claim detail. |
| Claims | `GET` | `/api/documents/:id/claims` | HTTP ready for document-scoped claims. |
| Claims | `GET` | `/api/stories/:storyId/claims` | HTTP ready for story-scoped claims. |
| Translations | `GET` | `/api/documents/:id/translations` | HTTP ready for source-level translation list/status. |
| Translations | `POST` | `/api/documents/:id/translations` | HTTP ready for source-level cache hit or async translation job. |
| Translations | `GET` | `/api/translations/:translationId` | HTTP ready for translated content detail. |
| Review | `GET` | `/api/review/queues` | HTTP ready for active review queue summaries. |
| Review | `GET` | `/api/review/queues/:queueKey/artifacts` | HTTP ready for paginated queue artifacts. |
| Review | `GET` | `/api/review/artifacts/:artifactId` | HTTP ready for review artifact detail. |
| Review | `GET` | `/api/review/artifacts/:artifactId/events` | HTTP ready for review event history. |
| Review | `POST` | `/api/review/artifacts/:artifactId/actions` | HTTP ready for immutable review action/event recording. |
| Collections | `GET` | `/api/collections` | HTTP ready for collection lists and summaries. Archive-linked collections remain CLI/internal until an Archives API exists. |
| Collections | `POST` | `/api/collections` | HTTP ready for non-archive collection creation. `archive_id` and `created_by` are intentionally not browser-mutable. |
| Collections | `GET` | `/api/collections/:collectionId` | HTTP ready for collection detail/summary. |
| Collections | `PATCH` | `/api/collections/:collectionId` | HTTP ready for mutable collection metadata only: name, description, visibility, tags, and defaults. |
| Taxonomy | `GET` | `/api/taxonomy` | HTTP ready for taxonomy list/filter. Browser bootstrap/merge/re-bootstrap remain CLI/operator-only for now. |
| Taxonomy | `GET` | `/api/taxonomy/export` | HTTP ready for YAML export. |
| Discovery | `GET` | `/api/discovery/similar-entities` | HTTP ready for caveated similar-entity research leads. |
| Discovery | `GET` | `/api/discovery/temporal-patterns` | HTTP ready for caveated anomaly and hotspot research leads. |
| Discovery | `GET` | `/api/discovery/classification-mappings` | HTTP ready for caveated taxonomy/classification mapping leads. |
| Discovery | `GET` | `/api/discovery/external-correlations` | HTTP ready for caveated external-correlation research leads. |
| Search | `POST` | `/api/search` | HTTP ready. App route still pending product UI activation. |
| Entities | `GET` | `/api/entities` | HTTP ready for entity list/search. |
| Entities | `GET` | `/api/entities/:id` | HTTP ready for entity detail. |
| Entities | `GET` | `/api/entities/:id/edges` | HTTP partial for local graph context. Product Knowledge Map needs aggregate/batched graph routes. |
| Entities | `POST` | `/api/entities/merge` | HTTP ready for curated merge, subject to future review/admin UX. |
| Evidence | `GET` | `/api/evidence/summary` | HTTP ready for high-level evidence metrics. |
| Evidence | `GET` | `/api/evidence/contradictions` | HTTP ready for contradiction lists. |
| Evidence | `GET` | `/api/evidence/reliability/sources` | HTTP partial for source reliability lists. Reader/source quality needs richer source credibility read models. |
| Evidence | `GET` | `/api/evidence/chains` | HTTP ready for evidence-chain lists. |
| Evidence | `GET` | `/api/evidence/clusters` | HTTP ready for spatio-temporal cluster lists. |

## Product Capability Matrix

### Workspace And Research Desk

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Workspace pulse | `status` CLI and status repositories exist. | `GET /api/status` is mounted. | Active on Research Desk. | Needs richer product usage/cost/health model later. |
| Review queue | M11 review workflow repository exists. | Review queue/artifact/event/action routes are mounted. | Disabled until Review Queue UI slice. | Need content-first UI, EN/DE copy, and empty/error/forbidden states before activation. |
| Watchlist | No clear stable product contract found. | No route. | Disabled. | Define product object before implementing. |
| Research agent | Future product decision. | No route. | Disabled. | Needs agent safety, permissions, audit, and external-query gating. |

### Sources, Reader, And Ingest

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Source ingestion | `ingest` and `pipeline run` exist. Core source/blob/provenance repositories exist. | Upload and pipeline routes exist, but product ingest is partial. | Add Sources disabled. | Need provenance-first Add Sources UX before activating upload for normal users. |
| Source list | Source/document repositories exist. | `GET /api/documents` is mounted. | `/sources` active. | Good enough for read-only list. |
| Source detail | Core has source, document quality, provenance, collection, sensitivity data. | `GET /api/documents/:id` is expanded for the reader. | Reader can use it defensively for header, provenance, quality, language, sensitivity, collection, and credibility context. | Custody-chain detail still belongs in a later provenance inspector. |
| Original document | Blob storage and document routes exist. | `GET /api/documents/:id/pdf` is mounted. | Reader uses app-controlled PDF pane. | Good for v1 reader. Later add thumbnails/search/rotation only if needed. |
| Layout/pages | Extract/page image data exists. | Layout/pages/page image routes are mounted. | Reader uses layout as supporting original text. | Good enough for now. |
| Stories | Story repository exists. | `GET /api/documents/:id/stories` is mounted. | Reader story pane active. | Global story list/detail routes are missing. |
| Processing background | Pipeline/job/source observability exists. | `GET /api/documents/:id/observability` is mounted. | Secondary reader panel active. | Keep secondary; do not let it become the product center. |
| Collections/archive | `collection` CLI and repository exist. | Collection list/create/detail/patch routes are mounted. | Archive disabled; collection hooks prepared. | Need Archives API before archive-linked collections become a product workflow. |
| Source rollback/restore/purge | `source rollback/restore/purge` CLI and repository exist. | No source recovery HTTP routes beyond pipeline retry. | Recovery disabled/partial. | Need admin-safe recovery contracts with permissions and audit. |
| URL lifecycle/refetch | `url status/refetch` CLI and repository exist. | No URL lifecycle routes. | Not active. | Needed before URL source management becomes product UI. |

### Search And Retrieval

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Hybrid search | `query` CLI and retrieval pipeline exist. | `POST /api/search` is mounted. | Search route disabled/pending. | UI should activate after reader destinations are strong. |
| Retrieval trace | Search response can expose trace-style data. | Present through search route where response includes it. | Not yet productized. | Keep behind disclosure; do not make retrieval mechanics primary. |
| Result landing | Reader routes exist. | Source/story reader routes exist in app, but API search needs stable links/ids. | Pending. | Search UI should link to `/sources/:id` and story context. |

### Findings, Claims, Evidence, And Trust

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Evidence summary | Analyze/evidence repositories exist. | `GET /api/evidence/summary` is mounted. | Active in Research Desk/Evidence. | Good high-level surface. |
| Contradictions | Analyze conflict/contradiction logic exists. M11 conflict nodes also exist. | `GET /api/evidence/contradictions` is mounted. | Active but limited. | Need M11 conflict-node/review contracts for richer workflow. |
| Source reliability | Evidence/source reliability and M11 credibility profile work exist. | `GET /api/evidence/reliability/sources`, `GET /api/documents/:id/credibility`, and `GET /api/source-credibility` are mounted. | Partial. | Need Source Quality/reader trust UI before broad activation. |
| Evidence chains | Evidence-chain repository exists. | `GET /api/evidence/chains` is mounted. | Future drilldown. | Need reader/story anchors before deep UI. |
| Spatio-temporal clusters | M6/M12 cluster data exists. | `GET /api/evidence/clusters` is mounted. | Future drilldown. | Need caveats and source/story links for research UI. |
| First-class claims/assertions | M10 `knowledge_assertions` repository exists. | Claim list/detail/source/story routes are mounted. | Claims & Evidence stays partial. | Need review/status UI and stable text offsets before passage-click anchors. |
| Citation/claim anchors | Assertions exist, but offsets are not exposed as stable reader anchors. | No anchor fields/routes. | Not implemented. | Do not show clickable claim spans until offsets exist. |

### Knowledge Base

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Entities | `entity list/show/merge/aliases` CLI and repositories exist. | Entity list/detail/edges/merge routes exist. | Entity routes mostly disabled until product UI slice. | Alias add/remove is CLI-only; product UI needs review/permissions. |
| Relationships | Edge repository and graph step exist. | Entity-local edges route exists. | Partial. | Need aggregate/batched graph read model for Knowledge Map. |
| Knowledge Map | Graph step and repositories exist. | No graph aggregate route. | Disabled. | Need scoped graph query/read model with pagination/limits. |
| Claim Registry | Knowledge assertions exist. | Claim list/detail/source/story routes are mounted. | Disabled until Knowledge Base UI slice. | Need registry UI and offsets/citation anchors later. |
| Taxonomy | `taxonomy bootstrap/re-bootstrap/show/export/curate/merge` CLI and taxonomy repository exist. | Taxonomy list and YAML export routes are mounted. | Disabled until Knowledge Base UI slice. | Bootstrap/merge/re-bootstrap remain CLI/operator-only until browser curation is designed. |
| Stories | Story repository exists. | Document-scoped stories exist only. | Partial through reader. | Need global story list/detail routes for registry-style UI. |

### Translation And Multilingual Work

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Translate source/story | `translate` CLI, translation service, and `translated_documents` repository exist. | Source-level translation routes are mounted. | Hooks prepared; reader controls remain disabled until product UX is wired. | Story-level translation can come later if persistence and offsets need it. |
| Translation cache | Repository stores current/stale cached translations. | List/detail routes expose current/stale translated content. | Not active in visible UI yet. | Add request/poll/content-switching UX and real-source smoke coverage. |
| Multilingual labels | App i18n exists. | Not API-dependent. | Active. | Continue EN/DE guardrails for all UI copy. |

### Review, Credibility, RBAC

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Review queues | M11 review workflow repository exists. | Review queue/artifact/event/action routes are mounted. | Review Queue disabled until content-first UI slice. | Need UX that presents tasks as human decisions, not artifact rows. |
| Credibility profiles | M11 source credibility repository exists. | Document credibility and source credibility list routes are mounted. | Source Quality disabled/partial. | Need reader/source quality panels and permission-aware unavailable states. |
| RBAC filtering | Access-role repository and sensitivity filters exist. | Document/entity routes pass browser principals into filters. Auth invite/session routes exist. | Partial. | Need members, roles, policy management, access audit surfaces. |
| Hidden/forbidden content | Core can filter by sensitivity. | Route behavior exists where wired. | Partial states exist. | App needs consistent copy when content is hidden by permissions. |

### Discovery

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Similar entities/cases | M12 similarity repository and analyzer exist. | `GET /api/discovery/similar-entities` is mounted. | Disabled until Discovery UI slice. | Need UX that links leads back to entities, sources, stories, and review state. |
| Classification harmonization | M12 harmonization repository exists. | `GET /api/discovery/classification-mappings` is mounted. | Disabled until Discovery/Taxonomy UI slice. | Need UX that makes mappings reviewable and non-authoritative. |
| Temporal patterns | M12 temporal-pattern repository exists. | `GET /api/discovery/temporal-patterns` is mounted. | Disabled until Discovery UI slice. | Need source/entity/story landing links and caveats in the UI. |
| External correlations | M12 external correlations exist. | `GET /api/discovery/external-correlations` is mounted. | Disabled until Discovery UI slice. | Need external-series context and clear correlation caveats. |

### Operations, Recovery, Usage, Admin

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Processing list/detail | `pipeline status`, jobs repository, worker status exist. | Jobs routes exist. | `/runs` active as Processing. | Detail artifacts/recovery controls remain partial. |
| Pipeline enqueue/retry | `pipeline run/retry` and queue exist. | Pipeline run/retry routes exist. | Operational actions are limited. | Product actions must stay source/research-framed. |
| Dead-letter retry | `retry` CLI exists. | No dead-letter-specific HTTP route. | Recovery disabled/partial. | Need admin-safe recovery API. |
| Selective reprocess | `reprocess` CLI exists. | No HTTP route. | Disabled. | Need route if product users can rerun affected sources. |
| Worker process control | `worker start/status/reap` CLI exists. | No HTTP route. | Not product UI. | Usually operator-only; do not expose without admin design. |
| Activity feed | Repositories/events exist in pieces, but no product event stream found. | No route. | Disabled. | Need cross-system activity read model. |
| Usage/cost | Budget reservation/cost pieces exist. | `GET /api/status` exposes pulse only. | Partial. | Need usage/cost history, estimates, and billing-safe read model. |
| Exports | `export graph/stories/evidence` CLI exists. | No export route. | Disabled. | Need async export jobs and permissions if productized. |
| Config | `config validate/show/schema` CLI exists. | No route. | Admin disabled. | Usually operator-only; maybe future read-only admin config. |
| Database | `db migrate/status/gc` CLI exists. | No route. | Not product UI. | Keep operator-only. |
| Fixtures/eval/cache | CLI/dev commands exist. | No routes. | Not product UI. | Keep dev/operator-only. |

## CLI/API Remote Parity Note

`docs/api-architecture.md` describes an intended Hono RPC path where CLI commands
can route through the API when `api.url` is configured. The current code audit did
not find broad implementation of that remote CLI client. Today, most CLI commands
still call local packages/core/pipeline code directly.

This is acceptable as an implementation stage, but it must be explicit:

- Local CLI remains the richest operator surface.
- HTTP API is the browser/app and remote-client contract.
- Future CLI remote mode should be implemented command-by-command only after the
  corresponding HTTP contract exists.

## Priority Backlog

The next API work should not try to expose every CLI command. It should close
the highest product gaps in app order.

### P0: Keep the existing reader path solid

- Keep expanded `GET /api/documents/:id` stable for provenance summary, quality,
  language, sensitivity, collection, credibility, and reader-safe source links.
- Keep `/api/documents/:id/pdf`, layout, pages, stories, and observability stable.
- Do not add claim/citation anchors until offsets exist.

### P1: Translation HTTP contract

The source-level routes are now mounted:

- `GET /api/documents/:id/translations`
- `POST /api/documents/:id/translations`
- `GET /api/translations/:translationId`

The app translation control is still intentionally disabled until we design the
request/poll/content-switching UX and verify the worker path against a real
local source. Story-level translation can come later if persistence and offsets
need it.

### P1: Review, quality, credibility, and claims contracts

The minimal contracts are now mounted:

- `GET /api/review/queues`
- `GET /api/review/queues/:queueKey/artifacts`
- `GET /api/review/artifacts/:artifactId`
- `GET /api/review/artifacts/:artifactId/events`
- `POST /api/review/artifacts/:artifactId/actions`
- `GET /api/documents/:id/quality`
- `GET /api/documents/:id/credibility`
- `GET /api/source-credibility`
- `GET /api/claims`
- `GET /api/claims/:claimId`
- `GET /api/documents/:id/claims`
- `GET /api/stories/:storyId/claims`

The app can prepare hooks against these routes, but visible route activation
still needs content-first UX, localized copy, and honest empty/error/forbidden
states.

Do not include passage-click UI until claim responses include stable source/story
text offsets.

### P2: Search UI activation

The search HTTP route exists. Product work should focus on UI and result links:

- Link results to `/sources/:id`.
- Include story context where stable story ids exist.
- Keep retrieval traces behind disclosure.
- Keep result content untranslated unless translation routes are used.

### P2: Collections, taxonomy, and discovery

The first read contracts are now mounted:

- `GET /api/collections`
- `POST /api/collections`
- `GET /api/collections/:collectionId`
- `PATCH /api/collections/:collectionId`
- `GET /api/taxonomy`
- `GET /api/taxonomy/export`
- `GET /api/discovery/similar-entities`
- `GET /api/discovery/temporal-patterns`
- `GET /api/discovery/classification-mappings`
- `GET /api/discovery/external-correlations`

The app should still wait for product UI slices before activating broad
Knowledge Base and Discovery screens. Discovery UI must frame outputs as
research leads, not proof.

Taxonomy bootstrap and re-bootstrap remain CLI/operator-only until a dedicated
worker job type and browser curation workflow exist.

### P3: Operations and admin

- Dead-letter/recovery routes.
- Reprocess routes.
- Export jobs.
- Usage/cost history and estimates.
- Member/role/policy management.
- Optional read-only admin config.

Database migration, fixture generation, cache clearing, and worker startup should
remain CLI/operator concerns unless a dedicated admin product need emerges.

## Acceptance Rule For New App Work

Before activating any sidebar item or primary workflow:

1. Identify the capability in this matrix.
2. Verify the HTTP route is mounted and covered by route tests.
3. Verify the app has loading, empty, error, unavailable, and forbidden states.
4. Verify EN/DE copy exists for all visible UI.
5. Verify the route does not depend on fixed fixtures or hard-coded source IDs.
6. If the capability is only CLI/core-backed, keep the UI disabled or stubbed.

This keeps Mulder honest: powerful backend capabilities are welcome, but the app
only promises what the API can actually deliver.
