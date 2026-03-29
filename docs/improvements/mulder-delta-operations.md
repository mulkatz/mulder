# mulder — Delta: Operational Architecture

Aktualisiere README.md und CLAUDE.md mit den folgenden 6 operativen Architektur-Themen. Diese sind keine Features im Sinne von Capabilities — sie sind die Engineering-Grundlage ohne die das Projekt nicht entwickelbar, nicht testbar und nicht sicher betreibbar ist. Alle 6 müssen vor dem ersten echten Pipeline-Code existieren, entweder als Implementierung oder als verbindliches Design in CLAUDE.md.

---

## 1. Local Development — Dev-Mode ohne GCP-Kosten

### Problem
Document AI und Gemini haben kein lokales Äquivalent. Ohne eine Local Dev Story kostet jede Iteration Geld und Zeit (API-Latenz). Bei ~8 Pipeline-Steps die alle GCP-Services aufrufen ist das ein Entwicklungs-Blocker.

### Lösung: Fixture-basierter Dev-Mode

**`fixtures/`-Verzeichnis** im Repo mit echten, eingecheckten Artefakten aus einem einmaligen GCP-Run gegen ein kleines Test-Corpus (3-5 Seiten aus verschiedenen Layout-Komplexitäten):

```
fixtures/
├── raw/                           # 2-3 Test-PDFs (public domain oder selbst erstellt)
│   ├── simple-layout.pdf
│   ├── complex-magazine.pdf
│   └── mixed-language.pdf
├── extracted/                     # Echte Document AI Layout Parser Outputs
│   ├── simple-layout/
│   │   └── layout.json
│   └── complex-magazine/
│       ├── layout.json
│       └── pages/
│           ├── page-001.png
│           └── page-002.png
├── segments/                      # Echte Gemini Segmentation Outputs
│   └── complex-magazine/
│       ├── seg-001.md
│       ├── seg-001.meta.json
│       ├── seg-002.md
│       └── seg-002.meta.json
├── entities/                      # Echte Gemini Entity Extraction Outputs
│   └── seg-001.entities.json
├── embeddings/                    # Echte gemini-embedding-001 Outputs
│   └── seg-001.embeddings.json
└── grounding/                     # Echte Gemini Search Grounding Outputs
    └── loc-munich.grounding.json
```

**Service-Abstraktionsschicht** — Jeder GCP-Service wird hinter einem Interface aufgerufen. Im Dev-Mode liefert eine lokale Implementierung Fixture-Daten zurück:

```typescript
// src/shared/services.ts
export interface DocumentExtractor {
  extract(gcsUri: string): Promise<LayoutResult>;
}

// src/shared/services.dev.ts — Dev-Mode: liest aus fixtures/
export class FixtureDocumentExtractor implements DocumentExtractor {
  async extract(gcsUri: string): Promise<LayoutResult> {
    const fixturePath = mapGcsUriToFixture(gcsUri);
    return JSON.parse(await readFile(fixturePath, 'utf-8'));
  }
}

// src/shared/services.gcp.ts — Production: echte GCP-Calls
export class GcpDocumentExtractor implements DocumentExtractor {
  async extract(gcsUri: string): Promise<LayoutResult> {
    return this.documentAiClient.processDocument({ ... });
  }
}
```

**Service-Registry** wählt basierend auf `NODE_ENV` oder Config-Flag:

```typescript
// src/shared/registry.ts
export function createServices(config: MulderConfig): Services {
  if (config.dev_mode || process.env.NODE_ENV === 'development') {
    return createDevServices(config);   // Fixtures
  }
  return createGcpServices(config);     // Echte GCP-Calls
}
```

**Lokale Infrastruktur** via docker-compose:
- PostgreSQL mit pgvector + PostGIS Extension (ersetzt Cloud SQL)
- Firestore Emulator (offizielles Google Image)
- Kein Spanner-Emulator verfügbar → Graph-Queries im Dev-Mode als SQL-Fallback gegen PostgreSQL (simuliert Budget-Tier)

```yaml
# docker-compose.yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    # + PostGIS via Dockerfile oder Init-Script
    ports: ["5432:5432"]
  firestore:
    image: google/cloud-sdk
    command: gcloud emulators firestore start --host-port=0.0.0.0:8080
    ports: ["8080:8080"]
```

Config:
```yaml
# mulder.config.yaml
dev_mode: false  # true → Fixtures + lokale DB, keine GCP-Calls
```

