---
milestone: M1
title: "Mulder runs locally" — Foundation
reviewed: 2026-03-30
steps_reviewed: [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11]
spec_sections: ["§1", "§1.1", "§4.1", "§4.2", "§4.3", "§4.3.1", "§4.5", "§4.6", "§7.1", "§7.2", "§7.3", "§8", "§9.3", "§11", "§13", "§14"]
verdict: PASS
---

# Milestone Review: M1 — Foundation

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Warning  | 4 |
| Note     | 6 |

**Verdict:** PASS

M1 is solidly implemented. All 11 steps are complete, all core infrastructure works. The database schema DDL matches the spec exactly across 14 migration files. Config loader, error hierarchy, logging, retry, rate limiter, service abstraction, and Docker Compose all align with the functional spec. Three spec divergences (migration numbering, registry function name, Docker Compose approach) were resolved by updating the functional spec to match the implementation. Remaining warnings are expected scope boundaries (files planned for M2+ milestones). No issues block starting M2.

---

## Per-Section Divergences

### §1 — CLI Command Tree

**[DIV-001] Only `config` and `db` command groups are registered**
- **Severity:** NOTE
- **Spec says:** §1 (line 17-150) lists 18+ command groups (config, db, ingest, extract, segment, enrich, ground, embed, graph, analyze, pipeline, cache, worker, taxonomy, query, entity, export, fixtures, eval, retry, reprocess, status)
- **Code does:** `apps/cli/src/index.ts:13-22` only registers `config` and `db` commands
- **Evidence:** Only `commands/config.ts` and `commands/db.ts` exist in `apps/cli/src/commands/`
- **Note:** Expected — M1 only implements the CLI scaffold (A5). Remaining commands are M2-M8 scope.

**[DIV-002] `config init` subcommand not implemented**
- **Severity:** WARNING
- **Spec says:** §1 (line 22) lists `config init` — "Generate mulder.config.yaml from interactive prompts"
- **Code does:** `apps/cli/src/commands/config.ts` only implements `validate` and `show`
- **Evidence:** No `init` subcommand registered. The spec §1.1 (line 158) also lists `config.ts` as handling `config validate | show | init`

**[DIV-003] `db reset` and `db gc` subcommands not implemented**
- **Severity:** WARNING
- **Spec says:** §1 (line 26-27) lists `db reset` ("Drop and recreate all tables") and `db gc` ("Garbage-collect orphaned entities")
- **Code does:** `apps/cli/src/commands/db.ts` only implements `migrate` and `status`
- **Evidence:** No `reset` or `gc` subcommands registered

### §1.1 — CLI Architecture

**[DIV-004] CLI lib/prompts.ts not implemented**
- **Severity:** NOTE
- **Spec says:** §1.1 (line 182) lists `lib/prompts.ts` — "Interactive prompts (for config init, confirmations)"
- **Code does:** `apps/cli/src/lib/` contains only `errors.ts` and `output.ts`
- **Evidence:** Not needed until `config init` is implemented — future milestone scope

### §4.1 — Config Loader

No divergences found. Implementation matches spec:
- `loadConfig(path?: string): MulderConfig` signature matches (loader.ts:57)
- Zod schema covers all config sections documented in spec
- Defaults match (verified against defaults.ts)
- `ConfigValidationError` thrown on failure (loader.ts:67, 82, 97)
- Config is deep-frozen after loading (loader.ts:112)
- Path override parameter exists (loader.ts:59)

### §4.2 — Database Client

No divergences found. Implementation matches spec:
- Dual connection pools: worker (OLTP) and query (OLAP) (client.ts:65, 93)
- Worker pool: min 1, max 3 connections (client.ts:72-73)
- Query pool: min 2, max 10, statement_timeout 10s (client.ts:98-101)
- SSL for non-localhost connections (client.ts:48-51)
- Lazy singleton pattern (client.ts:28-29, 66, 94)

### §4.3 — Core Database Schema

**[DIV-005] Migration file numbering differed from spec — RESOLVED**
- **Severity:** ~~WARNING~~ RESOLVED
- **Resolution:** Spec §4.2 updated to match implementation's migration file naming (002_sources includes source_steps, 005_relationships combines story_entities + entity_edges, 008_indexes is separate). Code's organization is better — related tables grouped together.

**[DIV-006] v2.0 tables (009-011) not created as migration files**
- **Severity:** NOTE
- **Spec says:** §4.2 (line 773-775) lists 009_grounding.sql, 010_evidence.sql, 011_spatio_temporal.sql
- **Code does:** These files don't exist
- **Evidence:** These are v2.0 (M6) scope. The DDL is defined in the spec but implementation is deferred. Expected.

All table DDL, columns, types, constraints, foreign keys, indexes, and the HNSW vector index match the spec exactly. The cascading reset function and gc_orphaned_entities function (014_pipeline_functions.sql) match §4.3.1 exactly.

### §4.3.1 — Cascading Reset Function

