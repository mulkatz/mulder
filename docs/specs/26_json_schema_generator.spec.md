---
spec: 26
title: JSON Schema Generator
roadmap_step: C5
functional_spec: ["§2.4", "§14"]
scope: single
created: 2026-04-03
issue: https://github.com/mulkatz/mulder/issues/55
---

# Spec 26 — JSON Schema Generator

## 1. Objective

Build a config-driven JSON Schema generator that converts the user's ontology definition (`mulder.config.yaml`) into a Gemini-compatible JSON Schema for entity extraction structured output. The generator reads entity types, attributes, and relationships from the loaded config, builds Zod schemas dynamically, then converts them to JSON Schema via `zod-to-json-schema`. This is the bridge between the config ontology and Gemini's structured output enforcement in the Enrich step (C8).

## 2. Boundaries

### In Scope

- Dynamic Zod schema generation from `OntologyConfig` (entity types + attributes + relationships)
- JSON Schema conversion via `zod-to-json-schema` (Zod v3 compat layer, matching segment step pattern)
- Attribute type mapping: `string` → `z3.string()`, `number` → `z3.number()`, `boolean` → `z3.boolean()`, `date` → `z3.string()` (ISO 8601), `geo_point` → `z3.object({lat, lng})`, `string[]` → `z3.array(z3.string())`
- Relationship schema generation (source type, target type, relationship name, optional attributes)
- Top-level extraction response schema wrapping entities + relationships
- CLI command: `mulder config schema` — prints the generated JSON Schema to stdout
- `--json` flag for machine-readable output (pretty-printed JSON Schema)
- Deterministic output: same config always produces identical JSON Schema (sorted keys)

### Out of Scope

- The Enrich step itself (C8) — this spec only generates the schema
- Taxonomy normalization (C6)
- Entity resolution (C7)
- Prompt template creation for extraction
- Gemini API calls — schema is generated offline

### CLI Surface

| Command | Description |
|---------|-------------|
| `mulder config schema` | Print the generated JSON Schema for the current ontology config |
| `mulder config schema --json` | Print as formatted JSON (default behavior, flag explicit for scripting) |

## 3. Dependencies

### Requires (must exist)

- Config loader (`loadConfig()`) — spec 03, step A2 ✅
- Config Zod schemas + types (`OntologyConfig`, `EntityTypeConfig`) — spec 03 ✅
- CLI scaffold — spec 06 ✅
- `zod-to-json-schema` package — already in `packages/pipeline` (segment step) ✅

### Provides (used by future steps)

- `generateExtractionSchema(ontology)` — used by Enrich step (C8) to get JSON Schema for Gemini structured output
- `getExtractionResponseSchema(ontology)` — returns the Zod v4 schema for runtime validation of Gemini responses
- `mulder config schema` CLI command — developer tooling for inspecting/debugging the generated schema

## 4. Blueprint

### 4.1 Files

| File | Purpose |
|------|---------|
| `packages/pipeline/src/enrich/schema.ts` | Core module: Zod schema builders + JSON Schema generator |
| `packages/pipeline/src/enrich/index.ts` | Barrel exports for enrich module |
| `packages/pipeline/src/index.ts` | Updated: export enrich schema functions |
| `apps/cli/src/commands/config.ts` | Updated: add `schema` subcommand |

### 4.2 Core Module: `packages/pipeline/src/enrich/schema.ts`

**Pattern:** Follows the established dual-schema pattern from `packages/pipeline/src/segment/schema.ts` — Zod v3 for JSON Schema generation, Zod v4 for runtime validation.

**Attribute type mapping (Zod v3 for JSON Schema generation):**

| Config `type` | Zod v3 Schema | JSON Schema |
|---------------|---------------|-------------|
| `string` | `z3.string()` | `{ "type": "string" }` |
| `number` | `z3.number()` | `{ "type": "number" }` |
| `boolean` | `z3.boolean()` | `{ "type": "boolean" }` |
| `date` | `z3.string().describe("ISO 8601 date")` | `{ "type": "string" }` |
| `geo_point` | `z3.object({ lat: z3.number(), lng: z3.number() })` | `{ "type": "object", "properties": { "lat": ..., "lng": ... } }` |
| `string[]` | `z3.array(z3.string())` | `{ "type": "array", "items": { "type": "string" } }` |

