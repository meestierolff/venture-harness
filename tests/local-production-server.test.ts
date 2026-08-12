import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalServerNonce,
  isAddressInUseOutput,
  waitForOwnedHttpReady,
} from "@/scripts/lib/local-production-server.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local production server ownership", () => {
  it("accepts only an HMAC from the exact spawned server", async () => {
    const nonce = createLocalServerNonce();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const challenge = new Headers(init.headers).get("x-vh-local-server-challenge");
      expect(challenge).toMatch(/^[a-f0-9]{48}$/u);
      expect(JSON.stringify(init.headers)).not.toContain(nonce);
      const proof = createHmac("sha256", nonce).update(challenge!).digest("hex");
      return new Response(JSON.stringify({ ready: true, proof }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForOwnedHttpReady(
        "http://127.0.0.1:43210",
        { exitCode: null, signalCode: null },
        nonce,
        1_000,
      ),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/api/health",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects a stale listener that reflects the public challenge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const reflected = new Headers(init.headers).get("x-vh-local-server-challenge");
        return new Response(JSON.stringify({ ready: true, proof: reflected }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await expect(
      waitForOwnedHttpReady(
        "http://127.0.0.1:43210",
        { exitCode: null, signalCode: null },
        "current-run",
        1,
      ),
    ).rejects.toThrow(/did not become ready/);
  });

  it("keeps the ownership probe unavailable without a runner nonce", () => {
    const route = readFileSync("app/api/health/route.ts", "utf8");
    expect(route).toContain("VH_LOCAL_SERVER_NONCE");
    expect(route).toContain('request.headers.get("x-vh-local-server-challenge")');
    expect(route).toContain('createHmac("sha256", expected)');
    expect(route).toContain("status: 404");
    expect(route).not.toContain("nonce: expected");
  });

  it("retries only an explicit address-in-use bind race", () => {
    expect(isAddressInUseOutput("listen EADDRINUSE: address already in use 127.0.0.1")).toBe(true);
    expect(isAddressInUseOutput("application build failed")).toBe(false);
  });
});