No divergences found. Both `reset_pipeline_step()` and `gc_orphaned_entities()` in `014_pipeline_functions.sql` match the spec exactly (line 1054-1134).

### §4.5 — Service Abstraction

**[DIV-007] `services.gcp.ts` does not exist**
- **Severity:** WARNING
- **Spec says:** §4.5 (line 1184) lists `services.gcp.ts` — "Production: real GCP API calls"
- **Code does:** File does not exist in `packages/core/src/shared/`
- **Evidence:** The registry (registry.ts:62) throws a ConfigError when GCP mode is requested, noting "GCP services will be implemented in M2-B1"
- **Note:** M1 only requires dev services. GCP implementation is M2-B1 scope. The registry correctly gates this.

**[DIV-008] `cost-estimator.ts` does not exist**
- **Severity:** NOTE
- **Spec says:** §4.5 (line 1188) lists `cost-estimator.ts` — "Cost estimation for pipeline operations"
- **Code does:** File does not exist in `packages/core/src/shared/`
- **Evidence:** Cost estimation is M8-I2 scope

**[DIV-009] Registry function name differed from spec — RESOLVED**
- **Severity:** ~~WARNING~~ RESOLVED
- **Resolution:** Spec §4.5 updated to use `createServiceRegistry(config, logger)`. The name is more precise (it creates a registry, not services directly) and the `logger` parameter enables initialization logging.

### §4.6 — GCP Clients (Connection Manager)

**[DIV-010] `gcp.ts` does not exist**
- **Severity:** WARNING
- **Spec says:** §4.6 (line 1217) lists `gcp.ts` — "Connection manager — raw GCP SDK clients (lazy singletons)"
- **Code does:** File does not exist. Database connection pools are in `database/client.ts` instead.
- **Evidence:** The spec envisions `gcp.ts` as a connection manager holding ALL GCP clients (Storage, Document AI, Vertex AI, Firestore) plus the database pools. The implementation put database pools in `client.ts` and deferred GCP SDK clients to M2-B1.
- **Note:** This is partially expected — M2-B1 creates the full GCP connection layer. The database pools exist in the right location per the database spec (§4.2).

