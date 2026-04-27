---
spec: "84"
title: "V1 Web App — Foundations + Case File (H11 core)"
roadmap_step: M7.5-V1
functional_spec: ["Spec 77", "H10"]
plan: "docs/v1-web-app-plan.md"
design: "docs/v1-web-app-design.md"
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/220"
created: 2026-04-27
---

# Spec 84: V1 Web App — Foundations + Case File (H11 core)

## 1. Objective

Build the Mulder V1 browser frontend through Phase 0 (Foundations) and Phase 1 (Case File) of `docs/v1-web-app-plan.md`. This satisfies the H11 roadmap anchor ("Document Viewer UI — Vite+React split-view consuming H10 routes and Spec 77 auth") and establishes the app scaffold all subsequent M7.5 phases build on.

The implementation must reuse the existing archived prototype (`codex/archive-v1-app-detached-prototype`) as its starting point rather than building from scratch — that branch contains complete or near-complete implementations of Phase 0 (providers, stores, primitives, auth, theme) and Phase 1 (PDFPane, CaseFile, EntityPill, Hero 1 & 2, StoryReader). The task is to rebase that work cleanly onto current main, reconcile any conflicts (especially in `apps/api/src/middleware/auth.ts` which was independently updated), and bring it to the Phase 1 acceptance criteria.

The existing legacy demo pages (`Dashboard.tsx`, `SourceLibrary.tsx`, etc.) are replaced by the new page structure.

## 2. Boundaries

**In scope:**

- Phase 0: dep install, path aliases, env config, Vite proxy, Radix primitives, theme toggle, providers, stores (EntityDrawer, AuditDrawer, CommandPalette, MentionIndex), Layout + nav, auth pages (Login, AcceptInvite), AuthGate, Desk stub.
- Phase 1: PDFPane (canvas renderer, virtualization, `scrollToPage`), PageThumbnails, StoryFrames, StoryList (Accordion), EntityPill, EntityHoverCard (Hero 2), EntityProfileDrawer, mention-index, Hero 1 choreography, StoryReader (reading mode), CaseFile page, all hooks from `features/documents`, `features/entities`.
- `lib/` utilities: api-client, api-types, pdf bootstrap, format, colors, cn, copy, routes.
- Playwright smoke test: `demo/tests/smoke.spec.ts` — loads `/archive/:id`, waits for first page canvas, asserts story frames render.
- Roadmap flip: H11 🟡 → 🟢 + M7.5-V1 🟡 → 🟢 after Phase 1 passes.
- README progress bar update.
- Devlog entry.

**Out of scope (V2–V6 in subsequent steps):**

- Archive list page (full implementation), drag-drop upload, Desk data (V2)
- Ask / search console, Command Palette (V3)
- Board / knowledge graph (V4)
- Audit drawer (V5)
- Polish, a11y pass, demo recording, Cloudflare deploy (V6)

## 3. Dependencies

**Requires (must be merged on main before this step):**

- Spec 77 (browser session auth) — `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/invitations/accept` — merged as of commit `e528fc7`.
- H10 (document retrieval routes) — `GET /api/documents`, `GET /api/documents/:id/pdf`, `GET /api/documents/:id/layout`, `GET /api/documents/:id/pages`, `GET /api/documents/:id/pages/:num` — landed.
- H8 (entity API) — `GET /api/entities/:id`, `GET /api/entities/:id/edges` — landed.

**Archived prototype:**

- `codex/archive-v1-app-detached-prototype` — contains Phase 0 + Phase 1 work committed as one bundle. Must be cherry-picked or merged onto a clean feature branch off current main.

## 4. Blueprint

### Phase implementation order

1. **Branch + rebase** — create `feat/N-v1-viewer-foundations-case-file` off main, apply the archived prototype changes, resolve conflicts.
2. **Reconcile auth middleware** — `apps/api/src/middleware/auth.ts` was independently updated in `e528fc7`; ensure the prototype's version doesn't regress those changes.
3. **Install/verify deps** — `@tanstack/react-query`, `pdfjs-dist`, `react-markdown`, `remark-gfm`, `cmdk`, `sonner`, `clsx`, `tailwind-merge`, `date-fns`, all Radix primitives (per §3 of plan).
4. **Path aliases + env** — `tsconfig.app.json` paths, `vite.config.ts` proxy, `demo/.env.example`, `demo/src/env.d.ts`.
5. **Foundation layer** (`demo/src/app/`, `demo/src/lib/`) — providers, stores, theme, cn, api-client, routes, copy, colors, format.
6. **Primitives** (`demo/src/components/primitives/`) — all 15 Radix wrappers per §0.3 of plan.
7. **Auth pages** (`demo/src/pages/auth/`) — Login + AcceptInvite per §0.7.
8. **Layout + AuthGate** — per §0.5–0.6.
9. **App router** — replace old `App.tsx` routes with new page structure; keep `/design` route only during dev then remove.
10. **Case File components** — `PDFPane`, `PageThumbnails`, `StoryFrames`, `StoryList`, `StoryListItem`, `EntityPill`, `EntityHoverCard`, `EntityProfileDrawer`, `StoryReader`, shared components.
11. **Feature hooks** — `features/documents/*`, `features/entities/*`, `features/auth/*`.
12. **CaseFile page** — wire all components; `/archive/:id` route.
13. **Hero 1 + Hero 2** — choreography per §1.10; highlight sweep per §1.7 + §1.9.
14. **Build verification** — `npm run build` zero errors, `npm run lint` passes.
15. **Playwright smoke test** — `demo/tests/smoke.spec.ts`.

