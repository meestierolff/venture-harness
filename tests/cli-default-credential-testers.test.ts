import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultFounderCredentialTesters } from "@/lib/cli/default-credential-testers";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import {
  CredentialBroker,
  MemoryCredentialBackend,
  loadCredentialCatalog,
  saveCredentialCatalog,
  type CredentialBackend,
  type CredentialBackendInspection,
  type CredentialKind,
  type CredentialReference,
} from "@/lib/credentials";
import {
  FileFounderStackStore,
  parseFounderStackConnection,
  type FounderStackConnection,
  type FounderStackProviderId,
  type FounderStackRole,
} from "@/lib/founder-launch";
import type { HttpFetcher, HttpRequest, HttpResponse } from "@/lib/providers";

const temporaryDirectories: string[] = [];
const fixturePath = "fixtures/founder-stack/founder-default.json";

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "vh-default-credential-testers-"));
  temporaryDirectories.push(path);
  return path;
}

function fixture(): FounderStackConnection {
  return parseFounderStackConnection(JSON.parse(readFileSync(fixturePath, "utf8")));
}

function durableText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return durableText(path);
      return entry.isFile() ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
}

function reference(provider: string, kind: CredentialKind): CredentialReference {
  return {
    ref: `cred://${provider}/founder-default`,
    provider,
    kind,
    backend: "memory",
    scopes: [],
  };
}

class CapturingFetcher implements HttpFetcher {
  readonly requests: HttpRequest[] = [];

  constructor(
    private readonly respond: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>,
  ) {}

  async fetch(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.respond(request);
  }
}

