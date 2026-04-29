---
date: 2026-04-29
type: milestone
title: "M7.5-V1 complete: Case File viewer ships with Playwright smoke gate"
tags: [frontend, playwright, m7.5, case-file]
---

M7.5-V1 is done. The V1 Case File viewer — split-view PDF renderer, story accordion with entity pills, EntityHoverCard (Hero 2), EntityProfileDrawer, reveal choreography (Hero 1), and StoryReader reading mode — is live and fully wired to the real H10 API routes and Spec 77 session auth.

The final piece was Playwright. The smoke test (`demo/tests/smoke.spec.ts`) loads `/archive/:id`, waits for the first page canvas to paint, and asserts story frames are present — skipping gracefully when no local API is running so it won't false-fail CI. Added `story-frame` as a stable CSS selector on frame divs to make the test deterministic without coupling it to implementation internals.

M7 is now 11/11 — H11 closes alongside V1 as planned. Next: M7.5-V2 (Archive list + Desk).
