---
spec: 31
title: "Golden Test Set: Segmentation + Entities"
roadmap_step: M3-C10
functional_spec: ["§15.1", "§15.2"]
scope: single
issue: https://github.com/mulkatz/mulder/issues/65
created: 2026-04-03
---

# 1. Objective

Extend the existing eval package (`packages/eval/`) with golden annotations and metrics for **segmentation** (Boundary Accuracy, Segment Count Accuracy) and **entity extraction** (Precision, Recall, F1 per entity type). Create ground-truth annotations for test documents covering the five ontology entity types (person, location, organization, event, document), plus expected segment boundaries. Implement metric computations, eval runners, and Vitest assertions that compare pipeline output against golden annotations. Establish a checked-in baseline for regression detection.

This builds directly on spec 21 (Golden Test Set: Extraction), which established the eval package, CER/WER metrics, and the `eval/golden/extraction/` directory.

# 2. Boundaries

**In scope:**
- `eval/golden/segmentation/` — ground truth JSON files for segment boundaries
- `eval/golden/entities/` — ground truth JSON files for entity extraction
- `packages/eval/src/segmentation-metrics.ts` — Boundary Accuracy + Segment Count metrics
- `packages/eval/src/entity-metrics.ts` — Precision/Recall/F1 per entity type
- `packages/eval/src/segmentation-runner.ts` — load golden segmentation set, compare, produce results
- `packages/eval/src/entity-runner.ts` — load golden entity set, compare, produce results
- Extended types in `packages/eval/src/types.ts`
- Synthetic fixtures in `fixtures/segments/` and `fixtures/entities/`
- Updated `eval/metrics/baseline.json` with segmentation + entity sections
- Updated `eval/golden/README.md` documenting new annotation formats
- Vitest test file asserting metric quality against golden set

**Out of scope:**
- `mulder eval` CLI command (M8-I1)
- Embedding retrieval accuracy (M4)
- Graph relationship accuracy (M4)
- Grounding metrics (M6)
- Real Gemini / Document AI calls — golden annotations are hand-crafted

**Commands in scope:** None (library-only, no CLI)

# 3. Dependencies

**Requires (must exist):**
- `packages/eval/` — eval package with types, errors, extraction metrics (spec 21, exists)
- `packages/pipeline/src/segment/types.ts` — `SegmentedStory`, `SegmentationData` (exists)
- `packages/pipeline/src/enrich/types.ts` — `ExtractedEntity`, `ExtractedRelationship` (exists)
- `mulder.config.yaml` — ontology entity types: person, location, organization, event, document (exists)
- `fixtures/segments/_schema.json`, `fixtures/entities/_schema.json` — structure definitions (exist)

**Required by (future steps):**
- M8-I1 — `mulder eval` CLI (wraps all eval runners)

# 4. Blueprint

## 4.1 File Plan

### New files

