# Mulder App Implementation Roadmap

**Status:** Planning baseline after M11 and M12 landed on `main`  
**Branch:** `codex/app-next-roadmap`  
**Audience:** Product, UX, frontend, API, and backend contributors building `apps/app`

---

## 1. Strategic Direction

`apps/app` is the only browser product direction for Mulder. The app is not a demo shell and should not inherit the old V1 demo posture.

Mulder must be understood first as a tool for working with sources, findings, claims, evidence, relationships, and discoveries. Processing remains inspectable and controllable, but it is infrastructure. It should not be the product's first impression.

The core product sentence is:

> Mulder helps researchers understand large, multilingual, contradictory source corpora with traceable evidence and progressively inspectable analysis.

The UI direction remains:

- research-first, system-aware, progressively technical
- content understanding before system monitoring
- sources, claims, evidence, review, search, and knowledge before operations
- clean professional workbench, not cinematic demo, not developer console
- app routes backed by real API contracts, not fixtures

## 2. What M11 And M12 Change

M10 made real ingest productization possible by adding provenance, quality, assertions, sensitivity, rollback, custody, and collections.

M11 adds the trust layer:

- source credibility profiles
- conflict/contradiction management
- review workflow infrastructure
- persisted translation foundations
- RBAC and sensitivity-aware filtering

M12 adds discovery value:

- similar entity/case discovery
- classification harmonization
- temporal patterns and hotspot detection
- external correlation plugins

This changes the app priority. The next app work should not add generic screens. It should expose the new value chain:

1. Sources can be read, understood, translated, and evaluated.
2. Claims, conflicts, credibility, and review tasks become visible human work.
3. Search and knowledge navigation can land on source/story/evidence destinations.
4. Discovery features become hypothesis-generating research tools.

## 3. Current App Baseline

Active app routes:

| Route | Product area | Current purpose |
| --- | --- | --- |
| `/` | Research Desk | High-level workspace pulse and next research signals |
| `/sources` | All Sources | Read-only corpus list with API-backed filters and pagination |
| `/sources/:id` | Source Reader | Original/story split reader with story rail, entity highlights, translation controls, and processing background |
| `/evidence` | Claims & Evidence | Early evidence/contradiction review surface |
| `/runs` | Processing | Operational job history and selected job detail |
| `/login` | Auth | Email/password login |
| `/auth/invitations/:token` | Auth | Invite acceptance |

Current app strengths:

- clean token-driven light/dark shell
- EN/DE i18n with guardrails
- cookie-backed auth
- React Query API binding
- explicit loading, empty, unavailable, and error states
- content-first navigation
- no checked-in app fixtures

Current app limitations:

- many M11/M12 capabilities exist in backend packages but are not mounted as app HTTP read models
- translation UI is prepared, but not bound to a real app contract
- claims/assertions do not yet have source/story offsets for passage-level linking
- Review Queue is still disabled, even though M11 created the backend review workflow primitives
- Discovery features from M12 are not yet visible in the app
- Add Sources is still disabled because the app needs a careful provenance-first ingest UX, not just a file picker

## 4. Non-Negotiable UX Principles

### Content First

Default screens must answer research questions:

- What sources exist?
- What changed?
- What needs review?
- What claims are supported, contradicted, uncertain, or weakly sourced?
- Which entities, relationships, stories, patterns, and correlations matter?
- Where can I inspect the original evidence?

They should not lead with:

- job IDs
- queue internals
- pipeline stages
- API readiness
- raw read-model status

Those details remain available in Operations or secondary disclosure panels.

### Broad Audience

Mulder must work for non-technical researchers and technical operators.

For non-technical users:

- use plain language
- explain uncertainty
- keep operations secondary
- make reading, comparing, reviewing, and citing easy
- avoid Denglisch in German UI

For technical users:

- provide inspectable provenance, traces, IDs, payloads, job history, and artifacts
- keep raw details one click deeper
- make failures and partial data diagnosable

### Multilingual Research

Many sources will not be in the user's native language. Source reading must support:

- original document view
- extracted story/markdown view
- split view
- original-only and story-only modes
- target language selection
- persisted on-demand translation once the M11 translation contract is exposed through HTTP
- clear distinction between original, extracted, translated, and machine-generated content

### Living Documents

Stories should not be plain markdown replicas. They should become living research documents:

- entities highlighted conservatively when offsets are reliable enough
- claim/evidence highlights only after assertion/claim offsets exist
- credibility and contradiction signals visible at story/source level
- citations and provenance exposed without cluttering the reading path
- linked context panels for entities, claims, contradictions, and sources

