# internal-inventory-app — execution routing

> **Cross-cutting home-lab conventions** (service users, Mac-vs-desktop execution, ollama
> broker, secrets, commit attribution, scraping/egress, shared-service-vs-library) live in
> `internal-infra/CONVENTIONS.md`. This file holds only what's internal-inventory-app-specific.

**Deploy target is the desktop, not this Mac checkout.** Real inventory data and the running
app live there as the `internal-inventory-app` service user:

```bash
ssh desktop.example.internal
sudo -u internal-inventory-app <command>
```

- **Deployed/running copy**: `/home/internal-inventory-app/internal-inventory-app`, served by
  `internal-inventory-app.service` (`npx next start -p 3010`, loopback+docker-only via
  `internal-inventory-app-firewall.service`).
- **Canonical live data**: `data/inventory.db` on the desktop checkout — never the Mac
  clone's `data/inventory.db`, which is a separate, disposable file (see
  `internal-inventory-app-architecture-contract` skill, safety fact 1: any `next build`/`dev`/
  `start` on this Mac clone would migrate and write to *this* clone's own DB, not the real
  one — they are never the same file).
- example.invalid public subdomain (Authentik + Cloudflare) is in progress on the desktop
  side; nothing about that lives in this Mac checkout.

If a task involves checking real inventory, running the app against live data, or verifying
a deploy, route it to the desktop via `ssh desktop.example.internal` — do not run it against this Mac
clone even if it appears to work (it has its own throwaway DB).

See also: `internal-monitor-app-internal-inventory-app-merge.md` (vault, `Development/Research/`) —
this repo stays a separate codebase from `internal-monitor-app`; the two are bridged by a manual
CSV export/import, not a shared service or merged app.
