import test from 'node:test';
import assert from 'node:assert/strict';
import { __rateLimitInternals, checkRateLimit, resetRateLimit } from './rate-limit.ts';

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

test('expired buckets are evicted once the map exceeds the size threshold, active ones are kept', () => {
  const base = 10_000_000;

  // Fill beyond the 10_000 threshold with buckets that are all expired by `later`.
  for (let i = 0; i < 10_001; i++) {
    checkRateLimit(`expired:${i}`, 5, WINDOW, base);
  }
  assert.equal(__rateLimitInternals.has('expired:0'), true, 'precondition: bucket present before sweep');
  const sizeBefore = __rateLimitInternals.size();
  assert.ok(sizeBefore > 10_000, `precondition: map exceeds threshold (size=${sizeBefore})`);

  // An active bucket created far in the future relative to `later`.
  checkRateLimit('active-key', 5, WINDOW, base + 10 * WINDOW);

  // A fresh key at a time when the `expired:*` buckets are stale but
  // `active-key` is still inside its window. This triggers the lazy sweep.
  const later = base + 5 * WINDOW;
  checkRateLimit('trigger-sweep', 5, WINDOW, later);

  // The sweep removed the expired buckets...
  assert.equal(__rateLimitInternals.has('expired:0'), false, 'expired bucket must be evicted by the sweep');
  assert.equal(__rateLimitInternals.has('expired:5000'), false, 'all expired buckets must be evicted');
  assert.ok(
    __rateLimitInternals.size() < sizeBefore,
    'map must shrink after evicting expired buckets',
  );

  // ...but retained the still-active bucket.
  assert.equal(__rateLimitInternals.has('active-key'), true, 'active bucket must be retained across the sweep');
  const active = checkRateLimit('active-key', 5, WINDOW, later);
  assert.equal(active.allowed, true);
  assert.equal(active.remaining, 3, 'active bucket keeps its consumed attempt (not reset)');
});
