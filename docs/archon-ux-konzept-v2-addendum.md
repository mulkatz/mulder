# ARCHON — UX-Konzept v2.0 / Addendum: Blinde Flecken

Dieses Dokument ergänzt das Hauptkonzept um alles, was bei der systematischen Überprüfung als fehlend identifiziert wurde. Die Ergänzungen gliedern sich in: fehlende Seiten/Views, fehlende Flows, fehlende Interaktionen, fehlende Zustände und fehlende Querschnittsthemen.

---

## A. Fehlende Seiten & Views

### A.1 Entity-Detail `/entities/:id`

Im Hauptkonzept wird die Entity-Detailseite zwar beim Graph-Doppelklick erwähnt, aber nirgends als eigene Seite beschrieben. Sie ist aber zentral — sie ist die "Akte" einer Entity.

**Zweck:** Vollständige Übersicht über eine einzelne Entity — alle Erwähnungen, Verbindungen, Zeitverlauf, und die Möglichkeit, die Entity zu bearbeiten.

**Layout:** Header mit Entity-Infos, darunter Tab-Navigation für verschiedene Perspektiven.

**Komponenten:**

*Entity-Header.* Kanonischer Name, Typ (mit Farbindikator aus Taxonomie), Alias-Liste (editierbar — hier können alternative Schreibweisen hinzugefügt werden), dynamische Attribute aus der Taxonomie (z.B. Geocoordinaten für Orte, Rolle für Personen), Anzahl Erwähnungen, Anzahl Verbindungen. Edit-Button für alle Felder.

*Tab: Stories.* Chronologische Liste aller Stories, in denen diese Entity vorkommt. Pro Eintrag: Titel, Quelle, Textauszug mit Highlight der Entity-Erwähnung im Kontext, Datum. Filtert und sortierbar.

*Tab: Verbindungen.* Liste aller verbundenen Entities. Pro Eintrag: Name, Typ, Anzahl gemeinsamer Stories, Confidence-Score der Verbindung. Klick öffnet Mini-Ansicht der gemeinsamen Stories. Button "Im Graph anzeigen" zentriert den Graph auf diese Entity.

*Tab: Timeline.* Wenn die Entity in Stories mit Datumsangaben vorkommt: chronologische Darstellung aller Erwähnungen auf einer Zeitachse. Zeigt, wann und in welchem Kontext die Entity auftaucht.

*Tab: Merge-Kandidaten.* KI-Vorschläge für Entities, die möglicherweise identisch mit dieser sind (z.B. "Dr. J. Allen Hynek" und "J.A. Hynek" und "Hynek"). Pro Vorschlag: Name, Typ, Similarity-Score, Anzahl Stories, Button "Mergen" (mit Vorschau der Auswirkungen) und "Nicht identisch" (markiert dauerhaft als unterschiedlich).

*Danger Zone.* Entity löschen — mit Warnung, welche Stories und Verbindungen betroffen sind.

### A.2 Entity-Management `/entities`

Komplett fehlende Seite. Bisher gibt es keinen Ort, an dem man alle Entities durchsuchen, filtern und verwalten kann, ohne den Graph zu öffnen.

**Zweck:** Tabellarische Verwaltung aller Entities. Bulk-Operationen, Duplikat-Erkennung, Datenqualität.

**Layout:** Toolbar oben, Tabelle als Hauptbereich, Sidebar bei Selektion.

**Komponenten:**

*Toolbar.* Suchfeld (Name, Alias), Filter: Entity-Typ (aus Taxonomie), Mindest-Erwähnungen, hat Merge-Kandidaten (ja/nein), Review-Status (KI-vorgeschlagen vs. bestätigt). Sortierung: Name, Anzahl Erwähnungen, Anzahl Verbindungen, zuletzt erwähnt.

*Entity-Tabelle.* Pro Zeile: Name, Typ (Farb-Badge), Aliase, Erwähnungen, Verbindungen, Status (bestätigt/vorgeschlagen), Merge-Indikator (Icon wenn Merge-Kandidaten existieren). Checkbox für Mehrfachauswahl.

*Bulk-Actions.* Merge (2+ Entities auswählen → zusammenführen), Typ ändern, Löschen (mit Kaskaden-Warnung), Bestätigen (KI-Vorschlag → bestätigt).

