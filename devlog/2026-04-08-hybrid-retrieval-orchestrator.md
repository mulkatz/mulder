---
date: 2026-04-08
type: milestone
title: Hybrid retrieval orchestrator + `mulder query` — M4 complete, v1.0 MVP ships
tags: [retrieval, cli, rrf, rerank, m4, milestone]
---

M4 is done. `hybridRetrieve()` wires the three retrieval strategies (vector E1, fulltext E2, graph E3), RRF fusion (E4), and Gemini Flash re-ranking (E5) behind a single library call, and `mulder query "<question>"` ships the same pipeline in the terminal with `--strategy`, `--top-k`, `--no-rerank`, `--explain`, and `--json` flags. The orchestrator runs active strategies in parallel via `Promise.allSettled`, so a single-strategy failure is captured in the explain block without crashing the call. Query entity extraction for the graph strategy stays deterministic and keyword-based: tokenize on whitespace and punctuation, generate 1/2/3-gram phrases capped at 100, resolve them with `findEntityByAlias`, and cap the final seed list at 20. Every result carries the §5.3 confidence object so consumers know whether to trust the ranking at the current corpus scale.
