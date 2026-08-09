import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryOAuthTransactionStore,
  beginOAuthAuthorization,
  consumeOAuthCallback,
  isPublicInternetAddress,
  safeUploadDestination,
  signWebhookFixture,
  validateProviderUrl,
  validateUpload,
  verifySignedWebhook,
} from "@/lib/security";

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

function oauthBinding() {
  return {
    provider: "fixture-provider",
    organizationId: "org-a",
    ventureId: "venture-a",
    actorId: "founder-a",
    sessionId: "session-a",
  };
}

describe("OAuth state, PKCE, and callback binding", () => {
  it("mints high-entropy state and S256 PKCE then consumes it exactly once", async () => {
    const store = new InMemoryOAuthTransactionStore();
    let call = 0;
    const started = await beginOAuthAuthorization(
      {
        ...oauthBinding(),
        redirectUri: "https://control.example/oauth/callback",
        allowedRedirectUris: ["https://control.example/oauth/callback"],
        returnPath: "/connections?provider=fixture",
        now: new Date("2026-08-09T12:00:00.000Z"),
        random: (size) => new Uint8Array(size).fill(++call),
      },
      store,
    );
    expect(started.state.length).toBeGreaterThanOrEqual(43);
    expect(started.codeChallengeMethod).toBe("S256");
    expect(started.codeChallenge).not.toBe(started.state);

    const consumed = await consumeOAuthCallback(
      {
        ...oauthBinding(),
        state: started.state,
        redirectUri: started.redirectUri,
        allowedRedirectUris: [started.redirectUri],
        code: "fixture-authorization-code",
        now: new Date("2026-08-09T12:01:00.000Z"),
      },
      store,
    );
    expect(consumed).toMatchObject({
      code: "fixture-authorization-code",
      redirectUri: "https://control.example/oauth/callback",
      returnPath: "/connections?provider=fixture",
    });
    expect(consumed.codeVerifier.length).toBeGreaterThanOrEqual(43);
    await expect(
      consumeOAuthCallback(
        {
          ...oauthBinding(),
          state: started.state,
          redirectUri: started.redirectUri,
          allowedRedirectUris: [started.redirectUri],
          code: "replay",
        },
        store,
      ),
    ).rejects.toThrow("OAuth callback was rejected");
  });

  it("fails closed on tenant mismatch, expiry, callback errors, and redirect confusion", async () => {
    const begin = async (store: InMemoryOAuthTransactionStore, now = "2026-08-09T12:00:00Z") =>
      beginOAuthAuthorization(
        {
          ...oauthBinding(),
          redirectUri: "https://control.example/oauth/callback",
          allowedRedirectUris: ["https://control.example/oauth/callback"],
          returnPath: "/connections",
          now: new Date(now),
        },
        store,
      );

    const tenantStore = new InMemoryOAuthTransactionStore();
    const tenant = await begin(tenantStore);
    await expect(
      consumeOAuthCallback(
        {
          ...oauthBinding(),
          ventureId: "venture-b",
          state: tenant.state,
          redirectUri: tenant.redirectUri,
          allowedRedirectUris: [tenant.redirectUri],
          code: "code",
        },
        tenantStore,
      ),
    ).rejects.toThrow("OAuth callback was rejected");

    const expiredStore = new InMemoryOAuthTransactionStore();
    const expired = await begin(expiredStore);
    await expect(
      consumeOAuthCallback(
        {
          ...oauthBinding(),
          state: expired.state,
          redirectUri: expired.redirectUri,
          allowedRedirectUris: [expired.redirectUri],
          code: "code",
          now: new Date("2026-08-09T12:11:00Z"),
        },
        expiredStore,
      ),
    ).rejects.toThrow("OAuth callback was rejected");

    const redirectStore = new InMemoryOAuthTransactionStore();
    const redirect = await begin(redirectStore);
    await expect(
      consumeOAuthCallback(
        {
          ...oauthBinding(),
          state: redirect.state,
          redirectUri: "https://control.example/oauth/callback/attacker",
          allowedRedirectUris: [redirect.redirectUri],
          code: "code",
        },
        redirectStore,
      ),
    ).rejects.toThrow(/redirect URI/);

    await expect(
      beginOAuthAuthorization(
        {
          ...oauthBinding(),
          redirectUri: "https://control.example.evil/oauth/callback",
          allowedRedirectUris: ["https://control.example/oauth/callback"],
          returnPath: "//attacker.example",
        },
        new InMemoryOAuthTransactionStore(),
      ),
    ).rejects.toThrow();

    const providerErrorStore = new InMemoryOAuthTransactionStore();
    const providerError = await begin(providerErrorStore);
    await expect(
      consumeOAuthCallback(
        {
          ...oauthBinding(),
          state: providerError.state,
          redirectUri: providerError.redirectUri,
          allowedRedirectUris: [providerError.redirectUri],
          providerError: "access_denied",
        },
        providerErrorStore,
      ),
    ).rejects.toThrow("OAuth callback was rejected");
    await expect(
      consumeOAuthCallback(
        {
          ...oauthBinding(),
          state: providerError.state,
          redirectUri: providerError.redirectUri,
          allowedRedirectUris: [providerError.redirectUri],
          code: "late-retry",
        },
        providerErrorStore,
      ),
    ).rejects.toThrow("OAuth callback was rejected");

    await expect(
      beginOAuthAuthorization(
        {
          ...oauthBinding(),
          redirectUri: "https://control.example/oauth/callback",
          allowedRedirectUris: ["https://control.example/oauth/callback"],
          returnPath: "/%2f%2fattacker.example",
        },
        new InMemoryOAuthTransactionStore(),
      ),
    ).rejects.toThrow(/return path/);
  });
});

