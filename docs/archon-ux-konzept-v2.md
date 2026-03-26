# ARCHON — UX-Konzept v2.0

**Open-Source Document Intelligence Framework**
Domänen-agnostisches System zur KI-gestützten Erfassung, Extraktion und Vernetzung von Inhalten aus Printmedien-Archiven.

Web App · Community-basiert (2–10 Nutzer) · PDF-basiert · KI-gestützt · Self-hosted via Terraform

---

## 1. Produktvision & Systemübersicht

### Open-Source-Philosophie

ARCHON ist ein Open-Source-Framework, das als generisches Werkzeug zur Dokumentenerfassung und Wissensvernetzung entwickelt wird. Das System selbst hat **keinen thematischen Bezug** — der Domänenkontext (z.B. UFO-Zeitschriften, historische Zeitungen, Fachmagazine, Vereinsarchive) wird vollständig über die Web-App konfiguriert.

Das bedeutet: Der gesamte Codebase, die Infrastruktur (Terraform), die KI-Pipelines und die UI-Komponenten sind domänen-neutral. Erst durch die **Domain Configuration** (siehe Kapitel 2) wird eine ARCHON-Instanz zu einem spezialisierten System — z.B. einem UFO-Zeitschriften-Archiv, einem Archiv für historische Lokalzeitungen, oder einer Wissensbasis für medizinische Fachzeitschriften.

### Was ARCHON löst

Viele Archive — insbesondere aus dem Print-Bereich — bestehen aus PDFs mit komplexen, individuellen Layouts: farbige Hintergründe, Bilder als Textuntergrund, wild verteilte Textblöcke, mehrspaltige Layouts ohne klare Struktur, Stories die über mehrere Seiten verteilt sind. ARCHON macht diese Inhalte durchsuchbar, vernetzbar und analysierbar.

### Drei-Säulen-Architektur

**Säule 1 — Erfassung.** PDFs werden hochgeladen. OCR und Layout-Analyse erkennen Textblöcke, Überschriften, Bilder, Spalten und Hintergrund-Elemente — unabhängig von der Layout-Komplexität.

**Säule 2 — Extraktion.** KI segmentiert die erkannten Elemente zu zusammenhängenden Artikeln/Stories — auch über Seitengrenzen hinweg. Ein Review-Workflow erlaubt manuelle Korrektur bei niedriger KI-Confidence. Die KI nutzt den konfigurierten Domänenkontext, um bessere Entscheidungen zu treffen (z.B. "was ist ein Artikel vs. was ist Werbung" hängt vom Medium ab).

**Säule 3 — Vernetzung.** Aus jeder Story werden Entities extrahiert — welche Entity-Typen relevant sind, wird über die Domain Configuration definiert. Texte werden als Vektoren eingebettet. Knowledge Graph und semantische Suche wachsen mit jedem neuen Dokument.

### Nutzerrollen

**Admin** — Dokumente hochladen, Domain Configuration verwalten, System konfigurieren, Nutzer verwalten, Processing-Queue überwachen.

**Researcher** — Stories reviewen und korrigieren, Knowledge Graph erkunden, Evidence Boards erstellen, semantische Suche nutzen, Zusammenhänge dokumentieren.

**Viewer** — Lesezugriff auf Stories, Graph und Boards. Kann kommentieren, aber keine Daten verändern.

---

## 2. Domain Configuration

Dieses Kapitel beschreibt das zentrale Differenzierungsmerkmal von ARCHON gegenüber einer hart-codierten Fachapplikation: Die gesamte Domänenspezialisierung geschieht über die Web-App, nicht im Code.

### 2.1 Konfigurationsebenen

Die Domain Configuration besteht aus vier Ebenen, die aufeinander aufbauen:

**Ebene 1 — Instanz-Identität.** Name der Instanz (z.B. "UFO-Archiv Deutschland", "Heimatblatt-Digitalisierung Uckermark"), Beschreibung, optionales Logo/Branding, Sprache der UI und der KI-Prompts (Deutsch, Englisch, etc.).

**Ebene 2 — Quelltypen.** Definition der Dokumententypen, die verarbeitet werden. Beispiele: "Zeitschrift" (mit Feldern: Titel, Ausgabe, Verlag, Erscheinungsdatum), "Zeitung" (mit Feldern: Titel, Ausgabe, Datum, Region), "Bericht" (mit Feldern: Titel, Autor, Organisation, Datum). Jeder Quelltyp hat konfigurierbare Metadaten-Felder. Die UI für Upload und Bibliothek passt sich dynamisch an die definierten Quelltypen an.

**Ebene 3 — Entity-Taxonomie.** Definition der Entity-Typen, die die KI extrahieren soll. Jeder Entity-Typ hat: einen Namen (z.B. "Person", "Ort", "Phänomen"), eine Farbe (für konsistente Darstellung in der gesamten App), optionale Untertypen (z.B. Phänomen → Lichter, Nahbegegnung, Entführung), optionale spezifische Attribute (z.B. Ort → hat Geocoordinaten). Standardmäßig werden generische Typen mitgeliefert (Person, Ort, Organisation, Datum), die erweitert oder ersetzt werden können.