| File | Purpose | Mirrors |
|------|---------|---------|
| `packages/eval/src/segmentation-metrics.ts` | Boundary Accuracy + Segment Count computation | `extraction-metrics.ts` |
| `packages/eval/src/entity-metrics.ts` | Precision, Recall, F1 per entity type | `extraction-metrics.ts` |
| `packages/eval/src/segmentation-runner.ts` | Load golden segmentation set, compare against fixture output | `eval-runner.ts` |
| `packages/eval/src/entity-runner.ts` | Load golden entity set, compare against fixture output | `eval-runner.ts` |
| `eval/golden/segmentation/magazine-issue-1.json` | Ground truth: multi-story magazine issue (3+ stories) |
| `eval/golden/segmentation/single-story-report.json` | Ground truth: single-story document |
| `eval/golden/segmentation/mixed-content-issue.json` | Ground truth: mixed content (editorial + news + sighting) |
| `eval/golden/entities/sighting-report-article.json` | Ground truth: entities from a sighting report |
| `eval/golden/entities/investigation-article.json` | Ground truth: entities from an investigation article |
| `eval/golden/entities/editorial-article.json` | Ground truth: entities from an editorial |
| `eval/golden/entities/multi-entity-article.json` | Ground truth: article with all 5 entity types |
| `eval/golden/entities/cross-lingual-article.json` | Ground truth: entities from DE+EN mixed article |
| `fixtures/segments/magazine-issue-1/seg-001.md` | Synthetic segment Markdown |
| `fixtures/segments/magazine-issue-1/seg-001.meta.json` | Synthetic segment metadata |
| `fixtures/segments/magazine-issue-1/seg-002.md` | Synthetic segment Markdown |
| `fixtures/segments/magazine-issue-1/seg-002.meta.json` | Synthetic segment metadata |
| `fixtures/segments/magazine-issue-1/seg-003.md` | Synthetic segment Markdown |
| `fixtures/segments/magazine-issue-1/seg-003.meta.json` | Synthetic segment metadata |
| `fixtures/segments/single-story-report/seg-001.md` | Synthetic segment Markdown |
| `fixtures/segments/single-story-report/seg-001.meta.json` | Synthetic segment metadata |
| `fixtures/segments/mixed-content-issue/seg-001.md` | Synthetic segment Markdown |
| `fixtures/segments/mixed-content-issue/seg-001.meta.json` | Synthetic segment metadata |
| `fixtures/segments/mixed-content-issue/seg-002.md` | Synthetic segment Markdown |
| `fixtures/segments/mixed-content-issue/seg-002.meta.json` | Synthetic segment metadata |
| `fixtures/entities/seg-001.entities.json` | Synthetic entity extraction output |
| `fixtures/entities/seg-002.entities.json` | Synthetic entity extraction output |
| `fixtures/entities/seg-003.entities.json` | Synthetic entity extraction output |
| `fixtures/entities/seg-004.entities.json` | Synthetic entity extraction output |
| `fixtures/entities/seg-005.entities.json` | Synthetic entity extraction output |

### Modified files

| File | Change |
|------|--------|
| `packages/eval/src/types.ts` | Add segmentation + entity golden types, metric result types, eval result types |
| `packages/eval/src/errors.ts` | Add error codes for segmentation/entity eval |
| `packages/eval/src/index.ts` | Export new modules |
| `eval/golden/README.md` | Document segmentation + entity annotation formats |
| `eval/metrics/baseline.json` | Add segmentation + entity baseline sections |

## 4.2 Types (`packages/eval/src/types.ts` — additions)

