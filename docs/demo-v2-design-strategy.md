# Mulder Demo v2 Design Strategy

**Date:** 2026-04-30  
**Status:** Direction-setting document for the `demo-v2/` prototype  
**Audience:** Product, design, and engineering contributors extending the Mulder web app

---

## 1. Executive Direction

The `demo-v2/` prototype should become the primary product direction for Mulder's browser experience.

The existing v1 demo should remain useful as a reference for storytelling, document reading, and earlier interaction ideas, but v2 is the stronger foundation for the actual product. Mulder is a powerful research and analysis system. The interface should therefore feel like a precise technical workbench, not like an editorial presentation layer.

The key decision is not simply "make v1 cleaner." The better path is to continue v2 as an API-first, capability-aware product shell:

- Build the UI around real workflows: documents, runs, evidence, entities, search, graph, review.
- Bind real API data as early as possible.
- Show future capabilities in the information architecture without pretending that unavailable APIs already exist.
- Keep all visual decisions adjustable through Tailwind and local design tokens.

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
| Static showcase risk | API-first workbench |

The product should communicate that it can handle difficult research work: messy sources, long-running jobs, contradictory claims, entity resolution, graph traversal, and auditability. The UI should make that power feel controllable.

---

## 3. Reference Direction

Firecrawl is a useful reference, especially for:

- Sidebar-first navigation.
- Light neutral canvas.
- Thin borders and compact panels.
- Orange as a restrained action/accent color.
- Developer-tool confidence without heavy visual decoration.
- Tables, logs, API-adjacent controls, and status-heavy UI.

Mulder should not become a Firecrawl clone. The reference is valuable because it demonstrates the right product category: a technical console for powerful backend capability. Mulder's own identity should come from its domain:

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

Recommended top-level IA:

| Area | Purpose | API state |
| --- | --- | --- |
| Overview | System pulse, corpus health, high-signal work | Mostly available |
| Analysis Runs | Queue, jobs, artifacts, run details | Partially available |
| Evidence Workspace | Claims, contradictions, citations, review | Partially available |
| Documents | Archive, upload, processing, viewer | Mostly available |
| Entities | Entity search, profiles, aliases, merges | Mostly available |
| Graph | Network exploration and relationship review | Partially available |
| Search | Hybrid retrieval and trace | Available |
| Activity | Cross-system event stream | Missing aggregate |
| Usage | Cost, credits, worker/budget status | Partially available |
| Settings | Workspace/admin/config surface | Mostly future |

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

## 8. API-First Strategy

The frontend should be built as if it will become the real product, but it must stay honest about backend availability.

Recommended architecture:

1. A typed API client layer.
2. React Query hooks per backend capability.
3. A capability registry describing whether a feature is `available`, `partial`, `planned`, or `missing`.
4. Fixture data only as a development fallback, never as the default source of truth once an endpoint exists.
5. UI states for loading, error, empty, partial, and unavailable.

The prototype currently uses static fixtures to establish the visual direction. The next step is to replace fixture-backed surfaces with real data incrementally.

### Existing API Coverage

These can be bound immediately or with minimal UI adaptation:

- `/api/status`
- `/api/jobs`
- `/api/jobs/:id`
- `/api/documents`
- `/api/documents/:id/pdf`
- `/api/documents/:id/layout`
- `/api/documents/:id/pages`
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

| Need | Current state | Recommendation |
| --- | --- | --- |
| Analysis run list/detail | Jobs exist, but not product-shaped runs | Add `/api/analysis-runs` facade or enrich `/api/jobs` |
| Run artifacts and params | Payload exists but not normalized for UI | Expose stable artifact/parameter shape |
| Evidence claims | Contradiction edges exist, claims are not first-class | Add `/api/evidence/claims` |
| Evidence review actions | Not exposed | Add confirm, dismiss, watch, resolve actions |
| Graph aggregate | Per-entity edges only | Add `/api/graph` or `/api/entities/edges?entity_ids=...` |
| Global stories | Document-scoped stories exist | Add `/api/stories` and `/api/stories/:id` |
| Taxonomy management | CLI/package exists, API missing | Add list/export/bootstrap/rebootstrap routes |
| Cost estimates | CLI exists, API missing | Add estimate endpoints for upload/pipeline/reprocess |
| Activity feed | Jobs and document observability exist separately | Add cross-system activity endpoint |
| Export workflows | CLI exists, API missing | Add export job routes or signed artifact routes |
| Reprocess/dead-letter recovery | CLI exists, partial retry API exists | Add UI-safe recovery endpoints |

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
type CapabilityState = 'available' | 'partial' | 'planned' | 'missing';
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
3. Global stories endpoints.
4. Graph aggregate endpoint.
5. Taxonomy API.
6. Cost estimate API.
7. Export and reprocess endpoints.

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

The goal is a durable product shell that can absorb backend capability as it lands.

---

## 11. Success Criteria

v2 is succeeding if:

- It feels immediately more credible as a powerful analysis product than v1.
- Users can understand system state without reading explanatory prose.
- Real API data replaces fixtures incrementally without redesigning screens.
- Missing capabilities are visible but not fake.
- Sidebar IA scales as new milestones land.
- Tables, inspectors, filters, and status surfaces become the dominant interaction model.
- The design can be tuned through tokens rather than component-by-component restyling.
- The app remains visually restrained, technical, and specific to evidence analysis.

---

## 12. Working Principle

The product should feel like it was built by people who trust the user with complexity.

Mulder does not need to make research look magical. It needs to make difficult research controllable, inspectable, and reliable.

That is the core design strategy for v2.
