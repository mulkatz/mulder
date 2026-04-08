---
milestone: M3
title: "Stories and entities appear" — Segment + Enrich
reviewed: 2026-04-08
steps_reviewed: [C1, C2, C3, C4, C5, C6, C7, C8, C9, C10]
spec_sections: [§1, §2, §2.3, §2.4, §3.4, §4.3, §4.3.1, §4.4, §4.5, §4.8, §6, §6.2, §7.3, §8, §14, §15.1, §15.2]
verdict: PASS_WITH_WARNINGS
---

# Milestone Review: M3 — Segment + Enrich

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| Warning  | 5 |
| Note     | 6 |

**Verdict:** PASS_WITH_WARNINGS

M3 delivers a solid implementation of the core "intelligence" pipeline: a Segment step that produces per-story Markdown + lean metadata JSON to GCS, an Enrich step that orchestrates JSON-Schema generation, taxonomy normalization, and 3-tier cross-lingual entity resolution, and a cascading reset PL/pgSQL function that matches the spec almost verbatim. Repositories follow the function-based pattern established in M2, all SQL is parameterized, and golden test sets exist for both segmentation (3 documents) and entity extraction (5 articles). No critical or correctness-breaking findings. The warnings cluster around (a) the spec's `countTokens` requirement being substituted with a `chars/4` heuristic, (b) a few small drifts from the spec's documented merge semantics, and (c) the taxonomy package not yet containing the `bootstrap.ts` / `merge.ts` files listed in §6 (those steps are scheduled for a later milestone but the §6 layout is presented as authoritative).

---

## Per-Section Divergences

### §2.3 — Segment

**[DIV-001] Page-level metadata fields synthesized rather than extracted**
- **Severity:** NOTE
- **Spec says:** The metadata JSON example (lines 300–313) lists `author`, `pages`, `date_references`, `geographic_references`, `extraction_confidence`.
- **Code does:** `packages/pipeline/src/segment/index.ts:105–149` builds a `SegmentMetadataJson` with `id`, `document_id`, `title`, `subtitle`, `language`, `category`, `pages`, `date_references`, `geographic_references`, `extraction_confidence`. The `author` field from the spec example is not present.
- **Evidence:** The Gemini schema in `segment/schema.ts` does not request an `author` field. Likely intentional since author is optional in many magazines, but it diverges from the spec example.

**[DIV-002] `pages` is generated as a contiguous range from page_start..page_end**
- **Severity:** NOTE
- **Spec says:** Example metadata: `"pages": [12, 13, 14]` — suggests an explicit list of pages a story actually appears on.
- **Code does:** `segment/index.ts:133–136` builds `pages` by iterating from `page_start` to `page_end` inclusive, regardless of whether intermediate pages contain content for the story.
- **Evidence:** A story spanning pages 12 → 14 with an interrupting ad on page 13 would still emit `[12, 13, 14]`. Acceptable simplification, but it loses information versus the spec example.

### §2.4 — Enrich

**[DIV-003] Hard token-count check uses character heuristic instead of `countTokens` API**
- **Severity:** WARNING
- **Spec says:** "Hard token-count check (via `@google/generative-ai` tokenizer or `countTokens` API)" (functional-spec.md:339)
- **Code does:** `packages/pipeline/src/enrich/index.ts:78–85` defines `estimateTokens(text)` as `Math.ceil(text.length / 4)` — a static character-to-token ratio.
- **Evidence:** The spec calls this "hard" specifically to prevent Gemini truncating mid-JSON. The `chars/4` heuristic underestimates token count for non-Latin scripts (German compound nouns, CJK) by a factor of 2–3×, which means a 30k-token German story may pass the 15k check and still get truncated. The `LlmService` interface should expose `countTokens`, or the enrich step should call the Vertex tokenizer directly.