**Ebene 4 — KI-Kontext.** Ein konfigurierbarer System-Prompt / Kontextblock, der der KI mitgegeben wird und ihre Extraktions- und Analysefähigkeiten auf die Domäne ausrichtet. Enthält: Beschreibung des Themengebiets (Freitext, z.B. "Dieses Archiv enthält deutschsprachige UFO-Zeitschriften aus den Jahren 1970–2010. Die Magazine behandeln Sichtungsberichte, Entführungsberichte, Verschwörungstheorien und wissenschaftliche Analysen zum UFO-Phänomen."), Hinweise zur Layout-Erkennung (z.B. "Diese Magazine haben häufig farbige Hintergründe, Bilder unter Text, und Stories die mit 'Fortsetzung auf Seite X' über mehrere Seiten verteilt sind."), Kategorie-Definitionen für Story-Typen (z.B. Sichtungsbericht, Interview, Leserbrief, Analyse — domänenspezifisch), Regeln für Entity-Extraction (z.B. "Erkenne militärische Einrichtungen als eigenen Entity-Typ" oder "Datumsangaben sind oft ungenau, extrahiere auch vage Zeitangaben wie 'Sommer 1977'").

### 2.2 Domain Configuration UI

Die Konfiguration geschieht über eine dedizierte Settings-Seite, die nur für Admins zugänglich ist.

**Wizard für Ersteinrichtung.** Beim ersten Start (leere Instanz) führt ein Schritt-für-Schritt-Wizard durch die Konfiguration: Instanz benennen → Quelltypen definieren → Entity-Taxonomie aufsetzen → KI-Kontext formulieren. Der Wizard bietet Templates als Startpunkt an: "Zeitschriftenarchiv", "Zeitungsarchiv", "Forschungsberichte", "Leer (alles selbst konfigurieren)".

**Laufende Anpassung.** Die Konfiguration kann jederzeit angepasst werden. Wichtig: Änderungen an der Entity-Taxonomie können retroaktiv angewendet werden (z.B. "führe den neuen Entity-Typ 'Militärbasis' ein und scanne alle bestehenden Stories erneut"). Das System zeigt Auswirkungen von Änderungen als Preview ("Diese Änderung würde 247 Stories betreffen").

**KI-Kontext-Editor.** Der KI-Kontext wird in einem Freitext-Editor mit Markdown-Unterstützung formuliert. Daneben zeigt eine Live-Preview, wie die KI den Kontext interpretiert — z.B. als Test: "Gib der KI eine Beispielseite und sieh, wie sie mit dem aktuellen Kontext segmentiert." Ein "Test & Iterate"-Workflow, der erlaubt, den KI-Kontext iterativ zu verbessern.

### 2.3 Beispiel-Konfigurationen

**UFO-Zeitschriftenarchiv (der Anwendungsfall dieses Projekts):**
Quelltyp: Zeitschrift (Titel, Ausgabe, Verlag, Datum). Entity-Typen: Person (Zeuge, Forscher, Offizieller), Ort (geocodiert), Zeitraum, Phänomen (CE-1 bis CE-5, Lichter, Objekte, Entführung, Crop Circle), Organisation (Militär, Regierung, Forschungsgruppe), Dokument/Akte (z.B. "Project Blue Book"). Story-Kategorien: Sichtungsbericht, Entführungsbericht, Interview, Analyse, Leserbrief, Kurzmeldung. KI-Kontext enthält Hinweise zu typischen Layouts, UFO-Fachterminologie, und der Tatsache, dass Magazine oft sensationalistische Sprache verwenden, die von der KI nicht als Indikator für niedrige Qualität gewertet werden soll.

**Historisches Lokalzeitungsarchiv:**
Quelltyp: Zeitung (Titel, Datum, Region, Rubrik). Entity-Typen: Person, Ort, Organisation, Ereignis. Story-Kategorien: Nachricht, Anzeige, Lesermeinung, Vereinsbericht, Todesanzeige. KI-Kontext enthält Hinweise zu Frakturschrift (falls relevant), Spalten-Layouts, und regionalen Dialektbegriffen.

**Medizinische Fachzeitschriften:**
Quelltyp: Journal (Titel, Volume, Issue, Datum, Impact Factor). Entity-Typen: Forscher, Institution, Wirkstoff, Krankheitsbild, Studie. Story-Kategorien: Original Research, Review, Case Report, Editorial, Letter. KI-Kontext enthält Hinweise zu Abstracts, Referenzen, Tabellen und Abbildungen.

---

## 3. Kerndaten-Modell (domänen-neutral)

### Generische Entitäten

**Source** — Das Quell-PDF. Attribute werden dynamisch durch den konfigurierten Quelltyp bestimmt. Feste Attribute: Datei-Referenz, Seitenanzahl, Verarbeitungsstatus, Upload-Datum, Uploader, Thumbnail.

**Story** — Ein extrahierter, zusammenhängender Artikel. Feste Attribute: Extrahierter Volltext, Seitenreferenzen (von–bis), Confidence-Score, Review-Status, Vektor-Embedding. Dynamische Attribute: Kategorie (aus der konfigurierten Kategorie-Liste), weitere Felder je nach Domain Configuration.

