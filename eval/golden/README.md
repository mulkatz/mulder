# Golden Test Set

Ground-truth annotations for evaluating extraction quality. Each JSON file in a subdirectory represents a manually annotated page.

## Annotation Format

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

## Directories

- `extraction/` — Ground truth for extraction step (CER/WER metrics)
- Future: `segmentation/` — Ground truth for segment boundaries
- Future: `entities/` — Ground truth for entity extraction

## Adding New Golden Pages

1. Create a golden JSON file in the appropriate subdirectory
2. Create a matching `layout.json` fixture in `fixtures/extracted/{slug}/`
3. Run the eval to generate updated metrics
4. Update the baseline if the new page is intentional: check in `eval/metrics/baseline.json`

## Difficulty Levels

- **simple** — single-column, native PDF text, clean extraction expected
- **moderate** — scanned pages, mixed languages, typical OCR challenges
- **complex** — multi-column layouts, tables, reading order ambiguity
