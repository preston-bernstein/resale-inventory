# Resale Inventory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local-first admin dashboard for tracking book and clothing resale inventory — add items, track listing/sale status through a state machine, upload photos, and follow an in-app seller playbook covering photography, pricing, platform choice, and shipping.

Built with Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4, and a single-file SQLite database via `better-sqlite3` — no external services required to run it.

## Features

- **Multi-category inventory**: books and clothing share a common `items` table with category-specific detail tables (condition vocabularies, measurements, etc. differ per category)
- **Photo-forward inventory grid**: cover photos, category/status badges, condition-tinted placeholders for items without photos yet
- **Client-side image optimization**: photos are downscaled and recompressed in the browser before upload
- **Status state machine**: Unlisted → Listed → Sale Pending → Sold, with terminal Removed/Donated/Discarded states and full price history
- **Smart forms**: autocomplete suggestions drawn from your own listing history, auto-generated listing titles for clothing
- **Dark mode**: class-based, respects system preference by default, persists an explicit toggle choice
- **CSV export/import** for bulk inventory management
- **Seller Playbook** (`/playbook`): a 17-step workflow guide covering prep, photography, platform selection, pricing, listing copy, and shipping — see [`docs/clothing-resale-research.md`](docs/clothing-resale-research.md) for sourcing
- **PWA-installable**, with a documented phone-access path over Tailscale (see [`docs/PHONE-ACCESS.md`](docs/PHONE-ACCESS.md))

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000/inventory](http://localhost:3000/inventory). The SQLite database is created automatically at `data/inventory.db` on first run, with schema migrations applied on every boot (see `lib/db.ts` and `data/migrations/`).

## Testing and QA

This project has a deliberately strict QA bar — see `docs/` and the `.claude/skills/` directory for the full architecture/QA contract this codebase is held to.

```bash
npm test              # unit + component tests (Vitest)
npm run test:coverage # with coverage report (85/80/85/85 thresholds enforced)
npm run test:e2e      # Playwright end-to-end suite
npm run test:mutation # Stryker mutation testing
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint (strict TypeScript rules)
npm run analyze       # fallow (dead code, duplication, complexity)
```

**Never point any test/build/dev command at `data/inventory.db` directly** — it's the real, live inventory. Every test-running mechanism in this repo (`vitest.config.ts`, `playwright.config.ts`) is configured to default to a scratch database via `BOOKSELLER_DB_PATH`/`BOOKSELLER_PHOTOS_PATH`, so this should never come up in normal use — but if you're invoking `next dev`/`next build` manually for some other purpose, set those env vars explicitly.

## Marketplace Connectors

This app can create, update, mark-sold, and delist inventory items on eight marketplaces — eBay, Etsy, Amazon, Poshmark, Depop, Mercari, Vinted, and Grailed — through one shared connector interface, gated by the multi-tenant consent/kill-switch system. No live credentials are configured out of the box.

| Platform | Tier | Notes |
|---|---|---|
| eBay | Real-Sandbox-tested | Exercised against eBay's actual Sandbox environment when `EBAY_SANDBOX_CLIENT_ID`/`EBAY_SANDBOX_CLIENT_SECRET` are set; skip-gated otherwise. |
| Etsy | Live-draft-only | Real API, no sandbox exists — listings are always created in draft state, never activated. |
| Amazon | Inert-until-credentialed | Throws `AmazonNotConfiguredError` until `AMAZON_LWA_CLIENT_ID`/`AMAZON_LWA_CLIENT_SECRET`/`AMAZON_SP_API_REFRESH_TOKEN` are all set; requires a paid Professional Selling Plan + Developer Profile to obtain. |
| Poshmark | Dry-run-until-credentialed | Playwright-driven; durable 60-day relist cooldown + 3500/24h share cap enforced regardless of credential state. |
| Depop / Mercari / Vinted / Grailed | Dry-run-until-credentialed | Playwright-driven; conservative 1-action/10s pacing default (no documented platform policy to match). |

Note that `playwright` is now a production dependency, not just the existing test-only `@playwright/test` — this is a deployment-model decision: the Playwright-driven connectors need a persistent server process (not serverless/edge-friendly), and their browser binaries must be provisioned at deploy time via `npx playwright install` (not automatically covered by `npm install --production`).

See [`.env.example`](.env.example) for the platform-level app credentials each connector reads. Per-tenant marketplace login credentials (as opposed to the app-level API keys above) are stored separately, encrypted, via the existing multi-tenant credential system — not configured through environment variables.

## Project structure

- `app/` — Next.js App Router pages and API routes
- `components/` — shared React components
- `lib/` — business logic (money/ISBN/clothing validation, DB access, backups)
- `data/migrations/` — versioned SQL migrations, applied via `PRAGMA user_version` gating in `lib/db.ts`
- `docs/` — research notes, the seller playbook source, and spec folders for past features
- `.claude/skills/` — accumulated project knowledge (architecture decisions, known failure modes, QA/debugging playbooks) consumed by Claude Code when working in this repo