**Entity** — Eine extrahierte benannte Entität. Feste Attribute: Kanonischer Name, Alias-Liste, Typ (aus der konfigurierten Taxonomie), Anzahl Erwähnungen. Dynamische Attribute: Je nach konfiguriertem Entity-Typ (z.B. Geocoordinaten für Orte, Rolle für Personen).

**Connection** — Eine Verbindung zwischen zwei Entities. Attribute: Typ (Co-Occurrence, KI-Inference, manuell), Confidence-Score, Liste der Stories als Evidenz, optionales Label.

**Board** — Ein Evidence Board. Attribute: Titel, Beschreibung, Ersteller, Sichtbarkeit, Karten (positionierte Story-Referenzen, Entity-Referenzen, Freitext-Notizen), Verbindungslinien zwischen Karten.

---

## 4. Globale Navigation & Layout-Prinzipien

### Navigationsstruktur

Horizontale Top-Navigation mit fünf Hauptbereichen. Die Bezeichnungen können über die Domain Configuration angepasst werden (z.B. "Magazine" statt "Sources" oder "Quellen" statt "Sources"), aber die Standardbezeichnungen sind:

**Dashboard** `/` — Einstieg, Überblick, Quick Actions.
**Sources** `/sources` — Bibliothek aller hochgeladenen Quell-PDFs.
**Stories** `/stories` — Durchsuchbares Story-Archiv.
**Graph** `/graph` — Knowledge Graph Visualisierung.
**Boards** `/boards` — Evidence Boards Übersicht.

Zusätzlich: **Settings** `/settings` — Domain Configuration, Nutzerverwaltung, persönliche Einstellungen (nur für berechtigte Rollen sichtbar).

Globale Command Palette (Cmd+K / Ctrl+K) als Overlay: bündelt Navigation, semantische Suche und Quick Actions.

### Layout-Prinzipien

**Responsive, Desktop-first.** Komplexe Visualisierungen (Graph, Evidence Board, Split-View Review) brauchen Bildschirmfläche. Mobile Ansichten erlauben grundlegendes Browsing und einfache Reviews.

**Breadcrumbs für Tiefe.** Bei verschachtelter Navigation (z.B. Source → Seite → Story → Review) zeigt eine Breadcrumb-Leiste den Kontext.

**Kontextabhängige Sidebars.** Graph-View und Evidence Board haben optionale Filter-/Navigations-Sidebars. Die Source-Detailseite hat rechts eine Story-Liste. Alle Sidebars einklappbar.

**Konsistentes Farbschema für Entity-Typen.** Die in der Domain Configuration definierten Farben pro Entity-Typ ziehen sich durch die gesamte App — als Tags, Graph-Knoten, Inline-Highlights und Filter-Chips.

**Domänen-neutrales UI-Vokabular.** Die UI verwendet durchgehend die in der Domain Configuration definierten Begriffe. Wenn dort "Magazin" statt "Source" konfiguriert ist, steht überall "Magazin". Das erfordert ein durchgängiges Label-System, das aus der Konfiguration gespeist wird.

---

## 5. User Flows

### Flow 1: Ersteinrichtung (Domain Configuration)

Dieser Flow beschreibt, wie ein Admin eine neue ARCHON-Instanz für eine spezifische Domäne einrichtet. Er wird nur beim ersten Start oder bei grundlegenden Änderungen durchlaufen.

**Schritt 1 — Template wählen (Admin).** Nach dem ersten Login sieht der Admin einen Wizard. Schritt 1: "Was möchtest du archivieren?" Auswahl eines Templates (Zeitschriftenarchiv, Zeitungsarchiv, Forschungsberichte, Leer) oder Freitext-Beschreibung. Bei Freitext schlägt die KI ein passendes Template vor.

**Schritt 2 — Instanz-Identität (Admin).** Name der Instanz, optionale Beschreibung, Sprache für UI und KI-Prompts. Optionales Logo-Upload für Branding.

**Schritt 3 — Quelltypen definieren (Admin).** Basierend auf dem Template sind Quelltypen vorausgefüllt. Der Admin passt an: Benennung (z.B. "Zeitschrift" → "Magazin"), Metadaten-Felder hinzufügen/entfernen/umbenennen. Preview zeigt, wie der Upload-Dialog und die Bibliothek aussehen werden.

**Schritt 4 — Entity-Taxonomie definieren (Admin).** Ebenfalls aus dem Template vorausgefüllt. Der Admin kann: Entity-Typen hinzufügen, entfernen, umbenennen, Untertypen definieren, Farben zuweisen, spezifische Attribute pro Typ festlegen. Preview zeigt, wie Entity-Tags und Graph-Knoten aussehen werden.

**Schritt 5 — KI-Kontext formulieren (Admin).** Ein Freitext-Editor mit Vorschlag aus dem Template. Der Admin beschreibt die Domäne, gibt der KI Hinweise zu Layouts, Terminologie und Extraktionsregeln. Ein "Testen"-Button erlaubt, eine Beispiel-PDF-Seite hochzuladen und zu sehen, wie die KI mit dem aktuellen Kontext segmentiert und extrahiert. Iterativer Verbesserungsprozess.

