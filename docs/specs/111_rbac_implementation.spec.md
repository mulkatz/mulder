---
spec: 111
title: "RBAC Implementation"
roadmap_step: "M11-L5"
functional_spec: "§A5.3, §A5, §A3"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/293"
created: 2026-05-07
---

# Spec 111: RBAC Implementation

## 1. Objective

Complete M11-L5 by turning the sensitivity metadata from M10-K5 into an enforceable role-based access layer. Mulder must resolve roles to permissions and maximum sensitivity levels, expose those roles through config and the database, and apply sensitivity filtering to read paths that return document, entity, and trust-layer artifacts.

This step is an enforcement foundation, not a product-facing role administration UI. It keeps the core domain-agnostic: roles are generic policy objects (`id`, `name`, `max_sensitivity_level`, `permissions`) and existing browser roles are mapped onto that policy without hard-coding domain semantics.

## 2. Boundaries

**Roadmap step:** M11-L5 - RBAC implementation - roles, permissions, sensitivity-based filtering.

**Base branch:** `milestone/11`. This spec is delivered to the M11 integration branch, not directly to `main`.

**Target branch:** `feat/293-rbac-implementation`.

**Primary files:**

- `packages/core/src/shared/access-control.ts`
- `packages/core/src/database/migrations/041_access_roles.sql`
- `packages/core/src/database/repositories/access-role.repository.ts`
- `packages/core/src/database/repositories/access-role.types.ts`
- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/database/repositories/source.types.ts`
- `packages/core/src/database/repositories/entity.repository.ts`
- `packages/core/src/database/repositories/entity.types.ts`
- `packages/core/src/database/repositories/story.repository.ts`
- `packages/core/src/database/repositories/story.types.ts`
- `packages/core/src/database/repositories/conflict-node.repository.ts`
- `packages/core/src/database/repositories/conflict-node.types.ts`
- `packages/core/src/database/repositories/review-workflow.repository.ts`
- `packages/core/src/database/repositories/review-workflow.types.ts`
- `packages/core/src/database/repositories/translated-document.repository.ts`
- `packages/core/src/database/repositories/translated-document.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/index.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/routes/documents.ts`
- `apps/api/src/routes/entities.ts`
- `apps/api/src/lib/documents.ts`
- `apps/api/src/lib/entities.ts`
- `mulder.config.example.yaml`
- `tests/lib/schema.ts`
- `tests/specs/111_rbac_implementation.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add role and permission primitives from §A5.3: `read`, `write`, `review`, `classify`, `delete`, `admin`, `export`, and `agent_config`.
- Add default role definitions that work from config defaults and `mulder.config.example.yaml` without requiring a missing `config/roles.yaml`.
- Add an `access_roles` table and repository APIs for listing, finding, and upserting role definitions.
- Preserve existing browser roles by mapping `member` to analyst-level read access and `admin`/`owner` to confidential admin access.
- Treat API-key principals as service/admin access for backward compatibility with existing CLI and automation paths.
- Add repository filtering by `max_sensitivity_level` for sources, entities, stories, conflict nodes, review artifacts, and translations.
- Apply read filtering in the document and entity API routes for browser session principals.

**Out of scope:**

- Role management UI, invitation-role redesign, multi-role memberships, organization/team hierarchies, or policy editing routes.
- External query gate behavior from §A5.4. L5 must leave clean helpers for it, but query sanitization belongs to a later agent milestone.
- Export filtering/audit from §A15 and agent web research filtering from §A16.
- Rewriting existing API auth tables or breaking the `owner`/`admin`/`member` browser auth contract.

**Architectural constraints:**

- Sensitivity comparisons must use the canonical order `public < internal < restricted < confidential`.
- Filtering must deny by default when access control is enabled and a role cannot be resolved.
- Config defaults must be self-contained. `roles_source` may remain as future metadata, but runtime tests must not read a missing roles file.
- Filtering must be explicit at read boundaries; write paths must continue to persist sensitivity metadata rather than dropping it.
- API-key behavior must remain backward compatible unless a future spec introduces scoped API keys.

