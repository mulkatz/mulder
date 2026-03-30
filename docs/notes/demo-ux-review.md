# mulder Demo-App — Umfassende UX-Analyse

> **Datum:** 2026-03-27
> **Methode:** Playwright-basierte visuelle Inspektion aller Seiten + Code-Analyse
> **Screenshots:** `demo/review-screenshots/` (15 Screenshots aller Views)
> **Scope:** Alle 12 Seiten/Routes, 3 Evidence-Tabs, 2 Source-Views

---

## Zusammenfassung

Die mulder Demo-App ist **visuell ausgereift** — sauberes Layout, konsistentes Design-System, gute Typografie und Farbgebung. Die **Einzelseiten** sind jeweils gut gestaltet. Das Problem liegt in der **Verbindung zwischen den Seiten**: Die App fühlt sich an wie ein zusammengewürfelter Haufen an Funktionalität, der nicht nachvollziehbar zusammengreift.

### Die drei Kernprobleme

| # | Problem | Auswirkung |
|---|---------|-----------|
| 1 | **Fehlende Verlinkung** | Evidence, Graph und Board sind fast vollständig isolierte Inseln |
| 2 | **Fehlender Workflow-Fluss** | Keine "Was kommt als nächstes?"-Guidance nach Aktionen |
| 3 | **Inkonsistente Interaktionsmuster** | Gleiche UI-Elemente sind auf einer Seite klickbar, auf der nächsten nicht |

---

## A. Informationsarchitektur & Ablauf

### Das konzeptionelle Datenmodell

Die App folgt implizit dieser Hierarchie:

```
Upload → Quelle (Source) → Berichte (Stories) → Akteure (Entities) → Netzwerk (Graph)
                                                                          ↓
                                                            Beweislage (Evidence)
                                                                          ↓
                                                              Board (Synthese)
```

**Problem: Dieses Modell wird dem Benutzer nirgends explizit kommuniziert.** Es gibt keinen visuellen Prozess-Indikator, der zeigt, wo man sich im Untersuchungsworkflow befindet. Jede Seite präsentiert sich als eigenständige Insel.

### Der gedachte Benutzer-Workflow

Ein Investigator würde idealerweise diesem Pfad folgen:

1. **Quelle hochladen** (`/upload`) — PDF einreichen
2. **Verarbeitung überwachen** (`/` Dashboard) — Pipeline-Status prüfen
3. **Berichte prüfen** (`/sources/:id/review/:storyId`) — Extrahierte Inhalte validieren
4. **Berichte erkunden** (`/stories`) — Quer-Verbindungen finden
5. **Akteure verfolgen** (`/entities/:id`) — Personen/Orgs/Events nachschlagen
6. **Netzwerk analysieren** (`/graph`) — Verbindungen visualisieren
7. **Beweislage bewerten** (`/evidence`) — Widersprüche und Bestätigungen prüfen
8. **Synthese erstellen** (`/boards/:id`) — Erkenntnisse zusammenführen

**Die Anwendung unterstützt diesen Fluss derzeit nicht.** Es gibt kein "Was kommt als nächstes?" nach einem abgeschlossenen Schritt.

### Identifizierte Sackgassen

| Sackgasse | Ort | Problem |
|-----------|-----|---------|
| Nicht-verarbeitete Quellen | `/sources` Grid/Table | Klick auf nicht-verarbeitete Quelle scrollt nach oben (`#`), kein Feedback |
| Dashboard Buttons | KI-Entdeckungen | "Untersuchen", "Zum Board", "Verwerfen" ohne Funktion |
| Dashboard "Alle anzeigen" | Letzte Aktivität | Button ohne Ziel |
| Top-Akteure | Dashboard | EntityBadges nicht klickbar trotz visueller Affordanz |
| Graph Node-Click | `/graph` rechte Sidebar | "Show in Archive", "Add to Board" ohne Funktion |
| Graph Stories | `/graph` rechte Sidebar | Verwandte Berichte als `<div>`, nicht `<Link>` |
| Board-Karten | `/boards/1` | Keine Karte verlinkt zu Story/Entity/Source |
| Review Entity-Tabelle | `/sources/:id/review/:storyId` | Entity-Namen nicht verlinkt |
| Evidence komplett | `/evidence` alle 3 Tabs | Kein einziger Link zu referenzierten Berichten/Quellen |
| Review Inline-Entities | `/sources/:id/review/:storyId` | `<mark>` statt `<Link>` (anders als StoryDetail) |