### Accessibility And Layout

Target posture:

- desktop-first for serious research work
- tablet-capable
- mobile-safe, not mobile-parity

Mobile must support login, invite acceptance, reading, quick review, and status visibility without broken layout. Complex graph exploration, large evidence tables, and processing debug views may show "best viewed on desktop" guidance.

## 5. Information Architecture Target

The current IA remains correct, but activation should now follow M11/M12 readiness.

| Group | Near-term active route | App priority |
| --- | --- | --- |
| Workspace | Research Desk, Review Queue | Review needs, recent findings, watched work, trust alerts |
| Search | Search | Corpus-wide retrieval over sources, stories, claims, entities, and citations |
| Sources | All Sources, Source Reader, Add Sources, Source Quality | Corpus entry, ingest, source understanding, provenance, credibility |
| Findings | Claims & Evidence, Contradictions, Source Reliability, Evidence Chains, Clusters & Timelines | Human review and evidence reasoning |
| Knowledge Base | Entities, Relationships, Knowledge Map, Claim Registry, Taxonomy, Stories | Structured knowledge objects and graph navigation |
| Operations | Processing, Activity, Recovery, Usage & Cost, Exports | Technical status, retry, debug, export |
| Admin | Settings, Members & Access, Policies, Integrations | Workspace setup, roles, access, integrations |

Important distinction:

- `Claims & Evidence` is the human review workflow.
- `Claim Registry` is the structured knowledge-base list of claim/assertion objects.
- `Processing` is operational infrastructure.
- `Research Desk` is the default researcher landing page.

## 6. API Contract Work Required

The app should not guess at backend shape. For each new route, define or confirm the HTTP contract first.

Use [`api-parity-matrix.md`](./api-parity-matrix.md) before activating any app capability. It distinguishes app-ready HTTP contracts from backend-only, CLI/operator-only, partial, and future surfaces.

Existing mounted contracts the app can continue to use:

- auth/session/login/logout/invite acceptance
- status
- documents list, PDF, layout, pages, stories, observability
- jobs list/detail
- search
- entities list/detail/edges/merge
- evidence summary, contradictions, reliability sources, chains, clusters
- uploads initiate/dev-upload/complete

Contracts needed to productize M11:

| Product need | Required app contract |
| --- | --- |
| Review Queue | list queues, list queue artifacts, artifact detail, record review event/action |
| Credibility profiles | source credibility detail, source credibility review status, dimensions, evidence refs |
| Conflict nodes | conflict list/detail, assertions, resolutions, review status, source/story links |
| Translation | list current translations, request translation, translation status, translated markdown/text retrieval |
| RBAC | current user permissions, role list, members list, invite/member role management |
| Source quality | provenance/custody/quality/sensitivity summary per source and collection |

Contracts needed to productize M12:

| Product need | Required app contract |
| --- | --- |
| Similar entities/cases | list similar links, detail explanation, dimension scores, review artifact link |
| Classification harmonization | taxonomy mappings list/detail, review status, mapped categories |
| Temporal patterns | pattern list/detail, windows, hotspots, source/entity links, caveats |
| External correlations | correlation list/detail, external series metadata, lag/correlation/caveat display |

Cross-cutting contracts still needed:

- first-class claim/assertion list and detail
- claim/assertion offsets into story/source text
- aggregate graph read model or batched graph endpoint
- activity feed
- app-shaped usage/cost read model
- export jobs and artifact downloads

## 7. Implementation Roadmap

### Slice 0: Roadmap And Capability Realignment

Purpose: make the app plan match M10-M12 reality.

Work:

- Update `docs/app-design-strategy.md` and `docs/app-api-integration.md` to reflect M10/M11/M12 as completed backend milestones.
- Update `apps/app/src/lib/capabilities.ts` so states distinguish "backend exists, app HTTP missing" from "future milestone."
- Add capability IDs for M11/M12 surfaces: review workflow, translation, credibility, RBAC, similarity, harmonization, temporal patterns, correlations.
- Keep unavailable routes disabled until their HTTP contracts exist.

Acceptance:

- docs no longer imply M10/M11/M12 are future gates
- disabled nav copy accurately says whether the blocker is API contract, app route, permissions, or future product decision
- no UI route is enabled without a real API-backed state model

### Slice 1: App API Contract Audit

Purpose: prevent frontend work from racing ahead of contracts.

Work:

