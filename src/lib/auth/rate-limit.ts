interface Bucket {
  count: number;
  resetAt: number;
}

// In-memory store: acceptable for the single-node MVP. Multi-instance
// deployments must move this to a shared store (e.g. Postgres or Redis).
const buckets = new Map<string, Bucket>();

// Soft cap on tracked keys. When exceeded, expired buckets are swept so the
// map cannot grow without bound from a flood of distinct keys.
const MAX_BUCKETS = 10_000;

/** Removes buckets whose window has already expired as of `now`. */
function evictExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Fixed-window rate limiter. Each key gets `max` attempts per `windowMs`.
 * `now` is injectable for deterministic testing.
 */
export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  // Lazy eviction: only sweep when the map grows past the threshold, and only
  // for a key that isn't already tracked (a fresh insert would grow the map).
  if (buckets.size > MAX_BUCKETS && !buckets.has(key)) {
    evictExpired(now);
  }

  let bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  if (bucket.count >= max) {
    return { allowed: false, remaining: 0 };
  }

  bucket.count += 1;
  return { allowed: true, remaining: max - bucket.count };
}

/** Clears the rate-limit state for a key (e.g. after a successful login). */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Test-only introspection into the in-memory store. Not for application use. */
export const __rateLimitInternals = {
  size: () => buckets.size,
  has: (key: string) => buckets.has(key),
};
