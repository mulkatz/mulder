# Functional Spec Implementation Diff Audit

Audit date: 2026-04-26
Implementation baseline: `main` at `22ea7a8`

Spec sources:
- `docs/functional-spec.md`
- `docs/functional-spec-addendum.md`

Implementation scope reviewed:
- CLI, API, worker, pipeline, retrieval, taxonomy, eval, core database, migrations, fixtures, docs, and Terraform currently present in the repository.
- Current implementation through M7 plus previously completed v2.0 analysis/grounding work.
- Addendum milestones M10-M14 are treated as future work unless the spec explicitly makes them a prerequisite for current or near-term usage.

## Executive Summary

The M7 remediation path is now aligned: normal API pipeline acceptance creates step jobs instead of `pipeline_run`, worker success chains the next step, retryable queue failures become runnable again, browser session auth exists without a browser-bundled API secret, and the M7 test lane was repaired.

The implementation is not completely converged with the full functional specification. The largest current product/spec gap is the addendum's M10 foundation: provenance, content-addressed storage, document quality assessment, assertion classification, sensitivity/RBAC, and source rollback are not implemented. The addendum labels this foundation as required before the first real archive ingest, so this is a blocker if real archive ingestion is the next operational milestone.

The highest-risk base-spec drifts are narrower: Ground and Analyze are not first-class queued/API pipeline steps, CLI ingest can store raw documents under a UUID that is not the persisted `sources.id`, sparse-corpus corroboration still exposes numeric scores in entity surfaces, and taxonomy YAML/bootstrap contracts differ from the spec examples.

## Confirmed Aligned Areas

| Area | Current state | Evidence |
| --- | --- | --- |
| CLI command surface | The CLI contains the expected command groups for ingest, extract, segment, enrich, ground, embed, graph, analyze, pipeline, query, taxonomy, entity, export, eval, status, worker, config, db, cache, fixtures, retry, and reprocess. It also includes `show`, which is an additive preview command covered by later specs. | `apps/cli/src/index.ts` |
| Ingest, extract, segment | Base PDF validation, source creation, storage upload, native/Document AI/Vision extraction, layout Markdown, page-image support, and story segmentation exist. | `packages/pipeline/src/ingest`, `packages/pipeline/src/extract`, `packages/pipeline/src/segment` |
| Enrich | Gemini structured output, generated JSON schema usage, cross-lingual entity resolution, taxonomy normalization, taxonomy linkage, and token counting are present. | `packages/pipeline/src/enrich`, `packages/taxonomy` |
| Ground | Standalone grounding exists with cache-aware persistence, Gemini Search grounding integration, TTL/min-confidence config, domain exclusions, and plausibility validation for dates/coordinates. | `packages/pipeline/src/ground`, `packages/core/src/database/migrations/009_entity_grounding.sql` |
| Embed and retrieval | Semantic chunking, embeddings, vector/fulltext/graph retrieval, RRF fusion, reranking, sparse graph confidence metadata, and negative-query gating are implemented. | `packages/pipeline/src/embed`, `packages/retrieval` |
| Graph and Analyze | Deduplication, relationship writing, contradiction flagging/resolution, source reliability, evidence chains with sparse-corpus gate, and spatio-temporal clustering are implemented. | `packages/pipeline/src/graph`, `packages/pipeline/src/analyze` |
| Job queue and API orchestration | Normal API acceptance uses step jobs, worker success chains the next step, legacy `pipeline_run` remains compatibility-only, upload finalization enters the step chain, and retryable failures return to `pending`. | `apps/api/src/lib/pipeline-jobs.ts`, `packages/worker/src/runtime.ts`, `packages/core/src/database/repositories/job.repository.ts` |
| Browser auth | Browser-safe session auth exists with users, sessions, invitations, login/logout/session routes, cookie middleware support, and bearer API-key compatibility. | `apps/api/src/routes/auth.ts`, `apps/api/src/lib/auth.ts`, `packages/core/src/database/migrations/020_browser_auth.sql`, `apps/app/src/features/auth` |
| API docs cleanup | Unsupported `/doc`, `/reference`, OpenAPI/Scalar, and stale CORS claims have been removed or neutralized from the API architecture docs. | `docs/api-architecture.md`, `apps/api/src/app.ts` |
| Cost safety and operations | Budget reservations, cost estimator/status gate, dead-letter/retry tooling, selective reprocessing, devlog, eval reporting, and Terraform budget alerts exist. | `docs/specs/77_*`, `docs/specs/78_*`, `terraform/modules/budget` |