**CLI-Command zum Generieren neuer Fixtures** aus echten GCP-Calls:
```bash
npx mulder fixtures generate --input ./test-pdfs/ --output ./fixtures/
# Führt die echte Pipeline einmalig aus und speichert alle Zwischenergebnisse
```

Neuer CLI-Command: `cli/commands/fixtures.ts`

---

## 2. Pipeline-Fehlerbehandlung — Partielle Verarbeitung, kein Datenverlust

### Problem
Bei 200+ Dokumenten × 8 Pipeline-Steps werden Fehler passieren: OCR schlägt auf einzelnen Seiten fehl, Gemini halluziniert bei der Segmentierung, Grounding hat Timeouts, Embedding-API wird gedrosselt. Ohne eine klare Strategie hat man nach dem ersten Batch-Run Dutzende halb-verarbeitete Dokumente ohne zu wissen wo sie stehen.

### Lösung: Per-Step Status-Tracking + Dead Letter Queue + partielle Ergebnisse

**Granulares Status-Tracking** in Firestore pro Dokument und pro Step:

```typescript
// Firestore: documents/{doc-id}
interface DocumentProcessingState {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'partial' | 'failed';
  steps: {
    [step: string]: {
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
      config_hash: string;
      started_at?: Timestamp;
      completed_at?: Timestamp;
      error?: {
        code: string;         // z.B. 'EXTRACTION_LOW_CONFIDENCE', 'GEMINI_TIMEOUT'
        message: string;
        page?: number;        // Bei welcher Seite der Fehler auftrat
        retries: number;
      };
      metrics?: {
        pages_processed?: number;
        entities_extracted?: number;
        duration_ms?: number;
      };
    };
  };
}
```

**Partielle Ergebnisse werden erhalten.** Wenn Extract für 95 von 100 Seiten klappt und 5 fehlschlagen:
- Die 95 erfolgreichen Seiten werden in GCS gespeichert
- Der Step wird als `partial` markiert mit Liste der fehlgeschlagenen Seiten
- Der Segment-Step kann auf den 95 Seiten laufen (best-effort)
- Die 5 fehlgeschlagenen Seiten können einzeln re-tried werden

**Dead Letter Queue** via Pub/Sub DLQ-Topic. Nachrichten die nach `max_attempts` Retries immer noch fehlschlagen landen in `docgraph-dlq`. Von dort aus manuell inspizierbar und re-processable:
```bash
npx mulder status --failed          # Zeige alle Dokumente mit fehlgeschlagenen Steps
npx mulder retry --document {id}    # Retry fehlgeschlagene Steps für ein Dokument
npx mulder retry --step enrich      # Retry den Enrich-Step für alle fehlgeschlagenen Dokumente
```

**Retry-Logik** mit exponential Backoff ist Teil der Service-Abstraktionsschicht, nicht der Pipeline-Steps. Jeder GCP-Client wrapped seine Calls automatisch:

```typescript
// src/shared/retry.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  // Exponential backoff mit Jitter
  // Unterscheidung: retryable (429, 503, timeout) vs. fatal (400, 404)
  // Logging jedes Retry-Versuchs
}
```

Config:
```yaml
pipeline:
  retry:
    max_attempts: 3
    backoff_base_ms: 1000
    backoff_max_ms: 30000
  error_handling:
    partial_results: true          # Partielle Ergebnisse erhalten
    continue_on_page_error: true   # Einzelne Seiten-Fehler brechen nicht das ganze Dokument ab
```

Neuer CLI-Command: `cli/commands/retry.ts`
Neues Pub/Sub-Topic in Terraform: `mulder-dlq`

---

## 3. API-Quota-Management — Rate Limiting gegen GCP Throttling

### Problem
Document AI, Gemini, Embedding API — alle haben Rate Limits (Requests/Minute, Tokens/Minute). Eine naive Pipeline die 20.000 Seiten gleichzeitig an Document AI feuert wird sofort gedrosselt. Ohne Quota-Management bekommt man kaskierende 429-Fehler die die Retry-Logik überlasten.

### Lösung: Zentrale Rate-Limiter-Klasse + konfigurierbare Concurrency

**Zentraler Rate Limiter** in `src/shared/rate-limiter.ts`:
- Token-Bucket-Algorithmus pro GCP-Service
- Konfigurierbare Limits aus `mulder.config.yaml`
- Automatisches Backoff wenn 429-Responses kommen
- Metrics: aktuelle Auslastung, Queue-Tiefe, Wartezeiten

