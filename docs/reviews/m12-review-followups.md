---
milestone: M12
title: "M12 Review Follow-ups"
review_source: docs/reviews/m12-review.md
tracking_issue: https://github.com/mulkatz/mulder/issues/307
branch: fix/m12-review-findings
created_at: 2026-05-07
status: implemented_pending_final_gates
---

# M12 Review Follow-ups

This document tracks implementation follow-ups for the M12 milestone review. The original review remains the historical assessment; this file records the corrective work against its warnings and selected consideration items.

## Resolution Summary

| ID | Finding | Resolution |
| --- | --- | --- |
| RF1 | Reverse `mappingType` filters used stored direction before inversion. | `resolveTaxonomyMappings` now filters by effective caller-perspective mapping type while `listTaxonomyMappings` remains storage-oriented. |
| RF2 | §A12 CUSUM/changepoint and DBSCAN semantics were incomplete. | Temporal anomaly detection now includes bounded CUSUM changepoints, `frequency_changepoint` persistence, and true deterministic DBSCAN hotspot clustering. HDBSCAN is deferred until a real implementation exists. |
| RF3 | External plugin interface did not match §A12.1/§D2.4 metadata. | The public plugin contract now exposes `id`, `name`, `description`, `type`, `update_frequency`, and request-aware `fetch`; invalid registrations throw custom analyze validation errors. |
| RF4 | Correlation caveat and similarity sort-score semantics needed tightening. | `always_include_caveat` must remain `true`; correlation caveats are always persisted. `weightedRankScore` is documented and tested as sort-only, and `custom_scorer` remains reserved. |
| RF5 | Roadmap/spec/CLAUDE references drifted from current architecture. | M12 references now point to `§D2.4`/`§D2.6`, Pattern Discovery is described as partially implemented through M12, and specs document the tightened contracts. |

## Verification Targets

- `pnpm test:scope run step M12-N1 -- --reporter=verbose`
- `pnpm test:scope run step M12-N2 -- --reporter=verbose`
- `MULDER_TEST_ISOLATED_DB=true pnpm test:scope run step M12-N3 -- --reporter=verbose`
- `MULDER_TEST_ISOLATED_DB=true pnpm test:scope run step M12-N4 -- --reporter=verbose`
- `pnpm test:scope run milestone M12 -- --reporter=verbose`
- `pnpm test:affected:plan -- origin/milestone/12`
- `MULDER_TEST_ISOLATED_DB=true pnpm test:affected -- origin/milestone/12 -- --reporter=verbose`
