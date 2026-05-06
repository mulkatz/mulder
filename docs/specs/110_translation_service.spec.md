---
spec: 110
title: "Translation Service"
roadmap_step: "M11-L4"
functional_spec: "§A7, §A5"
scope: "phased"
issue: "https://github.com/mulkatz/mulder/issues/291"
created: 2026-05-06
---

# Spec 110: Translation Service

## 1. Objective

Complete M11-L4 by adding Mulder's document translation service from §A7. A source document must be translatable through an explicit translation-only path for reading access and through a full-pipeline path that records translation as a byproduct of pipeline work. Translations are persisted, cached by source/target language, invalidated when the source material changes, and served without another LLM call when the current cache entry is valid.

The service is intentionally CLI-first and storage-light. The canonical translated content is stored as Markdown or HTML text in PostgreSQL, not rebuilt into a PDF. L4 does not add a review UI, terminology glossary, or second LLM verification pass.

## 2. Boundaries

**Roadmap step:** M11-L4 - Translation service - two paths, caching.

**Base branch:** `milestone/11`. This spec is delivered to the M11 integration branch, not directly to `main`.

**Target branch:** `feat/291-translation-service`.

**Primary files:**

- `packages/core/src/database/migrations/040_translated_documents.sql`
- `packages/core/src/database/repositories/translated-document.repository.ts`
- `packages/core/src/database/repositories/translated-document.types.ts`
- `packages/core/src/database/repositories/source.repository.ts`
- `packages/core/src/database/repositories/pipeline-reset.ts`
- `packages/core/src/database/repositories/source-rollback.repository.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/types.ts`
- `packages/core/src/prompts/templates/translate-document.jinja2`
- `packages/core/src/shared/services.dev.ts`
- `packages/core/src/index.ts`
- `packages/pipeline/src/translate/index.ts`
- `packages/pipeline/src/translate/types.ts`
- `packages/pipeline/src/index.ts`
- `apps/cli/src/commands/translate.ts`
- `apps/cli/src/index.ts`
- `tests/lib/schema.ts`
- `tests/specs/110_translation_service.test.ts`
- `docs/roadmap.md`

**In scope:**

- Add a `translated_documents` table aligned with §A7 and sensitivity metadata from §A5.
- Add repository APIs for inserting current translations, finding current cache entries, listing translations, marking translations stale, and deleting translations for purged sources.
- Add `translation` config defaults and validation from §A7.
- Add a pipeline translation module that can translate supplied document content or source-owned stored content, records `pipeline_path` as `full` or `translation_only`, and returns an explicit `translated` or `cached` outcome.
- Add deterministic dev-mode text generation for translation prompts so tests never call production Gemini.
- Add a thin `mulder translate <source-id>` CLI surface for translation-only/manual use.
- Invalidate cached translations when source file identity/storage changes and when extract/segment resets can change source-derived Markdown.
- Delete translated documents during source purge.

**Out of scope:**

- Browser UI actions, API routes, async worker jobs, or review queue integration for translations.
- Rebuilding translated PDFs or preserving visual PDF layout.
- Human translation review workflows, second-pass quality verification, terminology glossaries, or project-specific dictionaries.
- Full replacement of the main pipeline step order. L4 records the full-pipeline translation path through the translation service; it does not insert `translate` into the existing ingest/extract/segment/enrich/embed/graph order.
- Translating every historical source automatically. Re-translation is on demand.

**Architectural constraints:**

- Cache lookup is by `(source_document_id, target_language)` for current rows. `pipeline_path` is recorded for provenance, but the cache pair remains source/target as specified in §A7.
- At most one `current` translation may exist per `(source_document_id, target_language)`.
- `content_hash` represents the source material used for the translation. If the current source material hash differs from a cached row, the cached row must become `stale` before a new current row is inserted.
- The service must respect `translation.enabled`, `translation.supported_languages`, `translation.cache_enabled`, `translation.output_format`, and `translation.max_document_length_tokens`.
- Translation artifacts inherit or explicitly store sensitivity metadata so L5 RBAC can filter them.
- Config and tests must work from a fresh checkout using example/temp configs, not a missing root `mulder.config.yaml`.

