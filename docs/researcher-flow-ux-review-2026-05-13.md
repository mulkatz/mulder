# Mulder Researcher Flow UX Review

Date: 2026-05-13
Environment: live IGAAP deployment at https://igaap.mulder.work
Scope: source intake, processing visibility, source list, split reader, source-level translation, request pressure

## Executive Summary

The core end-to-end shape is now real: a researcher can reach the app, inspect sources, open a source reader, see extracted stories with entity highlighting, and switch to a source-level translation. The product direction is sound, but the current flow still feels technical and brittle in the moments where researchers need reassurance: upload start, processing wait, source readiness, and reader failure states.

Three blocking issues surfaced during the live review and were fixed immediately:

- Anonymous `/` access looped on "Checking session" instead of redirecting to login.
- Reader polling plus automatic 429 retries could push the API past the 60/minute document GET limit.
- Original PDF rendering was blocked by deployment/API delivery issues: `.mjs` worker MIME type and missing CORS headers on binary PDF responses.

The most important remaining UX work is not a large redesign. It is a clearer state model: one researcher-facing status per source, one visible next action, and fewer raw processing details leaking into primary surfaces.

## What Was Tested

- Anonymous entry at `/`
- Invitation acceptance and authenticated session creation
- Research Desk overview
- Add Sources form structure and validation states
- Sources list and selected-source side panel
- Reader route `/sources/:id`
- Original/document pane, extracted story pane, entity highlighting
- Translation target switch and translated source view
- Processing details disclosure
- Cloud Run/API logs for 429 request patterns
- Binary PDF fetch behavior with browser `Origin`

The temporary audit account used for the review was removed after testing.

## Fixes Applied During Review

| Area | Problem | Change | Status |
|---|---|---|---|
| Auth entry | `/` could stay forever on "Checking session" for anonymous users. | `useSession()` now treats 401 as "no active session", and the global 401 handler no longer removes the active auth query. | Deployed |
| Rate limiting | Active reader polling could create bursts across detail, stories, layout, pages, and observability; 429s were retried automatically. | 429 is no longer retried automatically; active processing poll interval increased to 10s; stable reader queries get `staleTime`. | Deployed |
| PDF worker | Nginx served `.mjs` as `application/octet-stream`, which can break PDF.js worker loading. | Added app Dockerfile/nginx config serving `.mjs` as JavaScript. | Deployed |
| PDF API CORS | `/api/documents/:id/pdf` returned a raw binary `Response` without CORS headers on 200. | CORS middleware reapplies headers after `next()`, covering binary responses. | Deployed |

## Current UX Strengths

- The split reader direction is strong: original left, interpreted content right, context secondary.
- Entity highlighting in extracted stories is useful and appropriately absent in translated content.
- Source-level translation is conceptually clear once the user sees "Extracted stories" vs "Translated source".
- The Add Sources form captures the right provenance primitives for v1.
- The Sources list gives a useful corpus-level entry point and a readable side panel.

## Main Weaknesses

### 1. The Add Sources Page Feels Like a Form, Not a Guided Intake

The intake page has the right fields, but it asks the user to understand the whole provenance model upfront. The visible hierarchy is flat: files, language, source type, acquisition, authenticity, custody, sensitivity, collection, confirmation, upload table. For a researcher, this reads as administrative data entry rather than "I am adding a source safely."

Recommended change:

- Split the page visually into four stages without changing routes:
  1. Files
  2. Provenance
  3. Collection and sensitivity
  4. Review and upload
- Keep all stages visible on desktop, but add a compact progress rail or section headers.
- Show "why this matters" only as short helper text near risky fields, not as long explanatory copy.
- Make the upload button area a review summary: files count, collection, language, sensitivity, confirmation status.

### 2. Collection Assignment Is Too Easy To Skip Without Understanding Consequences

The no-collection warning exists, but it is a checkbox inside a side panel. It does not explain the operational effect: where the source will appear, whether defaults apply, and how to assign it later.

Recommended change:

- When no collection is selected, show a compact warning block in the main upload summary.
- Use concrete copy: "No collection defaults will be applied. You can assign a collection later from source details."
- If a collection is selected, show applied defaults as chips: language, sensitivity, custody defaults if available.

### 3. Upload Progress Is Stage-Based But Does Not Set Expectations

The upload states are technically good, but users need to know that byte progress is not available and that processing can continue after upload. Without this, "processing" can feel stuck.

Recommended change:

- Keep per-file rows, but add a small status explainer:
  - Uploading file
  - Registering source
  - Processing content
  - Ready to open
- For processing, show the current source-level readiness rather than raw job labels.
- After a batch finishes, provide a clear batch result panel: created, duplicates, unavailable, failed.

### 4. Processing Details Leak Into Product Surfaces

Overview and source panels show labels such as "Unknown processing type: translate" and worker messages. These are useful for debugging, but they undermine researcher trust when surfaced as primary activity.

