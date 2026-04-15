---
spec: "75"
title: "Evidence API Routes"
roadmap_step: M7-H9
functional_spec: ["§10.6"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/187"
created: 2026-04-15
---

# Spec 75: Evidence API Routes

## 1. Objective

Expose Mulder's pre-computed evidence layer over authenticated HTTP so API clients can inspect contradictions, source reliability, evidence chains, and spatio-temporal cluster snapshots without shelling into CLI exports or rerunning analysis work. Per `§10.6`, these routes stay synchronous and database-backed: they read persisted evidence state directly and return in milliseconds rather than enqueueing jobs or invoking Analyze inline.

This step completes the last major read-only data surface promised by the M7 API milestone. The API layer should adapt and aggregate the evidence state that already exists in PostgreSQL, while preserving Mulder's sparse-data and read-only evidence semantics from the evidence/analyze specs.

## 2. Boundaries

- **Roadmap Step:** `M7-H9` — Evidence API routes (sync)
- **Target:** `apps/api/src/app.ts`, `apps/api/src/routes/evidence.schemas.ts`, `apps/api/src/routes/evidence.ts`, `apps/api/src/lib/evidence.ts`, `packages/core/src/database/repositories/evidence-chain.repository.ts`, `packages/core/src/database/repositories/spatio-temporal-cluster.repository.ts`, `packages/core/src/database/repositories/index.ts`, `tests/specs/75_evidence_api_routes.test.ts`
- **In scope:** authenticated read-only routes for evidence summary, contradiction inspection, source reliability inspection, persisted evidence-chain lookup, and persisted spatio-temporal cluster lookup; repository read helpers needed to expose persisted evidence-chain and cluster snapshots cleanly; snake_case HTTP DTO mapping for evidence data; sparse-data warning propagation where the underlying data model already signals degraded confidence; and black-box tests proving sync behavior, auth protection, filters, empty-state handling, and response contracts
- **Out of scope:** rerunning `analyze`, recomputing contradictions/reliability/chains/clusters inside the API, new LLM calls or grounding work, source/story/taxonomy/document routes, write/mutation endpoints for evidence data, websockets/streaming, and any UI work (`M7-H10` / `M7-H11`)
- **Constraints:** keep all routes behind the existing middleware/auth stack and in the standard rate-limit tier; keep the surface read-only and database-backed with no queue jobs or pipeline-run mutations; reuse or extend `@mulder/core` repositories instead of embedding ad hoc SQL in handlers; and preserve the rule that evidence APIs expose already-computed state rather than inventing a second analysis engine in `apps/api`

## 3. Dependencies

- **Requires:** Spec 53 (`M5-F5`) evidence export semantics, Spec 61 (`M6-G3`) contradiction resolution outputs, Spec 62 (`M6-G4`) source reliability persistence, Spec 63 (`M6-G5`) evidence-chain persistence, Spec 64 (`M6-G6`) spatio-temporal cluster persistence, Spec 66 (`M6-G5b`) evidence package boundary, Spec 69 (`M7-H3`) Hono server scaffold, and Spec 70 (`M7-H4`) API middleware stack
- **Blocks:** no later roadmap step is strictly blocked, but this step completes the synchronous `/api/evidence/*` surface promised by `§10.6` so API clients can consume Mulder's analytical outputs through HTTP instead of CLI-only reporting

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/evidence.schemas.ts`** — defines query/body schemas plus snake_case response envelopes for the evidence route group
2. **`apps/api/src/lib/evidence.ts`** — owns repository-backed evidence readers, summary aggregation, and HTTP DTO mapping
3. **`apps/api/src/routes/evidence.ts`** — registers the evidence route group and delegates to the route-facing evidence helpers
4. **`apps/api/src/app.ts`** — mounts the evidence route group beneath the existing middleware stack
5. **`packages/core/src/database/repositories/evidence-chain.repository.ts`** — adds read helpers for thesis discovery and/or broader chain inspection needed by the API
6. **`packages/core/src/database/repositories/spatio-temporal-cluster.repository.ts`** — adds read helpers for persisted cluster snapshots
7. **`packages/core/src/database/repositories/index.ts`** — exports any new repository helpers
8. **`tests/specs/75_evidence_api_routes.test.ts`** — black-box verification for the evidence API surface

### 4.2 Route Contract

#### `GET /api/evidence/summary`

Purpose: expose a lightweight overview of Mulder's current evidence state.

Response shape:

```json
{
  "data": {
    "entities": {
      "total": 42,
      "scored": 18,
      "avg_corroboration": 0.61
    },
    "contradictions": {
      "potential": 2,
      "confirmed": 3,
      "dismissed": 1
    },
    "duplicates": {
      "count": 4
    },
    "sources": {
      "total": 12,
      "scored": 9,
      "data_reliability": "low"
    },
    "evidence_chains": {
      "thesis_count": 2,
      "record_count": 6
    },
    "clusters": {
      "count": 3
    }
  }
}
```

Rules:

- the summary is read-only and aggregate-only; it does not inline full contradiction, chain, or cluster collections
- `data_reliability` follows the existing sparse-data classification used by Mulder's evidence export surface
- empty datasets still return `200` with zero counts rather than not-found errors

#### `GET /api/evidence/contradictions`

Purpose: inspect contradiction edges already written by graph/analyze.

Query parameters:

- `status` — optional `potential | confirmed | dismissed | all` selector; defaults to `all`
- `limit` — optional integer cap with a safe default
- `offset` — optional integer offset

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "source_entity_id": "uuid",
      "target_entity_id": "uuid",
      "relationship": "contradiction_status",
      "edge_type": "CONFIRMED_CONTRADICTION",
      "story_id": "uuid",
      "confidence": 0.93,
      "attributes": {
        "attribute": "status",
        "valueA": "active",
        "valueB": "inactive"
      },
      "analysis": {
        "verdict": "confirmed",
        "winning_claim": "A",
        "confidence": 0.93,
        "explanation": "..."
      }
    }
  ],
  "meta": {
    "count": 1,
    "limit": 20,
    "offset": 0,
    "status": "all"
  }
}
```

Rules:

- the route exposes existing contradiction edges only; it never synthesizes unresolved conflicts from raw entity data
- `status=potential` maps to `POTENTIAL_CONTRADICTION`, `confirmed` to `CONFIRMED_CONTRADICTION`, and `dismissed` to `DISMISSED_CONTRADICTION`
- edge `analysis` is returned when present and `null` when the contradiction has not yet been resolved

#### `GET /api/evidence/reliability/sources`

Purpose: inspect persisted source reliability scores.

Query parameters:

- `scored_only` — optional boolean, default `false`
- `limit` — optional integer cap with a safe default
- `offset` — optional integer offset

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "filename": "source-a.pdf",
      "status": "analyzed",
      "reliability_score": 0.75,
      "created_at": "2026-04-15T12:00:00.000Z",
      "updated_at": "2026-04-15T12:10:00.000Z"
    }
  ],
  "meta": {
    "count": 1,
    "limit": 20,
    "offset": 0,
    "scored_only": true
  }
}
```

Rules:

- scores come from the persisted `sources.reliability_score` column; the route never recalculates them
- `scored_only=true` excludes rows where `reliability_score` is `null`
- the endpoint remains a source-inspection route, not a source-detail replacement

#### `GET /api/evidence/chains`

Purpose: inspect persisted evidence-chain rows grouped by thesis.

Query parameters:

- `thesis` — optional exact thesis selector; when omitted the route returns all persisted theses grouped in the response

Response shape:

```json
{
  "data": [
    {
      "thesis": "The event was a coordinated surveillance test.",
      "chains": [
        {
          "id": "uuid",
          "path": ["entity-a", "entity-b"],
          "strength": 0.88,
          "supports": true,
          "computed_at": "2026-04-15T12:00:00.000Z"
        }
      ]
    }
  ],
  "meta": {
    "thesis_count": 1,
    "record_count": 1
  }
}
```

Rules:

- the route reads only persisted chain rows from `evidence_chains`
- when no rows exist for the requested thesis, the route returns `200` with an empty `data` array instead of a not-found error
- the API groups rows by thesis so clients do not need to reconstruct the snapshot shape manually

#### `GET /api/evidence/clusters`

Purpose: inspect persisted spatio-temporal cluster snapshots.

Query parameters:

- `cluster_type` — optional `temporal | spatial | spatio-temporal`

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "cluster_type": "spatio-temporal",
      "center_lat": 52.52,
      "center_lng": 13.405,
      "time_start": "2024-01-01T00:00:00.000Z",
      "time_end": "2024-01-05T00:00:00.000Z",
      "event_count": 3,
      "event_ids": ["uuid", "uuid", "uuid"],
      "computed_at": "2026-04-15T12:00:00.000Z"
    }
  ],
  "meta": {
    "count": 1,
    "cluster_type": "spatio-temporal"
  }
}
```

