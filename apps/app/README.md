# Mulder App

Browser app for the cleaner, technical Mulder research workbench direction.

`apps/app` is the only active browser app. API integration decisions are captured in [`../../docs/app-api-integration.md`](../../docs/app-api-integration.md).

## Commands

```bash
pnpm --filter @mulder/app dev
pnpm --filter @mulder/app build
pnpm --filter @mulder/app preview
```

`dev` and `preview` use port `5174`.

## API And Auth

The app uses Mulder's cookie-backed browser auth. It never embeds an operator API key.

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

The app's look is controlled from `src/styles.css`. Light and dark mode are implemented through the same semantic tokens; components should use token-backed Tailwind utilities and should not branch on the active theme.

- Surface tokens: `--canvas`, `--panel`, `--panel-raised`, `--field`
- Text tokens: `--text`, `--text-muted`, `--text-subtle`, `--text-inverse`
- Structure tokens: `--border`, `--border-strong`, `--ring`
- Accent tokens: `--accent`, `--accent-hover`, `--accent-soft`
- Status tokens: `--success`, `--warning`, `--danger`, `--info`
- Density tokens: `--sidebar-width`, `--topbar-height`, `--radius-*`

## i18n, Theme, And Motion

- UI copy lives in `src/i18n/resources.ts` and is served through `i18next` / `react-i18next`.
- English and German are first-class locales. New UI strings should not be hard-coded in components.
- User language and theme preferences live in `src/app/preferences.tsx`.
- Motion uses `framer-motion` through `MotionConfig` in `src/app/Providers.tsx`.
- Animations should be sparse, fast, and respect `prefers-reduced-motion`.

The app intentionally avoids editorial serif language. It is sans-first, light-first, research-focused, and optimized for dense analysis screens without becoming a developer-only console.

Primary app references:

- [`../../docs/app-design-strategy.md`](../../docs/app-design-strategy.md)
- [`../../docs/app-api-integration.md`](../../docs/app-api-integration.md)
- [`../../docs/app-deployment.md`](../../docs/app-deployment.md)
