# Mulder App API Integration Notes

**Status:** Active implementation reference for `apps/app`
**Related:** [`app-design-strategy.md`](./app-design-strategy.md), [`app-deployment.md`](./app-deployment.md), [`api-architecture.md`](./api-architecture.md), [`api-parity-matrix.md`](./api-parity-matrix.md)

This document is the active API integration reference for the Mulder app. It is not a visual or interaction-design reference. The app must continue to follow the cleaner, research-first direction in `docs/app-design-strategy.md`.

Use [`api-parity-matrix.md`](./api-parity-matrix.md) as the source of truth for whether a capability is app-ready, partially exposed over HTTP, backend-only, CLI/operator-only, or future work.

## Integration Posture

`apps/app` should bind to stable HTTP contracts early, but Mulder's backend remains CLI/domain/queue-first. Browser routes should consume API read models and enqueue jobs; they should not move business logic into UI-shaped endpoints.

The app should use:

- `VITE_API_BASE_URL` as the browser API origin.
- `VITE_API_PROXY_TARGET` for local same-origin `/api` proxying during Vite development.
- `credentials: 'include'` for all authenticated API calls.
- Cookie-backed browser sessions, not bundled bearer tokens.
- Explicit loading, empty, unavailable, and error states.
- No checked-in static IDs or product-screen fixtures in `apps/app`.

The app API client should keep these properties:

- `ApiError` carries `status`, `code`, `message`, and optional `details`.
- Error responses are parsed from `{ error: { code, message, details } }` when available.
- Network, CORS, and unreachable-origin failures are normalized to structured API-unavailable errors.
- JSON helpers set `Content-Type: application/json`.
- Text helpers use `Accept: text/markdown, text/plain`.
- `buildApiUrl(path)` passes through absolute URLs and prefixes relative API paths with `VITE_API_BASE_URL`.

React Query should use conservative defaults:

- Short stale time for dashboard and status data.
- No refetch on window focus by default.
- No retry for `401`, `403`, or `404`.
- Limited retry for transient network/server failures.
- Session expiry is observable through shared app-level handling for both queries and mutations.
- API-unavailable states must remain visible product states and must not be treated as logout.

## App State Model

The app treats API state as product behavior, not as incidental rendering detail.

| State | Meaning | App behavior |
| --- | --- | --- |
| `unauthenticated` | API returned `401` | Auth/session handling owns the redirect to `/login`. |
| `unavailable` | Network/CORS failure, status `0`, or `5xx` | Show localized API-unavailable UI; never treat this as logout. |
| `forbidden` | API returned `403` | Show localized access/error UI. |
| `notFound` | API returned `404` | Show localized missing-data UI where relevant. |
| `validation` | Other `4xx` responses | Show localized request/error UI with the API message when available. |

Active app routes use this model as follows:

- `Research Desk` (`/`) treats `GET /api/status` as the minimum workspace pulse. Without it, the page shows a workspace-unavailable state. Documents, evidence summary, contradictions, and jobs remain secondary panel-level data.
- `All Sources` (`/sources`) uses `GET /api/documents` with server-backed search, status filters, limit, and offset. Empty corpus, unavailable API, and no matching filters are distinct states.
- `Source Reader` (`/sources/:id`) uses document-scoped contracts only: PDF, layout, pages, stories, and observability. Each pane can fail independently without collapsing the whole reader.
- `Claims & Evidence` (`/evidence`) separates "no claims need review" from "claims data unavailable." Evidence summaries may fail independently from claim/contradiction records.
- `Processing` (`/runs`) separates the job list from selected job detail. A failed `GET /api/jobs/:id` leaves the list selection intact and shows an inspector-level detail error.

The app should expose:

- `/login` for email/password authentication.
- `/auth/invitations/:token` for invite acceptance, matching the API-generated invitation link shape.
- Protected app routes behind `GET /api/auth/session`.
- Logout through `POST /api/auth/logout` and query-cache clearing.
- Any `401` from a protected app query or mutation should invalidate auth state and force the session gate to re-check.

## Usable HTTP Surface

These endpoints are the first candidates for `apps/app` because they already represent usable browser-facing contracts.