---

## B. Seitenübergreifende Kohärenz

### Verlinkungsmatrix (Ist-Zustand)

| Von ↓ / Nach → | Sources | Stories | StoryDetail | EntityDetail | Graph | Evidence | Board |
|-----------------|---------|---------|-------------|-------------|-------|----------|-------|
| **Dashboard** | — | — | — | — | ja | — | — |
| **Sources** | — | — | — | — | — | — | — |
| **SourceDetail** | — | — | — | — | — | — | — |
| **Review** | ja(h) | — | — | — | — | — | — |
| **Stories** | — | — | ja | — | — | — | — |
| **StoryDetail** | ja(h) | ja | — | ja | ja | — | ja |
| **EntityDetail** | — | ja | — | — | ja | — | — |
| **Graph** | — | — | — | — | — | — | — |
| **Evidence** | — | — | — | — | — | — | — |
| **Board** | — | — | — | — | — | — | — |

*(h) = hardcoded auf `/sources/1`*

### Kritische Beobachtungen

1. **Evidence-Seite ist eine Isolations-Insel.** Referenziert Berichte und Quellen namentlich, aber kein einziger klickbarer Link. Der Benutzer sieht "Die Nächte von Rendlesham Forest" als Claim-Referenz, kann aber nicht darauf klicken.

2. **Graph-Seite ist eine Sackgasse.** Keine funktionierende Navigation heraus. Rechte Sidebar zeigt Stories als nicht-klickbare `<div>`s.

3. **Board ist komplett unverlinkt.** Keine Karte führt irgendwohin. Kein Weg vom Board zur zugrundeliegenden Quelle, zum Bericht oder zum Akteur.

4. **StoryDetail ist die einzige gut vernetzte Seite** — mit Links zu Entities, Source, Review, Graph, Board und verwandten Stories. Dieses Muster fehlt überall sonst.

5. **Hardcoded IDs überall.** Fast alle Cross-Page-Links verwenden `/sources/1` oder `/boards/1`. "Quell-PDF anzeigen" führt IMMER zum MUFON Journal, unabhängig welche Story man betrachtet.

---

## C. Probleme des konzeptionellen Modells

### Terminologie-Inkonsistenz: "Akteure"

"Akteure" als Übersetzung für "Entities" ist problematisch:
- **Akteure** suggeriert Personen und Organisationen
- Die Entity-Taxonomie umfasst aber auch **Ereignisse** und **Orte**
- "Akteur-Taxonomie" in Settings: Ein Ort ist kein "Akteur"
- Dashboard "Akteure: 2.156" zählt alle Entity-Typen

### Fehlende Seiten

| Fehlende Seite | Problem |
|----------------|---------|
| **`/entities` Liste** | Kein zentraler Einstiegspunkt für Entities. Nur über Umwege erreichbar. Breadcrumb "Akteure" führt ins Leere. |
| **`/boards` Liste** | Navigation verlinkt direkt auf `/boards/1`. Keine Board-Verwaltung. |

### Inkonsistente Entity-URLs

- EntityBadge-Links: `/entities/e1` (korrekte ID)
- StoryDetail Inline-Links: `/entities/david-fravor` (Name-basiert, bricht für alle außer e1)

---

## D. Detailanalyse pro Seite

### 1. Dashboard (`/`)

**Screenshot:** `01-dashboard.png`

