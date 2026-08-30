# Authentik Forward-Auth Deployment

This runbook covers deploying internal-inventory-app behind Authentik's Caddy forward-auth proxy. Three components require manual coordination: Caddyfile updates, environment variables, and smoke-test verification.

## 0. Why this is HS256/client_secret, not RS256/JWKS

This app was originally built (2026-07-18, see `docs/authentik-forward-auth-sso/`) against RS256 with a JWKS endpoint — the usual OIDC pattern, and the pattern Authentik's own docs and admin UI both suggest. **That design cannot work for this deployment.** Authentik's Proxy Provider (the "Forward auth (single application)" mode this app uses) hardcodes `signing_key = None` on every provider, every time `authentik-server`/`authentik-worker` boots — see `ProxyProvider.set_oauth_defaults()` in Authentik's own `authentik/providers/proxy/models.py`, called unconditionally for every `ProxyProvider` row by `authentik/providers/proxy/apps.py`'s `proxy_set_defaults()`. There is no admin-UI setting, database edit, or provider reconfiguration that survives a restart and changes this — it resets every time, by design, for this provider type. Authentik's own embedded outpost knows this: `src/outpost/proxy/auth.rs`'s `verify_token()` checks the OIDC discovery document for `HS256` in `id_token_signing_alg_values_supported` and, when present (which it always is for a Proxy Provider), verifies with the provider's `client_secret` as the HMAC key instead (`src/outpost/proxy/token.rs`'s `verify_hs256()`) — never RS256/JWKS.

**Do not "fix" this back to RS256/JWKS.** This app's `lib/forwardAuth.ts` verifies the same way Authentik's own outpost does: HS256, keyed by the provider's `client_secret`. If a future person finds this surprising, it's because the discovery-document/JWKS pattern is what every other OIDC client does — Proxy Provider mode is the exception, not this app.

## 1. Caddyfile Configuration

Update the Caddyfile on your Caddy host to add two headers to the `copy_headers` list. The block for `your-app.example.com` must include `X-Authentik-Jwt` and `X-Authentik-Email`.

`X-Authentik-Meta-Jwks` is **not** needed and should not be forwarded: HS256 verification needs no JWKS document at all, so there is nothing on this app's side that would ever read that header.

### Current block (example):
```caddy
http://your-app.example.com {
    forward_auth authentik-server:9000 {
        uri /outpost.goauthentik.io/auth/caddy
        copy_headers X-Authentik-Username X-Authentik-Groups
        trusted_proxies private_ranges
    }
    reverse_proxy host.docker.internal:3000 {
        header_up X-Forwarded-Proto https
        header_up Host {host}
    }
}
```

### Updated block (required):
```caddy
http://your-app.example.com {
    forward_auth authentik-server:9000 {
        uri /outpost.goauthentik.io/auth/caddy
        copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Jwt X-Authentik-Email
        trusted_proxies private_ranges
    }
    reverse_proxy host.docker.internal:3000 {
        header_up X-Forwarded-Proto https
        header_up Host {host}
    }
}
```

**Action**: Edit your Caddyfile. Add the two headers to `copy_headers`. Reload Caddy.

```bash
caddy reload
```

## 2. Environment Variables

Set all three variables on your app's service. If you set one, you must set all three. If any are missing, the app fails to start right away, with a clear error message (see Troubleshooting).

### Where to set them:

Set them in one of two places:
- **systemd unit environment**: `/etc/systemd/system/your-app.service` (Environment= lines)
- **Or in a `.env` file**: if the app reads from a deployed `.env` file, add them there

### Required variables:

| Variable | Value | Example |
|----------|-------|---------|
| `AUTHENTIK_CLIENT_SECRET` | Authentik proxy provider's OAuth2 client secret | a long random string from the provider's OAuth2Provider record (see below) — treat as a secret, same handling as a password; never commit the real value anywhere |
| `AUTHENTIK_ISSUER` | Issuer URL from proxy provider config | `https://auth.example.com/application/o/my-app-slug/` |
| `AUTHENTIK_AUDIENCE` | The provider's OAuth2 client ID | `example-client-id-0123456789abcdef` |

### How to obtain these values:

1. Open your Authentik admin panel
2. Navigate to **Applications > Providers**
3. Find the proxy provider for your app

