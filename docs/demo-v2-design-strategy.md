# Mulder Demo v2 Design Strategy

**Date:** 2026-04-30
**Status:** Direction-setting document for the `demo-v2/` prototype
**Audience:** Product, design, and engineering contributors extending the Mulder web app

---

## 1. Executive Direction

The `demo-v2/` prototype should become the primary product direction for Mulder's browser experience.

The existing v1 demo should remain useful as a reference for storytelling, document reading, and earlier interaction ideas, but v2 is the stronger foundation for the actual product. Mulder is a powerful research and analysis system. The interface should therefore feel like a precise technical workbench, not like an editorial presentation layer.

The key decision is not simply "make v1 cleaner." The better path is to continue v2 as an API-contract-first, capability-aware product shell:

- Build the UI around real workflows: documents, runs, evidence, entities, search, graph, review.
- Bind real API data as early as possible.
- Show future capabilities in the information architecture without pretending that unavailable APIs already exist.
- Keep all visual decisions adjustable through Tailwind and local design tokens.

API-contract-first is a frontend and product strategy, not a backend inversion. Mulder's backend should remain CLI/domain/queue-first: long-running operations are produced as jobs, read-only product surfaces bind to stable HTTP read models, and UI-shaped endpoints should be facades over real domain capabilities rather than new business logic hidden in the web layer.

This avoids the trap of building a beautiful static frontend that later has to be rebuilt when the backend contract becomes clearer.

---

## 2. Why v2 Exists

The v1 design was visually polished, but its concept was not fully aligned with the product's purpose. It leaned into an investigative, literary, archival tone: serif headlines, large atmospheric surfaces, cinematic pacing, and a narrated "hero moment" structure.

That direction can work for a fundable product demo, but it is less convincing as the daily interface for a serious analysis tool. It makes the app feel like it is presenting insight rather than helping the user operate a complex system.

v2 exists to shift the product posture:

| v1 tendency | v2 correction |
| --- | --- |
| Editorial, cinematic, narrated | Technical, operational, direct |
| Large hero surfaces | Dense work surfaces |
| Serif/display emphasis | Sans-first UI typography |
| Mood-led visual identity | Data-led visual identity |
| Top-nav demo structure | Sidebar-first product IA |
| Screens as chapters | Screens as tools |
| Static showcase risk | API-contract-backed workbench |

The product should communicate that it can handle difficult research work: messy sources, long-running jobs, contradictory claims, entity resolution, graph traversal, and auditability. The UI should make that power feel controllable.

---

## 3. Reference Direction

Firecrawl is a useful reference, especially for:

- Sidebar-first navigation.
- Light neutral canvas.
- Thin borders and compact panels.
- Orange as a restrained action/accent color.
- Operational confidence without heavy visual decoration.
- Tables, logs, API-adjacent controls, and status-heavy UI.

Mulder should not become a Firecrawl clone. The reference is valuable because it demonstrates useful interface discipline: scalable navigation, restraint, density, and clear operational feedback. Mulder should borrow that discipline without inheriting a developer-tool posture wholesale. Its own identity should come from its domain:

- Claims, citations, sources, and contradictions.
- Evidence depth and traceability.
- Entity and graph reasoning.
- Source reliability.
- Pipeline observability.
- Research review workflows.

The target feeling is closer to:

> "A precise analysis workbench for documents, evidence, and graph-backed research."

Not:

> "An AI landing page," "a case-file moodboard," or "a generic SaaS dashboard."

---

## 4. Product Posture

v2 should feel:

- **Clean:** restrained palette, low decoration, clear layout rhythm.
- **Productive:** users can scan, compare, filter, inspect, and act quickly.
- **Technically credible:** IDs, statuses, jobs, parameters, artifacts, traces, and source metadata exist, but they do not dominate the default experience.
- **Trustworthy:** the UI shows provenance and uncertainty rather than hiding it.
- **Extensible:** the shell anticipates future modules without requiring another redesign.
- **Quietly specific:** Mulder vocabulary appears in the work surfaces, not through theatrical styling.

The interface should not over-explain itself with marketing copy. It should show the system's capabilities through the shape of the tools.