*Merge-Queue (eigener Tab oder Filter-Preset).* Zeigt alle Entity-Paare, bei denen die KI vermutet, dass sie identisch sind. Pro Paar: beide Namen, Typen, Anzahl Stories, Überlappungsgrad, Buttons "Mergen" und "Unterschiedlich". Keyboard-navigierbar für effizientes Durcharbeiten.

*Sidebar (bei Selektion einer Entity).* Kompakte Vorschau: Name, Stories-Auszug, Verbindungen. Link zur Entity-Detail-Seite.

### A.3 Timeline-View `/timeline`

Komplett fehlend. Für jede Domäne, die mit zeitlichen Ereignissen arbeitet (UFO-Sichtungen, historische Ereignisse, Forschungsverläufe), ist eine Zeitachse essentiell.

**Zweck:** Chronologische Visualisierung aller Stories und Entities auf einer Zeitachse. Erkennen von zeitlichen Mustern, Häufungen, und Korrelationen.

**Layout:** Horizontale Zeitachse als Hauptelement, Filter-Panel oben, Detail-Panel bei Selektion.

**Komponenten:**

*Zeitachse (Hauptbereich).* Horizontale Timeline mit Zoom-Stufen: Jahrzehnte → Jahre → Monate → Tage. Stories als Punkte oder Balken auf der Achse (Balken für Stories mit Zeitspannen). Farbkodierung nach Story-Kategorie oder nach Entity-Typ (umschaltbar). Häufungs-Indikator: Bereiche mit vielen Ereignissen werden visuell dichter dargestellt.

*Filter-Panel (oben).* Entity-Filter: "Zeige nur Stories die Entity X erwähnen". Kategorie-Filter. Quell-Filter. Freitext-Filter.

*Detail bei Hover/Klick.* Hover über einen Punkt → Tooltip mit Story-Titel und Quelle. Klick → expandiertes Panel mit Textauszug, Entities, Link zur Story.

*Bereichs-Selektion.* Nutzer kann einen Zeitbereich auf der Achse markieren (Drag). Zeigt Zusammenfassung: "23 Stories in diesem Zeitraum. Top-Entities: Phoenix (7), Travis Walton (4). Top-Kategorien: Sichtungsbericht (15)." Button: "Alle Stories dieses Zeitraums im Archiv anzeigen".

*Vergleichsmodus.* Zwei Entity-Timelines übereinanderlegen: "Wann wird Entity A erwähnt vs. Entity B?" Visuell sofort erkennbar, ob zeitliche Korrelation besteht.

### A.4 Karten-View `/map`

Fehlend. Wenn die Entity-Taxonomie Orte mit Geocoordinaten enthält, ist eine geografische Ansicht ein offensichtlicher und mächtiger View.

**Zweck:** Geografische Visualisierung aller Ort-Entities und der mit ihnen verknüpften Stories.

**Layout:** Karte als Vollbild, Filter-Panel und Legende als Overlays.

**Komponenten:**

*Karte (Hauptbereich).* Interaktive Karte (Leaflet/Mapbox). Ort-Entities als Marker. Marker-Größe proportional zur Anzahl verknüpfter Stories. Marker-Farbe nach Story-Kategorie, Phänomen-Typ, oder Zeitraum (umschaltbar). Cluster-Verhalten bei Herauszoomen.

*Klick auf Marker.* Popup mit: Ortsname, Anzahl Stories, Liste der Top-Stories an diesem Ort, Entity-Verbindungen. Link zur Entity-Detail-Seite.

*Filter-Panel.* Zeitraum-Slider (filtert Stories nach Datum → zeigt nur Orte die im Zeitraum vorkommen). Entity-Filter, Kategorie-Filter. Heatmap-Toggle (statt einzelner Marker eine Heatmap der Ereignisdichte).

*Verbindungslinien.* Optional: Linien zwischen Orten, die in derselben Story erwähnt werden. Visualisiert räumliche Zusammenhänge.

