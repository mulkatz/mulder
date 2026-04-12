---
date: 2026-04-12
type: implementation
title: Source reliability scoring ships in `mulder analyze --reliability`
tags: [evidence, analyze, reliability, pagerank, m6]
---

`mulder analyze --reliability` now computes and persists the roadmap’s first-pass `sources.reliability_score` signal from the existing corpus graph instead of leaving G4 as a stub. The implementation builds a source graph from cross-source shared entities, runs a weighted PageRank-style pass, normalizes the scores into `0..1`, and prints a dedicated CLI table plus sparse-corpus warnings without changing the existing contradiction flow. The non-obvious part was separating true no-op runs from graph shrinkage: reruns now clear stale scores only for sources that fall out of an otherwise valid graph, while fully disconnected corpora stay spec-compliant no-ops. The analyze contracts are now selector-aware, so later evidence-chain or credibility-profile work can extend the command surface without rewriting this reliability slice.