**Schritt 6 — Story-Kategorien definieren (Admin).** Liste der Kategorien, die Stories zugeordnet werden können. Aus Template vorausgefüllt, frei anpassbar. Pro Kategorie: Name, optionale Beschreibung (hilft der KI bei der Zuordnung), Farbe.

**Schritt 7 — Fertig.** Die Instanz ist konfiguriert. Der Wizard leitet zum Dashboard weiter, das den leeren Zustand zeigt und zum ersten Upload einlädt.

### Flow 2: Dokument-Ingestion (Upload bis fertige Stories)

**Schritt 1 — PDF-Upload (User).** Drag & Drop oder Datei-Dialog. Batch-Upload möglich. Nach Upload: Metadaten-Dialog, dessen Felder sich dynamisch aus dem konfigurierten Quelltyp ergeben. KI füllt Felder automatisch vor (aus Cover/ersten Seiten, unter Berücksichtigung des KI-Kontexts).

**Schritt 2 — Processing Queue (System).** Das Dokument durchläuft: Queued → OCR → Layout-Analyse → Segmentierung → Entity Extraction → Embedding → Fertig. Geschätzte Dauer: 2–5 Minuten pro Dokument. Fortschritt live sichtbar auf Dashboard und in der Bibliothek.

**Schritt 3 — Layout-Analyse & OCR (KI).** Jede Seite wird analysiert: Textblöcke, Bilder, Überschriften, Spalten, Seitenzahlen. Der KI-Kontext gibt Hinweise, worauf besonders zu achten ist (z.B. "farbige Hintergründe sind üblich" oder "Frakturschrift möglich"). Ergebnis: positionierte Textblöcke mit Bounding Boxes.

**Schritt 4 — Story-Segmentierung (KI).** Textblöcke werden zu zusammenhängenden Stories gruppiert — auch seitenübergreifend. Die KI nutzt die konfigurierten Story-Kategorien, um Artikeltypen zu unterscheiden (z.B. Hauptartikel vs. Leserbrief vs. Werbung). Jede Story bekommt einen Confidence-Score und eine vorgeschlagene Kategorie.

**Schritt 5 — Auto-Review oder manuelle Review (System/User).** Stories mit Confidence >Threshold werden automatisch freigegeben. Der Threshold ist pro Nutzer einstellbar (Standard: 85%). Stories darunter landen in der Review-Queue.

**Schritt 6 — Entity Extraction & Embedding (KI).** Aus jeder Story werden Entities extrahiert — die KI sucht gezielt nach den in der Taxonomie definierten Entity-Typen. Der Volltext wird vektorisiert. Der Knowledge Graph wird mit neuen Knoten und Kanten aktualisiert.

### Flow 3: Story-Review (manuelle Korrektur)

**Schritt 1 — Review-Queue öffnen (User).** Filtert auf Stories mit Status "Needs Review" oder niedrigem Confidence-Score. Pro Eintrag: Story-Titel (KI-Vorschlag), Quell-Dokument, Confidence-Score, Seitenreferenz. Sortierbar nach Confidence, Quelle oder Datum.

**Schritt 2 — Split-View (User).** Geteilte Ansicht. Links: Original-PDF-Seite mit farbigen Overlay-Regionen (welche Textblöcke gehören zu welcher Story). Verschiedene Farben pro Story. Zoom, Pan, Seitennavigation. Rechts: Extrahierter Text mit Metadaten und Entity-Tags. Direkt editierbar.

**Schritt 3 — Segmente korrigieren (User).** Textblöcke per Drag & Drop zwischen Stories verschieben. Stories mergen oder splitten. Neue Story-Grenzen setzen. Blöcke als "kein Content" markieren.

**Schritt 4 — Metadaten und Entities anpassen (User).** Titel/Autor korrigieren. Kategorie zuweisen (aus der konfigurierten Kategorie-Liste). Entity-Vorschläge bestätigen, ablehnen oder hinzufügen. Entity-Typ aus der konfigurierten Taxonomie zuweisen. Autocomplete gegen bestehende Entities im Graph.

**Schritt 5 — Approve (System).** Story wird als reviewed markiert. Embedding wird neu berechnet falls Text geändert. Graph wird aktualisiert. Nächste Story in der Queue wird automatisch geladen.

**Keyboard-Shortcuts:** Pfeiltasten für Seiten, Enter = Approve, E = Edit, J/K = vorherige/nächste Story, Tab = nächstes Entity-Feld.

### Flow 4: Exploration & Evidenz-Aufbau

**Schritt 1 — Semantische Suche (User).** Natürlichsprachige Anfrage im Suchfeld. KI findet semantisch passende Stories. Facetten-Filter orientieren sich an der konfigurierten Taxonomie — die Filter-Optionen für Entity-Typen, Kategorien etc. werden dynamisch aus der Domain Configuration erzeugt.

