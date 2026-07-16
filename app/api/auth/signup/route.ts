import { NextRequest, NextResponse } from 'next/server';
import {
  createTenant,
  createSession,
  setSessionCookie,
  DuplicateEmailError,
  WeakPasswordError,
} from '@/lib/tenantAuth';
import { checkRateLimit, getClientIp, tooManyRequestsBody } from '@/lib/rateLimit';

// ---------------------------------------------------------------------------
// POST /api/auth/signup — create a tenant, issue a session, set the cookie.
//
// See docs/reseller-multi-tenant-foundation/plan.md's "API / interface
// contract" Auth section for the exact contract this implements.
//
// Rate limiting (requirements.md NFR): keyed per IP only, not per email --
// unlike login, every signup attempt targets a distinct (as-yet-unclaimed)
// email by definition, so email-keying would never actually throttle
// anything. This is purely the CPU-exhaustion backstop: createTenant() pays
// scrypt's cost on every call, success or failure, checked before that cost
// is paid.
// ---------------------------------------------------------------------------

const PER_IP_LIMIT = 20;
const PER_IP_WINDOW_MS = 10 * 60 * 1000;

/** Parse the JSON request body. Mirrors app/api/items/route.ts's pattern. */
async function parseRequestBody(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { error: NextResponse }> {
  try {
    const body = await request.json();
    return { body };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) };
  }
}

/** Build the standard 422 validation-failed response, or null if nothing invalid. */
function invalidFieldsResponse(invalidFields: string[]): NextResponse | null {
  if (invalidFields.length === 0) return null;
  return NextResponse.json({ error: 'Validation failed.', fields: invalidFields }, { status: 422 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseRequestBody(request);
  if ('error' in parsed) return parsed.error;
  const { body } = parsed;

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const invalidFields: string[] = [];
  if (!email) invalidFields.push('email');
  if (!password) invalidFields.push('password');
  const invalid = invalidFieldsResponse(invalidFields);
  if (invalid) return invalid;

  const ip = getClientIp(request);
  if (!checkRateLimit(`signup:ip:${ip}`, PER_IP_LIMIT, PER_IP_WINDOW_MS)) {
    return NextResponse.json(tooManyRequestsBody(), { status: 429 });
  }

  let tenantId: string;
  try {
    ({ tenantId } = createTenant(email, password));
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      return NextResponse.json({ error: 'Email already registered.' }, { status: 409 });
    }
    if (err instanceof WeakPasswordError) {
      // Same validation-failed shape as any other field-level 422, per
      // app/api/items/route.ts's invalidFieldsResponse convention.
      return NextResponse.json(
        { error: 'Validation failed.', fields: ['password'] },
        { status: 422 },
      );
    }
    throw err;
  }

  const { token, expiresAt } = createSession(tenantId);
  const response = NextResponse.json({ tenant_id: tenantId }, { status: 201 });
  setSessionCookie(response, token, expiresAt);
  return response;
}
