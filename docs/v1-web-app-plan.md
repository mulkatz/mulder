# Mulder V1 Web App — Implementation Plan

> **Legacy notice:** This plan is retained as historical context for the removed V1 `demo/` app. It is superseded by [`docs/product-app-design-strategy.md`](./product-app-design-strategy.md), [`docs/product-app-api-integration.md`](./product-app-api-integration.md), and [`apps/app`](../apps/app) for current browser product work. Do not use this plan as the current implementation blueprint.

> **Roadmap scope:** This plan covers **M7.5 V1–V6** (see [`roadmap.md`](./roadmap.md)). V1 also satisfies the M7-H11 roadmap anchor.
> **For the agent reading this in a fresh session.** This plan is the full brief. You don't need to re-explore or re-design — everything needed to execute is here or linked from here. Follow the phases in order.

---

## 0. Read This First (5 minutes)

In order, read:

1. **This file (the plan)** — end to end before writing any code.
2. [`docs/v1-web-app-design.md`](./v1-web-app-design.md) — the UX/UI design doc. Hero moments, visual language, screen specs.
3. `demo/src/index.css` — design tokens and Tailwind theme (already committed). Do not modify without good reason.
4. [`CLAUDE.md`](../CLAUDE.md) — project conventions.
5. [`docs/roadmap.md`](./roadmap.md) — find milestone **M7.5** (V1–V6) and the M7-H11 anchor.

Do **not** re-read:
- The full functional spec (`docs/functional-spec.md` — 2500+ lines, not needed).
- The API source. The API contract you need is in **§A (Appendix — API Contract Cheat Sheet)** at the bottom of this file.

---

## 1. Ground Rules (non-negotiable)

Pulled from project conventions + the user's memory:

- **English only.** All code, comments, commits, and PR descriptions in English.
- **TypeScript strict.** No `any`, no `as` except for external API responses.
- **Latest deps.** When installing, use latest stable. Fix breaking changes forward, never pin old versions.
- **Atomic semantic commits.** `feat:` / `fix:` / `chore:` / `refactor:` / `docs:` / `test:`. One logical change per commit. Co-authored-by trailer on all commits Claude produces.
- **No squash merges.** Use `gh pr merge --merge` to preserve commit atomicity.
- **No historical comments.** Never write `// previously we did X` or reference issue/spec IDs in code. Git log and PR description carry that context.
- **Roadmap obligation.** When you start a step, flip it `⚪ → 🟡` in `docs/roadmap.md`. When you finish, flip `🟡 → 🟢`. Then update the progress bar in `README.md` between `<!-- PROGRESS:START -->` and `<!-- PROGRESS:END -->` markers.
- **Do not invent features.** If something isn't in the design doc or this plan, don't add it. Cut scope, don't expand it.
- **UI verification.** For every phase, start the dev server and verify the feature works in a browser before marking the phase done. Don't rely on type checks alone.

---

## 2. Shipping Goal

**H11's acceptance criterion** per `docs/roadmap.md`:

> Document Viewer UI — Vite+React split-view (PDF + layout.md), consuming H10's document routes, using invite-based session auth (Spec 77).

**H11 is satisfied when Phase 1 ships.** Phases 2–6 turn the viewer into a complete V1 demo and are what makes the project fundable. Close the H11 roadmap step after Phase 1. Track the rest as a follow-up PR stream.

Directory: `/Users/franz/Workspace/mulder/demo/`. All frontend work happens there. The Vite app is already scaffolded with React 19 + Tailwind v4 + React Router v7.

---

## 3. Dependency Installation (Phase 0.0)

From `/Users/franz/Workspace/mulder/demo/`:

```bash
cd demo

# Core data/state
npm install @tanstack/react-query pdfjs-dist react-markdown remark-gfm \
  cmdk sonner clsx tailwind-merge date-fns

# Radix primitives (broad set — user approved)
npm install \
  @radix-ui/react-dialog \
  @radix-ui/react-dropdown-menu \
  @radix-ui/react-tooltip \
  @radix-ui/react-popover \
  @radix-ui/react-hover-card \
  @radix-ui/react-scroll-area \
  @radix-ui/react-separator \
  @radix-ui/react-tabs \
  @radix-ui/react-accordion \
  @radix-ui/react-collapsible \
  @radix-ui/react-slider \
  @radix-ui/react-toggle \
  @radix-ui/react-toggle-group \
  @radix-ui/react-slot \
  @radix-ui/react-visually-hidden \
  @radix-ui/react-label \
  @radix-ui/react-avatar

# Dev (Playwright added in Phase 6 for demo recording + smoke test)
```

Already present, keep: `react` `react-dom` `react-router-dom` `@xyflow/react` `lucide-react` `recharts` `tailwindcss` `@tailwindcss/vite`.

**Dep notes:**
- **No `motion` / `framer-motion`.** All animations use CSS + Radix `data-state` attributes. The theme already ships `animate-compose-in` + the amber-sweep keyframes. If Phase 4's graph assembly reveals a real need, add it then — not preemptively.
- **No `@types/pdfjs-dist`.** `pdfjs-dist@4+` ships its own types.
- **`recharts`** stays for the entity-profile sparkline only. If after Phase 5 we've used it in exactly one spot, consider a 30-line hand-rolled SVG sparkline to drop ~80KB from the bundle.
- **`@axe-core/react`** is installed in Phase 6.3 (dev-only), not at the top of Phase 0.

---

## 4. File Structure (target state)

Create this layout. Anything not listed, don't create.

```
demo/src/
├── main.tsx                          # entry, providers, theme bootstrap
├── App.tsx                           # router
├── index.css                         # ✓ design tokens (already done)
├── env.d.ts                          # Vite env var types
│
├── app/
│   ├── providers.tsx                 # QueryClient, Router, ThemeProvider, Tooltip.Provider, Toaster
│   ├── Layout.tsx                    # Header + nav tabs + <Outlet /> + AuditDrawer slot
│   ├── AuthGate.tsx                  # Gates protected routes; renders <Login /> in place if no session
│   ├── ErrorBoundary.tsx             # Route-level error boundary (Phase 6 polish; stub in Phase 0)
│   ├── theme.ts                      # light/dark toggle, persisted to localStorage
│   └── stores/
│       ├── EntityDrawerStore.tsx     # context: openEntity(id) / close() used across pages
│       ├── AuditDrawerStore.tsx      # context: openAudit(tab?) / close()
│       └── CommandPaletteStore.tsx   # context: openPalette() / close()
│
├── pages/
│   ├── Desk.tsx                      # `/` — home
│   ├── Archive.tsx                   # `/archive` — document list
│   ├── CaseFile.tsx                  # `/archive/:id` — split-view viewer ★ H11 core
│   ├── CaseFileReading.tsx           # `/archive/:id/read/:storyId` — reading mode
│   ├── Board.tsx                     # `/board` — knowledge graph
│   ├── Ask.tsx                       # `/ask` — search / Q&A
│   ├── auth/
│   │   ├── Login.tsx                 # `/auth/login`
│   │   └── AcceptInvite.tsx          # `/auth/invitations/:token`
│   └── NotFound.tsx
│
├── features/
│   ├── auth/
│   │   ├── useSession.ts             # GET /api/auth/session → query
│   │   ├── useLogin.ts               # POST /api/auth/login → mutation
│   │   ├── useLogout.ts              # POST /api/auth/logout → mutation
│   │   ├── useAcceptInvite.ts        # POST /api/auth/invitations/accept → mutation
│   │   ├── useCreateInvite.ts        # POST /api/auth/invitations → admin-gated mutation
│   │   └── useAuth.ts                # derived: { user, role, isAdmin }
│   ├── documents/
│   │   ├── useDocuments.ts           # list
│   │   ├── useDocument.ts            # single — see §6 Phase 1.12 for strategy
│   │   ├── useDocumentPages.ts
│   │   ├── useDocumentLayout.ts      # fetches markdown (text, not JSON)
│   │   ├── useStoriesForDocument.ts  # parses layout + pairs with metadata
│   │   ├── useUploadDocument.ts      # POST /api/pipeline/ingest (see §A.8)
│   │   └── usePdfUrl.ts              # just builds URL; pdf.js fetches directly
│   ├── entities/
│   │   ├── useEntities.ts
│   │   ├── useEntity.ts
│   │   ├── useEntityEdges.ts
│   │   ├── useAllEdges.ts            # Phase 4 Board — aggregated edges (see §6 Phase 4.1)
│   │   └── useEntityMerge.ts
│   ├── search/
│   │   └── useSearch.ts
│   ├── evidence/
│   │   ├── useEvidenceSummary.ts
│   │   ├── useContradictions.ts
│   │   ├── useSourceReliability.ts
│   │   └── useEvidenceChains.ts
│   └── jobs/
│       └── useJobs.ts                # Used by Phase 2 upload progress polling
│
├── components/
│   ├── primitives/                   # thin styled wrappers around Radix
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Dialog.tsx
│   │   ├── Drawer.tsx                # right-side slide-in (Dialog variant)
│   │   ├── DropdownMenu.tsx
│   │   ├── Tooltip.tsx
│   │   ├── HoverCard.tsx
│   │   ├── Popover.tsx
│   │   ├── Tabs.tsx
│   │   ├── Accordion.tsx
│   │   ├── ScrollArea.tsx
│   │   ├── Separator.tsx
│   │   ├── Slider.tsx
│   │   ├── ToggleGroup.tsx
│   │   ├── Avatar.tsx
│   │   └── VisuallyHidden.tsx
│   ├── AuditDrawer/
│   │   ├── AuditDrawer.tsx
│   │   ├── ContradictionCard.tsx
│   │   ├── SourceReliabilityList.tsx
│   │   └── EvidenceChainList.tsx
│   ├── CommandPalette/
│   │   ├── CommandPalette.tsx        # cmdk + Radix Dialog
│   │   └── useCommandPalette.ts
│   ├── Entity/
│   │   ├── EntityPill.tsx            # the ubiquitous chip
│   │   ├── EntityHoverCard.tsx       # Hero 2 ghost card
│   │   └── EntityProfileDrawer.tsx   # reused from 4 places
│   ├── PDFPane/
│   │   ├── PDFPane.tsx               # pdf.js canvas renderer
│   │   ├── PageThumbnails.tsx
│   │   ├── StoryFrames.tsx           # colored overlay per story
│   │   └── usePdfDocument.ts
│   ├── Story/
│   │   ├── StoryList.tsx
│   │   ├── StoryListItem.tsx
│   │   └── StoryReader.tsx           # full markdown reading experience
│   ├── Graph/
│   │   ├── GraphCanvas.tsx
│   │   ├── nodes/
│   │   │   ├── PersonNode.tsx
│   │   │   ├── LocationNode.tsx
│   │   │   └── EventNode.tsx
│   │   ├── edges/
│   │   │   ├── RelationshipEdge.tsx
│   │   │   ├── ContradictionEdge.tsx
│   │   │   └── DuplicateEdge.tsx
│   │   ├── GraphControls.tsx
│   │   └── TimelineScrubber.tsx
│   ├── Ask/
│   │   ├── AnswerCard.tsx
│   │   ├── CitationCard.tsx
│   │   └── RetrievalTrace.tsx
│   ├── shared/
│   │   ├── ConfidenceBar.tsx         # visual score 0–1
│   │   ├── StatusLight.tsx           # 6px colored dot
│   │   ├── PageRange.tsx             # "pp. 12–14" in mono
│   │   ├── Timestamp.tsx
│   │   ├── EmptyState.tsx
│   │   ├── Skeleton.tsx
│   │   ├── ErrorState.tsx
│   │   ├── Illustration/             # line-art SVGs for empty states
│   │   │   ├── EmptyArchive.tsx
│   │   │   ├── NoResults.tsx
│   │   │   └── NoBoard.tsx
│   │   └── PipelineBadge.tsx         # status badge for documents
│   └── Desk/
│       ├── OverviewRibbon.tsx
│       ├── RecentlyAdded.tsx
│       └── WorthFollowing.tsx
│
├── lib/
│   ├── api-client.ts                 # fetch wrapper; credentials: 'include'
│   ├── api-types.ts                  # TypeScript types mirroring API contract (§A)
│   ├── pdf.ts                        # pdfjs-dist bootstrap + helpers
│   ├── format.ts                     # dates, page ranges, confidence values
│   ├── colors.ts                     # entity-type → Tailwind class mapping
│   ├── cn.ts                         # clsx + tailwind-merge
│   ├── copy.ts                       # all user-facing strings (single source)
│   ├── shortcuts.ts                  # keyboard shortcut registry + useShortcut() hook
│   ├── mention-index.ts              # builds entity → DOM ranges index (used by Hero 2)
│   └── routes.ts                     # typed route builders
│
└── public/
    └── fonts/                        # optional local fonts fallback
```