```typescript
// ────────────────────────────────────────────────────────────
// Segmentation golden annotations
// ────────────────────────────────────────────────────────────

/** Expected segment boundary for a single story. */
export interface ExpectedSegment {
  /** Story title (for matching against actual output). */
  title: string;
  /** First page number (1-indexed). */
  pageStart: number;
  /** Last page number (1-indexed). */
  pageEnd: number;
  /** Story category. */
  category: string;
}

/** Ground truth annotation for segmentation of a document. */
export interface SegmentationGolden {
  /** Reference to source fixture (slug matches fixtures/segments/{slug}/). */
  sourceSlug: string;
  /** Total page count of the document. */
  totalPages: number;
  /** Difficulty level for reporting. */
  difficulty: DifficultyLevel;
  /** Expected number of segments. */
  expectedSegmentCount: number;
  /** Expected segment boundaries. */
  expectedSegments: ExpectedSegment[];
  /** Annotation metadata. */
  annotation: {
    author: string;
    date: string;
    notes?: string;
  };
}

/** Segmentation metric result for a single document. */
export interface SegmentationMetricResult {
  sourceSlug: string;
  difficulty: string;
  /** 1.0 = all boundaries exact, 0.0 = all wrong. */
  boundaryAccuracy: number;
  /** Whether actual count matches expected count. */
  segmentCountExact: boolean;
  /** Actual segment count. */
  actualSegmentCount: number;
  /** Expected segment count. */
  expectedSegmentCount: number;
}

/** Aggregate segmentation eval results. */
export interface SegmentationEvalResult {
  timestamp: string;
  documents: SegmentationMetricResult[];
  summary: {
    totalDocuments: number;
    avgBoundaryAccuracy: number;
    segmentCountExactRatio: number;
    byDifficulty: Record<string, { avgBoundaryAccuracy: number; count: number }>;
  };
}

// ────────────────────────────────────────────────────────────
// Entity golden annotations
// ────────────────────────────────────────────────────────────

/** Expected entity in a golden annotation. */
export interface ExpectedEntity {
  /** Entity name. */
  name: string;
  /** Entity type from ontology (person, location, organization, event, document). */
  type: string;
  /** Key attributes to verify (subset — not all attributes need matching). */
  attributes?: Record<string, unknown>;
}

/** Expected relationship in a golden annotation. */
export interface ExpectedRelationship {
  sourceEntity: string;
  targetEntity: string;
  relationshipType: string;
}

/** Ground truth annotation for entity extraction from a story. */
export interface EntityGolden {
  /** Segment ID (matches fixtures/entities/{segmentId}.entities.json). */
  segmentId: string;
  /** Source slug for context. */
  sourceSlug: string;
  /** Difficulty level for reporting. */
  difficulty: DifficultyLevel;
  /** Languages in the source story. */
  languages: string[];
  /** Expected entities. */
  expectedEntities: ExpectedEntity[];
  /** Expected relationships. */
  expectedRelationships: ExpectedRelationship[];
  /** Annotation metadata. */
  annotation: {
    author: string;
    date: string;
    notes?: string;
  };
}

/** Entity metric result for a single story/segment. */
export interface EntityMetricResult {
  segmentId: string;
  sourceSlug: string;
  difficulty: string;
  /** Per entity type: precision, recall, F1. */
  byType: Record<string, { precision: number; recall: number; f1: number }>;
  /** Aggregate across all types. */
  overall: { precision: number; recall: number; f1: number };
  /** Relationship metrics. */
  relationships: { precision: number; recall: number; f1: number };
}

/** Aggregate entity eval results. */
export interface EntityEvalResult {
  timestamp: string;
  segments: EntityMetricResult[];
  summary: {
    totalSegments: number;
    /** Per entity type averaged across all segments. */
    byType: Record<string, { avgPrecision: number; avgRecall: number; avgF1: number; count: number }>;
    /** Overall averaged across all segments. */
    overall: { avgPrecision: number; avgRecall: number; avgF1: number };
    /** Relationship metrics averaged. */
    relationships: { avgPrecision: number; avgRecall: number; avgF1: number };
    byDifficulty: Record<string, { avgF1: number; count: number }>;
  };
}
```

## 4.3 Segmentation Metrics (`packages/eval/src/segmentation-metrics.ts`)

```
computeBoundaryAccuracy(expected: ExpectedSegment[], actual: ActualSegment[]): number
  → Match expected segments to actual by best overlap (page range intersection)
  → For each matched pair: score = 1.0 if pageStart AND pageEnd match exactly, 0.5 if one matches, 0.0 if neither
  → Return average score across all expected segments
  → If no expected segments, return 1.0
  → Unmatched expected segments score 0.0

ActualSegment = { title: string; pageStart: number; pageEnd: number; category: string }
  → Parsed from fixtures/segments/{slug}/*.meta.json files

loadActualSegments(segmentsDir: string, sourceSlug: string): ActualSegment[]
  → Read all *.meta.json from segmentsDir/{sourceSlug}/
  → Parse and return sorted by pageStart
```

## 4.4 Entity Metrics (`packages/eval/src/entity-metrics.ts`)

```
computeEntityPrecisionRecallF1(expected: ExpectedEntity[], actual: ExtractedEntity[]): PerTypeMetrics
  → Group expected and actual by type
  → For each type:
    → Match by name (case-insensitive, whitespace-normalized)
    → Precision = matched / actual count
    → Recall = matched / expected count
    → F1 = 2 * (P * R) / (P + R), or 0.0 if P + R = 0
  → Overall = micro-average across all types

computeRelationshipPrecisionRecallF1(expected: ExpectedRelationship[], actual: ExtractedRelationship[]): PRF1
  → Match by (sourceEntity, targetEntity, relationshipType) tuple
  → Entity name matching is case-insensitive, whitespace-normalized
  → Precision = matched / actual count
  → Recall = matched / expected count
  → F1 = 2 * (P * R) / (P + R)

normalizeEntityName(name: string): string
  → Lowercase, collapse whitespace, trim
```

