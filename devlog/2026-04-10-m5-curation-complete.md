---
date: 2026-04-10
type: milestone
title: M5 Curation Complete — Taxonomy + Entity Management + Export
tags: [milestone, cli, taxonomy, export]
---

M5 wraps up the human-in-the-loop curation layer. Taxonomy bootstrap generates initial categories from corpus data, curate/merge gives humans control, entity management handles aliases and merges, status overview shows system health, and export commands enable interoperability with Neo4j (Cypher), Gephi (GraphML), and spreadsheets (CSV). All five steps ship CLI-first with structured JSON output for scripting. The export formatters are pure functions — no DB calls, no side effects — making them easy to reuse when the API layer lands in M7.
