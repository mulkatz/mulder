# Testing Strategy

Mulder's CI is split into lanes so ordinary feature work gets fast feedback without hiding database or storage state leaks.

## Lanes

| Lane | Purpose | Default behavior |
|---|---|---|
| `unit` | Pure package/app tests without PostgreSQL, storage, Docker, or cloud services | Parallel |
| `schema` | Destructive migration/schema tests | Serial, isolated DB |
| `db` | Normal PostgreSQL-backed specs | Serial per shard, isolated DB |
| `heavy` | Slow upload, ingest, browser, and end-to-end-ish specs | Serial per shard, isolated DB |
| `external` | Real Docker, GCP, or live-service tests | Manual/opt-in |

## Rules For New Tests

- Prefer `unit` for pure package/app behavior. This lane is intentionally present even while it is small or empty; as new isolated library tests are added, they should fill this lane instead of being placed under DB-backed specs.
- Put tests that require PostgreSQL but not expensive end-to-end fixtures in `db`.
- Put destructive schema/migration tests in `schema`; do not mix them into `db`.
- Put long-running upload/ingest/browser flows in `heavy` and add them to `tests/test-runtime-manifest.json`.
- Put tests that require real Docker, GCP credentials, paid services, or live external services in `external`. These tests must stay opt-in and should use explicit env gates such as `MULDER_TEST_GCP=true` when applicable.
- After adding or moving tests, run `pnpm test:lanes:verify` to confirm every test file is assigned to exactly one lane.

## Local Verification

Use scoped or affected tests during feature work:

```bash
pnpm test:scope run step Mx-Yz -- --reporter=verbose
pnpm test:affected -- origin/main -- --reporter=verbose
```

Use full lane runs when changing shared infrastructure, migrations, worker dispatch, storage, or pipeline orchestration:

```bash
MULDER_TEST_ISOLATED_DB=true pnpm test:lane -- schema -- --reporter=verbose
MULDER_TEST_ISOLATED_DB=true pnpm test:lane -- db 1 2 -- --reporter=verbose
MULDER_TEST_ISOLATED_DB=true pnpm test:lane -- heavy 1 3 -- --reporter=verbose
```