## Open Divergence Register

### DIFF-001 - M10 provenance, quality, assertions, sensitivity, and rollback are not implemented

Priority: P1 if real archive ingest is next; otherwise planned future work.

Spec requires:
- Addendum M10 and sections A2-A6 require content-addressed storage, `DocumentBlob`, acquisition context, archive location, custody chain, collection management, document quality assessment, assertion classification, sensitivity tagging/RBAC foundations, and source rollback.
- The addendum explicitly says foundation work must be implemented before first real archive ingest.

Current implementation:
- Base ingest still uses source-centric storage and the `sources` table.
- Current migrations stop at shipped migration `020_browser_auth.sql`; no `document_blobs`, `acquisition_contexts`, `archive_locations`, `document_quality_assessments`, `knowledge_assertions`, `source_deletions`, audit log, sensitivity columns, or RBAC roles exist.
- Browser auth users/sessions/invitations exist, but this is not the addendum's full access-control/RBAC/sensitivity model.
- Config does not contain `ingest_provenance`, `document_quality`, `access_control`, `source_rollback`, or assertion-classification sections.

Impact:
- Mulder can ingest demo/development PDFs, but it does not yet meet the addendum's archive-grade ingest contract.
- If real archive material is loaded now, provenance and custody information would need a migration/backfill story later.

Recommended action:
- Treat M10 as the next foundation milestone before any real archive ingest.
- Either implement A2-A6 or explicitly write a temporary operational waiver that no real archive ingest occurs until these are in place.

### DIFF-002 - Addendum migration numbering is stale and now collides with shipped migrations

Priority: P1 before starting M10 schema work.

Spec requires:
- Addendum Appendix C says the current highest migration is `017` and assigns future migrations `018` onward to sensitivity, provenance, source deletion, document blobs, and later addendum tables.

Current implementation:
- The repository already has:
- `018_entity_taxonomy_link.sql`
- `019_monthly_budget_reservations.sql`
- `020_browser_auth.sql`

Impact:
- Implementing the addendum migration index literally would collide with shipped migrations.
- This is easy to miss because the future addendum table list is otherwise still useful.

Recommended action:
- Update the addendum migration index before implementing M10.
- Create a new migration map starting at `021` and remap the addendum's intended `018`-`020` work into new migration numbers.

### DIFF-003 - Ground and Analyze are not first-class queued/API pipeline steps

Priority: P1 for full base-spec conformance; P2 if intentionally deferred as v2 pipeline orchestration.

Spec requires:
- The base spec describes full pipeline order as `ingest -> extract -> segment -> enrich -> ground* -> embed -> graph -> analyze*`.
- It also says long-running operations, including pipeline steps, batch grounding, and analysis, go through the job queue.

Current implementation:
- CLI pipeline step order is `ingest`, `extract`, `segment`, `enrich`, `embed`, `graph`.
- CLI pipeline can run a global Analyze after Graph only when analysis is enabled and the run is not stopped early, but `analyze` is not a normal `--from`/`--up-to` step.
- `ground` is not run by the pipeline when `grounding.mode` is `pipeline`.
- API/worker step schemas only include `extract`, `segment`, `enrich`, `embed`, and `graph`.
- Worker jobs do not support queued `ground` or `analyze` jobs.

Impact:
- Standalone `mulder ground` and `mulder analyze` work, but full pipeline and API behavior do not match the documented optional step model.
- Browser/API initiated pipelines cannot request or chain Ground/Analyze.

Recommended action:
- Decide explicitly whether Ground/Analyze should now be part of the executable pipeline contract.
- If yes, extend `PipelineStepName`, API `PIPELINE_STEP_VALUES`, worker job types, chaining order, upload finalization, retry logic, and tests to cover `ground` and `analyze`.
- If no, update the functional spec to say Ground/Analyze remain standalone v2 operations until a later orchestration milestone.

