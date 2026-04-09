---
spec: 49
title: Minimal Document Viewer (split-view PDF + Markdown)
roadmap_step: "off-roadmap (demoability)"
functional_spec: "§2.2 (extract step), §13 (source layout)"
scope: phased
issue: https://github.com/mulkatz/mulder/issues/127
created: 2026-04-09
---

# Spec 49: Minimal Document Viewer (split-view PDF + Markdown)

## 1. Objective

Build a minimal, local-only web viewer that shows, for each document Mulder has processed through the Extract step, the raw PDF on the left and the derived `layout.md` on the right, side by side. This is the first demoable UI for Mulder and the direct consumer of spec 48's `layoutToMarkdown` output.

The viewer is a Vite + React + Tailwind app living under `demo/` as its own pnpm workspace (`@mulder/demo`). It runs entirely in Vite dev mode via `pnpm --filter @mulder/demo dev`. A small Vite dev plugin scans the local filesystem and exposes three HTTP endpoints: list documents, serve PDF bytes, serve Markdown text. **No backend process, no database, no Mulder runtime imports.**

**Why now:** Spec 48 (merged earlier today) produces `layout.md` alongside `layout.json` on every Extract run, but there is no way to see the output next to the original PDF without opening two files in an editor. The viewer closes that loop — a user can run `mulder ingest foo.pdf && mulder extract <id>` and then instantly see the result side by side. It also works out-of-the-box against the committed fixture goldens so a fresh clone of the repo is demoable without running the pipeline first. Off-roadmap demoability feature, same family as spec 48.

**Spec refs:** §2.2 (Extract step contract — the source of `layout.md`), §13 (source layout — the `demo/` directory already reserved in the repo tree).

## 2. Boundaries

### In scope

- New pnpm workspace `@mulder/demo` at `demo/` with its own `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, Tailwind config, and `src/` tree.
- **Vite dev plugin** (`demo/vite/document-source-plugin.ts`) that registers middleware in `configureServer`:
  - `GET /api/documents` → JSON array of discovered documents (unified from `.local/storage/` and `fixtures/`)
  - `GET /api/pdf/:source/:id` → raw PDF bytes with `Content-Type: application/pdf`
  - `GET /api/markdown/:source/:id` → Markdown text with `Content-Type: text/markdown; charset=utf-8`
  - Directory-traversal protection: `:id` must be a UUID (v4) for `source=local` or match a hardcoded fixture whitelist for `source=fixture`. Reject with 400 otherwise.
- **Document discovery:** the plugin scans two sources and returns a unified list:
  1. **Local** — for each subdirectory in `.local/storage/extracted/` that contains BOTH `layout.md` AND `layout.json`, AND where `.local/storage/raw/{id}/original.pdf` exists, add `{ id, source: 'local', title, pageCount, extractedAt }`. The ID is the directory name (UUID).
  2. **Fixture** — for each fixture in `fixtures/extracted/` that has BOTH `layout.json` AND a matching golden at `eval/golden/layout-markdown/{name}.md`, AND where `fixtures/raw/{name}.pdf` exists, add `{ id, source: 'fixture', title, pageCount, extractedAt }`. The ID is the fixture name (e.g. `native-text-sample`).
- **Title derivation:** for each document, try to extract the first `# heading` line from the Markdown as a human-readable title. If no heading, use `sourceId.slice(0, 8) + '…'` (local) or the fixture name (fixture). Displayed in the document list.
- **React UI** with three routes/views:
  - `/` — document list (left-rail or centered list layout, one row per document, click to open)
  - `/doc/:source/:id` — split view (50/50, PDF left / Markdown right)
  - Empty state for `/` when no documents are found (with a helpful message: "No documents found. Run `mulder ingest foo.pdf && mulder extract <id>` to add one, or check that `fixtures/` is present.")
