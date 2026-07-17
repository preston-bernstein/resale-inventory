import { test as setup, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { DEPLOYED_STORAGE_STATE_PATH } from './deployedStorageStatePath';

// ---------------------------------------------------------------------------
// Deployed-instance auth bootstrap. Unlike the local suite's auth.setup.ts,
// the deployed app sits behind TWO auth layers:
//   1. Authentik forward-auth (Caddy -> authentik-server, "forward_single"
//      proxy provider) — gates the whole resale-inventory.houseoflight.dev
//      host. Driven here via Authentik's flow-executor JSON API (the same
//      API its own login SPA calls), not by scripting the login page's DOM
//      — no CSS selectors to keep in sync with Authentik's UI. This is the
//      exact mechanism proven manually against this account (Authentik user
//      pk=8, username qa-harness-resale-inventory, path=service-accounts)
//      via curl before this file was written.
//   2. The app's own tenant auth (multi-tenant foundation) — same
//      /api/auth/signup dance as tests/e2e/auth.setup.ts, run AFTER step 1
//      so the request actually passes the Authentik gate.
//
// Both cookie jars land in the same Playwright request context, so one
// storageState covers the whole chain for every downstream spec.
// ---------------------------------------------------------------------------

const AUTHENTIK_BASE_URL = process.env.QA_AUTHENTIK_BASE_URL;
const FLOW_SLUG = process.env.QA_AUTHENTIK_FLOW_SLUG ?? 'default-authentication-flow';
const USERNAME = process.env.QA_AUTHENTIK_USERNAME;
const PASSWORD = process.env.QA_AUTHENTIK_PASSWORD;

setup('authenticate through Authentik, then as a throwaway app tenant', async ({ request, baseURL }) => {
  if (!AUTHENTIK_BASE_URL || !USERNAME || !PASSWORD || !baseURL) {
    throw new Error(
      'QA_AUTHENTIK_BASE_URL / QA_AUTHENTIK_USERNAME / QA_AUTHENTIK_PASSWORD / baseURL not set — see .env.deployed',
    );
  }

  // Step 1: hit the app unauthenticated. Caddy's forward_auth redirects
  // through Authentik's OAuth2 authorize endpoint to the login flow's SPA
  // shell — the request context follows every redirect in that chain and
  // lands on the final HTML page. Its URL carries two distinct tokens, easy
  // to conflate: `query` binds the flow-executor API calls below to this
  // specific authorize attempt, while `next` is the actual OAuth2 authorize
  // URL to continue to once the flow reports done — the SPA's own JS reads
  // `next` from the page URL for that hop, it is NOT returned by the
  // executor's own `xak-flow-redirect` challenge (that challenge's `to` is
  // just "/", an artifact of driving the flow outside a real browser).
  const landing = await request.get(baseURL);
  const landingUrl = new URL(landing.url());
  expect(landingUrl.pathname, `expected to land on the Authentik flow SPA, got ${landing.url()}`).toContain(
    `/if/flow/${FLOW_SLUG}/`,
  );
  const query = landingUrl.searchParams.get('query') ?? '';
  const next = landingUrl.searchParams.get('next');
  if (!next) {
    throw new Error(`expected a \`next\` param on the flow SPA URL, got ${landing.url()}`);
  }

  const executorUrl = `${AUTHENTIK_BASE_URL}/api/v3/flows/executor/${FLOW_SLUG}/?query=${encodeURIComponent(query)}`;

  // Step 2: identification stage.
  const identify = await request.post(executorUrl, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    data: { uid_field: USERNAME },
  });
  const identifyBody = await identify.json();
  expect(identifyBody.component, JSON.stringify(identifyBody)).toBe('ak-stage-password');

  // Step 3: password stage. On success this returns an `xak-flow-redirect`
  // challenge (`to: "/"` — just an internal flow-done marker, not useful
  // here; the real continuation is the `next` param captured in step 1).
  const passwordStage = await request.post(executorUrl, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    data: { password: PASSWORD },
  });
  const passwordBody = await passwordStage.json();
  expect(passwordBody.component, JSON.stringify(passwordBody)).toBe('xak-flow-redirect');

  // Step 4: follow `next` — the OAuth2 authorize URL — back through the
  // outpost callback into the app. This is the request that sets the
  // app-domain `authentik_proxy_<hash>` cookie forward_auth checks on every
  // subsequent request.
  const redirectTarget = new URL(next, AUTHENTIK_BASE_URL).toString();
  const final = await request.get(redirectTarget);
  expect(final.ok(), `Authentik login did not land on the app: ${final.status()} ${final.url()}`).toBe(true);
  expect(new URL(final.url()).host).toBe(new URL(baseURL).host);

  // Step 5: the app's own tenant auth, same throwaway-tenant pattern as
  // tests/e2e/auth.setup.ts's local suite — isolated per run, tagged
  // `e2e-deployed-` so it's identifiable (and safely prunable) among real
  // production tenant rows.
  const email = `e2e-deployed-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.invalid`;
  const password = 'e2e-deployed-suite-test-password';
  const signup = await request.post('/api/auth/signup', { data: { email, password } });
  expect(signup.ok(), `tenant signup failed: ${signup.status()} ${await signup.text()}`).toBe(true);

  fs.mkdirSync(path.dirname(DEPLOYED_STORAGE_STATE_PATH), { recursive: true });
  await request.storageState({ path: DEPLOYED_STORAGE_STATE_PATH });
});