Rules:

- the route exposes only persisted cluster rows; it never computes new clusters from entity geometry/date fields during the request
- empty cluster snapshots return `200` with an empty `data` array

### 4.3 Integration Points

- the route group consumes the existing bearer-auth and standard-tier rate limiting from Spec 70
- contradiction data comes from `entity_edges`; reliability data comes from `sources`; evidence chains come from `evidence_chains`; cluster snapshots come from `spatio_temporal_clusters`
- summary aggregation should reuse the same sparse-data reliability classification already established by `mulder export evidence`
- request-scoped logging should record route metadata such as filter set, thesis selector, result counts, and duration without introducing a second logging system

### 4.4 Implementation Phases

**Phase 1: repository read support + DTO design**
- add any missing read helpers for evidence-chain thesis discovery and cluster snapshot retrieval
- define the evidence route schemas and the snake_case response envelopes
- centralize DTO mapping so the route layer stays thin

**Phase 2: route-facing evidence bridge**
- implement the summary aggregator over the existing repositories
- implement contradiction, reliability, chains, and clusters readers
- preserve empty-state success behavior and Mulder JSON error handling for malformed requests

**Phase 3: route wiring + black-box QA**
- register the evidence route group and mount it in the Hono app
- add black-box tests for auth protection, filters, empty states, sync/read-only guarantees, and API build health
- verify the API package still compiles with the new route surface

