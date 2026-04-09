---
date: 2026-04-07
type: implementation
title: Graph step — dedup, corroboration, contradiction flagging
tags: [pipeline, graph, m4]
---

`mulder graph <story-id>` now closes the M4-D5 loop: it loads the story's entities, materializes RELATIONSHIP edges from the existing entity_edges table (re-upserting for idempotency), runs MinHash dedup against other stories with similar embeddings, recomputes corroboration scores from the dedup-aware independent-source count, and flags potential contradictions via attribute-level diffs. Contradiction edges are stored as self-loops on the canonical entity with both conflicting claim story IDs in `attributes.storyIdA / storyIdB` — claims aren't first-class rows, so the edge sits on the entity and the JSONB carries the variant payload. The deliberate non-LLM design keeps the graph step pure SQL/computation, which means it can run in seconds against thousands of stories and is safe to re-execute after enrich-quality changes without burning Gemini tokens. The most non-obvious decision was making the `co_occurs_with` fallback opt-in rather than always-on: a 50-entity story would otherwise produce 1225 edges and a 100-entity story 4950, signal-diluting the entity_edges table at archive scale. The fallback is now gated behind `graph.cooccurrence_fallback: false` (default off) so only callers who explicitly need co-occurrence data pay that cost. M6 G3 Analyze will load these contradiction edges by edge_type and read the conflict fields directly from JSONB to build resolution prompts.