### DIFF-004 - CLI ingest raw storage path can disagree with `sources.id`

Priority: P2.

Spec requires:
- Base ingest stores raw PDFs at `raw/{source_id}/original.pdf`.

Current implementation:
- CLI ingest generates a random UUID for `raw/{uuid}/original.pdf`, then calls `createSource` without forcing that UUID as the source id.
- Because `createSource` generates/returns its own `sources.id`, the stored path UUID and database source id can differ.
- Browser upload finalization does pass the source id into `createSource`, so this mismatch is specific to CLI ingest.

Impact:
- The persisted `storage_path` remains usable, but any code, operator, or doc that derives storage paths from `sources.id` will be wrong for CLI-ingested documents.
- This also conflicts with the mental model needed for later provenance/storage work.

Recommended action:
- Make CLI ingest use the same UUID for the storage path and `sources.id`, or create the source first and derive storage from the returned id before upload.
- Add a regression test asserting `sources.storage_path` contains the persisted source id for CLI ingest.

### DIFF-005 - Sparse-corpus corroboration semantics are only partially enforced

Priority: P2.

Spec requires:
- Base spec section 5.3 says corroboration below the configured meaningful corpus threshold should be returned as `null` or `"insufficient_data"`, not as a misleading score.
- Base graph scoring still requires persisted `corroboration_score = min(source_count / min_independent_sources, 1.0)`.

Current implementation:
- Graph correctly computes and persists numeric `entities.corroboration_score`.
- Retrieval confidence metadata classifies corroboration reliability and marks degraded responses.
- Entity and evidence surfaces can still expose numeric corroboration scores directly, even when the corpus is below `thresholds.corroboration_meaningful`.

Impact:
- The underlying graph score is mathematically correct, but user-facing APIs/CLI can still make sparse scores look more authoritative than the spec intends.

Recommended action:
- Keep persisted numeric scores for internal ranking if needed.
- Add a presentation layer that returns `null` plus `insufficient_data`/reliability metadata when the processed-source corpus is below `thresholds.corroboration_meaningful`.
- Cover at least entity lookup, entity list, evidence export, and API entity surfaces.

### DIFF-006 - Grounding config lacks `skip_types`

Priority: P2.

Spec requires:
- Ground filters entities by configured `enrich_types` and `skip_types`.

Current implementation:
- `grounding.enrich_types` exists.
- No `grounding.skip_types` config exists in the current config schema.

Impact:
- Operators can include types but cannot express explicit exclusions as documented.

Recommended action:
- Add `grounding.skip_types` to config with validation and apply it in Ground candidate selection, or simplify the spec to only document the include-list behavior.

### DIFF-007 - Taxonomy bootstrap LLM response contract differs from the functional spec

Priority: P2.

Spec requires:
- Taxonomy bootstrap asks Gemini to return `{ categories: [{ name, type, members: [{ canonical, aliases }] }] }`.

Current implementation:
- Bootstrap processes one entity type at a time and expects `{ clusters: [{ canonical, aliases }] }`.

Impact:
- The implementation is coherent, but the spec and prompt contract describe a different shape.
- Future maintainers or test authors could build the wrong fixture/prompt contract from the functional spec.

Recommended action:
- Either update the spec to document the per-type `clusters` contract, or change bootstrap to accept the `categories` shape and map it internally.

### DIFF-008 - Curated taxonomy YAML schema is flatter than the functional spec example

Priority: P2.

Spec requires:
- The functional spec example wraps curated taxonomy under `categories:` and shows richer fields such as category names, types, descriptions, aliases, locale variants, and Wikidata metadata.

Current implementation:
- Taxonomy export/curate/merge uses a flat top-level mapping of entity type to entries.
- The current curated schema is intentionally simpler than the functional spec example.

Impact:
- The current CLI workflow works, but users following the functional spec example will produce YAML the implementation may not accept.

