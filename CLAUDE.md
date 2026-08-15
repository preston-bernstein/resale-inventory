# resale-inventory — execution routing

> **Cross-cutting home-lab conventions** (service users, Mac-vs-desktop execution, ollama
> broker, secrets, commit attribution, scraping/egress, shared-service-vs-library) live in
> `home-infra/CONVENTIONS.md`. This file holds only what's resale-inventory-specific.

**Deploy target is the desktop, not this Mac checkout.** Real inventory data and the running
app live there as the `resale-inventory` service user:

```bash
ssh desktop-agent
sudo -u resale-inventory <command>
```

- **Deployed/running copy**: `/home/resale-inventory/resale-inventory`, served by
  `resale-inventory.service` (`npx next start -p 3010`, loopback+docker-only via
  `resale-inventory-firewall.service`).
- **Canonical live data**: `data/inventory.db` on the desktop checkout — never the Mac
  clone's `data/inventory.db`, which is a separate, disposable file (see
  `resale-inventory-architecture-contract` skill, safety fact 1: any `next build`/`dev`/
  `start` on this Mac clone would migrate and write to *this* clone's own DB, not the real
  one — they are never the same file).
- houseoflight.dev public subdomain (Authentik + Cloudflare) is in progress on the desktop
  side; nothing about that lives in this Mac checkout.

If a task involves checking real inventory, running the app against live data, or verifying
a deploy, route it to the desktop via `ssh desktop-agent` — do not run it against this Mac
clone even if it appears to work (it has its own throwaway DB).

See also: `fashion-monitor-resale-inventory-merge.md` (vault, `Development/Research/`) —
this repo stays a separate codebase from `fashion-monitor`; the two are bridged by a manual
CSV export/import, not a shared service or merged app.
