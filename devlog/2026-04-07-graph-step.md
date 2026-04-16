---
date: 2026-04-07
type: implementation
title: Graph step — dedup, corroboration, contradiction flagging
tags: [pipeline, graph, m4]
---

`mulder graph <story-id>` now closes the M4-D5 loop by loading the story's entities, materializing RELATIONSHIP edges from the existing `entity_edges` table with idempotent re-upserts, running MinHash dedup against similar embeddings, recomputing dedup-aware corroboration scores, and flagging potential contradictions via attribute-level diffs. Contradiction edges are stored as self-loops on the canonical entity with both conflicting claim story IDs in `attributes.storyIdA / storyIdB`. The deliberate non-LLM design keeps the step pure SQL/computation, so it can run in seconds against thousands of stories and is safe to re-execute after enrich-quality changes without burning Gemini tokens. A non-obvious decision was to make the `co_occurs_with` fallback opt-in instead of always-on, because a 100-entity story would otherwise fan out into 4950 edges and dilute the signal. The fallback is now gated behind `graph.cooccurrence_fallback: false` by default, and M6 G3 Analyze will load contradiction edges by `edge_type` and read the conflict fields directly from JSONB.