| Kategorie | Finding |
|-----------|---------|
| Layout | Rechte Spalte wird abgeschnitten — KI-Entdeckungen und Top-Akteure bei < 1440px nicht sichtbar |
| Funktion | "Untersuchen", "Zum Board", "Verwerfen" Buttons ohne Funktionalität |
| Funktion | Top-Akteure: EntityBadges nicht klickbar |
| Sprache | `{processingQueue.length} items` — Englisch statt Deutsch |
| Sprache | `{discoveries.length} new` — Englisch statt Deutsch |
| Daten | Top-Akteure nach Array-Reihenfolge, nicht nach Erwähnungen sortiert |
| Konzept | Dashboard ist Status-Übersicht, kein Workflow-Einstiegspunkt. Fehlt: "Was sollte ich als nächstes tun?" |

### 2. Quellen-Bibliothek (`/sources`)

**Screenshots:** `02-sources-grid.png`, `03-sources-table.png`

| Kategorie | Finding |
|-----------|---------|
| Funktion | Klick auf nicht-verarbeitete Quelle: `#` → Scroll-nach-oben statt Fehlermeldung |
| Funktion | Nur `src1` korrekt verlinkt (`/sources/1`). Alle anderen → `/sources/srcX` → SourceDetail zeigt immer MUFON Journal |
| Design | Grid-Cover: 136px für dekorativen Farbverlauf, 80px für Informationen. Platzhalter-Ästhetik. |
| Design | Cover-Farben gebunden an Array-Index — wechseln bei Filterung |

### 3. Quellen-Detail (`/sources/1`)

**Screenshot:** `04-source-detail.png`

| Kategorie | Finding |
|-----------|---------|
| Funktion | Alle 3 Story-Links führen zu `/sources/1/review/1` — immer gleiche Review-Seite |
| Funktion | PDF-View komplett statisch — Story-Overlays nicht klickbar |
| Funktion | Breadcrumb "Quellen" nicht klickbar (kein Link zu `/sources`) |
| Konzept | Verbindung PDF ↔ Story nur visuell angedeutet, nicht interaktiv |

### 4. Review (`/sources/1/review/1`)

**Screenshot:** `05-review.png`

| Kategorie | Finding |
|-----------|---------|
| Funktion | Story-Navigation "Bericht 3 von 12" fest, Prev/Next ohne Funktion |
| Funktion | Konfidenz-Badge zeigt 0.72 statt Story-Konfidenz (0.95) |
| Funktion | Entity-Tabelle zeigt `entities.slice(0, 6)` — globale Entities, nicht Story-Entities |
| Funktion | Inline-Entities als `<mark>` statt `<Link>` (inkonsistent mit StoryDetail) |
| Funktion | Keyboard Shortcuts (Enter/S/F) nur visuell, nicht implementiert |
| Sprache | Entity-Tabelle Spaltenheader: "Type", "Confidence", "Status" — Englisch |
| Konzept | Herzstück des Workflows, fühlt sich aber statisch an. Kein Fortschritt, keine Historie. |

### 5. Berichte-Liste (`/stories`)

**Screenshot:** `06-stories-list.png`

| Kategorie | Finding |
|-----------|---------|
| Funktion | Filter-Checkboxen: `defaultChecked` ohne State-Management — nicht steuerbar |
| Funktion | Confidence-Slider ohne State-Binding |
| Funktion | "Nach Relevanz sortieren" ohne Funktion |
| Design | Story-Cards dehnen sich auf volle Breite — kein `max-w-*` |
| Design | Source-Filter zeigt nur 3 von 8+ Quellen |

### 6. Bericht-Detail (`/stories/:id`)

**Screenshot:** `07-story-detail.png`

**Stärken:**
- Am besten vernetzte Seite der App
- Related-Stories-Sidebar mit Similarity-Scores, AI-Reasoning, Cross-Document-Insight
- Entity-Badges klickbar, Inline-Highlights klickbar
- Action-Buttons zu Review, Graph, Board

| Kategorie | Finding |
|-----------|---------|
| Funktion | Inline-Entity-Links: `/entities/david-fravor` statt `/entities/e1` — bricht für alle außer e1 |
| Funktion | "Quell-PDF anzeigen" → immer `/sources/1` |
| Funktion | "In Prüfung öffnen" → immer `/sources/1/review/1` |
| Konzept | Related-Stories-Sidebar ist das **Muster**, das auf alle anderen Seiten übertragen werden sollte |

