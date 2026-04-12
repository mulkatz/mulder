---
date: 2026-04-12
type: implementation
title: Evidence chains land in `mulder analyze --evidence-chains`
tags: [evidence, analyze, graph, retrieval, m6]
---

`mulder analyze --evidence-chains` now persists thesis-specific graph paths into `evidence_chains` instead of leaving G5 as a placeholder. The shipped slice stays deterministic: thesis strings resolve through Mulder's existing query-entity matching, supporting paths use the established recursive traversal pattern, and confirmed contradictions are stored as non-supporting evidence for the same thesis snapshot. The non-obvious part was keeping the snapshots idempotent without schema changes, so each thesis run now replaces its prior rows instead of appending duplicates. This keeps the Analyze command extensible for G6 and G7 while making evidence export and review flows work against stored results immediately.
