---
date: 2026-05-03
type: implementation
title: "M9-J2: Pipeline orchestrator supports pre-structured format skip"
tags: [pipeline, multi-format, orchestrator, m9]
---

The pipeline orchestrator now knows that some source types don't need Gemini segmentation. `text`, `docx`, `spreadsheet`, `email`, and `url` sources produce discrete stories at extract time, so there is no story-boundary detection work to do — the segment step is a no-op that would run pointlessly.

M9-J2 wires this up by adding `isPreStructuredType()` as a pure utility, updating `shouldRun()` with an optional fifth `sourceType` parameter, and extending the `enumerateSources()` resume logic to treat `extracted` as a valid pickup status when the first step is `enrich`. The dry-run estimate path mirrors the same change.

The critical constraint was ordering: the segment-skip guard fires before the `--force` check inside `shouldRun()`, so a user cannot accidentally force-run segment for a format that has no segment implementation. The function stays pure — no I/O, no database access — which kept the change surgical and easy to unit-test.

The status machine now has two valid paths to `enriched`: the PDF path (`segmented → enriched`) and the pre-structured path (`extracted → enriched`). The `segmented` status is never touched for pre-structured sources; they simply skip past it. All seven QA conditions pass as pure-function assertions — no database or GCP infrastructure required.

J3–J10 format handlers can now be implemented knowing the orchestrator will route their sources correctly. The only downstream concern noted in review: extract handlers must persist at least one story before returning, or the enrich step silently no-ops with no error (correct per spec, but worth verifying per format).
