---
spec: "73"
title: "Search API Routes"
roadmap_step: M7-H7
functional_spec: ["§10.6", "§5"]
scope: single
issue: "https://github.com/mulkatz/mulder/issues/183"
created: 2026-04-15
---

# Spec 73: Search API Routes

## 1. Objective

Expose Mulder's hybrid retrieval stack over authenticated HTTP so remote clients can run the same synchronous search flow as `mulder query` without shell access or queue handoffs. Per `§10.6`, `POST /api/search` is a direct-response endpoint rather than a job producer; per `§5`, the route must stay a thin adapter over the existing vector, full-text, graph, RRF, and optional Gemini re-ranking pipeline instead of introducing a second retrieval implementation.

This step makes the read-side query surface available under the M7 API while preserving Mulder's existing retrieval semantics: strategy selection, `top_k`, confidence reporting, graph degradation behavior, and optional explain output.

## 2. Boundaries

- **Roadmap Step:** `M7-H7` — Search API routes (sync)
- **Target:** `apps/api/src/app.ts`, `apps/api/src/routes/search.schemas.ts`, `apps/api/src/routes/search.ts`, `apps/api/src/lib/search.ts`, `tests/specs/73_search_api_routes.test.ts`
- **In scope:** authenticated `POST /api/search`; HTTP request validation for query, strategy, `top_k`, and explain flags; a route-level retrieval bridge that loads Mulder config/services and calls the existing `@mulder/retrieval` orchestrator; API response mapping into Mulder's snake_case HTTP envelope; support for the public `no_rerank` query-string toggle so the middleware can keep strict vs standard rate tiers observable; and black-box tests covering successful search, validation failures, auth protection, empty-result behavior, explain output, and the synchronous no-job contract
- **Out of scope:** entity, evidence, source, story, taxonomy, or document routes (`M7-H8` through `M7-H10`); OpenAPI/Scalar publishing; pagination or saved search history; changes to the retrieval algorithms, prompt templates, or ranking weights; new query language/filter syntax; and any UI work (`M7-H11`)
- **Constraints:** keep the route synchronous and read-only; do not enqueue jobs or mutate `pipeline_runs`; call the existing retrieval orchestrator instead of duplicating vector/full-text/graph logic in `apps/api`; preserve the middleware contract from Spec 70, especially auth and `/api/search` rate limiting; and use the query-oriented database/runtime path for read traffic rather than inventing ad hoc connections

## 3. Dependencies

- **Requires:** Spec 37 (`M4-D7`) full-text search retrieval, Spec 39 (`M4-E3`) graph traversal retrieval, Spec 40 (`M4-E4`) RRF fusion, Spec 41 (`M4-E5`) LLM re-ranking, Spec 42 (`M4-E6`) hybrid retrieval orchestrator, Spec 69 (`M7-H3`) Hono server scaffold, and Spec 70 (`M7-H4`) API middleware stack
- **Blocks:** no later roadmap step is strictly blocked, but this step completes the synchronous query surface promised by `§10.6` and enables remote/API consumers to search the indexed corpus without falling back to CLI-only workflows

## 4. Blueprint

### 4.1 Files

1. **`apps/api/src/routes/search.schemas.ts`** — defines the HTTP request/query schemas and the snake_case search response envelope
2. **`apps/api/src/lib/search.ts`** — owns the route-facing retrieval bridge: load config, build or reuse the service registry, obtain the query pool, call `hybridRetrieve`, and map the result into HTTP DTOs
3. **`apps/api/src/routes/search.ts`** — registers `POST /api/search`, parses the body + query string, and delegates to the search bridge
4. **`apps/api/src/app.ts`** — mounts the search route under the existing middleware stack
5. **`tests/specs/73_search_api_routes.test.ts`** — black-box verification for the synchronous search contract

### 4.2 Route Contract

#### `POST /api/search`

Purpose: run Mulder's synchronous hybrid retrieval flow over HTTP.

Query parameters:

- `no_rerank=true` — optional public toggle that disables Gemini re-ranking for this request
- `rerank=false` — optional alias for the same behavior

Request body:

```json
{
  "query": "ufo sighting",
  "strategy": "hybrid",
  "top_k": 10,
  "explain": false
}
```

Rules:

- `query` is required and must be non-empty after trimming
- `strategy` is optional and must be one of `vector | fulltext | graph | hybrid`
- `top_k` is optional and must be a positive integer when provided
- `explain` is optional and defaults to `false`
- the rerank toggle lives in the query string so the middleware can determine strict vs standard rate-limit tier before the body is parsed
- the route is synchronous and read-only: it must not create queue jobs, pipeline runs, or any other side-effect rows

Success response:

```json
{
  "data": {
    "query": "ufo sighting",
    "strategy": "hybrid",
    "top_k": 10,
    "results": [
      {
        "chunk_id": "uuid",
        "story_id": "uuid",
        "content": "Observed lights moved silently across the sky...",
        "score": 0.82,
        "rerank_score": 0.91,
        "rank": 1,
        "contributions": [
          {
            "strategy": "vector",
            "rank": 1,
            "score": 0.82
          }
        ],
        "metadata": {}
      }
    ],
    "confidence": {
      "corpus_size": 12,
      "taxonomy_status": "bootstrapping",
      "corroboration_reliability": "low",
      "graph_density": 0.03,
      "degraded": false,
      "message": null
    },
    "explain": {
      "counts": {
        "vector": 20,
        "fulltext": 8
      },
      "skipped": [],
      "failures": {},
      "seed_entity_ids": [],
      "contributions": []
    }
  }
}
```