### 7. Akteur-Detail (`/entities/:id`)

**Screenshot:** `08-entity-detail.png`

**Stärken:**
- Connected-Entities-Sidebar mit Kookkurrenz-Stärke
- Merge-Candidates mit AI-Vorschlägen
- Stats-Grid informativ

| Kategorie | Finding |
|-----------|---------|
| Funktion | Breadcrumb "Akteure" nicht klickbar (kein Link, kein `/entities`-Route) |
| Funktion | Timeline-Daten synthetisch — Datum aus fester Liste, nicht aus Story-Inhalt |
| Daten | Merge-Candidates nur für e1, e2, e3 — alle anderen leer |

### 8. Netzwerk/Graph (`/graph`)

**Screenshot:** `09-graph.png`

| Kategorie | Finding |
|-----------|---------|
| **Kritisch** | `entities.slice(0, 16)` — nur 13 Personen + 3 Orgs. Events und Locations nicht sichtbar, obwohl Filter aktiv |
| Funktion | Layout-Buttons (Force/Hierarchical/Radial) ohne Funktion |
| Funktion | "Cluster", "New Discoveries" Buttons ohne Funktion |
| Funktion | Slider (Min-Connections, Time-Range) ohne State-Binding |
| Funktion | Rechte Sidebar: Stories nicht klickbar, Buttons funktionslos |
| Sprache | Massiver Sprachmix — fast alle Labels Englisch: "Find entity...", "Entity Types", "Graph Stats", "Nodes", "Edges", "Clusters", "Connected Entities", "Show in Archive", "Add to Board", "Force", "Hierarchical", "Radial" |
| Design | Positioning via Grid + Jitter, kein Force-Layout-Algorithmus. Nodes überlappen teilweise. |

### 9. Beweislage — Widersprüche (`/evidence` Tab 1)

**Screenshot:** `10-evidence-contradictions.png`

**Stärken:**
- Master-Detail-Split gut strukturiert
- Gemini-Analyse bietet echten Mehrwert
- Status-farbige Seitenränder visuell klar

| Kategorie | Finding |
|-----------|---------|
| **Kritisch** | Story-Titel und Quellen-Referenzen als reiner Text — nicht klickbar |
| Funktion | Confirm/Dismiss-Buttons ohne Funktion |

### 10. Beweislage — Bestätigungen (`/evidence` Tab 2)

**Screenshot:** `11-evidence-corroboration.png`

**Stärken:**
- Score-Bars (Bestätigung/Zuverlässigkeit/Beweiskette) mit erklärenden Beschreibungen
- Bestätigende Quellen mit Reliability-Scores

| Kategorie | Finding |
|-----------|---------|
| **Kritisch** | Quellen-Story-Titel nicht klickbar |
| Sprache | "Sort" Label — Englisch |

### 11. Beweislage — Raum-Zeit-Analyse (`/evidence` Tab 3)

**Screenshot:** `12-evidence-spatiotemporal.png`

| Kategorie | Finding |
|-----------|---------|
| Design | Karte ist vereinfachtes SVG mit Kreisen auf Raster — keine echte Geografie |
| Sprache | Entity-Type-Buttons: "person", "organization", "event", "location" — Englisch, lowercase |
| Stärke | Event-Liste mit Timeline-Clustern und Entity-Badges funktioniert gut |

### 12. Board (`/boards/1`)

**Screenshot:** `13-board.png`

| Kategorie | Finding |
|-----------|---------|
| Funktion | Cards positioniert aber nicht draggbar |
| Funktion | Alle Toolbar-Buttons funktionslos |
| **Kritisch** | Kein Link von Board-Karten zu Story/Entity/Source |
| Konzept | Soll Synthese-Schicht sein, kann aber nicht mit Daten befüllt werden |

### 13. Upload (`/upload`)

**Screenshot:** `14-upload.png`

**Stärken:**
- Multi-Stage-Workflow gut umgesetzt
- KI-Metadaten-Auto-Fill mit Animation überzeugend

