# Authentik Forward-Auth Deployment

This runbook covers deploying internal-inventory-app behind Authentik's Caddy forward-auth proxy. Three components require manual coordination: Caddyfile updates, environment variables, and smoke-test verification.

## 1. Caddyfile Configuration

Update the Caddyfile on your Caddy host to add three headers to the `copy_headers` list. The block for `internal-inventory-app.example.invalid` must include `X-Authentik-Jwt`, `X-Authentik-Meta-Jwks`, and `X-Authentik-Email`.

### Current block (example):
```caddy
http://internal-inventory-app.example.invalid {
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
http://internal-inventory-app.example.invalid {
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

**Action**: Edit your Caddyfile, add the three headers to `copy_headers`, and reload Caddy.

```bash
caddy reload
```

## 2. Environment Variables

Set all three variables on the internal-inventory-app service. If any one is set, all three **must** be set or the app will fail at startup. If any are missing, startup will fail immediately with a clear error message (see Troubleshooting).

### Where to set them:
- **systemd unit environment**: `/etc/systemd/system/internal-inventory-app.service` (Environment= lines)
- **Or `.env` file**: If the app reads from a deployed `.env` file, add them there

### Required variables:

| Variable | Value | Example |
|----------|-------|---------|
| `AUTHENTIK_JWKS_URL` | Authentik proxy provider's JWKS endpoint | `https://auth.example.invalid/application/o/my-app-slug/jwks/` |
| `AUTHENTIK_ISSUER` | Issuer URL from proxy provider config | `https://auth.example.invalid/application/o/my-app-slug/` |
| `AUTHENTIK_AUDIENCE` | Audience from proxy provider config | `internal-inventory-app` (or as configured in Authentik) |

### How to obtain these values:

1. Open your Authentik admin panel
2. Navigate to **Applications > Providers**
3. Find or create a proxy provider for internal-inventory-app
4. View the provider's settings — the configuration page displays:
   - **JWKS URL**: Shown directly in the provider UI
   - **Issuer**: Construct from your Authentik base URL + `/application/o/{slug}/`
   - **Audience**: The slug or identifier you assigned to the proxy provider

### Example systemd configuration:

```ini
[Service]
...
Environment="AUTHENTIK_JWKS_URL=https://auth.example.invalid/application/o/internal-inventory-app/jwks/"
Environment="AUTHENTIK_ISSUER=https://auth.example.invalid/application/o/internal-inventory-app/"
Environment="AUTHENTIK_AUDIENCE=internal-inventory-app"
```

After updating, reload and restart the service:

```bash
systemctl daemon-reload
systemctl restart internal-inventory-app
```

## 3. Manual Smoke Test (AC1)

Verify the integration works end-to-end.

### Prerequisites:
- internal-inventory-app service is running and healthy
- Caddy is reloaded with the updated Caddyfile
- All three env vars are set and the app has restarted

### Test procedure:

1. **Open an incognito/private browser window** and navigate to `https://internal-inventory-app.example.invalid/`
2. **Caddy forwards you to Authentik** — you should see the Authentik login page
3. **Authenticate with your Authentik credentials** — log in successfully
4. **Caddy redirects you back** — you should be sent to internal-inventory-app
5. **Verify: The login form should NOT appear** — you should see the authenticated app dashboard, not a login screen

If you see the login form after successful Authentik authentication (step 5), the integration has failed silently — see **Troubleshooting** below.

## 4. Troubleshooting

### The login form still appears after Authentik authentication

**Root cause**: The app is not receiving the required headers from Caddy.

**Why it fails silently**: The app has a fallback mode. If JWT headers are **absent entirely**, it acts as if forward-auth is not deployed — the login form appears, and users can log in directly. This is intentional: the app can run standalone (no forward-auth) or behind forward-auth seamlessly.

