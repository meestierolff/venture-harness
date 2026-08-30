import { describe, expect, it } from "vitest";
import { clientRateLimitKey, InMemoryRateLimiter } from "@/lib/rate-limit";

describe("bounded in-memory rate limiting", () => {
  it("keeps a hard LRU bound under attacker-controlled key churn", () => {
    let now = 1;
    const limiter = new InMemoryRateLimiter({ maxBuckets: 32, idleTtlMs: 60_000, now: () => now });
    for (let index = 0; index < 10_000; index += 1) {
      now += 1;
      expect(limiter.allow(`attacker-${index}`, 1, 1)).toBe(true);
    }
    expect(limiter.size).toBe(32);
  });

  it("expires idle buckets and evicts the least recently used bucket", () => {
    let now = 1;
    const expiring = new InMemoryRateLimiter({ maxBuckets: 4, idleTtlMs: 100, now: () => now });
    expiring.allow("a", 1, 1);
    expiring.allow("b", 1, 1);
    now = 102;
    expiring.allow("c", 1, 1);
    expect(expiring.size).toBe(1);

    now = 1;
    const lru = new InMemoryRateLimiter({ maxBuckets: 2, idleTtlMs: 1_000, now: () => now });
    expect(lru.allow("a", 1, 1)).toBe(true);
    expect(lru.allow("b", 1, 1)).toBe(true);
    expect(lru.allow("a", 1, 1)).toBe(false); // touch a, making b oldest
    expect(lru.allow("c", 1, 1)).toBe(true);
    expect(lru.allow("b", 1, 1)).toBe(true); // b was evicted, so it has a fresh bucket
  });
});

describe("rate-limit client identity", () => {
  it("does not use arbitrary forwarded values outside a trusted platform", () => {
    const first = new Headers({ "x-forwarded-for": "198.51.100.1" });
    const second = new Headers({ "x-forwarded-for": "203.0.113.200" });
    expect(clientRateLimitKey(first, "none")).toBe("anonymous");
    expect(clientRateLimitKey(second, "none")).toBe("anonymous");
  });

  it("normalizes a trusted Vercel address and fails malformed chains closed", () => {
    expect(
      clientRateLimitKey(
        new Headers({ "x-vercel-forwarded-for": "2001:0db8:0:0:0:0:0:1" }),
        "vercel",
      ),
    ).toBe("ip:2001:db8::1");
    expect(
      clientRateLimitKey(
        new Headers({ "x-vercel-forwarded-for": "198.51.100.1, 203.0.113.2" }),
        "vercel",
      ),
    ).toBe("anonymous");
    expect(
      clientRateLimitKey(
        new Headers({ "x-vercel-forwarded-for": "malformed-attacker-value" }),
        "vercel",
      ),
    ).toBe("anonymous");
  });
});