### Key files (target state, from plan §4)

```
demo/src/
  app/providers.tsx, Layout.tsx, AuthGate.tsx, theme.ts
  app/stores/{EntityDrawerStore,AuditDrawerStore,CommandPaletteStore,MentionIndexStore}.tsx
  pages/CaseFile.tsx, CaseFileReading.tsx, Desk.tsx (stub)
  pages/auth/{Login,AcceptInvite}.tsx
  features/auth/{useSession,useLogin,useLogout,useAcceptInvite,useAuth}.ts
  features/documents/{useDocuments,useDocument,useDocumentPages,useDocumentLayout,usePdfUrl,useStoriesForDocument}.ts
  features/entities/{useEntities,useEntity,useEntityEdges}.ts
  components/primitives/{Button,Input,Dialog,Drawer,DropdownMenu,Tooltip,HoverCard,
    Popover,Tabs,Accordion,ScrollArea,Separator,Slider,ToggleGroup,Avatar,VisuallyHidden}.tsx
  components/PDFPane/{PDFPane,PageThumbnails,StoryFrames,usePdfDocument}.tsx
  components/Story/{StoryList,StoryListItem,StoryReader}.tsx
  components/Entity/{EntityPill,EntityHoverCard,EntityProfileDrawer}.tsx
  components/shared/{ConfidenceBar,StatusLight,PageRange,Timestamp,EmptyState,Skeleton,ErrorState,PipelineBadge}.tsx
  lib/{api-client,api-types,pdf,format,colors,cn,copy,routes}.ts
demo/tests/smoke.spec.ts
```

### Config additions

`demo/vite.config.ts`: `@` alias + `/api` proxy to `VITE_API_PROXY_TARGET`.
`demo/tsconfig.app.json`: `"paths": { "@/*": ["src/*"] }`.
`demo/.env.example`: `VITE_API_BASE_URL=` + `VITE_API_PROXY_TARGET=http://localhost:8787`.

## 5. QA Contract

All acceptance criteria derive from the plan's Phase 1 acceptance criteria (§6 Phase 1 "Acceptance (Phase 1 / H11)") and Phase 0 criteria.

**QA-01: App boots and auth gate works**
Given no session cookie, When the app loads at `/`, Then the Login card renders in-place (URL stays `/`). Given valid credentials, When login form submits, Then `POST /api/auth/login` sets session cookie, AuthGate revalidates, Desk stub renders.

**QA-02: Theme toggle persists**
Given the app at any route, When the theme toggle is clicked, Then the `dark` class is applied to `<html>`. When the page reloads, Then the theme persists via `localStorage`.

**QA-03: CaseFile split-view renders real data**
Given a document that has reached `embedded` or later status in the local API, When visiting `/archive/:id`, Then: PDF renders on the left with at least the first page visible, StoryList renders on the right with at least one story, entity pills appear within the expanded story.

**QA-04: PDF navigation via thumbnails**
Given the CaseFile at `/archive/:id`, When the user clicks a page thumbnail in the left rail, Then the PDF pane scrolls to that page.

**QA-05: Story expand + entity pills**
Given the CaseFile, When the user clicks a story accordion item, Then it expands showing the story snippet, entity pills, and a "Read full story →" link.

**QA-06: Hero 2 — EntityHoverCard + mention highlight**
Given the CaseFile with a story expanded, When the user hovers an entity pill, Then: a HoverCard appears within 120ms with entity name, type, and aliases; any visible mentions of that entity in the story snippet acquire the `amber-underline-active` class. When hover ends, Then the HoverCard closes and highlights are removed.

**QA-07: EntityProfileDrawer opens on pill click**
Given the CaseFile with a story expanded, When the user clicks an entity pill, Then the EntityProfileDrawer slides in from the right with the entity's canonical name, type badge, aliases grouped by language, and at least one related entity edge.

**QA-08: StoryReader (reading mode)**
Given the CaseFile, When the user clicks "Read full story →", Then navigation goes to `/archive/:id/read/:storyId` and the story markdown renders in the reading pane. When Esc is pressed, Then the URL returns to `/archive/:id`.

**QA-09: Hero 1 — reveal choreography**
Given the CaseFile opened for the first time in a session (no `sessionStorage` key `mulder:revealed:<id>`), When the page loads, Then StoryFrames fade in with stagger, StoryList items compose in after, entity pills compose in last — total choreography completes within 1.8s. When the same document is opened again in the same session, Then no choreography plays.

**QA-10: Build passes**
`npm run build` (from `demo/`) must exit 0 with zero TypeScript errors. `npm run lint` must exit 0 with no lint errors.

**QA-11: Playwright smoke test**
`demo/tests/smoke.spec.ts` loads `/archive/:id` for the first fixture document (seeded via the local API), waits for `[data-page="1"] canvas`, and asserts `.story-frame` elements exist (at least one). Test passes when the local API + database are running.

## 5b. CLI Test Matrix

N/A — this is a frontend-only spec. No CLI commands in scope.