Response rules:

- the HTTP layer uses snake_case even though the retrieval package returns camelCase internals (`topK`, `seedEntityIds`, `rerankScore`, `chunkId`, `storyId`)
- `results` may be an empty array; that is still a successful `200` response
- `confidence` and `explain` are always returned so clients can distinguish "no hits" from degraded corpus conditions
- `explain.contributions` is populated only when `explain=true`; otherwise the field may be omitted or an empty array, but the outer explain block must remain structurally valid

### 4.3 Runtime Bridge

The route must remain a thin adapter over the existing retrieval implementation:

- load Mulder config through the shared loader
- obtain the API/logger context from the existing middleware contract where helpful for request-scoped logging
- create or reuse the standard service registry so the route uses the same embedding and LLM abstractions as CLI retrieval
- use the query-oriented PostgreSQL pool for synchronous search reads
- call `hybridRetrieve(pool, services.embedding, services.llm, config, query, options)`
- map the returned `HybridRetrievalResult` into the API response DTO without changing ranking semantics

This preserves the CLI/API parity rule from `CLAUDE.md`: the HTTP layer adapts inputs and outputs, but the retrieval logic lives in `@mulder/retrieval`.

### 4.4 Integration Points

- the route consumes the middleware protections from Spec 70, including auth and `/api/search` rate-limit tiers
- the retrieval bridge reuses the shipped `@mulder/retrieval` package instead of ad hoc SQL in `apps/api`
- request-scoped logging should record route-level metadata such as strategy, `top_k`, rerank mode, result count, and duration without inventing a second logging system
- the route keeps the public response envelope compatible with future OpenAPI/Scalar work, but that publishing work stays out of scope here

### 4.5 Implementation Phases

**Phase 1: HTTP contract + DTO mapping**
- add the search request schema and snake_case response schemas
- define the public `no_rerank` query-string contract
- map retrieval-layer camelCase fields into API-facing snake_case DTOs

**Phase 2: Retrieval bridge + route wiring**
- implement the route helper that loads config/services/query pool and calls `hybridRetrieve`
- register `POST /api/search`
- mount the route in the Hono app without weakening the existing middleware protections

**Phase 3: Black-box QA**
- add API-focused tests for successful searches, empty-result searches, invalid requests, auth protection, explain output, and the no-job synchronous contract
- verify the API package still compiles with the new route surface

## 5. QA Contract

1. **QA-01: `POST /api/search` returns a synchronous retrieval response for a valid authenticated request**
   - Given: an indexed corpus and a valid API key
   - When: `POST /api/search` is called with a non-empty query body
   - Then: the response is `200` and returns `data.query`, `data.strategy`, `data.top_k`, `data.results`, `data.confidence`, and `data.explain`

2. **QA-02: malformed search requests fail at the HTTP edge**
   - Given: a request body missing `query` or using an invalid `strategy` or `top_k`
   - When: `POST /api/search` is called
   - Then: the API returns a Mulder JSON client error and does not create queue or pipeline-run rows

3. **QA-03: the search route stays synchronous and read-only**
   - Given: the search route is mounted and the database already contains retrieval data
   - When: `POST /api/search` is called successfully
   - Then: the route performs retrieval directly, returns within the request/response cycle, and leaves `jobs` / `pipeline_runs` counts unchanged

4. **QA-04: `no_rerank` is a public per-request toggle**
   - Given: a valid search request
   - When: `POST /api/search?no_rerank=true` is called
   - Then: the response still succeeds through the same route contract while bypassing the reranker path for that request

5. **QA-05: explain mode exposes strategy provenance**
   - Given: a valid search request with `explain=true`
   - When: `POST /api/search` is called against a corpus with at least one hit
   - Then: the response includes `data.explain.counts`, `data.explain.seed_entity_ids`, and per-result strategy contribution details

6. **QA-06: no-match searches remain successful and observable**
   - Given: a well-formed query that has no meaningful matches in the indexed corpus
   - When: `POST /api/search` is called
   - Then: the API returns `200` with an empty `results` array plus the confidence/explain blocks instead of a not-found or server error

7. **QA-07: the search route stays behind the existing auth middleware**
   - Given: the search route is mounted in the API app
   - When: `POST /api/search` is called without a valid bearer token
   - Then: the response is `401` and no retrieval work is executed

8. **QA-08: the API package compiles with the new search route surface**
   - Given: the route, schemas, and retrieval bridge are wired into `@mulder/api`
   - When: the API package build/typecheck runs
   - Then: the package compiles successfully and exports a bootable app with the search route mounted

## 5b. CLI Test Matrix

N/A — no CLI commands are introduced or modified in this step.

## 6. Cost Considerations

This step is directly cost-sensitive because reranked search can call Gemini Flash synchronously. The public route must therefore preserve the middleware's strict-vs-standard rate-limit distinction, expose a `no_rerank` path for lower-cost traffic, and reject malformed requests before any embedding, retrieval, or LLM work begins.
