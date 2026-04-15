---
spec: "77"
title: "Document Observability Aggregation Route"
roadmap_step: M7-H11
functional_spec: ["§13", "§10.6"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/193"
created: 2026-04-15
---

# Spec 77: Document Observability Aggregation Route

## 1. Objective

Add a real `GET /api/documents/:id/observability` contract for `M7-H11` so the document-detail console and timeline can be rendered from authoritative backend state alone. Instead of pretending the source-level Firestore projection is the whole picture, this route aggregates the source record, source-step history, related story records, story-level observability projections, and the latest job/run progress tied to the document.

This spec intentionally chooses the broader direction called out in issue `#193`: keep the richer H11 console/timeline promise and broaden the observability contract to match the data Mulder already persists. The API returns structured events and summaries, not fake log strings.

## 2. Boundaries

- **Roadmap Step:** `M7-H11` — Document Viewer UI
- **Target:** `apps/api/src/routes/documents.schemas.ts`, `apps/api/src/routes/documents.ts`, `apps/api/src/lib/documents.ts`, `tests/specs/77_document_observability_route.test.ts`
- **In scope:** authenticated `GET /api/documents/:id/observability`; aggregation of source metadata from PostgreSQL; source-step history from `source_steps`; related stories from `stories`; source/story observability projections from Firestore; latest pipeline job and run progress for the source from `jobs` plus `pipeline_runs`; normalized event/timeline entries derived strictly from persisted backend records; and black-box tests for missing, partial, and fully populated observability states
- **Out of scope:** shipping the full React viewer shell; inventing synthetic narrative log text; changing pipeline write behavior; streaming/SSE/WebSocket updates; introducing Firestore as an orchestration dependency; or backfilling historical observability rows beyond what existing persistence already records
- **Constraints:** PostgreSQL remains the source of truth for pipeline/job/story state; Firestore is read only as an observability projection for UI details; the route must degrade cleanly when projection records are absent; and the response must expose enough structured metadata for the UI to render an honest console/timeline without hard-coded fake entries

## 3. Dependencies

- **Requires:** Spec 14 (`M2-B2`) source repository, Spec 22 (`M2-B10`) story repository, Spec 36 (`M4-D6`) pipeline run tracking, Spec 67 (`M7-H1`) job queue repository, Spec 69 (`M7-H3`) Hono server scaffold, Spec 70 (`M7-H4`) API middleware stack, Spec 72 (`M7-H6`) job status API patterns, and Spec 76 (`M7-H10`) document retrieval routes
- **Blocks:** the H11 document-detail console/timeline implementation, which needs a stable observability contract before the UI can drop mock activity data

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/documents.schemas.ts`** — adds the observability response schemas and validates the new route contract
2. **`apps/api/src/lib/documents.ts`** — aggregates source, step, story, Firestore, and job/run records into a normalized observability payload
3. **`apps/api/src/routes/documents.ts`** — registers `GET /api/documents/:id/observability`
4. **`tests/specs/77_document_observability_route.test.ts`** — black-box verification for missing, partial, and fully populated observability states

### 4.2 Route Contract

#### `GET /api/documents/:id/observability`

Purpose: return the authoritative backend-backed observability state needed for the H11 document-detail console/timeline.

Response shape:

```json
{
  "data": {
    "source": {
      "id": "uuid",
      "filename": "case-file.pdf",
      "status": "segmented",
      "page_count": 12,
      "steps": [
        {
          "step": "extract",
          "status": "completed",
          "completed_at": "2026-04-15T12:01:00.000Z",
          "error_message": null
        }
      ],
      "projection": {
        "status": "segmented",
        "extracted_at": "2026-04-15T12:01:00.000Z",
        "segmented_at": "2026-04-15T12:02:30.000Z",
        "page_count": 12,
        "story_count": 3,
        "vision_fallback_count": 2,
        "vision_fallback_capped": false
      }
    },
    "stories": [
      {
        "id": "uuid",
        "title": "Story title",
        "status": "embedded",
        "page_start": 2,
        "page_end": 5,
        "projection": {
          "status": "embedded",
          "enriched_at": "2026-04-15T12:03:00.000Z",
          "embedded_at": "2026-04-15T12:04:00.000Z",
          "entities_extracted": 9,
          "chunks_created": 4
        }
      }
    ],
    "job": {
      "job_id": "uuid",
      "status": "running",
      "attempts": 1,
      "max_attempts": 3,
      "error_log": null,
      "created_at": "2026-04-15T12:00:00.000Z",
      "started_at": "2026-04-15T12:00:03.000Z",
      "finished_at": null
    },
    "progress": {
      "run_id": "uuid",
      "run_status": "running",
      "current_step": "segment",
      "source_status": "processing",
      "updated_at": "2026-04-15T12:00:05.000Z",
      "error_message": null
    },
    "timeline": [
      {
        "scope": "job",
        "event": "job.started",
        "status": "running",
        "occurred_at": "2026-04-15T12:00:03.000Z",
        "step": "segment",
        "story_id": null,
        "details": {
          "run_id": "uuid"
        }
      },
      {
        "scope": "source",
        "event": "source_step.completed",
        "status": "completed",
        "occurred_at": "2026-04-15T12:01:00.000Z",
        "step": "extract",
        "story_id": null,
        "details": {
          "origin": "postgresql"
        }
      }
    ]
  }
}
```

Rules:

- `source.steps` comes from PostgreSQL `source_steps`, ordered by known pipeline step order rather than alphabetical database order
- `source.projection` comes from `documents/{sourceId}` when present; when absent, it is `null`
- `stories[*].projection` comes from `stories/{storyId}` when present; when absent, it is `null`
- `job` reflects the newest queued/worker job whose payload targets the source and is `null` when no matching job exists
- `progress` reflects the newest persisted `pipeline_run_sources` row for the source, enriched with its parent `pipeline_runs.status`, and is `null` when no run-progress row exists
- `timeline` is a normalized event feed sorted ascending by timestamp and derived only from persisted records; it must not include invented prose-only logs
- timeline events may be synthesized from authoritative timestamps and states, but each event must trace back to an actual row or projection field already stored by the backend

### 4.3 Timeline Normalization Rules

The route should emit timeline events from these sources:

1. **Job lifecycle:** `jobs.created_at`, `jobs.started_at`, `jobs.finished_at`, `jobs.status`, `jobs.error_log`
2. **Run/source progress:** latest `pipeline_run_sources` row for the source, including `current_step`, `status`, and `updated_at`
3. **Source-step completion/failure:** `source_steps.completed_at`, `source_steps.status`, `source_steps.error_message`
4. **Source projection milestones:** known timestamp-bearing fields on `documents/{sourceId}` such as `extractedAt` and `segmentedAt`
5. **Story projection milestones:** known timestamp-bearing fields on `stories/{storyId}` such as `enrichedAt`, `embeddedAt`, and `graphedAt`

The route must not fabricate line-by-line worker logs. The UI can map these normalized events into human-readable labels later.

### 4.4 Implementation Notes

- prefer existing repository functions (`findSourceById`, `findSourceSteps`, `findStoriesBySourceId`, `findJobs`, `findPipelineRunById`, `findLatestPipelineRunSourceForSource`) over new database helpers unless a blocker appears
- reuse the existing document-route config/service bootstrap so dev-mode tests can provide in-memory Firestore projections
- keep the timeline payload intentionally structured and compact; do not dump raw Firestore documents or raw job payloads into the response

## 5. QA Contract

### QA-01: unknown documents fail with the established not-found response

**Given** no source row exists for the requested ID,
**When** an authenticated client sends `GET /api/documents/{id}/observability`,
**Then** the API returns the established Mulder not-found response and does not synthesize an empty observability payload.

### QA-02: missing projections still return authoritative SQL-backed observability

**Given** a source exists with `source_steps` and/or story rows but no Firestore projection documents,
**When** an authenticated client sends `GET /api/documents/{id}/observability`,
**Then** the response is `200`, `source.projection` and missing `stories[*].projection` entries are `null`, and the SQL-backed step/story/job data is still present.

### QA-03: partial observability states stay explicit

**Given** some but not all observability records exist for a source,
**When** an authenticated client requests the route,
**Then** the response preserves missing sections as `null` or empty arrays instead of backfilling fake completion details.

### QA-04: fully populated observability returns source, stories, job, and timeline data together

**Given** a source with source-step history, story rows, Firestore projection documents, and a matching pipeline job/run,
**When** an authenticated client sends `GET /api/documents/{id}/observability`,
**Then** the response aggregates all of those records into one payload and exposes a timeline sorted by real timestamps.

### QA-05: timeline events are structured and traceable

**Given** persisted timestamps across jobs, source steps, and projection milestones,
**When** the observability route responds,
**Then** each timeline entry includes scope, event, status, occurred timestamp, and structured details sufficient for the UI to render without relying on fake log strings.

### QA-06: document observability stays read-only and non-queueing

**Given** the observability route is available,
**When** an authenticated client exercises the route,
**Then** no jobs, pipeline runs, sources, stories, or source-step rows are created or mutated.

### QA-07: unauthenticated and malformed requests fail at the HTTP boundary

**Given** the route is mounted behind the existing middleware stack,
**When** the request is unauthenticated or uses a malformed document ID,
**Then** the API fails with the established auth or validation response shape.

### QA-08: the API package still builds with the observability route added

**Given** the observability route implementation is in place,
**When** the API build and the dedicated spec test run,
**Then** both pass without needing the full CI-equivalent suite.

## 5b. CLI Test Matrix

N/A — no CLI commands in this step.

## 6. Cost Considerations

This route adds only read-time API cost. It reuses already-persisted PostgreSQL rows and Firestore projection documents, and it does not trigger new pipeline work, LLM calls, or artifact generation. Keep Firestore lookups bounded to the source document and the stories already linked to the source so one detail-page request does not fan out unnecessarily.