## 3. Dependencies

- Spec 11 service abstraction provides `Services.llm.generateText()` and dev/GCP service registries.
- Spec 18 prompt templates provide the template-driven prompt boundary.
- Spec 22 stories and source repositories provide source-owned content metadata.
- Spec 32 chunks and Spec 36 pipeline orchestration establish existing source reset patterns.
- M10-K5 / Spec 102 provides sensitivity levels and metadata.
- M10-K6 / Spec 104 provides source rollback and purge hooks.

L4 blocks M11-L5 only at the milestone integration level. It directly enables later API/UI translation access, export-language selection in M13, and agent-readable translated document context in M14.

## 4. Blueprint

1. Add migration `040_translated_documents.sql`:
   - Create `translated_documents` with `id UUID`, `source_document_id UUID REFERENCES sources(id) ON DELETE CASCADE`, `source_language TEXT`, `target_language TEXT`, `translation_engine TEXT`, `translation_date TIMESTAMPTZ`, `content TEXT`, `content_hash TEXT`, constrained `status` (`current`, `stale`), constrained `pipeline_path` (`full`, `translation_only`), constrained `output_format` (`markdown`, `html`), `sensitivity_level`, `sensitivity_metadata`, and timestamps.
   - Add a partial unique index on `(source_document_id, target_language)` where `status = 'current'`.
   - Add indexes for source scans, target/status scans, stale cleanup, and content hash lookup.

2. Add repository module and exports:
   - Define `TranslatedDocument`, `TranslationStatus`, `TranslationPipelinePath`, `TranslationOutputFormat`, and repository input/list option types.
   - Implement `createCurrentTranslatedDocument`, `findCurrentTranslatedDocument`, `listTranslatedDocumentsForSource`, `markTranslatedDocumentsStaleForSource`, and `deleteTranslatedDocumentsForSource`.
   - `createCurrentTranslatedDocument` must run in one transaction, mark older current rows for the same source/target stale, and insert the new current row.
   - Repository list functions must exclude soft-deleted sources by default and offer an explicit include-deleted option only for rollback/admin tests.

3. Add config:
   - `translation.enabled` default `true`.
   - `translation.default_target_language` default `en`.
   - `translation.supported_languages` defaults to `de`, `en`, `fr`, `es`, `pt`, `ru`, `zh`, `ja`, `pl`, and `cs`.
   - `translation.engine` default `gemini-2.5-flash`.
   - `translation.output_format` default `markdown`.
   - `translation.cache_enabled` default `true`.
   - `translation.max_document_length_tokens` default `500000`.

4. Add translation pipeline module:
   - Input accepts `sourceId`, optional `targetLanguage`, optional `sourceLanguage`, `pipelinePath`, optional supplied `content`, optional `outputFormat`, and `refresh`.
   - When content is supplied, translate that content and hash it.
   - When content is not supplied, assemble source-owned Markdown from existing stories where available. If no stories exist, fall back to raw source content for text-like sources and to a media-backed LLM call for binary layout sources where the service interface can carry media.
   - Before calling the LLM, check the current cache entry when cache is enabled and `refresh` is false. Return `cached` without an LLM call if source/target and `content_hash` match.
   - Render `translate-document.jinja2`, call `services.llm.generateText()`, persist the current translation, and return a result containing translation id, cache outcome, languages, output format, pipeline path, and content.
   - Enforce supported target/source languages and `max_document_length_tokens` for text-backed translation. Documents beyond the limit must fail with a clear error until chunked translation is implemented in a later spec.

5. Add CLI:
   - Register `mulder translate <source-id>`.
   - Options: `--target <lang>`, `--source-language <lang>`, `--path <full|translation-only>`, `--format <markdown|html>`, `--refresh`, and `--json`.
   - Default path is `translation_only`, default target/output format come from config.
   - CLI prints translated content to stdout in normal mode and a compact JSON object in `--json` mode. Summary/status messages must not corrupt JSON output.

