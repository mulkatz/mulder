---
spec: "86"
title: "Pipeline Step Skipping — Pre-Structured Format Support"
roadmap_step: M9-J2
functional_spec: ["§3.1", "§3.2"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/239"
created: 2026-05-01
---

# Spec 86: Pipeline Step Skipping — Pre-Structured Format Support

## 1. Objective

Teach the pipeline orchestrator to skip the `segment` step for pre-structured source formats — those whose extracted content already arrives as discrete stories and therefore does not need Gemini-based story segmentation. When segment is skipped, the source transitions directly from `extracted` to `enriched` status, bypassing `segmented`.

This satisfies M9-J2 and is the orchestration infrastructure that later J3–J10 format handlers depend on. The change is purely in the orchestrator — no pipeline step logic or data models change, and existing PDF ingest behaviour is fully preserved.

**Pre-structured types:** `text`, `docx`, `spreadsheet`, `email`, `url`
**Normal-pipeline types (segment applies):** `pdf`, `image`

## 2. Boundaries

**Roadmap step:** M9-J2 — Pipeline step skipping: orchestrator supports `skip_to` so pre-structured formats bypass segment.

**Target files:**

- `packages/pipeline/src/ingest/source-type.ts` — add and export `isPreStructuredType()`
- `packages/pipeline/src/pipeline/index.ts` — update `shouldRun()`, `enumerateSources()`, dry-run path
- `packages/pipeline/src/index.ts` — export `isPreStructuredType`
- `tests/specs/86_pipeline_step_skipping.test.ts`

**In scope:**

- Add `isPreStructuredType(sourceType: SourceType): boolean` pure utility that returns `true` for `text`, `docx`, `spreadsheet`, `email`, `url`.
- Update `shouldRun()` to accept an optional fifth parameter `sourceType?: SourceType`:
  - `segment` step: always returns `false` when `sourceType` is pre-structured, even when `options.force` is true.
  - `enrich` step: returns `true` when `sourceType` is pre-structured and `sourceStatus === 'extracted'` (segment was skipped).
- Update `processSource()` to pass `currentSource.sourceType` to every `shouldRun()` call.
- Update the `enumerateSources()` resume path: when `firstStep === 'enrich'`, include `extracted` as an eligible source status (so pre-structured sources at `extracted` are picked up on resume).
- Update the dry-run source count estimate correspondingly.
- Export `isPreStructuredType` from `packages/pipeline/src/index.ts`.

**Out of scope:**

- Implementing any format-specific extract handler (J3–J10).
- Any migration or schema changes — `source_type` column already exists from J1.
- Modifying the `SourceStatus` type — the `segmented` status remains valid; pre-structured sources simply never reach it.
- Changing the `--from`/`--up-to` flag semantics or validation.
- Any changes to the `segment` step implementation itself.

**Architectural constraints:**

- `shouldRun()` must remain a pure function — no I/O, no database calls.
- The change must be fully backward-compatible: sources with `source_type = 'pdf'` or `source_type = 'image'` behave identically to before.
- Pre-structured sources at `extracted` status must silently skip segment and proceed to enrich without error.
- With `--force`, segment remains skipped for pre-structured types (there is no segment implementation to force-retry).

## 3. Dependencies

**Requires:**

- M9-J1 / Spec 85 — `source_type` column on `sources`, `SourceType` type in `@mulder/core`, `detectSourceType()` in `packages/pipeline`.
- M4-D6 / Spec 36 — pipeline orchestrator (`packages/pipeline/src/pipeline/index.ts`).

**Blocks:**

- M9-J3–J10 — format-specific ingest handlers depend on the orchestrator skipping segment correctly for their source types.

## 4. Blueprint

### Phase 1: `isPreStructuredType` utility

In `packages/pipeline/src/ingest/source-type.ts`, add after the existing `detectSourceType` export:

```typescript
/**
 * Returns true for source types that produce stories directly at extract time
 * and therefore skip the segment step in the pipeline orchestrator.
 * PDF and image go through the normal segment step.
 */
export function isPreStructuredType(sourceType: SourceType): boolean {
    return sourceType === 'text'
        || sourceType === 'docx'
        || sourceType === 'spreadsheet'
        || sourceType === 'email'
        || sourceType === 'url';
}
```

Export from `packages/pipeline/src/index.ts`:

```typescript
export { detectSourceType, isPreStructuredType, execute as executeIngest, resolvePdfFiles } from './ingest/index.js';
```

And from `packages/pipeline/src/ingest/index.ts` re-export it so the barrel path works.

### Phase 2: Update `shouldRun()`

Update the signature to:

```typescript
export function shouldRun(
    step: PipelineStepName,
    sourceStatus: SourceStatus,
    storyStatuses: StoryStatus[],
    options: PipelineRunOptions,
    sourceType?: SourceType,
): boolean
```

Add at the top of the function body, before the `options.force` check:

```typescript
// Pre-structured types never have a segment step — skip unconditionally.
if (step === 'segment' && sourceType && isPreStructuredType(sourceType)) {
    return false;
}
```

Update the `enrich` branch to allow `extracted` for pre-structured types:

```typescript
if (step === 'enrich') {
    if (sourceStatus === 'segmented') return true;
    if (sourceType && isPreStructuredType(sourceType) && sourceStatus === 'extracted') return true;
    return storyStatuses.some((s) => storyStatusIndex(s) < targetStoryIdx);
}
```

### Phase 3: Update `processSource()`

In the `for (const step of stepsForSource)` loop, update the `shouldRun` call to pass `currentSource.sourceType`:

```typescript
if (!shouldRun(step, currentSource.status, storyStatuses, ctx.options, currentSource.sourceType)) {
```

### Phase 4: Update `enumerateSources()` resume path

In the `switch (firstStep)` block inside `enumerateSources`:

```typescript
case 'enrich':
    eligibleStatuses.push('segmented', 'extracted'); // 'extracted' for pre-structured types
    break;
```

Update the corresponding dry-run estimate block in `execute()` identically.

### Phase 5: Exports and wiring

Ensure `isPreStructuredType` is re-exported from `packages/pipeline/src/ingest/index.ts` and then from `packages/pipeline/src/index.ts`.

## 5. QA Contract

**QA-01: `isPreStructuredType` classifies correctly**

Given the `isPreStructuredType` function, when called with each `SourceType` value:
- `text`, `docx`, `spreadsheet`, `email`, `url` → returns `true`
- `pdf`, `image` → returns `false`

**QA-02: `shouldRun` skips segment for pre-structured types**

Given `shouldRun('segment', 'extracted', [], {}, 'text')`, the result is `false`.
Given `shouldRun('segment', 'extracted', [], {}, 'docx')`, the result is `false`.
Given `shouldRun('segment', 'extracted', [], {}, 'email')`, the result is `false`.
Given `shouldRun('segment', 'extracted', [], {}, 'pdf')`, the result is `true` (unchanged).

**QA-03: `shouldRun` skips segment even with force=true**

Given `shouldRun('segment', 'extracted', [], { force: true }, 'text')`, the result is `false`.
Given `shouldRun('segment', 'extracted', [], { force: true }, 'pdf')`, the result is `true`.

**QA-04: `shouldRun` allows enrich from extracted for pre-structured types**

Given `shouldRun('enrich', 'extracted', [], {}, 'text')`, the result is `true`.
Given `shouldRun('enrich', 'extracted', [], {}, 'docx')`, the result is `true`.
Given `shouldRun('enrich', 'extracted', [], {}, 'pdf')`, the result is `false` (PDF at extracted still needs segment first).

**QA-05: `shouldRun` allows enrich from segmented (unchanged PDF path)**

Given `shouldRun('enrich', 'segmented', [], {}, 'pdf')`, the result is `true`.
Given `shouldRun('enrich', 'segmented', [], {}, undefined)`, the result is `true` (no sourceType → original behaviour).

**QA-06: `shouldRun` with no sourceType is backward-compatible**

Given `shouldRun('segment', 'extracted', [], {})` (no 5th arg), the result is `true` — identical to pre-J2 behaviour.
Given `shouldRun('enrich', 'extracted', [], {})` (no 5th arg), the result is `false` — identical to pre-J2 behaviour.

**QA-07: `isPreStructuredType` is exported from the pipeline package**

Given `import { isPreStructuredType } from '@mulder/pipeline'`, the import resolves and the function is callable.

## 5b. CLI Test Matrix

N/A — J2 is purely an orchestrator logic change. No new CLI commands or flags are introduced. Existing `mulder pipeline run` commands are tested by the QA contract above via unit assertions on the exported pure functions.

## 6. Cost Considerations

No GCP or LLM calls are involved. This is a pure TypeScript orchestration change.