**Schritt 2 — Knowledge Graph erkunden (User).** Interaktive Visualisierung. Knoten = Entities (Farbe und Form aus der Taxonomie-Konfiguration). Kanten = Co-Occurrence in Stories. Filter-Panel zeigt die konfigurierten Entity-Typen als Checkboxen. Klick auf Knoten → Detail-Panel mit verbundenen Entities und Stories.

**Schritt 3 — KI-Vorschläge (KI).** System schlägt proaktiv Zusammenhänge vor. Die Art der Vorschläge wird durch den KI-Kontext beeinflusst (z.B. in einem UFO-Archiv: "4 Stories beschreiben ähnliche Phänomene im selben Zeitraum" — in einem Zeitungsarchiv: "3 Artikel berichten über dieselbe Person in verschiedenen Kontexten"). Jeder Vorschlag hat Confidence-Score und kann angenommen, verworfen oder auf ein Board übernommen werden.

**Schritt 4 — Evidence Board (User).** Freiform-Canvas. Stories, Entities und Notizen per Drag & Drop platzieren. Verbindungslinien ziehen und beschriften. KI-Vorschläge für das aktuelle Board abrufen. Board teilen und kollaborativ bearbeiten.

### Flow 5: Domain Configuration anpassen (laufend)

**Schritt 1 — Entity-Typ hinzufügen (Admin).** Admin stellt fest, dass ein neuer Entity-Typ benötigt wird (z.B. nach Verarbeitung der ersten 50 Magazine fällt auf, dass "Militärische Einrichtung" ein eigener Typ sein sollte statt nur ein Ort). Admin geht in Settings → Entity-Taxonomie → "+ Typ hinzufügen". Definiert: Name, Farbe, Untertypen, Attribute.

**Schritt 2 — Retroaktive Anwendung (System/Admin).** Das System zeigt: "Soll dieser neue Typ auf alle bestehenden Stories angewendet werden? Geschätzte Dauer: ~15 Min für 3.891 Stories." Admin bestätigt. Das System scannt alle bestehenden Stories erneut mit dem aktualisierten Entity-Schema. Neue Entities werden als "Vorgeschlagen" markiert und tauchen in einer eigenen Review-Queue auf.

**Schritt 3 — KI-Kontext verfeinern (Admin).** Der Admin merkt, dass die KI bestimmte Artikel falsch segmentiert (z.B. Werbung wird als Story erkannt). Er ergänzt den KI-Kontext: "In diesen Magazinen ist Werbung häufig ganzseitig und enthält Bestellformulare. Solche Seiten sollen als 'Werbung' kategorisiert und nicht als Story extrahiert werden." Optional: erneutes Scannen bestehender Dokumente mit dem aktualisierten Kontext.

---

## 6. Seitenbeschreibungen

### 6.1 Dashboard `/`

**Zweck:** Einstiegsseite mit Überblick über Systemzustand und Handlungsaufforderungen.

**Layout:** Volle Breite, kein Sidebar. Stat-Karten oben, darunter zweispaltiges Layout.

**Komponenten:**

*Stat-Karten (4er-Reihe).* Gesamtzahl Sources, Gesamtzahl Stories, Gesamtzahl Entities, Anzahl offene Reviews. Die Labels verwenden die in der Domain Configuration definierten Begriffe ("Magazine" statt "Sources", etc.). Die letzte Karte ist visuell hervorgehoben bei >0.

*Processing Queue (linke Spalte).* Aktuell in Verarbeitung befindliche Dokumente. Pro Eintrag: Titel, aktueller Schritt, Progress-Bar, geschätzte Restdauer. Leerer Zustand mit Upload-CTA.

*Letzte Aktivität (linke Spalte, unter Queue).* Chronologischer Feed: Uploads, Reviews, neue Verbindungen. Jeder Eintrag klickbar.

*KI-Discoveries (rechte Spalte).* Die drei neuesten Vorschläge der KI als Karten: Kurzbeschreibung, Confidence-Score, beteiligte Stories/Entities als Tags, Aktions-Buttons (Ansehen, Auf Board, Verwerfen).

*Quick Actions (rechte Spalte).* Prominente Buttons: Upload, Review starten (mit Zähler), Suche öffnen.

### 6.2 Source-Bibliothek `/sources`

**Zweck:** Alle hochgeladenen Quell-Dokumente als durchsuchbares Grid.

**Layout:** Toolbar oben, darunter responsives Grid.

**Komponenten:**

*Toolbar.* Suchfeld, Filter-Chips (Zeitraum, Verarbeitungsstatus, und alle Metadaten-Felder des konfigurierten Quelltyps — dynamisch generiert), Sortierung, "+ Upload"-Button.

*Source-Grid.* Responsive Karten (4/2/1 Spalten). Jede Karte: Thumbnail (erste Seite), dynamisch angezeigte Metadaten aus dem konfigurierten Quelltyp (z.B. Titel + Ausgabe + Datum für Zeitschriften, Titel + Datum + Region für Zeitungen), Anzahl Stories, Seitenanzahl, Status-Badge.

*Upload-Dialog (Modal).* Drag & Drop, Batch-Upload. Metadaten-Formular: Felder werden dynamisch aus dem konfigurierten Quelltyp generiert. KI füllt vor (unter Nutzung des KI-Kontexts). Nutzer bestätigt oder korrigiert.

