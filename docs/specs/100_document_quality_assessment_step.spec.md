---
spec: "100"
title: "Document Quality Assessment Step"
roadmap_step: M10-K3
functional_spec: ["§A4", "§A1", "§A2"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/266"
created: 2026-05-05
---

# Spec 100: Document Quality Assessment Step

## 1. Objective

Complete M10-K3 by adding a deterministic document quality assessment step between ingest and extract. §A4 defines the long-term quality model:

```ts
interface DocumentQualityAssessment {
  document_id: string;
  assessed_at: string;
  assessment_method: "automated" | "human";
  overall_quality: "high" | "medium" | "low" | "unusable";
  processable: boolean;
  recommended_path: ExtractionPath;
  dimensions: {
    text_readability: { score: number; method: "ocr_confidence" | "llm_visual" | "n/a"; details: string };
    image_quality: { score: number; issues: string[] };
    language_detection: { primary_language: string; confidence: number; mixed_languages: boolean };
    document_structure: {
      type:
        | "printed_text"
        | "handwritten"
        | "mixed"
        | "table"
        | "form"
        | "newspaper_clipping"
        | "photo_of_document"
        | "diagram";
      has_annotations: boolean;
      has_marginalia: boolean;
      multi_column: boolean;
    };
    content_completeness: {
      pages_total: number;
      pages_readable: number;
      missing_pages_suspected: boolean;
      truncated: boolean;
    };
  };
}
```

K3 must persist this assessment, expose it as a real pipeline step named `quality`, route obviously unprocessable documents away from automatic extract, and propagate compact quality metadata to downstream artifacts. The implementation must stay domain-agnostic and config-driven. It must not introduce archive-specific terms, hard-coded collections, or paid-service behavior by default.

## 2. Boundaries

**Roadmap step:** M10-K3 - Document quality assessment step.

**Base branch:** `milestone/10`. This spec is delivered to the M10 integration branch, not directly to `main`.

**Target branch:** `feat/266-document-quality-assessment`.

**Target files:**

- `packages/core/src/database/migrations/026_document_quality_assessments.sql`
- `packages/core/src/database/repositories/document-quality.repository.ts`
- `packages/core/src/database/repositories/document-quality.types.ts`
- `packages/core/src/database/repositories/index.ts`
- `packages/core/src/config/schema.ts`
- `packages/core/src/shared/pipeline-step-plan.ts`
- `packages/core/src/database/repositories/pipeline-reset.ts`
- `packages/pipeline/src/quality/index.ts`
- `packages/pipeline/src/quality/types.ts`
- `packages/pipeline/src/pipeline/index.ts`
- `packages/pipeline/src/pipeline/types.ts`
- `packages/pipeline/src/index.ts`
- `packages/pipeline/src/extract/index.ts`
- `apps/cli/src/commands/quality.ts`
- `apps/cli/src/index.ts`
- Worker/API step dispatch files as needed for existing pipeline job routing
- `tests/specs/100_document_quality_assessment_step.test.ts`
- Existing config, pipeline-plan, CLI, worker, extract, and migration tests as needed
- `docs/roadmap.md`

**In scope:**

- Add a `document_quality_assessments` table keyed by source document id.
- Store the §A4 assessment payload with normalized TypeScript types and snake_case database JSON where applicable.
- Add a `quality` pipeline step immediately after `ingest` and before `extract`.
- Record successful quality execution in `source_steps` with `step_name = 'quality'`.
- Keep `sources.status` unchanged after quality assessment. A quality-assessed source remains `ingested` until extract completes, because existing source status values are lifecycle checkpoints rather than every internal step.
- Add `document_quality` configuration with safe defaults matching §A4 names.
- Implement deterministic automated assessment from cheap local signals:
  - Text-like/prestructured sources (`text`, `markdown`, `docx`, `spreadsheet`, `email`, `url`) default to `high` and `standard` when no override or quality signal says otherwise.
  - PDF/image sources use existing metadata such as page count, native text ratio, OCR confidence, image warnings, and explicit test/manual overrides when present.
  - Explicit `document_quality_override` metadata may force quality, processability, recommended path, and dimensions for tests or manually staged ingest.
- Add human/manual assessment support at repository level through `assessment_method = 'human'`, without building UI review queues.
- Make latest assessment lookup idempotent: re-running `quality` without `--force` reuses the latest assessment; re-running with `--force` writes a new assessment version and marks the step complete again.
- Route non-processable documents conservatively:
  - `recommended_path = 'skip'` or `manual_transcription_required` prevents automatic extract from creating stories/artifacts.
  - The extract step must return an observable skipped result and record a skipped `source_steps` row instead of failing the pipeline.
- Propagate compact quality metadata to source and extracted story metadata:
  - `source_document_quality`
  - `extraction_path`
  - `extraction_confidence`
  - `document_quality_assessment_id`
- Add a CLI command that can run the step for one source or all eligible ingested sources.
- Keep all quality labels generic and configurable. No domain terms or archive-specific concepts may appear in code paths.

**Out of scope:**

- Gemini Vision, paid OCR, LLM calls, or external network calls during default quality assessment.
- Full manual review queue UI, reviewer notifications, task assignment, or RBAC.
- Per-page quality annotations and page-level routing.
- Enhanced OCR implementation, handwriting recognition, visual extraction implementation, or model selection changes.
- Batch quality report APIs and dashboard analytics.
- New `sources.status` values such as `quality_assessed`.
- Backfilling quality assessments for all historical sources outside the normal migration/test seed path.
- Changing public API response contracts unless an existing internal pipeline endpoint already exposes step names/results.

## 3. Dependencies

- M10-K1 / Spec 98: raw documents are content-addressed and deduplicated; quality must evaluate the durable `sources` document record, not temporary upload paths.
- M10-K2 / Spec 99: downstream artifacts can already carry source provenance; K3 adds quality metadata without weakening provenance writes.
- Existing pipeline step planning and reset behavior. K3 extends the step list but must preserve existing commands like `extract`, `segment`, `enrich`, `embed`, and `graph`.
- Existing extract routing for prestructured sources. Quality must not force text-like sources through PDF/image-only extraction paths.

K3 blocks M10-K9 because golden tests for quality routing require a persisted quality decision and an observable pipeline step.

## 4. Data Model

Add migration `026_document_quality_assessments.sql` with:

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE`
- `assessed_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `assessment_method TEXT NOT NULL`
- `overall_quality TEXT NOT NULL`
- `processable BOOLEAN NOT NULL`
- `recommended_path TEXT NOT NULL`
- `dimensions JSONB NOT NULL`
- `signals JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- CHECK constraints for:
  - `assessment_method IN ('automated', 'human')`
  - `overall_quality IN ('high', 'medium', 'low', 'unusable')`
  - `recommended_path IN ('standard', 'enhanced_ocr', 'visual_extraction', 'handwriting_recognition', 'manual_transcription_required', 'skip')`
  - `jsonb_typeof(dimensions) = 'object'`
  - `jsonb_typeof(signals) = 'object'`
- Indexes:
  - `(source_id, assessed_at DESC)`
  - `(overall_quality)`
  - `(recommended_path)`
  - `(processable)`

The repository must expose:

- `DocumentQualityAssessment`
- `DocumentQualityDimensions`
- `DocumentQualitySignals`
- `ExtractionPath`
- `DocumentQualityOverride`
- `createDocumentQualityAssessment(pool, input)`
- `findLatestDocumentQualityAssessment(pool, sourceId)`
- `findDocumentQualityAssessmentById(pool, id)`
- `listDocumentQualityAssessmentsForSource(pool, sourceId)`
- `normalizeDocumentQualityDimensions(value)`
- `normalizeDocumentQualitySignals(value)`

Repository reads must map snake_case database payloads to camelCase TypeScript objects. Writes must validate known enums before SQL execution where practical and rely on database CHECK constraints as the final guard.

## 5. Configuration

Add `document_quality` to the config schema with defaults equivalent to:

```yaml
document_quality:
  enabled: true
  assessment:
    method: "ocr_confidence"
    engine: null
    ocr_confidence_threshold: 0.7
    native_text_ratio_threshold: 0.5
  routing:
    high: { path: "standard" }
    medium: { path: "enhanced_ocr", fallback: "visual_extraction" }
    low: { path: "visual_extraction", fallback: "manual_transcription_required" }
    unusable: { path: "skip", create_manual_task: false }
  quality_propagation:
    enabled: true
    low_quality_embedding_weight: 0.5
    low_quality_assertion_penalty: 0.3
  manual_queue:
    enabled: false
    notify_reviewers: false
    priority: "normal"
```

`assessment.method = 'gemini_vision'` or `'both'` is accepted by schema for §A4 compatibility but must be treated as unsupported by the default local assessor unless a future service-backed implementation is explicitly added. K3 must not silently make external calls from config alone.

## 6. Pipeline Behavior

1. Update the canonical order to `ingest -> quality -> extract -> segment -> enrich -> embed -> graph`.
2. `quality` is a source-level step. It does not operate per story.
3. When `document_quality.enabled = false`, the pipeline records `quality` as skipped and continues to extract.
4. When `quality` is requested and the latest completed assessment already exists, the step reuses it unless `force` is true.
5. `processSource` and step-scoped worker jobs must understand `quality` as a first-class step.
6. `targetSourceStatusForStep('quality')` returns the current ingested checkpoint. Quality must not advance source status beyond `ingested`.
7. `shouldRun` must preserve existing behavior for prestructured source skipping. Adding `quality` must not make prestructured sources run `segment`.
8. Extract must check the latest assessment before creating stories/artifacts:
   - `standard`, `enhanced_ocr`, and `visual_extraction` are processable for K3.
   - `handwriting_recognition` is processable only if the source is already text-like or an explicit override marks it processable.
   - `manual_transcription_required` and `skip` are not automatically extracted.
9. A skipped extract due to quality must be visible in `source_steps` and in the returned step result. It must not be reported as a failed extraction.

## 7. Assessment Rules

The default deterministic assessor should compute a complete dimensions object even when some fields are `n/a`.

- Text-like/prestructured sources:
  - `overall_quality = 'high'`
  - `processable = true`
  - `recommended_path = 'standard'`
  - `text_readability.score = 1`
  - `text_readability.method = 'n/a'`
  - `document_structure.type` follows source format when known (`table` for spreadsheets, `form` for structured email/form-like metadata, otherwise `printed_text`)
- PDF sources:
  - Prefer existing `format_metadata` or `metadata` signals such as `ocr_confidence`, `native_text_ratio`, `pages_total`, `pages_readable`, `image_quality_issues`, and `document_structure`.
  - Native text ratio above threshold routes to `high`/`standard`.
  - OCR confidence above threshold but weak native text routes to `medium`/`enhanced_ocr`.
  - Low confidence routes to `low`/`visual_extraction`.
  - Missing/unreadable page signals may route to `unusable`/`skip`.
- Image sources:
  - Good image quality routes to `medium`/`visual_extraction`.
  - Poor image quality or explicit unreadable signals route to `low`/`visual_extraction` or `unusable`/`skip`.
- Overrides:
  - `metadata.document_quality_override` and `format_metadata.document_quality_override` are accepted only as local/manual/test inputs.
  - Overrides must be normalized and validated through the same repository types as automated assessments.

## 8. Quality Propagation

The assessment step must write a compact quality summary to `sources.metadata.document_quality` without deleting existing metadata keys:

```json
{
  "source_document_quality": "high",
  "extraction_path": "standard",
  "extraction_confidence": 1,
  "document_quality_assessment_id": "..."
}
```

Extracted stories must include the same compact fields in `stories.metadata` when quality propagation is enabled. If extraction is skipped, no stories should be created for that source during the skipped run.

`source_document_quality` may use only `high`, `medium`, or `low` downstream. `unusable` must be mapped to `low` for downstream metadata while the persisted assessment keeps `overall_quality = 'unusable'`.

## 9. QA Contract

1. **QA-01: Migration creates constrained assessment table**
   - Given: a migrated test database
   - When: `information_schema` and `pg_constraint` are inspected
   - Then: `document_quality_assessments` exists with enum-like CHECK constraints, JSONB dimensions/signals constraints, and source indexes.

2. **QA-02: Repository round-trips full assessment payloads**
   - Given: a source and a complete assessment input
   - When: the repository writes and reads the assessment
   - Then: all enum fields, dimensions, signals, timestamps, and source ids round-trip in normalized TypeScript shape.

3. **QA-03: Latest assessment lookup is version-aware**
   - Given: two assessments for the same source
   - When: `findLatestDocumentQualityAssessment` is called
   - Then: it returns the newest `assessed_at` row without deleting historical rows.

4. **QA-04: Config defaults are safe and local**
   - Given: default config loading
   - When: `document_quality` is parsed
   - Then: quality is enabled, uses the local OCR-confidence method, has routing defaults, and does not configure a paid engine by default.

5. **QA-05: Pipeline plan includes quality before extract**
   - Given: a full pipeline plan
   - When: requested steps are resolved
   - Then: `quality` appears after `ingest` and before `extract`, while existing prestructured segment skipping still works.

6. **QA-06: Quality step persists assessment and source step**
   - Given: an ingested text-like source
   - When: `quality` runs
   - Then: one assessment is written, `source_steps` records `quality` as completed, and source metadata receives the compact quality summary.

7. **QA-07: Re-run without force reuses latest assessment**
   - Given: a completed quality step
   - When: `quality` runs again without force
   - Then: no duplicate assessment is created and the returned result references the existing assessment id.

8. **QA-08: Force re-run writes a new assessment version**
   - Given: a completed quality step
   - When: `quality --force` runs
   - Then: a new assessment row is created and becomes the latest assessment.

9. **QA-09: Unprocessable quality skips extract**
   - Given: a source with override quality `unusable` and path `skip`
   - When: extract or full pipeline runs after quality
   - Then: extract is recorded as skipped, no stories/artifacts are created, and the pipeline does not report a failure.

10. **QA-10: Processable quality propagates to stories**
    - Given: a source assessed as `medium` with path `enhanced_ocr`
    - When: extract creates stories
    - Then: source and story metadata contain `source_document_quality`, `extraction_path`, `extraction_confidence`, and `document_quality_assessment_id`.

11. **QA-11: CLI command runs one source and all eligible sources**
    - Given: one or more ingested sources
    - When: `mulder quality <source-id>` and `mulder quality --all` are run
    - Then: commands exit 0, write assessments, and print a concise status summary.

12. **QA-12: Default quality assessment never calls external services**
    - Given: default test config
    - When: quality runs for text, PDF, and image-like fixtures
    - Then: no Gemini, OCR API, LLM, embedding, or network service mock is invoked.

## 10. CLI Test Matrix

| Command | Scenario | Expected observable result |
|---------|----------|----------------------------|
| `mulder quality <source-id>` | Ingested text source | Exit 0; quality assessment row exists; source step is completed. |
| `mulder quality --force <source-id>` | Source with existing assessment | Exit 0; latest assessment id changes. |
| `mulder quality --all` | Multiple ingested sources | Exit 0; every eligible source has a latest assessment. |
| `mulder extract <source-id>` | Latest assessment recommends `skip` | Exit 0; extract is skipped and no stories are created. |
| `mulder pipeline <source-id> --up-to quality` | Full plan through quality | Exit 0; quality runs after ingest and before extract. |

## 11. Cost Considerations

K3 is intentionally deterministic database and local metadata work. It adds one table, one source-level pipeline step, config defaults, repository mapping, and small metadata propagation. It must not add paid service calls, bulk OCR, visual model calls, or network access. The migration has no expensive backfill by default, so rollout cost is bounded to schema creation and indexes.

