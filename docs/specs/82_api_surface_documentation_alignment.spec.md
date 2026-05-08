---
spec: "82"
title: "API Surface Documentation Alignment"
roadmap_step: ""
functional_spec: ["§10.6"]
scope: single
issue: ""
created: 2026-04-18
---

# Spec 82: API Surface Documentation Alignment

## 1. Objective

Eliminate the remaining drift between the documented M7 API surface and the runtime that actually ships. The API now publishes an OpenAPI JSON contract at `/api/openapi.json`, while Scalar or a human-facing reference UI remain intentionally unmounted. This spec keeps documentation, middleware public-path exceptions, and config expectations aligned with that exact surface.

This is a cleanup/integrity spec, not a broad docs-portal spec. If the project later wants Scalar or another reference UI, that should land as explicit future work.

## 2. Boundaries

- **Roadmap Step:** N/A — off-roadmap M7 remediation follow-up for review note `DIV-005`
- **Target:** `docs/api-architecture.md`, `apps/api/src/middleware/auth.ts`, `packages/core/src/config/schema.ts`, `packages/core/src/config/types.ts`, `packages/core/src/config/defaults.ts`, `mulder.config.example.yaml`, `tests/specs/82_api_surface_documentation_alignment.test.ts`
- **In scope:** aligning documented public/protected routes, config keys, and middleware assumptions with the runtime that actually ships; verifying that `/api/openapi.json` is mounted and public; keeping `/doc` and `/reference` protected/unmounted; and black-box verification that auth middleware public-path exceptions match mounted routes
- **Out of scope:** implementing Scalar UI as a new feature, broad browser-auth work beyond whichever small config/public-path alignment remains after Spec 77, and unrelated API route functionality
- **Constraints:** prefer trimming docs and small runtime mismatches over introducing broad new feature scope; keep the API-architecture companion doc trustworthy; and do not leave middleware whitelist entries for routes the app does not mount

## 3. Dependencies

- **Requires:** Spec 70 (`M7-H4`) middleware stack and whichever auth/runtime shape is finalized by Spec 77 in this follow-up set
- **Blocks:** none directly, but this is required for a genuinely clean, trustable M7 documentation state

## 4. Blueprint

### 4.1 Files

1. **`docs/api-architecture.md`** — state that OpenAPI JSON is mounted while explorer UI remains unmounted
2. **`apps/api/src/middleware/auth.ts`** — align public-path exceptions with the routes the app truly mounts
3. **`packages/core/src/config/schema.ts`**, **`types.ts`**, **`defaults.ts`**, **`mulder.config.example.yaml`** — align the documented config surface with what the app actually reads after the auth cleanup
4. **`tests/specs/82_api_surface_documentation_alignment.test.ts`** — black-box verification that documented public paths and runtime public paths agree

### 4.2 Decision Rule

For this cleanup pass:

- browser-auth-related credential configuration belongs with Spec 77
- OpenAPI JSON should be documented as a mounted runtime contract
- unimplemented explorer/doc UI features should be documented as future work rather than silently implied to exist
- middleware should not treat `/doc` or `/reference` as public if the app does not mount them

### 4.3 Integration Points

- the architecture doc becomes trustworthy again for future implement/review flows
- middleware no longer whitelists phantom routes
- config docs stop promising keys or behaviors the runtime does not honor

### 4.4 Implementation Phases

Single phase — align docs, whitelist/config surface, and black-box verification together.

## 5. QA Contract

1. **QA-01: public-path middleware matches mounted runtime routes**
   - Given: the API app is started
   - When: requests are made to documented public paths and undocumented/unmounted doc paths
   - Then: only the actually mounted public routes bypass auth

2. **QA-02: API architecture docs describe OpenAPI JSON without promising explorer UI**
   - Given: the architecture companion doc and the current app runtime
   - When: a maintainer compares the documented API surface to the mounted routes/config
   - Then: the doc matches what actually ships

3. **QA-03: config example matches the runtime schema**
   - Given: `mulder.config.example.yaml` and the current config schema
   - When: the example config is validated
   - Then: documented API-related keys reflect the runtime-supported surface only

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

None — this work is documentation/runtime alignment only.