class ReadOnlyOnePasswordBackend implements CredentialBackend {
  readonly id = "onepassword";
  readonly writable = false;

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<void> {
    throw new Error("read-only fixture backend");
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async inspect(): Promise<CredentialBackendInspection> {
    return { status: "missing", writable: false };
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("default Founder Stack credential testers", () => {
  it("uses the exact read-only auth scheme and target for every supported provider", async () => {
    const connection = fixture();
    const secrets = {
      neon: "neon-probe-secret",
      stripe: "stripe-probe-secret",
      revenuecat: "revenuecat-probe-secret",
      brevo: "brevo-probe-secret",
      google: "google-probe-secret",
      bing: "bing probe/?&secret",
    } as const;
    const fetcher = new CapturingFetcher((request) => {
      if (request.url === "https://api.stripe.com/v1/account") {
        return { status: 200, body: { id: "fixture-stripe-account", private_body: "stripe-body" } };
      }
      if (request.url === "https://api.stripe.com/v1/balance") {
        return { status: 200, body: { livemode: false, private_body: "stripe-balance" } };
      }
      if (request.url === "https://api.brevo.com/v3/account") {
        return {
          status: 200,
          body: { organization_id: "fixture-brevo-account", private_body: "brevo-body" },
        };
      }
      if (request.url.startsWith("https://analyticsadmin.googleapis.com/")) {
        return {
          status: 200,
          body: {
            accountSummaries: [{ account: "accounts/fixture-google-analytics-account" }],
            private_body: "google-body",
          },
        };
      }
      return { status: 200, body: { private_body: "provider-body" } };
    });
    const testers = createDefaultFounderCredentialTesters({ fetcher, connection });
    const kinds: Record<keyof typeof secrets, CredentialKind> = {
      neon: "api_key",
      stripe: "restricted_api_key",
      revenuecat: "restricted_api_key",
      brevo: "api_key",
      google: "oauth",
      bing: "api_key",
    };

    const results = Object.fromEntries(
      await Promise.all(
        (Object.keys(secrets) as Array<keyof typeof secrets>).map(async (provider) => [
          provider,
          await testers[provider]!(secrets[provider], reference(provider, kinds[provider])),
        ]),
      ),
    );

    expect(results).toEqual({
      neon: {
        ok: true,
        message: "neon credential passed a read-only official API probe",
      },
      stripe: {
        ok: true,
        accountId: "fixture-stripe-account",
        providerMode: "test",
        message: "stripe credential passed a read-only official API probe",
      },
      revenuecat: {
        ok: true,
        message: "revenuecat credential passed a read-only official API probe",
      },
      brevo: {
        ok: true,
        accountId: "fixture-brevo-account",
        message: "brevo credential passed a read-only official API probe",
      },
      google: {
        ok: true,
        message: "google credential passed a read-only official API probe",
      },
      bing: {
        ok: true,
        message: "bing credential passed a read-only official API probe",
      },
    });
    expect(fetcher.requests).toEqual(
      expect.arrayContaining([
        {
          method: "GET",
          url: "https://console.neon.tech/api/v2/projects?limit=1&org_id=fixture-neon-org",
          headers: { Authorization: `Bearer ${secrets.neon}` },
          sensitiveHeaders: ["Authorization"],
          sensitiveUrl: false,
        },
        {
          method: "GET",
          url: "https://api.stripe.com/v1/account",
          headers: {
            Authorization: `Basic ${Buffer.from(`${secrets.stripe}:`).toString("base64")}`,
          },
          sensitiveHeaders: ["Authorization"],
          sensitiveUrl: false,
        },
        {
          method: "GET",
          url: "https://api.stripe.com/v1/balance",
          headers: {
            Authorization: `Basic ${Buffer.from(`${secrets.stripe}:`).toString("base64")}`,
          },
          sensitiveHeaders: ["Authorization"],
          sensitiveUrl: false,
        },
        {
          method: "GET",
          url: "https://api.revenuecat.com/v2/projects/fixture-revenuecat-project/apps?limit=1",
          headers: { Authorization: `Bearer ${secrets.revenuecat}` },
          sensitiveHeaders: ["Authorization"],
          sensitiveUrl: false,
        },
        {
          method: "GET",
          url: "https://api.brevo.com/v3/account",
          headers: { "api-key": secrets.brevo },
          sensitiveHeaders: ["api-key"],
          sensitiveUrl: false,
        },
        {
          method: "GET",
          url: "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
          headers: { Authorization: `Bearer ${secrets.google}` },
          sensitiveHeaders: ["Authorization"],
          sensitiveUrl: false,
        },
        {
          method: "GET",
          url: `https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(secrets.bing)}`,
          headers: {},
          sensitiveHeaders: [],
          sensitiveUrl: true,
        },
      ]),
    );
    expect(fetcher.requests).toHaveLength(7);
    const serializedResults = JSON.stringify(results);
    for (const secret of Object.values(secrets)) expect(serializedResults).not.toContain(secret);
    expect(serializedResults).not.toContain("private_body");
    expect(serializedResults).not.toContain("provider-body");
  });

  it("returns sanitized failures without exposing response bodies, secrets, or thrown detail", async () => {
    const connection = fixture();
    const responseMarker = "private-provider-response-marker";
    const unavailableMarker = "private-network-error-marker";
    const rejectedFetcher = new CapturingFetcher(() => ({
      status: 401,
      body: { error: responseMarker },
    }));
    const rejected = createDefaultFounderCredentialTesters({
      fetcher: rejectedFetcher,
      connection,
    });
    const providers = ["neon", "stripe", "revenuecat", "brevo", "google", "bing"] as const;
    const kinds: Record<(typeof providers)[number], CredentialKind> = {
      neon: "api_key",
      stripe: "restricted_api_key",
      revenuecat: "restricted_api_key",
      brevo: "api_key",
      google: "oauth",
      bing: "api_key",
    };

    for (const provider of providers) {
      const secret = `${provider}-failure-secret`;
      const result = await rejected[provider]!(secret, reference(provider, kinds[provider]));
      expect(result).toEqual({
        ok: false,
        message: `${provider} credential probe returned HTTP 401`,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(responseMarker);
    }

    const identityFetcher = new CapturingFetcher((request) => {
      if (request.url.includes("stripe")) return { status: 200, body: { id: responseMarker } };
      if (request.url.includes("brevo")) {
        return { status: 200, body: { organization_id: responseMarker } };
      }
      return {
        status: 200,
        body: { accountSummaries: [{ account: `accounts/${responseMarker}` }] },
      };
    });
    const identity = createDefaultFounderCredentialTesters({
      fetcher: identityFetcher,
      connection,
    });
    for (const provider of ["stripe", "brevo", "google"] as const) {
      const result = await identity[provider]!(
        `${provider}-identity-secret`,
        reference(provider, kinds[provider]),
      );
      expect(result).toEqual({
        ok: false,
        message: `${provider} credential cannot access the exact Founder Stack account`,
      });
      expect(JSON.stringify(result)).not.toContain(responseMarker);
    }

    const unavailableFetcher = new CapturingFetcher(() => {
      throw new Error(unavailableMarker);
    });
    const unavailable = createDefaultFounderCredentialTesters({
      fetcher: unavailableFetcher,
      connection,
    });
    const unavailableResult = await unavailable.neon!(
      "neon-unavailable-secret",
      reference("neon", "api_key"),
    );
    expect(unavailableResult).toEqual({
      ok: false,
      message: "neon credential read-only probe was unavailable",
    });
    expect(JSON.stringify(unavailableResult)).not.toContain(unavailableMarker);

    let mismatchedFetches = 0;
    const mismatch = createDefaultFounderCredentialTesters({
      connection,
      fetcher: new CapturingFetcher(() => {
        mismatchedFetches += 1;
        return { status: 200 };
      }),
    });
    expect(
      await mismatch.stripe!("mismatched-secret", reference("neon", "restricted_api_key")),
    ).toEqual({
      ok: false,
      message: "stripe credential metadata does not match the probe",
    });
    expect(mismatchedFetches).toBe(0);
  });

  it("rejects a valid Stripe account credential unless balance read-back proves test mode", async () => {
    const connection = fixture();
    const fetcher = new CapturingFetcher((request) =>
      request.url.endsWith("/account")
        ? { status: 200, body: { id: "fixture-stripe-account" } }
        : { status: 200, body: { livemode: true } },
    );
    const tester = createDefaultFounderCredentialTesters({ fetcher, connection }).stripe!;

    await expect(
      tester("stripe-live-secret", reference("stripe", "restricted_api_key")),
    ).resolves.toEqual({ ok: false, message: "stripe credential did not prove test mode" });
    expect(fetcher.requests.map(({ url }) => url)).toEqual([
      "https://api.stripe.com/v1/account",
      "https://api.stripe.com/v1/balance",
    ]);
  });
});

const roleProviders: Readonly<
  Record<Exclude<FounderStackRole, "dns.records">, FounderStackProviderId>
> = {
  "source.repository": "github",
  "hosting.web": "vercel",
  "database.postgres": "neon",
  "commerce.web": "stripe",
  "commerce.native": "revenuecat",
  "email.transactional": "brevo",
  "growth.google": "google",
  "search.bing": "bing",
};

const providerKinds: Readonly<Record<Exclude<FounderStackProviderId, "dns">, CredentialKind>> = {
  github: "cli_session",
  vercel: "cli_session",
  neon: "api_key",
  stripe: "restricted_api_key",
  revenuecat: "restricted_api_key",
  brevo: "api_key",
  google: "oauth",
  bing: "api_key",
};

async function founderBroker(
  connection: FounderStackConnection,
  extraBackends: readonly CredentialBackend[] = [],
): Promise<{ broker: CredentialBroker; secrets: string[] }> {
  const broker = new CredentialBroker([
    new MemoryCredentialBackend(),
    new MemoryCredentialBackend("cli_session"),
    ...extraBackends,
  ]);
  const secrets: string[] = [];
  for (const [role, provider] of Object.entries(roleProviders) as Array<
    [Exclude<FounderStackRole, "dns.records">, Exclude<FounderStackProviderId, "dns">]
  >) {
    const metadata = connection.roles[role];
    const value = `${provider}-integration-secret`;
    secrets.push(value);
    await broker.store({
      ref: metadata.credentialRef!,
      provider,
      kind: providerKinds[provider],
      backend: providerKinds[provider] === "cli_session" ? "cli_session" : "memory",
      scopes: metadata.scopes,
      expiresAt: metadata.expiresAt,
      value,
    });
  }
  return { broker, secrets };
}

function successfulProbeFetcher(responseMarker: string): CapturingFetcher {
  return new CapturingFetcher((request) => {
    if (request.url === "https://api.stripe.com/v1/account") {
      return {
        status: 200,
        body: { id: "fixture-stripe-account", responseMarker },
      };
    }
    if (request.url === "https://api.stripe.com/v1/balance") {
      return { status: 200, body: { livemode: false, responseMarker } };
    }
    if (request.url === "https://api.brevo.com/v3/account") {
      return {
        status: 200,
        body: { organization_id: "fixture-brevo-account", responseMarker },
      };
    }
    if (request.url.startsWith("https://analyticsadmin.googleapis.com/")) {
      return {
        status: 200,
        body: {
          accountSummaries: [{ account: "accounts/fixture-google-analytics-account" }],
          responseMarker,
        },
      };
    }
    return { status: 200, body: { responseMarker } };
  });
}

describe("default CLI Founder Stack credential integration", () => {
  it("uses the built-in auth tester and persists only sanitized credential evidence", async () => {
    const rootDir = temporaryDirectory();
    const stateRoot = join(rootDir, "founder-stacks");
    const catalogPath = join(rootDir, "credentials.json");
    const connection = fixture();
    new FileFounderStackStore(stateRoot).save(connection);
    const { broker, secrets } = await founderBroker(connection);
    saveCredentialCatalog({ schemaVersion: 1, references: broker.list() }, catalogPath);
    const responseMarker = "auth-response-private-marker";
    const fetcher = successfulProbeFetcher(responseMarker);
    const services = createDefaultCliServices({
      rootDir,
      founderStackRoot: stateRoot,
      credentialCatalogPath: catalogPath,
      credentialBroker: broker,
      dataHttpFetcher: fetcher,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const result = (await services.auth!({ action: "test", provider: "stripe" })) as {
      tested: Array<Record<string, unknown>>;
      allPassed: boolean;
      valuesExposed: boolean;
    };

    expect(result).toMatchObject({
      tested: [
        {
          ref: "cred://stripe/founder-default",
          mode: "remote_tester",
          result: {
            ok: true,
            accountId: "fixture-stripe-account",
            providerMode: "test",
            message: "stripe credential passed a read-only official API probe",
          },
        },
      ],
      allPassed: true,
      valuesExposed: false,
    });
    expect(fetcher.requests).toHaveLength(2);
    expect(fetcher.requests[0]).toMatchObject({
      method: "GET",
      sensitiveHeaders: ["Authorization"],
    });
    expect(loadCredentialCatalog(catalogPath).references).toContainEqual(
      expect.objectContaining({
        ref: "cred://stripe/founder-default",
        testStatus: "passed",
        accountId: "fixture-stripe-account",
        providerMode: "test",
      }),
    );
    const durable = durableText(rootDir);
    for (const secret of secrets) expect(durable).not.toContain(secret);
    expect(durable).not.toContain(responseMarker);
    expect(JSON.stringify(result)).not.toContain(responseMarker);
  });

  it("persists failed auth evidence without persisting provider error bodies", async () => {
    const rootDir = temporaryDirectory();
    const stateRoot = join(rootDir, "founder-stacks");
    const catalogPath = join(rootDir, "credentials.json");
    const connection = fixture();
    new FileFounderStackStore(stateRoot).save(connection);
    const { broker, secrets } = await founderBroker(connection);
    saveCredentialCatalog({ schemaVersion: 1, references: broker.list() }, catalogPath);
    const responseMarker = "failed-auth-private-response-marker";
    const fetcher = new CapturingFetcher(() => ({
      status: 403,
      body: { error: responseMarker },
    }));
    const services = createDefaultCliServices({
      rootDir,
      founderStackRoot: stateRoot,
      credentialCatalogPath: catalogPath,
      credentialBroker: broker,
      dataHttpFetcher: fetcher,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const result = (await services.auth!({ action: "test", provider: "brevo" })) as {
      tested: Array<Record<string, unknown>>;
      allPassed: boolean;
      valuesExposed: boolean;
    };

    expect(result).toMatchObject({
      tested: [
        {
          ref: "cred://brevo/founder-default",
          mode: "remote_tester",
          result: {
            ok: false,
            message: "brevo credential probe returned HTTP 403",
          },
        },
      ],
      allPassed: false,
      valuesExposed: false,
    });
    expect(loadCredentialCatalog(catalogPath).references).toContainEqual(
      expect.objectContaining({
        ref: "cred://brevo/founder-default",
        testStatus: "failed",
      }),
    );
    const durable = durableText(rootDir);
    for (const secret of secrets) expect(durable).not.toContain(secret);
    expect(durable).not.toContain(responseMarker);
    expect(JSON.stringify(result)).not.toContain(responseMarker);
  });

  it("becomes ready from built-in GET probes while retaining credential values outside durable state", async () => {
    const rootDir = temporaryDirectory();
    const stateRoot = join(rootDir, "founder-stacks");
    const catalogPath = join(rootDir, "credentials.json");
    const connection = fixture();
    new FileFounderStackStore(stateRoot).save(connection);
    const { broker, secrets } = await founderBroker(connection);
    const responseMarker = "doctor-response-private-marker";
    const fetcher = successfulProbeFetcher(responseMarker);
    const services = createDefaultCliServices({
      rootDir,
      founderStackRoot: stateRoot,
      credentialCatalogPath: catalogPath,
      credentialBroker: broker,
      dataHttpFetcher: fetcher,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const report = (await services.stack!({
      action: "doctor",
      profileId: "founder-default",
    })) as unknown as {
      status: string;
      roles: Array<{ role: string; status: string }>;
      writableCredentialTargets: { status: string };
      externalEffects: boolean;
    };

    expect(report).toMatchObject({
      status: "ready",
      writableCredentialTargets: { status: "ready" },
      externalEffects: false,
    });
    expect(report.roles.filter(({ status }) => status === "ready")).toHaveLength(8);
    expect(fetcher.requests).toHaveLength(7);
    expect(fetcher.requests.every(({ method }) => method === "GET")).toBe(true);
    const durable = durableText(rootDir);
    for (const secret of secrets) expect(durable).not.toContain(secret);
    expect(durable).not.toContain(responseMarker);
    expect(JSON.stringify(report)).not.toContain(responseMarker);
  });

  it.each([
    ["missing backend", []],
    ["unwritable backend", [new ReadOnlyOnePasswordBackend()]],
  ] as const)("fails closed when writable capture targets use a %s", async (_label, backends) => {
    const rootDir = temporaryDirectory();
    const stateRoot = join(rootDir, "founder-stacks");
    const connection = parseFounderStackConnection({
      ...fixture(),
      writableCredentialBackend: { mode: "shared", backend: "onepassword" },
    });
    new FileFounderStackStore(stateRoot).save(connection);
    const { broker } = await founderBroker(connection, backends);
    const fetcher = successfulProbeFetcher("capture-response-private-marker");
    const services = createDefaultCliServices({
      rootDir,
      founderStackRoot: stateRoot,
      credentialCatalogPath: join(rootDir, "credentials.json"),
      credentialBroker: broker,
      dataHttpFetcher: fetcher,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    const report = (await services.stack!({
      action: "doctor",
      profileId: "founder-default",
    })) as unknown as {
      status: string;
      roles: Array<{ role: string; status: string }>;
      writableCredentialTargets: { status: string; targets: unknown[] };
      externalEffects: boolean;
    };

    expect(report).toMatchObject({
      status: "attention_required",
      writableCredentialTargets: { status: "unconfigured", targets: [] },
      externalEffects: false,
    });
    for (const role of ["database.postgres", "commerce.web", "growth.google"]) {
      expect(report.roles.find((item) => item.role === role)?.status).toBe("unconfigured");
    }
    expect(fetcher.requests).toHaveLength(7);
    expect(fetcher.requests.every(({ method }) => method === "GET")).toBe(true);
  });
});
