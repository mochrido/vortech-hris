import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, resetRateLimit } from './rate-limit.ts';

const WINDOW = 60_000;

test('allows up to max attempts within a window, then blocks the (max+1)th', () => {
  const t0 = 1_000_000;
  const key = 'login:user-a';

  for (let i = 1; i <= 5; i++) {
    const result = checkRateLimit(key, 5, WINDOW, t0);
    assert.equal(result.allowed, true, `attempt ${i} should be allowed`);
    assert.equal(result.remaining, 5 - i);
  }

  const blocked = checkRateLimit(key, 5, WINDOW, t0);
  assert.equal(blocked.allowed, false, '6th attempt within the window must be blocked');
  assert.equal(blocked.remaining, 0);
});

test('allows again after the window resets', () => {
  const t0 = 2_000_000;
  const key = 'login:user-b';

  for (let i = 0; i < 3; i++) {
    assert.equal(checkRateLimit(key, 3, WINDOW, t0).allowed, true);
  }
  assert.equal(checkRateLimit(key, 3, WINDOW, t0).allowed, false, 'blocked before window end');

  // One ms before reset: still blocked
  assert.equal(checkRateLimit(key, 3, WINDOW, t0 + WINDOW - 1).allowed, false);

  // At/after resetAt: fresh window
  const fresh = checkRateLimit(key, 3, WINDOW, t0 + WINDOW);
  assert.equal(fresh.allowed, true, 'a new window must allow attempts again');
  assert.equal(fresh.remaining, 2);
});

test('resetRateLimit clears the block for a key', () => {
  const t0 = 3_000_000;
  const key = 'login:user-c';

  for (let i = 0; i < 2; i++) {
    checkRateLimit(key, 2, WINDOW, t0);
  }
  assert.equal(checkRateLimit(key, 2, WINDOW, t0).allowed, false, 'blocked at max');

  resetRateLimit(key);

  const after = checkRateLimit(key, 2, WINDOW, t0);
  assert.equal(after.allowed, true, 'resetRateLimit must clear the block immediately');
  assert.equal(after.remaining, 1);
});

test('different keys are independent', () => {
  const t0 = 4_000_000;

  for (let i = 0; i < 2; i++) {
    checkRateLimit('key-x', 2, WINDOW, t0);
  }
  assert.equal(checkRateLimit('key-x', 2, WINDOW, t0).allowed, false);

  const other = checkRateLimit('key-y', 2, WINDOW, t0);
  assert.equal(other.allowed, true, 'blocking key-x must not affect key-y');
  assert.equal(other.remaining, 1);
});
