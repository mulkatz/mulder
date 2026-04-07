---
date: 2026-04-07
type: implementation
title: Pipeline orchestrator with cursor-based resume
tags: [pipeline, orchestration, m4]
---

`mulder pipeline run|status|retry` now chains ingest → extract → segment → enrich → embed → graph end-to-end, persisting per-source progress in `pipeline_runs` / `pipeline_run_sources` so a crash at document N resumes from document N instead of the beginning. A per-source failure writes `status='failed'` with the error message and lets the batch continue — one bad PDF no longer crashes a nightly run of thousands. `shouldRun()` encodes a source-vs-story status matrix for step eligibility: source-level steps (extract, segment) compare against `sources.status`, story-fanout steps (enrich, embed, graph) also accept stories at the prior story status, which makes `--from <step>` resume behaviour correct for partial runs. The most non-obvious fix was wrapping Phase 2 of `execute()` in a catch-and-finalize block so any unexpected throw (DB hiccup mid-run, etc.) still marks the `pipeline_runs` row as `failed` before re-throwing — without it, a single exception would leave a zombie `running` row forever since v1.0 has no reaper. This closes M4-D6 and unblocks the retrieval-side work (D7/E1-E6) that turns Mulder into a demoable v1.0.
