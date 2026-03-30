# Mulder — Delta: 5 weitere Architektur-Features

Aktualisiere README.md und CLAUDE.md mit den folgenden 5 Features. Drei davon sind Core-Design (ohne sie ist das System kaputt oder fundamental eingeschränkt), zwei sind Phase-2-Features die aber bereits im Design berücksichtigt werden müssen.

---

## Core-Design Features (müssen sofort rein)

### 8. Cross-Lingual Entity Resolution

Ohne dieses Feature ist der Knowledge Graph bei mehrsprachigen Corpora fragmentiert. "München", "Munich", "Monaco di Baviera", "Мюнхен" werden als vier verschiedene Entities im Graph modelliert obwohl sie dieselbe Stadt sind. Das zerstört Corroboration Scores, Cluster-Analyse und jede Form von Cross-Referencing.

Die Resolution funktioniert sprachunabhängig auf drei Ebenen:

**Ebene 1 — Attribut-Match** (deterministisch): Entities mit identischen normalisierten Attributen (GPS-Koordinaten, ISO-Datum, Wikidata-ID) werden gemerged. Das Grounding liefert diese Attribute. Funktioniert für jede Sprache die Google Search abdeckt.

**Ebene 2 — Embedding-Similarity** (statistisch): Entity-Namen werden via gemini-embedding-001 embedded und verglichen. Das Modell unterstützt 100+ Sprachen im selben semantischen Raum — "München" und "Munich" liegen bereits nah beieinander. Über einem konfigurierbaren Schwellenwert → Merge-Kandidat.

**Ebene 3 — LLM-Assisted** (semantisch): Gemini bekommt Kandidatenpaare und entscheidet ob sie dieselbe Entity sind. Funktioniert sprachunabhängig — Gemini versteht 40+ Sprachen produktionsreif und erkennt Entitäten in noch mehr.

Die **Taxonomy wird zum sprachübergreifenden Anker**. Kanonische Einträge haben keine Sprache — sie haben eine ID und Varianten in beliebig vielen Sprachen:

```yaml
# In taxonomy (auto-generated + curated)
loc:munich:
  canonical: "Munich"
  wikidata: "Q1726"
  coordinates: [48.1351, 11.5820]
  variants:
    de: ["München"]
    en: ["Munich"]
    it: ["Monaco di Baviera"]
    ru: ["Мюнхен"]
    ja: ["ミュンヘン"]
    # Wachsen automatisch mit jedem neuen Dokument in jeder Sprache
```

Config-Auswirkung — `supported_locales` steuert nur UI und Prompt-Sprache, nicht die Entity Resolution:

```yaml
project:
  supported_locales: ["de", "en"]  # Primärsprachen der Dokumente / UI
  # Entity Resolution + Taxonomy funktionieren für ALLE Sprachen automatisch

entity_resolution:
  strategies:
    - type: "attribute_match"       # Deterministic: coordinates, dates, IDs
      enabled: true
    - type: "embedding_similarity"  # Statistical: gemini-embedding-001
      enabled: true
      threshold: 0.85
    - type: "llm_assisted"          # Semantic: Gemini decides
      enabled: true
      model: "gemini-2.5-flash"
  cross_lingual: true               # Immer true — sprachübergreifend ist default
```

Praktische Limitierung: Grounding-Qualität hängt von Google Search ab — für seltene Sprachen weniger Webdaten zum Anreichern. Die Resolution selbst (Erkennen dass zwei Entities dasselbe beschreiben) funktioniert für alles was Gemini versteht.

### 9. Deduplizierung / Near-Duplicate Detection

Ohne Deduplizierung sind Corroboration Scores wertlos. Wenn derselbe Artikel in drei Ausgaben nachgedruckt wird, zählt das System drei unabhängige Quellen — ist aber nur eine. Bei Magazinen passiert das ständig: Nachdrucke, aktualisierte Versionen, Zusammenfassungen älterer Berichte.

Zwei Ebenen:

**Document/Segment-Level Dedup**: Erkennt identische oder fast identische Texte. Ansatz: MinHash/SimHash auf Chunk-Embeddings. Ergebnis: `DUPLICATE_OF`-Edge im Graph mit Similarity-Score. Duplikate werden nicht gelöscht sondern markiert — der Originaltext bleibt erhalten, wird aber bei Corroboration nicht doppelt gezählt.

**Semantic Dedup für Corroboration**: Unterscheidung zwischen "gleicher Text nachgedruckt" (= eine Quelle) und "verschiedene Autoren berichten unabhängig über dasselbe Event" (= echte Corroboration). Signale: gleicher Autor, identische Textpassagen, gleiche Quelle → eine Quelle. Verschiedene Autoren, unterschiedliche Formulierungen, unterschiedliche Details → echte Corroboration.