**[DIV-011] `types.ts` does not exist in shared/**
- **Severity:** NOTE
- **Spec says:** §4.6 (line 1220) lists `src/shared/types.ts` — "Shared TypeScript types"
- **Code does:** File does not exist. Types are defined in their respective modules (config/types.ts, services.ts interfaces)
- **Evidence:** No shared general-purpose types file needed yet

### §7.1 — Error Classes

No divergences found. Implementation matches spec exactly:
- `MulderError` base class with `code` and `context` (errors.ts:74-91)
- `ConfigError extends MulderError` (errors.ts:94-106)
- `PipelineError extends MulderError` (errors.ts:109-121)
- `DatabaseError extends MulderError` (errors.ts:124-136)
- `ExternalServiceError extends MulderError` (errors.ts:139-151)
- `isRetryableError()` type guard (errors.ts:166-171)

### §7.2 — Error Codes

No divergences found. All error codes from spec table (line 1576-1589) are implemented:
- CONFIG_NOT_FOUND, CONFIG_INVALID (errors.ts:16-19)
- DB_CONNECTION_FAILED, DB_MIGRATION_FAILED (errors.ts:34-37)
- PIPELINE_SOURCE_NOT_FOUND, PIPELINE_WRONG_STATUS, PIPELINE_STEP_FAILED, PIPELINE_RATE_LIMITED (errors.ts:24-29)
- EXT_DOCUMENT_AI_FAILED, EXT_VERTEX_AI_FAILED, EXT_STORAGE_FAILED (errors.ts:42-46)
- TAXONOMY_BOOTSTRAP_TOO_FEW (errors.ts:51-53)

### §7.3 — Retry Strategy

No divergences found. Implementation matches spec:
- Max retries: 3 (retry.ts:36)
- Base delay: 1000ms, multiplier: 2 (retry.ts:37-39)
- Full jitter backoff (retry.ts:53-57)
- Non-retryable errors thrown immediately (retry.ts:105-107)
- Rate limiter is token-bucket, per-service (rate-limiter.ts:48)

### §8 — Logging

No divergences found. Implementation matches spec:
- Pino-based structured JSON logging (logger.ts:14)
- ISO timestamps (logger.ts:140)
- Custom error serializer for MulderError (logger.ts:72-95)
- Child loggers with step/source_id/story_id context (logger.ts:187-189)
- Duration helper for timing (logger.ts:204-216)
- Pretty-print to stderr for dev, structured JSON for production (logger.ts:108-118)

### §9.3 — Local Infrastructure (Docker Compose)

**[DIV-012] Docker Compose approach differed from spec — RESOLVED**
- **Severity:** ~~WARNING~~ RESOLVED
- **Resolution:** Spec §9.3 updated to reflect the Dockerfile approach (pg17 + build-time PostGIS installation) with full service definitions, health checks, and volumes. The original spec approach (pg16 + init-script apt-get) fails because init scripts run as the non-root `postgres` user.

### §11 — Test Fixtures

No divergences found. Implementation matches spec:
- `fixtures/` directory exists at repo root with all 6 subdirectories: raw/, extracted/, segments/, entities/, embeddings/, grounding/
- README.md present with schema documentation
- Placeholder .gitkeep files for empty directories

### §13 — Source Layout

**[DIV-013] No `demo/` directory referenced in spec exists in unexpected context**
- **Severity:** NOTE
- **Spec says:** §13 (line 2228) lists `demo/` — "Demo UI (existing)"
- **Code does:** `demo/` directory exists from a previous phase
- **Evidence:** This is consistent. Not a divergence.

No divergences found. All directories listed in §13 exist:
- packages/core, packages/pipeline, packages/retrieval, packages/taxonomy, packages/worker, packages/evidence
- apps/cli, apps/api
- fixtures/, docs/, devlog/
- Repo root files: package.json, turbo.json, tsconfig.base.json, mulder.config.yaml

### §14 — Key Design Decisions

No divergences found. All architectural decisions are correctly reflected in implementation:
- Monorepo with pnpm + Turborepo (package.json, turbo.json)
- Single PostgreSQL instance for everything (all schema in one DB)
- Service abstraction pattern implemented (services.ts interfaces, registry.ts DI)
- CLI-first with Commander.js (apps/cli/src/index.ts:12)
- Zod for all validation (schema.ts uses Zod throughout)
- ESM only (all package.json have "type": "module")
- No Pub/Sub — job queue uses PostgreSQL (012_job_queue.sql)

---

## Cross-Cutting Convention Review

### Naming Conventions
All files follow `kebab-case.ts` convention. Types use `PascalCase` (e.g., `MulderConfig`, `StorageService`, `RateLimiter`). Functions use `camelCase` (e.g., `loadConfig`, `createServiceRegistry`, `withRetry`). Config keys use `snake_case` (e.g., `max_file_size_mb`, `dev_mode`, `cloud_sql`). No violations found.

### TypeScript Strictness
- `"strict": true` in `tsconfig.base.json` (inherited by all packages)
- `"type": "module"` in all package.json files (10/10)
- Zero `any` or `as any` in `packages/` or `apps/` source code
- Zero `as` type assertions in source code (only `as const` in defaults.ts for literal types, which is correct)

### Architecture Patterns
- No direct GCP SDK imports in pipeline-adjacent code (gcp.ts doesn't even exist yet)
- Config always loaded via `loadConfig()` — no direct YAML parsing outside the loader
- Zero `throw new Error()` in packages/ — all errors use custom error classes
- Zero `console.log` in packages/ or apps/ source code — all logging via pino
- Zod used for all runtime validation

### Package Structure
- All internal dependencies use `workspace:*` protocol (verified in 6 packages + 2 apps)
- Barrel exports (`index.ts`) present and complete in `packages/core/`
- TypeScript strict mode inherited from `tsconfig.base.json`

### Test Coverage
Tests exist for all 11 specs (specs 02-12). All tests are black-box — no imports from `packages/` or `apps/` source code. Tests use `spawnSync`/`execFileSync` for CLI commands and `docker exec` for database queries.

---

## CLAUDE.md Consistency

CLAUDE.md accurately reflects the functional spec and implementation. The architecture decisions, repo structure, key patterns, and code conventions documented in CLAUDE.md match both the spec and the actual codebase. One minor observation:

- CLAUDE.md lists `gcp.ts` in the Service Abstraction section as part of the current architecture, but the file doesn't exist yet (M2-B1 scope). This is slightly misleading but not incorrect — it documents the target architecture, not just the current state.

---

## Recommendations

### Must Fix (Critical)
None.

### Should Fix (Warning)
1. [DIV-002]: `config init` deferred — implement when interactive config generation is needed (M2 or later)
2. [DIV-003]: `db reset` and `db gc` deferred — implement when cascading reset is exercised (M3-C9)
3. [DIV-007]: Expected — `services.gcp.ts` will be created in M2-B1
4. [DIV-010]: Expected — `gcp.ts` connection manager will be created in M2-B1

### Resolved in This Review
- [DIV-005]: Spec §4.2 migration numbering updated to match implementation
- [DIV-009]: Spec §4.5 registry function updated to `createServiceRegistry(config, logger)`
- [DIV-012]: Spec §9.3 Docker Compose updated to Dockerfile approach with pg17

### For Consideration (Note)
1. [DIV-001]: Remaining CLI commands are M2-M8 scope — no action needed
2. [DIV-004]: `lib/prompts.ts` needed when `config init` is implemented
3. [DIV-006]: v2.0 migration files (009-011) will be created in M6
4. [DIV-008]: `cost-estimator.ts` is M8-I2 scope
5. [DIV-011]: `shared/types.ts` can be created when shared types are needed beyond service interfaces
6. [DIV-013]: Not a real divergence — `demo/` exists as expected
