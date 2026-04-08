# Golden Test Set

Ground-truth annotations for evaluating pipeline quality. Each JSON file in a subdirectory represents a manually annotated document, page, or segment.

## Directories

- `extraction/` — Ground truth for extraction step (CER/WER metrics)
- `segmentation/` — Ground truth for segment boundaries (Boundary Accuracy, Segment Count)
- `entities/` — Ground truth for entity extraction (Precision/Recall/F1 per type)
- `retrieval/` — Ground truth for hybrid retrieval (Precision@k, Recall@k, MRR, nDCG@10)

## Annotation Formats

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