**[DIV-004] Enrich does not propagate `canonical_id` from taxonomy match to entity**
- **Severity:** WARNING
- **Spec says:** §2.4 step 6: "If match found (similarity > threshold): assign `canonical_id`, add as alias" (line 348). The intent is that taxonomy normalization gives the entity a canonical identifier.
- **Code does:** `enrich/index.ts:415–419` calls `normalizeTaxonomy()` and only counts taxonomy entries added; the returned `taxonomyEntry` is discarded. The entity's `canonical_id` is only set later by the cross-lingual resolver (or self-pointed at line 440). The `taxonomy_status` column on `entities` is also never written from the taxonomy result (always defaults to `auto`).
- **Evidence:** Taxonomy normalization currently only mutates the `taxonomy` table, not the `entities` table. Entities are not linked to their taxonomy entry via any column (no `taxonomy_id` column exists), so the only way the taxonomy match becomes visible on the entity is through the alias side-effect.

**[DIV-005] Tier 3 only operates on Tier 2 near-misses, not on independent candidates**
- **Severity:** NOTE
- **Spec says:** "Tier 3 — LLM-assisted (semantic): Gemini receives candidate pairs and decides whether they represent the same entity" (line 354). The spec frames Tier 3 as a general semantic fallback.
- **Code does:** `enrich/resolution.ts:389–414` only invokes Tier 3 with `tier2NearMisses` (entities scoring between `0.8 * threshold` and `threshold`). If Tier 2 is disabled, Tier 3 receives an empty candidate set and is skipped entirely.
- **Evidence:** A reasonable optimization (avoids running expensive LLM calls on the whole table), but it makes Tier 3 effectively dependent on Tier 2 being enabled. Worth documenting in the spec if intentional.

**[DIV-006] Deadlock-prevention sort uses `(type, name)`, not `(entity_type, canonical_name)`**
- **Severity:** NOTE
- **Spec says:** "Sort all entity upserts lexicographically by `(entity_type, canonical_name)`" (line 358)
- **Code does:** `enrich/index.ts:391–395` sorts extracted entities by `(type, name)` — i.e. the raw extracted name, not the canonical one (which is unknown at sort time).
- **Evidence:** Functionally equivalent for deadlock prevention (any deterministic ordering works), but the spec wording implies sorting after normalization. Both implementations achieve the goal.

**[DIV-007] `relationship.attributes` typed as `passthrough()` instead of strict shape**
- **Severity:** NOTE
- **Spec says:** Relationships are part of the ontology contract; structured output should be strictly schema-validated.
- **Code does:** `enrich/schema.ts:146` uses `z3.object({}).passthrough().optional()` for relationship attributes.
- **Evidence:** Allows arbitrary relationship attributes through validation without checking against the ontology relationship-attribute config. Acceptable since the spec doesn't define relationship-attribute schemas explicitly, but it bypasses one layer of safety.

### §3.4 — Force Re-runs & Cascading Reset

No divergences found. `forceCleanupSource()` in `enrich/index.ts:190` calls `resetPipelineStep(pool, sourceId, 'enrich')`, and the segment step's `forceCleanup()` calls `resetPipelineStep(..., 'segment')` plus GCS prefix deletion. Both delegate atomic DB work to the PL/pgSQL function as the spec requires.

### §4.3 — Core Database Schema (stories, entities, edges, taxonomy)

No divergences found. The migrations match the spec column-for-column:
- `stories` (003): all columns including `gcs_markdown_uri`, `gcs_metadata_uri`, `chunk_count`, `extraction_confidence`, `status`, no inline content column.
- `entities` (004): includes `canonical_id` self-FK with `ON DELETE SET NULL`, `taxonomy_status` defaulting to `auto`.
- `entity_aliases` (004): `UNIQUE(entity_id, alias)` constraint present.
- `entity_edges` (005), `story_entities` (005), `taxonomy` (007): all match.
Repository row mappers in `story.repository.ts:46`, `entity.repository.ts`, `edge.repository.ts`, `taxonomy.repository.ts` use the snake_case → camelCase pattern from M2.

### §4.3.1 — Cascading Reset Function

