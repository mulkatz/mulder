# Mulder — Delta: Devlog System

Erstelle das Verzeichnis `devlog/` im Repo-Root und aktualisiere die CLAUDE.md mit den Devlog-Regeln. Erstelle KEINEN initialen Devlog-Eintrag — das passiert automatisch bei der nächsten signifikanten Änderung.

---

## Devlog-System

Das Verzeichnis `devlog/` enthält kurze, strukturierte Einträge über signifikante Projekt-Fortschritte. Diese werden automatisch auf eine Website deployed und dienen als öffentliches Build Log des Projekts.

### Dateiformat

Verzeichnis: `devlog/`
Dateinamen: `{YYYY-MM-DD}-{slug}.md`
Bei mehreren Einträgen am selben Tag: `{YYYY-MM-DD}-{slug-a}.md`, `{YYYY-MM-DD}-{slug-b}.md`

### Aufbau jedes Eintrags

```markdown
---
date: 2026-03-28
type: architecture
title: "Kurzer, konkreter Titel"
tags: [relevante, technische, tags]
---

2-5 Sätze. Was wurde gemacht oder entschieden, und was ist das
Ergebnis. Kein Filler, kein "heute habe ich", keine Einleitung.
Direkt zum Punkt. Technisch genug dass ein Entwickler es versteht,
kurz genug dass man es in 15 Sekunden liest.
```

### Type-Werte

- `architecture` — Strukturelle Entscheidung, System-Design
- `implementation` — Feature oder Pipeline-Step erstmals funktionsfähig
- `breakthrough` — Nicht-offensichtliches technisches Problem gelöst
- `decision` — Technologie-Wahl, Tradeoff-Entscheidung
- `refactor` — Signifikante Umstrukturierung mit konzeptuellem Hintergrund
- `integration` — GCP-Service oder externe Komponente erstmals angebunden
- `milestone` — Übergeordneter Projektmeilenstein

### Wann loggen

Erstelle einen Devlog-Eintrag wenn:
- Eine neue Capability oder ein Pipeline-Step erstmals funktioniert
- Eine Architektur-Entscheidung getroffen oder revidiert wird
- Ein nicht-offensichtliches technisches Problem gelöst wird
- Ein GCP-Service zum ersten Mal integriert wird
- Ein signifikanter Refactor die Struktur verändert (mit Begründung)
- Ein Meilenstein erreicht wird (z.B. "erste PDF erfolgreich durch die volle Pipeline")

### Wann NICHT loggen

Kein Devlog-Eintrag bei:
- Routine-Refactoring ohne konzeptuelle Änderung
- Bug-Fixes
- Dependency-Updates
- Code-Formatierung, Linting, Typo-Korrekturen
- Reine Test-Ergänzungen ohne neues Feature
- Wiederholte Iterationen am selben Feature (nur den Durchbruch loggen, nicht jeden Versuch)

### Stil

- Direkt, technisch, konkret
- Kein "Heute habe ich...", kein "In diesem Eintrag..."
- Aktive Sprache: "Extraction-Pipeline nutzt jetzt Document AI Layout Parser mit Gemini-Fallback"
- Englisch (das Repo und die Zielgruppe sind international)
- Max 5 Sätze pro Eintrag. Wenn es mehr braucht, ist es wahrscheinlich zwei Einträge.

---

## Änderungen an CLAUDE.md

Neuer Abschnitt **"Devlog"** (nach "Testing" oder am Ende):

```markdown
## Devlog

- Directory: `devlog/`, files: `{YYYY-MM-DD}-{slug}.md`
- Frontmatter: `date`, `type`, `title`, `tags`
- Types: architecture | implementation | breakthrough | decision | refactor | integration | milestone
- Write entry when: new capability works, architecture decision made/revised, non-obvious problem solved, GCP service first integrated, significant refactor, milestone reached
- Skip when: routine refactoring, bug fixes, dependency updates, formatting, repeated iterations
- Style: English, direct, technical, max 5 sentences, no filler
```

## Änderungen an Repo-Struktur

Ergänze in der Repo-Struktur:

```
mulder/
├── devlog/              # Public build log, auto-deployed to website
├── ...
```
