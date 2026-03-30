---
spec: 12
title: Docker Compose — pgvector + PostGIS + Firestore Emulator
roadmap_step: M1-A11
functional_spec: ["§9.3", "§13", "§14"]
scope: single
issue: null
created: 2026-03-30
---

## 1. Objective

Provide a `docker-compose.yaml` at repo root that starts the full local development stack in one command: PostgreSQL with pgvector + PostGIS + pg_trgm extensions, and a Firestore emulator. This replaces ad-hoc `docker run` commands currently documented in test files, giving developers a reproducible, zero-config local environment.

## 2. Boundaries

**In scope:**
- `docker-compose.yaml` with two services: `postgres` and `firestore`
- PostgreSQL init script that enables required extensions (pgvector, PostGIS, pg_trgm)
- Health checks for both services
- Volume for PostgreSQL data persistence between restarts
- Named network for service-to-service communication

**Out of scope:**
- Cloud SQL proxy or production database configuration
- Terraform infrastructure
- Modifications to the database client or config loader
- CI/CD pipeline integration (future step)
- Any application code changes

## 3. Dependencies

### Requires (must exist before this step)
- M1-A1 (monorepo setup) — repo structure exists ✅
- M1-A6 (database client) — dual pool config with `localhost:5432` defaults ✅
- M1-A7 (core schema migrations) — migration SQL files exist ✅

### Required by (this step enables)
- M2-B1 (GCP + dev service implementations) — needs local DB for development
- All test suites — replaces ad-hoc `docker run` commands

## 4. Blueprint

### 4.1 Files

| File | Action | Purpose |
|------|--------|---------|
| `docker-compose.yaml` | Create | Service definitions for postgres + firestore |
| `docker/postgres/init-extensions.sh` | Create | Init script to enable pgvector, PostGIS, pg_trgm |

### 4.2 docker-compose.yaml

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    container_name: mulder-postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: mulder
      POSTGRES_PASSWORD: mulder
      POSTGRES_DB: mulder
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init-extensions.sh:/docker-entrypoint-initdb.d/init-extensions.sh
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mulder"]
      interval: 5s
      timeout: 3s
      retries: 5

  firestore:
    image: google/cloud-sdk:emulators
    container_name: mulder-firestore
    command: >
      gcloud emulators firestore start
      --host-port=0.0.0.0:8080
      --project=mulder-dev
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8080/ || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

Key decisions:
- **pgvector/pgvector:pg17** — latest PostgreSQL 17 with pgvector pre-installed. The existing tests already use `pg17`.
- **Named container `mulder-postgres`** — tests reference containers by name. This aligns with existing test infrastructure that uses `mulder-pg-test` (tests will be updated to use `mulder-postgres` or can continue using standalone containers).
- **Init script for PostGIS + pg_trgm** — pgvector image has `vector` extension built-in, but PostGIS and pg_trgm need separate installation via the init script.
- **`google/cloud-sdk:emulators`** — lighter image specifically for emulators.
- **Volume `pgdata`** — persists data between `docker compose stop/start`, cleared by `docker compose down -v`.
- **Health checks** — enables `docker compose up --wait` and `depends_on` conditions.

### 4.3 docker/postgres/init-extensions.sh

```bash
#!/bin/bash
set -e

# Install PostGIS (pgvector is pre-installed in the base image)
apt-get update -qq && apt-get install -y -qq postgresql-17-postgis-3 > /dev/null 2>&1

# Enable all required extensions in the mulder database
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
```

This script runs once on first container initialization (fresh volume). The extensions match `001_extensions.sql` migration exactly, ensuring migrations are idempotent.

### 4.4 Integration Points

- **Config defaults** already point to `localhost:5432` with user `mulder` — no config changes needed.
- **Existing tests** use `docker exec mulder-pg-test` — they can either be updated to use `mulder-postgres` or continue with standalone containers. No breaking change.
- **Firestore emulator** is accessible at `localhost:8080` — the `FIRESTORE_EMULATOR_HOST=localhost:8080` env var enables automatic SDK routing.

## 5. QA Contract

### QA-01: postgres-starts
**Given** Docker is running and port 5432 is free
**When** `docker compose up -d postgres` is run
**Then** the `mulder-postgres` container reaches `healthy` status within 30 seconds

### QA-02: extensions-available
**Given** the postgres service is healthy
**When** querying `SELECT extname FROM pg_extension`
**Then** the result includes `vector`, `postgis`, and `pg_trgm`

### QA-03: firestore-starts
**Given** Docker is running and port 8080 is free
**When** `docker compose up -d firestore` is run
**Then** the `mulder-firestore` container reaches `healthy` status within 60 seconds

### QA-04: database-accessible
**Given** both services are healthy
**When** connecting with `psql -h localhost -U mulder -d mulder`
**Then** the connection succeeds and queries can be executed

### QA-05: migrations-run-cleanly
**Given** the postgres service is healthy with a fresh database
**When** running `npx mulder db migrate` (or the equivalent CLI command)
**Then** all migrations complete successfully with exit code 0

### QA-06: data-persists-across-restart
**Given** data has been inserted into the database
**When** `docker compose stop postgres && docker compose start postgres`
**Then** the previously inserted data is still present

### QA-07: clean-slate
**Given** the services are running with data
**When** `docker compose down -v` is run
**Then** all containers stop and the volume is removed (next `up` starts fresh)
