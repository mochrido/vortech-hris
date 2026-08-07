import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.ts';

const FORMAT = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/;

test('hashPassword returns the scrypt$N$r$p$saltB64$keyB64 format', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, FORMAT);

  const parts = hash.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], '16384');
  assert.equal(parts[2], '8');
  assert.equal(parts[3], '1');
  // salt is randomBytes(16) -> 24 base64 chars; key is 32 bytes -> 44 base64 chars
  assert.equal(Buffer.from(parts[4], 'base64').length, 16);
  assert.equal(Buffer.from(parts[5], 'base64').length, 32);
});

test('hashPassword never returns the raw password', async () => {
  const password = 'hunter2';
  const hash = await hashPassword(password);
  assert.notEqual(hash, password);
  assert.ok(!hash.includes(password), 'hash must not contain the raw password');
});

test('two hashes of the same password differ (unique salt)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  // yet both verify against the original password
  assert.equal(await verifyPassword(a, 'same-password'), true);
  assert.equal(await verifyPassword(b, 'same-password'), true);
});

test('verifyPassword returns true for the correct password', async () => {
  const hash = await hashPassword('S3cure!passphrase');
  assert.equal(await verifyPassword(hash, 'S3cure!passphrase'), true);
});

test('verifyPassword returns false for a wrong password', async () => {
  const hash = await hashPassword('S3cure!passphrase');
  assert.equal(await verifyPassword(hash, 'S3cure!passphrasf'), false);
  assert.equal(await verifyPassword(hash, ''), false);
});

test('verifyPassword returns false (does not throw) for malformed or tampered hashes', async () => {
  const malformed = [
    '',
    'not-a-hash',
    'scrypt$16384$8$1', // too few parts
    'scrypt$16384$8$1$extra$parts$here$ohmy',
    'bcrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'scrypt$abc$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // non-numeric params
    'scrypt$16384$8$1$%%%not-base64%%%$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$', // missing key
  ];

  for (const bad of malformed) {
    assert.equal(await verifyPassword(bad, 'whatever'), false, `should return false for: ${bad}`);
  }

  // Tampered key: valid format, wrong key bytes -> false, not throw
  const hash = await hashPassword('real-password');
  const parts = hash.split('$');
  const keyBytes = Buffer.from(parts[5], 'base64');
  keyBytes[0] ^= 0xff;
  const tampered = [...parts.slice(0, 5), keyBytes.toString('base64')].join('$');
  assert.equal(await verifyPassword(tampered, 'real-password'), false);
});

test('verifyPassword rejects an absurd scrypt N quickly without throwing', async () => {
  const salt = Buffer.alloc(16, 1).toString('base64');
  const key = Buffer.alloc(32, 2).toString('base64');

  // Well-formed string but N far above the accepted upper bound (2^20).
  const hugeN = ['scrypt', String(1 << 30), '8', '1', salt, key].join('$');
  // N just past the bound: a valid power of two, but 2^21 > 2^20 must be rejected.
  const overBound = ['scrypt', String(1 << 21), '8', '1', salt, key].join('$');
  // N not a positive power of two.
  const notPow2 = ['scrypt', '1000', '8', '1', salt, key].join('$');

  const start = Date.now();
  assert.equal(await verifyPassword(hugeN, 'pw'), false, 'must reject an N far above the upper bound');
  assert.equal(await verifyPassword(overBound, 'pw'), false, 'must reject N = 2^21 (> 2^20 upper bound)');
  assert.equal(await verifyPassword(notPow2, 'pw'), false, 'must reject a non-power-of-two N');
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `must reject without invoking scrypt (took ${elapsed}ms)`);
});