| Kategorie | Finding |
|-----------|---------|
| Funktion | "Zurück zur Übersicht" → Dashboard statt Quellen-Bibliothek |
| Funktion | Nach Verarbeitungsstart kein Link zur neuen Quelle |

### 14. Einstellungen (`/settings`)

**Screenshot:** `15-settings.png`

**Stärken:**
- Gut strukturiert mit 5 Tabs
- KI-Kontext-Tab mit Prompt-Editor — starkes Feature
- mulder.config.yaml Preview verbindet UI mit Konfiguration

| Kategorie | Finding |
|-----------|---------|
| Funktion | "Änderungen speichern" ohne Funktion |
| Daten | "Dokument" Entity-Typ wird als `type: 'event'` gehackt — Typsystem erlaubt nur 4 Typen |

---

## E. Das "Sammelsurium"-Problem — Warum es sich fragmentiert anfühlt

### 1. Fehlende Navigationshierarchie

Die Top-Navigation ist flach: **Übersicht | Quellen | Berichte | Netzwerk | Beweislage | Boards**. Das kommuniziert 6 gleichwertige Bereiche. Aber die Daten sind hierarchisch: Quellen → Berichte → Akteure → Netzwerk → Beweislage.

Breadcrumbs existieren, aber inkonsistent:
- SourceDetail: "Übersicht > Quellen > MUFON..." (Quellen nicht klickbar)
- Review: "MUFON UFO Journal > Prüfung" (unvollständig)
- StoryDetail: "Berichte > Story-Titel" (gut)
- EntityDetail: "Übersicht > Akteure > Name" (Akteure nicht klickbar)
- Graph, Evidence, Board: **kein Breadcrumb**

### 2. Kein kontextueller Nächster Schritt

- Nach dem Freigeben eines Berichts in Review → nichts passiert
- Nach dem Betrachten eines Entity → "Im Netzwerk zeigen" führt zum gesamten Graph, nicht gefiltert auf dieses Entity
- Nach Upload → kein Link zur neuen Quelle

### 3. Sprachmix unterbricht den Immersions-Fluss

| Seite | Englische Texte |
|-------|-----------------|
| Dashboard | `items`, `new` |
| Graph | `Find entity...`, `Entity Types`, `Graph Stats`, `Nodes`, `Edges`, `Clusters`, `Connected Entities`, `Show in Archive`, `Add to Board`, `New Discoveries`, `Force`, `Hierarchical`, `Radial` |
| Review | `Type`, `Confidence`, `Status` |
| Evidence Tab 2 | `Sort` |
| Evidence Tab 3 | `person`, `organization`, `event`, `location` |

### 4. Inkonsistente Interaktionsmuster

| UI-Element | StoryDetail | Dashboard | Review | Stories | Evidence | Board | Graph |
|------------|-------------|-----------|--------|---------|----------|-------|-------|
| EntityBadge | klickbar | **nicht** | **nicht** | **nicht** | **nicht** | **nicht** | **nicht** |
| Inline-Entity | klickbar | — | **nicht** | — | — | — | — |
| Story-Referenz | — | — | — | — | **nicht** | **nicht** | **nicht** |

Dieselbe Information (Entity-Name, Story-Titel) ist auf einer Seite ein Link und auf der nächsten toter Text. Das erzeugt Misstrauen in die Interaktionsfähigkeit der gesamten Anwendung.

---

## F. Priorisierte Verbesserungsempfehlungen

### Höchste Priorität — Kohärenz-Brüche schließen

#### F.1 Universelle Entity-Links

**Problem:** EntityBadge rendert immer `<span>`. Ob klickbar, hängt vom Kontext ab.

**Lösung:** EntityBadge erhält optionales `href`-Prop → rendert als `<Link>` wenn gesetzt. Alle Verwendungen aktualisieren.

**Dateien:** `components/EntityBadge.tsx`, alle Pages die EntityBadges nutzen

#### F.2 Evidence-Seite mit Berichten verlinken

**Problem:** Evidence referenziert Berichte/Quellen als Text-Strings, kein Link.

