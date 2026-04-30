# Mulder V1 Web App — UX/UI & Feature Design Document

> **Legacy notice:** This document is retained as historical context for the removed V1 `demo/` app. It is superseded by [`docs/product-app-design-strategy.md`](./product-app-design-strategy.md) for current browser product work in `apps/app`. Do not use this document as the current visual, IA, or product strategy.

> **Milestone:** M7.5 V1–V6 (see [`roadmap.md`](./roadmap.md)). V1 also satisfies the M7-H11 roadmap anchor.
> **Companion:** [`docs/v1-web-app-plan.md`](./v1-web-app-plan.md) — the phase-by-phase implementation blueprint.
> **Audience:** Investors, early users, and the engineering team building this out.
> **Posture:** This is not a dev tool demo. This is the product's first impression. Every pixel needs to earn the next funding round.

---

## 0. The One-Sentence Pitch

> **Mulder turns shelves of unreadable paper into a living case board you can interrogate.**

Everything in this design serves that sentence. If a screen doesn't make someone feel like an investigator with superpowers, we cut it or redesign it.

---

## 1. Why This V1 Exists (The Strategic Brief)

A demo has three jobs, in order:

1. **Make someone feel something in the first 10 seconds.** Not informed — *felt*. A tiny emotional hook: "Oh. This is different."
2. **Let them *do* something in the first 60 seconds.** Passive watching is forgettable. A single click, keystroke, or hover that produces surprise = conversion.
3. **Leave a mental model they can repeat to others.** If they can't describe what Mulder does to a colleague the next morning, the demo failed.

This document is the blueprint for all three.