```typescript
// src/shared/rate-limiter.ts
export class RateLimiter {
  constructor(private config: ConcurrencyConfig) {}

  async acquire(service: 'document_ai' | 'gemini' | 'embeddings'): Promise<ReleaseFunction> {
    // Wartet bis ein Slot frei ist
    // Respektiert sowohl concurrency (parallele Calls) als auch rate (Calls/Minute)
  }
}
```

**Jeder GCP-Service-Client nutzt den Rate Limiter** automatisch über die Service-Registry:

```typescript
// src/shared/services.gcp.ts
export class GcpGeminiClient implements LlmService {
  constructor(private rateLimiter: RateLimiter) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const release = await this.rateLimiter.acquire('gemini');
    try {
      return await this.vertexClient.generateContent(request);
    } finally {
      release();
    }
  }
}
```

**Cloud Run Jobs Parallelität** wird über die Config gesteuert. Das Terraform-Modul setzt die `--tasks` und `--parallelism` Flags:

```yaml
pipeline:
  concurrency:
    document_ai: 5        # Max parallele Document AI Batch-Requests
    gemini: 10             # Max parallele Gemini-Calls
    embeddings: 20         # Max parallele Embedding-Batches (die sind schnell)
    grounding: 3           # Max parallele Search Grounding Calls (konservativ)
  batch_size:
    extract: 10            # Dokumente pro Cloud Run Job Task
    segment: 5             # Dokumente pro Task (Gemini-intensiv)
    embed: 50              # Segmente pro Embedding-Batch-Call
```

---

## 4. Evaluierung / Quality Framework — Wissen ob die Pipeline funktioniert

### Problem
Ohne Evaluierung fliegst du blind. Du verarbeitest 200+ Magazine und hast keine Möglichkeit zu wissen ob die Extraktion, Segmentierung oder Entity-Erkennung gut ist. Jede Änderung an Prompts, Config oder Modell-Version könnte die Qualität verschlechtern ohne dass es jemand merkt.

### Lösung: Golden Test Set + Eval-Metriken + CLI-Command

**Golden Test Set** in `eval/golden/`:
- 5-10 manuell annotierte Seiten/Dokumente die schwierige Fälle abdecken
- Pro Seite: Ground-Truth-Text, korrekte Segment-Grenzen, erwartete Entities
- Verschiedene Schwierigkeitsgrade: einfaches Layout, Multi-Column, Text über Bild, gemischte Sprachen

```
eval/
├── golden/
│   ├── page-simple-de.json        # Ground truth für einfache deutsche Seite
│   ├── page-complex-magazine.json # Ground truth für komplexes Magazine-Layout
│   ├── page-mixed-language.json   # Ground truth für DE+EN gemischt
│   ├── segments-magazine.json     # Erwartete Segment-Grenzen für ein Test-Magazin
│   └── entities-article.json      # Erwartete Entities für einen Test-Artikel
├── metrics/                       # Eval-Ergebnisse (gitignored, aber Baseline eingecheckt)
│   └── baseline.json              # Ergebnis des initialen Eval-Runs
└── run-eval.ts                    # Eval-Script
```

**Metriken pro Pipeline-Step**:

| Step | Metriken |
|------|----------|
| Extract | Character Error Rate (CER), Word Error Rate (WER) gegen Ground Truth |
| Segment | Boundary Accuracy (Start/End-Seiten korrekt?), Segment Count Accuracy |
| Enrich | Entity Extraction Precision, Recall, F1 pro Entity-Typ |
| Ground | Enrichment Coverage (% Entities mit Grounding-Ergebnis), Coordinate Accuracy |
| Embed | Retrieval Accuracy (relevante Chunks in Top-K für Test-Queries?) |
| Graph | Relationship Accuracy, Cross-Lingual Merge Precision |

**CLI-Command**:
```bash
npx mulder eval                    # Voller Eval-Run gegen Golden Set
npx mulder eval --step extract     # Nur Extraction evaluieren
npx mulder eval --compare baseline # Vergleich gegen eingecheckte Baseline
npx mulder eval --update-baseline  # Aktuelle Ergebnisse als neue Baseline speichern
```