Config:
```yaml
deduplication:
  enabled: true
  segment_level:
    strategy: "minhash"          # minhash | embedding_similarity
    similarity_threshold: 0.90   # Ab wann near-duplicate
  corroboration_filter:
    same_author_is_one_source: true
    similarity_above_threshold_is_one_source: true  # Near-dupes zählen nicht doppelt
```

Neuer Edge-Typ im Graph: `DUPLICATE_OF` mit Attributen `similarity_score`, `duplicate_type` (exact | near | reprint | summary).

### 10. Schema Evolution / Reprocessing Strategy

Ohne dieses Feature ist das Projekt nach der ersten Config-Änderung kaputt. Bei 200+ Dokumenten kann man nicht alles von vorn starten wenn ein Entity-Typ hinzukommt oder die Taxonomy erweitert wird.

Lösung: Jeder Pipeline-Step speichert die Config-Version mit der er gelaufen ist. Bei Config-Änderung berechnet ein Diff welche Steps für welche Dokumente neu laufen müssen.

Reprocessing-Matrix:
- **Ontology-Änderung** (neuer Entity-Typ, neues Relationship) → Enrich + Ground + Graph + Analyze re-run. Extract und Segment bleiben.
- **Taxonomy erweitert** → Nur Normalisierung (Teil von Enrich) + Graph re-run.
- **Retrieval-Config geändert** (Gewichtungen, Re-Ranker) → Kein Reprocessing, wirkt sofort bei Queries.
- **Evidence-Config geändert** → Nur Analyze re-run.
- **Extraction-Config geändert** (z.B. layout_complexity) → Volle Re-Extraction nötig.

Tracking pro Dokument:
```json
// In Firestore: documents/{doc-id}/processing
{
  "config_hash": "sha256:abc123...",
  "steps": {
    "extract": { "config_hash": "sha256:...", "completed_at": "...", "version": "v1" },
    "segment": { "config_hash": "sha256:...", "completed_at": "...", "version": "v1" },
    "enrich":  { "config_hash": "sha256:...", "completed_at": "...", "version": "v2" },
    "ground":  { "config_hash": "sha256:...", "completed_at": "...", "version": "v1" },
    "embed":   { "config_hash": "sha256:...", "completed_at": "...", "version": "v1" },
    "graph":   { "config_hash": "sha256:...", "completed_at": "...", "version": "v2" }
  }
}
```

CLI-Integration:
```bash
npx mulder reprocess --dry-run    # Zeigt was neu laufen müsste
npx mulder reprocess              # Führt selektives Reprocessing durch
npx mulder reprocess --step enrich  # Nur einen Step forcieren
```

Neuer CLI-Command: `cli/commands/reprocess.ts`

---

## Phase-2-Features (im Design berücksichtigen, Implementierung später)

### 11. Visuelle Intelligenz (Phase 2)

Aktuell extrahiert die Pipeline Text und wirft sämtliche visuelle Information weg. Aber in Magazinen sind Fotos, Skizzen, Diagramme, Karten selbst Daten. Eine Handskizze ist Information. Ein Foto mit Bildunterschrift ist eine Quelle. Eine Karte mit eingezeichneten Punkten enthält geospatiale Daten die im Text nicht stehen.

Geplante Funktionsweise (Phase 2):
- Im Segment-Step: Document AI erkennt Bild-Regionen auf Seiten
- Bilder werden einzeln extrahiert und in GCS gespeichert (`segments/{doc-id}/{segment-id}/images/`)
- Gemini analysiert jedes Bild: Beschreibung, erkennbare Entities, bei Karten/Diagrammen strukturierte Datenextraktion
- Bild-Beschreibungen werden als eigene Entity-Quelle in den Graph eingespeist
- Bildunterschriften (aus dem Text extrahiert) werden mit dem Bild verknüpft
- Bilder bekommen eigene Embeddings (Gemini multimodal) für visuelle Ähnlichkeitssuche

Config (vorbereitet aber noch nicht implementiert):
```yaml
visual_intelligence:
  enabled: false  # Phase 2
  extract_images: true
  analyze_images: true
  image_embedding: true
  extract_from_maps: true      # Versuche Geo-Daten aus Karten zu extrahieren
  extract_from_diagrams: true  # Versuche strukturierte Daten aus Diagrammen
```

GCS-Struktur vorbereiten:
```
segments/{doc-id}/{segment-id}/
├── content.md
├── meta.json
└── images/              # Phase 2
    ├── img-001.png
    └── img-001.meta.json  # Gemini-Beschreibung, extrahierte Entities
```

Design-Impact jetzt: Die GCS-Struktur und das Segment-Datenmodell müssen Images schon berücksichtigen (Platz für `images/` Verzeichnis, optionales `image_count` Feld). Der Graph braucht einen `Image`-Node-Typ in Reserve.

### 12. Proaktive Pattern Discovery (Phase 2)

