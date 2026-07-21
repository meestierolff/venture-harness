/**
 * Minimal in-memory token bucket per key (IP). Good enough to keep a
 * validation site's evidence clean; swap for a durable limiter if abuse
 * appears. Not shared across serverless instances — a known, accepted
 * limitation recorded in docs/plans/TECH_DEBT.md territory.
 */
const buckets = new Map<string, { tokens: number; updatedAt: number }>();

export function allowRequest(key: string, ratePerMinute = 30, burst = 10): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: burst, updatedAt: now };
  const refill = ((now - bucket.updatedAt) / 60000) * ratePerMinute;
  bucket.tokens = Math.min(burst, bucket.tokens + refill);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}