Mulder should not look like a developer tool. Its backend is technically complex, but the primary user experience is research work: reading, comparing, verifying, following sources, understanding entities, and resolving evidence. Pipeline internals are important, but they are not the main object of attention for most users.

The product should serve both non-technical researchers and technical operators:

- A 60-year-old non-technical researcher should be able to use Mulder without understanding jobs, embeddings, graph traversal, or pipeline stages.
- A scientist should be able to focus on the content and evidence rather than backend machinery.
- A technical user should still be able to inspect traces, job state, source artifacts, parameters, and failure details when needed.
- Operators should be able to control and debug the pipeline, but those controls should live behind deliberate navigation or disclosure.

The default posture is therefore:

> Research-first, system-aware, progressively technical.

Not:

> Pipeline-first, developer-facing, permanently technical.

---

## 4.1 Audience Model

Mulder must be usable across a wide audience:

| Audience | Primary need | UI implication |
| --- | --- | --- |
| Non-technical researchers | Understand documents, sources, claims, and relationships | Default screens emphasize content, evidence, and next actions |
| Scientists and domain experts | Evaluate reliability and citeable support | Citations, confidence, provenance, and source context are always accessible |
| Technical researchers | Inspect how results were produced | Retrieval traces, parameters, artifacts, and pipeline details are available one click deeper |
| Operators/admins | Monitor and control ingestion and processing | Pipeline controls live in operations-oriented views, not in the main evidence-reading path |

The app should not assume that "powerful" means "busy." The strongest interface will often be the one that hides pipeline complexity until the user asks for it.

---

## 5. Information Architecture

The sidebar is the right foundation because Mulder will grow beyond four demo tabs. Future product breadth is expected, and top navigation will not scale.

The sidebar must still express product priorities. A research user should see Mulder as a workspace for documents, evidence, search, and knowledge. Operations should be available, but visually secondary.

Recommended sidebar grouping:

| Group | Area | Purpose | Contract state |
| --- | --- | --- | --- |
| Research | Overview | Corpus pulse, high-signal work, review queue | Mounted partial: `/api/status`, jobs, evidence read models |
| Research | Evidence Workspace | Claims, contradictions, citations, review decisions | Mounted partial; first-class claims and review actions need a facade |
| Research | Documents | Archive, upload, processing readiness, viewer | Mounted API; real archive use is gated by M10 provenance/trust work |
| Research | Search | Hybrid retrieval, citations, trace disclosure | Mounted API; trace depth is partial |
| Knowledge | Entities | Entity search, profiles, aliases, merges | Mounted API |
| Knowledge | Graph | Relationship exploration and graph-backed review | Mounted partial; aggregate graph endpoint or batch edge query needed |
| Operations | Analysis Runs | Queue, jobs, artifacts, failures, retries | Jobs mounted; product-shaped run facade needed |
| Operations | Activity | Cross-system event stream | Missing aggregate |
| Operations | Usage | Cost, budget, worker, and capacity signals | CLI/package-only plus mounted status pieces; product API partial |
| Admin | Settings | Workspace, users, API/auth, config, policy | Future milestone |

`Analysis Runs` can stay active in the v2 prototype because it is the fastest way to validate API binding and operational states. In the real product navigation, it should sit under Operations so pipeline machinery does not look like the core research object.

Use precise contract states in planning:

| State | Meaning |
| --- | --- |
| Mounted API | Route exists and can be bound now |
| Mounted partial | Route exists, but the UI needs a stronger read model or additional fields |
| CLI/package-only | Capability exists outside HTTP and needs an API boundary before browser use |
| Documented target | Described in docs/specs, but not mounted in the current API |
| Future milestone | Depends on upcoming milestone work before product use |
| Missing | Needed by the product direction but not yet planned clearly |

Disabled or "soon" items are acceptable in the prototype only if they are visually honest and non-interactive. As APIs become real, these sections should graduate from disabled to functional.

---

## 6. Visual System

The v2 visual system lives in `demo-v2/src/styles.css`. That file should remain the main adjustment surface.

### Typography

