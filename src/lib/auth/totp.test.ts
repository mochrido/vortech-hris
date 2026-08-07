import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  generateTotpSecret,
  totpCode,
  verifyTotp,
  encryptTotpSecret,
  decryptTotpSecret,
  base32Encode,
  base32Decode,
} from './totp.ts';

const TEST_KEY = randomBytes(32).toString('hex');

function withTotpKey<T>(key: string | undefined, fn: () => T): T {
  const saved = process.env.TOTP_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
  else process.env.TOTP_ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = saved;
  }
}

test('base32 encode/decode round-trips', () => {
  const bytes = randomBytes(20);
  const encoded = base32Encode(bytes);
  assert.match(encoded, /^[A-Z2-7]+$/, 'base32 must use RFC 4648 alphabet');
  const decoded = base32Decode(encoded);
  assert.deepEqual(decoded, bytes);
});

test('generateTotpSecret returns a base32 secret from 20 bytes', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/, '20 bytes -> 32 base32 chars (no padding)');
  // Two secrets differ
  const other = generateTotpSecret();
  assert.notEqual(secret, other);
});

test('totpCode produces a deterministic 6-digit code for a time step', () => {
  const secret = generateTotpSecret();
  const step = 123456789;
  const code1 = totpCode(secret, step);
  const code2 = totpCode(secret, step);
  assert.equal(code1, code2, 'same step must produce the same code');
  assert.match(code1, /^\d{6}$/, 'code must be 6 digits');
});

test('verifyTotp returns true for the current code', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const step = Math.floor(now / 30);
  const code = totpCode(secret, step);
  assert.equal(verifyTotp(secret, code), true, 'current code must verify');
});

test('verifyTotp returns false for a wrong code', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const step = Math.floor(now / 30);
  const good = totpCode(secret, step);
  // A code that differs from the correct one
  const wrong = good === '000000' ? '000001' : String((Number(good) + 1) % 1_000_000).padStart(6, '0');
  assert.equal(verifyTotp(secret, wrong), false, 'wrong code must not verify');
});

test('verifyTotp accepts codes within ±1 time step window', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const step = Math.floor(now / 30);

  const prev = totpCode(secret, step - 1);
  const curr = totpCode(secret, step);
  const next = totpCode(secret, step + 1);

  assert.equal(verifyTotp(secret, prev, { window: 1 }), true, 'previous step must verify within window 1');
  assert.equal(verifyTotp(secret, curr, { window: 1 }), true, 'current step must verify');
  assert.equal(verifyTotp(secret, next, { window: 1 }), true, 'next step must verify within window 1');
});

test('verifyTotp rejects a code outside the window', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const step = Math.floor(now / 30);

  const tooOld = totpCode(secret, step - 2);
  const tooNew = totpCode(secret, step + 2);

  assert.equal(verifyTotp(secret, tooOld, { window: 1 }), false, 'code 2 steps old must be rejected');
  assert.equal(verifyTotp(secret, tooNew, { window: 1 }), false, 'code 2 steps ahead must be rejected');
});

test('verifyTotp with window 0 rejects non-current codes', () => {
  const secret = generateTotpSecret();
  const now = Math.floor(Date.now() / 1000);
  const step = Math.floor(now / 30);

  const prev = totpCode(secret, step - 1);
  assert.equal(verifyTotp(secret, prev, { window: 0 }), false, 'window 0 must reject previous step');
});

test('encryptTotpSecret/decryptTotpSecret round-trips', () => {
  withTotpKey(TEST_KEY, () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    assert.notEqual(encrypted, secret, 'ciphertext must differ from plaintext');
    const decrypted = decryptTotpSecret(encrypted);
    assert.equal(decrypted, secret, 'decryption must recover the original secret');
  });
});

test('encryptTotpSecret produces unique ciphertexts (random IV)', () => {
  withTotpKey(TEST_KEY, () => {
    const secret = generateTotpSecret();
    const a = encryptTotpSecret(secret);
    const b = encryptTotpSecret(secret);
    assert.notEqual(a, b, 'random IV must produce different ciphertexts');
    assert.equal(decryptTotpSecret(a), secret);
    assert.equal(decryptTotpSecret(b), secret);
  });
});

test('decryptTotpSecret fails on tampered ciphertext', () => {
  withTotpKey(TEST_KEY, () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    // Flip a byte near the end (ciphertext region)
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    assert.throws(() => decryptTotpSecret(tampered), 'tampered ciphertext must throw');
  });
});

test('decryptTotpSecret fails on tampered auth tag', () => {
  withTotpKey(TEST_KEY, () => {
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    const buf = Buffer.from(encrypted, 'base64');
    // AES-256-GCM layout: [12-byte IV][16-byte tag][ciphertext]
    // Tamper with the tag (bytes 12..28)
    buf[15] ^= 0x01;
    const tampered = buf.toString('base64');
    assert.throws(() => decryptTotpSecret(tampered), 'tampered tag must throw');
  });
});

test('encrypt/decrypt throws when TOTP_ENCRYPTION_KEY is missing', () => {
  withTotpKey(undefined, () => {
    assert.throws(() => encryptTotpSecret('ABC'), 'missing key must throw');
  });
});

test('encrypt/decrypt throws when TOTP_ENCRYPTION_KEY is not 64 hex chars', () => {
  withTotpKey('tooshort', () => {
    assert.throws(() => encryptTotpSecret('ABC'), 'bad key must throw');
  });
});