## 3. Dependencies

- M10-K5 / Spec 102: sensitivity levels and metadata exist on core artifacts.
- M11-L1 / Spec 107: credibility profiles exist and are source-owned trust artifacts.
- M11-L2 / Spec 108: conflict nodes carry sensitivity metadata.
- M11-L3 / Spec 109: review artifacts and queues exist.
- M11-L4 / Spec 110: translated documents carry sensitivity metadata.

L5 completes the M11 trust-layer enforcement foundation and blocks later export filtering, external query gates, and agent research safety.

## 4. Blueprint

1. Add core access-control helpers:
   - Define `AccessPermission`, `AccessRole`, `AccessPolicy`, `AccessPrincipalKind`, and default role definitions.
   - Provide `resolveAccessPolicy`, `canReadSensitivityLevel`, `hasAccessPermission`, `allowedSensitivityLevelsForMax`, and browser-role mapping helpers.
   - When `access_control.enabled` is false, return full read access for compatibility.

2. Add config support:
   - Extend `access_control.rbac` with a `roles` array matching §A5.3 while keeping `roles_source` and `default_role`.
   - Populate defaults and example config with generic roles.
   - Keep minimal configs valid when `access_control` is omitted.

3. Add the `access_roles` data model:
   - Create migration `041_access_roles.sql` with constrained sensitivity levels and permission values.
   - Seed the generic default roles idempotently.
   - Add repository APIs and exports for role listing and upsert.

4. Add repository sensitivity filters:
   - Add `maxSensitivityLevel` options to relevant filter types.
   - Use allowed-level lists rather than lexical comparison.
   - For review artifacts, filter on `context.sensitivity_level` with `internal` fallback until review artifacts get first-class sensitivity columns in a later spec.

5. Apply API read filtering:
   - Pass `authPrincipal` from document/entity routes into route libraries.
   - Resolve a policy from full config and the principal.
   - Filter list/detail/story/edge reads so browser members cannot read artifacts above their max sensitivity.
   - Keep API keys as service-level access.

6. Update roadmap state:
   - Mark L5 in progress during implementation and complete only after verification, review, PR CI, and merge to `milestone/11`.

## 5. QA Contract

1. **QA-01: Role schema and defaults are self-contained**
   - Given `mulder.config.example.yaml` and a minimal config without `access_control`
   - When the config is loaded
   - Then `access_control.rbac.roles` includes generic analyst/reviewer/admin roles with permissions and max sensitivity levels, and no missing roles file is read.

2. **QA-02: Access helpers enforce the sensitivity lattice**
   - Given a member/analyst policy with max `internal` and an admin policy with max `confidential`
   - When sensitivity checks are evaluated for all four levels
   - Then analyst can read only `public` and `internal`, while admin can read all levels.

3. **QA-03: Roles persist and round-trip**
   - Given the migrated database
   - When default roles are listed and a custom role is upserted
   - Then persisted roles preserve id, name, max sensitivity level, and permission set.

4. **QA-04: Repository filters hide over-sensitive artifacts**
   - Given sources, entities, stories, conflict nodes, review artifacts, and translated documents across sensitivity levels
   - When queries are run with `maxSensitivityLevel = internal`
   - Then restricted and confidential artifacts are omitted, while admin-level queries can see them.

5. **QA-05: API routes apply session sensitivity filters**
   - Given browser session principals mapped to member and admin roles
   - When document and entity list/detail routes are requested
   - Then member responses omit restricted/confidential artifacts and admin responses include them.

6. **QA-06: Existing API-key behavior stays compatible**
   - Given an API-key principal
   - When the same filtered routes are requested
   - Then the service policy can read confidential artifacts, preserving existing automation behavior.

## 5b. CLI Test Matrix

N/A - no CLI commands are added or changed in this step.

## 6. Cost Considerations

No paid services are introduced. The implementation is database/config/API logic only. Tests must avoid live GCP, Vertex, or external network calls and must use example/temp configs rather than a missing root `mulder.config.yaml`.
