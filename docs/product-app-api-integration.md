# Mulder Product App API Integration Notes

**Status:** Active implementation reference for `apps/app`
**Related:** [`product-app-design-strategy.md`](./product-app-design-strategy.md), [`product-app-deployment.md`](./product-app-deployment.md), [`api-architecture.md`](./api-architecture.md)

This document is the active API integration reference for the Mulder product app. It is not a visual or interaction-design reference. The product app must continue to follow the cleaner, research-first direction in `docs/product-app-design-strategy.md`.

## Integration Posture

`apps/app` should bind to stable HTTP contracts early, but Mulder's backend remains CLI/domain/queue-first. Browser routes should consume API read models and enqueue jobs; they should not move business logic into UI-shaped endpoints.

The app should use:

- `VITE_API_BASE_URL` as the browser API origin.
- `VITE_API_PROXY_TARGET` for local same-origin `/api` proxying during Vite development.
- `credentials: 'include'` for all authenticated API calls.
- Cookie-backed browser sessions, not bundled bearer tokens.
- Explicit loading, empty, unavailable, and error states.
- No showcase IDs or checked-in product-screen fixtures in `apps/app`.

The product app API client should keep these properties:

- `ApiError` carries `status`, `code`, `message`, and optional `details`.
- Error responses are parsed from `{ error: { code, message, details } }` when available.
- JSON helpers set `Content-Type: application/json`.
- Text helpers use `Accept: text/markdown, text/plain`.
- `buildApiUrl(path)` passes through absolute URLs and prefixes relative API paths with `VITE_API_BASE_URL`.

React Query should use conservative defaults:

- Short stale time for dashboard and status data.
- No refetch on window focus by default.
- No retry for `401`, `403`, or `404`.
- Limited retry for transient network/server failures.
- Session expiry should be observable through a shared `auth:expired` event or equivalent app-level handling.

The product app should expose:

- `/login` for email/password authentication.
- `/auth/invitations/:token` for invite acceptance, matching the API-generated invitation link shape.
- Protected product routes behind `GET /api/auth/session`.
- Logout through `POST /api/auth/logout` and query-cache clearing.

## Usable HTTP Surface

These endpoints are the first candidates for `apps/app` because they already represent usable browser-facing contracts.

| Area | Endpoint | Notes |
| --- | --- | --- |
| Health | `GET /api/health` | Public service health. Useful for deployment smoke checks. |
| Auth | `GET /api/auth/session` | Session bootstrap for protected product routes. |
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
| Documents | `GET /api/documents/:id/pdf` | PDF document stream. |
| Documents | `GET /api/documents/:id/layout` | Markdown layout text. |
| Documents | `GET /api/documents/:id/pages` | Page image metadata. |
| Documents | `GET /api/documents/:id/pages/:pageNumber` | Page image stream. |
| Documents | `GET /api/documents/:id/stories` | Story list and story metadata. |
| Documents | `GET /api/documents/:id/observability` | Document processing timeline/read model. |
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

This mapping captures the product app's hook-per-contract shape.

| Legacy hook | API contract | Product-app use |
| --- | --- | --- |
| `useSession` | `GET /api/auth/session` | AuthGate/session bootstrap. |
| `useLogin` | `POST /api/auth/login` | Login screen. |
| `useLogout` | `POST /api/auth/logout` | Account menu/logout. |
| `useAcceptInvite` | `POST /api/auth/invitations/accept` | Invite acceptance route. |
| `useCreateInvite` | `POST /api/auth/invitations` | Future admin settings. |
| `useStatus` | `GET /api/status` | Overview pulse and capacity signals. |
| `useJobs` | `GET /api/jobs` | Operations/Analysis Runs table. |
| `useJob` | `GET /api/jobs/:id` | Selected run inspector. |
| `useDocuments` | `GET /api/documents` | Documents list and corpus counts. |
| `useDocumentLayout` | `GET /api/documents/:id/layout` | Future document reader. |
| `useDocumentPages` | `GET /api/documents/:id/pages` | Future document reader. |
| `usePdfUrl` | `GET /api/documents/:id/pdf` | Future PDF pane. |
| `useStoriesForDocument` | `GET /api/documents/:id/stories` | Future story/evidence reader. |
| `useEntities` | `GET /api/entities` | Entities list. |
| `useEntity` | `GET /api/entities/:id` | Entity inspector/profile. |
| `useEntityEdges` | `GET /api/entities/:id/edges` | Entity-local graph context. |
| `useSearch` | `POST /api/search` | Research search route. |
| `useEvidenceSummary` | `GET /api/evidence/summary` | Overview and Evidence Workspace. |
| `useContradictions` | `GET /api/evidence/contradictions` | Evidence Workspace. |
| `useEvidenceReliabilitySources` | `GET /api/evidence/reliability/sources` | Trust/source panels. |
| `useEvidenceChains` | `GET /api/evidence/chains` | Future evidence-chain drilldown. |
| `useEvidenceClusters` | `GET /api/evidence/clusters` | Future spatial/temporal review. |
| `useDocumentUpload` | upload initiate -> transport -> complete -> job polling | Future document ingest flow after product gates are satisfied. |

## Known Product-App API Gaps

These gaps should be visible in the app capability registry instead of hidden behind fake data.

| Capability | Current issue |
| --- | --- |
| Analysis run facade | Jobs exist, but product-shaped run summaries, artifacts, step timings, and retry affordances are still partial. |
| Evidence claims | Summary and contradictions exist, but first-class claim records, review decisions, and assertion history need a product contract. |
| Provenance and trust gate | M10 provenance, document quality, sensitivity/RBAC, custody, rollback, and source credibility are product gates for real archive ingest. |
| Graph aggregate | Entity-local edges exist, but product graph views need an aggregate or batched graph read model. |
| Activity feed | No cross-system event stream exists yet. |
| Usage/cost surface | Status exposes budget pieces, but product usage views need a broader read model. |
| Settings/admin | Auth invitations exist, but workspace policy, roles, config, and product settings are future work. |
| Production upload UX | Upload contracts exist, but real archive ingest should not be promoted until the trust/provenance gate is resolved or explicitly waived. |

## What To Reuse

- API client shape and credential behavior.
- React Query defaults and query-key discipline.
- Hook-per-contract structure.
- Upload session sequence.
- Playwright smoke-test idea: verify real routes against a running API, not only static render.
- API-backed empty/error states as first-class UI states.

## What Not To Reuse

- Old editorial visual language: serif typography, cinematic hero moments, dark dossier mood, or investor-showcase pacing.
- Old top-nav route structure: Desk, Archive, Board, Ask as the default product IA.
- Fake hero interactions or fixture-backed product claims.
- Showcase-specific copy, seeded users, fixed showcase IDs, or local-only data assumptions.
- Pipeline-first navigation that makes jobs feel like the main product object for non-technical researchers.

## First API Slice

After the cleanup, the first product-app API implementation should stay narrow:

1. Add the API client, local API types, React Query provider, and capability registry to `apps/app`.
2. Bind existing routes only: `/`, `/runs`, and `/evidence`.
3. Use real loading/empty/error states.
4. Do not use checked-in fixture data in product screens.
5. Do not add new product modules until the API foundation is green.

If Mulder needs a public, stable showcase later, build it as a separate, explicitly labeled surface with fixed showcase data. That surface must not be the product app and must not point at a private production project.