## 4.5 Segmentation Runner (`packages/eval/src/segmentation-runner.ts`)

```
loadSegmentationGoldenSet(goldenDir: string): SegmentationGolden[]
  → Read all *.json from goldenDir
  → Validate required fields: sourceSlug, totalPages, difficulty, expectedSegmentCount, expectedSegments, annotation
  → Return sorted by sourceSlug

runSegmentationEval(goldenDir: string, segmentsDir: string): SegmentationEvalResult
  → Load golden set
  → For each golden document:
    → Load actual segments from fixtures/segments/{sourceSlug}/
    → Compute boundary accuracy
    → Check segment count
  → Aggregate results
  → Return full eval result with summary
```

## 4.6 Entity Runner (`packages/eval/src/entity-runner.ts`)

```
loadEntityGoldenSet(goldenDir: string): EntityGolden[]
  → Read all *.json from goldenDir
  → Validate required fields: segmentId, sourceSlug, difficulty, languages, expectedEntities, expectedRelationships, annotation
  → Return sorted by segmentId

loadActualEntities(entitiesDir: string, segmentId: string): { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] }
  → Read fixtures/entities/{segmentId}.entities.json
  → Parse as ExtractionResponse

runEntityEval(goldenDir: string, entitiesDir: string): EntityEvalResult
  → Load golden set
  → For each golden segment:
    → Load actual entities
    → Compute per-type precision/recall/F1
    → Compute relationship precision/recall/F1
  → Aggregate results
  → Return full eval result with summary
```

## 4.7 Golden Annotations

### Segmentation golden (3 documents minimum)

1. **magazine-issue-1** — complex: 12-page magazine with 3 stories spanning multiple pages
2. **single-story-report** — simple: 4-page document containing exactly 1 story
3. **mixed-content-issue** — moderate: 8-page issue with editorial + sighting report (2 stories)

### Entity golden (5 segments minimum, covering all 5 entity types)

1. **sighting-report-article** — moderate: person, location, event entities + WITNESSED, OCCURRED_AT relationships
2. **investigation-article** — moderate: person, organization, event entities + INVESTIGATED, CLASSIFIED_BY relationships
3. **editorial-article** — simple: person, document entities + AUTHORED, REFERENCES relationships
4. **multi-entity-article** — complex: all 5 entity types, 6+ relationships
5. **cross-lingual-article** — complex: DE+EN mixed content, same entities in both languages

## 4.8 Synthetic Fixture Strategy

### Segment fixtures (`fixtures/segments/{slug}/`)

Each segment fixture consists of:
- `{segment-id}.md` — Story Markdown content
- `{segment-id}.meta.json` — Segment metadata with page boundaries, confidence, category

Meta JSON structure (matches `SegmentedStory` shape):
```json
{
  "id": "seg-001",
  "title": "Story Title",
  "subtitle": null,
  "language": "de",
  "category": "sighting_report",
  "pageStart": 1,
  "pageEnd": 4,
  "dateReferences": ["1987-06-15"],
  "geographicReferences": ["Munich"],
  "extractionConfidence": 0.92
}
```

### Entity fixtures (`fixtures/entities/`)

Each entity fixture is `{segment-id}.entities.json` matching `ExtractionResponse` shape:
```json
{
  "entities": [
    {
      "name": "Hans Weber",
      "type": "person",
      "confidence": 0.95,
      "attributes": { "role": "witness" },
      "mentions": ["Hans Weber", "Weber"]
    }
  ],
  "relationships": [
    {
      "source_entity": "Hans Weber",
      "target_entity": "Munich Sighting",
      "relationship_type": "WITNESSED",
      "confidence": 0.88
    }
  ]
}
```

Introduce realistic imperfections:
- Entity fixtures should include some **extra** entities not in golden (tests precision)
- Entity fixtures should **miss** some golden entities (tests recall)
- Some boundary fixtures should be off by 1 page (tests boundary accuracy < 1.0)

