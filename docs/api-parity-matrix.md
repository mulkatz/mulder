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
| Documents | `GET` | `/api/documents/:id` | HTTP partial. Basic source detail exists; provenance, quality, language, sensitivity, and collection summary need expansion. |
| Documents | `GET` | `/api/documents/:id/pdf` | HTTP ready for authenticated original-document reader. |
| Documents | `GET` | `/api/documents/:id/layout` | HTTP ready for extracted layout text. |
| Documents | `GET` | `/api/documents/:id/pages` | HTTP ready for page metadata/images. |
| Documents | `GET` | `/api/documents/:id/pages/:num` | HTTP ready for page image stream. |
| Documents | `GET` | `/api/documents/:id/stories` | HTTP ready for document-scoped stories. |
| Documents | `GET` | `/api/documents/:id/observability` | HTTP ready for secondary processing background. |
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
| Review queue | M11 review workflow repository exists. | No review HTTP routes. | Disabled. | Need queue list, artifact list/detail, and review action routes. |
| Watchlist | No clear stable product contract found. | No route. | Disabled. | Define product object before implementing. |
| Research agent | Future product decision. | No route. | Disabled. | Needs agent safety, permissions, audit, and external-query gating. |

### Sources, Reader, And Ingest

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Source ingestion | `ingest` and `pipeline run` exist. Core source/blob/provenance repositories exist. | Upload and pipeline routes exist, but product ingest is partial. | Add Sources disabled. | Need provenance-first Add Sources UX and source-detail contract expansion. |
| Source list | Source/document repositories exist. | `GET /api/documents` is mounted. | `/sources` active. | Good enough for read-only list. |
| Source detail | Core has source, document quality, provenance, collection, sensitivity data. | `GET /api/documents/:id` exists but is basic. | Reader uses it for basic header/readiness. | Expand with provenance summary, quality, language, sensitivity, collection, authenticity, custody. |
| Original document | Blob storage and document routes exist. | `GET /api/documents/:id/pdf` is mounted. | Reader uses app-controlled PDF pane. | Good for v1 reader. Later add thumbnails/search/rotation only if needed. |
| Layout/pages | Extract/page image data exists. | Layout/pages/page image routes are mounted. | Reader uses layout as supporting original text. | Good enough for now. |
| Stories | Story repository exists. | `GET /api/documents/:id/stories` is mounted. | Reader story pane active. | Global story list/detail routes are missing. |
| Processing background | Pipeline/job/source observability exists. | `GET /api/documents/:id/observability` is mounted. | Secondary reader panel active. | Keep secondary; do not let it become the product center. |
| Collections/archive | `collection` CLI and repository exist. | No collection HTTP routes. | Archive disabled. | Need collection CRUD/list/read model before app activation. |
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
| Source reliability | Evidence/source reliability and M11 credibility profile work exist. | `GET /api/evidence/reliability/sources` is mounted. | Partial. | Need source credibility profile route/read model. |
| Evidence chains | Evidence-chain repository exists. | `GET /api/evidence/chains` is mounted. | Future drilldown. | Need reader/story anchors before deep UI. |
| Spatio-temporal clusters | M6/M12 cluster data exists. | `GET /api/evidence/clusters` is mounted. | Future drilldown. | Need caveats and source/story links for research UI. |
| First-class claims/assertions | M10 `knowledge_assertions` repository exists. | No first-class claims/assertions HTTP routes. | Claims & Evidence stays partial. | Need claim list/detail/history/review routes and stable text offsets. |
| Citation/claim anchors | Assertions exist, but offsets are not exposed as stable reader anchors. | No anchor fields/routes. | Not implemented. | Do not show clickable claim spans until offsets exist. |

### Knowledge Base

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Entities | `entity list/show/merge/aliases` CLI and repositories exist. | Entity list/detail/edges/merge routes exist. | Entity routes mostly disabled until product UI slice. | Alias add/remove is CLI-only; product UI needs review/permissions. |
| Relationships | Edge repository and graph step exist. | Entity-local edges route exists. | Partial. | Need aggregate/batched graph read model for Knowledge Map. |
| Knowledge Map | Graph step and repositories exist. | No graph aggregate route. | Disabled. | Need scoped graph query/read model with pagination/limits. |
| Claim Registry | Knowledge assertions exist. | No claims/assertions routes. | Disabled. | Same gap as first-class claims. |
| Taxonomy | `taxonomy bootstrap/re-bootstrap/show/export/curate/merge` CLI and taxonomy repository exist. | No taxonomy routes are mounted. | Disabled. | Need taxonomy list/export/curation routes if productized. |
| Stories | Story repository exists. | Document-scoped stories exist only. | Partial through reader. | Need global story list/detail routes for registry-style UI. |

