import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { encryptBytes, decryptBytes } from '@preston-bernstein/credential-crypto';

// XChaCha20-Poly1305 encrypt/decrypt for platform_connections.encrypted_credential
// (data/migrations/007_platform_connections.sql — BLOB, format nonce(24B)||ciphertext+tag,
// CHECK length >= 41 as of data/migrations/013_credential_column_floor.sql). The AEAD
// primitive itself is delegated to the shared @preston-bernstein/credential-crypto
// package (encryptBytes/decryptBytes) so this repo no longer maintains its own cipher
// call site — see that package's src/primitives.ts for the exact packing format.
// XChaCha20-Poly1305 was chosen as the one canonical cipher because it was
// fashion-monitor's pre-existing working choice, not because this repo's old
// AES-256-GCM was deficient. Key-loading strategy below is intentionally NOT
// shared — only the cipher primitive is; loadMasterKey() is unchanged from
// before this migration. No key-rotation / multi-key-version support in this
// increment by design (inherited unchanged) — one master key, used as-is.

const KEY_BYTES = 32; // XChaCha20-Poly1305 key size (also matches the old AES-256 size)

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
 * nonce(24B)||ciphertext+tag (credential-crypto's packing format), with a
 * fresh random nonce every call.
 */
export function encryptCredential(plaintext: string | object): Buffer {
  const serialized = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const key = loadMasterKey();
  const packed = encryptBytes(new TextEncoder().encode(serialized), key);
  return Buffer.from(packed);
}

/**
 * Decrypt a buffer produced by encryptCredential, returning the original
 * plaintext string. Throws if the buffer is malformed or the auth tag
 * doesn't verify (tamper/corruption/wrong key) — callers must not swallow
 * this. The structural too-short check and AEAD verification both happen
 * inside decryptBytes (credential-crypto/src/primitives.ts); this function
 * does not duplicate that logic.
 */
export function decryptCredential(encrypted: Buffer): string {
  const key = loadMasterKey();
  const plaintext = decryptBytes(encrypted, key);
  return Buffer.from(plaintext).toString('utf8');
}