**Hinweis zur Domain Configuration:** Dieser View wird nur angezeigt, wenn mindestens ein Entity-Typ in der Taxonomie das Attribut "Geocoordinaten" hat. Ansonsten fehlt er in der Navigation — das ist ein Beispiel für UI die sich dynamisch an die Konfiguration anpasst.

### A.5 Activity Log `/activity`

Fehlend. Bei einer Community von 2–10 Personen, die gemeinsam an einem Datenbestand arbeiten, braucht es Transparenz über alle Änderungen.

**Zweck:** Vollständiges Audit-Log aller Systemaktivitäten. Nachvollziehbarkeit und Accountability.

**Layout:** Chronologische Liste (neueste zuerst), Filter-Toolbar oben.

**Komponenten:**

*Event-Liste.* Pro Eintrag: Zeitstempel, Nutzer (Avatar + Name), Aktion (Upload, Review, Merge, Edit, Delete, Config-Änderung, etc.), betroffenes Objekt (klickbar: Source, Story, Entity, Board), Detail-Auszug (z.B. "Hat den Titel von 'Untitled' zu 'Die Lichter über Phoenix' geändert").

*Filter.* Nach Nutzer, nach Aktionstyp, nach Objekttyp, nach Zeitraum.

*Relevanz für Review-Workflow.* Zeigt, wer eine Story reviewed hat — und erlaubt damit Nachvollziehbarkeit bei Unstimmigkeiten.

---

## B. Fehlende Flows

### B.1 Fehlerbehandlung bei Processing

Das Hauptkonzept beschreibt den Happy Path der Processing Pipeline, aber nicht was passiert wenn es schiefgeht.

**Fehlerquellen:** Korrupte PDFs, passwortgeschützte PDFs, extrem niedrige Scan-Qualität (OCR versagt), unbekannte Sprache, PDF enthält nur Bilder ohne erkennbaren Text, Processing-Timeout bei sehr großen Dokumenten.

**Flow:**

**Schritt 1 — Fehler tritt auf (System).** Die Processing Pipeline schlägt bei einem bestimmten Schritt fehl. Das Dokument bekommt den Status "Error" mit konkreter Fehlermeldung und dem Schritt, bei dem der Fehler auftrat.

**Schritt 2 — Benachrichtigung (System).** Der Uploader wird benachrichtigt: "Verarbeitung von [Titel] fehlgeschlagen: [Grund]". Der Eintrag erscheint rot markiert in der Processing Queue und in der Bibliothek.

**Schritt 3 — Fehlerbehebung (User).** Je nach Fehlertyp verschiedene Optionen: "Erneut versuchen" (bei transienten Fehlern), "PDF ersetzen" (bei korrupter Datei — neuer Upload, Metadaten bleiben), "Manuell fortfahren" (z.B. bei partiellem OCR-Fehler: die erkannten Seiten werden verarbeitet, problematische Seiten übersprungen und markiert), "Löschen" (Dokument komplett entfernen). Bei partiellen Fehlern: Pro-Seiten-Status, damit der Nutzer sieht welche Seiten problematisch sind.

### B.2 Duplikat-Erkennung

Nicht behandelt. Bei hunderten Magazinen ist es wahrscheinlich, dass dasselbe PDF versehentlich zweimal hochgeladen wird.

**Flow:**

**Schritt 1 — Upload (User).** Beim Upload prüft das System automatisch auf mögliche Duplikate — per Datei-Hash (exakte Duplikate) und per Metadaten-Ähnlichkeit (z.B. gleicher Titel + Ausgabe).

**Schritt 2 — Duplikat-Warnung (System).** Falls ein Duplikat-Kandidat gefunden wird: "Dieses Dokument ist möglicherweise bereits vorhanden: [Titel, Upload-Datum]. Möchtest du trotzdem fortfahren?" Optionen: "Trotzdem hochladen", "Upload abbrechen", "Bestehendes Dokument anzeigen".

**Schritt 3 — Nachträgliche Erkennung.** Auch nach dem Upload: Die KI kann beim Vergleich der extrahierten Stories feststellen, dass zwei Sources nahezu identischen Content haben. In dem Fall: Hinweis in der Bibliothek, Option zum Mergen oder Löschen des Duplikats.

### B.3 Entity-Deduplizierung (Merge-Flow)