Recommended action:
- Choose one contract.
- If the flat schema is the desired near-term contract, update the functional spec example.
- If the richer `categories:` shape is desired, extend export/import/merge with backwards-compatible parsing.

### DIFF-009 - Addendum core-vs-domain rule is not fully reflected in comments, examples, and fixtures

Priority: P3.

Spec requires:
- Addendum A1 requires the core system to avoid domain-specific type/function/field names and keep domain examples separated from core feature specs.

Current implementation:
- Runtime data model is mostly generic.
- Some code comments, prompt copy, fixtures, and tests still use archive/UFO/sighting-style examples.
- The remaining examples do not appear to define core database fields or public type names, but they blur the boundary the addendum asks us to keep clean.

Impact:
- Low runtime risk, but it can slowly bias new features toward the original domain.

Recommended action:
- During future touch points, replace domain-specific comments and test examples with generic archive/research examples unless the example is intentionally in the domain architecture doc.

### DIFF-010 - Source layout and infrastructure sections over-promise the current repository shape

Priority: P3.

Spec requires:
- The functional spec source layout lists package internals and Terraform modules for a broader final-state architecture.

Current implementation:
- `packages/evidence` is a facade that re-exports Analyze functionality rather than containing separate contradiction/reliability/chain modules.
- Terraform currently contains budget-alert infrastructure, not the full Cloud SQL, storage, Cloud Run, Pub/Sub, Firestore, IAM, and networking module set shown in the final-state layout.

Impact:
- The repository is usable, but the source-layout section reads more complete than the current implementation.

Recommended action:
- Mark the source-layout and Terraform sections as target/future-state, or update them to the current phased implementation and move final-state layout into roadmap notes.

### DIFF-011 - Addendum M11-M14 are not implemented yet

Priority: Future, not a current M7 blocker.

Spec requires:
- M11: credibility profiles, richer contradiction/conflict nodes, review workflow, translation, RBAC.
- M12: similar case discovery, classification harmonization, temporal anomaly detection, external data plugins.
- M13: graph event log, snapshots, advanced export/import, stable external IDs.
- M14: research journal, agentic research loop, scheduler, web research, report generation, agent safety/eval.

Current implementation:
- The repository has earlier versions of reliability, contradiction, spatio-temporal clustering, exports, and eval.
- It does not have the richer addendum models, tables, config sections, or workflows for M11-M14.

Impact:
- This is expected future scope.
- It becomes a divergence only if the product claims those milestones are shipped.

Recommended action:
- Keep M11-M14 explicitly roadmapped.
- Do not back-port their terms into current docs/API claims until each milestone is implemented.

## Recommended Next Implementation Sequence

1. Resolve the spec/documentation blockers before new schema work:
   - Update the addendum migration index so it no longer collides with shipped migrations.
   - Decide whether Ground/Analyze are now part of the pipeline/API/worker contract or explicitly future.

2. Fix low-to-medium size base-spec drifts:
   - Align CLI ingest storage path with `sources.id`.
   - Add or remove `grounding.skip_types`.
   - Gate user-facing corroboration scores under sparse-corpus thresholds.
   - Align taxonomy bootstrap/export schemas with the documented contract.

3. Treat M10 as the next real foundation milestone:
   - Implement provenance/content-addressed storage, quality assessment, assertion classification, sensitivity/RBAC foundations, and rollback before real archive ingest.

4. Keep M11-M14 as future roadmap work:
   - Do not treat credibility profiles, conflict nodes, review workflow, discovery, exchange, or research-agent features as current implementation until their tables, config, API/CLI surfaces, and tests exist.

## Done Criteria For "No Spec Divergence"

- All P1/P2 entries above are either implemented or explicitly reflected as intentional spec changes.
- The addendum migration plan starts after the current highest migration and has no numbering collisions.
- A test proves CLI ingest storage path and `sources.id` alignment.
- Pipeline tests cover the final chosen Ground/Analyze orchestration contract.
- API/CLI outputs do not present sparse corroboration scores as reliable.
- Taxonomy bootstrap/export fixtures match the public schema documented in the functional spec.
- M10 is complete or real archive ingest remains explicitly out of scope.