**Lösung:**
- `Contradiction` bekommt `storyAId`/`storyBId` in mock.ts
- Story-Titel als `<Link to={/stories/${id}}>` rendern
- Gleiches für Corroboration: Source-Story-Titel verlinken

**Dateien:** `pages/Evidence.tsx`, `data/mock.ts`

#### F.3 Graph: Alle Entity-Typen anzeigen

**Problem:** `entities.slice(0, 16)` — keine Events, keine Locations trotz aktiver Filter.

**Lösung:** Repräsentative Auswahl aller Entity-Typen. Edges erweitern für Person→Event, Event→Location Verbindungen.

**Datei:** `pages/Graph.tsx`

#### F.4 Sprachmix bereinigen

**Problem:** ~30 englische Labels in deutscher UI.

**Lösung:** Alle identifizierten englischen Strings übersetzen. Schwerster Fall: Graph-Seite.

**Dateien:** `pages/Graph.tsx`, `pages/Dashboard.tsx`, `pages/Review.tsx`, `pages/Evidence.tsx`

---

### Hohe Priorität — Workflow-Verbesserungen

#### F.5 Review: Entity-Linking & Tabelle korrigieren

- Inline-Entities als `<Link>` statt `<mark>`
- Entity-Tabelle: Story-Entities statt `entities.slice(0, 6)`
- Spaltenheader übersetzen

**Datei:** `pages/Review.tsx`

#### F.6 Breadcrumbs vereinheitlichen

- Shared Breadcrumb-Komponente
- Alle Segmente klickbar (außer letztes)
- Fehlende Breadcrumbs: Graph, Evidence, Board

**Neue Datei:** `components/Breadcrumb.tsx`

#### F.7 Entities-Listenseite erstellen

- `/entities` Route mit Filter-Sidebar (Typ, Status, Confidence)
- Scrollbare Entity-Liste mit Stats

**Neue Dateien:** `pages/EntityList.tsx`, Route in `App.tsx`

#### F.8 Prozessnavigation einführen

- Kontextbezogene Schritt-Anzeige auf Workflow-Seiten
- `Upload → Verarbeitung → Prüfung → Analyse → Synthese`

---

### Mittlere Priorität — Einzelseiten-Verbesserungen

#### F.9 Dashboard: Stat-Cards klickbar machen

Quellen → `/sources`, Berichte → `/stories`, Akteure → `/entities`, Offene Prüfungen → nächste Review

#### F.10 SourceLibrary: Non-processed Sources UX

Statt `#`: Tooltip "Quelle wird noch verarbeitet" + `cursor-not-allowed`

#### F.11 Board: Karten verlinken

Story-Karten → Story-Detail, Entity-Karten → Entity-Detail

#### F.12 Graph: Rechte Sidebar Stories klickbar machen

Stories als `<Link>`, "Show in Archive" → Entity-Detail

---

### Niedrige Priorität — Polish

#### F.13 Dashboard rechte Spalte nicht abschneiden

Grid-Layout anpassen oder `overflow-auto`

#### F.14 Source Grid Cover-Farben stabilisieren

Farbe an `source.id` binden statt Array-Index

#### F.15 StoryDetail Inline-Entity-Links korrigieren

Entity-Lookup nach Name → korrekte ID für URL

#### F.16 Global Search (Cmd+K) implementieren

Command-Palette über Entities, Stories, Sources — stärkt "Alles ist verbunden"-Eindruck

---

## Fazit

Das Grundgerüst der App ist solide. Die Einzelseiten sind visuell ausgereift, die Mock-Daten beeindruckend detailliert. **Was fehlt, ist die Verbindung.** Wenn die Verlinkung (F.1–F.2), die Interaktionskonsistenz (F.5) und der Sprachmix (F.4) gelöst werden, wird aus dem "Sammelsurium" ein kohärentes Analyse-Werkzeug.

Die Related-Stories-Sidebar auf StoryDetail zeigt, wie es richtig geht: Kontext, Querverweise, AI-Reasoning, klickbare Links. Dieses Muster auf alle Seiten zu übertragen, ist der Schlüssel zur Kohärenz.