- **PDF rendering** via `react-pdf` (pdf.js under the hood). All pages rendered in a single scroll column inside the left pane. Page width fits the pane, no manual zoom needed for MVP.
- **Markdown rendering** via `react-markdown` + `remark-gfm`. GFM tables MUST render as `<table>`, not as raw pipe-delimited text. Fenced code blocks render monospace. Headings render with appropriate size hierarchy.
- **Keyboard:** pressing `Escape` on the split-view route returns to `/`. No other shortcuts.
- **Visual design:** monochrome or max two colors derived from a neutral palette. Whitespace + typography > decoration. No gradients, no glow effects, no generic AI hero aesthetics. Tailwind classes only, no component libraries (no shadcn, no Material, no Chakra). Font: system stack with a single optional typographic accent if it reads better.
- **Build:** `pnpm --filter @mulder/demo build` produces a static `demo/dist/` (even though deployment is out of scope — the build must work because the same plugin-serving endpoints need to function at dev-time, and the non-API parts of the app must build as a static SPA for future deployment).
- **Tests:**
  - **Mechanical (Vitest):** `tests/specs/49_document_viewer.test.ts` — spawns the Vite dev server via `vite` programmatic API (or `execFileSync` + wait-for-port), fetches the three API endpoints, asserts response shapes + status codes. Also asserts `pnpm --filter @mulder/demo build` succeeds.
  - **Smoke (Playwright):** `demo/tests/viewer.e2e.ts` — 4-6 headless Chromium tests: app loads, document list populates, click → split view renders, PDF canvas is visible, Markdown container has expected content, GFM table renders as `<table>`. Playwright is added as a workspace dev dep. The verify agent runs `npx playwright install --with-deps chromium` once before running the smoke tests (or gates the tests on browser availability).

### Out of scope (explicit, to prevent creep)

- **Any backend process.** No Express, no Koa, no Fastify, no Cloud Run, no `apps/api` route, no separate Node process. Dev-time is Vite + middleware plugin; production build is a static SPA.
- **Production deployment / hosting.** The build artifact exists but nothing deploys it. A follow-up spec would wire up Cloudflare Pages or similar.
- **Database access.** The viewer does not import `@mulder/core`, `@mulder/pipeline`, or any internal package. Zero runtime Mulder imports. Filesystem is the only source.
- **GCS / GCP.** Local filesystem only.
- **Editing.** The Markdown is read-only. No edit mode, no form inputs, no save button.
- **Segmented story view.** The Segment step produces per-story Markdown fragments — those are out of scope. This viewer only shows the whole-document `layout.md`.
- **Entity view, graph view, retrieval playground, spatio-temporal map.** All deferred to future specs (M10 in the functional spec addendum).
- **Hot reload when new documents are extracted.** After an extract, the user must refresh the browser. Live-update via filesystem watcher is deferred.
- **Resizable split divider.** 50/50 fixed. Drag-to-resize is V2.
- **Mobile responsiveness.** Laptop-only demo. Desktop viewports assumed (≥ 1280 × 800).
- **Dark mode toggle.** Single theme (light, monochrome).
- **i18n, search, download, export, print, zoom controls, page navigation shortcuts, TOC, bookmarks.** Nice-to-haves, all deferred.
- **Authentication, users, sessions, state persistence** — none.
- **A CLI command to launch the viewer.** Users run `pnpm --filter @mulder/demo dev` directly. Adding a `mulder viewer` command is deferred.

### Interfaces affected

- **New:** `demo/` directory — self-contained workspace.
- **New:** `pnpm-workspace.yaml` — add `demo` to the `packages:` list.
- **Root `package.json`:** optional convenience script `"viewer": "pnpm --filter @mulder/demo dev"` (architect discretion — implement decides if this adds value).
- **`turbo.json`:** register `@mulder/demo`'s `build` task with no dependencies (standalone).
- **`tests/specs/49_document_viewer.test.ts`:** new black-box QA test file.
- **No changes to `@mulder/core`, `@mulder/pipeline`, `apps/cli`, `apps/api`, database schema, or config.**
- **No new npm dependencies in existing packages** — all new deps live under `demo/package.json` except Playwright (workspace dev dep at root for consistency with the existing test directory).

## 3. Dependencies

### Requires (must exist)

- **Spec 48 (merged):** `layoutToMarkdown` function + Extract step writes `layout.md` to storage. Without spec 48, there's nothing for the viewer to show.
- **Spec 16 (Ingest step, merged):** writes raw PDFs to `raw/{sourceId}/original.pdf` per `packages/pipeline/src/ingest/index.ts:203`.
- **Spec 19 (Extract step, merged):** writes extracted artifacts to `extracted/{sourceId}/`.
- **Existing fixtures** at `fixtures/extracted/` (5 layout.json files) and `eval/golden/layout-markdown/` (5 goldens from spec 48) and `fixtures/raw/` (2 PDFs — `native-text-sample.pdf`, `scanned-sample.pdf`). The viewer's fixture path can only show documents where all three artifacts exist, so only the two fixtures with raw PDFs appear in the fixture source.
- **pnpm workspace** (`pnpm-workspace.yaml`) — already configured; `demo` is a new entry.

