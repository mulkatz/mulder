# Mulder V1 Live Demo Deployment

This guide keeps production data clean: the live demo must be populated through the API/UI pipeline, never by SQL fixture seeding.

## Architecture

- Frontend: Cloudflare Pages, `https://mulder.mulkatz.dev`
- API: Cloud Run service, `https://api.mulder.mulkatz.dev`
- Worker: Cloud Run service using `scripts/run-worker-service.mjs`, minimum one instance, CPU always allocated
- Data: Cloud SQL Postgres, GCS, Firestore
- Users: Mulder Postgres tables (`api_users`, `api_invitations`, `api_sessions`)
- Invite delivery: API sends email through Resend in production; local/dev logs the invite link

## Required GCP Setup

Enable these APIs in `mulder-platform`:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  --project mulder-platform
```

Create:

- Artifact Registry repository: `mulder`
- Runtime service account: `mulder-runtime@mulder-platform.iam.gserviceaccount.com`
- Cloud SQL Postgres database with `vector`, `pg_trgm`, and `postgis`
- Secret Manager secret `mulder-config-yaml`
- Secret Manager secret `resend-api-key`
- DNS record/domain mapping for `api.mulder.mulkatz.dev`

The runtime service account needs access to Cloud SQL, GCS, Firestore, Document AI, Vertex AI, and the two runtime secrets.

## Production Environment

Cloud Run API environment:

```text
NODE_ENV=production
MULDER_CONFIG=/secrets/mulder.config.yaml
MULDER_CORS_ORIGINS=https://mulder.mulkatz.dev
MULDER_APP_BASE_URL=https://mulder.mulkatz.dev
MULDER_INVITE_DELIVERY=resend
MULDER_MAIL_FROM=<verified sender>
RESEND_API_KEY=<secret mounted from Secret Manager>
```

Production `mulder.config.yaml` browser auth must use:

```yaml
api:
  auth:
    browser:
      cookie_secure: true
      same_site: "None"
```

Cloudflare Pages environment:

```text
VITE_API_BASE_URL=https://api.mulder.mulkatz.dev
VITE_PREVIEW_AUTH_BYPASS=false
```

## Deploy

Use the manual GitHub Actions workflow `Deploy Live Demo`.

Required GitHub settings:

- Secret `GCP_CREDENTIALS_JSON`
- Variable `MULDER_MAIL_FROM`

The workflow builds `Dockerfile.api`, pushes the image to Artifact Registry, deploys `mulder-api`, deploys `mulder-worker`, and runs the live smoke check.

## First Owner Invite

After the API is healthy, request the first owner invitation:

```bash
MULDER_API_URL=https://api.mulder.mulkatz.dev \
MULDER_OWNER_EMAIL=<owner@example.com> \
MULDER_OPERATOR_API_KEY=<operator-api-key> \
pnpm invite:owner
```

The API sends the invite email in production. In local/dev with `MULDER_INVITE_DELIVERY=log`, the API logs the acceptance URL.

## Live Smoke

```bash
pnpm smoke:live
```

For authenticated smoke:

```bash
MULDER_SMOKE_EMAIL=<owner@example.com> \
MULDER_SMOKE_PASSWORD=<password> \
pnpm smoke:live
```

## Production Data Rules

Do not insert demo corpus rows directly into Cloud SQL. Populate the demo by logging in as owner and uploading real PDFs through the product. After processing, audit production for:

- no `full-functional-demo` metadata
- no `demo` fixture tags
- no fixed `11111111`, `22222222`, or `33333333` UUID families
- no `*.e2e@mulder.local` users
