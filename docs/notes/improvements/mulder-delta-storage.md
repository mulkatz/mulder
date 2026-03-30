# Mulder — Delta: Extraction Format + Storage Architecture

Aktualisiere README.md und CLAUDE.md mit der korrekten Extraction-Format-Strategie und Storage-Architektur. Das betrifft primär die CLAUDE.md (Key Patterns, Architecture) und sekundär die README.md (Architecture Overview).

---

## Extraction Format: NICHT Markdown als Zwischenformat

Die Pipeline nutzt drei verschiedene Formate an verschiedenen Stellen — nicht einheitlich Markdown:

1. **Extract → Document AI Structured JSON** — Rohformat mit Bounding Boxes, Leserichtung, Confidence Scores, Block-Typen pro Textfragment. Enthält die räumliche Information die für Magazine-Layout-Segmentierung kritisch ist ("dieser Block steht rechts oben neben einem Foto"). Wird in GCS archiviert als Source of Truth.

2. **Segment → Gemini bekommt Seiten als Images + das JSON** — Gemini sieht sowohl das visuelle Layout als auch den extrahierten Text. So kann es Story-Grenzen, Werbung, Bildunterschriften erkennen. Spatial-Information ist hier noch vollständig verfügbar.

3. **Output pro Segment → Markdown + Metadata JSON** — Sobald eine Story als zusammenhängende Einheit identifiziert ist, wird ihr Text als Markdown gespeichert (Überschriften als `#`, Absätze getrennt, Fettdruck erhalten). Das ist das Format für Embed, Enrich und Graph. Dazu ein separates, schlankes Metadata-JSON.

Kernregel: **Markdown ist das Endformat pro Story, NICHT das Zwischenformat zwischen OCR und Segmentierung.**

---

## Storage Architecture: Content in GCS, Referenzen in DB

Kein Markdown oder Langtext in Datenbank-Spalten. Klare Trennung:

### Cloud Storage — alle Content-Artefakte

```
gs://mulder-{project}/
├── raw/                          # Original PDFs (immutable)
│   └── {doc-id}.pdf
├── extracted/                    # Document AI JSON (spatial, archival)
│   └── {doc-id}/
│       ├── layout.json           # Vollständiges Layout Parser Ergebnis
│       └── pages/                # Seiten als Images (für Gemini Segment-Step)
│           ├── page-001.png
│           └── page-002.png
├── segments/                     # Pro Story: Markdown + Metadata getrennt
│   └── {doc-id}/
│       ├── {segment-id}.md       # Reiner Story-Text als Markdown
│       └── {segment-id}.meta.json # Schlankes Metadata-JSON (kein Content)
└── taxonomy/                     # Auto-generierte + kurierte Taxonomy
    ├── taxonomy.auto.yaml
    └── taxonomy.curated.yaml
```

### Cloud SQL — Referenzen + Suchindex

```sql
-- segments: Referenzen, kein Content
id, document_id, title, language, category,
page_start, page_end,
gcs_markdown_uri,     -- gs://... Pfad zum Markdown
gcs_metadata_uri,     -- gs://... Pfad zum Metadata JSON
chunk_count, extraction_confidence,
created_at

-- chunks: Kurzer Chunk-Text inline (ok weil ~512 tokens)
id, segment_id, chunk_index,
content TEXT,         -- Chunk-Text inline (kurz)
embedding VECTOR(768),
tsvector_content TSVECTOR
```

Begründung: `chunks.content` ist inline weil Chunks klein sind (~512 Tokens) und direkt für Retrieval gebraucht werden (Vector Search + BM25 in einer Query). Der volle Story-Markdown (kann mehrere Seiten sein) liegt nur in GCS und wird bei Bedarf geladen (z.B. für RAG-Antwort mit vollem Kontext).

### Metadata JSON pro Segment — schlank, kein Content

```json
{
  "id": "seg-abc123",
  "document_id": "doc-xyz",
  "title": "...",
  "author": "...",
  "language": "de",
  "category": "sighting_report",
  "pages": [12, 13, 14],
  "date_references": ["1987-03-15"],
  "geographic_references": ["Bodensee", "Konstanz"],
  "extraction_confidence": 0.92,
  "canonical_entities": ["loc:bodensee", "loc:konstanz"]
}
```

Kein Markdown, kein extrahierter Text — nur strukturierte Metadaten.

---

## Änderungen an CLAUDE.md

**"Key Patterns"** — Ergänze:
- Extraction liefert Document AI Structured JSON (spatial), NICHT Markdown. Markdown ist das Endformat pro Segment nach der Segmentierung.
- Content-Artefakte (PDFs, Layout JSON, Seiten-Images, Story Markdown) leben in GCS, nicht in der Datenbank
- Cloud SQL speichert nur Referenzen (GCS URIs) und den Suchindex (kurze Chunk-Texte + Embeddings + tsvector)
- GCS-Bucket-Struktur: `raw/` → `extracted/` → `segments/` → `taxonomy/`
- Segment Metadata JSON ist schlank (kein Content), Story Markdown ist separat

**"Pipeline Steps"** — Aktualisiere den Extract-Step:
- Extract: Document AI Layout Parser → Structured JSON mit Bounding Boxes + Seiten-Images → GCS (`extracted/`)

**"Pipeline Steps"** — Aktualisiere den Segment-Step:
- Segment: Gemini bekommt Seiten als Images + Layout JSON → identifiziert Stories → Output: Markdown + Metadata JSON pro Segment → GCS (`segments/`)

**"Architecture Decisions"** oder neuer Abschnitt **"Storage Architecture"**:
- GCS Bucket-Struktur dokumentieren
- Cloud SQL Schema-Prinzip: Referenzen + Suchindex, kein Content
- Chunks inline (kurz), Segment-Markdown in GCS (lang)

## Änderungen an README.md

**"Architecture Overview"** — Erwähne kurz dass die Pipeline drei Formate nutzt (Structured JSON → Images+JSON → Markdown) und dass Content in Cloud Storage lebt, nicht in der Datenbank. Ein Satz reicht.
