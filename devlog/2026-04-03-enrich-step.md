---
date: 2026-04-03
type: implementation
title: Enrich step — entity extraction pipeline complete
tags: [pipeline, enrich, taxonomy, entity-resolution]
---

The Enrich step (C8) brings together three previously built building blocks — JSON Schema generator, pg_trgm taxonomy normalization, and 3-tier cross-lingual entity resolution — into the fourth pipeline step. Stories go in as Markdown, entities and relationships come out in PostgreSQL. Pre-chunking handles oversized stories by splitting at paragraph boundaries before extraction. Deadlock prevention via lexicographic entity sorting ensures safe concurrent enrichment. With this step, the full extraction pipeline (ingest → extract → segment → enrich) is operational end-to-end.