Use sans-first typography for all product UI. Avoid v1's editorial display-serif language in v2.

Recommended usage:

- Sans for navigation, headings, labels, tables, forms, and body UI.
- Mono for IDs, job names, timestamps, parameters, source locators, hashes, confidence values, and status metadata.
- No viewport-scaled font sizes.
- No negative letter spacing.
- Headings should be compact and task-oriented, not hero-like.

### Color

The palette should stay light-first and neutral:

- Off-white canvas.
- White panels.
- Fine gray borders.
- Graphite primary text.
- Muted gray secondary text.
- Orange accent for primary actions, active navigation, and important highlights.
- Semantic colors for success, warning, danger, and info.

Orange should be strong enough to create product identity, but sparse enough to preserve seriousness.

### Layout

Prefer:

- Sidebar plus topbar shell.
- Dense tables.
- Filter/toolbars.
- Inspector panels.
- Split views.
- Compact metric cards.
- Code/parameter blocks.
- Status badges.

Avoid:

- Large editorial hero sections.
- Decorative cards inside cards.
- Mood-driven illustration.
- Gradient/orb backgrounds.
- Oversized type in operational panels.
- Decorative animation that slows work.

### Radius and Borders

Keep radii compact. Cards and panels should stay at 8px or below unless a specific component needs a different treatment. Borders should carry most of the structure; shadows should be subtle.

### Density and Accessibility

Density should be tokenized, not hard-coded. The default product mode should be comfortable enough for older and non-technical users, with compact density available for technical users and operators.

Recommended token surfaces:

- Row height.
- Toolbar height.
- Sidebar item height.
- Font size scale for table cells and metadata.
- Icon button size.
- Inspector spacing.

Do not make Mulder feel powerful only by making everything smaller. The interface can be dense, but primary reading paths, evidence summaries, citations, and review actions need enough breathing room to remain usable for people who do not live in technical consoles all day.

---

## 7. Usability Strategy

v2 should optimize for repeated analytical work, not just first impression.

### Research First, Pipeline Second

The researcher works with the result of the pipeline, not with the pipeline itself. Most screens should therefore lead with:

- Documents.
- Claims.
- Citations.
- Entities.
- Relationships.
- Reliability.
- Contradictions.
- Search results.

Pipeline state should appear when it helps answer a user question:

- Is this document ready?
- Why is this result missing?
- Can I trust this answer?
- What failed?
- What should I retry?

Pipeline internals should not be the default visual focus in evidence-reading or research workflows.

### Scan First

Tables, badges, timestamps, and compact rows should make it possible to understand state quickly. A user should be able to answer:

- What is running?
- What failed?
- What needs review?
- What evidence supports this?
- What source can I inspect next?

### Inspect Without Losing Context

Use inspector panels for selected rows and entities. The user should not have to navigate away for every detail. Master-detail patterns are central to the product.

### Progressive Disclosure

Complexity should be layered:

1. **Default layer:** plain-language research surface. Shows what matters, why it matters, and what can be done next.
2. **Evidence layer:** citations, source reliability, confidence, entity links, contradiction details.
3. **Technical layer:** retrieval trace, pipeline step, job payload, artifacts, parameters, errors.

The technical layer must be available, but it should normally sit behind "Details", "Trace", "Run details", "Artifacts", or an inspector panel. This lets non-technical users stay oriented while technical users can still get the full picture.

### Make Uncertainty Visible

Confidence, reliability, degraded search, missing citations, and partial data should be visible. Mulder should not pretend every answer is equally certain.

### Treat Provenance as a Product Gate

Trust is not only a visual treatment. Before Mulder is productized for real archive ingest, the product needs the M10 provenance and trust foundation or an explicit temporary waiver.

The UI should reserve space for:

- Content-addressed document identity.
- Acquisition context.
- Archive location.
- Custody chain.
- Document quality assessment.
- Assertion classification.
- Sensitivity and access-control signals.
- Source rollback or deletion status.

Until those backend contracts exist, v2 can support demo/development ingest and design exploration, but it should not imply archive-grade provenance, compliance, or review safety. This is a hard product boundary for a serious research system.

### Do Not Fake Capability