### 6.3 Source-Detail `/sources/:id`

**Zweck:** Einzelansicht eines Quell-Dokuments mit Seitenübersicht und extrahierten Stories.

**Layout:** Dreispaltig: links Seiten-Thumbnails, Mitte Seitenansicht, rechts Story-Liste.

**Komponenten:**

*Seiten-Navigation (links, schmal).* Vertikale Thumbnail-Leiste. Aktive Seite hervorgehoben. Seiten mit Stories haben farbigen Indikator. Content-lose Seiten ausgegraut.

*Seitenansicht (Mitte).* Große PDF-Darstellung. Semi-transparente, farbige Overlay-Boxen für Story-Regionen. Hover → Story-Titel als Tooltip. Klick → Story selektieren. Zoom & Pan.

*Story-Liste (rechts).* Alle Stories aus diesem Dokument. Pro Eintrag: Titel, Seiten, Kategorie-Tag (aus konfigurierter Liste), Confidence-Score, Review-Status. Klick highlightet Regionen in der Mitte. Aktions-Buttons: Review, Im Archiv öffnen, Auf Board setzen.

*Source-Header.* Dynamisch aus dem Quelltyp: zeigt alle konfigurierten Metadaten-Felder. Bearbeiten-Button, PDF-Download-Link.

### 6.4 Extraction Review `/sources/:id/review/:storyId`

**Zweck:** Split-View für manuelle QA der KI-Extraktion. Herzstück der Qualitätssicherung.

**Layout:** Zweispaltig (je 50%). Toolbar oben. Entity-Panel unten (ausklappbar).

**Komponenten:**

*Review-Toolbar.* Breadcrumb, Story-Navigation (X von Y), Confidence-Anzeige (Grün/Gelb/Rot), Buttons: Approve, Skip, Flag for Expert. Shortcut-Hinweise.

*PDF-Ansicht (links).* Original-PDF-Seite(n). Farbige Overlays für die aktuelle Story. Andere Stories in schwächerer Farbe. Seitennavigation bei mehrseitigen Stories. Interaktion: Klick auf fremden Block → Kontextmenü "Zu dieser Story verschieben?". Freihand-Selektion für neue Blöcke.

*Extrahierter Text (rechts).* Editierbarer Volltext. Darüber: editierbarer Titel und Autor. Kategorie-Dropdown (Optionen aus Domain Configuration). Inline-Entity-Highlights (Farben aus Taxonomie). Klick auf Entity → Popup: Typ ändern (Typen aus Taxonomie), umbenennen, löschen, mit bestehendem Entity mergen.

*Entity-Panel (unten).* Tabellarische Entity-Liste: Name, Typ (aus Taxonomie, mit Farbe), Confidence, Status. Button für manuelles Hinzufügen mit Autocomplete gegen den bestehenden Graph.

*Segmentierungs-Tools.* Merge, Split, Block entfernen, Block hinzufügen — als Kontextmenü oder Toolbar.

### 6.5 Story-Archiv `/stories`

**Zweck:** Durchsuchbare Datenbank aller extrahierten Stories.

**Layout:** Suchfeld prominent oben, optionaler Filter-Sidebar links.

**Komponenten:**

*Semantische Suchleiste.* Großes Eingabefeld. Akzeptiert natürliche Sprache. Schnellfilter-Chips darunter — dynamisch generiert aus den konfigurierten Story-Kategorien und häufigsten Entity-Typen. Autocomplete schlägt Entities vor.

*Facetten-Filter (links, einklappbar).* Dynamisch aus der Domain Configuration: Story-Kategorien, Zeitraum, Quelle/Dokument, ein Filter pro konfiguriertem Entity-Typ (mit Auswahlmöglichkeiten aus dem Graph), Review-Status, Confidence-Range.

*Ergebnisliste.* Pro Eintrag: Titel, Quelle, Textauszug mit Highlights, Relevanz-Score, Entity-Tags (Farben aus Taxonomie), Anzahl verwandter Stories, Review-Status.

*Story-Detail (Inline oder eigene Seite `/stories/:id`).* Volltext, Entity-Highlights, Metadaten, Sidebar "Verwandte Stories", Link zur Original-PDF-Seite, Buttons: Auf Board setzen, Im Graph anzeigen, Review öffnen.

*Bulk-Actions.* Mehrfachauswahl mit: Taggen, zu Board hinzufügen, Export (CSV/JSON), Batch-Review.

### 6.6 Knowledge Graph `/graph`

**Zweck:** Interaktive Visualisierung aller Entitäten und Verbindungen.

**Layout:** Graph nahezu Vollbild. Filter-Panel links einklappbar. Detail-Panel rechts einklappbar.

**Komponenten:**

*Graph-Canvas.* Force-Directed Graph. Knotengröße = Erwähnungshäufigkeit. Knotenfarbe = Entity-Typ (aus Taxonomie-Konfiguration). Kantendicke = Co-Occurrence-Häufigkeit. Zoom-Verhalten: herauszoomen → thematische Cluster; hineinzoomen → einzelne Entities.