Im Hauptkonzept erwähnt, aber nicht als vollständiger Flow beschrieben. Das ist einer der häufigsten und wichtigsten Workflows — Entities kommen in verschiedenen Schreibweisen vor ("J. Allen Hynek" / "Dr. Hynek" / "Josef A. Hynek").

**Flow:**

**Schritt 1 — Merge-Vorschlag entsteht.** Entweder: KI schlägt automatisch vor (Namens-Similarity + Co-Occurrence-Muster), oder: Nutzer erkennt im Graph/in der Entity-Liste, dass zwei Entities identisch sind.

**Schritt 2 — Merge-Preview.** Das System zeigt: welche Entity wird die "Primäre" (Vorschlag: die mit mehr Erwähnungen), welche Aliase werden zusammengeführt, wie viele Stories/Connections sind betroffen, Preview des resultierenden Graph-Ausschnitts. Der Nutzer wählt den kanonischen Namen und bestätigt.

**Schritt 3 — Merge ausführen (System).** Alle Story-Referenzen der sekundären Entity werden auf die primäre übertragen. Connections werden zusammengeführt (Duplikat-Connections werden dedupliziert, Confidence-Scores werden neu berechnet). Vektor-Embeddings der betroffenen Stories werden nicht verändert (der Text bleibt gleich), aber der Graph wird aktualisiert.

**Schritt 4 — Undo.** Merges sind reversibel — innerhalb eines Zeitfensters (z.B. 30 Tage) kann ein Merge rückgängig gemacht werden. Danach wird der Merge permanent.

### B.4 Lösch-Flows (Kaskaden)

Komplett fehlend. Was passiert, wenn jemand eine Source, Story oder Entity löscht?

**Source löschen.** Warnung: "Diese Source enthält X Stories mit Y Entities. Löschen entfernt die Source, alle zugehörigen Stories und alle Entities die nur in diesen Stories vorkommen." Optionen: "Löschen" (mit Kaskadeneffekt) oder "Nur Source-PDF entfernen, Stories behalten" (Stories werden zu "verwaisten" Stories ohne Quell-Referenz). Entities die auch in anderen Stories vorkommen, bleiben erhalten. Zweistufige Bestätigung (Titel eintippen).

**Story löschen.** Warnung: "Entities die nur in dieser Story vorkommen, werden ebenfalls entfernt: [Liste]." Board-Referenzen auf diese Story werden als "gelöschte Story" markiert (nicht stillschweigend entfernt — das Board soll seine Struktur behalten).

**Entity löschen.** Warnung: "Diese Entity wird aus X Stories entfernt und Y Connections gelöscht." Keine Auswirkung auf Story-Text — nur die Entity-Markierung und Graph-Einträge werden entfernt.

**Generell:** Alle Löschungen erscheinen im Activity Log. Soft-Delete mit 30-Tage-Papierkorb (Admin kann endgültig löschen).

### B.5 Re-Processing

Nicht behandelt. Ein wichtiger Workflow: die KI verbessert sich über die Zeit (besserer KI-Kontext, besseres Modell), und bereits verarbeitete Dokumente sollen erneut analysiert werden.

**Flow:**

**Schritt 1 — Trigger (Admin/System).** Manuell: Admin wählt in der Bibliothek einzelne Sources oder alle Sources und klickt "Erneut verarbeiten". Automatisch: Nach Änderung des KI-Kontexts bietet das System an, betroffene Sources neu zu analysieren.

**Schritt 2 — Scope wählen (Admin).** "Was soll neu verarbeitet werden?" Optionen: nur OCR (bei besserem OCR-Modell), nur Segmentierung (bei besserem KI-Kontext), nur Entity-Extraction (bei geänderter Taxonomie), alles. Zusätzlich: "Bestehende Reviews behalten?" (ja = manuell korrigierte Stories werden nicht überschrieben, nur neue/unreviewed Stories werden aktualisiert; nein = alles wird neu extrahiert).

**Schritt 3 — Diff-Preview (System).** Bei Re-Processing einer bereits verarbeiteten Source zeigt das System einen Diff: welche Stories wurden neu erkannt, welche sind weggefallen, welche haben sich verändert. Der Nutzer kann selektiv annehmen.

### B.6 Daten-Import & -Export