| Area | Endpoint | Notes |
| --- | --- | --- |
| Health | `GET /api/health` | Public service health. Useful for deployment smoke checks. |
| Auth | `GET /api/auth/session` | Session bootstrap for protected app routes. |
| Auth | `POST /api/auth/login` | Email/password login. |
| Auth | `POST /api/auth/logout` | Ends the browser session. |
| Auth | `POST /api/auth/invitations/accept` | Invite acceptance flow. |
| Auth | `POST /api/auth/invitations` | Owner/admin invite creation. |
| Status | `GET /api/status` | Budget and queue pulse. Good for Overview. |
| Jobs | `GET /api/jobs` | Job list with filters and pagination. Good for Operations/Analysis Runs. |
| Jobs | `GET /api/jobs/:id` | Job detail with payload, error log, and progress when exposed. |
| Pipeline | `POST /api/pipeline/run` | Enqueues pipeline work. Keep behind deliberate user action. |
| Pipeline | `POST /api/pipeline/retry` | Retry flow for failed work. Treat as operational. |
| Uploads | `POST /api/uploads/documents/initiate` | Starts large browser upload session. |
| Uploads | `PUT /api/uploads/documents/dev-upload` | Local/dev upload transport. Not a production product primitive. |
| Uploads | `POST /api/uploads/documents/complete` | Finalizes upload and creates a job. |
| Documents | `GET /api/documents` | Archive list and Overview corpus counts. |
| Documents | `GET /api/documents/:id` | Reader-safe source detail: readiness, provenance summary, quality, language, sensitivity, collection, credibility, and stable reader links. |
| Documents | `GET /api/documents/:id/pdf` | PDF document stream. |
| Documents | `GET /api/documents/:id/layout` | Markdown layout text. |
| Documents | `GET /api/documents/:id/pages` | Page image metadata. |
| Documents | `GET /api/documents/:id/pages/:pageNumber` | Page image stream. |
| Documents | `GET /api/documents/:id/stories` | Story list and story metadata. |
| Documents | `GET /api/documents/:id/observability` | Document processing timeline/read model. |
| Translations | `GET /api/documents/:id/translations` | Source-level translation list/status and cached content. |
| Translations | `POST /api/documents/:id/translations` | Source-level cache hit or async translation job request. |
| Translations | `GET /api/translations/:translationId` | Translation detail with translated content. |
| Search | `POST /api/search` | Hybrid retrieval, citations, and trace data. |
| Entities | `GET /api/entities` | Entity list with filters. |
| Entities | `GET /api/entities/:id` | Entity detail, aliases, related stories. |
| Entities | `GET /api/entities/:id/edges` | Entity-local graph edges. |
| Entities | `POST /api/entities/merge` | Curated merge operation. |
| Evidence | `GET /api/evidence/summary` | High-level evidence metrics. |
| Evidence | `GET /api/evidence/contradictions` | Potential/confirmed/dismissed contradictions. |
| Evidence | `GET /api/evidence/reliability/sources` | Source reliability list. |
| Evidence | `GET /api/evidence/chains` | Evidence chains by thesis. |
| Evidence | `GET /api/evidence/clusters` | Spatio-temporal clusters. |

## Hook Mapping

This mapping captures the app's hook-per-contract shape.

| Legacy hook | API contract | App use |
| --- | --- | --- |
| `useSession` | `GET /api/auth/session` | AuthGate/session bootstrap. |
| `useLogin` | `POST /api/auth/login` | Login screen. |
| `useLogout` | `POST /api/auth/logout` | Account menu/logout. |
| `useAcceptInvite` | `POST /api/auth/invitations/accept` | Invite acceptance route. |
| `useCreateInvite` | `POST /api/auth/invitations` | Future admin settings. |
| `useStatus` | `GET /api/status` | Overview pulse and capacity signals. |
| `useJobs` | `GET /api/jobs` | Operations/Analysis Runs table. |
| `useJob` | `GET /api/jobs/:id` | Selected run inspector. |
| `useDocuments` | `GET /api/documents` | Sources list, corpus counts, server-backed search/status filters, and pagination. |
| `useDocument` | `GET /api/documents/:id` | Source reader detail/readiness without depending on processing observability. |
| `useDocumentLayout` | `GET /api/documents/:id/layout` | Source reader extracted-text preview. |
| `useDocumentPages` | `GET /api/documents/:id/pages` | Source reader page count and future page metadata. |
| PDF pane URL | `GET /api/documents/:id/pdf` | Source reader original-document pane. |
| `useDocumentStories` | `GET /api/documents/:id/stories` | Source inspector and source reader story workspace. |
| `useDocumentObservability` | `GET /api/documents/:id/observability` | Source inspector and secondary processing-background panel. |
| `useEntities` | `GET /api/entities` | Entities list. |
| `useEntity` | `GET /api/entities/:id` | Entity inspector/profile. |
| `useEntityEdges` | `GET /api/entities/:id/edges` | Entity-local graph context. |
| `useSearch` | `POST /api/search` | Research search route. |
| `useEvidenceSummary` | `GET /api/evidence/summary` | Overview and Evidence Workspace. |
| `useContradictions` | `GET /api/evidence/contradictions` | Evidence Workspace. |
| `useEvidenceReliabilitySources` | `GET /api/evidence/reliability/sources` | Trust/source panels. |
| `useEvidenceChains` | `GET /api/evidence/chains` | Future evidence-chain drilldown. |
| `useEvidenceClusters` | `GET /api/evidence/clusters` | Future spatial/temporal review. |
| `useDocumentUpload` | upload initiate -> transport -> complete -> job polling | Future document ingest flow after release gates are satisfied. |