If an action has no API, do not render it as a working primary action. Use one of these patterns instead:

- Hide the action until available.
- Render a disabled control with "API pending" or similar internal-facing language in prototype mode.
- Show a capability-aware empty state.

This is especially important for evidence review actions, graph aggregation, taxonomy management, exports, and cost controls.

### Mobile Behavior

Mobile support should be pragmatic:

- Sidebar collapses into a drawer.
- Tables may intentionally scroll horizontally.
- Inspector panels stack below the primary content.
- The topbar should reduce to essential controls.

The product is primarily a desktop workbench, but it should not break on small screens.

---

## 8. Frontend API Contract Strategy

The frontend should be built as if it will become the real product, but it must stay honest about backend availability.

This does not mean the backend should become UI-driven. Mulder's durable architecture is CLI/domain/queue-first:

- Long-running operations are produced as jobs.
- The worker executes domain pipeline steps.
- Read-only browser views consume stable HTTP read models.
- Product facades are acceptable when they compose existing domain data for the UI.
- Product facades are not acceptable when they duplicate pipeline logic or become a second implementation of domain behavior.

Recommended architecture:

1. A typed API client layer.
2. React Query hooks per backend capability.
3. A capability registry describing the real contract state of each feature.
4. Fixture data only as a development fallback, never as the default source of truth once an endpoint exists.
5. UI states for loading, error, empty, partial, and unavailable.

The prototype currently uses static fixtures to establish the visual direction. The next step is to replace fixture-backed surfaces with real data incrementally.

### Contract States

Use explicit states instead of broad labels like "mostly available":

```ts
type CapabilityState =
	| 'mounted-api'
	| 'mounted-partial'
	| 'cli-or-package-only'
	| 'documented-target'
	| 'future-milestone'
	| 'missing';
```

The v2 UI should only use fixtures as the primary data source for `documented-target`, `future-milestone`, and `missing` capabilities. For `mounted-api` and `mounted-partial`, the default path should be real API data with development fallbacks.

### Mounted API Coverage

These can be bound immediately or with minimal UI adaptation:

- `/api/health`
- `/api/status`
- `/api/auth/login`
- `/api/auth/logout`
- `/api/auth/session`
- `/api/auth/invitations/accept`
- `/api/auth/invitations`
- `/api/jobs`
- `/api/jobs/:id`
- `/api/documents`
- `/api/documents/:id/pdf`
- `/api/documents/:id/layout`
- `/api/documents/:id/pages`
- `/api/documents/:id/pages/:num`
- `/api/documents/:id/stories`
- `/api/documents/:id/observability`
- `/api/entities`
- `/api/entities/:id`
- `/api/entities/:id/edges`
- `/api/entities/merge`
- `/api/evidence/summary`
- `/api/evidence/contradictions`
- `/api/evidence/reliability/sources`
- `/api/evidence/chains`
- `/api/evidence/clusters`
- `/api/search`
- `/api/uploads/documents/initiate`
- `/api/uploads/documents/complete`
- `/api/pipeline/run`
- `/api/pipeline/retry`

### Missing or Weak API Shapes

These are important for the v2 workbench:

| Need | Contract state | Recommendation |
| --- | --- | --- |
| Analysis run list/detail | Mounted partial: jobs exist, product-shaped runs do not | Add `/api/analysis-runs` facade or enrich `/api/jobs` with stable run grouping, progress, artifacts, parameters, and source status |
| Run artifacts and params | Mounted partial: payload exists but is not normalized for UI | Expose a stable artifact/parameter read model rather than parsing job payloads in components |
| Evidence claims | Missing/product facade needed: contradictions exist, claims are not first-class | Add `/api/evidence/claims` with claim text, source support, confidence, contradiction state, and review state |
| Evidence review actions | Missing | Add confirm, dismiss, watch, resolve, and annotate actions with optimistic-safe contracts |
| Graph aggregate | Mounted partial: per-entity edges only | Add `/api/graph` or `/api/entities/edges?entity_ids=...` for graph surfaces beyond one entity |
| Global stories | Mounted partial: document-scoped stories exist | Add `/api/stories` and `/api/stories/:id` or keep story access intentionally document-scoped |
| Taxonomy management | CLI/package-only; some docs mention target routes, but routes are not mounted | Add list/export/bootstrap/rebootstrap routes only if taxonomy becomes a browser workflow |
| Ground/analyze orchestration | CLI/standalone and package capability; not first-class API/worker steps | Decide whether these become queued API steps; if yes, update pipeline step types, worker job types, chaining, retry, and tests |
| M10 provenance/trust | Future milestone | Do not present real archive ingest as product-ready until provenance, custody, quality, sensitivity/RBAC, assertions, and rollback contracts exist |
| Cost estimates | CLI/package-only | Add estimate endpoints for upload, pipeline run, and reprocess before showing actionable cost controls |
| Activity feed | Missing aggregate: jobs and document observability exist separately | Add cross-system activity endpoint when users need one timeline across documents, runs, reviews, and errors |
| Export workflows | CLI/package-only | Add export job routes or signed artifact routes before exposing export as a primary browser action |
| Reprocess/dead-letter recovery | Mounted partial: retry exists, operational recovery broader than API | Add UI-safe recovery endpoints for retry, reprocess, dead-letter inspection, and rollback as distinct operations |

The UI should be designed with these needs in mind, but it should not fabricate them.

---

## 9. Recommended Build Path

### Phase 1: Bind Real API Data

Replace v2 fixtures with real API hooks for:

- Overview metrics.
- Jobs/runs table.
- Evidence summary.
- Contradictions.
- Source reliability.
- Search status where useful.

Keep fixture fallbacks only for design review or Storybook-like development.

### Phase 2: Add Capability-Aware Product States

Introduce a small capability map:

```ts
type CapabilityState =
	| 'mounted-api'
	| 'mounted-partial'
	| 'cli-or-package-only'
	| 'documented-target'
	| 'future-milestone'
	| 'missing';
```

Use it to control:

- Disabled sidebar items.
- Missing actions.
- Empty states.
- Tooltips.
- "API pending" prototype notes.

### Phase 3: Close Backend Gaps in Product Order

Prioritize API additions that unlock complete workflows:

1. Analysis run facade.
2. Evidence claim and review facade.
3. M10 provenance/trust contracts before real archive ingest.
4. Global stories or intentionally document-scoped story endpoints.
5. Graph aggregate endpoint.
6. Ground/analyze orchestration decision.
7. Taxonomy API, if taxonomy is meant to be browser-managed.
8. Cost estimate API.
9. Export and reprocess endpoints.

### Phase 4: Expand Workbench Modules

Once the API shape exists, expand:

- Documents and upload.
- Entity profiles.
- Search with trace.
- Graph/Board.
- Evidence review.
- Usage/cost.
- Settings/admin.

---

## 10. Non-Goals

v2 should not attempt to:

- Recreate v1's cinematic document reveal language.
- Ship a complete fake workbench before API coverage exists.
- Add complex visual effects before core workflows are usable.
- Optimize for a marketing landing page.
- Hide backend uncertainty.
- Build every future route at once.
- Move pipeline or domain logic into frontend-shaped API routes.
- Productize real archive ingest before the provenance/trust gate is resolved or explicitly waived.

The goal is a durable product shell that can absorb backend capability as it lands.

---

## 11. Success Criteria

v2 is succeeding if:

- It feels immediately more credible as a powerful analysis product than v1.
- Users can understand system state without reading explanatory prose.
- Real API data replaces fixtures incrementally without redesigning screens.
- Missing capabilities are visible but not fake.
- Sidebar IA scales as new milestones land while keeping research modules visually primary.
- Tables, inspectors, filters, and status surfaces become the dominant interaction model.
- The design can be tuned through tokens rather than component-by-component restyling.
- Density can be adjusted without rebuilding components.
- The app remains visually restrained, research-first, technically credible, and specific to evidence analysis.

---

## 12. Working Principle

The product should feel like it was built by people who trust the user with complexity.

Mulder does not need to make research look magical. It needs to make difficult research controllable, inspectable, and reliable.

That is the core design strategy for v2.