Export wird unter Settings erwähnt, aber Import gar nicht. Für ein Open-Source-Tool ist Datenportabilität essentiell.

**Export-Formate:** Vollständiger Datenbank-Dump (JSON). Story-Archiv als CSV (für Weiterverarbeitung in anderen Tools). Knowledge Graph als GraphML oder JSON-LD (für Import in andere Graph-Tools). Evidence Boards als JSON (Struktur + Referenzen). Einzelne Stories als Markdown oder PDF.

**Import:** Von einer anderen ARCHON-Instanz (JSON-Dump). Importiert Sources, Stories, Entities, Connections, Boards. Konflikte werden angezeigt (z.B. gleiche Entity existiert bereits). Selektiver Import möglich (nur bestimmte Sources oder Stories).

---

## C. Fehlende Interaktionen

### C.1 Gespeicherte Suchen & Alerts

Komplett fehlend. Bei einer wachsenden Datenbasis will der Researcher benachrichtigt werden, wenn neues Material zu seinem Interessengebiet hinzukommt.

**Interaktion:** In der Story-Suche: "Diese Suche speichern"-Button. Gespeicherte Suchen erscheinen als Liste im persönlichen Bereich. Option pro Suche: "Alert aktivieren" — bei jeder neuen Story die der Suche entspricht, wird der Nutzer benachrichtigt. Alerts erscheinen als eigene Sektion auf dem Dashboard.

### C.2 Bookmarks / Favoriten

Fehlend. Ein einfaches, aber wichtiges Feature für Researcher die sich durch hunderte Stories arbeiten.

**Interaktion:** Stern-/Lesezeichen-Icon auf jeder Story-Karte, Entity-Karte, Board-Karte, und Source-Karte. Persönliche Bookmark-Liste unter `/bookmarks` oder als Tab im persönlichen Bereich. Optional: Bookmark-Ordner für thematische Gruppierung.

### C.3 User-definierte Tags

Die konfigurierten Kategorien und Entity-Typen sind system-weit. Es fehlt ein persönliches oder team-weites Tagging-System.

**Interaktion:** Auf Story-Ebene: Freitext-Tags hinzufügen (z.B. "noch überprüfen", "widersprüchlich", "Schlüsselbericht"). Tags sind für alle sichtbar. Tag-Autocomplete gegen bestehende Tags. Filter im Story-Archiv nach Tags. Tags sind nicht teil der Domain Configuration, sondern entstehen organisch durch die Community.

### C.4 Explizite Story-Querverweise

Im Hauptkonzept entstehen Verbindungen zwischen Stories implizit (über geteilte Entities oder semantische Ähnlichkeit). Es fehlt die Möglichkeit, explizite Querverweise zu setzen.

**Interaktion:** In der Story-Detail-Ansicht: "Querverweis hinzufügen"-Button. Öffnet Suchfeld, Nutzer wählt eine andere Story. Verbindung wird erstellt mit optionalem Label (z.B. "widerspricht", "bestätigt", "erweitert", "Quelle für"). Diese expliziten Querverweise erscheinen in der Story-Detail-Ansicht als eigene Sektion und im Knowledge Graph als besonderer Kanten-Typ (visuell unterscheidbar von Co-Occurrence-Kanten).

### C.5 Undo / Review zurückziehen

Im Hauptkonzept ist der Review-Approve irreversibel. Das ist problematisch — Fehler passieren.

**Interaktion:** In der Story-Detail-Ansicht: "Review zurückziehen"-Option. Setzt die Story zurück auf "Needs Review". Optionales Kommentarfeld ("Zurückgezogen weil: ..."). Erscheint im Activity Log. Nur der Original-Reviewer oder ein Admin kann zurückziehen.

### C.6 Annotation auf PDF-Seiten

Im Review können Textblöcke zugeordnet werden, aber es gibt keine Möglichkeit, Anmerkungen direkt auf der PDF-Seite zu hinterlassen — für Inhalte, die nicht als Story extrahiert werden, aber trotzdem relevant sind (z.B. ein Foto, eine Grafik, eine Karte im Magazin).