6. Add invalidation and rollback integration:
   - `updateSource` marks translations stale when `fileHash`, `storagePath`, `sourceType`, or format metadata changes.
   - `resetPipelineStep` marks translations stale for `extract` and `segment` resets because source-owned Markdown can change.
   - `purgeSource` deletes translations for the purged source and reports the deletion count.
   - Soft-delete hides translations through repository/source joins; restore makes them visible again without modifying translation rows.

7. Update roadmap state only after gates:
   - Keep L4 in progress while implementation is open.
   - Mark L4 complete only after scoped tests, affected checks, review, PR CI, and merge to `milestone/11`.

## 5. QA Contract

1. **QA-01: Translation schema is constrained and cache-safe**
   - Given a migrated test database
   - When schema metadata is inspected
   - Then `translated_documents` exists with current/stale, full/translation-only, markdown/html constraints, sensitivity columns, source indexes, and a partial unique current translation per source/target.

2. **QA-02: Config exposes §A7 defaults**
   - Given minimal config based on the example config
   - When it is loaded through the public config loader
   - Then `translation` is enabled with target language `en`, the §A7 supported language set, engine `gemini-2.5-flash`, output format `markdown`, cache enabled, and max length `500000`.

3. **QA-03: Translation-only path persists a current translation**
   - Given a source with source-owned Markdown content and translation enabled
   - When the translation service runs with `pipeline_path = translation_only`
   - Then a current translated document is inserted with target language, source language, engine, content hash, output format, inherited sensitivity, and translated content.

4. **QA-04: Full-pipeline path is recorded without changing cache semantics**
   - Given no current translation for a source/target pair
   - When the translation service runs with `pipeline_path = full`
   - Then the row records `pipeline_path = full`, and a later translation-only request for the same source/target/content is served from the same current cache row without another LLM call.

5. **QA-05: Cache hits do not call the LLM**
   - Given a current translation whose content hash matches the source material
   - When translation is requested again with cache enabled and no refresh
   - Then the service returns `cached`, preserves the existing translation id, and does not invoke `generateText`.

6. **QA-06: Refresh or source material changes produce stale history**
   - Given a current translation
   - When refresh is requested or the source material hash changes
   - Then the previous current row becomes `stale`, a new current row is inserted, and both rows remain queryable as history.

7. **QA-07: Source update/reset/purge integration is safe**
   - Given current translations for a source
   - When source file identity changes or extract/segment is reset
   - Then translations become `stale`.
   - When the source is purged
   - Then translation rows for that source are deleted and the purge report includes the count.

8. **QA-08: CLI exposes translation without production calls in dev mode**
   - Given a dev-mode config and a source with test Markdown
   - When `mulder translate <source-id> --json` runs
   - Then the command exits `0`, returns JSON containing the translated document id and cache outcome, and uses the deterministic dev LLM translation fixture.

## 5b. CLI Test Matrix

| Command | Scenario | Expected |
|---------|----------|----------|
| `mulder translate <source-id>` | Default config and source-owned Markdown | Exit 0, prints translated Markdown |
| `mulder translate <source-id> --json` | JSON mode | Exit 0, stdout is valid JSON and contains `outcome` |
| `mulder translate <source-id> --target xx` | Unsupported target language | Exit non-zero with a clear validation error |
| `mulder translate <source-id> --path full` | Full-pipeline byproduct path | Exit 0, persisted row records `full` |
| `mulder translate <source-id> --refresh` | Existing cache row | Exit 0, previous row becomes stale |

## 6. Cost Considerations

L4 adds optional Gemini text-generation calls. Cache hits must short-circuit before model invocation, and deterministic dev/test fixtures must avoid paid calls. The default max document length protects against accidental huge prompts; chunked translation can be added later with explicit tests and cost estimates. Translation-only runs intentionally skip enrichment, graph, embedding, and analysis work.
