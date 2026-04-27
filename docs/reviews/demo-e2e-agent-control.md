# Demo E2E Agent-Control Coverage

Created for branch `codex/demo-e2e-agent-control`.

## Covered Now

- #195 Browser-safe auth: covered by real cookie login, logout, invite acceptance, and protected-route auth gate checks.
- #218 M7.5-V1 viewer foundations: covered by authenticated app boot, theme persistence, Archive navigation, Case File render, PDF canvas, story frames, entity hover, entity drawer, and reading mode.
- #220 V1 Case File acceptance: covered by the same V1 browser tests against a deterministic real-stack fixture.

## Explicitly Future

- #212 Archive + Desk: not implemented here beyond current Archive list navigation and Desk placeholder health.
- #213 Ask + Command Palette: placeholder render only.
- #215 Board: placeholder render only.
- #216 Audit Drawer: out of scope for this branch.
- #217 Polish + demo asset production: out of scope except for the reusable Playwright foundation.

## Agent-Control Contract

The browser harness must fail on console errors, uncaught page errors, failed requests, and unexpected `/api` 4xx/5xx responses. The only globally tolerated API error is the expected unauthenticated `GET /api/auth/session` 401 used by the login/auth-gate path.
