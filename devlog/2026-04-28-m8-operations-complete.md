---
date: 2026-04-28
type: milestone
title: M8 Operations Complete — Eval, Cost Gates, Reprocess, Retry
tags: [milestone, operations, reprocess, cost-safety]
---

M8 closes the operational safety layer. `mulder reprocess` now plans from PostgreSQL `source_steps` rather than stale source-level status, handles multiple simultaneous config changes as a union of impacted steps, preserves embedding state when enrich-only changes do not require re-embedding, and keeps graph reprocess cleanup from discarding enrichment relationships. Together with eval reporting, cost estimates, Terraform budget alerts, dead-letter retry, and devlog conventions, Mulder can now run real corpora with selective reruns instead of blunt full-pipeline replays.
