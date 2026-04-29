---
date: 2026-04-29
type: milestone
title: "M7.5-V1 complete: Case File viewer ships with Playwright smoke gate"
tags: [frontend, playwright, m7.5, case-file]
---

M7.5-V1 is done: the Case File viewer now ships with the split-view PDF renderer, story accordion, entity pills, EntityHoverCard, EntityProfileDrawer, reveal choreography, and StoryReader reading mode wired to the real H10 API routes and Spec 77 session auth.

The binary gate is `cd demo && npm run test:e2e`, backed by Playwright coverage that logs in through the real browser session, opens `/archive/:id`, waits for the first PDF canvas, and asserts story frames render.

The roadmap and README now mark H11 and M7.5-V1 complete, leaving M7 at 11/11 and the next frontend step at M7.5-V2.