- Create an app API matrix covering every sidebar item.
- For each capability, mark one of:
  - mounted and app-ready
  - mounted but insufficient
  - package/CLI only
  - repository exists but no HTTP route
  - not implemented
- For M11/M12, identify the smallest read-only HTTP routes needed before UI activation.
- Write route specs before implementing screens.

Acceptance:

- every planned app route has a contract owner
- app work can proceed in small slices without fixture fallbacks

### Slice 2: Source Reader V2

Purpose: make source understanding the strongest part of the product.

Work:

- Maintain the app-controlled PDF pane using React-PDF/PDF.js and authenticated Blob fetching.
- Preserve split/original/story modes.
- Hide split mode on small widths.
- Add page navigation, zoom, fit-to-width, and render error states.
- Keep story markdown safe through `react-markdown` without raw HTML.
- Improve story/entity annotation interactions.
- Prepare but do not fake claim/evidence spans until offsets exist.
- Bind translation controls to a real contract only after M11 translation HTTP endpoints exist; until then show honest unavailable state.

Acceptance:

- source reader feels like the core research surface
- original and story can each take focus
- missing PDF/story/layout does not collapse the whole page
- German UI is fully translated
- no generated fake translation appears

### Slice 3: Provenance-First Add Sources

Purpose: turn upload from a technical endpoint into a trustworthy ingest workflow.

Work:

- Design Add Sources as a provenance wizard, not just file upload.
- Capture acquisition context, archive location, collection, custody notes, expected sensitivity, authenticity status, and source language.
- Use existing upload contracts only if they can carry the required metadata; otherwise define a contract extension first.
- Make post-upload state explicit: queued, processing, quality review, ready, failed.
- Link new sources into Source Reader and Processing.

Acceptance:

- no production ingest without provenance fields
- users understand what they are adding and why provenance matters
- upload completion lands on a meaningful source state, not a job monitor

### Slice 4: Review Queue

Purpose: bring M11 human review workflow into the default research path.

Work:

- Activate `Review Queue` under Workspace.
- Show review tasks grouped by source credibility, assertion classification, conflict nodes, conflict resolutions, and similar-case links.
- Provide approve/reject/correct/contest style actions only after the review action API exists.
- Link every review item back to source/story/evidence context.
- Add reviewer notes and event history where supported.

Acceptance:

- Research Desk can show "what needs attention now"
- non-technical users see review tasks as content decisions, not artifact rows
- technical metadata is available in a secondary panel

### Slice 5: Claims & Evidence V2

Purpose: make evidence review coherent instead of a summary dashboard.

Work:

- Split current `/evidence` into focused sections:
  - open claims/assertions
  - contradictions/conflicts
  - source support
  - reliability
  - evidence chains
- Add filters by status, source, entity, confidence, review state, and sensitivity where available.
- Add claim detail panel once first-class claim/assertion API exists.
- Link claims to story/source offsets only after offsets are real.

Acceptance:

- "Claims & Evidence" feels like a review workspace
- no fabricated citations or anchors
- contradictions and confidence are explained in researcher language

### Slice 6: Search

Purpose: make retrieval the main way to move through the corpus.

Work:

- Activate Search route.
- Bind `POST /api/search`.
- Show source/story/entity/citation-style results with trace disclosures.
- Let results open Source Reader at source/story context.
- Display degraded confidence and corpus limitations plainly.
- Support EN/DE search UI copy; do not translate results unless translation contract is used.

Acceptance:

- search is useful with existing sources and stories
- result click-through lands somewhere meaningful
- retrieval traces are inspectable but not default clutter

### Slice 7: Source Quality And Trust

Purpose: expose M10/M11 trust without overwhelming readers.

Work:

- Activate Source Quality once source credibility/provenance contracts exist.
- Show provenance, custody, authenticity, quality routing, sensitivity, rollback state, and credibility dimensions.
- Add source-level trust panels to Source Reader and All Sources.
- Keep raw processing details secondary.

Acceptance:

- researchers can judge whether a source is trustworthy
- admins/operators can inspect provenance/custody details
- RBAC/sensitivity restrictions are visible and honest

### Slice 8: Knowledge Base

Purpose: turn extracted structure into navigable knowledge.

Work:

- Activate Entities route using existing `GET /api/entities`.
- Build entity detail with related stories and local graph edges.
- Add Relationships once an app-friendly relationship list exists.
- Add Claim Registry once claim/assertion API exists.
- Add Taxonomy only after browser-safe taxonomy contracts exist.
- Add Knowledge Map after graph aggregate/batch endpoint exists.

Acceptance:

