# Mulder V1 Live Demo Deployment

This guide keeps production data clean: the live demo must be populated through the API/UI pipeline, never by SQL fixture seeding.

Keep deployment-specific domains, project IDs, sender addresses, and corpus choices outside the repository. Store them in GitHub Actions inputs/secrets, Secret Manager, DNS, hosting environment variables, or private operator notes.

## Architecture

- Frontend: static app host, for example Cloudflare Pages, `<app-origin>`
- API: Cloud Run service, `<api-origin>`
- Worker: Cloud Run service using `scripts/run-worker-service.mjs`, minimum one instance, CPU always allocated
- Data: Cloud SQL Postgres, GCS, Firestore
- Users: Mulder Postgres tables (`api_users`, `api_invitations`, `api_sessions`)
- Invite delivery: API sends email through Resend in production; local/dev logs the invite link

## Required GCP Setup

Enable these APIs in the target GCP project:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  --project <gcp-project-id>
```

Create:

- Artifact Registry repository: `mulder`
- Runtime service account: `mulder-runtime@<gcp-project-id>.iam.gserviceaccount.com`
- Cloud SQL Postgres database with `vector`, `pg_trgm`, and `postgis`
- Secret Manager secret `mulder-config-yaml`
- Secret Manager secret `resend-api-key`
- DNS record/domain mapping for `<api-origin>`

The runtime service account needs access to Cloud SQL, GCS, Firestore, Document AI, Vertex AI, and the two runtime secrets.

## Production Environment

Cloud Run API environment:

```text
NODE_ENV=production
MULDER_CONFIG=/secrets/mulder.config.yaml
MULDER_CORS_ORIGINS=<app-origin>
MULDER_APP_BASE_URL=<app-origin>
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
VITE_API_BASE_URL=<api-origin>
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
MULDER_API_URL=<api-origin> \
MULDER_OWNER_EMAIL=<owner@example.com> \
MULDER_OPERATOR_API_KEY=<operator-api-key> \
pnpm invite:owner
```

The API sends the invite email in production. In local/dev with `MULDER_INVITE_DELIVERY=log`, the API logs the acceptance URL.

## Live Smoke

```bash
MULDER_API_URL=<api-origin> \
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