---

## 5. Global Conventions for the Implementation

### 5.1 Import aliases

Add to `tsconfig.app.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
```

And mirror in `vite.config.ts`:

```ts
import path from 'node:path';
// resolve: { alias: { '@': path.resolve(__dirname, './src') } }
```

All imports inside `src/` use `@/...` — no relative paths more than one level deep.

### 5.2 Component patterns

**Primitives wrapping Radix** (`components/primitives/*`) follow this pattern:

```tsx
// components/primitives/Dialog.tsx
import * as RadixDialog from '@radix-ui/react-dialog';
import { cn } from '@/lib/cn';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;

export function DialogContent({ className, children, ...props }: RadixDialog.DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          'bg-raised border border-thread rounded-lg shadow-xl',
          'w-full max-w-lg p-6',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
```

Rules:
- Primitives are **styled wrappers, not logic**. No state inside them beyond what Radix provides.
- Every primitive accepts `className` and merges via `cn()`.
- `asChild` via Radix is preserved — we don't hide it.
- No primitive re-exports things under new names; `DialogTrigger` is still `DialogTrigger`.

**Feature components** (`components/AuditDrawer`, etc.) compose primitives + hooks.

### 5.3 `cn()` helper

```ts
// lib/cn.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
```

### 5.4 Copy catalog

All user-facing strings live in `lib/copy.ts`. This is crucial for voice consistency and eventual i18n:

```ts
// lib/copy.ts
export const copy = {
  nav: { desk: 'The Desk', archive: 'Archive', board: 'Board', ask: 'Ask' },
  empty: {
    archive: {
      title: 'The archive is empty.',
      body: 'Drop a PDF anywhere on this screen to begin.',
    },
  },
  loading: {
    document: (page: number, total: number) => `Reading page ${page} of ${total}`,
  },
  errors: {
    sessionExpired: 'Your session has ended. Please log in again.',
    pdfRead: 'Couldn\'t read this page. The scan may be corrupted.',
  },
  // ... extend as strings are needed
};
```

Never hardcode a user-facing string in a component. If you need one, add it to `copy.ts` first.

### 5.5 Entity-type → color mapping

```ts
// lib/colors.ts
export const ENTITY_CLASS = {
  person:       'entity-person',
  location:     'entity-location',
  organization: 'entity-org',
  event:        'entity-event',
  concept:      'entity-concept',
  date:         'entity-date',
} as const;

export function entityClass(type: string): string {
  const normalized = type.toLowerCase() as keyof typeof ENTITY_CLASS;
  return ENTITY_CLASS[normalized] ?? 'entity-concept';
}
```

Unknown types fall back to `entity-concept`. Never throw.

### 5.6 API client

```ts
// lib/api-client.ts
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';   // empty in dev — Vite proxy handles it (§5.9)

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',                    // session cookie travels
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Text-response variant for /api/documents/:id/layout (markdown)
export async function apiFetchText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { Accept: 'text/markdown, text/plain', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? res.statusText);
  }
  return res.text();
}
```

No Authorization header, ever. Session cookie is the only credential for the browser. The dev Vite proxy makes the empty `API_BASE` same-origin (§5.9).

### 5.7 React Query setup

```ts
// app/providers.tsx — QueryClient defaults
new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return false;
        return count < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) {
          // AuthGate listens for this and re-renders <Login /> in place at the current URL
          window.dispatchEvent(new Event('auth:expired'));
        }
      },
    },
  },
});
```

### 5.8 Route builders

```ts
// lib/routes.ts
export const routes = {
  desk:          () => '/',
  archive:       () => '/archive',
  caseFile:      (id: string) => `/archive/${id}`,
  reading:       (id: string, storyId: string) => `/archive/${id}/read/${storyId}`,
  board:         () => '/board',
  ask:           () => '/ask',
  login:         () => '/auth/login',
  acceptInvite:  (token: string) => `/auth/invitations/${token}`,
};
```

Use these everywhere instead of hardcoded strings. Makes refactors safe.

### 5.9 Env vars + dev proxy (cookie-critical)

**The cookie problem.** Session cookies are `HttpOnly` + `SameSite=Strict` (per Spec 77 §4.5). In dev, if the frontend runs on `:5173` and the API on `:8080`, the browser treats them as cross-origin and the session cookie won't be sent on fetch. The fix is a Vite dev proxy so both appear same-origin to the browser.

`demo/vite.config.ts`:

```ts
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:8080';
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, cookieDomainRewrite: 'localhost' },
      },
    },
  };
});
```

With the proxy in place, `VITE_API_BASE_URL` becomes empty string in dev — the frontend fetches `/api/...` same-origin and cookies work.

`demo/.env.example`:

```
# Same-origin via Vite proxy in dev. Set to full URL in production (Cloudflare Pages).
VITE_API_BASE_URL=
VITE_API_PROXY_TARGET=http://localhost:8080
```

`demo/.env.local` (gitignored) for per-developer overrides.

Production (Cloudflare Pages build) sets `VITE_API_BASE_URL=https://api.mulder.mulkatz.dev` (or the real API origin). For production the API must set `CORS` with `credentials: true` and an explicit `Access-Control-Allow-Origin` (not `*`), plus `Set-Cookie: SameSite=None; Secure` since the two are on different subdomains.

`env.d.ts`:

```ts
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_PROXY_TARGET?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
```

Update `lib/api-client.ts` accordingly:

```ts
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
// fetch(`${API_BASE}${path}`, { credentials: 'include', ... })
```

An empty `API_BASE` in dev + the Vite proxy makes every fetch same-origin, which is what session cookies require.

---

## 6. Phases

Each phase ends in a demoable, running app. Don't start phase N+1 until phase N verifies in a browser.

---

### Phase 0 — Foundations *(target: 3–4 days)*

**Goal:** app boots, dark/light toggle works, auth gates routes, all primitives exist.

**0.1 Install dependencies** (§3).

**0.2 Configure aliases** (§5.1), env vars (§5.9).

**0.3 Build out primitives.** For each file in `components/primitives/`, create a thin styled Radix wrapper using the pattern in §5.2. Visual spec:

| Primitive | Notable visual |
|---|---|
| `Button` | 4 variants: `primary` (amber fill, ink-inverse text), `secondary` (surface, thread border), `ghost` (transparent, amber on hover), `destructive` (carmine). Sizes: `sm` `md` `lg`. Font: sans. Radius: `md`. |
| `Input` | 1px thread border, bg-sunken, focus: amber 2px ring via `:focus-visible`. |
| `Dialog` | Centered, `max-w-lg`, radius `lg`, shadow `xl`, overlay fade. |
| `Drawer` | Right-slide variant of Dialog. 480px wide. Used for Audit + Entity profile. |
| `DropdownMenu` | bg-raised, shadow-lg, 1px thread border, radius `md`. Item hover: amber-faint. |
| `Tooltip` | 200ms open delay, bg-ink, text-ink-inverse, radius `sm`, shadow-md. |
| `HoverCard` | Rich content card for entity ghost. 320px wide. Arrow enabled. |
| `Popover` | Like HoverCard but click-triggered. |
| `Tabs` | Underline-style, amber on active. No pill backgrounds. |
| `Accordion` | Flat, chevron rotates. Used in StoryList. |
| `ScrollArea` | Replaces native scrollbar in panels. Thumb: thread → thread-strong on hover. |
| `Separator` | Either hairline (`rule` utility color) or thread. |
| `Slider` | Track: thread. Range: amber. Thumb: raised w/ amber border. |
| `ToggleGroup` | For filter pills. Active: amber-soft bg + amber text. |
| `Avatar` | Used in user menu. Fallback: initials in mono, thread bg. |
| `VisuallyHidden` | Straight Radix re-export for a11y labels. |

Use `tailwindcss-animate` patterns (`data-[state=open]:animate-in`) via handcrafted keyframes (theme already has `animate-compose-in` and the sweep variants). Radix exposes `data-state` and `data-side` attributes for all transitions.

**0.4 Theme toggle.** `app/theme.ts`:

```ts
// - read localStorage 'mulder-theme', fallback 'light'
// - apply 'dark' class on <html>
// - expose useTheme() hook + ThemeProvider
```

Do **not** use `prefers-color-scheme` as default. Light is the product's default voice.

**0.5 Providers + Layout.**

```tsx
// main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

```tsx
// App.tsx
import { Providers } from '@/app/providers';
import { Router } from '@/app/router'; // or inline Routes
export default function App() {
  return <Providers><Router /></Providers>;
}
```

`app/providers.tsx` composes: `BrowserRouter` → `QueryClientProvider` → `ThemeProvider` → `TooltipProvider` (Radix, delay 200) → `<Toaster />` from sonner. Children render inside.

**0.6 Layout + nav.** `app/Layout.tsx` has header with:
- Logo (left): mulder icon (already in `demo/public/`) + wordmark "Mulder" in `font-serif` at ~`text-xl`, weight 500.
- Nav (center): The Desk · Archive · Board · Ask. Active link: amber underline, 2px offset, slides in on mount.
- Right: theme toggle (icon button), `⌘K` hint pill, user menu (avatar → dropdown: email, logout).
- Header height: 56px. Border-bottom: thread.
- Below header: `<Outlet />` inside `<main className="flex-1">`.
- Footer: none.
- Slot for AuditDrawer rendered at layout level so it overlays any page.

**0.7 Auth pages + gate.**

Per Spec 77 (issue #195), these are the product's only browser entry points. The web bundle never touches an API key — session cookies only.

`pages/auth/Login.tsx` — centered card, 400px wide, `bg-surface`, shadow-md, radius-lg, padding 8. Display-serif title: "Enter the archive." Email input, password input, submit button.

- Error UX is **generic by spec §4.3**: never indicate whether the email or password was wrong. Single message: *"Those credentials didn't match. Try again, or ask your operator for a fresh invitation."*
- Below the form, in `text-ink-subtle`: "Access is invite-only. Ask your operator for an invitation." No "Forgot password?" link — self-serve reset is out of scope for V1 (spec §2: out of scope).

`pages/auth/AcceptInvite.tsx` — reads `:token` from the URL path. Same visual layout as Login.

- Fields: new password + confirm password. Strength meter (4 bars, amber → sage progression), minimum length per server config (spec leaves it to config; fail open — server will reject if too weak).
- On submit, POST `{ token, password }` to `/api/auth/invitations/accept`. The token comes from the URL, not user input — never expose it in the UI.
- Failure modes:
  - **400 / validation** — generic "This invitation couldn't be accepted. Check that your password meets the requirements."
  - **410 / consumed or expired** — specific, helpful: "This invitation has expired or was already used. Ask your operator to send a fresh one." (Spec §4.3 says invites are single-use and time-limited.)
  - **500** — "Something went wrong on our side. Try again in a minute."
- On success, the response sets the session cookie and returns user info. Navigate to `/`.

`app/AuthGate.tsx`:
```tsx
// On mount: GET /api/auth/session via useSession() (react-query)
// 401 → render <Login /> in place (don't navigate — preserve the URL so successful login redirects back)
// 200 → render children; store { user: {email, role}, expiresAt } in context
// Loading → minimal shimmer, not a spinner
// Listens for 'auth:expired' window event → clear react-query cache → show <Login />
```

`useAuth()` hook exposes `{ user, role, isAdmin }` where `isAdmin = role === 'owner' || role === 'admin'`. Components that render admin-only affordances read from this hook — they do not re-fetch session.

Routes under `/auth/*` are **not** wrapped in AuthGate. Everything else is. `/auth/invitations/:token` must be reachable by a signed-out browser.

**Invite-flow URL contract.** The invite email contains a link like `https://mulder.example.org/auth/invitations/<token>`. The server-configured `invite_base_url` (mulder.config.yaml) must match the deployed frontend origin, otherwise the link 404s. In dev, the backend's dev email transport logs the full URL — the invite "email" is the log line.

**0.8 Desk stub.** `pages/Desk.tsx` renders a page shell with "The Desk" heading. Populated in Phase 2.

**0.9 Drawer & palette stores.** Create `app/stores/EntityDrawerStore.tsx`, `AuditDrawerStore.tsx`, `CommandPaletteStore.tsx` per §6c. Nest providers inside `<Providers>` (outer to inner: QueryClient → Theme → Tooltip → EntityDrawer → AuditDrawer → CommandPalette → Toaster). Wire them up with no consumers yet — consumers come in Phases 1/3/5.

**Acceptance (Phase 0):**
- `npm run dev` boots without errors.
- Visiting `/` while logged out shows the login card in place (no navigation, the URL stays `/`).
- Logging in with a real API session sets the cookie, `AuthGate` revalidates, Desk stub renders.
- `GET /api/auth/session` fires exactly once on app bootstrap (check Network tab).
- Dark mode toggle flips the theme; preference persists across reload via localStorage.
- The three stores (entity drawer, audit drawer, command palette) can be opened/closed from the browser console via a throw-away debug hook or temporarily-wired button — prove the contexts work end-to-end before Phase 1 depends on them.
- All primitives render correctly in a scratch `/design` route — this route is deleted before the Phase 0 commit.

**Commit:** `feat(demo): foundations — providers, stores, auth gate, primitives, theme toggle`

---

### Phase 1 — Case File (the H11 core) *(target: 5–6 days)*

**Goal:** a user can open a processed document and see the split-view viewer with PDF, story frames, story list, entity pills, and Hero 1 + Hero 2 interactions. H11 roadmap step closes at the end of this phase.

**1.1 PDF.js bootstrap.** `lib/pdf.ts`:

```ts
import * as pdfjs from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = worker;
export { pdfjs };
```

`usePdfDocument(url)` hook: returns `{ doc, numPages, error, loading }`. Uses `pdfjs.getDocument({ url, withCredentials: true })` so session cookie travels.

**1.2 `PDFPane`.**
- Renders each page to `<canvas>` inside an absolutely-positioned wrapper.
- Vertical stack, pages separated by 16px, all centered.
- Virtualize past 30 pages: use IntersectionObserver, render canvas only for pages within 2 viewport heights of the scroll position.
- Expose `scrollToPage(n)` via ref.
- Each page wrapper has `data-page={n}`.

**1.3 `PageThumbnails`.**
- 80px-wide left rail. For each page: a 64px-wide canvas rendered at low-res (scale 0.2), below it a small mono page number.
- Clicking a thumbnail fires `scrollToPage(n)` on `PDFPane`.
- Active page: amber left border rule, surface background.
- Pages that start a story: a small bookmark icon (lucide `Bookmark`) top-right of thumbnail.
- Uses Radix `ScrollArea`.

**1.4 `StoryFrames`.**
- Absolutely-positioned overlay aligned to each page in `PDFPane`.
- Per story with `pageStart`/`pageEnd`: draw a 1.5px outlined rectangle covering the full page area.
- Palette rotation: stories get colors by index modulo a palette of 6 — amber, cobalt, sage, carmine, entity-event, entity-concept. Always `-soft` fill at 15% opacity plus full-color 1.5px border.
- Label floating at top-left of the first page of the story: story title truncated + page range, white bg with 1px thread border, radius `sm`, small shadow.
- Stories are aligned to the PDFPane coordinate system. Compute story rects from page metrics published by `PDFPane` on render.

**1.5 `StoryList` (right rail).**
- 360px-wide right panel. Radix `Accordion` with `type="single"`, `collapsible`.
- Each `AccordionItem` (story) collapsed state:
  - Display-serif title
  - `PageRange` mono component
  - Language + category as tiny mono labels
  - `ConfidenceBar` (narrow, `w-16`)
- Expanded state adds:
  - First ~200 chars of markdown (fetch on demand from `/api/documents/:id/layout`, parse to find this story's section)
  - "Read full story →" link navigating to `CaseFileReading`
  - Entity pills strip, horizontal overflow scroll
  - Small 🔺 icon badge if any contradictions touch stories with those entity IDs (from `useEvidenceSummary` and `useContradictions`)

**1.6 `EntityPill`.**

```tsx
// components/Entity/EntityPill.tsx
interface Props {
  entity: { id: string; name: string; type: string; canonical_id?: string };
  size?: 'sm' | 'md';
  interactive?: boolean; // wraps in HoverCard + click → drawer
}
```

- Mono font, tracking-tight, text-xs, px-2 py-0.5, rounded-pill.
- Uses `entityClass(type)` for colors.
- If `canonical_id` set, render a tiny ring around the pill (2px thread-strong offset).
- When `interactive`, wraps in `EntityHoverCard` (Hero 2) + click opens `EntityProfileDrawer`.

**1.7 `EntityHoverCard` — Hero 2 ("The Echoing Entity").**

On hover of any entity pill or entity mention:
1. Uses Radix `HoverCard` (open delay 120ms, close delay 80ms).
2. Content: ghost card 320px wide, shadow-lg, radius-lg, border thread.
   - Canonical name in display-serif
   - Type badge (entity class colors)
   - Aliases in up to 3 languages, mono, `text-ink-subtle`
   - `ConfidenceBar` labeled "Corroboration"
   - "Appears in N documents →" link
3. **In parallel**, dispatch a `highlightEntity(id)` event. Every visible mention of that entity in the document gets the `amber-underline-active` class added for the duration of the hover. Mentions are located by a pre-built index (1.9).

**1.8 `EntityProfileDrawer`.**

Radix `Dialog` variant that slides from the right (480px). Content sections, each separated by `Separator`:
- Header: display-serif name, type badge, close button.
- Corroboration + source count in a small row.
- Aliases grouped by language.
- Attributes as definition list (rendered generically from `attributes` JSONB).
- Related entities: 6 cards of linked entities (from `useEntityEdges`), relationship label in mono.
- Mentions timeline: tiny recharts sparkline of mentions over time if temporal data exists.
- Footer: Merge... / See on Board → / Close actions.

Reused from: StoryList entity pills, Board node click, Ask citation click, Audit drawer links. Route via global state (`useEntityDrawer` store — can use `useState` in Layout + context, no need for Zustand in V1).

**1.9 Mention index.**

Purpose: when the user hovers an entity pill, every occurrence of that entity's name (or any of its aliases) on the current page lights up with an amber sweep. This is Hero 2.

**Where the matching happens.** Only in the story-list expanded snippets (CaseFile) and in `StoryReader` prose — never in the raw PDF canvas (PDF text is a pixel image). The PDF side participates in Hero 2 only at page-frame granularity (dim non-story pages, brighten pages that contain the entity).

**Index shape.**

```ts
// lib/mention-index.ts
type MentionIndex = Map<string /* entity.id */, Range[]>;   // DOM ranges

