import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// lib/credentialCrypto.ts resolves its master key once per process and
// caches it in module scope (`let cachedKey`), reading either
// BOOKSELLER_CREDENTIAL_KEY (env, wins outright) or a key file at
// BOOKSELLER_CREDENTIAL_KEY_PATH (generating one on first use if absent).
// vitest.config.ts sets BOOKSELLER_CREDENTIAL_KEY_PATH globally to a shared
// scratch file for the rest of the suite, so to exercise each key-loading
// branch independently (env var / existing file / fresh-generate) without
// cross-test interference, each test here gets its own scratch directory,
// resets process.env itself, and re-imports the module fresh via
// vi.resetModules() -- the same technique lib/__tests__/photos.test.ts and
// lib/__tests__/tailnetOrigin.test.ts use for import-time env-derived state.
//
// Cipher primitive: as of the credential-crypto migration, the AEAD call
// itself is delegated to @preston-bernstein/credential-crypto's
// encryptBytes/decryptBytes (XChaCha20-Poly1305), packed as
// nonce(24B)||ciphertext+tag. loadMasterKey() and its key-loading branches
// are unchanged, so those test groups below assert exactly what they did
// before -- only the buffer-layout and boundary-length assertions differ.

const ORIGINAL_ENV_KEY = process.env.BOOKSELLER_CREDENTIAL_KEY;
const ORIGINAL_KEY_PATH = process.env.BOOKSELLER_CREDENTIAL_KEY_PATH;

let scratchDir: string | undefined;

afterEach(() => {
  if (ORIGINAL_ENV_KEY === undefined) {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
  } else {
    process.env.BOOKSELLER_CREDENTIAL_KEY = ORIGINAL_ENV_KEY;
  }
  if (ORIGINAL_KEY_PATH === undefined) {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY_PATH;
  } else {
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = ORIGINAL_KEY_PATH;
  }
  if (scratchDir) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
  vi.restoreAllMocks();
});

function freshScratchDir(): string {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-key-test-'));
  return scratchDir;
}

async function freshModule() {
  vi.resetModules();
  return import('../credentialCrypto');
}

describe('lib/credentialCrypto.ts round-trip', () => {
  it('encrypts and decrypts a string, recovering the exact plaintext', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential, decryptCredential } = await freshModule();

    const encrypted = encryptCredential('my-secret-token');
    expect(decryptCredential(encrypted)).toBe('my-secret-token');
  });

  it('encrypts and decrypts an object as its JSON-serialized form', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential, decryptCredential } = await freshModule();

    const credential = { apiKey: 'abc123', secret: 'xyz789' };
    const encrypted = encryptCredential(credential);
    expect(JSON.parse(decryptCredential(encrypted))).toEqual(credential);
  });

  it('produces a fresh random nonce on every call, so encrypting the same plaintext twice yields different ciphertext', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential } = await freshModule();

    const a = encryptCredential('same-plaintext');
    const b = encryptCredential('same-plaintext');
    expect(a.equals(b)).toBe(false);
  });

  it('returns a buffer laid out as nonce(24B)||ciphertext+tag', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential } = await freshModule();

    const encrypted = encryptCredential('x');
    // 24 (nonce) + 1 (plaintext 'x') + 16 (Poly1305 tag appended to ciphertext) = 41.
    expect(encrypted.length).toBe(24 + 1 + 16);
  });
});

describe('lib/credentialCrypto.ts BOOKSELLER_CREDENTIAL_KEY (env) branch', () => {
  it('uses a valid 32-byte hex env key directly, without touching the filesystem fallback', async () => {
    const dir = freshScratchDir();
    const keyPath = path.join(dir, 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;
    process.env.BOOKSELLER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('hex');
    const { encryptCredential, decryptCredential } = await freshModule();

    const encrypted = encryptCredential('secret-via-env-key');
    expect(decryptCredential(encrypted)).toBe('secret-via-env-key');
    // The key-file fallback path must never be touched when the env key wins.
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('throws when BOOKSELLER_CREDENTIAL_KEY decodes to fewer than 32 bytes', async () => {
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY = Buffer.alloc(16, 1).toString('hex'); // 16 bytes, not 32
    const { encryptCredential } = await freshModule();

    expect(() => encryptCredential('x')).toThrow(/32 bytes/);
  });

  it('throws when BOOKSELLER_CREDENTIAL_KEY decodes to more than 32 bytes', async () => {
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY = Buffer.alloc(48, 1).toString('hex'); // 48 bytes, not 32
    const { encryptCredential } = await freshModule();

    expect(() => encryptCredential('x')).toThrow(/32 bytes/);
  });

  it('reports the actual decoded byte length in the error message', async () => {
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY = Buffer.alloc(10, 1).toString('hex');
    const { encryptCredential } = await freshModule();

    expect(() => encryptCredential('x')).toThrow(/got 10/);
  });
});

describe('lib/credentialCrypto.ts key-file branch (no env var)', () => {
  it('throws when an existing key file is the wrong number of bytes', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    const dir = freshScratchDir();
    const keyPath = path.join(dir, 'credential.key');
    fs.writeFileSync(keyPath, Buffer.alloc(20)); // not 32 bytes
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;
    const { encryptCredential } = await freshModule();

    expect(() => encryptCredential('x')).toThrow(/20 bytes, expected 32/);
  });

  it('generates a fresh 32-byte key when neither env var nor key file exists, and persists it to disk', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    const dir = freshScratchDir();
    const keyPath = path.join(dir, 'nested', 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;
    expect(fs.existsSync(keyPath)).toBe(false);

    const { encryptCredential } = await freshModule();
    encryptCredential('triggers key generation');

    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath).length).toBe(32);
  });

  it('writes the freshly generated key file with mode 0600 (owner read/write only)', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    const dir = freshScratchDir();
    const keyPath = path.join(dir, 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;

    const { encryptCredential } = await freshModule();
    encryptCredential('x');

    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reuses the same generated key for encrypt then decrypt within the same process (cache), even after the on-disk file is deleted', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    const dir = freshScratchDir();
    const keyPath = path.join(dir, 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;

    const { encryptCredential, decryptCredential } = await freshModule();
    const encrypted = encryptCredential('cached-key-round-trip');
    // Remove the on-disk file: if the cache were NOT working, the next
    // loadMasterKey() call would regenerate a different key and decryption
    // would fail (auth tag mismatch) instead of succeeding.
    fs.rmSync(keyPath);

    expect(decryptCredential(encrypted)).toBe('cached-key-round-trip');
  });

  it('does not re-read the key file from disk on a second call once cached (module-scope cache)', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    const dir = freshScratchDir();
    const keyPath = path.join(dir, 'credential.key');
    fs.writeFileSync(keyPath, Buffer.alloc(32, 3), { mode: 0o600 });
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = keyPath;

    const { encryptCredential } = await freshModule();
    const readFileSpy = vi.spyOn(fs, 'readFileSync');

    encryptCredential('first-call-reads-file');
    expect(readFileSpy).toHaveBeenCalledTimes(1);

    encryptCredential('second-call-should-use-cache');
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });
});