describe("fresh, route-bound webhook authentication", () => {
  const secret = "fixture-webhook-secret-32-bytes-long";
  const routeId = "org-a/venture-a/revenuecat/production";
  const timestamp = "2026-08-09T12:00:00.000Z";
  const body = new TextEncoder().encode('{"event":{"id":"fixture-1"}}');
  const policy = {
    routeId,
    secrets: [
      {
        secret,
        validFrom: "2026-08-01T00:00:00.000Z",
        validUntil: "2026-09-01T00:00:00.000Z",
      },
    ],
    now: new Date("2026-08-09T12:00:10.000Z"),
  } as const;

  it("authenticates exact raw bytes, route, freshness, and a bounded rotation version", () => {
    const signature = signWebhookFixture(routeId, timestamp, body, secret);
    expect(verifySignedWebhook(body, timestamp, signature, policy)).toEqual({
      routeId,
      receivedAt: "2026-08-09T12:00:10.000Z",
    });
    expect(() =>
      verifySignedWebhook(
        new TextEncoder().encode(`${new TextDecoder().decode(body)} `),
        timestamp,
        signature,
        policy,
      ),
    ).toThrow("Webhook signature is invalid");
    expect(() =>
      verifySignedWebhook(body, timestamp, signature, { ...policy, routeId: "org-b/venture-b" }),
    ).toThrow("Webhook signature is invalid");
  });

  it("rejects stale, future, oversized, and expired-secret deliveries before parsing", () => {
    const signature = signWebhookFixture(routeId, timestamp, body, secret);
    expect(() =>
      verifySignedWebhook(body, timestamp, signature, {
        ...policy,
        now: new Date("2026-08-09T12:06:00.000Z"),
      }),
    ).toThrow(/freshness/);
    expect(() => verifySignedWebhook(body, "2026-08-09T12:02:00.000Z", signature, policy)).toThrow(
      /freshness/,
    );
    expect(() =>
      verifySignedWebhook(body, timestamp, signature, { ...policy, maxBodyBytes: 4 }),
    ).toThrow(/body/);
    expect(() =>
      verifySignedWebhook(body, timestamp, signature, {
        ...policy,
        secrets: [
          {
            secret,
            validFrom: "2026-07-01T00:00:00.000Z",
            validUntil: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow("Webhook signature is invalid");
  });
});

describe("outbound provider SSRF policy", () => {
  it("permits only exact HTTPS hosts whose complete DNS answer set is public", async () => {
    await expect(
      validateProviderUrl("https://api.stripe.com/v1/products", {
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).resolves.toMatchObject({ url: expect.objectContaining({ hostname: "api.stripe.com" }) });
    await expect(
      validateProviderUrl("https://api.stripe.com.evil/v1/products", {
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(/allowlisted/);
    await expect(
      validateProviderUrl("https://api.stripe.com/v1/products", {
        resolveHost: async () => ["93.184.216.34", "169.254.169.254"],
      }),
    ).rejects.toThrow(/non-public/);
    await expect(
      validateProviderUrl("http://api.stripe.com/v1/products", {
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).rejects.toThrow(/HTTPS/);
    expect(isPublicInternetAddress("::ffff:127.0.0.1")).toBe(false);
  });
});

describe("upload boundary", () => {
  it("checks size, MIME magic, and storage-root containment", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(
      validateUpload({ bytes: png, declaredMime: "image/png", allowedMimes: ["image/png"] }),
    ).toEqual({ mime: "image/png", size: 8 });
    expect(() =>
      validateUpload({ bytes: png, declaredMime: "image/jpeg", allowedMimes: ["image/jpeg"] }),
    ).toThrow(/does not match/);
    expect(() =>
      validateUpload({
        bytes: png,
        declaredMime: "image/png",
        allowedMimes: ["image/png"],
        maxBytes: 7,
      }),
    ).toThrow(/size/);

    const root = mkdtempSync(join(tmpdir(), "vh-upload-root-"));
    directories.push(root);
    expect(safeUploadDestination(root, "tenant-a/asset.png")).toBe(
      join(root, "tenant-a", "asset.png"),
    );
    expect(() => safeUploadDestination(root, "../tenant-b/asset.png")).toThrow(/escapes/);
    expect(() => safeUploadDestination(root, "tenant-a\\..\\tenant-b")).toThrow(/invalid/);
  });
});