Output als strukturiertes JSON + menschenlesbare Zusammenfassung:
```
Extraction Quality:
  CER:  3.2% (baseline: 3.5%) ✓ improved
  WER:  8.1% (baseline: 7.9%) ⚠ slightly worse

Segmentation Quality:
  Boundary Accuracy: 91% (baseline: 89%) ✓ improved
  Segment Count:     exact in 8/10 documents

Entity Extraction:
  Location Precision: 94%  Recall: 87%  F1: 90.4%
  Person Precision:   88%  Recall: 72%  F1: 79.2%
  ...
```

**Eval muss vor dem ersten Batch-Run existieren** — nicht als Nachgedanke. Die ersten 5-10 Golden Pages werden manuell erstellt, danach kann die Coverage inkrementell wachsen.

Neues Verzeichnis: `eval/`
Neuer CLI-Command: `cli/commands/eval.ts`

---

## 5. Cold Start / Sparse Graph — Graceful Degradation bei wenig Daten

### Problem
Bei 5 verarbeiteten Dokumenten ist die Taxonomy fast leer, Corroboration Scores sind bedeutungslos, der Graph zu dünn für Community Detection, Hybrid Retrieval hat kaum Daten. Features die nicht sinnvoll funktionieren dürfen nicht so tun als ob sie funktionieren.

### Lösung: Feature-Activation-Thresholds + ehrliche Confidence-Angaben

Jedes Feature hat einen **Mindest-Datenmenge-Schwellenwert** ab dem es aktiviert wird. Unterhalb des Schwellenwerts degradiert es graceful:

```yaml
thresholds:
  taxonomy_bootstrap: 25           # Dokumente bis Taxonomy-Bootstrap startet
  corroboration_meaningful: 50     # Dokumente bis Corroboration Scores > "insufficient data"
  graph_community_detection: 100   # Entities bis Community Detection sinnvoll ist
  temporal_clustering: 30          # Events mit Timestamps bis Clustering sinnvoll ist
  source_reliability: 50           # Dokumente bis PageRank stabil ist
  pattern_discovery: 100           # Dokumente bis Anomalie-Detection sinnvoll ist (Phase 2)
```

**Degradation pro Feature**:
- **Taxonomy** < Schwellenwert: Entities werden extrahiert aber nicht normalisiert. Rohe Entity-Namen im Graph.
- **Corroboration** < Schwellenwert: Score wird als `null` / `"insufficient_data"` zurückgegeben, nicht als `1`.
- **Hybrid Retrieval** mit wenig Daten: Fällt auf reinen Vector Search zurück. BM25 und Graph-Expansion bleiben aktiv aber mit ehrlicher Confidence ("graph expansion returned 0 additional results").
- **Evidence Chains** < Schwellenwert: Feature deaktiviert, API-Endpoint gibt `501 Not Yet Available` mit Erklärung.

**In jeder API-Response**: Ein `confidence` Objekt das angibt wie aussagekräftig die Ergebnisse sind:

```json
{
  "results": [...],
  "confidence": {
    "corpus_size": 12,
    "taxonomy_status": "bootstrapping",     // "bootstrapping" | "active" | "mature"
    "corroboration_reliability": "low",     // "insufficient" | "low" | "moderate" | "high"
    "graph_density": 0.03                   // Edges/Nodes ratio
  }
}
```

---

## 6. Cost Safety — Schutz vor versehentlichen Kosten

### Problem
Ein Bug oder ein versehentliches Full-Reprocessing aller 200+ Dokumente erzeugt ~$50 in Gemini-Calls. Bei größerem Corpus schnell mehr. CI/CD Pipelines die Tests mit echten API-Calls fahren können Kosten erzeugen.

### Lösung: Budget Alerts + Cost Estimation + Hard Limits

**Terraform-Modul für Budget Alerts** auf dem GCP-Projekt:

```hcl
# terraform/modules/budget/main.tf
resource "google_billing_budget" "mulder" {
  billing_account = var.billing_account
  display_name    = "mulder-${var.project_name}"
  amount {
    specified_amount {
      currency_code = "USD"
      units         = var.monthly_budget_usd
    }
  }
  threshold_rules {
    threshold_percent = 0.5   # Alert bei 50%
  }
  threshold_rules {
    threshold_percent = 0.9   # Alert bei 90%
  }
}
```

**Cost Estimation** vor teuren Operationen:

```bash
npx mulder ingest ./pdfs/ --cost-estimate
# ┌─────────────────────────────────────────────┐
# │ Cost Estimate for 217 documents (est. 21,700 pages)
# ├─────────────────────────────────────────────┤
# │ Extract (Document AI):    ~$32.55
# │ Segment (Gemini Flash):   ~$12.00
# │ Enrich  (Gemini Flash):   ~$4.50
# │ Ground  (Search Grounding): ~$3.00
# │ Embed   (Embeddings):     ~$2.10
# │ ─────────────────────────────────────────────
# │ Total estimated:          ~$54.15
# └─────────────────────────────────────────────┘
# Proceed? [y/N]

npx mulder reprocess --cost-estimate --dry-run
# Shows which documents need reprocessing + estimated cost
```

**Hard Limits** in der Config:

```yaml
safety:
  max_pages_without_confirm: 500     # Über 500 Seiten: CLI fragt nach Bestätigung
  max_cost_without_confirm_usd: 20   # Über $20 geschätzt: CLI fragt nach Bestätigung
  budget_alert_monthly_usd: 100      # GCP Budget Alert Schwellenwert
  block_production_calls_in_test: true # In NODE_ENV=test: GCP-Calls blockiert, Fixture-Mode erzwungen
```

**Test-Safety**: Wenn `NODE_ENV=test`, werden echte GCP-Calls nicht nur umgangen sondern aktiv geblockt. Die Service-Registry wirft einen Fehler wenn im Test-Mode ein echter GCP-Client instanziiert wird. Das verhindert dass CI/CD versehentlich Kosten erzeugt.

---

## Zusammenfassung der Änderungen

### Neue Verzeichnisse
```
mulder/
├── fixtures/              # Vorverarbeitete GCP-Artefakte für Dev-Mode
│   ├── raw/
│   ├── extracted/
│   ├── segments/
│   ├── entities/
│   ├── embeddings/
│   └── grounding/
├── eval/                  # Quality Framework
│   ├── golden/            # Ground-Truth-Annotationen
│   └── metrics/           # Eval-Ergebnisse
└── ...
```

### Neue CLI-Commands
- `cli/commands/fixtures.ts` — Generiert Fixtures aus echtem GCP-Run
- `cli/commands/eval.ts` — Evaluiert Pipeline-Qualität gegen Golden Set
- `cli/commands/retry.ts` — Retry fehlgeschlagener Pipeline-Steps

### Neue src/ Module
- `src/shared/rate-limiter.ts` — Zentraler Token-Bucket Rate Limiter
- `src/shared/retry.ts` — Retry mit exponential Backoff + Jitter
- `src/shared/registry.ts` — Service-Registry (Dev vs. GCP-Mode)
- `src/shared/services.ts` — Service-Interfaces
- `src/shared/services.dev.ts` — Fixture-basierte Dev-Implementierungen
- `src/shared/services.gcp.ts` — Echte GCP-Implementierungen
- `src/shared/cost-estimator.ts` — Kostenschätzung für Pipeline-Operationen

### Neues Terraform-Modul
- `terraform/modules/budget/` — GCP Billing Budget Alerts

### Neue Pub/Sub Topics (Terraform)
- `mulder-dlq` — Dead Letter Queue für fehlgeschlagene Pipeline-Messages

---

## Änderungen an CLAUDE.md

### Neuer Abschnitt: "Local Development"
```markdown
## Local Development

- `dev_mode: true` in config oder `NODE_ENV=development` → keine GCP-Calls
- `fixtures/` enthält echte GCP-Artefakte für jeden Pipeline-Step
- Service-Interfaces in `src/shared/services.ts`, Dev-Implementierung in `services.dev.ts`, GCP in `services.gcp.ts`
- Service-Registry in `src/shared/registry.ts` wählt basierend auf Mode
- docker-compose: PostgreSQL (pgvector + PostGIS) + Firestore Emulator
- Kein Spanner-Emulator → Dev-Mode simuliert Budget-Tier (SQL statt Graph)
- `npx mulder fixtures generate` erzeugt Fixtures aus echtem GCP-Run
- `NODE_ENV=test` blockiert aktiv alle echten GCP-Calls (Safety)
```

### Neuer Abschnitt: "Error Handling"
```markdown
## Error Handling

- Per-Dokument, per-Step Status-Tracking in Firestore (`documents/{id}`)
- States: pending | running | completed | partial | failed | skipped
- Partielle Ergebnisse werden erhalten (95 von 100 Seiten OK → 95 Seiten in GCS)
- Dead Letter Queue: Pub/Sub DLQ Topic `mulder-dlq`
- Retry: exponential backoff mit Jitter, retryable (429, 503) vs. fatal (400, 404)
- Retry-Logik in `src/shared/retry.ts`, nicht in Pipeline-Steps
- CLI: `npx mulder status --failed`, `npx mulder retry --document {id}`
```