export function buildMentionIndex(root: HTMLElement, entities: EntityWithAliases[]): MentionIndex;
```

**Matching rules** (deliberate, documented):

1. Case-insensitive.
2. Whole-word only: `\b<term>\b` word-boundary regex (`\b` in JS works for ASCII word chars; for non-ASCII names use Unicode-property-aware boundary).
3. Candidate terms: the entity's `name` + every alias from `EntityDetailResponse.aliases`. Dedupe. Skip candidates shorter than 3 characters to avoid false positives on common words.
4. Longest-term-first matching within a single text node — prevents "CUFOS" from being shadowed by "CU" if both exist.
5. Don't cross element boundaries. If a name is split across `<em>` tags, it won't match — accept that miss for V1.

**Rebuild triggers.**

- `StoryReader` mounts with new markdown → rebuild for that root.
- Story accordion item expands/collapses in CaseFile → rebuild for the CaseFile root.
- Debounce 100ms to coalesce bursts.
- Entity data changes (rare in session) → rebuild.

Exposed via `MentionIndexContext` in `app/stores/` (added alongside the drawer stores). `useMentionIndex()` returns `{ highlight(entityId): () => void, clear(): () => void }` — the clear function is returned from highlight so the hover-out handler can call it.

**Applying the sweep.** When `highlight(id)` is called, iterate the ranges, wrap each in a `<mark class="amber-underline amber-underline-active">` via `range.surroundContents()`. Store references; on `clear()`, unwrap. CSS transitions on `amber-underline` handle the actual animation (tokens already in `index.css`).

**1.10 Hero 1 ("The Reveal").**

First time `CaseFile` mounts for a document in a session (track in `sessionStorage`):
1. PDF renders normally.
2. 400ms later: `StoryFrames` fade + compose in one by one, 100ms stagger.
3. 100ms after frames finish: `StoryList` items compose in (AccordionItem fade + 4px rise), 80ms stagger.
4. 200ms after stories finish: entity pills inside the first visible story compose in, 40ms stagger.
5. Total choreography: ~1.8s. Skippable: press Space or click anywhere → all animations jump to end state.

Use Tailwind's `animate-compose-in` utility (already in theme) plus inline `style={{ animationDelay: ... }}`. No JS animation library needed.

Subsequent visits to the same document in the session: no choreography, just render final state.

**1.11 `StoryReader` (reading mode).**

`/archive/:id/read/:storyId`. Dim the PDF panel to 40% opacity and gray. Reading pane slides from center-right, max column width 680px, `bg-paper`, generous margins.

Render story markdown with `react-markdown` + `remark-gfm`. Custom renderers:
- `h1`: `font-serif text-4xl` tight leading, weight 500.
- `h2`: `font-serif text-2xl`, weight 500.
- `p`: `text-lg leading-relaxed text-ink`.
- `blockquote`: left amber border, serif italic.
- Entity mentions: detected via mention index, wrapped in `EntityPill` inline component (text mode: only amber underline on hover, no pill chrome).

Escape key or clicking the "← Back" link exits reading mode.

**1.12 Wire up the API.**

| Hook | Returns | Endpoint |
|---|---|---|
| `useDocument(id)` | Document record | See "Single-document fetch" below |
| `useDocumentPages(id)` | Page manifest | `GET /api/documents/:id/pages` |
| `useDocumentLayout(id)` | Markdown string | `GET /api/documents/:id/layout` via `apiFetchText` |
| `usePdfUrl(id)` | Just `${API_BASE}/api/documents/${id}/pdf` | — |
| `useStoriesForDocument(id)` | Story records | Derived — see "Stories derivation" below |
| `useEntity(id)` | Entity detail | `GET /api/entities/:id` |
| `useEntityEdges(id)` | Edges | `GET /api/entities/:id/edges` |

**Single-document fetch.** The API does **not** expose `GET /api/documents/:id`. Strategy:

1. `useDocument(id)` first reads from the react-query cache (key: `['documents', 'list', ...]`) — if the Archive page was visited, the record is already there.
2. Cache miss: fetch `GET /api/documents?limit=100&offset=0` and filter in memory. For the V1 demo corpus this is trivial.
3. If the filtered result is empty, surface a "Document not found" state via `ErrorState`.

Future optimization if the corpus grows: add `GET /api/documents/:id` server-side. Don't add an `?id=` query to the list route — it's not supported.

**Stories derivation.** The API emits segment markdown from `GET /api/documents/:id/layout` and metadata alongside (story IDs, page ranges, titles). For V1, derive the story list from two sources:

1. Parse the concatenated layout markdown to locate story H1 boundaries (fixture format: each story starts with `# <title>` at top level).
2. If a structured stories endpoint exists (check `/api/stories?source_id=<id>` — not documented in §A; treat as optional), prefer it. Otherwise the parsed list with `{ id: slug(title), title, pageStart: n, pageEnd: m }` is enough.

If there's friction (IDs don't line up with what Entity endpoints reference), add a devlog note and fix in Phase 1 cleanup rather than adding a new API route.

**Layout-unavailable notice.** When `layout_available` is false, show a soft notice at the top of the story list: "This document has been ingested but stories haven't been extracted yet." with a mono timestamp showing the source's current status.

**1.13 Roadmap and progress bar update.**

Once Phase 1 verifies:
- Open `docs/roadmap.md`, flip H11 `🟡 → 🟢`.
- Open `README.md`, find `<!-- PROGRESS:START -->` markers, bump the M7 row and total count.

**Acceptance (Phase 1 / H11):**
- Given a real document that has reached `embedded` or later status in a real local API, visiting `/archive/:id` renders: PDF on left, story frames drawn correctly, story list on right, entity pills correct per story.
- Clicking a thumbnail scrolls PDF to that page.
- Clicking a story in the list expands it, highlights its frame on the PDF.
- Hovering an entity pill triggers Hero 2: hover card + all mentions on the page gain `amber-underline-active`. Hover-out removes them.
- Clicking a pill opens `EntityProfileDrawer` with real aliases + edges.
- First mount of a given document (per `sessionStorage` key `mulder:revealed:<id>`) runs Hero 1 choreography within 1.8s total.
- "Read full story" navigates to reading mode; Esc returns to Case File.
- `npm run build` succeeds with zero TypeScript errors.
- `npm run lint` passes.
- Lighthouse desktop audit run once: accessibility ≥ 95. Mobile is out of scope (desktop-first demo).
- A Playwright smoke test (`demo/tests/smoke.spec.ts`) loads `/archive/:id` for a seeded fixture document, waits for the first page canvas, and asserts story frames render. Passing this smoke test is the binary gate.

**Commits for Phase 1** — separate them, per the atomic-commit rule:
1. `feat(demo): case file viewer — split-view PDF + stories + entity interactions`
2. `feat(demo): hero 1 and hero 2 reveal animations`
3. `chore(roadmap): flip H11 to 🟢, update README progress bar`
4. `docs(devlog): add H11 case-file viewer entry`