**This is different from a JWT header being present but failing verification** (2026-08-01 fix — see section 5 below). If Caddy IS forwarding `X-Authentik-Jwt` but the app still shows the login form, check for `sso_error=verification_failed` in the URL first — that means the app actively rejected the credential (and logged why) rather than silently falling back.

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
   systemctl show internal-inventory-app | grep AUTHENTIK
   # Should show all three variables
   ```

4. **Check the app started successfully**:
   ```bash
   systemctl status internal-inventory-app
   journalctl -u internal-inventory-app -n 20
   ```
   If any AUTHENTIK env vars are missing, startup should fail with a clear error like: `Error: AUTHENTIK_JWKS_URL is required when AUTHENTIK_ISSUER is set`.

5. **Inspect headers in flight** (advanced): Use browser dev tools (Network tab) or curl with verbose output to verify Caddy is forwarding the headers:
   ```bash
   curl -v https://internal-inventory-app.example.invalid/ 2>&1 | grep -i x-authentik
   ```
   (This works after you've authenticated with Authentik in that session.)

### App fails to start with missing AUTHENTIK error

**Root cause**: One or more of the three env vars is unset.

**Fix**: All three must be set together. Verify all are present in your systemd unit or `.env` file, then restart:

```bash
systemctl restart internal-inventory-app
```

If startup still fails, check the journal:
```bash
journalctl -u internal-inventory-app -n 50
```

### Authentik login loops or does not redirect back

**Root cause**: Caddy or Authentik proxy provider misconfiguration (outside this doc's scope).

**Action**: Verify the Authentik proxy provider's callback/redirect URLs match `https://internal-inventory-app.example.invalid/` and check Authentik's logs. Consult Authentik documentation.

## 5. Fail-closed JWT verification failures (2026-08-01 security fix)

A fleet observability audit (2026-08-01) found that a JWT header that WAS present but failed verification (bad signature, expired, wrong issuer/audience, algorithm confusion, a key-rotation-window mismatch, or the JWKS endpoint itself being unreachable/timing out) used to be treated identically to no header at all — silently falling back to the app's own login form with zero log output. That meant an Authentik/JWKS outage could disable SSO for every user with nothing in the journal to show it. This is now fixed: **a presented-but-invalid JWT is actively rejected**, not silently passed through.

### What changed, operationally

- A request to a page route with a presented-but-invalid JWT now redirects to `/login?sso_error=verification_failed` (distinct from the pre-existing `sso_error=unmatched`, which means the credential verified fine but no local tenant matches it).
- A request to an `/api/*` route with a presented-but-invalid JWT now gets `401 {"error": "authentik_verification_failed"}` instead of falling through to whatever that route's own unauthenticated behavior is.
- **The specific failure reason is never shown to the browser** — the banner text and the JSON error are identical regardless of whether the token was expired, the issuer was wrong, or the JWKS endpoint was down. The reason is only in the server-side log line below.
- **This does NOT change behavior for a genuinely absent header** — local dev, Tailscale/LAN access, and a forgotten Caddyfile `copy_headers` change all still fall through exactly as before (section 4's "why it fails silently" still applies to that case, and only that case).

### How to diagnose a verification-failure spike

Every rejection now emits one structured JSON log line to the systemd journal:

```bash
journalctl -u internal-inventory-app -n 50 | grep forward_auth.verification_failed
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

`jwks_unreachable` and `key_not_found` logging at `error` level and appearing repeatedly is the signal that matters most operationally — it means the verifier's own dependency is broken, not that individual users have bad tokens.

### Metrics (not yet wired to Prometheus)

The app also maintains an in-process count of verification outcomes by reason, exportable as a node-exporter textfile-collector `.prom` file. **This is currently inert on the deployed instance** — it only writes a file when the `NODE_EXPORTER_TEXTFILE_DIR` env var is set, and that has not been added to the deployed systemd unit as part of this change (deploy is sequenced separately). To wire it up later, add to the unit:

```ini
Environment="NODE_EXPORTER_TEXTFILE_DIR=<docker-root>/observability/node-exporter-textfiles"
```

and add a Prometheus alert rule on `resale_inventory_forward_auth_outcomes_total{outcome=~"jwks_unreachable|key_not_found"}` sustaining above zero — that is a `internal-infra` repo change, not something in this repo.