### Neuer Abschnitt: "Rate Limiting & Quotas"
```markdown
## Rate Limiting & Quotas

- Zentraler Rate Limiter in `src/shared/rate-limiter.ts` (Token Bucket)
- Jeder GCP-Client nutzt Rate Limiter via Service-Registry
- Concurrency + Batch-Size konfigurierbar in `pipeline.concurrency` und `pipeline.batch_size`
- Automatisches Backoff bei 429-Responses
```

### Neuer Abschnitt: "Quality Evaluation"
```markdown
## Quality Evaluation

- Golden test set in `eval/golden/` — manuell annotierte Ground Truth
- Metriken: CER/WER (Extract), Boundary Accuracy (Segment), Precision/Recall/F1 (Enrich)
- `npx mulder eval` gegen Golden Set, `--compare baseline` für Regression Detection
- Baseline eingecheckt in `eval/metrics/baseline.json`
```

### Neuer Abschnitt: "Cost Safety"
```markdown
## Cost Safety

- `safety.max_pages_without_confirm` — CLI Bestätigung bei großen Batches
- `safety.max_cost_without_confirm_usd` — CLI Bestätigung bei geschätzten Kosten über Schwellenwert  
- `--cost-estimate` Flag auf ingest/reprocess Commands
- Terraform Budget Alert Modul in `terraform/modules/budget/`
- `NODE_ENV=test` blockiert echte GCP-Calls (throw, nicht fallback)
```

### Key Patterns — Ergänze:
- Alle GCP-Services hinter Interfaces, Dev-Mode liefert Fixtures, GCP-Mode echte Calls
- Service-Registry als zentrale Factory, nie direkt GCP-Clients instanziieren
- Rate Limiting ist transparent — Pipeline-Steps wissen nichts davon
- Partielle Ergebnisse sind ein Feature, kein Bug — 95% Verarbeitung ist besser als 0%
- Cost Estimation vor jeder teuren Operation, Hard Limits in Config
- Golden Test Set existiert ab Tag 1, wächst inkrementell

### Repo Structure — Ergänze:
```
fixtures/           # Dev-Mode GCP-Artefakte
eval/               # Quality Framework + Golden Set
  golden/
  metrics/
src/shared/
  rate-limiter.ts
  retry.ts
  registry.ts
  services.ts
  services.dev.ts
  services.gcp.ts
  cost-estimator.ts
terraform/modules/
  budget/
```

### Cold Start / Sparse Graph — Ergänze in Key Patterns oder neuer Abschnitt:
```markdown
## Sparse Graph Handling

- Features haben Mindest-Datenmenge-Schwellenwerte (konfigurierbar in `thresholds`)
- Unter Schwellenwert: Feature degradiert graceful, gibt `null` / `"insufficient_data"` zurück
- API-Responses enthalten `confidence` Objekt mit corpus_size, taxonomy_status, graph_density
- Taxonomy Bootstrap erst ab Schwellenwert, davor: rohe Entity-Namen im Graph
- Retrieval fällt bei wenig Daten auf reinen Vector Search zurück
```

---

## Änderungen an README.md

### Architecture Overview — Ergänze:
Ein Absatz über die Entwicklungserfahrung: Fixture-basierter Dev-Mode ermöglicht Entwicklung ohne GCP-Kosten, docker-compose für lokale Infrastruktur, `npx mulder eval` für Quality Checks.

### Neuer Abschnitt "Development" (nach Quick Start, vor Configuration):
```markdown
## Development

mulder ships with a fixture-based dev mode that requires no GCP credentials or API calls.
Every GCP service is abstracted behind an interface — in dev mode, pre-recorded API
responses from `fixtures/` are served instead. Local infrastructure runs via docker-compose
(PostgreSQL with pgvector/PostGIS + Firestore Emulator). A quality evaluation framework
with manually annotated golden test pages ensures extraction accuracy is measurable from
day one.
```

### Configuration Example — Ergänze die neuen Config-Blöcke:
- `pipeline.concurrency` und `pipeline.retry` im YAML-Beispiel zeigen
- `safety` Block zeigen
- `thresholds` Block zeigen (oder zumindest erwähnen)
