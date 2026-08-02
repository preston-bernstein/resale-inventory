# Authentik Forward-Auth Deployment

This runbook shows you how to put resale-inventory behind Authentik (an open-source sign-in and identity system), using forward-auth — a setup where Caddy (the reverse proxy that sits in front of the app) checks with Authentik before it lets a request through. Caddy passes along a JWT (JSON Web Token — a signed credential that proves who the user is) in a request header, and the app checks that JWT against Authentik's JWKS endpoint (JWKS = JSON Web Key Set, the public keys Authentik publishes so other services can verify its signed tokens).

You need to update three things by hand: the Caddyfile, three environment variables, and then run a manual smoke test to confirm it all works.

## 1. Caddyfile Configuration

Update the Caddyfile on your Caddy host to add three headers to the `copy_headers` list. The block for `resale-inventory.houseoflight.dev` must include `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, and `X-Authentik-Email`.

### Current block (example):
```caddy
http://resale-inventory.houseoflight.dev {
    forward_auth authentik-server:9000 {
        uri /outpost.goauthentik.io/auth/caddy
        copy_headers X-Authentik-Username X-Authentik-Groups
        trusted_proxies private_ranges
    }
    reverse_proxy host.docker.internal:3010 {
        header_up X-Forwarded-Proto https
        header_up Host {host}
    }
}
```

### Updated block (required):
```caddy
http://resale-inventory.houseoflight.dev {
    forward_auth authentik-server:9000 {
        uri /outpost.goauthentik.io/auth/caddy
        copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Jwt X-Authentik-Meta-Jwks X-Authentik-Email
        trusted_proxies private_ranges
    }
    reverse_proxy host.docker.internal:3010 {
        header_up X-Forwarded-Proto https
        header_up Host {host}
    }
}
```

**Action**: Edit your Caddyfile. Add the three headers to `copy_headers`. Reload Caddy.

```bash
caddy reload
```

## 2. Environment Variables

Set all three variables on the resale-inventory service. If you set one, you must set all three. If any are missing, the app fails to start right away, with a clear error message (see Troubleshooting).

### Where to set them:

Set them in one of two places:
- **systemd (Linux's service manager) unit environment**: `/etc/systemd/system/resale-inventory.service` (Environment= lines)
- **Or in a `.env` file**: if the app reads from a deployed `.env` file, add them there

### Required variables:

| Variable | Value | Example |
|----------|-------|---------|
| `AUTHENTIK_JWKS_URL` | Authentik proxy provider's JWKS endpoint | `https://auth.houseoflight.dev/application/o/my-app-slug/jwks/` |
| `AUTHENTIK_ISSUER` | Issuer URL from proxy provider config | `https://auth.houseoflight.dev/application/o/my-app-slug/` |
| `AUTHENTIK_AUDIENCE` | Audience from proxy provider config | `resale-inventory` (or as configured in Authentik) |

### How to obtain these values:

1. Open your Authentik admin panel
2. Navigate to **Applications > Providers**
3. Find or create a proxy provider (the Authentik object that connects an app to forward-auth) for resale-inventory
4. View the provider's settings. The configuration page displays:
   - **JWKS URL**: Shown directly in the provider UI
   - **Issuer**: Construct from your Authentik base URL + `/application/o/{slug}/`
   - **Audience**: The slug or identifier you assigned to the proxy provider

### Example systemd configuration:

```ini
[Service]
...
Environment="AUTHENTIK_JWKS_URL=https://auth.houseoflight.dev/application/o/resale-inventory/jwks/"
Environment="AUTHENTIK_ISSUER=https://auth.houseoflight.dev/application/o/resale-inventory/"
Environment="AUTHENTIK_AUDIENCE=resale-inventory"
```

After updating, reload and restart the service:

```bash
systemctl daemon-reload
systemctl restart resale-inventory
```

## 3. Manual Smoke Test (AC1 — acceptance criterion 1 in the feature spec)