**Interaktion:** In der Source-Detail-Ansicht (6.3): Button "Seite annotieren". Nutzer kann auf der PDF-Seite Bereiche markieren und Freitext-Notizen daran heften. Annotationen erscheinen als Layer über der PDF-Ansicht. Sind durchsuchbar. Können auf Evidence Boards gezogen werden.

### C.7 Concurrent-Edit-Handling

Bei 2–10 Nutzern die gleichzeitig arbeiten: Was passiert, wenn zwei Researcher dieselbe Story reviewen oder dasselbe Board bearbeiten?

**Stories:** Optimistic Locking. Wenn User A eine Story öffnet und User B sie bereits bearbeitet, sieht User A einen Hinweis: "[Name] bearbeitet diese Story gerade." User A kann trotzdem öffnen (Lesemodus), oder warten. Beim Speichern: Falls sich der zugrunde liegende Stand verändert hat, wird ein Diff gezeigt und der Nutzer kann seine Änderungen darauf anwenden.

**Boards:** Echtzeit-Kollaboration (wie bei Miro/Figma). Cursor anderer Nutzer sichtbar. Kartenverschiebungen werden in Echtzeit synchronisiert. Textbearbeitung auf Karten: Lock pro Karte (wer bearbeitet, hat den Lock; andere sehen "wird bearbeitet").

---

## D. Fehlende Zustände & Edge Cases

### D.1 Error States

Das Hauptkonzept beschreibt leere Zustände, aber nicht Fehlerzustände.

**Netzwerk-Fehler.** Offline-Indikator in der Top-Navigation. Lokale Änderungen werden gecacht und beim Reconnect synchronisiert (zumindest für Board-Edits und Reviews).

**Processing-Fehler.** Pro-Seiten-Fehlerstatus in der Source-Detail-Ansicht. Fehlgeschlagene Seiten sind rot markiert mit Fehlergrund. Möglichkeit, einzelne Seiten erneut zu verarbeiten.

**KI-Service nicht erreichbar.** Degraded Mode: Upload und manuelle Bearbeitung funktionieren weiterhin. KI-abhängige Features (Auto-Segmentierung, Entity-Extraction, Vorschläge) zeigen "KI-Service nicht verfügbar — manuelle Eingabe möglich". Queue hält Jobs und verarbeitet sie, sobald der Service wieder da ist.

### D.2 Performance bei Skalierung

Bei hunderten Magazinen und tausenden Stories/Entities muss das Konzept Performance-Strategien zeigen.

**Graph-View.** Bei >5.000 Entities wird der Force-Directed Graph träge. Lösung: Progressive Loading — zeige initial nur die Top-100-Entities (meiste Verbindungen). "Mehr laden"-Button oder Zoom-basiertes Nachladen. Cluster-Ansicht als Standard bei großen Graphen. Server-Side Graph-Layout für die initiale Positionierung.

**Story-Archiv.** Virtuelle Scrolling-Liste (nicht alle Stories auf einmal rendern). Pagination oder Infinite Scroll. Facetten-Filter reduzieren die Ergebnismenge serverseitig.

**Suche.** Debouncing bei Autocomplete. Serverseitige Vektor-Suche mit Limit. Caching häufiger Suchanfragen.

### D.3 Mehrsprachige Inhalte

Nicht behandelt. Ein Magazin kann gemischtsprachige Artikel enthalten (z.B. UFO-Magazine mit englischen Originalberichten in einem deutschen Magazin).

**Handling:** Die KI erkennt die Sprache pro Story automatisch. Sprache wird als Metadatum der Story gespeichert. Filter im Story-Archiv nach Sprache. Der KI-Kontext kann Hinweise zur Mehrsprachigkeit enthalten. Semantische Suche funktioniert sprachübergreifend (Vektor-Embeddings sind multilingual). Optionale maschinelle Übersetzung pro Story als Service.

### D.4 Nicht-Text-Inhalte

Im Hauptkonzept werden Bilder zwar bei der Layout-Analyse erkannt, aber ihr weiterer Weg ist unklar.

**Bilder in Stories.** Bilder die einem Artikel zugeordnet sind (Fotos, Illustrationen), werden als Anhänge der Story gespeichert. In der Story-Detail-Ansicht: Bild-Galerie unter dem Text. Bilder sind mit der Story verknüpft und tauchen auf Evidence Boards auf.