**★ H11 is closed after the chore-roadmap commit merges.** Continue to Phase 2 in a separate PR.

---

### Phase 2 — Archive + Desk *(target: 3 days)*

**Goal:** complete the navigation shell. Users can see, filter, and upload documents, and the Desk lands them into "what's worth looking at now."

**2.1 Archive list.**
- `pages/Archive.tsx` — two-pane list/detail.
- Left: collapsible filter rail (200px). Filter groups: "Status" (status enum), "Date added" (sliding date range), "Language", "Source type" (V1: pdf only, but render the control — it signals future).
- Right: table. Columns: thumbnail (page 1 preview from `/documents/:id/pages/1`), title (display-serif), page count (mono), entities (count), status light + label, `Timestamp`.
- Row click → `navigate(routes.caseFile(id))`.
- Sort dropdown: recent / alphabetical / size / entity density.
- `useDocuments` hook paginates with `limit=25, offset` + exposes `hasMore`; load-more button.
- Empty state: `EmptyArchive` illustration + copy from `copy.ts` + drop zone wrapping the entire content area.

**2.2 Drag-drop upload.**

The upload endpoint is served by H5 pipeline routes. Exact route: see §A.8. Do **not** invent an endpoint — if the route isn't there, skip the drag-drop feature for V1 and ship the Archive page read-only with a footer note "Uploading is a CLI operation today (`mulder ingest <path>`)."

- `useFileDrop(target)` hook — binds `dragover`, `dragleave`, `drop`. Target: the entire Archive content area.
- On drop, open a small upload modal (Radix Dialog) that POSTs the file as `multipart/form-data` per §A.8.
- Progress: the API responds with a job ID. Poll `GET /api/jobs/:id` every 2s (Relaxed rate-limit tier). Narrate stages from the job record: "Uploaded" → "Parsing PDF" → "Queued for extraction" → "Extracted".
- On job completion, invalidate `['documents', 'list']` query. New row appears in the list.
- Hide the entire feature behind a feature check: if the first poll returns 404 or the upload POST returns 404, fall back to the CLI-only footer note — never show a broken affordance.

**2.2b Admin invite modal (role-gated).**