This test checks that the whole integration works, end to end.

### Prerequisites:
- resale-inventory service is running and healthy
- Caddy is reloaded with the updated Caddyfile
- All three env vars are set and the app has restarted

### Test procedure:

1. **Open an incognito/private browser window** and navigate to `https://resale-inventory.houseoflight.dev/`
2. **Caddy forwards you to Authentik** — you'll see the Authentik login page
3. **Authenticate with your Authentik credentials** — log in
4. **Caddy redirects you back** — you land on resale-inventory
5. **Check the result** — you should see the authenticated app dashboard. The login form should not appear.

If the login form appears after you've authenticated with Authentik (step 5), the integration has failed silently. See **Troubleshooting** below.

## 4. Troubleshooting

### The login form still appears after Authentik authentication

**Root cause**: The app is not receiving the required headers from Caddy.

**Why it fails silently**: The app has a fallback mode. If the JWT header is missing entirely, the app assumes forward-auth isn't set up. It shows the login form, and users can log in directly. This is intentional — the app works standalone, without forward-auth, or behind it.

**This is different from a JWT header that's present but fails verification** (2026-08-01 fix — see section 5 below). If Caddy is forwarding `X-Authentik-Jwt` but the app still shows the login form, check the URL for `sso_error=verification_failed` first. That means the app rejected the credential on purpose, and logged why, instead of silently falling back.

**How to debug**:

1. **Check Caddyfile was reloaded**: Verify all five headers are in `copy_headers`:
   ```bash
   grep -A5 "forward_auth" /path/to/Caddyfile
   ```
   Should show: `copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Jwt X-Authentik-Meta-Jwks X-Authentik-Email`

2. **Check Caddy reloaded successfully**:
   ```bash
   caddy reload
   # Watch systemd journal or logs for success
   systemctl status caddy
   ```

3. **Check env vars are set**:
   ```bash
   systemctl show resale-inventory | grep AUTHENTIK
   # Should show all three variables
   ```

4. **Check the app started successfully**:
   ```bash
   systemctl status resale-inventory
   journalctl -u resale-inventory -n 20
   ```
   If any AUTHENTIK env vars are missing, startup should fail with a clear error like: `Error: AUTHENTIK_JWKS_URL is required when AUTHENTIK_ISSUER is set`.

