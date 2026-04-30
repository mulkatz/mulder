# Mulder Product App Deployment and Infrastructure Runbook

This runbook describes what must be in place before the product app is exposed to real users. It is intentionally configuration-neutral: do not commit private domains, GCP project IDs, sender addresses, customer names, private corpus choices, API keys, service-account keys, or production config files to this open-source repository.

Use placeholders in repo-tracked documentation and code:

- `<app-origin>` for the Cloudflare frontend origin
- `<api-origin>` for the public API origin
- `<gcp-project-id>` for the GCP project
- `<region>` for the Cloud Run and Artifact Registry region
- `<owner@example.com>` for the first product owner

Store real values in Cloudflare settings, GitHub Actions secrets or variables, GCP Secret Manager, DNS, and private operator notes.

## Scope

The target product UI is `apps/app`. Product API integration rules are preserved in [`docs/product-app-api-integration.md`](./product-app-api-integration.md).

The product app must be populated through the product pipeline only:

- no SQL fixture seeding in production
- no checked-in production corpus configuration
- no showcase UUID families
- no `*.e2e@mulder.local` users
- no showcase metadata in production data

## Target Architecture

| Area | Target |
| --- | --- |
| Frontend | Cloudflare Pages serving `apps/app` at `<app-origin>` |
| API | GCP Cloud Run service at `<api-origin>` |
| Worker | Separate Cloud Run worker service using the same container image |
| Database | Cloud SQL Postgres |
| Object storage | GCS bucket for document artifacts |
| Observability projections | Firestore |
| Auth | Product users in Postgres: `api_users`, `api_invitations`, `api_sessions` |
| App login | Mulder auth, not GCP IAM |
| Invite delivery | API sends email in production; local/dev logs invite links |

## Current Repo State

Already present:

- API production container via `Dockerfile.api`
- manual GitHub Actions workflow for API and worker deployment
- API and worker Cloud Run deployment steps
- Resend-backed invite delivery plumbing
- owner invite helper: `pnpm invite:owner`
- live smoke helper: `pnpm smoke:live`
- one-command local product-app dev entrypoint: `pnpm dev`
- API-backed `apps/app` shell with browser auth, loading, empty, and error states
- product-app API integration notes in `docs/product-app-api-integration.md`
- `wrangler.json` points Cloudflare assets at `apps/app/dist`

Still required before live:

- create and permission GCP infrastructure
- create production secrets
- run production database migrations
- deploy API and worker
- configure Cloudflare Pages
- create the first owner invitation
- upload real pilot PDFs through the product
- run production smoke and browser QA

## Release Blockers

Do not go live until all of these are true:

- `apps/app` does not depend on checked-in fixture data for product screens.
- Cloudflare production has `VITE_API_BASE_URL=<api-origin>`.
- The API health check at `<api-origin>/api/health` returns 200.
- Production database migrations have completed successfully.
- The worker is deployed and processing jobs outside HTTP request handlers.
- Owner invite email delivery is verified.
- A PDF uploaded through the UI completes the API and worker pipeline.
- Browser QA passes on desktop and mobile for the main live routes.

## Frontend Work Order: Cloudflare Pages

### 1. Decide the public frontend origin

Choose `<app-origin>` outside the repo, for example in private deployment notes. Create or approve the DNS records in Cloudflare.

### 2. Create the Cloudflare Pages project

`apps/app` is part of the root pnpm workspace. Use the monorepo build path:

```text
Root directory: /
Install command: pnpm install --frozen-lockfile
Build command: pnpm --filter @mulder/app build
Build output directory: apps/app/dist
```

Do not use the old standalone npm app path. It is obsolete now that the app lives at `apps/app`.

The local build command is:

```text
pnpm --filter @mulder/app build
```

### 3. Configure Cloudflare environment variables

Production:

```text
VITE_API_BASE_URL=<api-origin>
```

Do not add operator API keys, preview auth bypasses, mock data toggles, or fixture fallbacks to the browser bundle.

### 4. Verify product app API integration before production

Before assigning the production domain to `apps/app`, verify that the current API-backed product shell still has:

- API client support for `VITE_API_BASE_URL`
- session bootstrap against `GET /api/auth/session`
- login, logout, and invite acceptance screens
- no operator API keys in the browser bundle
- API-backed loading, empty, success, and error states
- no checked-in fixture fallback for product screens
- visible production API errors rather than masked fallback data
- a green repo-root `pnpm --filter @mulder/app build`

### 5. Browser QA the deployed frontend

