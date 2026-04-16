---
date: 2026-04-16
type: implementation
title: H11 closes with the first browser Case File viewer
tags: [demo, frontend, m7, m7.5, h11]
---

The demo app now runs against the real browser-safe API boundary instead of the earlier mock-heavy shell. This closes H11 and M7.5-V1 with a split-view Case File: authenticated session bootstrap, archive list, streamed PDF rendering through PDF.js, page thumbnails, derived story rail, entity pills with hover details, and a reusable entity profile drawer. The interesting tradeoff was story derivation, because the H10 contract streams layout markdown but not a single-document viewer payload, so the implementation stitches together layout text, entity catalog matches, and the existing document observability metadata already exposed by the API. That keeps the demo inside the current backend surface while making the first Hero 1 and Hero 2 interactions feel like a real product instead of a static mock.