No divergences found. `migrations/014_pipeline_functions.sql` reproduces the spec PL/pgSQL almost verbatim:
- Five branches (`extract`, `segment`, `enrich`, `embed`, `graph`) match the spec's branch logic.
- `gc_orphaned_entities()` is a separate function returning the deleted count, exactly as the spec dictates.
- Status rollbacks (`extracted`, `segmented`, `enriched`, `embedded`) match.
- Orphan cleanup is correctly NOT inlined into reset (race-condition concern from spec lines 1106–1108 respected).

### §4.4 — Storage Architecture

No divergences found. Segment writes:
- `segments/{source-id}/{story-id}.md` (Markdown, `text/markdown`) — `segment/index.ts:335, 340`
- `segments/{source-id}/{story-id}.meta.json` (lean metadata) — `segment/index.ts:336, 353`
Story records contain only GCS URIs (`gcs_markdown_uri`, `gcs_metadata_uri`); no Markdown is stored in PostgreSQL columns. Enrich loads Markdown on demand via `services.storage.download(story.gcsMarkdownUri)`.

### §4.5 — Service Abstraction

No divergences found. Neither `packages/pipeline/src/segment/` nor `packages/pipeline/src/enrich/` imports from `packages/core/src/shared/gcp.ts` directly. Both consume the `Services` interface (storage, llm, embedding, firestore) injected from the registry. The Vertex AI structured output call goes through `services.llm.generateStructured()`, the embedding call through `services.embedding.embed()`.

### §4.8 — Vertex AI Wrapper (used by Enrich)

No divergences found for M3 usage. Enrich passes a `responseValidator` (Zod v4 schema) per story to `generateStructured`, exercising the validator hook added during M2's resolution of DIV-011. Tier 3 LLM resolution passes the JSON schema directly without a validator (acceptable since the response shape is fixed and minimal).

### §6 — Taxonomy System (Module Layout)

**[DIV-008] Taxonomy package missing `bootstrap.ts` and `merge.ts`**
- **Severity:** WARNING
- **Spec says:** §6 (lines 1496–1502) lists the taxonomy module as containing `bootstrap.ts`, `normalize.ts`, `merge.ts`, `types.ts`.
- **Code does:** `packages/taxonomy/src/` contains only `index.ts` and `normalize.ts`. No `bootstrap.ts`, no `merge.ts`, no `types.ts` (types live in `@mulder/core`).
- **Evidence:** Bootstrap and curation are scheduled for a later milestone (M5/M8 area), so this is expected — but the §6 file layout reads as the authoritative current structure. Either §6 should be marked as "target layout" or the missing files should be stubbed.

### §6.2 — Normalization (inline in Enrich)

**[DIV-009] Normalization does not flow back to the entity record**
- **Severity:** WARNING
- **Spec says:** "If match > threshold: assign `canonical_id` from taxonomy entry, add as alias" (line 1522)
- **Code does:** `taxonomy/src/normalize.ts:44–112` correctly searches by trigram similarity, respects `confirmed` vs `auto` status, and creates new auto entries. However the result is not consumed by the enrich step to populate the entity's `taxonomy_status` or any taxonomy-link column. See also DIV-004.
- **Evidence:** The normalization function itself is correct. The integration in `enrich/index.ts:415–419` discards everything but the `created` flag.

### §7.3 — Retry Strategy