*Knoten-Interaktion.* Hover → Tooltip (Name, Typ, Verbindungen). Klick → Selektion, direkte Verbindungen anzeigen, Detail-Panel öffnen. Doppelklick → Entity-Detailseite. Drag → Knoten verschieben.

*Filter-Panel (links).* Entity-Typ-Checkboxen — dynamisch aus Taxonomie. Zeitraum-Slider. Mindest-Verbindungen-Slider. Confidence-Threshold. Textsuche (zentriert Graph auf Knoten).

*Detail-Panel (rechts).* Bei Knoten-Klick: Entity-Name und Typ, Erwähnungen, verbundene Entities, zugehörige Stories (klickbar), Buttons: Im Archiv filtern, Auf Board setzen. Bei Ort-Entities mit Geocoordinaten: Mini-Karte.

*Graph-Toolbar.* Layout-Optionen (Force-Directed, Hierarchisch, Radial). Cluster-Toggle. "Neue Entdeckungen hervorheben"-Toggle. Export.

### 6.7 Evidence Boards — Übersicht `/boards`

**Zweck:** Liste aller Boards der Community.

**Layout:** Grid oder Liste.

**Komponenten:** Board-Karten mit Titel, Ersteller, Datum, Anzahl Karten, Beschreibung, Sichtbarkeits-Status. "+Neues Board"-Button.

### 6.8 Evidence Board — Einzelansicht `/boards/:id`

**Zweck:** Infinite Canvas zum Aufbau von Evidenzketten.

**Layout:** Vollbild-Canvas. Toolbar oben. Story-Suchpanel rechts (bei Bedarf).

**Komponenten:**

*Infinite Canvas.* Frei positionierbare Karten. Endloses Scrollen und Zoomen. Optionales Hintergrund-Grid.

*Karten-Typen.* Story-Karte (Titel, Auszug, Quelle, Entity-Tags). Entity-Karte (Name, Typ, Verbindungen). Notiz-Karte (Freitext). Bild-Karte.

*Verbindungslinien.* Drag von Karte zu Karte. Beschriftbar, Farbe/Stil wählbar, optionale Richtungspfeile.

*Board-Toolbar.* Titel (editierbar), Story-Suche öffnen, Notiz hinzufügen, KI-Vorschläge, Teilen, Export, Undo/Redo.

*Story-Suchpanel (rechts).* Semantische Suche, Ergebnisse per Drag & Drop auf Canvas ziehen.

*Kollaboration.* Kommentare auf Karten- und Board-Ebene. Sichtbar wer was erstellt hat. Versionshistorie. Export als Bild, PDF oder Dossier.

### 6.9 Settings `/settings`

**Zweck:** Domain Configuration, Nutzerverwaltung, persönliche Einstellungen.

**Layout:** Tab-Navigation innerhalb der Settings-Seite.

**Tabs und Komponenten:**

*Domain (nur Admin).* Instanz-Identität (Name, Logo, Sprache). Quelltyp-Editor (Metadaten-Felder verwalten). Entity-Taxonomie-Editor (Typen, Untertypen, Farben, Attribute). Story-Kategorien-Editor. KI-Kontext-Editor (Freitext + Test-Funktion). Retroaktive Anwendung von Änderungen (mit Preview der Auswirkungen).

*Nutzer (nur Admin).* Einladung per E-Mail. Rollenzuweisung (Admin, Researcher, Viewer). Aktive Nutzer-Liste. Nutzer deaktivieren/entfernen.

*Persönlich.* Auto-Approve Confidence-Threshold. Benachrichtigungs-Präferenzen. UI-Sprache. Keyboard-Shortcut-Übersicht.

*System (nur Admin).* Processing-Prioritäten. Daten-Export (vollständiger Dump). Infrastruktur-Status (Terraform-managed Services). API-Keys und Integrationen.

---

## 7. Interaktionsmuster

### 7.1 Confidence-Score UX

Jede KI-Aktion zeigt einen Confidence-Score (0–100%). Konsistente Farbskala: Grün (>85%), Gelb (50–85%), Rot (<50%). Dezenter Hint "Review empfohlen" bei niedrigem Score. Auto-Approve-Threshold pro Nutzer einstellbar.

### 7.2 Universelles Drag & Drop

PDFs auf Upload-Zone → Dokument anlegen. Story-Karten auf Board → hinzufügen. Textblöcke im Review zwischen Stories → Segmente umordnen. Suchergebnisse auf Canvas → Board erweitern. Einheitliches visuelles Feedback: Ghost-Preview, farbige Drop-Zone-Highlights.

### 7.3 Semantische Suche

Globale Command Palette (Cmd+K) und Story-Archiv-Suchfeld akzeptieren natürliche Sprache und strukturierte Filter. Autocomplete schlägt konfigurierte Entities vor. Relevanz-Score und Textpassagen-Highlights. "Mehr wie diese Story"-Button für Vektor-Ähnlichkeitssuche.

### 7.4 Proaktive KI-Vorschläge

