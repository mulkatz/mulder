---
spec: 02
title: Monorepo Setup — pnpm, Turborepo, TypeScript, Biome
roadmap_step: M1-A1
functional_spec: ["§13", "§14"]
scope: single
created: 2026-03-29
issue: https://github.com/mulkatz/mulder/issues/4
---

# Spec 02: Monorepo Setup — pnpm, Turborepo, TypeScript, Biome

## 1. Objective

Scaffold the mulder monorepo with pnpm workspaces, Turborepo build orchestration, shared TypeScript configuration (strict mode, ESM), and Biome for linting/formatting. After this step, every package compiles independently and `pnpm turbo run build` succeeds with zero errors. No runtime logic — pure project infrastructure.

## 2. Boundaries

**In scope:**
- Root `package.json` (pnpm workspace root, scripts, devDependencies)
- `pnpm-workspace.yaml` declaring `packages/*` and `apps/*`
- `turbo.json` with `build`, `lint`, `typecheck` pipelines
- `tsconfig.base.json` (shared strict-mode ESM config)
- `biome.json` (linting + formatting rules)
- 6 packages: `core`, `pipeline`, `retrieval`, `taxonomy`, `worker`, `evidence` — each with `package.json`, `tsconfig.json`, `src/index.ts` (empty barrel export)
- 2 apps: `cli`, `api` — each with `package.json`, `tsconfig.json`, `src/index.ts` (placeholder)
- `.gitignore` updates for `node_modules`, `dist/`, `*.tsbuildinfo`
- Vitest config at root level

**Out of scope:**
- Runtime code (config loader, logger, errors, etc. — later steps)
- Docker Compose (M1-A11)
- Database anything (M1-A6/A7)
- CI/CD pipelines
- Any GCP dependencies

**Architecture constraints:**
- TypeScript strict mode, ESM only (`"type": "module"`)
- Node 20+ (LTS)
- pnpm 9+ (Corepack)
- Package references use `workspace:*` protocol
- Per §13: exact directory structure from functional spec
- Per §14: clear package boundaries, no circular imports

## 3. Dependencies

### Requires
- None (first step in the roadmap)

### Enables
- All subsequent M1 steps (A2–A11) depend on the monorepo scaffold
- All packages will extend `tsconfig.base.json`
- All packages will use the workspace dependency resolution

## 4. Blueprint

### 4.1 Root Configuration Files

**`package.json`**
```json
{
  "name": "mulder",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.4",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "turbo": "^2.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**`pnpm-workspace.yaml`**
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

**`turbo.json`**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {}
  }
}
```

**`tsconfig.base.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  }
}
```

**`biome.json`**
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab",
    "lineWidth": 120
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always"
    }
  },
  "files": {
    "ignore": ["node_modules", "dist", ".turbo", "fixtures", "demo"]
  }
}
```

**`vitest.config.ts`**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
```

### 4.2 Package Structure

Each package follows the same pattern:

| Package | Name | Internal Dependencies |
|---------|------|-----------------------|
| `packages/core` | `@mulder/core` | none |
| `packages/pipeline` | `@mulder/pipeline` | `@mulder/core`, `@mulder/retrieval`, `@mulder/taxonomy` |
| `packages/retrieval` | `@mulder/retrieval` | `@mulder/core` |
| `packages/taxonomy` | `@mulder/taxonomy` | `@mulder/core` |
| `packages/worker` | `@mulder/worker` | `@mulder/core`, `@mulder/pipeline` |
| `packages/evidence` | `@mulder/evidence` | `@mulder/core` |
| `apps/cli` | `@mulder/cli` | `@mulder/core`, `@mulder/pipeline`, `@mulder/retrieval`, `@mulder/taxonomy`, `@mulder/evidence`, `@mulder/worker` |
| `apps/api` | `@mulder/api` | `@mulder/core`, `@mulder/retrieval`, `@mulder/taxonomy`, `@mulder/evidence`, `@mulder/worker` |

Per §13 package dependency graph.

**Each package `package.json`:**
```json
{
  "name": "@mulder/{name}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc --build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    // workspace:* references per table above
  }
}
```

**Each package `tsconfig.json`:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    // project references matching dependencies
  ]
}
```

**Each `src/index.ts`:** Empty barrel export (`export {};`) to make build succeed.

### 4.3 Directory Scaffolding

Create empty directories matching §13 source layout:
- `packages/core/src/config/`
- `packages/core/src/database/`
- `packages/core/src/shared/`
- `packages/core/src/prompts/`
- `packages/pipeline/src/{ingest,extract,segment,enrich,ground,embed,graph,analyze}/`
- `packages/retrieval/src/`
- `packages/taxonomy/src/`
- `packages/worker/src/`
- `packages/evidence/src/`
- `apps/cli/src/commands/`
- `apps/cli/src/lib/`
- `apps/api/src/routes/`
- `apps/api/src/middleware/`

### 4.4 .gitignore Updates

Append to existing `.gitignore`:
```
# Build outputs
dist/
*.tsbuildinfo
.turbo/

# Dependencies (already have node_modules but be explicit)
node_modules/
```

### 4.5 Implementation Phases

**Phase 1:** Root config files (package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, biome.json, vitest.config.ts)
**Phase 2:** Core package (packages/core) — no dependencies, the foundation
**Phase 3:** Leaf packages (pipeline, retrieval, taxonomy, evidence) — depend only on core
**Phase 4:** Worker package — depends on core + pipeline
**Phase 5:** Apps (cli, api) — depend on multiple packages
**Phase 6:** `pnpm install` + `pnpm turbo run build` + `biome check` — verify everything compiles

## 5. QA Contract

### Condition: build-succeeds
- `pnpm turbo run build` exits 0
- Every package produces `dist/index.js` and `dist/index.d.ts`

### Condition: typecheck-succeeds
- `pnpm turbo run typecheck` exits 0 (strict mode, no errors)

### Condition: lint-passes
- `npx biome check .` exits 0 with no warnings or errors

### Condition: workspace-resolution
- `pnpm ls --depth 0 -r` shows all 8 workspace packages
- Internal dependencies resolve to `workspace:*` (not registry versions)

### Condition: package-structure
- Each of the 8 packages has `package.json`, `tsconfig.json`, `src/index.ts`
- Directory structure matches §13 layout

### Condition: esm-only
- Every `package.json` has `"type": "module"`
- `tsconfig.base.json` uses `"module": "Node16"` (ESM)
- No `require()` anywhere — all imports are ESM `import`

### Condition: strict-mode
- `tsconfig.base.json` has `"strict": true`
- No `any` types, no `as` assertions in scaffolding code

### Condition: no-circular-deps
- Package dependency graph is a DAG (no cycles)
- `packages/core` has zero internal dependencies
