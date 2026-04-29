# Mulder Local Demo

This app is the local, API-backed Mulder browser demo and E2E harness. Login, documents, upload, Case Files, search,
Board, Audit, jobs, and corpus metrics all go through the real API against a deterministic local Postgres/storage
fixture.

The fixture setup is intentionally local-only. `demo:prepare` refuses to seed unless it is pointed at the local
docker-compose `mulder-postgres` service on port 5432 and `MULDER_ALLOW_LOCAL_E2E_SEEDING=local-docker-only` is set.
Do not use this setup path for the production demo database; production should contain only documents ingested through
the normal upload/pipeline flow.

## Credentials

- Email: `owner.e2e@mulder.local`
- Password: `correct horse battery staple`
- Seeded invite token for tests: `mulder-e2e-invite-token`

## Local Runtime

From the repository root:

```sh
cd demo
npm run demo:stack
```

`demo:stack` performs the full local E2E setup:

- Builds `@mulder/core`, retrieval, pipeline, worker, evidence, API, and CLI packages.
- Runs migrations and seeds the deterministic fixture corpus.
- Starts the API on `127.0.0.1:8080`.
- Starts the worker via `apps/cli/dist/index.js worker start --poll-interval 250 --concurrency 1`.
- Starts Vite on `127.0.0.1:5173` with real cookie auth and same-origin API proxying.

Useful single-process commands:

- `npm run demo:prepare` reseeds the guarded local Docker Postgres fixture and writes `.local/storage` artifacts.
- `npm run demo:api` starts only the API with the demo E2E config.
- `npm run demo:worker` starts only the worker.
- `npm run demo:web` starts only Vite.

## Verification

```sh
cd demo
npm run build
npm run lint
npm run test:e2e
```

The Playwright lane starts API, worker, and Vite, captures console/page/network/API failures, and drives the primary
browser flow: auth, Desk, Archive upload, Case File, Ask citations, Board drawer, Audit drawer, theme, invite, and logout.

From the repository root, also run:

```sh
pnpm test:api:e2e
```

## Troubleshooting

- `EADDRINUSE :8080` means an old API process is still running. Check it with `lsof -nP -iTCP:8080 -sTCP:LISTEN` and stop
  the stale `node apps/api/dist/index.js` process before restarting.
- Upload UI requires the worker. If uploads stay queued, use `npm run demo:stack` instead of starting only Vite.
- The demo uses cookie-backed auth. Do not set or bundle `VITE_MULDER_API_KEY`; browser API keys are intentionally out.
- Sparse-corpus corroboration is displayed as a status, not a numeric score. That is expected for the compact fixture.
