import { NextRequest, NextResponse } from 'next/server';
import { verifyPassword, createSession, setSessionCookie } from '@/lib/tenantAuth';
import { checkRateLimit, getClientIp, tooManyRequestsBody } from '@/lib/rateLimit';
import { parseJsonBody } from '@/lib/apiRequest';

// ---------------------------------------------------------------------------
// POST /api/auth/login — verify credentials, issue a session, set the cookie.
//
// Per docs/reseller-multi-tenant-foundation/plan.md's Auth section: a
// nonexistent email and a wrong password for a real email are
// indistinguishable to the caller — both collapse to the same generic 401,
// so this endpoint can't be used to enumerate registered emails.
//
// Rate limiting (requirements.md NFR): two layers, both checked BEFORE
// verifyPassword() pays scrypt's cost --
//   1. per (ip, email) -- caps brute-forcing one specific account's password.
//   2. per ip alone, looser -- caps spraying many different emails from one
//      source, and is the actual CPU-exhaustion backstop (an attacker who
//      varies the email defeats layer 1 alone).
// ---------------------------------------------------------------------------

const PER_ACCOUNT_LIMIT = 10;
const PER_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 30;
const PER_IP_WINDOW_MS = 15 * 60 * 1000;

function invalidCredentials(): NextResponse {
  return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJsonBody(request);
  if ('error' in parsed) return parsed.error;
  const { body } = parsed;

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // Missing/malformed fields fold into the same generic 401 as a wrong
  // password rather than a distinct 4xx — no signal that would help an
  // attacker distinguish "no such field" from "wrong credentials".
  if (!email || !password) {
    return invalidCredentials();
  }

  const ip = getClientIp(request);
  const ipOk = checkRateLimit(`login:ip:${ip}`, PER_IP_LIMIT, PER_IP_WINDOW_MS);
  const accountOk = checkRateLimit(
    `login:acct:${ip}:${email.toLowerCase()}`,
    PER_ACCOUNT_LIMIT,
    PER_ACCOUNT_WINDOW_MS,
  );
  if (!ipOk || !accountOk) {
    return NextResponse.json(tooManyRequestsBody(), { status: 429 });
  }

  const tenantId = verifyPassword(email, password);
  if (!tenantId) {
    return invalidCredentials();
  }

  const { token, expiresAt } = createSession(tenantId);
  const response = NextResponse.json({ tenant_id: tenantId }, { status: 200 });
  setSessionCookie(response, token, expiresAt);
  return response;
}
