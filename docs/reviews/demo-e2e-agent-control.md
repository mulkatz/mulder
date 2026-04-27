# Demo E2E Agent-Control And Full Functional Coverage

Created for `codex/demo-e2e-agent-control` and extended by `codex/full-functional-demo`.

## Covered Now

- #195 Browser-safe auth: covered by real cookie login, logout, invite acceptance, and protected-route auth gate checks.
- #212 Archive + Desk: covered by real Desk metrics, evidence summary, status/jobs, recent documents, leads, Archive filtering/sorting, preview thumbnails, and browser upload through the worker.
- #213 Ask + Command Palette: covered by `POST /api/search` with `explain: true`, citation rendering, citation-to-Case-File navigation, retrieval trace, command palette navigation, upload action, audit action, theme action, and logout action.
- #215 Board: covered by entity graph rendering via `GET /api/entities` and capped per-entity edge fetches, graph/list modes, filters, and node-to-drawer interaction.
- #216 Audit Drawer: covered by global drawer access, Summary, Contradictions, Source Reliability, Evidence Chains, and Clusters tabs using the current read-only evidence API.
- #218 M7.5-V1 viewer foundations: covered by authenticated app boot, theme persistence, Archive navigation, Case File render, PDF canvas, story frames, entity hover, entity drawer, and reading mode.
- #220 V1 Case File acceptance: covered by the same V1 browser tests against a deterministic real-stack fixture.

## Explicitly Future

- #217 Demo polish and asset production: partially covered by route error boundaries, shortcut overlay, keyboard-accessible list view, and browser flow tests. Screenshot/GIF production and CI rollout remain future work.
- V2-V6 product work remains out of scope: OAuth/password reset, owner management UI, bulk graph edge API, evidence mutation APIs, production Cloudflare deploy, visual intelligence, provenance, and mobile redesign.

## Agent-Control Contract

The browser harness must fail on console errors, uncaught page errors, failed requests, and unexpected `/api` 4xx/5xx responses. The only globally tolerated API error is the expected unauthenticated `GET /api/auth/session` 401 used by the login/auth-gate path. The dev-upload PUT has one narrow Vite-proxy abort allowance; completion is verified through the real finalize job API.

## Current Green Gates

- `cd demo && npm run build`
- `cd demo && npm run lint`
- `cd demo && npm run test:e2e`
- `pnpm test:api:e2e`
