# Golden Test Set

Ground-truth annotations for evaluating pipeline quality. Each JSON file in a subdirectory represents a manually annotated document, page, or segment.

## Directories

- `extraction/` — Ground truth for extraction step (CER/WER metrics)
- `segmentation/` — Ground truth for segment boundaries (Boundary Accuracy, Segment Count)
- `entities/` — Ground truth for entity extraction (Precision/Recall/F1 per type)
- `quality-routing/` — Ground truth for document quality routing and extraction gate behavior
- `assertions/` — Ground truth for assertion classification labels and confidence metadata
- `retrieval/` — Ground truth for hybrid retrieval (Precision@k, Recall@k, MRR, nDCG@10)
- `multi-format/` — Deterministic M9 black-box manifest for source type, route, story, skip, and duplicate contracts

## Annotation Formats

### Quality Routing (`quality-routing/*.json`)

```json
{
  "caseId": "string — stable case identifier",
  "sourceSlug": "string — matches fixtures/quality-routing/{slug or case}.json",
  "difficulty": "simple | moderate | complex",
  "expected": {
    "overallQuality": "high | medium | low | unusable",
    "processable": "boolean",
    "recommendedPath": "standard | enhanced_ocr | visual_extraction | handwriting_recognition | manual_transcription_required | skip",
    "extractionGateOutcome": "allow | skip",
    "qualityMetadata": {
      "source_document_quality": "high | medium | low",
      "extraction_path": "same value as recommendedPath",
      "extraction_confidence": "number from 0.0 to 1.0"
    },
    "signals": {
      "signal_name": "generic expected signal value"
    }
  },
  "annotation": {
    "author": "string",
    "date": "string — ISO date",
    "notes": "string (optional)"
  }
}
```

Rules:

1. Cover all quality values (`high`, `medium`, `low`, `unusable`) in the checked-in set.
2. Keep signals generic and observable; do not encode domain policy or production internals.
3. Fixtures in `fixtures/quality-routing/` mirror the quality assessment, extraction gate outcome, and propagated metadata.
4. Mismatches are reported by field path; runners do not call live OCR, LLM, storage, or database services.

### Assertion Classification (`assertions/*.json`)

```json
{
  "caseId": "string — stable case identifier",
  "segmentId": "string — stable segment identifier",
  "sourceSlug": "string — source document slug for context",
  "difficulty": "simple | moderate | complex",
  "expected": {
    "content": "string — assertion text",
    "assertionType": "observation | interpretation | hypothesis",
    "classificationProvenance": "llm_auto | human_reviewed | author_explicit",
    "confidenceMetadata": {
      "witness_count": "number or null",
      "measurement_based": "boolean",
      "contemporaneous": "boolean",
      "corroborated": "boolean",
      "peer_reviewed": "boolean",
      "author_is_interpreter": "boolean"
    },
    "entityNames": ["string (optional)"],
    "qualityMetadata": "object (optional)"
  },
  "annotation": {
    "author": "string",
    "date": "string — ISO date",
    "notes": "string (optional)"
  }
}
```

Rules:

1. Cover all assertion types (`observation`, `interpretation`, `hypothesis`) in the checked-in set.
2. Every golden case must include complete confidence metadata.
3. Fixtures in `fixtures/assertions/` mirror extracted assertion output plus optional persisted metadata.
4. Classification examples must stay domain-agnostic; use generic document, review, or process examples.

### Multi-Format (`multi-format/manifest.json`)

The multi-format manifest is not model output annotation. It is a curated
fixture index used by the Spec 97 Vitest harness to prove every supported M9
source type enters the same source/story/status model.

```json
{
  "schema_version": 1,
  "cases": [
    {
      "id": "string — stable case identifier",
      "source_type": "pdf | image | text | docx | spreadsheet | email | url",
      "fixture_kind": "committed_file | generated_png | generated_markdown | generated_docx | generated_xlsx | generated_eml | local_http_url",
      "fixture_ref": "string (optional) — committed path or local HTTP route",
      "expected_filename": "string — filename persisted by ingest",
      "expected_route": "layout | prestructured",
      "expected_story_min": "number — minimum story rows after extract",
      "expected_metadata_keys": ["format_metadata keys required on sources"]
    }
  ],
  "duplicate_scenario": {
    "id": "string — stable duplicate case identifier",
    "first": { "fixture_kind": "string", "expected_filename": "string" },
    "second": { "fixture_kind": "string", "expected_filename": "string" },
    "expected_source_type": "text",
    "expected_duplicate_basis": "text_content"
  }
}
```

