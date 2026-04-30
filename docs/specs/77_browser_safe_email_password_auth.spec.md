---
spec: "77"
title: "Browser-Safe Email/Password Session Auth For The Product App"
roadmap_step: ""
functional_spec: ["§10.6", "§13"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/195"
created: 2026-04-18
---

# Spec 77: Browser-Safe Email/Password Session Auth For The Product App

## 1. Objective

Deliver browser-safe, cookie-backed session auth for the product app. This spec closes the browser auth gap by defining the auth/session routes, cookie behavior, role-gated invite flow, and browser-compatible middleware path needed for `apps/app` to consume the real API without embedding bearer keys in the web bundle.

The functional-spec authority here is partial: `§10.6` governs the API boundary and `§13` governs the source layout. The active product-app implementation reference is `docs/product-app-api-integration.md`.

## 2. Boundaries

- **Roadmap Step:** N/A — M7/M7.5 remediation follow-up restoring the browser auth prerequisite
- **Target:** `packages/core/src/config/schema.ts`, `packages/core/src/config/types.ts`, `packages/core/src/config/defaults.ts`, `mulder.config.example.yaml`, `apps/api/src/app.ts`, `apps/api/src/middleware/auth.ts`, `apps/api/src/routes/auth.schemas.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/lib/auth.ts`, `apps/app/vite.config.ts`, `apps/app/src/lib/api-client.ts`, `apps/app/src/features/auth/useSession.ts`, `apps/app/src/features/auth/useLogin.ts`, `apps/app/src/features/auth/useLogout.ts`, `apps/app/src/features/auth/useAcceptInvitation.ts`, `apps/app/src/app/AuthGate.tsx`, `tests/specs/77_browser_safe_email_password_auth.test.ts`
- **In scope:** cookie-backed browser login/logout/session routes; invitation acceptance and admin-gated invitation issuance; explicit role handling for `owner`, `admin`, and `member`; middleware support for session-authenticated browser requests alongside existing operator/API-key flows; dev-mode same-origin proxy alignment for the product app; and black-box verification that the product app can authenticate and then call protected API routes without embedding bearer tokens
- **Out of scope:** OAuth/OIDC/SSO, password-reset flows, admin invitation management UI beyond create-invite, full ACL/RBAC beyond role gating, non-browser SDK auth, and unrelated OpenAPI/Scalar work
- **Constraints:** the browser bundle must never carry a static API key; session cookies must be `HttpOnly`; auth failures on login must remain generic; protected read routes must accept valid session auth from the browser; and the implementation must not regress CLI/server-side bearer-key access where that path is still intentionally used

## 3. Dependencies

- **Requires:** Spec 69 (`M7-H3`) Hono server scaffold, Spec 70 (`M7-H4`) middleware stack, Spec 76 (`M7-H10`) document retrieval routes, and the current product app auth hooks/pages under `apps/app/src/features/auth/*` and `apps/app/src/pages/*`
- **Blocks:** a fully clean browser product app integration story, because the current web app assumes this auth model for all protected API access

## 4. Blueprint

### 4.1 Files

1. **`packages/core/src/config/schema.ts`**, **`types.ts`**, **`defaults.ts`**, **`mulder.config.example.yaml`** — add the browser-auth config surface needed for session secret/cookie/invite settings without breaking non-web workflows
2. **`apps/api/src/routes/auth.schemas.ts`** — define Zod-backed request/response contracts for login, logout, session, invitation acceptance, and invitation creation
3. **`apps/api/src/lib/auth.ts`** — implement session creation/validation/clearing plus invitation acceptance/issuance helpers behind one route-facing library boundary
4. **`apps/api/src/routes/auth.ts`** — mount `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/invitations/accept`, and `POST /api/auth/invitations`
5. **`apps/api/src/middleware/auth.ts`** and **`apps/api/src/app.ts`** — extend protected-route auth so browser session cookies can authorize the same read surfaces the product app uses, while preserving explicit public-path behavior and intentional operator-key support where documented
6. **`apps/app/vite.config.ts`** and **`apps/app/src/lib/api-client.ts`** — keep the browser fetch path same-origin in dev and credential-aware in all environments
7. **`apps/app/src/features/auth/*`** and **`apps/app/src/app/AuthGate.tsx`** — align the existing auth hooks/gate with the real API contract rather than preview-only fallbacks
8. **`tests/specs/77_browser_safe_email_password_auth.test.ts`** — add black-box verification for the API auth/session flow and the browser-facing contract

### 4.2 Route Contract

The browser-facing auth contract is:

- `POST /api/auth/login`
  - body: `{ email, password }`
  - success: `200 { user, expires_at }` plus session cookie
  - failure: `401` generic invalid-credentials error
- `POST /api/auth/logout`
  - success: `204` and cookie cleared
- `GET /api/auth/session`
  - success: `200 { user, expires_at }`
  - failure: `401` when no valid session exists
- `POST /api/auth/invitations/accept`
  - body: `{ token, password }`
  - success: `200 { user, expires_at }` plus session cookie
  - failures: invalid password, missing token, expired/consumed invite
- `POST /api/auth/invitations`
  - allowed for operator API key or session role `owner|admin`
  - denied for session role `member`
  - response never includes the raw invite token
  - API delivers the raw invite link server-side: log delivery in local/dev, transactional email in production

### 4.3 Auth Model

- Browser sessions are cookie-based and `HttpOnly`
- The browser uses `credentials: 'include'`; it does not send a bearer key
- CLI/server-side flows may continue to use bearer keys where those surfaces are intentionally operator-only
- Protected read routes used by the product app (`/api/documents*`, `/api/search`, `/api/entities*`, `/api/evidence*`) must accept a valid browser session

### 4.4 Integration Points

- The existing `apps/app` auth hooks should remain real clients of the API rather than preview-mode placeholders
- The middleware contract must stop treating browser auth as out of scope for product app paths
- The invite flow in the UI and the admin-gated invite API must agree on roles, expiration semantics, and generic failure copy
- Dev mode must use the Vite proxy path so cookies behave same-origin during local work
- Production invite links use `MULDER_APP_BASE_URL` and delivery is selected by `MULDER_INVITE_DELIVERY` (`log` or `resend`)

### 4.5 Implementation Phases

**Phase 1: spec recovery + API contract**
- restore the missing spec artifact
- add config, schemas, and route/library scaffolding
- define cookie and invitation behavior explicitly

**Phase 2: middleware and session enforcement**
- extend middleware to validate browser sessions on protected routes
- preserve operator-key behavior where documented
- wire the auth route family into the app

**Phase 3: product-app alignment + QA**
- align `apps/app` auth hooks and proxy behavior with the real backend
- verify protected document/search/entity/evidence routes work through session auth
- close preview-only assumptions that mask missing backend auth

## 5. QA Contract

1. **QA-01: browser login creates a valid session**
   - Given: a valid invited user account
   - When: `POST /api/auth/login` is called with correct credentials
   - Then: the response is `200`, includes `user` and `expires_at`, and sets a valid session cookie

2. **QA-02: invalid login remains generic**
   - Given: a wrong email/password combination
   - When: `POST /api/auth/login` is called
   - Then: the response is `401` with one generic invalid-credentials path that does not reveal which field was wrong

3. **QA-03: session bootstrap works for the browser**
   - Given: a valid session cookie
   - When: `GET /api/auth/session` is called
   - Then: the response is `200` with the current user and expiry data

4. **QA-04: unauthenticated browsers cannot access protected data routes**
   - Given: no valid bearer token and no valid session cookie
   - When: a protected read route such as `/api/documents` or `/api/search` is requested
   - Then: the response is `401`

5. **QA-05: authenticated browsers can access protected data routes without a bearer key**
   - Given: a valid browser session cookie and no `Authorization` header
   - When: the browser calls `/api/documents`, `/api/search`, `/api/entities`, or `/api/evidence`
   - Then: the request succeeds under the session auth path

6. **QA-06: invite acceptance creates a session and rejects expired tokens cleanly**
   - Given: one valid invitation and one expired/consumed invitation
   - When: `POST /api/auth/invitations/accept` is called
   - Then: the valid token returns `200` plus session cookie, and the invalid token returns the documented non-success response without partial session creation

7. **QA-07: invitation creation is role-gated**
   - Given: one `admin` or `owner` session and one `member` session
   - When: `POST /api/auth/invitations` is called
   - Then: the admin/owner request succeeds and the member request returns `403`

8. **QA-08: local browser dev uses same-origin credentials**
   - Given: `apps/app` is run through the documented Vite dev setup
   - When: the browser logs in and then requests a protected route
   - Then: the session cookie is sent successfully without embedding any API key in frontend code

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

- **Services called:** none beyond the existing API/database/auth persistence path
- **Estimated cost per run:** negligible; no new LLM or Document AI traffic is required
- **Dev mode alternative:** yes — browser auth should be verifiable locally via same-origin proxy
- **Safety flags:** cookies must be `HttpOnly`; raw invite tokens must not be returned by the invitation-create route
