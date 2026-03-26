---
spec: 01
title: Demo App — Evidence Analysis UI (Spatio-Temporal, Contradictions, Corroboration)
issue: https://github.com/mulkatz/mulder/issues/1
status: draft
created: 2026-03-26
---

# Spec: Demo App — Evidence Analysis UI (Spatio-Temporal, Contradictions, Corroboration)

## 1. Engineering Objective

Add three new interactive pages to the demo app showcasing mulder's full-featured capabilities (CLAUDE.md Capabilities 6 & 7): **Spatio-Temporal Analysis**, **Contradiction Detection**, and **Corroboration Scoring**. These pages use mock data to demonstrate the vision of the Analyze pipeline stage. They integrate with the existing demo app design system (monochrome + entity colors, JetBrains Mono, shadow-hard cards, Tailwind v4) and are accessible from the navigation bar.

## 2. System Boundaries

- **Target Component:** `demo/src/pages/` (3 new pages), `demo/src/data/mock.ts` (new mock data), `demo/src/components/Layout.tsx` (nav updates), `demo/src/App.tsx` (routes)
- **Inclusions:**
  - New page: **Evidence** (`/evidence`) — tabbed page with three tabs: Contradictions, Corroboration, Spatio-Temporal
  - Mock data: contradictions (with POTENTIAL/CONFIRMED/DISMISSED status), corroboration scores (source count, weighted PageRank reliability), spatio-temporal events (locations with coordinates, timestamps, clusters)
  - Navigation: Add "Evidence" nav item between "Graph" and "Boards"
  - Interactive elements: status filters, expandable contradiction details, sortable corroboration table, timeline slider for temporal filtering, cluster visualization
- **Exclusions:**
  - No real map library (Leaflet/Mapbox) — use a stylized SVG/canvas-based location visualization
  - No backend integration — all data is mock
  - No modifications to existing pages beyond navigation
- **Architecture Constraints:** Per CLAUDE.md: demo app uses Vite + React + Tailwind CSS + TypeScript. No new dependencies unless absolutely necessary. Follow existing design patterns (entity badges, confidence badges, status badges, shadow-hard cards).

## 3. Dependencies

- **Requires:** None — standalone demo UI addition
- **Blocks:** None

## 4. Implementation Blueprint

### Files to create

1. **`demo/src/pages/Evidence.tsx`** — Tabbed page with three sections:
   - **Contradictions Tab:** List of contradictions between entities/claims across stories. Each shows: the two conflicting claims, source stories, entity involved, status (POTENTIAL/CONFIRMED/DISMISSED), Gemini analysis summary (mock). Expandable detail view with side-by-side claim comparison.
   - **Corroboration Tab:** Table of entities/claims sorted by corroboration score. Columns: claim, entity, independent source count, corroboration score (0-1), source reliability (weighted PageRank, 0-1), evidence chain strength. Visual bars for scores. Expandable rows showing individual sources and their reliability ratings.
   - **Spatio-Temporal Tab:** Location-based event visualization. Left: scrollable event list with timestamp and location, filterable by date range and entity type. Right: stylized location cluster visualization (SVG circles sized by event density, positioned in rough geographic layout). Timeline scrubber at bottom. Temporal clusters highlighted.

### Files to modify

2. **`demo/src/data/mock.ts`** — Add:
   - `Contradiction` interface and `contradictions` array (6-8 items with varying statuses)
   - `CorroborationEntry` interface and `corroborationEntries` array (8-10 items)
   - `SpatioTemporalEvent` interface and `spatioTemporalEvents` array (12-15 events with lat/lng, timestamp, entities, location name)
   - `TemporalCluster` interface and `temporalClusters` array (3-4 clusters)

3. **`demo/src/components/Layout.tsx`** — Add "Evidence" nav item with `Shield` icon from lucide-react, path `/evidence`

4. **`demo/src/App.tsx`** — Add route: `<Route path="/evidence" element={<Evidence />} />`

### Data flow

- Mock data is imported directly from `demo/src/data/mock.ts`
- All filtering/sorting happens client-side in React state
- Tab state managed via React `useState`
- No API calls, no side effects

### Design specifications

- Follow existing card pattern: `rounded-[var(--radius)] border bg-card shadow-hard`
- Use existing badge components (EntityBadge, ConfidenceBadge, StatusBadge) where applicable
- Status colors for contradictions: POTENTIAL = amber, CONFIRMED = red/destructive, DISMISSED = muted/green
- Corroboration score visualization: horizontal bars with primary color
- Source reliability: star-rating or horizontal bar with gradient
- Spatio-temporal: SVG circles with entity-type colors, pulsing animation for active clusters
- All pages must support dark mode via existing CSS variable system

## 5. QA Validation Contract

1. **Evidence page renders with three tabs**
   - Given: Demo app is running at localhost
   - When: Navigate to `/evidence`
   - Then: Page renders with three visible tab buttons labeled "Contradictions", "Corroboration", "Spatio-Temporal". Contradictions tab is active by default.

2. **Contradictions tab shows mock data**
   - Given: On the Evidence page, Contradictions tab active
   - When: Page loads
   - Then: At least 5 contradiction cards are visible, each showing: two conflicting claims, status badge (POTENTIAL/CONFIRMED/DISMISSED), involved entity names, and source references.

3. **Contradiction status filtering works**
   - Given: On the Evidence page, Contradictions tab active
   - When: Click a status filter button (e.g., "Confirmed")
   - Then: Only contradictions with that status are shown. Count updates.

4. **Corroboration tab shows scored entries**
   - Given: On the Evidence page
   - When: Click "Corroboration" tab
   - Then: A table/list of at least 6 entries appears, each with: claim text, entity badge, source count (integer), corroboration score (0-1 with visual bar), and source reliability score.

5. **Spatio-Temporal tab shows events and visualization**
   - Given: On the Evidence page
   - When: Click "Spatio-Temporal" tab
   - Then: Left panel shows a scrollable list of events with timestamps and location names. Right panel shows an SVG-based location visualization with positioned circles.

6. **Navigation includes Evidence link**
   - Given: Demo app is running
   - When: Look at the top navigation bar
   - Then: "Evidence" nav item is visible between "Graph" and "Boards", and clicking it navigates to `/evidence`.

7. **Dark mode support**
   - Given: Demo app in dark mode (toggle via theme button)
   - When: Navigate to `/evidence`
   - Then: All elements use dark mode colors. No hardcoded light-only colors visible.

8. **Existing pages unaffected**
   - Given: Demo app is running
   - When: Navigate to `/`, `/sources`, `/stories`, `/graph`
   - Then: All existing pages render identically to before this change (no visual regressions).