5. **Inspect headers in flight** (advanced): Use browser dev tools (Network tab) or curl with verbose output to verify Caddy is forwarding the headers:
   ```bash
   curl -v https://resale-inventory.houseoflight.dev/ 2>&1 | grep -i x-authentik
   ```
   (This works after you've authenticated with Authentik in that session.)

### App fails to start with missing AUTHENTIK error

**Root cause**: One or more of the three env vars is unset.

**Fix**: All three must be set together. Verify all are present in your systemd unit or `.env` file, then restart:

```bash
systemctl restart resale-inventory
```

If startup still fails, check the journal:
```bash
journalctl -u resale-inventory -n 50
```

### Authentik login loops or does not redirect back

**Root cause**: Caddy or Authentik proxy provider misconfiguration (outside this doc's scope).

**Action**: Verify the Authentik proxy provider's callback/redirect URLs match `https://resale-inventory.houseoflight.dev/` and check Authentik's logs. Consult Authentik documentation.

## 5. Fail-closed JWT verification failures (2026-08-01 security fix)

On 2026-08-01, a fleet observability audit found a bug. A JWT header that was present but failed verification — for reasons like a bad signature, an expired token, the wrong issuer or audience, algorithm confusion, a key-rotation-window mismatch, or the JWKS endpoint itself being unreachable or timing out — used to be treated exactly like no header at all. The app fell back silently to its own login form, with zero log output. That meant an Authentik or JWKS outage could disable SSO (single sign-on — logging in once to reach multiple apps) for every user, with nothing in the journal to show why.

This is now fixed: a JWT that's present but invalid gets **actively rejected**, instead of silently passed through.

### What changed, operationally

- A request to a page route with a presented-but-invalid JWT now redirects to `/login?sso_error=verification_failed` (distinct from the pre-existing `sso_error=unmatched`, which means the credential verified fine but no local tenant matches it).
- A request to an `/api/*` route with a presented-but-invalid JWT now gets `401 {"error": "authentik_verification_failed"}` instead of falling through to whatever that route's own unauthenticated behavior is.
- **The specific failure reason is never shown to the browser** — the banner text and the JSON error are identical regardless of whether the token was expired, the issuer was wrong, or the JWKS endpoint was down. The reason is only in the server-side log line below.
- **This does not change behavior for a genuinely absent header.** Local dev, Tailscale (a private VPN network) or LAN access, and a forgotten Caddyfile `copy_headers` change all still fall through exactly as before. Section 4's "why it fails silently" still applies to that case, and only that case.

### How to diagnose a verification-failure spike

Every rejection now emits one structured JSON log line to the systemd journal:

```bash
journalctl -u resale-inventory -n 50 | grep forward_auth.verification_failed
```

Look at the `reason` field:

| `reason` | Likely cause | Log level |
|---|---|---|
| `jwks_unreachable` | Authentik's JWKS endpoint is down, slow (>5s), or returning a malformed response — **an infra problem on the JWKS/Authentik side**, not a bad token | `error` |
| `key_not_found` | Authentik just rotated its signing key and this app's cached JWKS hasn't caught up yet — usually transient, should self-resolve within the JWKS cache's cooldown window | `error` |
| `token_expired` | A stale/replayed token, or client clock skew — usually benign, one-off | `warn` |
| `invalid_issuer` / `invalid_audience` | `AUTHENTIK_ISSUER`/`AUTHENTIK_AUDIENCE` env vars don't match the actual Authentik proxy provider config — check for a recent provider reconfiguration | `warn` |
| `invalid_signature` / `invalid_algorithm` | A malformed or forged token — worth a closer look if these appear in volume | `warn` |
| `malformed_token` / `missing_email_claim` | Proxy-provider misconfiguration (Authentik not including an `email` claim) or a non-JWT value in the header | `warn` |
| `unknown` | An unclassified failure — should be rare; worth investigating regardless of volume | `error` |

Watch for `jwks_unreachable` and `key_not_found` logging at `error` level and appearing repeatedly. That's the signal that matters most — it means the verifier's own dependency is broken, not that individual users have bad tokens.

### Metrics (wired to Prometheus, 2026-08-02)

The app counts verification outcomes by reason, in memory, and exports that count as a node-exporter textfile-collector `.prom` file — a plain-text file that Prometheus (the monitoring system used elsewhere in this stack) reads to pick up custom metrics. **This export is active on the deployed instance.** The deployed systemd unit (`/etc/systemd/system/resale-inventory.service` on the desktop) sets:

```ini
Environment="NODE_EXPORTER_TEXTFILE_DIR=/opt/docker/observability/node-exporter-textfiles"
```

The `resale-inventory` service user is a member of the `node-exporter-textfile` group (`usermod -aG node-exporter-textfile resale-inventory`), which the target directory's ACL requires for traversal/write. `lib/metrics.ts` writes two metrics — `resale_inventory_forward_auth_outcomes_total{outcome="..."}` (counter) and `resale_inventory_forward_auth_last_write_timestamp_seconds` (gauge) — each with its own `# HELP`/`# TYPE` pair, validated against `promtool check metrics` in `tests/metrics.test.ts`.

The corresponding Prometheus alert rule (`resale-inventory forward-auth config failure` and a companion `absent()` scrape-coverage rule) lives in the `home-infra` repo's `compose/desktop/observability/prometheus/alert-rules.yml` — it fires on sustained `jwks_unreachable`/`key_not_found`/`invalid_algorithm` (configuration failures) but deliberately NOT on `token_expired`/`malformed_token` alone (normal per-request noise).