Recommended change:

- Introduce a display-name map for job types, including translation and quality.
- Hide worker identifiers by default.
- Primary copy should be researcher-facing: "Translation completed", "Content extraction completed", "Search indexing running".
- Keep raw job IDs, worker IDs, and payloads inside a disclosure labeled "Technical details".

### 5. Reader Initial Load Still Does Too Much At Once

The reader currently loads source detail, stories, layout, pages, PDF, translations, observability, and evidence context close together. This is why the rate-limit issue was easy to trigger. The immediate throttling fix helps, but the architecture still treats the reader as many independent polling surfaces.

Recommended change:

- Make document detail the root query.
- Load stories and pages as core reader data.
- Load PDF only when the original pane is visible.
- Load layout preview only when PDF is unavailable or the user expands extracted-text preview.
- Load observability on open and poll only while the source is actively processing.
- Load evidence signals only after a story is selected.

Longer-term API improvement:

- Add a single reader bootstrap endpoint that returns source detail, story list metadata, readiness, and processing summary. Keep large content endpoints separate.

### 6. Reader Failure States Need Better Recovery Language

The PDF failure state was honest but generic. It said the original could not be rendered, but not whether the source itself was usable, whether extracted stories were still trustworthy, or what retry does.

Recommended change:

- Distinguish:
  - Original unavailable
  - Original loading
  - Original unsupported
  - Original blocked by API/session
  - Original failed to render, extracted content still available
- Keep the story pane usable even when original PDF fails.
- Add a compact "Reader health" indicator only when something is degraded.

### 7. Story List Is Dense And Hard To Scan

The story list is valuable, but each item mixes title, page range, language, type, readiness, and confidence. The repeated "English / sighting_report / Searchable / 95%" creates noise.

Recommended change:

- Use a two-line story item:
  - Title and page range
  - Status chips only when they differ or matter
- Hide language if it matches the source.
- Hide confidence unless below a threshold or user opens details.
- Use source-type labels as secondary metadata, not equal-weight chips.

### 8. Translation Works But Needs Stronger Mode Framing

The translated source view is conceptually correct, and entity highlights are disabled. The weakness is that users can easily miss that translation is source-level assembled content, not aligned story-by-story content.

Recommended change:

- Rename mode buttons to "Stories" and "Source translation" for tighter labels.
- In translated mode, show a small persistent note: "Source-level translation. Entity highlights are shown only in extracted stories."
- "Translate again" should be a menu or secondary action; the primary button should be "View translation" when current translation exists.
- If target language equals source language, default to a disabled explanatory state or hide the translate action.

### 9. Overview Has A Broken Primary Action

The Research Desk showed a disabled "Add Sources" button while the sidebar and topbar "Add Sources" links work. That creates doubt immediately after login.

Recommended change:

- Make the Research Desk Add Sources action a real link to `/sources/add`.
- Avoid disabled primary actions on the overview unless there is a clear permission reason and visible explanation.

### 10. Navigation Contains Too Many Disabled Product Promises

The sidebar has many disabled future areas. That may be useful for roadmap signaling, but in a live research workflow it makes the product feel unfinished and increases cognitive load.

Recommended change:

- For this phase, group disabled future modules under a collapsed "Coming later" disclosure or remove them from primary navigation.
- Keep active navigation limited to Research Desk, Sources, Add Sources, Reader through Sources, Evidence, Processing.

## 429 Strategy

Immediate changes are deployed:

- No automatic retry on 429.
- Active reader processing poll is 10s instead of 4s.
- Stable reader queries have a 30s freshness window.

Recommended next step:

- Treat 429 as a product state, not just an error. If a query gets 429, show "Refreshing too quickly; retrying shortly" and back off using `Retry-After`.
- Add jitter to polling so multiple tabs do not synchronize.
- Stop polling when the tab is hidden.
- Prefer polling one observability/readiness query and invalidating content queries only when readiness changes.

## Priority Backlog

### P0

- Keep `/` redirect, 429 retry suppression, binary CORS, and `.mjs` MIME fixes deployed.
- Make Research Desk "Add Sources" active.
- Replace unknown job type labels with human display names.
- Verify fresh uploads no longer hit 429 during active processing.

### P1

- Reframe Add Sources as a staged intake.
- Add upload completion summary with clear next actions.
- Reduce reader initial query fan-out.
- Improve reader degraded-state copy for original/PDF failures.
- Make story list less noisy.

### P2

- Add a reader bootstrap endpoint.
- Add source readiness timeline as a product object.
- Add collection default preview and later reassignment affordance.
- Add translation mode explanation and refresh affordance polish.

## Product Principle

The central object should be the source, not the job. Jobs are provenance and operations background. The user should always understand:

- What source did I add?
- What does Mulder currently know about it?
- What is still processing?
- What can I safely read or use now?
- What should I do next?

If each screen answers those five questions, the flow will feel much less brittle without requiring a large visual redesign.