Aktuell ist das System rein reaktiv — jemand fragt, bekommt eine Antwort. Ein Research-Graph sollte von sich aus interessante Muster aufzeigen.

Geplante Funktionsweise (Phase 2):
- Läuft als Substep von Analyze nach jedem Batch
- **Cluster-Anomalien**: Neue Locations/Entities die plötzlich gehäuft auftauchen
- **Temporal Spikes**: Ungewöhnliche Häufung bestimmter Phänomene in Zeitfenstern
- **Unverbundene Subgraphen**: Ähnliche aber nicht verbundene Entity-Cluster die zusammenhängen könnten
- **High-Impact Pending**: Entities mit hohem Corroboration-Potenzial die noch nicht angereichert/verifiziert sind
- Ergebnisse als `insights` in Firestore, surfaced über API-Endpoint und optional als periodischer Digest

Config (vorbereitet aber noch nicht implementiert):
```yaml
pattern_discovery:
  enabled: false  # Phase 2
  run_after_batch: true
  anomaly_detection: true
  temporal_spikes: true
  subgraph_similarity: true
  digest:
    enabled: false
    frequency: "weekly"
```

Design-Impact jetzt: Firestore braucht eine `insights`-Collection in Reserve. Die API braucht einen Platzhalter-Endpoint `routes/insights.ts`. Der Analyze-Step muss erweiterbar designed sein.

---

## Aktualisierte Gesamtübersicht: 12 Capabilities

Core (implementiert in Phase 1):
1. Complex Layout Extraction
2. Config-Driven Domain Ontology
3. Domain Taxonomy mit automatischer Normalisierung
4. Hybrid Retrieval mit LLM Re-Ranking
5. Web Grounding / Enrichment
6. Spatio-Temporale Analyse
7. Evidenzbewertung und Widerspruchserkennung
8. Cross-Lingual Entity Resolution
9. Deduplizierung / Near-Duplicate Detection
10. Schema Evolution / Reprocessing

Phase 2 (im Design berücksichtigt):
11. Visuelle Intelligenz
12. Proaktive Pattern Discovery

---

## Änderungen an README.md

**Core Capabilities Section**: Von 7 auf 10 Core Capabilities erweitern. Die drei neuen (Cross-Lingual Entity Resolution, Deduplizierung, Schema Evolution) jeweils mit 1-2 Sätzen. Erwähne die 2 Phase-2-Features als "Planned" am Ende der Liste.

**Configuration Example**: Ergänze `entity_resolution` und `deduplication` Blöcke im YAML-Beispiel.

## Änderungen an CLAUDE.md

**Capabilities**: Von 7 auf 10 Core + 2 Phase-2 erweitern mit jeweils 2-3 Bullet Points WHAT + HOW:
- Cross-Lingual Entity Resolution: 3-Ebenen-Strategie, Taxonomy als sprachübergreifender Anker, alle Sprachen supported
- Deduplizierung: MinHash/SimHash + Corroboration-Filter, DUPLICATE_OF edge, near-dupes nicht doppelt zählen
- Schema Evolution: Config-Hash pro Step pro Dokument, Reprocessing-Matrix, `npx mulder reprocess` CLI
- Visuelle Intelligenz: (Phase 2) Bild-Extraktion, Gemini-Analyse, Image-Embeddings, Karten/Diagramm-Parsing
- Proaktive Pattern Discovery: (Phase 2) Cluster-Anomalien, Temporal Spikes, Subgraph-Similarity, Insights API

**Pipeline Steps**: Step 4 (Enrich) erweitern um "Cross-Lingual Entity Resolution". Neuer optionaler Substep in Step 7 (Graph): "Deduplizierung, DUPLICATE_OF edges".

**Key Patterns** — Ergänze:
- Entity Resolution ist sprachunabhängig — `supported_locales` steuert nur UI/Prompts, nicht die Resolution
- Taxonomy-Einträge haben keine Sprache, sondern eine ID mit Varianten in beliebig vielen Sprachen
- Deduplizierung passiert VOR Corroboration Scoring — near-dupes werden markiert aber nicht gelöscht
- Jeder Pipeline-Step tracked seinen Config-Hash — selektives Reprocessing bei Config-Änderungen
- Phase-2-Features (Visual Intelligence, Pattern Discovery) sind im Datenmodell bereits berücksichtigt (GCS-Struktur, Firestore Collections, Graph-Node-Typen)

**Repo Structure** — Ergänze:
- `src/pipeline/analyze/` enthält auch Platzhalter für Pattern Discovery
- `cli/commands/reprocess.ts`
- Firestore: `insights`-Collection (reserved für Phase 2)

**GCS Bucket Structure** — Aktualisiere:
```
segments/{doc-id}/{segment-id}/
├── content.md
├── meta.json
└── images/              # Phase 2, Verzeichnis wird schon angelegt
```
