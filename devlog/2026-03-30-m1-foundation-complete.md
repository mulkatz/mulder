---
date: 2026-03-30
type: milestone
title: "M1 complete — Mulder runs locally"
tags: [milestone, foundation, docker, local-dev]
---

Milestone 1 is done. All 11 foundation steps shipped: monorepo scaffolding, config loader with Zod validation, custom error classes, structured logging, CLI scaffold, database client with dual connection pools, full schema migrations (core + job queue), fixture directory, service abstraction layer, and now Docker Compose for local development. The final step required a fix — PostGIS can't be installed via init scripts in the pgvector image (runs as non-root postgres user), so we build a custom image layering PostGIS on top. Zero GCP dependencies at this stage; everything runs against local containers and fixture data.