- users can move from source text to entities to relationships and back
- graph views support understanding, not decoration
- merges/review actions are permission-aware

### Slice 9: Discovery Workbench

Purpose: productize M12 as hypothesis generation, not final proof.

Work:

- Add discovery panels for:
  - similar entities/cases
  - temporal patterns and hotspots
  - classification harmonization
  - external correlations
- Use strong caveat copy: patterns and correlations are leads, not causal proof.
- Link each discovery back to sources, stories, entities, and review artifacts.
- Add review affordances where M11 review artifacts exist.

Acceptance:

- M12 outputs are understandable to non-technical researchers
- weak-signal caveats are visible
- discovery never presents correlation as verified evidence

### Slice 10: Admin, RBAC, And Workspace Settings

Purpose: make the app safe for real teams.

Work:

- Activate Members & Access.
- Show current user role and permission implications.
- Support invitations and role management after contract confirmation.
- Add policies for retention, sensitivity, review rules, source rules, and integrations after backend contracts exist.

Acceptance:

- users understand access limitations
- admins can onboard members safely
- sensitive sources are protected by design

### Slice 11: Operations And Recovery

Purpose: keep system control available without making it the product center.

Work:

- Keep Processing as technical route.
- Add Recovery when retry/rollback/reset app contracts are clear.
- Add Activity when an aggregate event stream exists.
- Add Usage & Cost when a proper app read model exists.
- Add Exports after export job/artifact contracts exist.

Acceptance:

- operators can diagnose and recover problems
- researchers are not forced through operational screens for normal work

### Slice 12: Deployment And Pilot Readiness

Purpose: prepare the app for controlled real use.

Work:

- Keep API local/staging until app-critical flows are smoke-tested.
- Deploy API/worker/app only after secrets, migrations, first owner invite, app env, and smoke tests are ready.
- Add browser smoke coverage for:
  - login/logout
  - source list
  - source reader
  - search
  - review queue
  - evidence review
  - processing detail
- Verify desktop, tablet, and mobile-safe layouts.

Acceptance:

- no fixture data in production
- no mock fallback mode
- no private corpus config in repo
- real API unavailable states visible
- first pilot corpus can be ingested and reviewed end to end

## 8. Recommended Immediate Next Steps

The next implementation work should be:

1. Update capability states and docs for M10/M11/M12 reality.
2. Implement the app-only PDF pane in Source Reader.
3. Define the minimum M11 HTTP contracts for review queue and translation.
4. Build Search as the first new active route after Source Reader, because search results can now land on `/sources/:id`.
5. Build Review Queue before broad Discovery screens, because M11 review state is the control layer for trust.

Do not start with:

- a visual redesign
- another static demo surface
- graph exploration before source/story/review destinations are strong
- discovery dashboards before caveats and review workflows are visible
- upload UI without provenance-first UX

## 9. Engineering Guardrails

- All visible UI copy must use i18next EN/DE resources.
- German UI must be fully German, not Denglisch.
- Components should consume theme tokens and not branch on light/dark mode.
- Motion should remain restrained and shared through app motion primitives.
- No checked-in product fixtures.
- No hard-coded UUIDs in app screens.
- No API keys in browser bundles.
- Each route must have loading, empty, unavailable, forbidden, not-found, and partial-data behavior where relevant.
- Technical IDs belong in inspectors, code blocks, locators, and Operations.
- Every new feature slice should include browser smoke or a clear reason why it cannot.

## 10. Branch And Commit Strategy

Use short-lived app branches:

- `codex/app-roadmap-*` for planning/docs
- `codex/app-source-reader-*` for reader work
- `codex/app-review-queue-*` for review workflow
- `codex/app-search-*` for search
- `codex/app-knowledge-*` for entity/graph/claim registry work
- `codex/app-discovery-*` for M12 discovery surfaces

Prefer atomic commits:

- one commit for API types/hooks
- one commit for UI route/component implementation
- one commit for i18n/docs/tests

Each slice should run:

```bash
pnpm lint
pnpm --filter @mulder/app build
pnpm build
```

When local API/app credentials are available, also run:

```bash
pnpm smoke:app
```

## 11. Decision Log

- The app remains in `apps/app`; no old `demo/` app returns.
- M11/M12 backend completion should now drive app activation.
- Source Reader is the most important near-term UX surface.
- Search should come after Source Reader so results have strong destinations.
- Review Queue should come before broad Discovery UI so new findings have a human trust workflow.
- Add Sources is now strategically possible after M10, but it must be provenance-first.
- Operations remains secondary even as technical power grows.