Check desktop and mobile widths for:

- login
- invite acceptance
- overview
- analysis runs
- evidence workspace
- documents and upload once connected
- search once connected
- graph and activity once connected

For each route, verify:

- no console errors
- no overlapping UI
- professional empty states for a fresh database
- loading states do not shift the layout badly
- API failures show product-appropriate errors
- no preview or mock data appears in production

## Backend Work Order: GCP API and Worker

### 1. Choose deployment values privately

Record these outside the repo:

```text
GCP project: <gcp-project-id>
Region: <region>
API origin: <api-origin>
App origin: <app-origin>
Runtime service account: mulder-runtime@<gcp-project-id>.iam.gserviceaccount.com
```

### 2. Enable required GCP APIs

The deployment workflow currently enables only the core deploy APIs. Before live, make sure the full runtime set is enabled:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudresourcemanager.googleapis.com \
  documentai.googleapis.com \
  firestore.googleapis.com \
  iam.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  serviceusage.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  aiplatform.googleapis.com \
  --project <gcp-project-id>
```

### 3. Create GCP infrastructure

Create:

- Artifact Registry Docker repository named `mulder`
- runtime service account `mulder-runtime@<gcp-project-id>.iam.gserviceaccount.com`
- Cloud SQL Postgres instance
- production database and database user
- GCS bucket for production document artifacts
- Firestore database for observability projections
- Document AI processor and location
- Vertex AI runtime location and budget controls
- API domain mapping for `<api-origin>`
- DNS record for `<api-origin>`

Cloud SQL must have these extensions installed in the production database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;
```

### 4. Create production secrets

Create Secret Manager entries for:

- `mulder-config-yaml`
- `resend-api-key` or the selected mail provider key
- database password, either inside `mulder-config-yaml` or as a separate secret referenced by private config generation
- browser session secret
- operator API key

The production `mulder.config.yaml` must not be committed. It should be based on `mulder.config.example.yaml` and stored in Secret Manager.

Required production auth settings:

```yaml
api:
  auth:
    browser:
      cookie_secure: true
      same_site: "None"
```

Use `SameSite=None` because the frontend and API are expected to be on different origins. The session cookie should be `HttpOnly`, `Secure`, and scoped to the API host.

### 5. Grant IAM permissions

The runtime service account needs least-privilege access for:

- Cloud SQL Client
- Secret Manager Secret Accessor for the runtime secrets
- GCS object access on the production artifact bucket
- Firestore or Datastore user access for observability projections
- Document AI API User
- Vertex AI User
- Logs Writer

The deploy identity needs:

- Artifact Registry Writer
- Cloud Run Admin
- Service Account User on the runtime service account
- Service Usage Admin if the workflow is allowed to enable APIs
- enough Secret Manager access to attach runtime secrets to Cloud Run

For open-source safety, prefer GitHub Workload Identity Federation over long-lived JSON service-account keys. The current workflow supports `GCP_CREDENTIALS_JSON`; treat that as a temporary deployment shortcut unless a private deployment policy explicitly accepts it.

## Backend Deploy

Use the manual GitHub Actions workflow `Deploy Product App`.

Required GitHub configuration:

```text
Secret: GCP_CREDENTIALS_JSON
Variable: MULDER_MAIL_FROM
```

Workflow inputs:

```text
project_id=<gcp-project-id>
region=<region>
api_domain=<api-origin>
app_origin=<app-origin>
```

The workflow builds `Dockerfile.api`, pushes the image to Artifact Registry, deploys `mulder-api`, deploys `mulder-worker`, and runs the live smoke check.

Cloud Run API environment:

```text
NODE_ENV=production
MULDER_CONFIG=/secrets/mulder.config.yaml
MULDER_CORS_ORIGINS=<app-origin>
MULDER_APP_BASE_URL=<app-origin>
MULDER_INVITE_DELIVERY=resend
MULDER_MAIL_FROM=<verified sender>
RESEND_API_KEY=<mounted secret>
```

The API must allow CORS only for the production frontend origin:

```text
Origin: <app-origin>
Credentials: enabled
Headers: Content-Type, Authorization, X-Request-Id
Methods: app-used methods only
```

## Database Migrations

Production migrations are mandatory before first live traffic and before the first upload.

The current deploy workflow does not run migrations. Add one of these before go-live:

- a Cloud Run Job that runs the built CLI against `/secrets/mulder.config.yaml`
- a dedicated GitHub Actions migration step using the same image and runtime service account
- a one-off operator command from a trusted environment with production config access

