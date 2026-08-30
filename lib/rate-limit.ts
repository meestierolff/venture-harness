import { isIP } from "node:net";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface InMemoryRateLimiterOptions {
  idleTtlMs?: number;
  maxBuckets?: number;
  now?: () => number;
}

/**
 * Per-instance token buckets with a hard memory bound. Map insertion order is
 * maintained as an LRU queue: every access moves its bucket to the back, while
 * expired and least-recently-used buckets leave from the front.
 */
export class InMemoryRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #idleTtlMs: number;
  readonly #maxBuckets: number;
  readonly #now: () => number;

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
    this.#maxBuckets = options.maxBuckets ?? 4_096;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#idleTtlMs) || this.#idleTtlMs < 1) {
      throw new Error("idleTtlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxBuckets) || this.#maxBuckets < 1) {
      throw new Error("maxBuckets must be a positive safe integer");
    }
  }

  get size(): number {
    return this.#buckets.size;
  }

  allow(key: string, ratePerMinute = 30, burst = 10): boolean {
    if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) {
      throw new Error("ratePerMinute must be positive");
    }
    if (!Number.isSafeInteger(burst) || burst < 1) {
      throw new Error("burst must be a positive safe integer");
    }

    const now = this.#now();
    this.#evictExpired(now);

    let bucket = this.#buckets.get(key);
    if (bucket) {
      this.#buckets.delete(key);
      const refill = ((now - bucket.updatedAt) / 60_000) * ratePerMinute;
      bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, refill));
      bucket.updatedAt = now;
    } else {
      while (this.#buckets.size >= this.#maxBuckets) this.#evictOldest();
      bucket = { tokens: burst, updatedAt: now };
    }

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return allowed;
  }

  #evictExpired(now: number): void {
    const cutoff = now - this.#idleTtlMs;
    while (this.#buckets.size > 0) {
      const oldest = this.#buckets.entries().next().value as [string, Bucket] | undefined;
      if (!oldest || oldest[1].updatedAt > cutoff) return;
      this.#buckets.delete(oldest[0]);
    }
  }

  #evictOldest(): void {
    const oldestKey = this.#buckets.keys().next().value as string | undefined;
    if (oldestKey !== undefined) this.#buckets.delete(oldestKey);
  }
}

export type TrustedRateLimitPlatform = "none" | "vercel";

function normalizedIp(value: string | null): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 64 || candidate.includes(",")) return null;

  const unwrapped =
    candidate.startsWith("[") && candidate.endsWith("]") ? candidate.slice(1, -1) : candidate;
  const version = isIP(unwrapped);
  if (version === 4) return unwrapped;
  if (version !== 6) return null;

  try {
    const hostname = new URL(`http://[${unwrapped}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Build a non-reflective limiter identity. Arbitrary X-Forwarded-For values
 * are ignored outside Vercel, where the platform overwrites its dedicated
 * forwarding header. Missing, chained, or malformed values intentionally
 * collapse into one anonymous bucket instead of creating attacker-chosen keys.
 */
export function clientRateLimitKey(
  headers: Pick<Headers, "get">,
  platform: TrustedRateLimitPlatform = process.env.VERCEL === "1" ? "vercel" : "none",
): string {
  if (platform !== "vercel") return "anonymous";

  const vercelForwardedFor = headers.get("x-vercel-forwarded-for");
  if (vercelForwardedFor !== null) {
    const ip = normalizedIp(vercelForwardedFor);
    return ip ? `ip:${ip}` : "anonymous";
  }

  const fallback = normalizedIp(headers.get("x-real-ip") ?? headers.get("x-forwarded-for"));
  return fallback ? `ip:${fallback}` : "anonymous";
}

const limiter = new InMemoryRateLimiter();

export function allowRequest(key: string, ratePerMinute = 30, burst = 10): boolean {
  return limiter.allow(key, ratePerMinute, burst);
}