### What this V1 is NOT
- A file manager with a PDF preview (that's Dropbox).
- A dashboard of metrics (that's boring, and metrics without stakes are noise).
- A neutral "platform" UI. The project has a voice. We'll use it.
- A finished product. It's a stage. We're lighting the parts that matter and leaving the rest in shadow.

### What this V1 IS
- A **narrated tour** of one investigation, from PDF to pattern, that happens to be a working application.
- A proof that the pipeline behind it is real — no mocks, no "coming soon" blocks.
- A showcase of five *hero moments* (§4) that each carry a funding argument on their own.

---

## 2. Brand Voice & Visual Language

### 2.1 Voice

The project is named after Fox Mulder. We are not going to pretend it isn't. But we're not building a theme park either — the reference is *tonal*, not literal. No green-on-black terminals. No "I Want to Believe" posters.

**Voice attributes** — in priority order:

1. **Investigative.** Calm, precise, confident. Not excitable. A good detective shows you the evidence and lets it speak.
2. **Literary.** The product moves documents — so the interface respects reading. Serif headlines. Generous margins. Quotes pulled like epigraphs.
3. **Archival.** Timestamped, numbered, indexed. Nothing floats — everything has provenance.
4. **Quietly futuristic.** The intelligence is obvious but never announces itself. No "AI-powered ✨" badges. No sparkles. If we did our job, the magic is the defaults.

**Copy examples:**

| Bad (what we avoid) | Good (Mulder voice) |
|---|---|
| "AI-powered document analysis" | "487 pages. 42 stories. 318 named entities. Indexed in 6 minutes." |
| "Upload your files" | "Add documents to the archive" |
| "Error: Processing failed" | "Couldn't read page 14. The scan is too dark. Re-upload or skip?" |
| "Loading…" | "Reading page 47 of 92" |
| "Dashboard" | "The desk" |
| "Search" | "Ask the archive" |
| "Entity not found" | "No record of *Allan Hendry*. Suggest adding a source?" |

Every piece of copy in the V1 is written. No Lorem Ipsum, no generic placeholders.

### 2.2 Color system

Two palettes — we pick one for V1 based on which better photographs (see §9.4). My strong recommendation: **Dossier** (dark-first).

#### Palette A — "Dossier" (dark, cinematic, recommended)
```
--ink:        #0B0D10   /* near-black background — slightly blue-cold */
--paper:      #14171C   /* surface 1 — cards, panels */
--vellum:     #1C2028   /* surface 2 — hover, raised */
--thread:     #2A2F39   /* borders, dividers */
--bone:       #E8E4DA   /* primary text — warm ivory, not pure white */
--bone-dim:   #9DA2A8   /* secondary text */
--ash:        #5D6168   /* tertiary, timestamps */

--amber:      #D4A24A   /* primary accent — "highlighted evidence" */
--amber-soft: rgba(212,162,74, 0.15)
--cobalt:     #6B8CFF   /* secondary accent — links, interactive */
--carmine:    #D9534F   /* contradictions, errors */
--sage:       #7AB89A   /* corroborated, success */
```

#### Palette B — "Archive" (light, editorial, refined)
```
--paper:      #F5F1E8   /* warm cream, not white */
--ink:        #191613   /* near-black text */
--thread:     #D8CFBE
--amber:      #8B5A1F
--cobalt:     #2B4FB3
--carmine:    #A8322D
--sage:       #3D7A5F
```

Both palettes reject cold tech-sterility (no `#FFFFFF`, no `#000000`, no pure gray). Everything has a warm bias — we want it to feel like paper and lamplight, not a spreadsheet.

### 2.3 Typography

Three families. No more.

- **Display serif** — `GT Alpina` (paid) or `EB Garamond` (free, nearly as good). Used for: document titles, hero headlines, story titles, pull-quotes. Always tight leading (1.1), generous size (32–64px for hero, 20–28px inline).
- **UI sans** — `Inter` (free, variable, excellent). Used for: buttons, labels, navigation, body UI text. 14px base, 15px for reading-heavy panels.
- **Mono** — `JetBrains Mono` or `Berkeley Mono`. Used for: IDs, timestamps, page numbers, status codes, confidence scores, hashes. Small (11–12px), muted. It's the "official stamp" texture.

Use of mono is crucial — it's what makes UI elements feel *archival* rather than generic.

### 2.4 Iconography & motifs

- **Iconography** — `lucide-react` (already in the demo). Line icons only, 1.5px stroke, no fills. Never mix icon families.
- **Page numbers** as a first-class UI element. Always formatted `p. 14` or `pp. 12–14`, in mono.
- **Confidence** rendered as a small horizontal bar, never as a percentage alone. "94%" is a number. A 94%-filled bar with a 6% remainder in --thread *feels* like 94%.
- **Status lights.** Tiny 6px circles next to items in the sidebar: amber = processing, sage = complete, carmine = failed, ash = skipped.
- **Motifs** (used *sparingly*, not as a theme park):
  - Thin vertical rule between split-view columns (like a book gutter).
  - Page-number gutter running down the left edge of any long document.
  - Dotted guide lines connecting related elements in detail views (echoing the "red string" board).

### 2.5 Motion language

Motion is what separates a demo that feels alive from one that feels drawn.

- **Default easing** — `cubic-bezier(0.22, 1, 0.36, 1)` ("expoOut"). All transitions 180–280ms. Nothing slower unless it's a hero moment.
- **Hover states** — 120ms. Must be instant enough to feel physical.
- **Entity pills** — when a new entity is extracted in a live view, it *composes in* — a 220ms fade + 4px rise.
- **Graph** — nodes settle via force simulation on first reveal (1.5s choreographed animation). Never on every interaction.
- **Page changes** — the PDF panel uses a micro-crossfade between pages (140ms), not a jarring swap.
- **No parallax, no scroll-jacking, no "scrollytelling."** We respect the user's scroll.
- **Reduced-motion users** — honor `prefers-reduced-motion`; all animations collapse to instant.

---

## 3. Information Architecture

The V1 has **four top-level destinations**. Anything more is noise for a demo. Each has a one-word name drawn from archival/investigative vocabulary.

```
┌─────────────────────────────────────────────────────────────┐
│ MULDER                            [⌘K]  [ user ] [ logout ] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   THE DESK   ARCHIVE   BOARD   ASK                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

| Name | What it is | Internal route |
|---|---|---|
| **The Desk** | Landing / overview. Shows what's new, unresolved, and worth investigating. | `/` |
| **Archive** | The collection of documents (H10 endpoints). Open one → **Case File** viewer. | `/archive` and `/archive/:id` |
| **Board** | The knowledge graph (H7/H8 entities + edges). Zoom from 10,000-ft to person-to-person. | `/board` |
| **Ask** | The interrogation console (H7 search). Natural-language queries → cited answers. | `/ask` |

A fifth, latent destination — **Audit** (H9 evidence: contradictions, reliability, chains) — lives as a panel that drawers in from the right on any page. It's not hidden; it's *contextual*. You don't visit audit, you *invoke* it.

**Why four tabs, not eight:**
A demo has 90 seconds of navigation attention before the user stops exploring and starts looking for the "this is what I meant" thing. Four labels, each a noun, each obviously different, is the maximum.

**Everything else we have** (status monitoring, taxonomy curation, job queue, admin) is either:
- Ambient (status lights, toasts) — appears only when relevant, and disappears.
- Deferred (`/admin` prefix, not in main nav) — powerful but off the happy path.
- Keyboard-invoked (`⌘K` command palette) — power users find it, normal users never need it.

---

## 4. The Five Hero Moments

A hero moment = a single experience you can screenshot/record and show to an investor and they *get it* without narration. Each is a funding argument.

### Hero 1 — "The Reveal"
**Where:** Archive → open a freshly-processed document for the first time.
**What happens:** The PDF appears in the left panel. Over 2.0 seconds, a choreographed animation fires:
1. Page boundaries subtly pulse (120ms per page, staggered).
2. Story regions draw on top — thin colored frames around detected stories. A whisper of sound (optional, off by default) — a single soft page-turn.
3. In the right panel, entity pills *compose in* one by one, in the order they appear in the document. Each pill has a tiny 2px ring when it first arrives, fading to 0 over 400ms.
4. For documents that had contradictions flagged in the pipeline, a single 🔺 icon appears in the corner of the affected story region, as if it just became visible. Subtle, not alarming.

**Why it matters:** This is the "oh." The user uploaded a 92-page PDF. In one pass, it is now 12 stories, 47 people, 8 places, 3 contradictions. Shown, not told.

**Engineering note:** All data is already there (pipeline finished). The animation is choreographed on mount with a `useEffect` + staggered `requestAnimationFrame`. It's not slow because of computation; it's slow because slowness is the point. Skippable via space bar or auto-skip for returning visits.

### Hero 2 — "The Echoing Entity"
**Where:** Case File viewer — hover any entity name in the story text.
**What happens:**
1. Every occurrence of the same entity in the visible document gets a 200ms amber underline animation — sweeping from left-to-right, like a reader drawing with a pencil.
2. A *ghost card* appears to the right of the cursor with: canonical name, type, aliases in 2–3 other languages, corroboration score bar, source count ("Appears in 4 other documents →").
3. In the right-panel story list, the stories that mention this entity get a subtle amber dot.

**Why it matters:** The entire *point* of the pipeline is that it links a name in this document to a name in 40 others, in any language. This interaction makes that connection viscerally obvious. It's the difference between a search engine and an index.

### Hero 3 — "Ask the Archive"
**Where:** `/ask` or triggered via `⌘K` from anywhere.
**What happens:**
1. A centered, uncluttered input. Placeholder: *"Ask anything. 'Who appears in multiple sightings between 1997 and 2001?'"*
2. User types. On submit, the answer area slides in from the bottom.
3. The answer is *not* a chat bubble. It's a one-paragraph prose answer, followed by numbered citations like a Wikipedia article. Each citation is clickable; clicking scrolls the Case File viewer to the exact page.
4. A tiny disclosure triangle reveals "How I found this" — a miniature explanation: which retrieval strategies contributed (vector, BM25, graph), and which entities seeded the graph traversal. This is the `explain=true` response from H6, rendered as a human-readable trace.

**Why it matters:** It's not a chatbot. It's a *researcher's tool*. The trace makes the system feel honest — nothing is hand-waved. Investors who've been burned by "AI hallucinates sources" will exhale visibly.

### Hero 4 — "The Board"
**Where:** `/board`
**What happens:**
1. Entities render as nodes in a force-directed graph (use `@xyflow/react`, already in deps — but style it heavily, not default).
2. Default view is zoomed out enough to show clusters but not individual labels. Hover = labels fade in.
3. Scroll to zoom. At high zoom, nodes show portrait placeholders (for persons) or tiny map thumbnails (for locations from PostGIS).
4. Click a node → right panel slides in with entity profile. Click an edge → the evidence behind the relationship.
5. Contradiction edges are **dashed and carmine**. Confirmed edges are solid. Duplicate-of edges are thin ghost lines.
6. A tiny timeline scrubber at the bottom filters edges by the year they were established in any source. Dragging it *unbuilds and rebuilds* the graph.

**Why it matters:** This is the emotional payoff of the whole system. Every document you've ever processed is one frame in this graph. An investor looking at a graph of 1,200 nodes and 3,800 edges understands *scale* in a way no bar chart conveys.

**Engineering note:** V1 doesn't need 1,200 nodes. It needs 60–120 with the option to zoom. We ship with a fixture-driven demo dataset if real data is sparse, but label it as such — no fake numbers.

### Hero 5 — "The Contradiction"
**Where:** Audit drawer (right-side drawer, invoked via header icon or `⌘.`)
**What happens:**
1. Drawer shows top unresolved items as cards.
2. A contradiction card is split down the middle. Left side: *"Allan Hendry was stationed at CUFOS in 1978."* Right side: *"Allan Hendry was stationed at CUFOS in 1976."*
3. Each side has source citations. Below: Gemini's resolution, when present — *"The 1978 claim is likely correct. It's cited by two primary sources published close to the date. The 1976 claim is a retrospective account."*
4. User can mark it resolved, keep watching, or dismiss.

**Why it matters:** Anyone who's ever done investigative research knows the hardest part is keeping two sources straight. Mulder *notices* when they disagree. This single card is a concrete example of the system's intelligence that a layperson immediately grasps.

---

## 5. Screen-by-Screen UX

### 5.1 Authentication — First run

**Invite accept:** single centered card. Application logo. One sentence: *"You've been invited to the Mulder archive."* One field: password (with strength meter). One button: Enter. No marketing copy, no "Welcome aboard!" No animation of confetti. Nothing. Quiet dignity.

**Login:** same visual vocabulary. Email + password. Below the button, in muted text: *"Forgot your password? Ask your operator for a fresh invitation."* (No self-serve reset in V1; invite-only is the point.)

**Post-login transition:** fade-to-black for 200ms, then The Desk composes in. Small detail that reads as expensive.

### 5.2 The Desk (Home)

Not a "dashboard." A *curated desk view* of what's worth looking at right now. Vertical scroll, three bands:

**Band 1 — Overview ribbon (single row, scroll-snapped)**
Four tiles, each with a number in display-serif and a single-line caption in mono:

- `847` · documents in archive
- `12,483` · entities indexed
- `3` · contradictions needing review  ← amber ring if nonzero
- `68%` · archive coverage (corroborated entities / total)

**Band 2 — Recently added**
Horizontal gallery of the last 6 documents. Each card: thumbnail of page 1, title, page count, status light. Click → open Case File.

**Band 3 — Worth following**
A vertical list of 4–8 cards, each one representing a *lead*. Types of leads:
- "New entity: 'Jennie Zeidman'. Appears in 3 documents, 2 languages." → open entity.
- "Pattern: 6 sightings within 80km of Phoenix, March 1997." → open board, zoomed.
- "Contradiction confirmed: conflicting dates for CUFOS founding." → open audit.
- "Taxonomy suggestion: merge *CUFOS* and *Center for UFO Studies*?" → taxonomy review.

These are generated from: evidence summary counts, new ingests since last session, unresolved contradictions, high-corroboration new entities, and discovered clusters.

**What makes this screen work:** No chart-junk. No pie charts, no donuts, no line charts just to have them. A demo dashboard full of charts is a cliché that signals *I don't know what to put here*. The Desk has presence because it has *voice* — it tells you what matters, not just what exists.

### 5.3 Archive (Document list)

Two-pane list/detail layout.

**Left pane — filter rail (collapsible, 200px):**
- Quick filters: All / Recently added / In progress / Needs review
- Source type (pdf, image, email, url — checkboxes)
- Date range (sliding)
- Status pipeline (visual: thin horizontal pipeline showing where documents are stuck)
- Language

**Right pane — document table:**
- Thumbnail + title + page count + entities found + status
- Sort by: recent / alphabetical / size / entity density
- Click row → opens Case File (§5.4)
- Selection mode (checkboxes appear on hover of first column) for batch operations — V1 shows the affordance, V1 does not require it to work beyond "delete" and "reprocess"

**Empty state (zero documents):**
A single centered illustration (line-art folder) with text: *"The archive is empty. Drop a PDF anywhere on this screen to begin."* Drag-and-drop from anywhere on the screen kicks off the ingest flow. A progress indicator appears in the header as the job runs. Done properly, the first-time experience has **zero buttons clicked** to feel magic.

### 5.4 Case File (the split-view viewer) — *the H11 core*

This is the screen H11 literally requires. Everything else in this doc is supporting cast.

**Layout (desktop, >1280px):**

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ← Archive   ·   MUFON Journal, March 2017   ·   92 pages  ·  en  ·  ⚠ 1│
├──────┬──────────────────────────────────────────────┬───────────────────┤
│ pg 1 │                                              │ STORIES (12)      │
│ pg 2 │                                              │                   │
│ pg 3 │                                              │ ▸ The Phoenix     │
│  …   │            PDF PAGE VIEWPORT                 │   Lights          │
│ pg47 │         (rendered via pdf.js)                │   Revisited       │
│  …   │         story frames overlaid                │   pp. 1–4  ·  94% │
│      │                                              │                   │
│      │                                              │ ▸ Witness Testim. │
│      │                                              │   pp. 5–8  ·  91% │
│      │                                              │                   │
│      │                                              │ … (10 more)       │
├──────┴──────────────────────────────────────────────┴───────────────────┤
│  Entities in this story:  [M. Henderson] [Prescott Valley] [1997] [+4]  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Left rail (80px):** Page thumbnails, scroll-linked to viewport. Active page has amber accent. Pages that are the start of a new story have a small bookmark icon.

**Center (flex, min 640px):** PDF rendered via `pdf.js`. Story frames — thin colored outlines — overlay on top of pages, aligned to `pageStart`/`pageEnd` metadata. Each has a floating label at its top-left with the story title and page range.

**Right rail (360px):** Story list, with expansion. Expanded story shows:
- Story title (display serif)
- Subtitle, language, category
- Extraction confidence bar
- First 200 chars of the story markdown (pulled from `/api/documents/:id/layout`), followed by *"Read full story →"* → expands into a reading view (see §5.4.1).
- Entities mentioned as tappable pills
- 🔺 if any contradictions touch this story

**Bottom bar:** The *entity strip*. Horizontally scrollable row of pills for all entities in the currently-visible story. Hovering one triggers Hero 2 (§4).

**Top bar:** Breadcrumb, document title, quick actions (open original PDF in new tab, download layout.md, mark reviewed), and a tiny signal showing pipeline status for this document.

**Mobile / narrow (< 900px):** Stack vertically. Story list on top, PDF below, entities drawer-invoked. The split-view is inherently desktop-first; we don't pretend otherwise, but we degrade cleanly.

#### 5.4.1 The Reading View (story expansion)

Clicking "Read full story" in any story card transitions into a **focused reading mode**. The PDF panel dims. The story content takes center stage — rendered Markdown with:
- Display-serif title, appropriate line length (680px max column).
- Inline entity highlights — subtle amber underline on hover, click = entity profile drawer.
- Sidenote callouts (bracketed like `[1]` in text) for metadata: dates referenced, geographic mentions. Sidenotes render in the margin on wide screens, as footnotes on narrow.
- A faint "back to PDF" link in top-left. Escape key exits.

This mode is the **reading experience**. It's the reason the pipeline outputs Markdown at all. If the demo doesn't include a screen where someone *reads the extracted text and thinks "this looks like an article in a magazine,"* we've buried the payoff.

### 5.5 Board (graph view)

Full-viewport force-directed graph (`@xyflow/react` with heavy custom styling — we'll need to override most defaults).

**Controls (bottom-left, minimal):**
- Zoom + / −
- Fit to screen
- Search (filter to matching labels)
- Timeline scrubber (drag to see graph state at a point in time — edges fade in/out based on when they were asserted in a source)

**Controls (top-right):**
- Filter: entity types to include (multi-select)
- Filter: edge types (relationship, duplicate, contradiction, confirmed contradiction)
- Layout mode: force / hierarchical / geographic (if entities have coordinates)

**Node design:**
- Person: circle with soft initials; if merged (`canonical_id`), shown as a stacked double-circle silhouette
- Location: map-pin shape; if coordinates exist, colored by region
- Event/other: hex or diamond depending on type
- Size proportional to `corroboration_score` (more corroborated = larger; but clamp max size to avoid chaos)

**Edge design:**
- Relationship: 1px solid --thread, slightly amber on hover
- Duplicate-of: 0.5px dashed, --ash
- Potential contradiction: 1.5px dashed, --carmine at 40% opacity
- Confirmed contradiction: 2px solid, --carmine

**Empty / loading states:**
First render shows an assembly animation: nodes fly in from the edges of the viewport in waves, edges draw afterwards. ~1.5 seconds. This is a hero moment — do it right.

**Hover a node:** Edges not touching it fade to 10% opacity. Adjacent nodes keep labels. Ripples outward subtly.

**Click a node:** Right drawer opens with the entity profile, which is also linked to from the Case File pills — it's the same component (§6.2).

### 5.6 Ask (search / Q&A)

Default view: a single centered prompt area. Below it, in muted text, 3 example queries drawn from the loaded corpus:

- *"Who are the most-cited researchers in the 1997 documents?"*
- *"What contradictions exist about CUFOS history?"*
- *"Show sightings near Phoenix between 1996 and 1998."*

On submit:
- Input slides to the top.
- An answer card composes in. It has:
  - The answer — 2–4 sentences, prose, with numbered citation markers.
  - Citations section — each one is a clickable card with: document title, page range, story title, confidence bar, 2-line snippet.
  - A disclosure: *"How I found this"* — expands to show retrieval trace: which strategies (vector, BM25, graph) contributed, which seed entities were used, whether re-ranking was applied.
- If `confidence.degraded: true`, a single-line amber banner above the answer: *"The archive is small. Take this lightly."*

Prior queries persist in the left rail as a history (this session only; V1 doesn't need persistence across sessions).

### 5.7 Audit (drawer — contextual, global)

Accessible from any screen via header icon or `⌘.`. Slides in from the right, 480px wide.

Three tabs:
1. **Contradictions** (default if any unresolved)
2. **Source reliability** — per-source credibility scoring
3. **Evidence chains** — thesis cards showing chains of support

Each item is a self-contained card. Resolving or dismissing a contradiction fires an optimistic UI update + API call. Errors reconcile with a toast.

This is where **§A3–A13 trust-layer features (M10–M11)** will eventually live. V1 shows the scaffolding and as much real data as the current pipeline produces. Placeholder cards for future functionality are clearly labeled *"Arriving in a later release"* — not hidden, not mocked. Transparency sells credibility.

---

## 6. Interaction Design — The Details That Separate Good From Memorable

### 6.1 Command palette (`⌘K`)

From anywhere, `⌘K` opens a centered dialog with a search input. Typing searches across:
- Documents by title
- Entities by name (across all languages)
- Stories by title
- Navigation shortcuts ("go to board", "open audit", "log out")

Results grouped, keyboard-navigable, 180ms fuzzy. This is the professional's entrance. Power users never touch the mouse. Investors who work in Linear / Raycast / Superhuman recognize this pattern immediately and register the product as *serious*.

### 6.2 Entity profile drawer — global, reusable

One component. Invoked from:
- Case File entity pills
- Board node clicks
- Ask answer citations
- Audit drawer entity links

Renders:
- Display-serif name
- Type badge with color
- Corroboration score (bar, not number)
- Sources count + inline miniature (stacked document-card thumbnails, max 4, *"+N more"*)
- Aliases grouped by language
- Key attributes (role, dates, coordinates, etc.) rendered as a definition list
- Related entities — top 6, with relationship labels
- Sparkline: mentions over time (if dates exist)
- Actions: *"Merge with…", "Add alias", "See on Board →"*

One consistent UI, reached from many places. Reduces cognitive load. Invests design capital once.

### 6.3 Highlighting & co-selection

Fundamental principle: *hovering one thing should illuminate its relationships.*

- Hover a page thumbnail → the PDF panel dims pages that aren't on screen + highlights the hovered one's boundaries.
- Hover a story in the right rail → the PDF shows that story's frame thicker + scrolls its first page into view (with a brief yellow sweep).
- Hover an entity pill → Hero 2 (§4.2).
- Hover a citation in Ask answer → the source document title lights up in the rail (if archive is open alongside).

These are small, 120ms, subtle. But together they produce the feeling that the system is *connected internally* — which is exactly the feeling we're selling.

### 6.4 Empty states, loading, errors — the neglected 80%

Most apps spend 100% of their design budget on the happy path. Mulder earns funding by spending 40% on states where things go sideways.

**Loading** — never a generic spinner. Specific progress messages: *"Reading page 47 of 92"*, *"Extracting entities from story 4 of 12"*. Skeletons for known-shape content. Shimmer lines for text. A toy: when the pipeline is processing a new upload, a tiny animated typewriter on the desk types the extraction as it happens. Playful but not gimmicky.

**Empty states** — always have three elements:
1. A muted line-art illustration (max 2 colors).
2. One sentence of copy in Mulder voice.
3. One action the user can take.

Example, empty Archive: *"The archive is empty. Drop a PDF anywhere to begin."* + upload affordance.

**Errors** — diagnostic, not apologetic. *"Couldn't read the PDF — page 14 seems corrupted. You can skip it or re-upload."* Offer action. Never: *"Something went wrong. Try again later."*

**Auth errors** — 401 triggers a *re-auth modal* over the current view (don't lose the user's context with a full redirect). After re-auth, the action resumes.

### 6.5 Keyboard shortcuts

Published on a `?` overlay. Minimum set for V1:

| Key | Action |
|---|---|
| `⌘K` | Command palette |
| `⌘.` | Toggle Audit drawer |
| `G` then `D` / `A` / `B` / `Q` | Go to Desk / Archive / Board / Ask |
| `/` | Focus the search / ask input |
| `J` / `K` | Next / previous in any list |
| `⌘←` | Back (same as browser back) |
| `Space` | Page down in PDF viewer |
| `Esc` | Close drawer / exit reading mode |

### 6.6 Internationalization

The product is DE + EN from day one. Language is a single toggle, upper-right next to the user menu. Entity names remain their canonical form (which may be any language); UI chrome translates.

Importantly, the interface demonstrates that language is *not a filter on content* — it's a filter on *chrome*. German-speaking users reading an English source see English prose with German UI around it. This is exactly the cross-lingual architecture we built.

---

## 7. Responsive & Accessibility

### 7.1 Breakpoints

- `< 768` — mobile. Case File collapses to stacked layout. Board is replaced with a read-only summary ("The board is best on a larger screen — 1,248 entities across 4,203 relationships").
- `768–1279` — tablet. Most screens work. Board renders but with a tighter control cluster.
- `≥ 1280` — desktop. The target. Everything at its best.
- `≥ 1920` — expansive. Use the extra room for a persistent audit drawer on wide screens, if the user pins it.

### 7.2 Accessibility, non-negotiable

- Color contrast AA minimum, AAA for text-on-background.
- Every icon-only button has an `aria-label`.
- Graph is keyboard-navigable via tab (nodes are focusable, arrow keys traverse edges). A text-only "list view" toggle is always available — graph is not the *only* way to inspect relationships.
- PDF panel provides the rendered Markdown as an accessible fallback in a screen-reader-only region.
- `prefers-reduced-motion` honored throughout.
- Focus outlines are designed (2px --amber offset), never removed.

Accessibility is not charity. A product that locks out power users on keyboard, screen readers, or low-contrast displays loses credibility with every sophisticated buyer — and accessibility happens to make the product faster to use for everyone.

---

## 8. Technical Implementation — What H11 Actually Has to Build

This section is the bridge from design to engineering. Details align with the API surface from the exploration report.

### 8.1 Stack

Already in `demo/`, keep it:
- React 19 + TypeScript strict
- Vite (build) + React Router v7 (routing)
- Tailwind CSS 4 (styling — replace the default palette with §2.2 tokens)
- `@xyflow/react` (graph view on Board)
- `lucide-react` (icons)
- `recharts` (only for the sparkline in entity profile; no charts on Desk)

Add:
- `pdfjs-dist` (PDF rendering in Case File) — Mozilla's official PDF.js
- `react-markdown` + `remark-gfm` (reading view Markdown)
- `@tanstack/react-query` (API data layer — caching, retries, invalidation; avoids reinventing)
- `radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tooltip` (primitives — accessible out of the box, unstyled — we style them)
- `cmdk` (command palette — the de-facto React implementation, used by Linear)
- `sonner` (toast library — understated, good defaults)
- `motion` (formerly Framer Motion — hero animations)

Explicit non-goals: no design system framework (no MUI / Chakra / Ant — none match our voice). No CSS-in-JS (Tailwind is enough). No state library beyond react-query + URL state (no Redux, no Zustand for V1).

### 8.2 File structure (proposed)

```
demo/
  src/
    app/
      layout.tsx            # Header, nav, audit drawer slot, toaster
      providers.tsx         # QueryClient, Theme, Router
    pages/
      Desk.tsx
      Archive.tsx
      CaseFile.tsx          # The H11 split-view — replaces old SourceDetail
      CaseFileReading.tsx   # The reading-mode expansion
      Board.tsx
      Ask.tsx
      AuthLogin.tsx
      AuthAcceptInvite.tsx
    components/
      AuditDrawer/
      CommandPalette/
      EntityProfile/        # reusable profile drawer
      EntityPill/
      PDFPane/              # pdf.js wrapper + story overlay
      StoryList/
      StoryReader/          # markdown rendering
      ConfidenceBar/
      StatusLight/
      PageThumbnails/
      GraphCanvas/          # xyflow wrapper + custom nodes/edges
      AnswerCard/           # for Ask
      EmptyState/
      Skeleton/
    hooks/
      useAuth.ts
      useDocuments.ts
      useDocument.ts
      useStories.ts
      useEntity.ts
      useEntities.ts
      useSearch.ts
      useEvidenceSummary.ts
      useContradictions.ts
      useJobs.ts
      useKeyboardShortcut.ts
    lib/
      api-client.ts         # fetch wrapper; credentials: 'include'
      pdf.ts                # pdf.js bootstrap + rendering helpers
      format.ts             # date, page range, confidence bar values
      colors.ts             # entity-type → color mapping (deterministic hash)
      copy.ts               # single source of truth for UI strings
    styles/
      globals.css
      tokens.css            # CSS custom properties from §2.2
      fonts.css
  public/
    fonts/                  # GT Alpina or EB Garamond + Inter + JetBrains Mono
    illustrations/          # line-art empty-state SVGs
```

### 8.3 API integration plan (per route from the exploration report)

All via `lib/api-client.ts`, which sets `credentials: 'include'` so the session cookie flows automatically.

| Hook | Endpoint | Used in |
|---|---|---|
| `useSession` | `GET /api/auth/session` | App bootstrap (redirect to login if missing) |
| `useLogin` | `POST /api/auth/login` | Login page |
| `useAcceptInvite` | `POST /api/auth/invitations/accept` | Invite page |
| `useLogout` | `POST /api/auth/logout` | Header menu |
| `useDocuments(filter)` | `GET /api/documents` | Archive list |
| `useDocument(id)` | `GET /api/documents` (with id filter) | Case File header |
| `useDocumentPages(id)` | `GET /api/documents/:id/pages` | Page thumbnails |
| `usePDFUrl(id)` | `GET /api/documents/:id/pdf` (URL only, not fetched — passed to pdf.js) | PDF pane |
| `useLayout(id)` | `GET /api/documents/:id/layout` | Reading view |
| `useEntities(filter)` | `GET /api/entities` | Command palette, Archive filters |
| `useEntity(id)` | `GET /api/entities/:id` | Entity drawer |
| `useEntityEdges(id)` | `GET /api/entities/:id/edges` | Entity drawer "related" + Board local queries |
| `useSearch(query, strategy)` | `POST /api/search` | Ask |
| `useEvidenceSummary` | `GET /api/evidence/summary` | Desk band 1 |
| `useContradictions` | `GET /api/evidence/contradictions` | Audit drawer |

React Query defaults: 30s stale time for lists, 5min for entity detail, no cache for search (query is the key). On 401, global handler redirects to login.

### 8.4 Auth flow implementation

Per Spec 77 (already partially landed — commit `af5897c`):

- App bootstrap: fire `GET /api/auth/session`. If 401, render `<AuthLogin />` instead of the main router outlet. No flash of unauthenticated content.
- Login form submits to `POST /api/auth/login`. On success, `Set-Cookie` is received + session data returned. Invalidate all queries, redirect to `/` (or the originally-requested route).
- Invite page reads `?token=` from URL. Form: password + confirm + minimum-length feedback. Submit → `POST /api/auth/invitations/accept`.
- All fetches use `credentials: 'include'`. No Authorization header is ever set from the browser. No API key in the bundle.
- Logout → `POST /api/auth/logout`, clear query cache, redirect to login.

### 8.5 PDF rendering

`pdfjs-dist` in a worker. The `PDFPane` component:
1. Takes a `url` prop (the API endpoint).
2. Fetches via `getDocument({ url, withCredentials: true })` so the session cookie travels.
3. Renders pages on a `<canvas>` per page, stacked vertically, virtualization via `react-window` if page count > 30.
4. Stores viewport metrics so story-frame overlays can be positioned in CSS relative to each page.

Pre-condition: H10 must stream PDFs through the API, not serve signed GCS URLs to the browser (they'd sidestep auth). From the exploration report, H10 streams bytes directly — good.

### 8.6 Story-frame overlay

For each story in the document, compute a list of `{ page, topRatio, heightRatio }` tuples using the `pageStart` / `pageEnd` from the metadata. In V1, frames span full pages — we don't yet have pixel-accurate bounding boxes within a page (that would need more metadata from the segment step). A story that runs pages 12–14 shows a colored frame on pages 12, 13, 14 at 100% height.

Later, when segment metadata includes pixel bboxes, frames shrink to the actual regions. V1 honestly advertises what it can do. It doesn't fake precision we don't have.

### 8.7 Performance budget

- First meaningful paint on Desk: < 1.2s on broadband, < 2.5s on 4G.
- Case File with a 92-page PDF: first page visible < 1.5s (pdf.js can render page 1 before the rest).
- Graph with 200 nodes: animates at 60fps.
- Bundle budget: < 400KB gzipped JS for the main route. Lazy-load pdf.js worker, @xyflow, pdfjs-dist (heavy deps not on the Desk).

### 8.8 Build & deploy

`demo/` builds to `demo/dist/`. Deployed to Cloudflare Pages (per CLAUDE.md's open-source-project finalization section) at `mulder.mulkatz.dev`. API lives separately; the frontend uses `VITE_API_BASE_URL` env var, default `http://localhost:8787` in dev, production URL injected at build.

CORS is already configured per the exploration report — `cors.origins` in `mulder.config.yaml` must include `https://mulder.mulkatz.dev` for production.

---

## 9. Presentation Engineering — Making It Photograph Well

For funding, the product appears in:
- One hero screenshot on the README (above the fold)
- A 30-second loop GIF in the README (per CLAUDE.md)
- A 2–3 minute demo video for investor meetings
- LinkedIn posts with carousel slides

We design *toward* these artifacts.

### 9.1 The hero screenshot

The shot that will end up on the README and every deck. Strong candidate: **Case File viewer on a document with 8+ stories extracted**, mid-interaction (one entity pill hovered, one story expanded, one contradiction visible). A single frame that shows: document intelligence, entity resolution, visual design quality, and *motion caught in amber*.

We pre-configure a demo dataset where this shot is reliable. Documents, stories, entities, contradictions — all real pipeline output, pre-processed, committed as fixtures.

### 9.2 The demo GIF (30 seconds)

Storyboard:
1. (0–3s) Empty Archive. PDF is dragged in.
2. (3–6s) Progress bar. *"Reading page 47 of 92"*. Upload completes.
3. (6–9s) Case File opens. Hero 1 (The Reveal) fires.
4. (9–13s) User hovers an entity. Hero 2 (The Echoing Entity) fires.
5. (13–18s) User clicks "Ask". Types *"contradictions about CUFOS"*.
6. (18–23s) Answer slides in with citations. A citation is clicked.
7. (23–28s) Screen transitions to Board. Cinematic assembly animation.
8. (28–30s) Fade to logo + tagline.

Playwright + ffmpeg pipeline per CLAUDE.md instructions in the global `Open-Source-Projekt Finalisierung` section.

### 9.3 The investor demo (2–3 minutes, live or recorded)

Beat structure:
1. **Context** (15s) — "These are 47 magazines of UFO witness testimony from 1995–2005. A researcher would spend 6 months reading them. Let me show you what Mulder did in 20 minutes."
2. **Case File** (40s) — Open a document. Hero 1. Scroll. Hover. Click into reading mode. Read a paragraph aloud. *"Note that this is extracted from a 3-column magazine layout, fully preserved."*
3. **Ask** (30s) — Type a question. Show the answer. Open the trace. *"Not a chatbot. A researcher's tool. Every claim is cited to a specific page."*
4. **Board** (40s) — *"And here's the entire archive as a graph."* Cinematic assembly. Zoom in. Click a node. Show cross-language aliases. *"Same person, five sources, three languages. The system figured it out."*
5. **Close** (20s) — One sentence on the config-driven vision: *"This is UFO archives. Same configuration file can make it medical research, legal discovery, corporate due diligence. The domain lives in one YAML. Everything else is reused."*

Each beat has a designed, rehearsed visual payoff.

### 9.4 Dark vs Light

A/B the hero screenshot in both palettes with 5 people each. Pick the winner by emotional response, not preference. (My prediction: Dossier wins for investors; Archive wins for end-user demos. We ship with a toggle but lead with Dossier.)

---

## 10. Roadmap to V1

A phased plan. Each phase is shippable and demoable on its own — so we can ship early and iterate.

### Phase 0 — Foundations (3–4 days)
- Tokens (colors, typography, spacing) → `tokens.css`.
- Font loading via `fonts.css` with `font-display: swap`.
- `app/providers.tsx` (QueryClient, Theme, Router).
- `lib/api-client.ts` with session-cookie semantics.
- Global layout: Header, nav tabs, toast, command-palette scaffold.
- Auth pages (login, accept invite) wired to real endpoints.

### Phase 1 — Case File (5–6 days) ← **the actual H11 deliverable**
- `PDFPane` with pdf.js + story-frame overlay.
- `PageThumbnails` rail.
- `StoryList` right-rail with expand/collapse.
- `StoryReader` reading mode with Markdown + entity highlights.
- `EntityPill` + `EntityProfile` drawer.
- Hero 1 and Hero 2 implemented.
- Connected to `/api/documents/*` and `/api/entities/*`.

**Ship this as H11 closed.** Everything after is M8+ polish, strictly speaking — but Hero moments need a place to live, so we continue.

### Phase 2 — Archive + Desk (3 days)
- Archive list with filters and empty state (drag-and-drop upload).
- The Desk (overview ribbon, recently added, leads).

### Phase 3 — Ask (3 days)
- Search input + answer card + citations + trace disclosure.
- Command palette (`⌘K`).

### Phase 4 — Board (4 days)
- GraphCanvas with custom nodes/edges.
- Controls (zoom, filters, timeline scrubber).
- Assembly animation.
- Entity drawer integration.

### Phase 5 — Audit (2 days)
- Drawer with contradictions + reliability + chains.
- Resolution actions (mutations).

### Phase 6 — Presentation Polish (2–3 days)
- Hero 3, 4, 5 polish.
- Loading / empty / error states across all screens.
- Accessibility audit (axe CI).
- Keyboard shortcut coverage.
- Playwright demo recording.
- Hero screenshot assembled, README updated.

**Total estimate:** 22–25 focused days. Phase 1 satisfies the roadmap gate for H11 on its own. Phases 2–6 are what turns the demo into the funding pitch.

---

## 11. What Would Make This Fail

Named explicitly so we don't do these things:

1. **Too many features, too little craft.** A Case File that works beautifully beats a Case File + Board + Ask that all feel half-baked. If a phase runs long, we cut the *next* phase, not the craft of the current one.
2. **Generic framework aesthetic.** If it ends up looking like a Shadcn starter, we've failed. Distinctive typography and deliberate color are what communicate "this is a real product."
3. **Fake data.** Every number, every entity, every citation is from real pipeline output. If something is aspirational, it's labeled (*"Arriving in a later release"*), not mocked.
4. **Chat-bot framing.** Ask is a *research console*, not a chatbot. No smiley face, no "How can I help you today?" framing. No conversational memory in V1.
5. **Ignoring performance.** A beautiful app that stutters on a 200-node graph or takes 4 seconds to open a PDF will be remembered as "buggy."
6. **AI theme-park.** No glittering gradients, no sparkles, no "AI-powered ✨" marketing copy. The intelligence shows in the *work*, not in decoration.

---

## 12. The Single Most Important Decision

If every other thing in this document is wrong, but we nail this one thing, we win: **the first 10 seconds after a visitor opens the Case File must be unmistakably excellent.** The typography, the layout, the page rendering, the Hero 1 reveal — if those four things land, everything else has permission to be a work in progress. If those four things feel cheap, no amount of feature depth recovers the impression.

Build outward from Hero 1.

---

## Appendix A — Inspiration References

Pulled from products that solved analogous design problems. For internal mood-board; not copied, studied.

- **Linear** — the operator's respect for keyboard, command palette, motion economy.
- **Are.na** — the quiet, archival feel. Typography that takes content seriously.
- **Readwise Reader** — how to render a reading experience inside a web app without it feeling like a web app.
- **Obsidian Canvas / Kumu** — graph-as-interface, done tastefully.
- **The New York Times archive (NYTimes TimesMachine)** — how to present scanned documents with dignity.
- **Notion's command palette** — interaction pattern only; visual language is too soft for our voice.
- **Superhuman** — loading states as narrative ("Bringing Monday into focus").
- **Axios HQ / Pudding.cool** — editorial typography and pacing in product UIs.

## Appendix B — Open Questions (to resolve before Phase 0)

1. **Palette commitment** — Dossier or Archive for the hero? (Recommended: Dossier. Decide before tokens land.)
2. **Paid font license** — GT Alpina requires a commercial license ($). Acceptable fallback: EB Garamond (free, SIL Open Font License). Decision affects cost and legal.
3. **pdf.js rendering strategy** — canvas-per-page (crisp, expensive) or pdf.js viewer iframe (cheap, less stylable)? Recommended: canvas, virtualized past 30 pages.
4. **Demo dataset** — do we commit a polished fixture set to drive the Hero moments reliably, or do we process real PDFs on demand? Recommended: commit a curated fixture so the demo is deterministic, but also support live ingest.
5. **Invite operator flow** — for V1, who issues invitations, and how? Recommended: CLI-only in V1 (`mulder invite <email>`), no admin UI yet. Demo script walks through `mulder invite` to produce a fresh invite link.

## Appendix C — Things We Intentionally Defer Past V1

Because shipping focus matters.

- Full taxonomy curation UI (M5 CLI is enough for V1).
- Upload flow for anything other than PDF (M9).
- Soft-delete / provenance UIs (M10).
- Role-based access UI beyond login/logout (M11).
- Research agent interface (M14).
- Multi-workspace / multi-tenant UI.
- Mobile-first redesign (responsive degradation is enough).
- SSR / Next.js migration (Vite SPA is fine for this scope).

Each is a real feature. None are V1 features. Saying no is the design decision.

---

*End of document.*