### Translation And Multilingual Work

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Translate source/story | `translate` CLI, translation service, and `translated_documents` repository exist. | No translation HTTP routes. | Reader controls are visible but disabled/stubbed. | Need list/request/status/fetch translation routes before activation. |
| Translation cache | Repository stores current/stale cached translations. | No browser route. | Not active. | App needs status and cached-content read models. |
| Multilingual labels | App i18n exists. | Not API-dependent. | Active. | Continue EN/DE guardrails for all UI copy. |

### Review, Credibility, RBAC

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Review queues | M11 review workflow repository exists. | No review HTTP routes. | Review Queue disabled. | Need queue summaries, artifact lists, artifact detail, review actions. |
| Credibility profiles | M11 source credibility repository exists. | No dedicated credibility/profile route. | Source Quality disabled/partial. | Need direct sensitivity/provenance policy before exposure. |
| RBAC filtering | Access-role repository and sensitivity filters exist. | Document/entity routes pass browser principals into filters. Auth invite/session routes exist. | Partial. | Need members, roles, policy management, access audit surfaces. |
| Hidden/forbidden content | Core can filter by sensitivity. | Route behavior exists where wired. | Partial states exist. | App needs consistent copy when content is hidden by permissions. |

### Discovery

| Capability | CLI/core status | HTTP status | App status | Gap |
| --- | --- | --- | --- | --- |
| Similar entities/cases | M12 similarity repository and analyzer exist. | No discovery HTTP route. | Disabled. | Need read model linking similarities to entities, sources, stories, review status. |
| Classification harmonization | M12 harmonization repository exists. | No HTTP route. | Disabled. | Need taxonomy/mapping routes and caveat/status model. |
| Temporal patterns | M12 temporal-pattern repository exists. | No M12 temporal pattern route. | Disabled. | Need read model and caveats; current evidence clusters are older/adjacent, not full M12 UI. |
| External correlations | M12 external correlations exist. | No HTTP route. | Disabled. | Need plugin metadata alignment and correlation read model. |

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

- Expand `GET /api/documents/:id` with provenance summary, quality, language,
  sensitivity, collection, authenticity, custody, and reader-safe source links.
- Keep `/api/documents/:id/pdf`, layout, pages, stories, and observability stable.
- Do not add claim/citation anchors until offsets exist.

### P1: Translation HTTP contract

Recommended minimal routes:

- `GET /api/documents/:id/translations`
- `GET /api/documents/:id/stories/:storyId/translations`
- `POST /api/documents/:id/stories/:storyId/translations`
- `GET /api/translations/:translationId`

The app can then replace the reader translation stub with real cached
translation status and content.

### P1: Review and credibility contracts

Recommended minimal routes:

- `GET /api/review/queues`
- `GET /api/review/queues/:id/artifacts`
- `GET /api/review/artifacts/:id`
- `POST /api/review/artifacts/:id/actions`
- `GET /api/documents/:id/credibility`
- `GET /api/source-quality`

These should preserve sensitivity/provenance rules before becoming active app UI.

### P1: First-class claims/assertions

Recommended minimal routes:

- `GET /api/claims`
- `GET /api/claims/:id`
- `GET /api/documents/:id/claims`
- `GET /api/stories/:id/claims`

Do not include passage-click UI until the response includes stable source/story
text offsets.

### P2: Search UI activation

The search HTTP route exists. Product work should focus on UI and result links:

- Link results to `/sources/:id`.
- Include story context where stable story ids exist.
- Keep retrieval traces behind disclosure.
- Keep result content untranslated unless translation routes are used.

### P2: Collections and taxonomy

Recommended routes if productized:

- `GET /api/collections`
- `POST /api/collections`
- `GET /api/collections/:id`
- `PATCH /api/collections/:id`
- `GET /api/taxonomy`
- `GET /api/taxonomy/export`
- `POST /api/taxonomy/bootstrap`
- `POST /api/taxonomy/re-bootstrap`

Taxonomy bootstrap and re-bootstrap should be async job routes.

### P2: Discovery read models

Recommended routes:

- `GET /api/discovery/similar-entities`
- `GET /api/discovery/temporal-patterns`
- `GET /api/discovery/classification-mappings`
- `GET /api/discovery/external-correlations`

Discovery UI must frame outputs as research leads, not proof.

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
