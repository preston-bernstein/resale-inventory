import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

// AES-256-GCM encrypt/decrypt for platform_connections.encrypted_credential
// (data/migrations/005_tenants.sql — BLOB, format iv(12B)||authTag(16B)||ciphertext,
// CHECK length >= 29). No key-rotation / multi-key-version support in this
// increment by design (see plan.md Risk areas) — one master key, used as-is.

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM-recommended nonce size
const AUTH_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

// Key-file path is configurable via BOOKSELLER_CREDENTIAL_KEY_PATH so tests
// can point at a scratch file instead of the operator's real
// data/credential.key (mirrors lib/db.ts's BOOKSELLER_DB_PATH pattern).
// Unset -> the historical cwd default, so behavior is unchanged in production.
function resolveKeyPath(): string {
  return (
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH ??
    path.join(process.cwd(), 'data', 'credential.key')
  );
}

// Cached in module scope so the key is only read/generated once per process,
// not on every encrypt/decrypt call.
let cachedKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  // BOOKSELLER_CREDENTIAL_KEY, if set, wins outright — a hex-encoded 32-byte
  // key supplied directly by the operator (e.g. production deployment),
  // never touching the filesystem fallback below.
  const envKey = process.env.BOOKSELLER_CREDENTIAL_KEY;
  if (envKey) {
    const keyBuf = Buffer.from(envKey, 'hex');
    if (keyBuf.length !== KEY_BYTES) {
      throw new Error(
        `BOOKSELLER_CREDENTIAL_KEY must decode to ${KEY_BYTES} bytes (64 hex chars); got ${keyBuf.length}`,
      );
    }
    cachedKey = keyBuf;
    return cachedKey;
  }

  // No env key: fall back to a key file on disk, generating one on first
  // use if it doesn't exist yet (zero-config local dev). Mode 0600 — this
  // file is as sensitive as the credentials it protects.
  const keyPath = resolveKeyPath();
  if (fs.existsSync(keyPath)) {
    const keyBuf = fs.readFileSync(keyPath);
    if (keyBuf.length !== KEY_BYTES) {
      throw new Error(
        `Credential key file at ${keyPath} is ${keyBuf.length} bytes, expected ${KEY_BYTES}`,
      );
    }
    cachedKey = keyBuf;
    return cachedKey;
  }

  const freshKey = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, freshKey, { mode: 0o600 });
  cachedKey = freshKey;
  return cachedKey;
}

/**
 * Encrypt a credential (string or JSON-serializable object) for storage in
 * platform_connections.encrypted_credential. Returns
 * iv(12B)||authTag(16B)||ciphertext, with a fresh random IV every call.
 */
export function encryptCredential(plaintext: string | object): Buffer {
  const serialized = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const key = loadMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt a buffer produced by encryptCredential, returning the original
 * plaintext string. Throws if the buffer is malformed or the auth tag
 * doesn't verify (tamper/corruption/wrong key) — callers must not swallow
 * this.
 */
export function decryptCredential(encrypted: Buffer): string {
  if (encrypted.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error(
      `Encrypted credential buffer too short: ${encrypted.length} bytes (min ${IV_BYTES + AUTH_TAG_BYTES})`,
    );
  }

  const key = loadMasterKey();
  const iv = encrypted.subarray(0, IV_BYTES);
  const authTag = encrypted.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = encrypted.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
