interface Bucket {
  count: number;
  resetAt: number;
}

// In-memory store: acceptable for the single-node MVP. Multi-instance
// deployments must move this to a shared store (e.g. Postgres or Redis).
const buckets = new Map<string, Bucket>();

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
