---
spec: "74"
title: "Entity API Routes"
roadmap_step: M7-H8
functional_spec: ["§10.6"]
scope: phased
issue: "https://github.com/mulkatz/mulder/issues/185"
created: 2026-04-15
---

# Spec 74: Entity API Routes

## 1. Objective

Expose Mulder's entity-management surface over authenticated HTTP so remote clients can inspect, search, and reconcile entities without shelling into `mulder entity`. Per `§10.6`, entity lookup remains a synchronous database-backed API path rather than a queued workflow; per the M7 API architecture, the HTTP surface should cover the practical entity operations needed by clients: list/search, detail, edge inspection, and lightweight merge.

This step gives the API parity with the already-shipped repository and CLI capabilities while preserving Mulder's core rule that route handlers adapt inputs and outputs only. Entity state continues to live in PostgreSQL and all domain behavior continues to flow through the existing repository layer.

## 2. Boundaries

- **Roadmap Step:** `M7-H8` — Entity API routes (sync)
- **Target:** `apps/api/src/app.ts`, `apps/api/src/routes/entities.schemas.ts`, `apps/api/src/routes/entities.ts`, `apps/api/src/lib/entities.ts`, `tests/specs/74_entity_api_routes.test.ts`
- **In scope:** authenticated `GET /api/entities`; authenticated `GET /api/entities/:id`; authenticated `GET /api/entities/:id/edges`; authenticated `POST /api/entities/merge`; query validation for list/search filters; HTTP DTO mapping for entities, aliases, stories, and edges; not-found and validation handling; and black-box tests proving the sync contract, auth protection, filtering, detail hydration, and merge behavior
- **Out of scope:** evidence routes (`M7-H9`), document retrieval routes (`M7-H10`), UI work (`M7-H11`), taxonomy HTTP endpoints, alias mutation endpoints, batch merge workflows, and any new repository/database behavior beyond what the shipped entity repositories already provide
- **Constraints:** keep the routes behind the existing middleware/auth stack; stay synchronous and database-backed with no job creation; reuse `@mulder/core` repositories instead of ad hoc SQL inside handlers; keep list/detail reads in the standard rate-limit tier; and preserve the core entity semantics already established by Spec 51 instead of inventing a second merge model for HTTP

## 3. Dependencies

- **Requires:** Spec 24 (`M3-C3`) entity + alias repositories, Spec 25 (`M3-C4`) edge repository, Spec 51 (`M5-F3`) entity management CLI semantics, Spec 69 (`M7-H3`) Hono server scaffold, and Spec 70 (`M7-H4`) API middleware stack
- **Blocks:** no later roadmap step is strictly blocked, but this step completes the entity HTTP surface promised by `§10.6` and the M7 API architecture so non-CLI clients can browse and reconcile entities through the real API instead of shell wrappers

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/entities.schemas.ts`** — defines the query/body schemas plus the snake_case response envelopes for list, detail, edges, and merge
2. **`apps/api/src/lib/entities.ts`** — owns repository-backed helpers that read and merge entities, then map core rows into API DTOs
3. **`apps/api/src/routes/entities.ts`** — registers the entity route group and delegates to the route-facing entity helpers
4. **`apps/api/src/app.ts`** — mounts the entity route group beneath the existing middleware stack
5. **`tests/specs/74_entity_api_routes.test.ts`** — black-box verification for the entity API surface

### 4.2 Route Contract

#### `GET /api/entities`

Purpose: list and search canonical entity rows for authenticated API clients.

Query parameters:

- `type` — optional entity-type filter
- `search` — optional case-insensitive substring filter on entity name
- `taxonomy_status` — optional filter for `auto | curated | merged`
- `limit` — optional integer cap with a safe default
- `offset` — optional integer offset for parity with the current repository surface

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "canonical_id": null,
      "name": "J. Allen Hynek",
      "type": "person",
      "taxonomy_status": "curated",
      "taxonomy_id": "uuid",
      "corroboration_score": 0.92,
      "source_count": 4,
      "attributes": {},
      "created_at": "2026-04-15T12:00:00.000Z",
      "updated_at": "2026-04-15T12:30:00.000Z"
    }
  ],
  "meta": {
    "count": 1,
    "limit": 20,
    "offset": 0
  }
}
```

Rules:

- the list route returns repository-backed rows only; it does not inline aliases, stories, or full edge sets for every item
- filters only narrow the result set and never mutate entity state
- the HTTP surface uses snake_case even when core rows are camelCase

#### `GET /api/entities/:id`

Purpose: return one entity plus the related data clients need for inspection and detail views.

Response shape:

```json
{
  "data": {
    "entity": {
      "id": "uuid",
      "canonical_id": null,
      "name": "J. Allen Hynek",
      "type": "person",
      "taxonomy_status": "curated",
      "taxonomy_id": "uuid",
      "corroboration_score": 0.92,
      "source_count": 4,
      "attributes": {},
      "created_at": "2026-04-15T12:00:00.000Z",
      "updated_at": "2026-04-15T12:30:00.000Z"
    },
    "aliases": [
      {
        "id": "uuid",
        "entity_id": "uuid",
        "alias": "Hynek",
        "source": "manual"
      }
    ],
    "stories": [
      {
        "id": "uuid",
        "source_id": "uuid",
        "title": "Project Blue Book notes",
        "status": "enriched",
        "confidence": 0.9,
        "mention_count": 2
      }
    ],
    "merged_entities": []
  }
}
```

Rules:

- unknown entity IDs return a Mulder JSON not-found response
- the detail route must hydrate aliases, linked stories, and merged-into-this-entity lineage using the existing repository layer
- the route does not duplicate the full edge list inline; edge inspection lives on the dedicated edges endpoint

#### `GET /api/entities/:id/edges`

Purpose: inspect the entity's relationships without overloading the detail response.

Response shape:

```json
{
  "data": [
    {
      "id": "uuid",
      "source_entity_id": "uuid",
      "target_entity_id": "uuid",
      "relationship": "investigated",
      "edge_type": "RELATIONSHIP",
      "confidence": 0.84,
      "story_id": "uuid",
      "attributes": {}
    }
  ]
}
```

Rules:

- the route returns all edges already associated with the entity via the repository layer
- unknown entity IDs fail as not-found instead of returning a misleading empty success envelope for typos

#### `POST /api/entities/merge`

Purpose: expose the existing lightweight entity-merge workflow synchronously over HTTP.

Request body:

```json
{
  "target_id": "uuid",
  "source_id": "uuid"
}
```

Success response:

```json
{
  "data": {
    "target": {
      "id": "uuid"
    },
    "merged": {
      "id": "uuid",
      "canonical_id": "uuid"
    },
    "edges_reassigned": 3,
    "stories_reassigned": 2,
    "aliases_copied": 1
  }
}
```

Rules:

- the route reuses the existing `mergeEntities` repository behavior and validation semantics
- same-ID merges, missing entities, or already-merged source rows surface Mulder validation/not-found errors rather than partial success payloads
- the route is synchronous and mutation-scoped only to the merge operation; it must not enqueue jobs or create pipeline rows

### 4.3 Integration Points

- the route group consumes the middleware protections from Spec 70, including bearer auth and standard-tier rate limiting
- entity reads and merges reuse the shipped core repository functions instead of route-local SQL
- the API layer should preserve CLI/API behavior parity by mapping HTTP fields only, leaving merge semantics and entity hydration logic anchored in core repositories
- request-scoped logging should record route metadata such as filter set, entity ID, merge IDs, and result counts without introducing a second logging system

### 4.4 Implementation Phases

**Phase 1: DTOs + repository-backed entity bridge**
- add list/detail/edges/merge schemas
- implement the API-facing entity helper that loads the query pool and maps repository rows into snake_case DTOs

**Phase 2: Route wiring**
- register `GET /api/entities`
- register `GET /api/entities/:id`
- register `GET /api/entities/:id/edges`
- register `POST /api/entities/merge`
- mount the route group in the Hono app without weakening the existing middleware protections

**Phase 3: Black-box QA**
- add API-focused tests for list filtering, detail hydration, edge inspection, merge success, validation failures, not-found behavior, and auth protection
- verify the API package still compiles with the new route surface

## 5. QA Contract

1. **QA-01: `GET /api/entities` lists entities for an authenticated request**
   - Given: entities exist in the database
   - When: `GET /api/entities` is called with a valid bearer token
   - Then: the response is `200` and returns a `data` array plus `meta.count`

2. **QA-02: list filters narrow the entity result set without mutating data**
   - Given: entities with different `type`, `taxonomy_status`, and names exist
   - When: `GET /api/entities` is called with `type`, `taxonomy_status`, and `search` filters
   - Then: the response contains only the matching entities and the underlying entity rows are unchanged

3. **QA-03: `GET /api/entities/:id` returns the entity with aliases, linked stories, and merged lineage**
   - Given: an entity with aliases, story links, and optionally merged child entities exists
   - When: `GET /api/entities/:id` is called
   - Then: the response is `200` and returns `entity`, `aliases`, `stories`, and `merged_entities`

4. **QA-04: `GET /api/entities/:id/edges` returns relationship rows for the entity**
   - Given: an entity participates in one or more `entity_edges`
   - When: `GET /api/entities/:id/edges` is called
   - Then: the response is `200` and returns the related edge rows in the API envelope

5. **QA-05: unknown entity IDs fail with a Mulder JSON not-found response**
   - Given: an entity ID that does not exist
   - When: either detail or edges is requested
   - Then: the API returns a JSON not-found error and does not emit a success envelope

6. **QA-06: `POST /api/entities/merge` performs the shipped merge workflow synchronously**
   - Given: two distinct canonical entities exist
   - When: `POST /api/entities/merge` is called with `target_id` and `source_id`
   - Then: the response is `200`, the source entity is marked merged into the target, and the returned counters reflect the reassigned stories, edges, and aliases

7. **QA-07: invalid merge requests fail at the HTTP or repository edge**
   - Given: a merge request with the same ID twice, a missing entity, or an already-merged source
   - When: `POST /api/entities/merge` is called
   - Then: the API returns a Mulder validation/not-found error and does not partially mutate entity state

8. **QA-08: entity routes stay behind the existing auth middleware**
   - Given: the entity routes are mounted in the API app
   - When: any entity route is requested without a valid bearer token
   - Then: the response is `401` and no entity data is exposed

9. **QA-09: the API package compiles with the new entity route surface**
   - Given: the route, schemas, and entity bridge are wired into `@mulder/api`
   - When: the API package build/typecheck runs
   - Then: the package compiles successfully and exports a bootable app with the entity routes mounted

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

No direct third-party spend is added by these routes because the entity surface is PostgreSQL-backed and synchronous. The implementation is still operationally cost-sensitive because list polling and merge misuse could create unnecessary database load, so the routes must keep validation at the HTTP edge, stay on the existing standard rate-limit tier, and avoid any inline LLM, GCS, or job-queue work.
