---
spec: 18
title: Prompt Template Engine
roadmap_step: M2-B6
functional_spec: ["§4.7"]
scope: single
created: 2026-03-31
issue: https://github.com/mulkatz/mulder/issues/36
---

## 1. Objective

Implement a Jinja2-style prompt template engine (`renderPrompt()`) that loads `.jinja2` template files, injects runtime variables (ontology, story text, language, i18n fragments), and returns the final prompt string. Pipeline steps will use this engine for all LLM calls — no inline prompt strings.

This step establishes the foundation for every Gemini-powered pipeline step (Segment, Enrich, Ground, Analyze, Rerank, Question Generation) by providing a single rendering interface with i18n support.

## 2. Boundaries

### In scope
- Template engine with Jinja2-style `{{ variable }}` interpolation
- Nested dot-access for variables (`{{ i18n.segment.system_role }}`)
- Template loading from `packages/core/src/prompts/templates/`
- i18n fragment loading from `packages/core/src/prompts/i18n/`
- `renderPrompt(templateName, variables)` as the public API
- Starter templates for Segment and Extract-Entities (skeleton content — real prompts come in M3)
- i18n files for `en` and `de` locales
- Barrel export from `packages/core`

### Out of scope
- Jinja2 control flow (`{% if %}`, `{% for %}`, `{% block %}`) — add when needed
- Actual prompt content tuning (that's M3 work)
- Integration with pipeline steps (each step's spec handles its own prompt wiring)

## 3. Dependencies

### Requires (must exist)
- `packages/core/` package structure (M1-A1, 🟢)
- Config loader with `supported_locales` and `ontology` (M1-A2, 🟢)
- Custom error classes (M1-A3, 🟢)

### Required by (future steps)
- M2-B7 Extract step (uses extract template)
- M3-C2 Segment step (uses segment template)
- M3-C8 Enrich step (uses extract-entities template)
- M4-E5 LLM re-ranking (uses rerank template)
- M6-G2 Ground step (uses ground-entity template)

## 4. Blueprint

### 4.1 Files to create

| File | Purpose |
|------|---------|
| `packages/core/src/prompts/engine.ts` | Template engine: load, parse, render |
| `packages/core/src/prompts/index.ts` | Barrel export |
| `packages/core/src/prompts/i18n/en.json` | English prompt fragments |
| `packages/core/src/prompts/i18n/de.json` | German prompt fragments |
| `packages/core/src/prompts/templates/segment.jinja2` | Story segmentation prompt (skeleton) |
| `packages/core/src/prompts/templates/extract-entities.jinja2` | Entity extraction prompt (skeleton) |
| `packages/core/src/prompts/templates/ground-entity.jinja2` | Web grounding prompt (placeholder) |
| `packages/core/src/prompts/templates/resolve-contradiction.jinja2` | Contradiction analysis (placeholder) |
| `packages/core/src/prompts/templates/generate-questions.jinja2` | Question generation for embeddings (placeholder) |
| `packages/core/src/prompts/templates/rerank.jinja2` | Re-ranking prompt (placeholder) |

### 4.2 Files to modify

| File | Change |
|------|--------|
| `packages/core/src/index.ts` | Add `renderPrompt`, `listTemplates`, `PromptError` exports |
| `packages/core/src/shared/errors.ts` | Add `PromptError` class + error codes |

### 4.3 Engine design — `engine.ts`

```typescript
// Public API
export function renderPrompt(
  templateName: string,
  variables: Record<string, unknown>
): string

export function listTemplates(): string[]
```

**Rendering logic:**
1. Resolve template path: `<prompts-dir>/templates/<templateName>.jinja2`
2. Read template file (cache after first read — templates don't change at runtime)
3. Resolve i18n: if `variables.locale` is set, load `<prompts-dir>/i18n/<locale>.json` and merge as `variables.i18n`
4. Interpolate all `{{ variable.path }}` placeholders using dot-notation access on the variables object
5. Throw `PromptError` for: missing template, missing variable, invalid locale file

**Template caching:** Use a module-level `Map<string, string>` for loaded templates. Templates are static files — no need for TTL or invalidation. i18n files are also cached.

**Variable resolution:** Support dot-access (`{{ i18n.segment.system_role }}`) by splitting on `.` and traversing the object. Undefined variables throw `PromptError` with code `TEMPLATE_VARIABLE_MISSING` — never silently render `undefined` or empty string.

### 4.4 Error codes

Add to `packages/core/src/shared/errors.ts`:

```typescript
// Prompt error codes
export const PROMPT_ERROR_CODES = {
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  TEMPLATE_VARIABLE_MISSING: 'TEMPLATE_VARIABLE_MISSING',
  LOCALE_FILE_NOT_FOUND: 'LOCALE_FILE_NOT_FOUND',
  TEMPLATE_PARSE_ERROR: 'TEMPLATE_PARSE_ERROR',
} as const;

export class PromptError extends MulderError { ... }
```

### 4.5 i18n file structure

```json
// en.json
{
  "segment": {
    "system_role": "You are a document analyst...",
    "output_format": "Return JSON with the following structure..."
  },
  "extract": {
    "system_role": "You are an entity extraction specialist...",
    "output_format": "Return entities matching the provided ontology schema..."
  },
  "common": {
    "language_instruction": "Respond in English.",
    "json_instruction": "Return valid JSON only. No markdown fencing."
  }
}
```

i18n files provide translated prompt fragments that templates reference via `{{ i18n.segment.system_role }}`. This is NOT i18next — it's a simple JSON lookup scoped to prompt rendering.

### 4.6 Template file format

Templates are plain text with `{{ variable }}` placeholders. Example skeleton:

```
{{ i18n.segment.system_role }}

## Document Context
Pages: {{ page_count }}
Has native text: {{ has_native_text }}

## Task
{{ i18n.segment.task_description }}

{{ i18n.common.json_instruction }}
```

Placeholder templates for future steps (ground, contradiction, questions, rerank) contain only a comment explaining their purpose and a `{{ i18n.common.json_instruction }}` placeholder — enough structure to validate the engine works, real content added when each step is implemented.

### 4.7 Integration with core package

The barrel export in `packages/core/src/index.ts` exposes:
- `renderPrompt` — the main rendering function
- `listTemplates` — utility to discover available templates
- `PromptError` — error class for template-related failures
- `PROMPT_ERROR_CODES` — error code constants

## 5. QA Contract

All conditions verified via black-box tests. Tests call `renderPrompt()` from the `@mulder/core` package — they do not import engine internals.

| ID | Condition | Given | When | Then |
|----|-----------|-------|------|------|
| QA-01 | Basic variable interpolation | A template with `{{ name }}` placeholder | `renderPrompt('test-template', { name: 'value' })` | Returns string with `value` substituted |
| QA-02 | Dot-notation variable access | A template with `{{ i18n.common.json_instruction }}` | `renderPrompt()` with locale set to `en` | Returns string with the English fragment substituted |
| QA-03 | Missing variable throws | A template with `{{ missing_var }}` | `renderPrompt()` without providing `missing_var` | Throws `PromptError` with code `TEMPLATE_VARIABLE_MISSING` |
| QA-04 | Missing template throws | No template file for the name | `renderPrompt('nonexistent', {})` | Throws `PromptError` with code `TEMPLATE_NOT_FOUND` |
| QA-05 | Locale loading | Template referencing `{{ i18n.segment.system_role }}` | `renderPrompt()` with `locale: 'de'` | Returns string with German fragment |
| QA-06 | Missing locale throws | Locale `fr` not in i18n directory | `renderPrompt()` with `locale: 'fr'` | Throws `PromptError` with code `LOCALE_FILE_NOT_FOUND` |
| QA-07 | All starter templates loadable | All 6 `.jinja2` files exist | `listTemplates()` | Returns array containing all 6 template names |
| QA-08 | Template caching | Same template loaded twice | Call `renderPrompt()` twice with same template | Second call uses cached template (no file read) |
| QA-09 | Segment template renders | segment.jinja2 with appropriate variables | `renderPrompt('segment', { locale: 'en', page_count: 5, has_native_text: true })` | Returns non-empty string without unresolved `{{ }}` |
| QA-10 | Extract-entities template renders | extract-entities.jinja2 with ontology | `renderPrompt('extract-entities', { locale: 'en', ontology: '...', story_text: '...' })` | Returns non-empty string without unresolved `{{ }}` |
