import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// 32 random bytes (256 bits), hex-encoded → 64 hex chars. Shared shape for
// every raw bearer token this app hands out (phone pairing tokens, tenant
// sessions) — only the SHA-256 hash below is ever persisted; the raw value
// is returned once, at issuance, and never stored.
const TOKEN_BYTES = 32;

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Generate one opaque bearer token: a random 64-hex-char raw value (hand
 * this to the client), its SHA-256 hash (the only form to persist), a fresh
 * id, and an expiry `ttlMs` out from now. Previously duplicated verbatim
 * between lib/pairingToken.ts#createToken and lib/tenantAuth.ts#createSession.
 */
export function generateOpaqueToken(ttlMs: number): {
  id: string;
  rawToken: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
} {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(rawToken);
  const id = uuidv4();
  const createdAt = Date.now();
  const expiresAt = createdAt + ttlMs;
  return { id, rawToken, tokenHash, createdAt, expiresAt };
}
