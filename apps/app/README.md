# Mulder App

Product browser app for the cleaner, technical Mulder research workbench direction.

`apps/app` is the only active browser product app. The legacy V1 `demo/` app has been removed; reusable API integration lessons from it are captured in [`../../docs/product-app-api-integration.md`](../../docs/product-app-api-integration.md).

## Commands

```bash
pnpm --filter @mulder/app dev
pnpm --filter @mulder/app build
pnpm --filter @mulder/app preview
```

`dev` and `preview` use port `5174`.

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
