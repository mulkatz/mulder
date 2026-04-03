---
date: 2026-04-03
type: implementation
title: Config-driven JSON Schema generator for entity extraction
tags: [enrich, gemini, structured-output, zod-to-json-schema]
---

# Config-driven JSON Schema generator for entity extraction

The JSON Schema generator (C5) bridges the user's ontology config and Gemini's structured output enforcement. Instead of hand-rolling JSON Schema for entity extraction, the generator reads entity types, attributes, and relationships from `mulder.config.yaml`, builds Zod schemas dynamically, and converts to JSON Schema via `zod-to-json-schema`. Same dual-schema pattern as the segment step: Zod v3 for JSON Schema generation, Zod v4 for runtime validation. Attribute types like `geo_point` and `date` get correct mappings without manual schema maintenance. `mulder config schema` prints the generated schema for inspection.