No divergences found. Enrich and Segment use the shared `services.llm.generateStructured()` (which uses `withRetry` per M2's retry implementation) for all LLM calls. Taxonomy normalization uses parameterized SQL only (no retry needed). Tier 2 embedding calls go through `services.embedding.embed()`, which is also wrapped.

### §8 — Logging

No divergences found. Both steps create child loggers with `step` and `sourceId`/`storyId` bound (`segment/index.ts:177`, `enrich/index.ts:220`). The resolution module uses a module-bound child logger (`resolution.ts:38–39`). Structured fields throughout — no string interpolation in log messages.

### §14 — Key Design Decisions (zod-to-json-schema)

No divergences found. `enrich/schema.ts` correctly uses `zodToJsonSchema` from the official package with `$refStrategy: 'none'`. The dual Zod v3/v4 pattern (v3 for json-schema generation, v4 for runtime validation) is documented in the file header and matches the M2 segment schema. Entity types and relationship types are deterministically sorted (`getEntityTypeNames`, `relationshipNames.sort()`). No hand-rolled schema conversion.

### §15.1 — Golden Test Set

No divergences found. Golden fixtures present:
- `eval/golden/segmentation/`: `magazine-issue-1.json`, `mixed-content-issue.json`, `single-story-report.json`
- `eval/golden/entities/`: `cross-lingual-article.json`, `editorial-article.json`, `investigation-article.json`, `multi-entity-article.json`, `sighting-report-article.json`

This exceeds the spec's "5–10 manually annotated pages" minimum. Cross-lingual coverage is explicitly included.

### §15.2 — Metrics Per Step

**[DIV-010] No relationship-level metric exposed for Enrich**
- **Severity:** NOTE
- **Spec says:** Enrich row in the metrics table (line 2430): "Entity Extraction Precision, Recall, F1 per entity type". Graph row (2433) covers "Relationship Accuracy".
- **Code does:** `packages/eval/src/entity-metrics.ts` computes per-type and overall PRF1 for entities. There is also relationship matching logic (since `entity-metrics.ts` imports `ExpectedRelationship`), but it isn't part of the Enrich-step metric requirement.
- **Evidence:** Compliant with §15.2 row "Enrich". The relationship-accuracy metric belongs to Graph (M5) and is correctly not in scope here. Listed as a NOTE because the imported `ExpectedRelationship` could give the impression that Enrich owns relationship metrics — it does not.

---

## Cross-Cutting Convention Review

### Naming Conventions
All M3 source files are `kebab-case.ts`. Types/interfaces (`SegmentResult`, `EnrichmentData`, `ResolutionCandidate`, `NormalizationResult`, `StoryRow`) are `PascalCase`. Functions (`createStory`, `normalizeTaxonomy`, `resolveEntity`, `forceCleanup`) are `camelCase`. Database columns and config keys are `snake_case`.

### TypeScript Strictness
- No `any` types in `packages/pipeline/src/{segment,enrich}/`, `packages/core/src/database/repositories/`, or `packages/taxonomy/src/`.
- No `console.log` calls in M3 source files.
- No generic `throw new Error()` — all throws use `SegmentError`, `EnrichError`, `DatabaseError`, `MulderEvalError`.
- `as` assertions are limited to the `z3.enum([...] as [string, ...string[]])` pattern in `enrich/schema.ts:131,143,187,197`, which is required by Zod's tuple-typed enum signature. Acceptable.
- All packages declare `"type": "module"`.

### Architecture Patterns
- **Service abstraction:** Pipeline steps import only from `@mulder/core` (interface side) and `@mulder/taxonomy`. No direct `gcp.ts` or GCP SDK imports. Verified.
- **Config via loader:** Both CLI commands (`apps/cli/src/commands/segment.ts:18`, `enrich.ts:20`) call `loadConfig()`. No direct YAML parsing.
- **Custom errors:** `SegmentError`, `EnrichError`, `DatabaseError`, `MulderEvalError` are used throughout with structured error codes (`SEGMENT_ERROR_CODES`, `ENRICH_ERROR_CODES`, `DATABASE_ERROR_CODES`, `EVAL_ERROR_CODES`).
- **Structured logging:** Pino child loggers everywhere; no string concatenation in log messages.
- **Zod validation:** Enrich uses `responseValidator` for Gemini structured output validation. Segment uses `segmentationResponseSchema.parse(data)` as its validator (`segment/index.ts:293`).

### Package Structure
- All M3 packages use `workspace:*` for cross-package deps.
- `packages/pipeline/src/enrich/index.ts` re-exports the resolution and schema modules via barrel pattern.
- `packages/taxonomy/src/index.ts` re-exports `normalize.ts`.
- TypeScript project references intact.

### Test Coverage
M3 black-box tests (one per step):
- `tests/specs/22_story_repository.test.ts` — C1
- `tests/specs/23_segment_step.test.ts` — C2
- `tests/specs/24_entity_alias_repositories.test.ts` — C3
- `tests/specs/25_edge_repository.test.ts` — C4
- `tests/specs/26_json_schema_generator.test.ts` — C5
- `tests/specs/27_taxonomy_normalization.test.ts` — C6
- `tests/specs/28_cross_lingual_entity_resolution.test.ts` — C7
- `tests/specs/29_enrich_step.test.ts` — C8
- `tests/specs/30_cascading_reset_function.test.ts` — C9
- `tests/specs/31_golden_test_set_segmentation_entities.test.ts` — C10

Every M3 step has a dedicated test file. Numbering is contiguous and matches roadmap order.

---

## CLAUDE.md Consistency

- "Pipeline steps are idempotent and can be re-run individually. Database upserts (`ON CONFLICT DO UPDATE`) are mandatory." — Verified: `createStory`, `upsertEntityByNameType`, `upsertEdge`, `createTaxonomyEntry` all use `ON CONFLICT`.
- "Entity extraction uses Gemini structured output with **dynamically generated JSON Schema from config** (via `zod-to-json-schema` — mandatory, never hand-roll)" — Verified: `enrich/schema.ts` uses the official library; no hand-rolled conversion.
- "Cross-lingual entity resolution: 3-tier (attribute match → embedding similarity → LLM-assisted)" — Verified: `enrich/resolution.ts` implements all three tiers in the documented order. Note: Tier 3 is gated on Tier 2 having produced near-misses (DIV-005).
- "Taxonomy normalization happens IN the extraction pipeline (Enrich step), not as post-processing" — Verified: called inline in `enrich/index.ts:416`.
- "Two-phase contradiction detection: Graph step flags... Analyze step resolves..." — Out of scope for M3, no M3 code touches contradictions.
- "Content in GCS, References/Index in PostgreSQL" — Verified: Segment writes Markdown + meta JSON to GCS; only URIs and lean fields land in `stories`.

No CLAUDE.md statements about M3 are contradicted by the implementation.

---

## Remaining Recommendations

### Should Fix (Warning)
1. **DIV-003:** Replace the `chars/4` token heuristic in Enrich with a real `countTokens` call (either via the Vertex SDK directly or via a new `LlmService.countTokens` method). The current heuristic systematically under-counts non-Latin text and defeats the purpose of the "hard" check the spec calls for.
2. **DIV-004 / DIV-009:** Decide how taxonomy normalization should surface on the entity. Either (a) add a `taxonomy_id` column to `entities` and link, or (b) update the spec §2.4 step 6 to say taxonomy normalization is alias-only. Today the result is partially discarded.
3. **DIV-008:** Either add stub `bootstrap.ts` / `merge.ts` files in `packages/taxonomy/src/` (matching §6 module layout), or annotate §6 with a "planned for M5" marker.

### For Consideration (Note)
4. **DIV-001 / DIV-002:** Consider adding `author` to the segmentation schema and/or recording an explicit `pages: number[]` instead of synthesizing the range — useful when stories are interrupted by ads.
5. **DIV-005:** Document the design decision that Tier 3 only fires on Tier 2 near-misses, or make Tier 3 work independently when Tier 2 is disabled.
6. **DIV-006:** Tweak §2.4 wording to say "by `(type, name)`" since canonical name is unknown at sort time.
7. **DIV-007:** Tighten relationship-attribute validation once the ontology config gains relationship-attribute schemas.
8. **DIV-010:** Move the `ExpectedRelationship` import out of `entity-metrics.ts` (to a shared types file) so that the Enrich metric module doesn't appear to own relationship metrics that belong to Graph.