### Required by (consumers)

- Future **Cloudflare Pages deployment** spec (optional; would add hosting config).
- Future **Viewer enrichment** spec (entity overlays, graph, retrieval — M10 territory).

## 4. Blueprint

### 4.1 Files to create

#### `demo/package.json`
```json
{
  "name": "@mulder/demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "react": "^19.x",
    "react-dom": "^19.x",
    "react-router-dom": "^7.x",
    "react-pdf": "^10.x",
    "react-markdown": "^10.x",
    "remark-gfm": "^4.x"
  },
  "devDependencies": {
    "@playwright/test": "^1.x",
    "@types/react": "^19.x",
    "@types/react-dom": "^19.x",
    "@vitejs/plugin-react": "^5.x",
    "autoprefixer": "^10.x",
    "postcss": "^8.x",
    "tailwindcss": "^4.x",
    "typescript": "^5.x",
    "vite": "^6.x"
  }
}
```
**Note:** Pick the latest stable version of each package at implementation time (per auto-pilot memory "Always use latest dependency versions"). The `x` placeholders are intentional — the implement agent resolves them to concrete versions.

#### `demo/vite.config.ts`
Vite config that registers the document-source plugin and the React plugin. Points to `src/main.tsx` as the entry, Tailwind via PostCSS.

#### `demo/tsconfig.json`
TypeScript strict config mirroring the rest of the repo's style. References `./tsconfig.node.json` for Vite/Node files.

#### `demo/tsconfig.node.json`
Node-side tsconfig for `vite.config.ts` and the plugin.

#### `demo/index.html`
Standard Vite HTML entry. Title: "Mulder — Document Viewer".

#### `demo/postcss.config.cjs`
`{ plugins: { tailwindcss: {}, autoprefixer: {} } }`.

#### `demo/tailwind.config.ts`
Tailwind v4 config. Content scan of `./index.html` and `./src/**/*.{ts,tsx}`. Extended theme is minimal — a monochrome palette with one accent color. No gradients, no shadows-heavy defaults.

#### `demo/src/main.tsx`
React app entry. Mounts `<App />` into `#root`. Imports `./styles.css` (Tailwind entry).

#### `demo/src/App.tsx`
Root component. Sets up React Router with two routes:
- `/` → `<DocumentList />`
- `/doc/:source/:id` → `<SplitView />`

Handles the Escape key at the router level to navigate back from `/doc/...` to `/`.

#### `demo/src/styles.css`
Tailwind entry: `@import "tailwindcss";` plus any tiny global resets (font-family, line-height). No CSS-in-JS.

#### `demo/src/lib/api-client.ts`
Typed wrapper around the plugin endpoints:
```typescript
export interface ViewerDocument {
  id: string;
  source: 'local' | 'fixture';
  title: string;
  pageCount: number;
  extractedAt: string;  // ISO 8601
}

export async function fetchDocuments(): Promise<ViewerDocument[]>;
export function pdfUrl(source: string, id: string): string;
export async function fetchMarkdown(source: string, id: string): Promise<string>;
```
Uses `fetch` against relative URLs. `pdfUrl` returns the URL string (for `<Document file={url} />`), it does not fetch the PDF bytes itself.

#### `demo/src/components/DocumentList.tsx`
- Fetches `/api/documents` on mount (via `fetchDocuments()`).
- Renders a vertical list of clickable rows. Each row shows: title, page count, extracted date (formatted short), source badge (`local` / `fixture`).
- Click navigates to `/doc/:source/:id`.
- Empty state: centered helpful message with the suggested command.
- Loading state: simple "Loading…" text. No spinner.
- Error state: inline error box with the message from the fetch failure.

#### `demo/src/components/SplitView.tsx`
- Reads `:source` and `:id` from route params.
- Renders a header bar with the document title and a back link (also reachable via Escape).
- 50/50 split layout using Flexbox. Left pane and right pane scroll independently.
- Left: `<PdfViewer source={source} id={id} />`. Right: `<MarkdownViewer source={source} id={id} />`.