Per Spec 77 (issue #195), `owner` and `admin` sessions can issue invitations via `POST /api/auth/invitations`. We expose this as a small modal — it closes the onboarding loop end-to-end in the demo without dropping to a terminal.

- Placement: header user menu (Radix DropdownMenu) → item "Invite a teammate" — **only rendered when `useAuth().isAdmin` is true**. Members never see it.
- Modal (Radix Dialog): two fields.
  - Email (text input, validated for basic shape on blur)
  - Role (Radix ToggleGroup: "Member" default, "Admin" — "Owner" hidden from the UI, set only via CLI)
- On submit, POST `{ email, role }` to `/api/auth/invitations`.
  - **Success:** toast *"Invitation sent to {email}. The link expires in 72 hours."* (Exact TTL comes from the API's `expires_at` in the response — format with `date-fns` `formatDistanceToNow`.) Close modal.
  - **403:** should be impossible if we gate the trigger, but handle defensively — toast *"You don't have permission to invite users."*
  - **409 / duplicate active user:** *"{email} already has an account."*
  - **409 / duplicate pending invite:** API re-issues (spec §4.3: *"re-inviting a pending email should invalidate any prior unused invite and issue a fresh one"*). Treat as success, toast *"A fresh invitation was sent to {email}."*
  - **5xx:** *"Couldn't send the invitation. Try again in a minute."*
- The API response does **not** include the raw invite token (spec §4.3 rule). Don't try to surface it in the UI — the user receives it via email (or the dev log).

`features/auth/useCreateInvite.ts` — React Query mutation wrapping `POST /api/auth/invitations`. Invalidates nothing (no invite list view in V1).

**2.3 The Desk.**

`pages/Desk.tsx`:

- **Overview ribbon** — 4 tiles horizontally. Each: big number in `font-serif` (`text-5xl`), caption in mono (`text-xs`). Tiles:
  1. `data.entities.total` documents
  2. `data.entities.scored` entities indexed (actually total entities — see API shape)
  3. `data.contradictions.potential + confirmed` — amber dot if > 0, clickable → opens AuditDrawer
  4. `Math.round(data.entities.scored / data.entities.total * 100)` % archive coverage
- Source: `useEvidenceSummary()` hook.

- **Recently added** — horizontal scroll-snap gallery of last 6 documents. `useDocuments({ limit: 6 })` + client-side sort by `created_at` desc (no `sort` query param on the API per §A.2).

- **Worth following** — vertical list of 4–8 "leads." V1 lead generation is a simple mix:
  - Contradictions (`useContradictions({ status: 'confirmed', limit: 3 })`) → "Contradiction confirmed: …"
  - Recent high-corroboration entities (fetch `useEntities({ limit: 50 })`, client-side sort by `corroboration_score` desc, take top 3) → "New entity: …". The API has no `sort` param on `/api/entities` (§A.3); sorting is client-side.
  - Auto-taxonomy suggestions: skipped in V1 (no API endpoint documented).
  - If none of the above have data, show a single placeholder card: "The archive needs more documents before leads emerge."

**Never invent query params.** If sorting/filtering isn't in §A for a given endpoint, do it client-side on a reasonable `limit`. If the dataset is too big for client-side sort, that's the signal to add the param server-side — file it as an issue rather than working around it.

**Acceptance (Phase 2):**
- Dragging a PDF onto the Archive page triggers upload and eventually adds a row.
- Desk shows real numbers or a clean empty state.
- Filter rail narrows the document list.

**Commit:** `feat(demo): desk overview + archive list with upload`

---

### Phase 3 — Ask (search + Q&A) *(target: 3 days)*

**3.1 `pages/Ask.tsx`.**

Default view: centered prompt (max-w-2xl). Big input (height 56px, `text-lg`). Placeholder cycles through 3 examples every 5s (subtle, fade 400ms):
- "Who appears in multiple sightings between 1997 and 2001?"
- "What contradictions exist about CUFOS history?"
- "Show documents related to the Phoenix Lights."

Submit:
- `useSearch(query, { explain: true })` fires `POST /api/search`.
- Input slides to top (translate-y animation, 220ms).
- `AnswerCard` composes in below.

**3.2 `AnswerCard`.**

- Wrap in `bg-surface` card, radius-lg, border thread, shadow-sm, padding 6.
- Prose section: render top re-ranked chunk's `content` with light prose styling. This is the "answer." For V1, no LLM answer composition above what the API returns — the top chunk + neighboring chunks serve as the answer, shown as a single merged block.
- Below: "Citations" header + a vertical list of `CitationCard` (one per result). Each:
  - Document title + `PageRange`
  - Story title
  - Snippet (first 140 chars of chunk content, serif, italic)
  - Confidence bar
  - Click → navigates to Case File at the right page, marks the chunk briefly with amber underline.

**3.3 `RetrievalTrace`.**

Disclosure triangle below answer: "How I found this."

Expanded content:
- Strategy breakdown: for each of `vector`, `fulltext`, `graph`, show how many results contributed. Tiny bars.
- Seed entities: list of entity names that seeded the graph traversal. Pills.
- Rerank status: whether Gemini reranking applied. Mono label.

Uses `explain` field from search response.

**3.4 Command Palette (`⌘K`).**

`components/CommandPalette/CommandPalette.tsx` — wraps Radix Dialog + `cmdk`. Invoked from anywhere with `⌘K` / `Ctrl+K`.

Search groups (in order):
1. **Documents** — `useDocuments({ search: query })` debounced.
2. **Entities** — `useEntities({ search: query })` debounced.
3. **Go to** — static navigation ("Go to Desk", "Go to Board"…).
4. **Actions** — "Upload document", "Toggle theme", "Log out".

Each result: left-aligned icon (lucide) + label + right-aligned `kbd`-style shortcut if applicable.

Selection navigates or performs the action. Enter = select, arrows navigate, Esc closes.

`lib/shortcuts.ts` — a small registry of global keyboard shortcuts with a `useShortcut(key, handler)` hook that binds to `document.keydown`. Register:
- `⌘K` / `Ctrl+K` → open command palette
- `⌘.` / `Ctrl+.` → toggle Audit drawer
- `G` then `D` → Desk, `G A` → Archive, `G B` → Board, `G S` → Ask (S for "search")
- `/` → focus nearest search input
- `?` (shift+/) → show shortcuts overlay
- `Esc` → close top-most drawer/dialog (Radix handles this per component; the registry only coordinates global state)

**Input-guard rule.** Every shortcut handler checks `document.activeElement` first. If the active element is `<input>`, `<textarea>`, or `[contenteditable]`, non-modifier shortcuts (`G`, `/`, `?`) are ignored so they don't hijack typing. `⌘`-prefixed shortcuts always fire.

**Acceptance (Phase 3):**
- Typing a query and submitting surfaces real cited results from a real API.
- Clicking a citation deep-links into the Case File at the right page.
- `⌘K` opens the palette. Typing fuzzy-matches documents and entities. Enter selects.

**Commit:** `feat(demo): ask — search + command palette`

---

### Phase 4 — Board (knowledge graph) *(target: 4 days)*

**4.1 `GraphCanvas`.**

`components/Graph/GraphCanvas.tsx` wraps `@xyflow/react`. Data pipeline:

```
useEntities({ limit: 200 })           → nodes
useAllEdges(nodeIds)                  → edges
apply force-directed layout           → positions (d3-force, first pass only, then persist in xyflow)
```

**Edges strategy.** The API exposes `GET /api/entities/:id/edges` per entity (§A.3) but **no bulk/aggregate edge endpoint** is documented. `useAllEdges(nodeIds)` fans out one request per node in parallel via `useQueries`, deduplicates edges by `id`, and caches each per-entity list so re-hovering a node is free.

**Budget.** With 200 nodes, that's 200 parallel requests on first Board load. Cap at `max 200 nodes` for V1, and add a one-sentence footer caveat: *"Showing the 200 most-corroborated entities. Full graph support comes with an aggregate edge endpoint."* If this becomes a bottleneck, file an issue to add `GET /api/entities/edges?entity_ids=...` server-side — do not hack around it with deep polling or sequential fetches.

**4.2 Custom nodes.**

- `PersonNode` — circle, initials in mono, diameter scales with `corroboration_score * 40 + 20`.
- `LocationNode` — map-pin shape (SVG path).
- `EventNode` — hex (SVG path).
- Merged entities (`canonical_id` set): double-ring treatment.
- Selected: 2px amber outline, scale 1.05.
- Hover: non-adjacent nodes drop to 10% opacity (class change).

**4.3 Custom edges.**

- `RelationshipEdge` — 1px solid, thread-strong.
- `DuplicateEdge` — 0.5px dashed, ink-subtle.
- `ContradictionEdge` — 1.5px dashed, carmine at 40% opacity.
- `ConfirmedContradictionEdge` — 2px solid, carmine.

**4.4 `GraphControls`.**
- Bottom-left: `+ / −` zoom, fit button, "list view" toggle.
- Top-right: Radix `ToggleGroup`s for entity types and edge types (filter).

**List view.** When toggled, `GraphCanvas` hides and a flat `<ul>` of entities renders in its place (same container). Each row: `EntityPill` + relationship count + click → drawer. This is the keyboard-accessible alternative to the visual graph (required for a11y — screen readers cannot consume an SVG graph). Tab order top-to-bottom, Enter opens the entity drawer.

**4.5 `TimelineScrubber`.**
- Bottom band, 64px tall, `bg-surface` with rule-top.
- Radix Slider range (`value={[minYear, maxYear]}`). Axis shows decade ticks.
- Dragging filters nodes to those with events/attributes in range. 180ms debounce.

**4.6 Assembly animation.**

On first visit in a session: nodes fly in from viewport edges in 3 waves (400ms each). Edges draw after. Use xyflow's `fitView` on load + manual staggered opacity via `data-*` attributes. Keep total ≤ 1.5s. Reduced-motion: skip entirely.

**4.7 Node click.**

Opens `EntityProfileDrawer` — same component used in Case File. Zero duplicate logic.

**Acceptance (Phase 4):**
- Board renders with 50+ nodes smoothly at 60fps.
- Filters hide/show node+edge types immediately.
- Timeline scrubber updates the graph smoothly.
- Clicking a node opens the same drawer used elsewhere.

**Commit:** `feat(demo): board — entity graph with timeline and filters`

---

### Phase 5 — Audit drawer *(target: 2 days)*

**5.1 `AuditDrawer`.**

Triggered by header icon or `⌘.`. Right-side Radix Dialog, 480px wide.

Tabs (Radix Tabs):
1. **Contradictions** — default if any `confirmed` exist.
2. **Source reliability** — list of sources with reliability scores.
3. **Evidence chains** — theses + supporting records.

**5.2 `ContradictionCard`.**

Split card (2 columns, divided by vertical thread rule):
- Each side: `valueA` / `valueB` in mono, surrounded by the story citations (linked to Case File).
- Below the split: if `analysis` present, Gemini's verdict with confidence and explanation. Otherwise: "Awaiting resolution" amber tag.
- Actions: "Mark resolved" / "Dismiss" / "Open in Case File"
- Resolution fires a mutation — for V1, actions can be UI-only if the API doesn't yet expose mutation endpoints. Document with a tiny "demo only" tag if so.

**5.3 `SourceReliabilityList`.**
- Rows: document thumbnail + title + reliability bar + reliability label (e.g. `moderate`).
- Click → Case File for that source.

**5.4 `EvidenceChainList`.**
- Cards: thesis in display-serif + "Supported by N records" + mini list of supporting entities.
- Click → expand inline to see the chain.

**Acceptance (Phase 5):**
- Drawer opens from any page without layout shift.
- All three tabs show real data or clean empty state.
- Cards are legible, not crowded.

**Commit:** `feat(demo): audit drawer — contradictions, reliability, chains`

---

### Phase 6 — Polish & demo asset production *(target: 2–3 days)*

**6.1 Hero moments QA.**

For each of the 5 Hero moments in the design doc §4, record a 5-second Playwright video and visually grade it. Fix anything that feels slow, janky, or understated. Specifically verify:
- **Hero 1 (Reveal)** — staggered compose-in is smooth, feels choreographed not buggy.
- **Hero 2 (Echoing Entity)** — amber sweep fires on exactly the right DOM ranges, hover card doesn't flicker.
- **Hero 3 (Ask)** — answer slides in smoothly, citation click smoothly navigates.
- **Hero 4 (Board)** — assembly choreography reads as intentional.
- **Hero 5 (Contradiction)** — split card is immediately parseable.

**6.2 Loading + empty + error states.**

Walk every screen with:
1. No session → login card ✓
2. API offline → error state per page, offering retry.
3. Empty data → `EmptyState` illustration + one-sentence copy + action.
4. Loading → skeleton or narrated progress, never a generic spinner.

Error boundary at route level (`app/ErrorBoundary.tsx`) catches renderer errors and shows "The archive is offline." with a reload button — never a white screen.

**6.3 Accessibility pass.**

Install and wire axe-core:

```bash
npm i -D @axe-core/react
```

`src/main.tsx`:

```ts
if (import.meta.env.DEV) {
  const [React, ReactDOM, axe] = await Promise.all([
    import('react'),
    import('react-dom'),
    import('@axe-core/react'),
  ]);
  axe.default(React.default, ReactDOM.default, 1000);
}
```

Open every route in dev; every console violation must be zero before shipping. Then:
- Manual keyboard-only test: tab through every screen, confirm focus order, confirm `Esc` closes every drawer and the command palette.
- Verify screen reader announces page changes (use `aria-live="polite"` on the `<main>` label or the route-level `<h1>`).
- Check color contrast on the amber-on-paper underline in both themes (AA minimum).

**6.4 Keyboard shortcuts overlay.**

`?` opens a modal listing every registered shortcut from `lib/shortcuts.ts`. Columns: shortcut + description.

**6.5 Demo recording (Playwright).**

Script in `demo/scripts/record-demo.ts` per CLAUDE.md's "Open-Source-Projekt Finalisierung" → GIF section. Beats per design doc §9.2:

1. Empty archive, drag-drop PDF in.
2. Upload progress.
3. Case File opens, Hero 1 fires.
4. Hover entity → Hero 2.
5. `⌘K` → "contradictions about CUFOS" → enter.
6. Ask answer + citation click.
7. Navigate to Board — assembly.
8. Fade to logo.

Output: `assets/demo.gif` via `ffmpeg -i tmp-video/*.webm -vf "fps=15,scale=1200:-1:flags=lanczos" -loop 0 assets/demo.gif`.

**6.6 Hero screenshot.**

Playwright takes a single PNG of the Case File viewer with an 8-story document loaded, one entity hovered (so Hero 2 is visible in the shot), drawer closed. Save to `public/hero-case-file.png`. Update README.md's top image.

**6.7 README + roadmap.**

- Update README progress bar for H11 + any M8 work completed ancillarily.
- Add a "V1 Frontend" section to README linking the live demo URL.
- Brief devlog entry: `devlog/YYYY-MM-DD-v1-frontend.md`, 3–5 sentences, type `milestone`.

**6.8 Cloudflare Pages deploy.**

Configure Cloudflare Pages to build `demo/` per CLAUDE.md's instructions. Verify `https://mulder.mulkatz.dev` (or the configured subdomain) serves the site and the API CORS config allows it.

**Acceptance (Phase 6):**
- All hero moments captured at demo quality.
- `assets/demo.gif` < 4MB, loops cleanly.
- README hero screenshot is the single best-looking artifact in the repo.
- axe-core reports zero violations.
- Site is live at the public URL.

**Commit:** `docs: V1 frontend demo assets + deploy` + separate `chore:` commit for any ancillary README/devlog updates.

---

## 6b. Testing Strategy (deliberately minimal)

V1 is a demo, not a product at scale. Heavy unit testing slows down iteration without meaningful payoff. Test selectively:

- **No Vitest unit tests for components.** Components evolve visually too fast for unit tests to pay off in V1.
- **Pure utilities get tested.** `lib/format.ts`, `lib/cn.ts`, `lib/mention-index.ts`, `lib/colors.ts` — add Vitest (`demo/vitest.config.ts`) and cover the matching/formatting logic. These are the functions most likely to silently regress.
- **One Playwright smoke test per page** (Phase 6). Boots the app, logs in with a seeded test user, navigates to the page, asserts the canonical element renders. Total wall-clock ≤ 30s for all routes. Source: `demo/tests/smoke.spec.ts`. No snapshots, no visual regression — just "does it render."
- **Phase 1 has a Phase-1-specific Playwright test** (see acceptance criteria) — it's the H11 gate.
- **axe-core runs continuously in dev** (Phase 6.3).
- **No CI integration for V1.** Run tests locally before merge. Add CI as follow-up if the test count grows beyond ~20.

The goal: tests defend against the regressions that would embarrass us on stage, not exhaustive coverage.

---

## 6c. Drawer & palette state management

§4 lists three store files in `app/stores/`. They are plain React contexts — no Zustand, no Redux. Pattern:

```tsx
// app/stores/EntityDrawerStore.tsx
type EntityDrawerState = { entityId: string | null };
type EntityDrawerApi = { open(id: string): void; close(): void };

const StateCtx = createContext<EntityDrawerState | null>(null);
const ApiCtx = createContext<EntityDrawerApi | null>(null);

export function EntityDrawerProvider({ children }: { children: ReactNode }) {
  const [entityId, setEntityId] = useState<string | null>(null);
  const api = useMemo(() => ({
    open: (id: string) => setEntityId(id),
    close: () => setEntityId(null),
  }), []);
  return (
    <StateCtx.Provider value={{ entityId }}>
      <ApiCtx.Provider value={api}>{children}</ApiCtx.Provider>
    </StateCtx.Provider>
  );
}

export const useEntityDrawerState = () => { const s = useContext(StateCtx); if (!s) throw new Error('…'); return s; };
export const useEntityDrawerApi   = () => { const s = useContext(ApiCtx);   if (!s) throw new Error('…'); return s; };
```

**Why two contexts.** State and API are split so components that only *open* the drawer (entity pills, board nodes, citation cards) don't re-render when the drawer state changes. Components that need to know *whether* the drawer is open (e.g. Layout's `<EntityProfileDrawer>` mount point) subscribe to state.

`AuditDrawerStore` and `CommandPaletteStore` follow the same pattern. Providers nest inside `<Providers>` (§5.2 of design doc § app/providers.tsx).

---

## 7. Architecture Decisions Baked In

These are settled. Don't revisit mid-implementation.

1. **Light mode default.** Dark is a toggle, not the default. No `prefers-color-scheme` detection.
2. **No SSR.** Vite SPA. Good enough for a demo + Cloudflare Pages.
3. **No state library.** React Query (server state) + URL state (page/filter params) + `useState`/`useContext` (UI state). No Zustand, no Redux, no Jotai.
4. **No design-system framework.** Radix unstyled primitives + our Tailwind tokens. No MUI, Chakra, Ant, shadcn copy-paste.
5. **Radix, broadly.** User approved expanding beyond the 4-primitive minimum. Use it wherever an accessible primitive matters (drawers, menus, tooltips, tabs, accordion, scroll area, tooltip, slider, toggle group).
6. **PDF.js directly, not `react-pdf`.** Better control, smaller bundle, easier to customize rendering + overlays.
7. **No "chat" framing.** Ask is a research console. No conversation memory in V1. No avatars, no "How can I help you?"
8. **Real data, always.** If a feature depends on pipeline output that isn't yet there for the demo corpus, show a labeled placeholder — never fake data.
9. **Voice consistency via `copy.ts`.** Every user-facing string goes through the catalog. Reviewers flag any hardcoded strings.
10. **Accessibility is a blocker.** axe-core green before merge. Keyboard-only usable. `prefers-reduced-motion` honored.

---

## 8. Gotchas (common traps, addressed)

- **Cross-origin cookie trap (Spec 77).** Session cookies are `HttpOnly` + `SameSite=Strict`. If the frontend fetches `http://localhost:8080/api/*` directly from `http://localhost:5173`, the browser will **not** send the cookie — the endpoint returns 401 on what looks like a valid session. Fix: always go through the Vite dev proxy (§5.9). In production, frontend and API must be on the same registrable domain (e.g. `mulder.mulkatz.dev` + `api.mulder.mulkatz.dev`), API sets `SameSite=None; Secure` when on HTTPS, and `Access-Control-Allow-Origin` is explicit (not `*`) with `Access-Control-Allow-Credentials: true`.
- **403 handling.** A `member` session calling an admin route returns 403. React Query already skips retry on 403 (§5.7). Surface as a sonner toast with copy *"You don't have permission to do that."* — not a redirect. If you see a 403 on a route you rendered, that's a bug in gating the trigger — fix the caller, not the handler.
- **pdf.js worker path.** Vite handles `pdfjs-dist/build/pdf.worker.min.mjs?url` correctly only with the right import. If you see a worker error, that's the fix.
- **`credentials: 'include'`** must be set on every fetch, including `pdfjs.getDocument`. If the PDF pane mysteriously returns 401, check this.
- **Radix Portal + Tailwind v4.** Portaled content is outside the app root. Theme CSS variables are inherited from `:root` / `.dark`, so this works without extra work — but if you see unthemed popovers, make sure `.dark` is on `<html>`, not just `<body>`.
- **`@custom-variant dark`** in the theme uses `:where(.dark, .dark *)`. Do not change to `@media (prefers-color-scheme)` — the toggle would break.
- **Story frame alignment.** PDF pages render at varying scales. Your story-frame overlay must use the actual rendered viewport of each page (expose via a resize observer on each page canvas), not a hardcoded ratio.
- **React Query + 401.** Our global handler fires a `window` event. Don't rely on it inside components that mount only for authenticated users — AuthGate must catch the event at the root.
- **Hero animations stacking.** Use `animation-delay` per element based on index, but cap total duration so documents with 80 stories don't take 10 seconds to reveal. Cap at 1.8s total regardless of count.
- **Virtualized PDF canvas.** Pages unmount their canvas when out of view. Save page dimensions on first render so thumbnail and story frame layout don't jump on scroll.
- **`recharts` bundle cost.** Sparkline only, in the entity drawer. If the drawer lazy-loads (React.lazy), recharts loads only when needed. Otherwise reconsider in Phase 5 polish.
- **Cross-tab sessions.** If the user logs out in one tab, other tabs should log out too. Listen for `storage` events on a marker key, or just accept that the 401 path handles it cleanly enough for V1.

---

## 9. Definition of Done (per phase)

Before declaring a phase complete:

1. ✅ `npm run build` succeeds with zero TypeScript errors.
2. ✅ `npm run lint` passes.
3. ✅ Manual walkthrough in dev browser confirms every acceptance criterion for the phase.
4. ✅ Dark + light both look correct on the new screens (not just one).
5. ✅ Keyboard-only navigation works on the new screens.
6. ✅ `git diff` contains zero placeholder TODOs.
7. ✅ Atomic commits with semantic messages, Co-Authored-By trailer.
8. ✅ For Phase 1 only: roadmap flipped, progress bar updated, short devlog entry written.

---

## 10. Out of Scope for V1 (say no to these)

If the user or your inner perfectionist asks for any of these, answer: "After V1."

- Self-serve password reset / "forgot password" flow (out of scope per Spec 77 §2)
- OAuth / OIDC / SSO / social login (out of scope per Spec 77 §2)
- Multi-factor auth
- Managing existing invitations (viewing, revoking, resending) — V1 ships the create-invite path only; management is a follow-up
- "Owner" role assignment from the UI — CLI-only, intentional
- Multi-workspace / multi-tenant
- Mobile-first redesign (responsive degradation is enough)
- Internationalized UI chrome (DE/EN switch — infra allowed but not required)
- Live collaboration / real-time multi-user
- Offline mode
- PDF annotation tools (highlights, notes)
- Full text editor for entity attributes
- Dashboards with charts beyond the Desk's 4 tiles
- Any feature depending on M10–M14 (provenance, trust, research agent)

---

# Appendix A — API Contract Cheat Sheet

What the frontend consumes. All routes live under `VITE_API_BASE_URL`. Session cookie (`mulder_session`) travels automatically via `credentials: 'include'`.

## A.1 Auth (Spec 77 / issue #195 — already landed per commit `af5897c`)

The browser consumes only these routes for auth. Operator API keys (Authorization: Bearer) are for CLI/server-side only — the web bundle must never carry one.

```
POST  /api/auth/login
      body: { email, password }
      → 200 { user: { id, email, role }, expires_at }
      → 401 generic: "invalid_credentials" (never reveals whether email or password was wrong)
      sets Set-Cookie: mulder_session=<opaque>; HttpOnly; SameSite=Strict; [Secure in HTTPS]

POST  /api/auth/invitations/accept
      body: { token, password }
      → 200 { user, expires_at } (+ session cookie set)
      → 400 invalid password (too short / fails server policy)
      → 410 invite consumed or expired
      → 404 invite token not found

POST  /api/auth/logout
      → 204 (clears cookie)
      Idempotent — safe to call even if no session

GET   /api/auth/session
      → 200 { user: {id, email, role}, expires_at }
      → 401 if no session cookie or session expired
      Browser should call this on app bootstrap via useSession()

POST  /api/auth/invitations                        ← ADMIN-GATED
      auth: operator API key OR session with role owner|admin
      body: { email: string, role: 'member' | 'admin' }
      → 201 { id, email, role, status: 'pending', expires_at }
      → 403 if session role is 'member'
      → 409 duplicate active user (email already has an account)
      → 200 on re-invite of a pending email (prior invite invalidated, fresh one issued)
      Response never contains the raw invite token — delivered via email/dev log only.
```

**Role model (spec §4.4):** `owner`, `admin`, `member`. Invite creation allowed for owner/admin or any valid operator API key. This is narrower than future RBAC — keep role checks centralized in `useAuth().isAdmin` so later `L5` work can extend without a UI rewrite.

**Failed-login copy.** Spec §4.3: generic error. Use one message across all 401s from `/api/auth/login`: *"Those credentials didn't match."* — never "email not found" or "wrong password."

## A.2 Documents (H10 — what H11 directly consumes)

```
GET  /api/documents?status={...}&search={...}&limit={1..100}&offset={n}
     → 200 DocumentListResponse

GET  /api/documents/:id/pdf         → 200 application/pdf (stream)
GET  /api/documents/:id/layout      → 200 text/markdown   (stream)
GET  /api/documents/:id/pages       → 200 DocumentPagesResponse
GET  /api/documents/:id/pages/:num  → 200 image/png|jpeg
```

```ts
type DocumentRecord = {
  id: string;
  filename: string;
  status: 'ingested' | 'extracted' | 'segmented' | 'enriched' | 'embedded' | 'graphed' | 'analyzed';
  page_count: number | null;
  has_native_text: boolean;
  layout_available: boolean;
  page_image_count: number;
  created_at: string;
  updated_at: string;
  links: { pdf: string; layout: string; pages: string };
};

type DocumentListResponse = {
  data: DocumentRecord[];
  meta: { count: number; limit: number; offset: number };
};

type DocumentPagesResponse = {
  data: { source_id: string; pages: { page_number: number; image_url: string }[] };
  meta: { count: number };
};
```

## A.3 Entities (H8)

```
GET   /api/entities?type={...}&search={...}&taxonomy_status={auto|curated|merged}&limit&offset
      → 200 EntityListResponse

GET   /api/entities/:id
      → 200 EntityDetailResponse

GET   /api/entities/:id/edges
      → 200 EntityEdgesResponse

POST  /api/entities/merge
      body: { target_id, source_id }
      → 200 { merged_id }
```

```ts
type EntityRecord = {
  id: string;
  canonical_id: string | null;
  name: string;
  type: string;
  taxonomy_status: 'auto' | 'curated' | 'merged';
  taxonomy_id: string | null;
  corroboration_score: number | null;
  source_count: number;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type EntityAlias = { id: string; entity_id: string; alias: string; source: string | null };

type EntityDetailResponse = {
  data: {
    entity: EntityRecord;
    aliases: EntityAlias[];
    stories: { id: string; source_id: string; title: string; status: string; confidence: number | null; mention_count: number }[];
    merged_entities: EntityRecord[];
  };
};

type EntityEdge = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship: string;
  edge_type: 'RELATIONSHIP' | 'DUPLICATE_OF' | 'POTENTIAL_CONTRADICTION' | 'CONFIRMED_CONTRADICTION' | 'DISMISSED_CONTRADICTION';
  confidence: number | null;
  story_id: string | null;
  attributes: Record<string, unknown>;
};

type EntityEdgesResponse = { data: EntityEdge[] };
```

## A.4 Search (H7)

```
POST  /api/search
      body: { query: string; strategy?: 'vector'|'fulltext'|'graph'|'hybrid'; top_k?: number; explain?: boolean }
      → 200 SearchResponse
```

```ts
type SearchResult = {
  chunk_id: string;
  story_id: string;
  content: string;
  score: number;
  rerank_score: number;
  rank: number;
  contributions: { strategy: 'vector'|'fulltext'|'graph'; rank: number; score: number }[];
  metadata: Record<string, unknown>;
};

type SearchResponse = {
  data: {
    query: string;
    strategy: 'vector'|'fulltext'|'graph'|'hybrid';
    top_k: number;
    results: SearchResult[];
    confidence: {
      corpus_size: number;
      taxonomy_status: 'not_started'|'bootstrapping'|'active'|'mature';
      corroboration_reliability: 'insufficient'|'low'|'moderate'|'high';
      graph_density: number;
      degraded: boolean;
      message: string | null;
    };
    explain?: {
      counts: Record<string, number>;
      skipped: string[];
      failures: Record<string, string>;
      seed_entity_ids: string[];
      contributions: unknown[];
    };
  };
};
```

## A.5 Evidence (H9)

```
GET  /api/evidence/summary
GET  /api/evidence/contradictions?status={potential|confirmed|dismissed|all}&limit&offset
GET  /api/evidence/reliability/sources?scored_only={true|false}&limit&offset
GET  /api/evidence/chains?thesis={text}
GET  /api/evidence/clusters?cluster_type={temporal|spatial|spatio-temporal}
```

```ts
type EvidenceSummary = {
  data: {
    entities: { total: number; scored: number; avg_corroboration: number };
    contradictions: { potential: number; confirmed: number; dismissed: number };
    duplicates: { count: number };
    sources: { total: number; scored: number; data_reliability: 'insufficient'|'low'|'moderate'|'high' };
    evidence_chains: { thesis_count: number; record_count: number };
    clusters: { count: number };
  };
};

type ContradictionRecord = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship: string;
  edge_type: 'POTENTIAL_CONTRADICTION'|'CONFIRMED_CONTRADICTION'|'DISMISSED_CONTRADICTION';
  story_id: string | null;
  confidence: number | null;
  attributes: { attribute: string; valueA: string; valueB: string };
  analysis: { verdict: 'confirmed'|'dismissed'; winning_claim: 'A'|'B'|'neither'; confidence: number; explanation: string } | null;
};
```

## A.6 Jobs (H6)

```
GET  /api/jobs?status=running&limit&offset    → JobListResponse
GET  /api/jobs/:id                            → JobDetailResponse
```

```ts
type Job = {
  id: string;
  type: string;
  status: 'pending'|'running'|'completed'|'failed'|'dead_letter';
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_log: string | null;
};
```

## A.8 Pipeline / Upload (H5)

The exact HTTP shape of ingest is less certain than the query routes — verify in `apps/api/src/routes/` before implementing. Most likely:

```
POST  /api/pipeline/ingest
      content-type: multipart/form-data
      fields: file (required), filename (optional)
      → 202 { job_id, source_id }

GET   /api/pipeline/sources/:id       → 200 DocumentRecord (optional — may not exist)
```

Progress is observed via `GET /api/jobs/:id` (§A.6). If `/api/pipeline/ingest` returns 404, the upload feature is not supported server-side yet — fall back to the CLI note per §6 Phase 2.2.

**Agent action on Phase 2 start:** before wiring the UI, `curl -X POST` the endpoint against the local API to confirm the contract. Update this section with the actual shape observed. Five minutes of verification saves a day of rework.

## A.9 Error envelope (all endpoints)

```ts
type ApiErrorBody = {
  error: {
    code: string;        // e.g. 'AUTH_UNAUTHORIZED', 'NOT_FOUND', 'CONFIG_INVALID'
    message: string;
    details?: unknown;
  };
};
```

Status mapping:
- **400** validation error
- **401** auth required → front-end redirects to login
- **403** forbidden (role mismatch)
- **404** not found
- **429** rate limited → show "slow down" toast
- **5xx** server error → show "service error" state with retry

## A.10 Rate limit tiers (§10.7 of functional spec)

- **Strict** (search with rerank): 10/min/IP. Keep `explain=false` by default to stay out of strict tier when possible.
- **Standard** (entity/story reads, search without rerank): 60/min/IP.
- **Relaxed** (status polling): 120/min/IP. Safe to poll every 5s.

---

# Appendix B — Fixtures you can lean on

`/Users/franz/Workspace/mulder/fixtures/` has real pipeline output committed. If a local API isn't running, these can be served via a quick Vite dev-only adapter, but **don't ship any such adapter**. It's only for bootstrap development. All production code must go through the real API.

- `fixtures/raw/` — test PDFs
- `fixtures/extracted/` — Document AI output
- `fixtures/segments/magazine-issue-1/seg-001.md` + `.meta.json` — real story markdown & metadata
- `fixtures/entities/` — real entity extraction output
- `fixtures/embeddings/` — real embedding outputs

For the demo recording, consider committing a small curated demo corpus (3–5 processed documents) that reliably produces the Hero moments. Label it as demo data.

---

# Appendix C — Commands you'll run a lot

```bash
# Dev server
cd demo && npm run dev

# Type-check + build
cd demo && npm run build

# Lint
cd demo && npm run lint

# Start the local API (from repo root)
pnpm --filter @mulder/api dev

# Run a PDF through the local pipeline (from repo root)
pnpm mulder ingest <path>
pnpm mulder pipeline run <id>
```

---

# Appendix D — Hand-off checklist for starting a fresh session

When resuming this plan in a new Claude session, first run through:

1. Read `docs/roadmap.md` — confirm M7.5 V1–V6 status. V1 is the current step if H11 hasn't closed yet; otherwise pick up at the next ⚪ step.
2. Read this file entirely — front to back, no skipping.
3. Read the design doc (`docs/v1-web-app-design.md`) §2 (visual language), §4 (hero moments), §5 (screen specs). Skim §6 (interaction details).
4. Open `demo/src/index.css` — confirm design tokens are intact. If anything looks stripped, investigate before proceeding.
5. `cd demo && npm install` — deps current.
6. `cd demo && npm run dev` — app must boot cleanly. Fix any errors first; do not write new code on a broken tree.
7. **API readiness check.** In a second terminal:
   ```bash
   cd /Users/franz/Workspace/mulder
   pnpm --filter @mulder/api dev
   # then in a third terminal:
   curl -i http://localhost:8080/api/health          # must return 200
   curl -i http://localhost:8080/api/auth/session    # must return 401 (no session yet), NOT connection refused
   ```
   If the API doesn't boot, fix that first. Frontend phases beyond Phase 0.3 (primitives) assume a running API.
8. **Identify current phase** — by inspecting the repo, not memory:
   ```bash
   git log --oneline -20                                  # recent commits tell the story
   grep "PROGRESS" README.md | head -5                    # roadmap bar shows M7 state
   ls demo/src/app demo/src/pages demo/src/features 2>/dev/null
   ```
   Match what exists against §4 (file structure) and §6 (phases). The first phase with missing files or acceptance criteria unmet is your starting point.
9. **Verify Spec 77 prerequisites still stand.** `git log --all --grep "af5897c\|browser.*invite\|spec.*77" --oneline` — the invite-auth backend must be landed before any Phase 0 auth work has meaning.
10. Start the next unstarted phase. Do not rewrite already-landed phases.

*End of plan.*
