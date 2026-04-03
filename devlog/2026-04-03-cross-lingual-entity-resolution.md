---
date: 2026-04-03
type: implementation
title: Cross-lingual entity resolution — 3-tier strategy
tags: [entity-resolution, pgvector, PostGIS, embeddings, cross-lingual]
---

# Cross-lingual entity resolution — 3-tier strategy

Implemented the 3-tier entity resolution module (C7) that detects when entities extracted from different documents refer to the same real-world thing — across languages and name variants. Tier 1 does deterministic attribute matching (Wikidata IDs, PostGIS geo_point proximity within 100m). Tier 2 uses `text-embedding-004` cosine similarity on entity names via pgvector HNSW index. Tier 3 escalates Tier 2 near-misses to Gemini for semantic resolution. Each tier is independently configurable via `entity_resolution.strategies` in the config. On match, the new entity's `canonical_id` points to the existing one and its name is added as an alias — no separate SAME_AS edges needed. Migration 017 adds the `name_embedding vector(768)` column with HNSW index to the entities table.