## Known App API Gaps

These gaps should be visible in the app capability registry instead of hidden behind fake data.

| Capability | Current issue |
| --- | --- |
| Analysis run facade | Jobs exist, but app-shaped run summaries, artifacts, step timings, and retry affordances are still partial. |
| Evidence claims | Summary and contradictions exist, but first-class claim records, review decisions, and assertion history need an app contract. |
| Source detail | `GET /api/documents/:id` now exposes stable readiness, provenance summary, quality, language, sensitivity, collection, credibility, and links without requiring processing background data. Custody-chain detail still needs a dedicated provenance inspector. |
| Provenance-first ingest | M10 provenance, document quality, sensitivity/RBAC, custody, rollback, and collections exist in the backend. Product Add Sources remains gated until the app captures and displays those concepts as part of the ingest workflow. |
| Persistent translation | Source-level translation routes now exist, and app hooks are prepared. The visible reader control remains disabled until the request, polling, and translated-content switching UX is designed and smoke-tested. |
| Review queues | M11 review workflow repositories exist, but the app needs HTTP contracts for queues, queue artifacts, artifact detail, and review actions before activating Review Queue. |
| Credibility profiles | M11 source credibility exists, but Source Quality and reader trust panels need source credibility read models. |
| RBAC management | M11 RBAC filters reads, but member/role/policy management is still only partially represented in app contracts. |
| M12 discovery | Similarity, classification harmonization, temporal patterns, and external correlations exist, but the app needs read models that link discoveries back to sources, stories, entities, and review artifacts. |
| Graph aggregate | Entity-local edges exist, but product graph views need an aggregate or batched graph read model. |
| Activity feed | No cross-system event stream exists yet. |
| Usage/cost surface | Status exposes budget pieces, but product usage views need a broader read model. |
| Settings/admin | Auth invitations exist, but workspace policy, roles, config, and product settings are future work. |
| Production upload UX | Upload contracts exist, but real archive ingest should not be promoted until the trust/provenance gate is resolved or explicitly waived. |
| Claim/citation anchors | Story entities can be highlighted conservatively, but exact claim spans, citation anchors, and assertion offsets need first-class API fields before the app shows passage-level claim links. |

## What To Reuse

- API client shape and credential behavior.
- Blob fetch shape for authenticated binary document streams.
- React Query defaults and query-key discipline.
- Hook-per-contract structure.
- Upload session sequence.
- Source reader pane pattern: authenticated original PDF, extracted story, and secondary processing background from document-scoped contracts.
- Playwright smoke-test idea: verify real routes against a running API, not only static render.
- API-backed empty/error states as first-class UI states.

## What Not To Reuse

- Old editorial visual language: serif typography, cinematic hero moments, dark dossier mood, or investor-style pacing.
- Old top-nav route structure: Desk, Archive, Board, Ask as the default product IA.
- Fake hero interactions or fixture-backed product claims.
- Static sample copy, seeded users, fixed local IDs, or local-only data assumptions.
- Pipeline-first navigation that makes jobs feel like the main product object for non-technical researchers.

## Reader-First App Slice

The app should now prove the source-reading happy path before expanding the product surface:

1. Bring one real local source through the existing pipeline with internal/dev tooling.
2. Verify `/sources` and `/sources/:id` against that source.
3. Fetch `/api/documents/:id/pdf` with app credentials as a Blob and render it in the app-controlled reader.
4. Keep story/entity/evidence annotations conservative and avoid claim/citation anchors until offsets exist.
5. Upgrade app smoke tests so `MULDER_SMOKE_SOURCE_ID` proves real reader content when configured.
6. Do not activate Search until search results can land on real source/story reader destinations.

### Local Reader Smoke Path

Use development or internal tooling to create the source; do not add checked-in app fixtures or fixed UUIDs.

Recommended local sequence:

1. Build the CLI/API/app packages.
2. Run the existing pipeline against a local PDF, for example `mulder pipeline run tests/data/pdf/Frontiers_of_Science_1980_v02-5-6.pdf --up-to graph`, using the local operator config.
3. Capture the produced source UUID from the pipeline output or `/api/documents`.
4. Run the app smoke with `MULDER_SMOKE_SOURCE_ID=<source-id>`.

Without `MULDER_SMOKE_SOURCE_ID`, `pnpm smoke:app` should still verify the app shell, `/sources`, `/evidence`, and `/runs` against empty/error states. With the variable set, it must prove real reader content, no iframe-based original pane, and mobile-safe reader behavior.

If Mulder needs a public example later, build it as a separate, explicitly labeled surface that does not point at a private production project and does not shape the production app.
