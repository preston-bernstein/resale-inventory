# internal-inventory-app — execution routing

This is a local-first Next.js/SQLite app. Every checkout — including this one — has its own
independent SQLite database under `data/inventory.db`, created automatically on first
`next build`/`dev`/`start`. There is no shared database between checkouts: running the app
locally never reads or writes anyone else's data, and a fresh clone always starts with an
empty inventory.

If this repo is deployed somewhere persistent (a home server, a VPS, etc.), treat that
deployment's `data/inventory.db` as the only copy of real data, and treat every other
checkout's `data/inventory.db` as disposable scratch data — never assume two checkouts
share a database just because they're the same repo.

See `docs/AUTHENTIK-DEPLOYMENT.md` for an optional forward-auth (SSO) deployment pattern,
and `.env.example` for the full list of environment variables the app reads.