## 5. QA Contract

1. **QA-01: `GET /api/evidence/summary` returns a synchronous evidence overview for an authenticated request**
   - Given: persisted evidence data exists in the database
   - When: `GET /api/evidence/summary` is called with a valid bearer token
   - Then: the response is `200` and returns counts for contradictions, duplicates, source reliability, evidence chains, and cluster snapshots

2. **QA-02: contradiction inspection filters the persisted contradiction edge set without mutating it**
   - Given: contradiction edges exist across potential, confirmed, and dismissed states
   - When: `GET /api/evidence/contradictions` is called with `status` filters
   - Then: the response only includes the requested contradiction states and the underlying edge rows are unchanged

3. **QA-03: source reliability inspection exposes persisted scores from `sources.reliability_score`**
   - Given: some sources have reliability scores and others do not
   - When: `GET /api/evidence/reliability/sources` is called with and without `scored_only=true`
   - Then: the response reflects the stored scores accurately and `scored_only` excludes `null` rows

4. **QA-04: evidence chains are returned grouped by thesis from persisted chain rows**
   - Given: evidence-chain rows exist for one or more theses
   - When: `GET /api/evidence/chains` is called with and without a `thesis` selector
   - Then: the response groups chains by thesis, returns the correct record counts, and never recomputes chains during the request

5. **QA-05: spatio-temporal cluster inspection returns persisted cluster snapshots**
   - Given: persisted cluster rows exist in `spatio_temporal_clusters`
   - When: `GET /api/evidence/clusters` is called with and without a `cluster_type` filter
   - Then: the response returns only the persisted matching rows and does not recompute clusters at request time

6. **QA-06: empty evidence datasets succeed with explicit empty envelopes**
   - Given: no contradictions, no evidence chains, or no clusters exist yet
   - When: the corresponding evidence routes are called
   - Then: the API returns `200` with empty `data` arrays or zero-count summaries instead of not-found or server errors

7. **QA-07: evidence routes stay synchronous and do not create jobs or pipeline runs**
   - Given: the evidence routes are mounted and the database already contains evidence data
   - When: any `GET /api/evidence/*` route is called successfully
   - Then: the response returns directly within the request/response cycle and leaves `jobs` / `pipeline_runs` counts unchanged

8. **QA-08: evidence routes stay behind the existing auth middleware**
   - Given: the evidence routes are mounted in the API app
   - When: an evidence route is requested without a valid bearer token
   - Then: the response is `401` and the route does not leak evidence data

9. **QA-09: malformed evidence query parameters fail at the HTTP edge**
   - Given: an invalid contradiction status or invalid cluster type query
   - When: the evidence route is called
   - Then: the API returns a Mulder JSON validation error and performs no evidence mutation work

10. **QA-10: the API package compiles with the new evidence route surface**
   - Given: the evidence routes, schemas, and repository exports are wired into `@mulder/api`
   - When: the API package build/typecheck runs
   - Then: the package compiles successfully and exports a bootable app with the evidence route group mounted

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

These routes should remain database-only and avoid any inline LLM, grounding, or analysis execution. They are operationally cost-sensitive because evidence dashboards and polling clients can query them frequently, so the implementation must stay lightweight, use the existing standard-tier rate limit, and read persisted evidence state instead of triggering expensive recomputation.