#### `demo/src/components/PdfViewer.tsx`
- Uses `react-pdf`'s `<Document>` and `<Page>` components.
- Loads the PDF from `pdfUrl(source, id)` (the plugin's `/api/pdf/...` endpoint).
- Renders all pages in sequence. Each page auto-sizes to the pane width.
- `pdfjs.GlobalWorkerOptions.workerSrc` is configured once (usually via `import` from the package in a way compatible with Vite ESM).
- Loading state: "Loading PDF…"
- Error state: inline error message if the fetch or parse fails.

#### `demo/src/components/MarkdownViewer.tsx`
- Fetches the markdown text via `fetchMarkdown(source, id)`.
- Renders with `<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>`.
- Uses a prose style (Tailwind typography plugin, or hand-crafted styles if the typography plugin is not installed). GFM tables MUST render as `<table>`.
- Loading state: "Loading Markdown…"
- Error state: inline error message.

#### `demo/vite/document-source-plugin.ts`
A Vite plugin (`PluginOption`) that returns an object with `name` and `configureServer`. `configureServer` registers middleware for three routes:

```typescript
export interface DocumentSourcePluginOptions {
  repoRoot: string;  // absolute path, resolved from vite.config.ts via `path.resolve(__dirname, '..')`
}

export function documentSourcePlugin(opts: DocumentSourcePluginOptions): PluginOption {
  return {
    name: 'mulder-document-source',
    configureServer(server) {
      server.middlewares.use('/api/documents', (req, res) => { ... });
      server.middlewares.use('/api/pdf', (req, res) => { ... });
      server.middlewares.use('/api/markdown', (req, res) => { ... });
    },
  };
}
```

**Discovery logic (GET /api/documents):**
1. Scan `${repoRoot}/.local/storage/extracted/*/` for subdirs that contain both `layout.md` and `layout.json`. For each such UUID, check that `${repoRoot}/.local/storage/raw/${uuid}/original.pdf` exists. If all three, parse `layout.json` for `sourceId` (should match), `pageCount`, `extractedAt`, and try to extract the title from the first line of `layout.md` starting with `# `. Build a `{ id, source: 'local', title, pageCount, extractedAt }` record.
2. Scan `${repoRoot}/fixtures/extracted/*/` similarly. For each fixture name, check:
   - `${repoRoot}/fixtures/extracted/{name}/layout.json` exists
   - `${repoRoot}/eval/golden/layout-markdown/{name}.md` exists (the Markdown substitute)
   - `${repoRoot}/fixtures/raw/{name}.pdf` exists
   If all three, build `{ id: name, source: 'fixture', title, pageCount, extractedAt }` with title/metadata from `layout.json` and title extraction from the golden.
3. Concatenate both lists (fixtures first for stable ordering). Return as JSON. Always return an array, even if empty.

**PDF endpoint (GET /api/pdf/:source/:id):**
- Validate `:source` is `local` or `fixture`. Reject with 400 otherwise.
- Validate `:id`: for `local`, must match UUID v4 regex; for `fixture`, must be in the known fixture whitelist (the set from discovery). Reject with 400 otherwise.
- Resolve path:
  - `local` → `${repoRoot}/.local/storage/raw/${id}/original.pdf`
  - `fixture` → `${repoRoot}/fixtures/raw/${id}.pdf`
- If file does not exist, respond 404.
- Otherwise stream the file with `Content-Type: application/pdf`.

**Markdown endpoint (GET /api/markdown/:source/:id):**
- Same validation as PDF endpoint.
- Resolve path:
  - `local` → `${repoRoot}/.local/storage/extracted/${id}/layout.md`
  - `fixture` → `${repoRoot}/eval/golden/layout-markdown/${id}.md`
- If file does not exist, respond 404.
- Otherwise read and respond with `Content-Type: text/markdown; charset=utf-8`.

**Directory traversal protection:** All path resolution uses `path.join` with validated components; `..` segments in `:id` are rejected by the validation regex/whitelist. After joining, verify the resolved path starts with the expected prefix (`repoRoot/...`) as a second line of defense.

#### `demo/playwright.config.ts`
Minimal Playwright config targeting Chromium only. `webServer` config spawns `pnpm --filter @mulder/demo dev` on a free port. Test dir: `./tests`.

#### `demo/tests/viewer.e2e.ts`
Playwright smoke tests (5 tests):
1. **SMOKE-01:** App loads, title is "Mulder — Document Viewer".
2. **SMOKE-02:** Document list populates — at least one row for a fixture (the CI environment always has fixtures). Selector: a button/link matching the fixture title.
3. **SMOKE-03:** Click a fixture row → URL changes to `/doc/fixture/:id`, and both split panes are visible.
4. **SMOKE-04:** PDF canvas element is present in the left pane (react-pdf renders to canvas).
5. **SMOKE-05:** Markdown container in the right pane contains expected text (the fixture's first heading) AND contains at least one `<table>` element for the table-layout fixture. (Two assertions in one test, or split into SMOKE-05 and SMOKE-06.)
6. **SMOKE-06 (optional):** Pressing Escape returns to `/`.

#### `tests/specs/49_document_viewer.test.ts`
Vitest black-box tests (mechanical side). See §5 below for the full QA contract — this file implements it.

### 4.2 Files to modify

#### `pnpm-workspace.yaml`
Add `demo` to the `packages:` list.

#### `package.json` (repo root)
- Add `"viewer": "pnpm --filter @mulder/demo dev"` to `scripts` for convenience (optional — implement discretion).
- Add `@playwright/test` to `devDependencies` at the root (so both `demo/` and future test suites can use it).

#### `turbo.json`
Register the `@mulder/demo` `build` task. Standalone — no dependencies on other packages.

### 4.3 Config changes

**None.** The viewer does not read `mulder.config.yaml`.

### 4.4 Integration points

- **Filesystem only.** The Vite plugin reads from `.local/storage/`, `fixtures/`, and `eval/golden/layout-markdown/`. Paths are resolved from `repoRoot` (the repo root, computed from `vite.config.ts` via `path.resolve(__dirname, '..')`).
- **No imports from `@mulder/core`, `@mulder/pipeline`, or any other internal workspace package.** Verifiable by grepping `demo/` for `@mulder/`.
- **No database access.** No `pg` import, no `@mulder/core` import.
- **No HTTP calls to external services.** Everything is served by the Vite dev middleware.

### 4.5 Implementation phases

Phased — three logical deliverables:

**Phase 1: Scaffold + workspace integration**
- Files: `demo/package.json`, `demo/tsconfig.json`, `demo/tsconfig.node.json`, `demo/vite.config.ts`, `demo/index.html`, `demo/postcss.config.cjs`, `demo/tailwind.config.ts`, `demo/src/main.tsx`, `demo/src/App.tsx` (empty router scaffold), `demo/src/styles.css`, `pnpm-workspace.yaml`, `turbo.json`, root `package.json` script addition.
- Deliverable: `pnpm install` runs cleanly, `pnpm --filter @mulder/demo build` succeeds, `pnpm --filter @mulder/demo dev` serves a blank page on localhost.

**Phase 2: Document source plugin + API**
- Files: `demo/vite/document-source-plugin.ts`, integration into `vite.config.ts`.
- Deliverable: `curl http://localhost:5173/api/documents` returns a JSON array (at least the 2 fixture entries: `native-text-sample`, `scanned-sample`). `curl http://localhost:5173/api/pdf/fixture/native-text-sample -o /tmp/a.pdf` produces a valid PDF. `curl http://localhost:5173/api/markdown/fixture/native-text-sample` returns Markdown text.

**Phase 3: React UI + Playwright smoke tests**
- Files: `demo/src/lib/api-client.ts`, `demo/src/components/DocumentList.tsx`, `demo/src/components/SplitView.tsx`, `demo/src/components/PdfViewer.tsx`, `demo/src/components/MarkdownViewer.tsx`, `demo/playwright.config.ts`, `demo/tests/viewer.e2e.ts`, `tests/specs/49_document_viewer.test.ts`.
- Deliverable: end-to-end flow works manually in a browser. Playwright smoke tests pass. Vitest mechanical tests pass.

Each phase is independently committable and must not break the build.

## 5. QA Contract

The viewer is a UI, so the QA contract has two layers: **mechanical** tests (Vitest) and **smoke** tests (Playwright). The verify agent writes both.

### Mechanical tests (Vitest, `tests/specs/49_document_viewer.test.ts`)

These gate the Vite plugin and the build. They spawn the dev server via `execFileSync` or `child_process.spawn`, wait for the port to be ready, run assertions against the API, then tear down.

### QA-01: Workspace builds cleanly
**Given** a fresh workspace (no stale `dist/`, no stale `.vite/`),
**When** `pnpm --filter @mulder/demo build` runs,
**Then** the command exits 0 and `demo/dist/index.html` exists.

### QA-02: Dev server starts and serves the SPA
**Given** the `@mulder/demo` workspace installed,
**When** the dev server is started and a GET request is made to `http://localhost:{port}/`,
**Then** the response is HTML 200 containing `<div id="root"` (or equivalent mount point) and the page title "Mulder — Document Viewer".

### QA-03: GET /api/documents returns a valid JSON array
**Given** the dev server is running in a repo clone where `fixtures/raw/native-text-sample.pdf`, `fixtures/raw/scanned-sample.pdf`, `fixtures/extracted/*/layout.json`, and `eval/golden/layout-markdown/*.md` all exist (standard checked-in state),
**When** a GET request is made to `http://localhost:{port}/api/documents`,
**Then** the response is HTTP 200, `Content-Type: application/json`, and the body parses as a JSON array containing at least two entries with `source: 'fixture'` — one with `id: 'native-text-sample'` and one with `id: 'scanned-sample'`. Each entry has `id`, `source`, `title`, `pageCount`, `extractedAt` fields, all with the expected types (strings and a positive integer).

### QA-04: GET /api/pdf/fixture/:id returns a valid PDF
**Given** the dev server is running,
**When** a GET request is made to `http://localhost:{port}/api/pdf/fixture/native-text-sample`,
**Then** the response is HTTP 200, `Content-Type: application/pdf`, and the first 5 bytes of the body are `%PDF-` (the PDF magic header).

### QA-05: GET /api/markdown/fixture/:id returns the golden
**Given** the dev server is running,
**When** a GET request is made to `http://localhost:{port}/api/markdown/fixture/table-layout-sample`,
**Then** the response is HTTP 200, `Content-Type: text/markdown` (charset optional), and the body is byte-identical to `eval/golden/layout-markdown/table-layout-sample.md`.

### QA-06: Directory traversal attempt is rejected
**Given** the dev server is running,
**When** a GET request is made to `http://localhost:{port}/api/pdf/local/..%2F..%2Fetc%2Fpasswd` or `http://localhost:{port}/api/markdown/fixture/../../etc/passwd`,
**Then** the response is HTTP 400 (bad request) and nothing under `/etc/` is ever opened. An unknown `:source` value must also return 400.

### QA-07: Unknown ID returns 404
**Given** the dev server is running,
**When** a GET request is made to `http://localhost:{port}/api/pdf/local/00000000-0000-0000-0000-000000000000`,
**Then** the response is HTTP 404 (the UUID is valid but no document exists for it).

### QA-08: Local storage documents appear in the list
**Given** the dev server is running and `.local/storage/extracted/{uuid}/layout.json`, `.local/storage/extracted/{uuid}/layout.md`, and `.local/storage/raw/{uuid}/original.pdf` all exist for a freshly-seeded UUID,
**When** a GET request is made to `/api/documents`,
**Then** the response includes an entry with `id: '{uuid}'` and `source: 'local'`. The test seeds the files in `beforeAll` and cleans them up in `afterAll`.

### QA-09: No `@mulder/*` runtime imports in demo bundle
**Given** the built `demo/dist/` or the source tree under `demo/src/`,
**When** a grep for `@mulder/core`, `@mulder/pipeline`, `@mulder/retrieval`, `@mulder/taxonomy`, `@mulder/worker`, `@mulder/evidence`, `@mulder/eval`, `apps/api`, or `apps/cli` runs against `demo/src/**/*.{ts,tsx}`,
**Then** zero matches are found. The viewer must be self-contained.

### Smoke tests (Playwright, `demo/tests/viewer.e2e.ts`)

These gate the UI rendering. Playwright starts the dev server via `webServer` config, spawns headless Chromium, and drives the app.

### SMOKE-01: App loads and has the correct title
**Given** the dev server is running,
**When** Playwright navigates to `/`,
**Then** `page.title()` equals "Mulder — Document Viewer" and the page does not crash (no uncaught errors in the console).

### SMOKE-02: Document list populates with at least one fixture entry
**Given** the dev server is running in the default repo state,
**When** Playwright navigates to `/` and waits for the list to render (timeout 5s),
**Then** at least one element matching the fixture row selector is visible, and its text contains either the fixture name or a derived title from the Markdown first heading.

### SMOKE-03: Clicking a document opens the split view
**Given** the document list is visible,
**When** Playwright clicks the first fixture row,
**Then** the URL changes to match `/doc/fixture/:id`, and two split panes become visible (a left pane and a right pane, identified by data-testid or role).

### SMOKE-04: PDF canvas renders in the left pane
**Given** the split view is open for a fixture with a known PDF,
**When** Playwright waits up to 10s for the PDF to load,
**Then** at least one `canvas` element is visible inside the left pane (react-pdf renders pages to canvas).

### SMOKE-05: Markdown content and GFM table render in the right pane
**Given** the split view is open for `fixture/table-layout-sample` specifically,
**When** Playwright waits up to 5s for the Markdown to render,
**Then** the right pane contains the text "Sichtungsdatenbank" (from the golden's first heading) AND contains at least one `<table>` element with at least one `<thead>` row and multiple `<tbody>` rows. This validates that `remark-gfm` is wired correctly.

### SMOKE-06: Escape returns to the list
**Given** the split view is open,
**When** Playwright presses `Escape`,
**Then** the URL returns to `/` and the document list is visible again.

## 5b. CLI Test Matrix

**N/A — no CLI commands in this step.** The viewer is a web app launched via `pnpm --filter @mulder/demo dev`, which is a standard pnpm script, not a Mulder CLI command.

## 6. Cost Considerations

**None — no paid API calls.** The viewer is pure client-side + Vite dev middleware, all running locally. No GCP, no Gemini, no Document AI, no external HTTP requests. Build cost is negligible (static Vite output). The only "cost" is the one-time Playwright browser install (~100 MB disk) and the workspace's own npm dependencies.

## 7. Known limitations (shipped intentionally)

Documenting these so future reviewers don't file them as bugs:

1. **Only 2 of 5 fixtures are visible** — because `fixtures/raw/` only contains `native-text-sample.pdf` and `scanned-sample.pdf`. The other three fixtures (`multi-column-sample`, `table-layout-sample`, `mixed-language-sample`) have `layout.json` and a golden but no raw PDF, so they do not pass the "all three artifacts exist" discovery filter. A follow-up could generate synthetic PDFs for the missing fixtures, or relax the filter to show markdown-only entries with a placeholder left pane. Deferred.
2. **No hot reload on new extractions.** After running `mulder extract <id>`, the user must refresh the browser to see the new document in the list. Filesystem watcher integration is deferred.
3. **No resizable split divider.** 50/50 fixed. Dragging to resize is V2.
4. **No mobile/tablet responsiveness.** Laptop viewports only.
5. **No dark mode, no i18n, no search, no download.** All deferred.
6. **Production build works but nothing deploys it.** Deployment is explicitly out of scope. A follow-up spec would wire up Cloudflare Pages or similar.
7. **PDF viewing is basic.** No zoom controls, no page navigation shortcuts, no bookmarks, no TOC. All pages render in a single scroll column at fit-width. Deferred.
8. **Empty state is dumb.** The "No documents found" message does not auto-detect why (missing fixtures vs. no extracts vs. broken plugin). Deferred.

## 8. Architecture alignment

- **Off-roadmap demoability feature** — same family as spec 48. Do NOT update `docs/roadmap.md` (per CLAUDE.md this is a targeted utility, not a milestone step).
- **No dependencies on domain-specific code** — the viewer is literally `{pdf: binary, markdown: string}`. It would work unchanged for any future domain.
- **Filesystem-only discovery** respects the "dev_mode = no GCP" principle. A production deployment would need a different backend (Cloud Run route + GCS signed URLs), which is explicitly out of scope.
- **No `@mulder/*` runtime imports** means the viewer can be extracted as a standalone package in the future without untangling internal dependencies.
- **Tailwind + React + TypeScript strict + latest deps** per auto-pilot memory preferences.
- **No squash merge** per auto-pilot memory — implement agent will use `gh pr merge --merge --delete-branch`.