The CLI command is:

```bash
node apps/cli/dist/index.js db migrate /secrets/mulder.config.yaml
```

Also verify status:

```bash
node apps/cli/dist/index.js db status /secrets/mulder.config.yaml
```

Treat a failed or skipped migration check as a release blocker.

## First Owner Bootstrap

After the API is deployed, healthy, and migrated, create the first owner invitation:

```bash
MULDER_API_URL=<api-origin> \
MULDER_OWNER_EMAIL=<owner@example.com> \
MULDER_OPERATOR_API_KEY=<operator-api-key> \
pnpm invite:owner
```

The API sends the invite email in production. In local/dev with log delivery enabled, it logs the acceptance URL server-side.

After the first owner accepts the invitation, all future users should be invited from the product admin flow.

## Product App Data

Do not insert product corpus rows directly into Cloud SQL.

Populate the live corpus through the product:

1. Log in as the owner.
2. Upload the agreed pilot PDFs through the UI.
3. Let API and worker processing complete.
4. Verify the documents, stories, entities, retrieval, and analysis views from the frontend.

The checked-in PDFs in `fixtures/raw/` can be used for technical smoke only if they are acceptable for the product trial. Any curated real pilot corpus choice belongs in private operator notes, not in this repo.

After processing, audit production for:

```sql
-- These are examples of the checks to perform. Adjust table names if the schema evolves.
SELECT * FROM api_users WHERE email LIKE '%.e2e@mulder.local';
SELECT * FROM sources WHERE id::text LIKE '11111111-%' OR id::text LIKE '22222222-%' OR id::text LIKE '33333333-%';
```

Also check metadata and tags for retired showcase labels.

## No-Deploy Local Smoke

Run this before any live deployment attempt.

API smoke with a local API:

```bash
MULDER_API_URL=http://127.0.0.1:8080 \
pnpm smoke:live
```

Authenticated API smoke after accepting a local invitation:

```bash
MULDER_API_URL=http://127.0.0.1:8080 \
MULDER_SMOKE_EMAIL=<owner@example.com> \
MULDER_SMOKE_PASSWORD=<password> \
pnpm smoke:live
```

Browser smoke against the local product app:

- unauthenticated `/` redirects to `/login`
- login succeeds with the local owner account
- protected `/`, `/runs`, and `/evidence` render without console errors
- logout redirects back to `/login`

Expected API smoke results:

- `GET /api/health` returns 200
- unauthenticated protected API calls return 401
- authenticated document calls return 200

## Production Smoke

Run the unauthenticated smoke:

```bash
MULDER_API_URL=<api-origin> \
pnpm smoke:live
```

Run authenticated smoke after the owner accepts the invite:

```bash
MULDER_API_URL=<api-origin> \
MULDER_SMOKE_EMAIL=<owner@example.com> \
MULDER_SMOKE_PASSWORD=<password> \
pnpm smoke:live
```

Minimum pass criteria:

- `GET /api/health` returns 200
- unauthenticated protected API calls return 401
- login creates a secure browser session cookie
- authenticated document calls return 200
- owner can create an invite
- recipient receives the invite email
- PDF upload creates a source
- worker advances queued jobs
- processed documents appear in the product app

## Infrastructure Checklist Before Go-Live

Operator-owned:

- Cloudflare account access confirmed
- frontend custom domain created
- API DNS record created
- GCP project selected
- GCP billing enabled
- GCP region selected
- required APIs enabled
- Cloud SQL created, backed up, and extension-ready
- production GCS bucket created
- Firestore created
- Document AI processor created
- Vertex AI access verified
- transactional email provider approved
- sender domain or sender address verified
- first owner email provided
- initial live corpus selected privately

Engineering-owned:

- `apps/app` API integration completed
- `apps/app` production build path configured
- no mock or fixture fallback in production product screens
- Cloud Run API deployed
- Cloud Run worker deployed
- production migrations run
- first owner invite created
- live upload tested
- production smoke passed
- browser QA screenshots reviewed

## Recommended Follow-Up PRs

1. `apps/app` production readiness
   - Keep `apps/app` as the monorepo workspace package for the product UI.

2. Production migration job
   - Add a Cloud Run Job or GitHub Actions step that runs `db migrate` with production config.

3. Deployment identity hardening
   - Replace `GCP_CREDENTIALS_JSON` with GitHub Workload Identity Federation.

4. Live QA automation
   - Add Playwright smoke screenshots for desktop and mobile against `<app-origin>`.
