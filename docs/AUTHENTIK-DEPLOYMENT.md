# Authentik Forward-Auth Deployment

This runbook covers deploying resale-inventory behind Authentik's Caddy forward-auth proxy. Three components require manual coordination: Caddyfile updates, environment variables, and smoke-test verification.

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

**Action**: Edit your Caddyfile, add the three headers to `copy_headers`, and reload Caddy.

```bash
caddy reload
```

## 2. Environment Variables

Set all three variables on the resale-inventory service. If any one is set, all three **must** be set or the app will fail at startup. If any are missing, startup will fail immediately with a clear error message (see Troubleshooting).

### Where to set them:
- **systemd unit environment**: `/etc/systemd/system/resale-inventory.service` (Environment= lines)
- **Or `.env` file**: If the app reads from a deployed `.env` file, add them there

### Required variables:

| Variable | Value | Example |
|----------|-------|---------|
| `AUTHENTIK_JWKS_URL` | Authentik proxy provider's JWKS endpoint | `https://auth.houseoflight.dev/application/o/my-app-slug/jwks/` |
| `AUTHENTIK_ISSUER` | Issuer URL from proxy provider config | `https://auth.houseoflight.dev/application/o/my-app-slug/` |
| `AUTHENTIK_AUDIENCE` | Audience from proxy provider config | `resale-inventory` (or as configured in Authentik) |

### How to obtain these values:

1. Open your Authentik admin panel
2. Navigate to **Applications > Providers**
3. Find or create a proxy provider for resale-inventory
4. View the provider's settings — the configuration page displays:
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

## 3. Manual Smoke Test (AC1)

Verify the integration works end-to-end.

### Prerequisites:
- resale-inventory service is running and healthy
- Caddy is reloaded with the updated Caddyfile
- All three env vars are set and the app has restarted

### Test procedure:

1. **Open an incognito/private browser window** and navigate to `https://resale-inventory.houseoflight.dev/`
2. **Caddy forwards you to Authentik** — you should see the Authentik login page
3. **Authenticate with your Authentik credentials** — log in successfully
4. **Caddy redirects you back** — you should be sent to resale-inventory
5. **Verify: The login form should NOT appear** — you should see the authenticated app dashboard, not a login screen

If you see the login form after successful Authentik authentication (step 5), the integration has failed silently — see **Troubleshooting** below.

## 4. Troubleshooting

### The login form still appears after Authentik authentication

**Root cause**: The app is not receiving the required headers from Caddy.

**Why it fails silently**: The app has a fallback mode. If JWT headers are absent, it acts as if forward-auth is not deployed — the login form appears, and users can log in directly. This is intentional: the app can run standalone (no forward-auth) or behind forward-auth seamlessly.

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
