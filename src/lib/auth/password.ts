import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Hard ceiling on the scrypt cost factor parsed from a stored hash. Guards
// against attacker-influenced hashes requesting an absurd amount of memory/CPU.
const MAX_SCRYPT_N = 1 << 20;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Hashes a password with scrypt and a unique random salt.
 * Returns `scrypt$N$r$p$saltB64$keyB64`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Verifies a password against a stored `scrypt$N$r$p$saltB64$keyB64` hash.
 * Never throws: returns false for malformed/tampered hashes or mismatches.
 */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // N must be a positive power of two and within the accepted upper bound,
    // so a parsed attacker-influenced N can never reach scrypt.
    if (N <= 1 || N > MAX_SCRYPT_N || (N & (N - 1)) !== 0) return false;
    if (r <= 0 || p <= 0) return false;

    const salt = Buffer.from(parts[4], 'base64');
    const expectedKey = Buffer.from(parts[5], 'base64');
    if (salt.length === 0 || expectedKey.length === 0) return false;
    if (salt.toString('base64') !== parts[4] || expectedKey.toString('base64') !== parts[5]) return false;

    const derivedKey = await scryptAsync(password, salt, expectedKey.length, { N, r, p });
    return timingSafeEqual(derivedKey, expectedKey);
  } catch {
    return false;
  }
}