**Bildunterschriften.** Die KI extrahiert Bildunterschriften und ordnet sie dem zugehörigen Bild und der zugehörigen Story zu.

**Tabellen und Diagramme.** Werden als Bilder extrahiert und der Story zugeordnet. Optional: Tabellen-OCR, das strukturierte Daten aus tabellarischen Inhalten extrahiert.

---

## E. Ergänzungen zum Datenmodell

### E.1 Fehlende Entitäten

**Annotation** — Eine nutzererstellte Anmerkung auf einer PDF-Seite. Attribute: Bounding Box (Position auf der Seite), Seiten-Referenz, Freitext, Ersteller, Erstelldatum.

**Tag** — Ein nutzerdefiniertes Label auf Story-Ebene. Attribute: Name, Farbe (optional), Ersteller.

**SavedSearch** — Eine gespeicherte Suchanfrage. Attribute: Query-String, Filter-Konfiguration, Ersteller, Alert aktiv (ja/nein).

**Bookmark** — Eine Nutzer-Favoriten-Markierung. Attribute: Nutzer, Objekt-Referenz (polymorph: Story, Entity, Board, Source), Ordner (optional).

**CrossReference** — Ein expliziter Querverweis zwischen zwei Stories. Attribute: Source-Story, Target-Story, Label (widerspricht/bestätigt/erweitert/etc.), Ersteller.

**AuditEvent** — Ein Eintrag im Activity Log. Attribute: Zeitstempel, Nutzer, Aktionstyp, Objekt-Referenz, Detail-JSON, IP (optional).

### E.2 Fehlende Attribute auf bestehenden Entitäten

**Source:** Sprache (erkannt oder manuell), Fehler-Status und -Nachricht, Duplikat-Gruppe (Referenz auf potenzielle Duplikate), Re-Processing-Historie.

**Story:** Sprache (automatisch erkannt), User-Tags (Liste), Querverweise (ein- und ausgehend), Bilder/Anhänge (Liste), Bearbeitungshistorie (Versionierung des extrahierten Texts), zuletzt bearbeitet von, Review-Historie (wer hat wann approved/zurückgezogen).

**Entity:** Merge-Historie (welche Entities wurden in diese gemerged), Status (KI-vorgeschlagen / nutzerbestätigt / manuell erstellt), Erstellt-durch (KI oder manuell), "nicht mergen mit" (dauerhaft als unterschiedlich markierte Entities).

**Board:** Template-Flag (ist dieses Board ein Template, das kopiert werden kann), Zugriffsrechte (privat / team / public), Kommentare (Thread-basiert), Snapshot-Historie.

---

## F. Ergänzungen zur Navigation

### F.1 Aktualisierte Hauptnavigation

Durch die neuen Seiten erweitert sich die Navigation. Nicht alle neuen Views brauchen einen Top-Level-Eintrag — einige sind Unter-Views oder über andere Wege erreichbar.

**Top-Navigation (primär, 6 Einträge):**
Dashboard `/` — Entities `/entities` — Sources `/sources` — Stories `/stories` — Graph `/graph` — Boards `/boards`

**Sub-Navigation / über Kontext erreichbar:**
Timeline `/timeline` — erreichbar über Graph-Toolbar ("Timeline-Ansicht") und über Story-Archiv ("Als Timeline anzeigen").
Map `/map` — erreichbar über Graph-Toolbar ("Karten-Ansicht"), nur wenn Geo-Entities konfiguriert.
Activity `/activity` — erreichbar über Dashboard ("Alle Aktivitäten") und über Top-Nav Nutzer-Menü.
Bookmarks `/bookmarks` — erreichbar über Nutzer-Menü.
Settings `/settings` — erreichbar über Nutzer-Menü (nicht in der Haupt-Reihe).

### F.2 Globale Benachrichtigungen

Fehlte im Hauptkonzept als UI-Element. Ein Glocken-Icon in der Top-Navigation mit Zähler. Dropdown zeigt: neue KI-Discoveries, zugewiesene Reviews, Mentions in Kommentaren, Alerts von gespeicherten Suchen, Processing-Fehler, Merge-Vorschläge. Klick auf Benachrichtigung führt zum relevanten Kontext.

