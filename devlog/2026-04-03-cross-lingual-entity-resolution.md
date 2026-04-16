---
date: 2026-04-03
type: implementation
title: Cross-lingual entity resolution — 3-tier strategy
tags: [entity-resolution, pgvector, PostGIS, embeddings, cross-lingual]
---

Implemented the 3-tier entity resolution module (C7) for cross-language entity matching across document variants. Tier 1 handles deterministic attribute matching with Wikidata IDs and PostGIS `geo_point` proximity within 100m, Tier 2 uses `text-embedding-004` cosine similarity via the pgvector HNSW index, and Tier 3 escalates near-misses to Gemini for semantic resolution. Each tier is independently configurable via `entity_resolution.strategies`. On a match, the new entity's `canonical_id` points to the existing one and the alias is preserved on the entity record. Migration 017 adds the `name_embedding vector(768)` column with an HNSW index.
