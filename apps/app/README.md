# Mulder App

Product browser app for the cleaner, technical Mulder research workbench direction.

`apps/app` is the only active browser product app. Product API integration decisions are captured in [`../../docs/product-app-api-integration.md`](../../docs/product-app-api-integration.md).

## Commands

```bash
pnpm --filter @mulder/app dev
pnpm --filter @mulder/app build
pnpm --filter @mulder/app preview
```

`dev` and `preview` use port `5174`.

## API And Auth

The product app uses Mulder's cookie-backed browser auth. It never embeds an operator API key.

```bash
cp apps/app/.env.example apps/app/.env.local
```

- `VITE_API_BASE_URL`: public API origin for deployed builds.
- `VITE_API_PROXY_TARGET`: local API target for the Vite `/api` proxy.
- Login route: `/login`
- Invitation route: `/auth/invitations/:token`

## Production Build

Cloudflare Pages should build from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @mulder/app build
```

Build output is `apps/app/dist`. Production only needs `VITE_API_BASE_URL=<api-origin>` in the browser environment.

## Design Tokens

The product app look is controlled from `src/styles.css`.

- Surface tokens: `--canvas`, `--panel`, `--panel-raised`, `--field`
- Text tokens: `--text`, `--text-muted`, `--text-subtle`, `--text-inverse`
- Structure tokens: `--border`, `--border-strong`, `--ring`
- Accent tokens: `--accent`, `--accent-hover`, `--accent-soft`
- Status tokens: `--success`, `--warning`, `--danger`, `--info`
- Density tokens: `--sidebar-width`, `--topbar-height`, `--radius-*`

The app intentionally avoids the v1 editorial serif language. It is sans-first, light-first, research-focused, and optimized for dense analysis screens without becoming a developer-only console.

Primary product references:

- [`../../docs/product-app-design-strategy.md`](../../docs/product-app-design-strategy.md)
- [`../../docs/product-app-api-integration.md`](../../docs/product-app-api-integration.md)
- [`../../docs/product-app-deployment.md`](../../docs/product-app-deployment.md)