---

## G. Querschnittsthemen

### G.1 Accessibility

Nicht erwähnt. Für ein Open-Source-Projekt sollten Accessibility-Grundlagen definiert sein.

Alle interaktiven Elemente müssen per Keyboard erreichbar sein (nicht nur die Review-Shortcuts). ARIA-Labels für alle dynamisch generierten UI-Elemente (besonders wichtig, da die UI sich aus der Domain Configuration speist). Farbschema muss WCAG-AA-kontrast-konform sein — die Entity-Typ-Farben müssen im Konfigurationseditor gegen einen Kontrastchecker geprüft werden. Screen-Reader-Kompatibilität für den Graph-View: alternative tabellarische Darstellung der Verbindungen. Reduzierte-Bewegung-Option für Animationen im Graph und auf dem Board.

### G.2 Permissions-Modell (Verfeinerung)

Das Drei-Rollen-Modell (Admin, Researcher, Viewer) ist ein guter Start, aber es fehlt Granularität.

**Board-Level-Permissions.** Privat (nur Ersteller), Team (alle Researcher), Public (auch Viewer). Pro Board konfigurierbar.

**Review-Permissions.** Wer darf "Flag for Expert" bearbeiten? Vorschlag: Nur Researcher mit einer gewissen Erfahrung (z.B. >50 Reviews abgeschlossen) oder explizit als "Expert" getaggt.

**Delete-Permissions.** Wer darf Sources/Stories/Entities löschen? Vorschlag: Nur Admin und der Original-Uploader (für Sources). Entity-Löschung nur Admin.

**Config-Permissions.** Die Domain Configuration ist Admin-only — aber einzelne Bereiche könnten für Researcher geöffnet werden (z.B. Story-Kategorien anpassen, nicht aber die KI-Kontext oder Taxonomie).

### G.3 KI-Kosten-Transparenz

Bei hunderten Magazinen entstehen reale KI-Kosten (LLM-Calls für Segmentierung, Entity-Extraction, Embedding). Das Konzept erwähnt die KI-Pipeline, aber nicht die Kosten-Transparenz.

**Im Dashboard:** "KI-Verbrauch diesen Monat: ~X API-Calls, geschätzte Kosten: Y €". Trend-Indikator.

**Im Settings:** Konfiguration des LLM-Providers (welches Modell, API-Key). Kosten-Limits (z.B. "Stoppe automatische Verarbeitung wenn monatliches Budget überschritten"). Wahl zwischen Qualität und Kosten (kleines/schnelles Modell für einfache Extraktion, großes Modell für Entity-Extraction und Vorschläge).

**Pro Source:** Anzeige wie viele KI-Calls die Verarbeitung verbraucht hat. Hilft bei der Entscheidung, ob Re-Processing den Aufwand wert ist.

### G.4 Daten-Lifecycle & Retention

Nicht behandelt. Braucht Policies für: wie lange bleiben gelöschte Objekte im Papierkorb (Vorschlag: 30 Tage, Admin-konfigurierbar), wie lange werden Processing-Logs aufbewahrt, Audit-Log-Retention (Vorschlag: unbegrenzt, da es für ein Archiv-Projekt genau darum geht, Herkunft nachvollziehbar zu machen).

### G.5 API & Integrationen

Für ein Open-Source-Framework essentiell, im UX-Konzept aber nicht als User-Facing-Feature beschrieben.

**REST/GraphQL API.** Alle Daten die in der UI verfügbar sind, sind auch über eine API erreichbar. Authentifizierung per API-Key (generierbar in Settings). Ermöglicht: externe Tools anbinden, Automatisierungen bauen, Daten in andere Systeme synchronisieren.

**Webhook-System.** Konfigurierbare Webhooks für Events: neues Dokument verarbeitet, neue Entities entdeckt, neuer KI-Vorschlag. Ermöglicht Integration in bestehende Workflows (z.B. Slack-Notification bei neuer Discovery).

**API-Dokumentation.** Erreichbar über Settings oder als eigene Seite `/api-docs`. Auto-generiert aus den API-Endpunkten. Interaktives Testen direkt in der Dokumentation.
