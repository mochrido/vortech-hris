import { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
// Largest accepted clock-skew window, in time steps. verifyTotp clamps any
// caller-supplied window into [0, MAX_TOTP_WINDOW] so a programming error can
// never widen the acceptance window beyond ±2 steps (±60s).
const MAX_TOTP_WINDOW = 2;
const IV_LENGTH = 12; // 96-bit IV for AES-GCM
const TAG_LENGTH = 16; // 128-bit auth tag

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP: ReadonlyMap<string, number> = new Map(
  BASE32_ALPHABET.split('').map((ch, i) => [ch, i]),
);

/** RFC 4648 base32 encode (no padding). */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** RFC 4648 base32 decode (accepts optional padding). */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_LOOKUP.get(ch);
    if (idx === undefined) {
      throw new Error(`invalid base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** Generates a new TOTP secret as a base32 string from 20 random bytes. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Computes the RFC 6238 TOTP code for a secret at a given time step.
 * Uses HMAC-SHA1, 30-second steps, dynamic truncation, 6 digits.
 */
export function totpCode(secret: string, timeStep: number): string {
  const key = base32Decode(secret);
  // 8-byte big-endian counter
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const hmac = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation per RFC 4226
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** TOTP_DIGITS;
  return String(otp).padStart(TOTP_DIGITS, '0');
}

function currentTimeStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Normalizes the caller-supplied skew window to a safe integer in
 * [0, MAX_TOTP_WINDOW]. Non-finite or non-numeric input falls back to the
 * default of 1; fractional values are truncated; out-of-range values are
 * clamped. This fails closed: no input can ever widen the window beyond ±2.
 */
function clampWindow(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input) ? Math.trunc(input) : 1;
  return Math.min(MAX_TOTP_WINDOW, Math.max(0, value));
}

/**
 * Verifies a TOTP code against a secret. Accepts codes within ±`window`
 * time steps of the current step. The window is clamped to [0, 2]; the
 * default is 1 to tolerate typical clock skew.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { window?: number } = {},
): boolean {
  const window = clampWindow(options.window);
  if (!/^\d{6}$/.test(code)) return false;
  const now = currentTimeStep();
  for (let offset = -window; offset <= window; offset++) {
    const expected = totpCode(secret, now + offset);
    // Constant-time comparison
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return true;
    }
  }
  return false;
}

function encryptionKey(): Buffer {
  const hex = process.env.TOTP_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('TOTP_ENCRYPTION_KEY is not set');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('TOTP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a TOTP secret with AES-256-GCM using TOTP_ENCRYPTION_KEY.
 * Output layout (base64): [12-byte IV][16-byte auth tag][ciphertext].
 */
export function encryptTotpSecret(secret: string): string {
  const key = encryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypts a TOTP secret produced by encryptTotpSecret.
 * Throws if the key is wrong, the data is tampered, or the format is invalid.
 */
export function decryptTotpSecret(encrypted: string): string {
  const key = encryptionKey();
  const data = Buffer.from(encrypted, 'base64');
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('invalid encrypted TOTP secret: too short');
  }
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}