**Gotcha**: the Proxy Provider's own edit page has no field for `client_id`/`client_secret` at all — that field genuinely does not exist on that form. The same underlying provider row is also reachable as an OAuth2/OpenID Provider (Authentik models Proxy Provider as an `OAuth2Provider` subclass under the hood): go to **Applications > Providers**, open the provider, and use the API browser or `/api/v3/providers/oauth2/{pk}/` directly (not `/api/v3/providers/proxy/{pk}/`, which omits the field) — or use Authentik's management shell (`ak shell`) if you have container access:

```python
from authentik.providers.oauth2.models import OAuth2Provider
p = OAuth2Provider.objects.get(name="your-app")
print(p.client_id, p.client_secret)
```

- **Issuer**: your Authentik base URL + `/application/o/{slug}/`
- **Audience**: the `client_id` printed above (not the provider's name or slug)

### Example systemd configuration:

```ini
[Service]
...
Environment="AUTHENTIK_CLIENT_SECRET=<the provider's client_secret>"
Environment="AUTHENTIK_ISSUER=https://auth.example.com/application/o/internal-inventory-app/"
Environment="AUTHENTIK_AUDIENCE=<the provider's client_id>"
```

After updating, reload and restart the service:

```bash
systemctl daemon-reload
systemctl restart your-app
```

## 3. Manual Smoke Test (AC1)

This test checks that the whole integration works, end to end.

### Prerequisites:
- internal-inventory-app service is running and healthy
- Caddy is reloaded with the updated Caddyfile
- All three env vars are set and the app has restarted

### Test procedure:

1. **Open an incognito/private browser window** and navigate to `https://your-app.example.com/`
2. **Caddy forwards you to Authentik** — you'll see the Authentik login page
3. **Authenticate with your Authentik credentials** — log in
4. **Caddy redirects you back** — you land on internal-inventory-app
5. **Check the result** — you should see the authenticated app dashboard. The login form should not appear.

If the login form appears after you've authenticated with Authentik (step 5), the integration has failed silently. See **Troubleshooting** below.

## 4. Troubleshooting

### The login form still appears after Authentik authentication

**Root cause**: The app is not receiving the required headers from Caddy.

**Why it fails silently**: The app has a fallback mode. If the JWT header is missing entirely, the app assumes forward-auth isn't set up. It shows the login form, and users can log in directly. This is intentional — the app works standalone, without forward-auth, or behind it.

**This is different from a JWT header that's present but fails verification** (2026-08-01 fix — see section 5 below). If Caddy is forwarding `X-Authentik-Jwt` but the app still shows the login form, check the URL for `sso_error=verification_failed` first. That means the app rejected the credential on purpose, and logged why, instead of silently falling back.

**How to debug**:

1. **Check Caddyfile was reloaded**: Verify all four headers are in `copy_headers`:
   ```bash
   grep -A5 "forward_auth" /path/to/Caddyfile
   ```
   Should show: `copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Jwt X-Authentik-Email`

2. **Check Caddy reloaded successfully**:
   ```bash
   caddy reload
   # Watch systemd journal or logs for success
   systemctl status caddy
   ```

3. **Check env vars are set**:
   ```bash
   systemctl show your-app | grep AUTHENTIK
   # Should show all three variables
   ```

4. **Check the app started successfully**:
   ```bash
   systemctl status your-app
   journalctl -u your-app -n 20
   ```
   If any AUTHENTIK env vars are missing or only partially set, startup should fail with a clear error like: `Forward-auth env misconfigured: AUTHENTIK_CLIENT_SECRET, AUTHENTIK_ISSUER, and AUTHENTIK_AUDIENCE must be either all set or all unset`.

5. **Inspect headers in flight** (advanced): Use browser dev tools (Network tab) or curl with verbose output to verify Caddy is forwarding the headers:
   ```bash
   curl -v https://your-app.example.com/ 2>&1 | grep -i x-authentik
   ```
   (This works after you've authenticated with Authentik in that session.)

### App fails to start with missing AUTHENTIK error

**Root cause**: One or more of the three env vars is unset.

**Fix**: All three must be set together. Verify all are present in your systemd unit or `.env` file, then restart:

```bash
systemctl restart your-app
```

If startup still fails, check the journal:
```bash
journalctl -u your-app -n 50
```

### Authentik login loops or does not redirect back

**Root cause**: Caddy or Authentik proxy provider misconfiguration (outside this doc's scope).

**Action**: Verify the Authentik proxy provider's callback/redirect URLs match `https://your-app.example.com/` and check Authentik's logs. Consult Authentik documentation.

## 5. Fail-closed JWT verification failures (2026-08-01 security fix)

On 2026-08-01, a fleet observability audit found a bug. A JWT header that was present but failed verification — for reasons like a bad signature, an expired token, the wrong issuer or audience, or algorithm confusion — used to be treated exactly like no header at all. The app fell back silently to its own login form, with zero log output. That meant a misconfiguration could disable SSO for every user, with nothing in the journal to show why.

This is now fixed: a JWT that's present but invalid gets **actively rejected**, instead of silently passed through.

### What changed, operationally

- A request to a page route with a presented-but-invalid JWT now redirects to `/login?sso_error=verification_failed` (distinct from the pre-existing `sso_error=unmatched`, which means the credential verified fine but no local tenant matches it).
- A request to an `/api/*` route with a presented-but-invalid JWT now gets `401 {"error": "authentik_verification_failed"}` instead of falling through to whatever that route's own unauthenticated behavior is.
- **The specific failure reason is never shown to the browser** — the banner text and the JSON error are identical regardless of whether the token was expired, the issuer was wrong, or the JWKS endpoint was down. The reason is only in the server-side log line below.
- **This does not change behavior for a genuinely absent header.** Local dev, Tailscale or LAN access, and a forgotten Caddyfile `copy_headers` change all still fall through exactly as before. Section 4's "why it fails silently" still applies to that case, and only that case.

### How to diagnose a verification-failure spike

Every rejection now emits one structured JSON log line to the systemd journal:

```bash
journalctl -u your-app -n 50 | grep forward_auth.verification_failed
```

Look at the `reason` field:

| `reason` | Likely cause | Log level |
|---|---|---|
| `token_expired` | A stale/replayed token, or client clock skew — usually benign, one-off | `warn` |
| `invalid_issuer` / `invalid_audience` | `AUTHENTIK_ISSUER`/`AUTHENTIK_AUDIENCE` env vars don't match the actual Authentik proxy provider config — check for a recent provider reconfiguration | `warn` |
| `invalid_signature` | Either a forged token, or `AUTHENTIK_CLIENT_SECRET` doesn't match the provider's actual `client_secret` (e.g. after a secret rotation) | `warn` |
| `invalid_algorithm` | A malformed or forged token whose header claims an algorithm other than HS256 — worth a closer look if these appear in volume | `warn` |
| `malformed_token` / `missing_email_claim` | Proxy-provider misconfiguration (Authentik not including an `email` claim) or a non-JWT value in the header | `warn` |
| `unknown` | An unclassified failure — should be rare; worth investigating regardless of volume | `error` |

Unlike an RS256/JWKS design, HS256 verification makes no network call at all — the provider's `client_secret` is a static, pinned env var, not something fetched at request time. There is no `jwks_unreachable`/`key_not_found` failure class here: a sustained run of `invalid_signature` most likely means `AUTHENTIK_CLIENT_SECRET` is stale (check whether the provider's secret was rotated in Authentik), not an infra outage.

### Metrics (optional, textfile-collector based)

The app counts verification outcomes by reason, in memory, and can export that count as a
node-exporter textfile-collector `.prom` file — a plain-text file a locally-running
node-exporter reads to pick up custom metrics, if you run one. Point it at your
collector's watched directory:

```ini
Environment="NODE_EXPORTER_TEXTFILE_DIR=/path/to/your/node-exporter/textfile-collector-dir"
```

Whichever OS user runs the app needs write access to that directory (however your
node-exporter setup grants that — a shared group is the common pattern). `lib/metrics.ts`
writes two metrics — `resale_inventory_forward_auth_outcomes_total{outcome="..."}`
(counter) and `resale_inventory_forward_auth_last_write_timestamp_seconds` (gauge) — each
with its own `# HELP`/`# TYPE` pair, validated against `promtool check metrics` in
`tests/metrics.test.ts`.

If you alert on this in Prometheus, a sustained run of `invalid_algorithm` is the signal
worth paging on (a real configuration failure); `token_expired`/`malformed_token` alone are
normal per-request noise and shouldn't page.
