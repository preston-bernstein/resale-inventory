# Resale Inventory

Resale Inventory is a local-first web app that tracks books, clothing and electronics you sell online. It follows each item from unlisted to sold, stores photos, and can list items on eight marketplaces.

It uses Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4 and a SQLite file through `better-sqlite3`. It needs no external service to run.

## Run it

1. Get read access to the private `credential-crypto` GitHub repo. `npm install` fetches it.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open [http://localhost:3000/inventory](http://localhost:3000/inventory).

`npm run dev` binds to `127.0.0.1` only. The first run creates `data/inventory.db` and applies the migrations in `data/migrations/`.

## What it does

- Keeps books, clothing and electronics in one `items` table, with a detail table per category.
- Moves each item through these states: Unlisted, Listed, Sale Pending, Sold, Removed, Donated, Discarded.
- Resizes and recompresses photos in the browser before upload.
- Suggests form values from your own listing history.
- Imports and exports inventory as CSV.
- Shows a 17-step seller playbook at `/playbook`. The source is `docs/SELLER-PLAYBOOK.md`.
- Installs as a PWA. `docs/PHONE-ACCESS.md` shows how to reach it from a phone over Tailscale.
- Supports accounts per seller (`/signup`, `/login`). It can also sit behind Authentik forward-auth. See `docs/AUTHENTIK-DEPLOYMENT.md`.

## Configure it

Every setting is optional. Copy `.env.example` to `.env` and uncomment what you need. It covers storage paths, the credential encryption key, Authentik, the public origin for phone QR codes, and marketplace API keys.

## Marketplace connectors

Each connector creates, updates, marks sold and delists listings through one shared interface. The app ships with no live credentials. The code is in `lib/connectors/`.

| Platform | Tier | Behavior |
|---|---|---|
| eBay | Sandbox-tested | Runs against the eBay Sandbox when `EBAY_SANDBOX_CLIENT_ID` and `EBAY_SANDBOX_CLIENT_SECRET` are set. Tests skip otherwise. |
| Etsy | Live-draft-only | Uses the real API. Listings stay in draft. |
| Amazon | Inert until credentialed | Throws `AmazonNotConfiguredError` until `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET` and `AMAZON_SP_API_REFRESH_TOKEN` are set. |
| Poshmark, Depop, Mercari, Vinted, Grailed, Swappa | Dry-run until credentialed | Driven by Playwright. Swappa takes electronics only. |

Poshmark enforces a 60-day relist cooldown and a cap of 3500 shares per 24 hours.

The Playwright connectors need a long-running server and a browser. Run `npx playwright install` at deploy time. Sellers enter marketplace logins in the app. The app stores them encrypted, not in environment variables.

## Test

Run these from the repo root.

```bash
npm test              # Vitest unit and component tests
npm run test:coverage # Vitest with coverage thresholds (85 statements, 80 branches, 85 functions, 85 lines)
npm run test:e2e      # Playwright end-to-end tests
npm run test:mutation # Stryker mutation tests
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint
npm run analyze       # fallow: dead code, duplication, complexity
```

Never point a test, build or dev command at `data/inventory.db`. It is the live inventory. `vitest.config.ts` and `playwright.config.ts` default to a scratch database. If you run `next dev` or `next build` by hand, set `BOOKSELLER_DB_PATH` and `BOOKSELLER_PHOTOS_PATH` yourself.

## Layout

- `app/`: pages and API routes.
- `components/`: shared React components.
- `lib/`: business logic, database access, connectors, backups.
- `data/migrations/`: SQL migrations, gated by `PRAGMA user_version` in `lib/db.ts`.
- `docs/`: research notes, the playbook source, and one spec folder per feature.
