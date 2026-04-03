---
date: 2026-04-03
type: implementation
title: Taxonomy normalization with pg_trgm trigram matching
tags: [taxonomy, pg_trgm, normalization, M3]
---

Taxonomy repository and normalization function now live in `@mulder/core` (repository) and `@mulder/taxonomy` (normalize). Uses PostgreSQL `pg_trgm` similarity for fuzzy matching entity names against the taxonomy table — searches both canonical names and the aliases array via `unnest`. Rejected entries are excluded from matches, confirmed entries are never modified. Default similarity threshold is 0.4, configurable via `taxonomy.normalization_threshold`. This is the inline layer the Enrich step will call for every extracted entity.