**Exports:**

```typescript
// Generate JSON Schema for Gemini structured output
function generateExtractionSchema(ontology: OntologyConfig): Record<string, unknown>

// Get Zod v4 schema for runtime validation of Gemini response
function getExtractionResponseSchema(ontology: OntologyConfig): z.ZodType

// Get the entity type names from ontology (utility)
function getEntityTypeNames(ontology: OntologyConfig): string[]
```

**Generated schema structure:**

```json
{
  "type": "object",
  "properties": {
    "entities": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "type": { "type": "string", "enum": ["person", "location", ...] },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "attributes": {
            "type": "object",
            "properties": { /* union of all entity type attributes */ }
          },
          "mentions": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": ["name", "type", "confidence", "attributes", "mentions"]
      }
    },
    "relationships": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "source_entity": { "type": "string" },
          "target_entity": { "type": "string" },
          "relationship_type": { "type": "string", "enum": ["WITNESSED", ...] },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
          "attributes": { "type": "object" }
        },
        "required": ["source_entity", "target_entity", "relationship_type", "confidence"]
      }
    }
  },
  "required": ["entities", "relationships"]
}
```

The `type` field uses an `enum` of all entity type names from the config. The `attributes` field is a flat union of all possible attributes across entity types (Gemini handles the per-type attributes based on the `type` discriminator in the prompt, not the schema). The `relationship_type` field uses an `enum` of all relationship names from the config.

### 4.3 CLI Integration

Add `schema` subcommand to the existing `config` command group in `apps/cli/src/commands/config.ts`:

```
mulder config schema          → prints JSON Schema to stdout
mulder config schema --json   → same (explicit for scripting)
```

The command loads the config, calls `generateExtractionSchema(config.ontology)`, and prints the result. Exit code 0 on success.

### 4.4 Determinism

The generated schema MUST be deterministic: same ontology config → identical JSON output. This means:
- Entity type enum values are sorted alphabetically
- Relationship type enum values are sorted alphabetically
- Attribute properties are iterated in config-definition order (preserved by JS object insertion order)

This enables snapshot testing and diffing schema changes across config updates.

## 5. QA Contract

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Schema generates from default config | Default `mulder.config.yaml` loaded | `generateExtractionSchema(config.ontology)` called | Returns valid JSON Schema with `entities` and `relationships` arrays |
| QA-02 | Entity type enum matches config | Config has entity types `["person", "location", "event"]` | Schema generated | `entities.items.properties.type.enum` contains exactly those types, sorted |
| QA-03 | Relationship type enum matches config | Config has relationships `["WITNESSED", "OCCURRED_AT"]` | Schema generated | `relationships.items.properties.relationship_type.enum` contains exactly those types, sorted |
| QA-04 | Attribute types map correctly | Config has `date`, `geo_point`, `string[]` attributes | Schema generated | `date` → `string`, `geo_point` → `object` with `lat`/`lng`, `string[]` → `array` of strings |
| QA-05 | Schema is deterministic | Same config | Generated twice | JSON output is byte-identical |
| QA-06 | Runtime validation schema works | Gemini-like response with valid entities | Validated against Zod v4 schema | Passes validation |
| QA-07 | Runtime validation rejects invalid | Response with unknown entity type | Validated against Zod v4 schema | Fails validation with descriptive error |
| QA-08 | `$refStrategy: 'none'` produces flat schema | Any config | Schema generated | No `$ref` keys anywhere in the output |

## 5b. CLI Test Matrix

| ID | Command | Expected |
|----|---------|----------|
| CLI-01 | `npx mulder config schema` | Prints valid JSON Schema to stdout, exit 0 |
| CLI-02 | `npx mulder config schema --json` | Same as CLI-01 (explicit flag) |
| CLI-03 | `npx mulder config schema` output | Contains `"entities"` and `"relationships"` top-level properties |