## 4.9 Baseline

`eval/metrics/baseline.json` is extended with `segmentation` and `entities` top-level keys alongside the existing `extraction` key. Structure matches `SegmentationEvalResult` and `EntityEvalResult` respectively.

## 4.10 Integration

- All new modules export from `packages/eval/src/index.ts`
- No runtime dependency on GCP — purely operates on local files
- No dependency on `packages/pipeline` for entity types — re-define a minimal `ActualSegment` and import `ExtractedEntity`/`ExtractedRelationship` from pipeline types (already a workspace dependency)

# 5. QA Contract

Tests file: `tests/specs/31_golden_test_set_segmentation_entities.test.ts`

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Segmentation golden directory exists | Repo checked out | `eval/golden/segmentation/` is listed | Directory exists with ≥3 JSON files |
| QA-02 | Segmentation golden files are valid | Golden JSON files exist | Each file is read and parsed | All files contain required fields: `sourceSlug`, `totalPages`, `difficulty`, `expectedSegmentCount`, `expectedSegments`, `annotation` |
| QA-03 | Segment fixtures exist | Segmentation golden pages reference source slugs | Check `fixtures/segments/{slug}/` for each golden document | Every golden document has ≥1 `.meta.json` fixture |
| QA-04 | Entity golden directory exists | Repo checked out | `eval/golden/entities/` is listed | Directory exists with ≥5 JSON files |
| QA-05 | Entity golden files are valid | Golden JSON files exist | Each file is read and parsed | All files contain required fields: `segmentId`, `sourceSlug`, `difficulty`, `languages`, `expectedEntities`, `expectedRelationships`, `annotation` |
| QA-06 | Entity fixtures exist | Entity golden files reference segment IDs | Check `fixtures/entities/{segmentId}.entities.json` for each golden segment | Every golden segment has a matching entity fixture |
| QA-07 | Boundary accuracy correct for exact match | Known segment boundaries | `computeBoundaryAccuracy(expected, actual)` with identical boundaries | Returns 1.0 |
| QA-08 | Boundary accuracy correct for partial mismatch | Known boundaries with one off-by-one | `computeBoundaryAccuracy(expected, actual)` with partial mismatch | Returns value between 0.0 and 1.0 (not 0.0, not 1.0) |
| QA-09 | Entity precision/recall/F1 correct | Known entity lists | `computeEntityPrecisionRecallF1(expected, actual)` | Returns expected precision, recall, and F1 values (deterministic) |
| QA-10 | Perfect entity match returns 1.0 | Identical entity lists | `computeEntityPrecisionRecallF1(entities, entities)` | Precision, recall, and F1 all equal 1.0 |
| QA-11 | Relationship metrics correct | Known relationship lists | `computeRelationshipPrecisionRecallF1(expected, actual)` | Returns expected precision, recall, F1 |
| QA-12 | Segmentation eval runner produces results | Segmentation golden set + fixtures exist | `runSegmentationEval()` is called | Returns `SegmentationEvalResult` with one entry per golden document and correct summary |
| QA-13 | Entity eval runner produces results | Entity golden set + fixtures exist | `runEntityEval()` is called | Returns `EntityEvalResult` with one entry per golden segment, per-type metrics, and summary |
| QA-14 | Baseline file includes segmentation + entity sections | Eval has been run | `eval/metrics/baseline.json` is read | Valid JSON with `segmentation` and `entities` keys, each containing valid result structures |
| QA-15 | Eval package builds | `packages/eval/` exists | `pnpm turbo run build --filter=@mulder/eval` | Build succeeds with no errors |
| QA-16 | All five entity types covered | Entity golden set loaded | Collect all entity types across golden files | At least one instance of each: person, location, organization, event, document |
| QA-17 | Difficulty coverage (segmentation) | Segmentation golden set loaded | Count documents by difficulty | At least 1 'simple', 1 'moderate', 1 'complex' |
| QA-18 | Difficulty coverage (entities) | Entity golden set loaded | Count segments by difficulty | At least 1 'simple', 1 'moderate', 1 'complex' |