Rules:

1. Keep exactly one primary case per supported M9 source type.
2. Prefer deterministic generated fixtures for DOCX, XLSX, email, text, image, and local URL cases.
3. Reuse committed PDFs when they already exercise the layout path.
4. Do not commit binary golden files solely for this manifest unless a future spec explicitly requires them.
5. Expected metadata keys should be stable contract keys, not incidental parser diagnostics.

### Extraction (`extraction/*.json`)

```json
{
  "sourceSlug": "string — matches fixtures/extracted/{slug}/",
  "pageNumber": "number — 1-indexed page number",
  "difficulty": "simple | moderate | complex",
  "languages": ["array of ISO language codes present on the page"],
  "expectedText": "string — ideal extraction output in reading order",
  "expectedBlockCount": "number (optional) — expected layout block count",
  "annotation": {
    "author": "string — who created this annotation",
    "date": "string — ISO date",
    "notes": "string (optional) — context about the page"
  }
}
```

### Segmentation (`segmentation/*.json`)

```json
{
  "sourceSlug": "string — matches fixtures/segments/{slug}/",
  "totalPages": "number — total page count of the document",
  "difficulty": "simple | moderate | complex",
  "expectedSegmentCount": "number — how many stories the document contains",
  "expectedSegments": [
    {
      "title": "string — story title for matching",
      "pageStart": "number — first page (1-indexed)",
      "pageEnd": "number — last page (1-indexed)",
      "category": "string — story category"
    }
  ],
  "annotation": {
    "author": "string — who created this annotation",
    "date": "string — ISO date",
    "notes": "string (optional) — context about the document"
  }
}
```

### Entities (`entities/*.json`)

```json
{
  "segmentId": "string — matches fixtures/entities/{segmentId}.entities.json",
  "sourceSlug": "string — source document slug for context",
  "difficulty": "simple | moderate | complex",
  "languages": ["array of ISO language codes in the story"],
  "expectedEntities": [
    {
      "name": "string — entity name",
      "type": "string — entity type (person, location, organization, event, document)",
      "attributes": "object (optional) — key attributes to verify"
    }
  ],
  "expectedRelationships": [
    {
      "sourceEntity": "string — source entity name",
      "targetEntity": "string — target entity name",
      "relationshipType": "string — relationship type from ontology"
    }
  ],
  "annotation": {
    "author": "string — who created this annotation",
    "date": "string — ISO date",
    "notes": "string (optional) — context about the article"
  }
}
```

### Retrieval (`retrieval/*.json`)

```json
{
  "queryId": "string — stable identifier used for reporting",
  "queryText": "string — natural-language query passed verbatim to hybridRetrieve",
  "language": "de | en",
  "queryType": "factual | exploratory | relational | negative",
  "difficulty": "simple | moderate | complex",
  "expectedHits": [
    {
      "contentContains": "string — substring that uniquely identifies the expected chunk",
      "storyTitle": "string (optional) — disambiguation hint",
      "relevance": "primary | secondary | tangential"
    }
  ],
  "expectedEntities": ["string (optional) — entities the orchestrator should extract from the query"],
  "annotation": {
    "author": "string",
    "date": "string — ISO date",
    "notes": "string (optional) — rationale / category"
  }
}
```

Matching is **case-insensitive substring match** on chunk content — generated
chunk IDs change between runs, so content-based matching is the only robust
option. The three relevance levels use gains `{primary: 3, secondary: 2,
tangential: 1}` for nDCG computation. Negative queries have
`expectedHits: []` and are satisfied only when the system returns no results.

## Difficulty Levels

- **simple** — single-column, native PDF text, clean extraction expected; single-story documents; straightforward entity extraction
- **moderate** — scanned pages, mixed languages, typical OCR challenges; mixed content types; moderate entity density
- **complex** — multi-column layouts, tables, reading order ambiguity; multi-story magazines; high entity density, all entity types, cross-lingual content

## Adding New Golden Annotations

1. Create a golden JSON file in the appropriate subdirectory
2. Create matching fixture files:
   - Extraction: `fixtures/extracted/{slug}/layout.json`
   - Segmentation: `fixtures/segments/{slug}/*.meta.json`
   - Entities: `fixtures/entities/{segmentId}.entities.json`
3. Run the eval to generate updated metrics
4. Update the baseline if the new annotation is intentional: check in `eval/metrics/baseline.json`