Nach jeder Verarbeitung: Abgleich neuer Stories gegen Bestand. Ergebnis: Discovery-Karten auf Dashboard, pulsierende Knoten im Graph, "Verwandte Stories"-Sections. KI-Vorschläge berücksichtigen den konfigurierten Domänenkontext — die Art der Muster die gesucht werden, hängt vom KI-Kontext ab. Jeder Vorschlag ist dismissable; Feedback verbessert zukünftige Vorschläge.

### 7.5 Review-Effizienz

Keyboard-first, Batch-Approve, Flag for Expert, Auto-Advance. Optimiert für das Durcharbeiten großer Review-Queues.

### 7.6 Kollaboration

Activity-Feed, Kommentare auf Story- und Board-Ebene, Assignments (Review-Aufgaben delegieren), Benachrichtigungen bei Mentions, Discoveries und Assignments.

### 7.7 Dynamische UI aus Konfiguration

Ein zentrales Muster: Die UI generiert sich an vielen Stellen dynamisch aus der Domain Configuration. Filter-Chips, Dropdowns, Graph-Farben, Upload-Formulare, Entity-Panels — all das liest die konfigurierten Quelltypen, Entity-Taxonomie und Kategorien aus und stellt sich entsprechend dar. Änderungen an der Konfiguration wirken sich sofort auf die UI aus, ohne Code-Änderungen.

---

## 8. Evidenz-Architektur

### 8.1 Knowledge Graph — Strukturierte Verbindungen

Speichert Entities und ihre Beziehungen. Entity-Typen werden durch die Domain Configuration definiert — das System ist hier vollständig flexibel. Verbindungen entstehen durch Co-Occurrence in Stories (automatisch) und durch KI-Inference (z.B. Namens-Matching über verschiedene Dokumente hinweg). Nutzer-Bestätigung stärkt den Confidence-Score von Verbindungen.

### 8.2 Vektor-Datenbank — Semantische Ähnlichkeit

Jede Story als Vektor-Embedding. Ermöglicht: semantische Suche, automatisches Clustering, Cross-Referencing neuer Stories gegen den Bestand, Anomalie-Erkennung (Stories ohne Cluster-Zugehörigkeit). Hybrid Search kombiniert Keyword-Match und Vektor-Ähnlichkeit.

### 8.3 Das Flywheel

Schritt 1 — Ingest: Neues Dokument verarbeitet, Stories und Entities extrahiert.
Schritt 2 — Connect: KI verknüpft neue Entities mit bestehenden, Vektor-Suche findet ähnliche Stories.
Schritt 3 — Discover: Neue Muster tauchen auf, KI schlägt Zusammenhänge vor, Community reviewed.
Schritt 4 — Validate: Bestätigte Zusammenhänge stärken den Graph, abgelehnte trainieren die KI.

Mehr Daten → bessere KI → schnellerer Review → mehr Daten.

---

## 9. Leere Zustände & Onboarding

### Allererster Start (noch nicht konfiguriert)

Der Admin sieht den Domain Configuration Wizard (Flow 1). Kein Zugang zu anderen Bereichen bis die Grundkonfiguration abgeschlossen ist.

### Konfiguriert, aber ohne Dokumente

Dashboard zeigt Willkommens-Screen: "1. Lade dein erstes [konfigurierter Quelltyp-Name] hoch → 2. Prüfe die extrahierten Stories → 3. Entdecke Zusammenhänge." Prominenter Upload-CTA. Andere Bereiche mit ermutigenden leeren Zuständen unter Verwendung der konfigurierten Terminologie.

### Progressives Freischalten

Knowledge Graph wird ab ca. 10 Stories mit Entities sinnvoll nutzbar (vorher sichtbar, aber als "Zu wenige Daten" markiert). Evidence Boards sofort verfügbar. KI-Vorschläge starten ab ca. 50 Stories.

---

## 10. Infrastruktur & Deployment

### Open-Source-Prinzipien

Der gesamte Codebase ist Open Source. Infrastruktur wird über Terraform provisioniert und ist damit reproduzierbar und cloud-agnostisch dokumentiert. Deployment als Self-hosted-Lösung — jede Instanz läuft auf der Infrastruktur des Betreibers.

### Terraform-Scope

Terraform verwaltet: Compute-Ressourcen für die Web-App und API, Datenbank-Instanzen (Vektor-DB, Graph-DB, relationale DB für Metadaten), Object Storage für PDFs und verarbeitete Assets, KI-Service-Anbindung (Konfiguration des LLM-Providers), Queue/Worker-Infrastruktur für die Processing Pipeline, Netzwerk und Secrets Management.

Die Terraform-Module sind so gestaltet, dass sie auf verschiedenen Cloud-Providern (GCP, AWS, etc.) oder on-premise deployt werden können — über austauschbare Provider-Module.

### Konfiguration vs. Code

Die strikte Trennung: Alles was domänenspezifisch ist, lebt in der Datenbank als Konfiguration (Domain Configuration). Alles was generisch ist, lebt im Code. Es gibt keinen Punkt im Codebase, an dem "UFO", "Entführung", "Phänomen" oder ein anderer domänenspezifischer Begriff hart codiert ist.