describe('lib/credentialCrypto.ts decryptCredential AEAD tamper detection', () => {
  it('throws when the ciphertext bytes have been tampered with (auth tag fails to verify)', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential, decryptCredential } = await freshModule();

    const encrypted = encryptCredential('a value worth protecting');
    const tampered = Buffer.from(encrypted);
    // Flip the last byte -- part of the Poly1305 tag appended to the ciphertext, past nonce(24).
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => decryptCredential(tampered)).toThrow();
  });

  it('throws when a byte inside the ciphertext+tag region has been tampered with', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential, decryptCredential } = await freshModule();

    const encrypted = encryptCredential('another protected value');
    const tampered = Buffer.from(encrypted);
    tampered[24] ^= 0xff; // byte 24 is the first byte past the 24-byte nonce, inside ciphertext+tag

    expect(() => decryptCredential(tampered)).toThrow();
  });

  it('throws when the nonce has been tampered with (decrypts to garbage, auth tag fails)', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential, decryptCredential } = await freshModule();

    const encrypted = encryptCredential('yet another protected value');
    const tampered = Buffer.from(encrypted);
    tampered[0] ^= 0xff; // byte 0 is inside the 24-byte nonce

    expect(() => decryptCredential(tampered)).toThrow();
  });

  it('never returns a decrypted string when tampered -- decryption genuinely fails, not silently succeeds with wrong output', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { encryptCredential, decryptCredential } = await freshModule();

    const original = 'do-not-leak-this';
    const encrypted = encryptCredential(original);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;

    let threw = false;
    try {
      decryptCredential(tampered);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('throws when the buffer is shorter than the structural minimum (nonce 24B + tag 16B = 40 bytes)', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { decryptCredential } = await freshModule();

    expect(() => decryptCredential(Buffer.alloc(39))).toThrow(/too short/);
  });

  it('reports the actual too-short buffer length in the error message', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { decryptCredential } = await freshModule();

    expect(() => decryptCredential(Buffer.alloc(5))).toThrow(/5 bytes/);
  });

  it('throws on a zero-length buffer', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { decryptCredential } = await freshModule();

    expect(() => decryptCredential(Buffer.alloc(0))).toThrow();
  });

  it('does not throw the too-short error for a buffer exactly at the structural boundary (40 bytes, empty ciphertext+tag) -- fails later, on auth tag verification instead', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    const { decryptCredential } = await freshModule();

    // Exactly 40 bytes clears the length guard, but is not a real
    // encrypted payload, so it must still fail -- just via auth-tag
    // verification, not the "too short" message.
    expect(() => decryptCredential(Buffer.alloc(40))).not.toThrow(/too short/);
    expect(() => decryptCredential(Buffer.alloc(40))).toThrow();
  });

  it('throws when decrypting a buffer that was encrypted under a different key', async () => {
    delete process.env.BOOKSELLER_CREDENTIAL_KEY;
    process.env.BOOKSELLER_CREDENTIAL_KEY_PATH = path.join(freshScratchDir(), 'credential.key');
    process.env.BOOKSELLER_CREDENTIAL_KEY = Buffer.alloc(32, 1).toString('hex');
    const { encryptCredential } = await freshModule();
    const encrypted = encryptCredential('encrypted-under-key-one');

    // Re-import with a different env key so loadMasterKey() resolves a
    // different 32-byte key this time.
    process.env.BOOKSELLER_CREDENTIAL_KEY = Buffer.alloc(32, 2).toString('hex');
    const { decryptCredential } = await freshModule();

    expect(() => decryptCredential(encrypted)).toThrow();
  });
});
