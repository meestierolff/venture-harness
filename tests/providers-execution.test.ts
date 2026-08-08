import { describe, expect, it } from "vitest";
import {
  CredentialBroker,
  MemoryCredentialBackend,
  Redactor,
  type CommandInvocation,
  type CommandRunner,
} from "@/lib/credentials";
import {
  classifyProviderFailure,
  CommandProviderTransport,
  getProviderAdapter,
  HttpProviderTransport,
  InMemoryIdempotencyLedger,
  MockProviderTransport,
  type HttpFetcher,
  type HttpRequest,
  type ProviderExecutionContext,
  type ProviderPlanRequest,
} from "@/lib/providers";
import { providerPlanFixtures } from "./fixtures/provider/requests";

function planRequest(
  base: ProviderPlanRequest,
  capabilities: readonly string[],
): ProviderPlanRequest {
  return { ...base, capabilities, dryRun: false };
}

describe("provider execution", () => {
  it("never invokes a transport during dry-run", async () => {
    const transport = new MockProviderTransport("cli");
    const adapter = getProviderAdapter("github");
    const plan = adapter.plan({
      ...providerPlanFixtures.github,
      capabilities: ["repository"],
      dryRun: true,
    });
    const report = await adapter.apply(plan, {
      authorization: "approved",
      transports: { cli: transport },
      redactor: new Redactor(),
    });

    expect(report.state).toBe("planned");
    expect(report.operations[0].result.status).toBe("skipped");
    expect(transport.calls).toHaveLength(0);
  });

  it("requires explicit approval even when a plan was created for apply", async () => {
    const transport = new MockProviderTransport("cli");
    const adapter = getProviderAdapter("github");
    const plan = adapter.plan(planRequest(providerPlanFixtures.github, ["repository"]));
    const report = await adapter.apply(plan, {
      authorization: "dry_run",
      transports: { cli: transport },
      redactor: new Redactor(),
    });
    expect(report.state).toBe("planned");
    expect(transport.calls).toHaveLength(0);
  });

  it("applies, reads back, and verifies through injected transports", async () => {
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "Mock GitHub repository created",
      output: { id: "repo-example" },
      verified: true,
    }));
    const adapter = getProviderAdapter("github");
    const plan = adapter.plan(planRequest(providerPlanFixtures.github, ["repository"]));
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: transport },
      redactor: new Redactor(),
    };
    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);
    const verification = adapter.verify(report, readBack);

    expect(report.state).toBe("applied");
    expect(transport.calls).toHaveLength(1);
    expect(readBack.results[0].status).toBe("matched");
    expect(verification.state).toBe("verified");
  });

  it("reuses a successful result from the idempotency ledger", async () => {
    const transport = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: "Created",
      output: { id: "prod_example" },
    }));
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"]));
    const ledger = new InMemoryIdempotencyLedger();
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { http: transport },
      redactor: new Redactor(),
      idempotencyLedger: ledger,
    };

    const first = await adapter.apply(plan, context);
    const second = await adapter.apply(plan, context);
    expect(first.operations[0].reused).toBe(false);
    expect(second.operations[0].reused).toBe(true);
    expect(transport.calls).toHaveLength(1);
  });

  it("materializes a declared dependency output before creating an exact Stripe price", async () => {
    const transport = new MockProviderTransport("http", async (operation) => ({
      status: "succeeded",
      message: "Fixture operation completed",
      output:
        operation.capability === "product"
          ? { id: "prod_from_verified_create" }
          : { id: "price_from_verified_create" },
      verified: true,
    }));
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan({
      environment: "sandbox",
      capabilities: ["product", "price"],
      credentialRef: "cred://stripe/test",
      inputs: {
        productName: "Reviewed product",
        productId: "{dependency.product.id}",
        currency: "eur",
        unitAmount: 1995,
        recurringInterval: "month",
      },
      dryRun: false,
    });
    const report = await adapter.apply(plan, {
      authorization: "approved",
      transports: { http: transport },
      redactor: new Redactor(),
      idempotencyLedger: new InMemoryIdempotencyLedger(),
    });

    expect(report.state).toBe("applied");
    expect(transport.calls[1].http?.body).toMatchObject({
      product: "prod_from_verified_create",
      currency: "eur",
      unit_amount: 1995,
    });
    expect(transport.calls[1].readBack?.assertions).toContainEqual({
      path: "product",
      operator: "equals",
      expected: "prod_from_verified_create",
    });
    expect(JSON.stringify(report)).not.toContain("{dependency.");
  });

  it("reconciles mutable local source again instead of trusting a stale ledger entry", async () => {
    const transport = new MockProviderTransport("cli", async () => ({
      status: "succeeded",
      message: "Local source reconciled with the remote branch",
      output: {
        branch: "main",
        commitOid: "a".repeat(40),
        treeOid: "b".repeat(40),
      },
    }));
    const adapter = getProviderAdapter("github");
    const plan = adapter.plan(planRequest(providerPlanFixtures.github, ["repository"]));
    const ledger = new InMemoryIdempotencyLedger();
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: transport },
      redactor: new Redactor(),
      idempotencyLedger: ledger,
    };

    const first = await adapter.apply(plan, context);
    const second = await adapter.apply(plan, context);
    expect(first.operations[0].reused).toBe(false);
    expect(second.operations[0].reused).toBe(false);
    expect(transport.calls).toHaveLength(2);
  });

  it("reports a partial provider outage as degraded and keeps evidence per operation", async () => {
    let count = 0;
    const transport = new MockProviderTransport("http", async () => {
      count += 1;
      return count === 1
        ? {
            status: "succeeded",
            message: "Product created",
            output: { id: "prod_example" },
          }
        : {
            status: "failed",
            statusCode: 503,
            providerCode: "retryable_outage",
            message: "Provider returned HTTP 503",
            retryable: true,
          };
    });
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan(planRequest(providerPlanFixtures.stripe, ["product", "price"]));
    const report = await adapter.apply(plan, {
      authorization: "approved",
      transports: { http: transport },
      redactor: new Redactor(),
    });

    expect(report.state).toBe("degraded");
    expect(report.operations.map(({ result }) => result.status)).toEqual(["succeeded", "failed"]);
    expect(report.operations[1].result).toMatchObject({
      retryable: true,
      providerCode: "retryable_outage",
    });
  });

  it("redacts secrets from transport messages and output", async () => {
    const memory = new MemoryCredentialBackend();
    const broker = new CredentialBroker([memory]);
    const raw = "sk_test_never_report";
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      value: raw,
    });
    const transport = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: `Bearer ${raw}`,
      output: { authorization: raw, diagnostic: `token=${raw}` },
    }));
    const adapter = getProviderAdapter("stripe");
    const report = await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"])),
      {
        authorization: "approved",
        transports: { http: transport },
        redactor: broker.redactor,
        credentials: broker,
      },
    );
    expect(JSON.stringify(report)).not.toContain(raw);
    expect(report.operations[0].result).toMatchObject({
      message: "Bearer [REDACTED]",
      output: {
        authorization: "[REDACTED]",
        diagnostic: "token=[REDACTED]",
      },
    });
  });

  it("passes command payload secrets only through stdin, never shell interpolation", async () => {
    const invocations: CommandInvocation[] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    };
    const memory = new MemoryCredentialBackend();
    const broker = new CredentialBroker([memory]);
    const raw = "actions-secret-never-in-argv";
    await broker.store({
      ref: "cred://github/actions-secret-payload",
      provider: "github",
      kind: "ci_secret",
      backend: "memory",
      value: raw,
    });
    const adapter = getProviderAdapter("github");
    const plan = adapter.plan(planRequest(providerPlanFixtures.github, ["actions_secret"]));
    await adapter.apply(plan, {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      credentials: broker,
      redactor: broker.redactor,
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0].command).toBe("gh");
    expect(invocations[0].args).not.toContain(raw);
    expect(invocations[0].stdin).toBe(raw);
    expect(invocations[0].sensitiveStdin).toBe(true);
  });

  it("rejects shell binaries at the command transport boundary", async () => {
    let called = false;
    const runner: CommandRunner = {
      async run() {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const adapter = getProviderAdapter("github");
    const valid = adapter.plan(planRequest(providerPlanFixtures.github, ["repository"]));
    const baseOperation = valid.operations[0];
    const plan = {
      ...valid,
      operations: [
        {
          ...baseOperation,
          command: { ...baseOperation.command!, binary: "sh" },
        },
      ],
    };
    const report = await adapter.apply(plan, {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      redactor: new Redactor(),
    });
    expect(called).toBe(false);
    expect(report.operations[0].result).toMatchObject({
      status: "failed",
      providerCode: "shell_binary_forbidden",
      retryable: false,
    });
  });

  it("injects HTTP auth at the transport boundary and redacts echoed auth", async () => {
    const requests: HttpRequest[] = [];
    const fetcher: HttpFetcher = {
      async fetch(request) {
        requests.push(request);
        return {
          status: 200,
          body: { id: "prod_example", authorization: request.headers.Authorization },
        };
      },
    };
    const memory = new MemoryCredentialBackend();
    const broker = new CredentialBroker([memory]);
    const raw = "sk_test_http_boundary";
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      value: raw,
    });
    const adapter = getProviderAdapter("stripe");
    const report = await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"])),
      {
        authorization: "approved",
        transports: { http: new HttpProviderTransport(fetcher) },
        credentials: broker,
        redactor: broker.redactor,
      },
    );

    expect(requests[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(`${raw}:`).toString("base64")}`,
    );
    expect(requests[0].sensitiveHeaders).toContain("authorization");
    expect(JSON.stringify(report)).not.toContain(raw);
    expect(report.operations[0].result.output).toMatchObject({
      authorization: "[REDACTED]",
    });
  });

  it("verifies an HTTP operation only when declared read-back assertions match", async () => {
    const fetcher: HttpFetcher = {
      async fetch(request) {
        if (request.method === "POST") {
          return { status: 201, body: { id: "prod_readback" } };
        }
        return {
          status: 200,
          body: { id: "prod_readback", name: "Example plan", active: true },
        };
      },
    };
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      value: "sk_test_assertion",
    });
    const adapter = getProviderAdapter("stripe");
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { http: new HttpProviderTransport(fetcher) },
      credentials: broker,
      redactor: broker.redactor,
    };
    const report = await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"])),
      context,
    );
    const readBack = await adapter.readBack(report, context);
    expect(readBack.results[0].status).toBe("matched");
    expect(adapter.verify(report, readBack).state).toBe("verified");
  });

  it("uses structured Vercel deploy output to inspect the exact deployment id and READY state", async () => {
    const invocations: CommandInvocation[] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return invocation.args[0] === "deploy"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                id: "dpl_exact",
                url: "https://venture-example.vercel.app",
                readyState: "READY",
              }),
              stderr: "",
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({ id: "dpl_exact", readyState: "READY" }),
              stderr: "",
            };
      },
    };
    const adapter = getProviderAdapter("vercel");
    const plan = adapter.plan(planRequest(providerPlanFixtures.vercel, ["deployment"]));
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      redactor: new Redactor(),
    };

    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);

    expect(invocations).toHaveLength(2);
    expect(invocations[0].args).toContain("--format=json");
    expect(invocations[1].args).toEqual(
      expect.arrayContaining(["inspect", "https://venture-example.vercel.app", "--format=json"]),
    );
    expect(readBack.results[0].status).toBe("matched");
    expect(adapter.verify(report, readBack).state).toBe("verified");
  });

  it("does not invoke Vercel read-back when a required apply result identifier is absent", async () => {
    const invocations: CommandInvocation[] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    };
    const adapter = getProviderAdapter("vercel");
    const plan = adapter.plan(planRequest(providerPlanFixtures.vercel, ["deployment"]));
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      redactor: new Redactor(),
    };

    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);

    expect(invocations).toHaveLength(1);
    expect(readBack.results[0]).toMatchObject({
      status: "unavailable",
      message: expect.stringContaining("unambiguous value"),
    });
    expect(adapter.verify(report, readBack).state).toBe("unavailable");
  });

  it("resolves a singleton EAS build result and verifies concrete build fields", async () => {
    const invocations: CommandInvocation[] = [];
    const runner: CommandRunner = {
      async run(invocation) {
        invocations.push(invocation);
        const build = {
          id: "eas-build-exact",
          platform: "IOS",
          status: "FINISHED",
          buildProfile: "production",
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify(invocation.args[0] === "build" ? [build] : build),
          stderr: "",
        };
      },
    };
    const backend = new MemoryCredentialBackend();
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://eas/primary",
      provider: "eas",
      kind: "api_key",
      backend: "memory",
      value: "eas-token-for-fixture",
    });
    const adapter = getProviderAdapter("eas");
    const plan = adapter.plan(planRequest(providerPlanFixtures.eas, ["ios_build"]));
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      credentials: broker,
      redactor: broker.redactor,
    };

    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);

    expect(invocations[1].args).toContain("eas-build-exact");
    expect(readBack.results[0].status).toBe("matched");
    expect(adapter.verify(report, readBack).state).toBe("verified");
  });

  it("requires an injected JWT signer and never sends a private key as bearer auth", async () => {
    const requests: HttpRequest[] = [];
    const fetcher: HttpFetcher = {
      async fetch(request) {
        requests.push(request);
        return { status: 201, body: { data: { id: "group-example" } } };
      },
    };
    const memory = new MemoryCredentialBackend();
    const broker = new CredentialBroker([memory]);
    const privateKey = ["-----BEGIN ", "PRIVATE KEY-----", "private-material"].join("");
    await broker.store({
      ref: "cred://app_store_connect/primary",
      provider: "app_store_connect",
      kind: "jwt_private_key",
      backend: "memory",
      value: privateKey,
    });
    const signerInputs: string[] = [];
    const transport = new HttpProviderTransport(
      fetcher,
      async () => ({ available: true }),
      async (key) => {
        signerInputs.push(key);
        return "signed-jwt-token";
      },
    );
    const adapter = getProviderAdapter("app_store_connect");
    await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.app_store_connect, ["testflight_group"])),
      {
        authorization: "approved",
        transports: { http: transport },
        credentials: broker,
        redactor: broker.redactor,
      },
    );

    expect(signerInputs).toEqual([privateKey]);
    expect(requests[0].headers.Authorization).toBe("Bearer signed-jwt-token");
    expect(requests[0].headers.Authorization).not.toContain("PRIVATE KEY");
  });

  it("keeps manual provider operations waiting for human evidence", async () => {
    const adapter = getProviderAdapter("dns");
    const plan = adapter.plan(planRequest(providerPlanFixtures.dns, ["record"]));
    const report = await adapter.apply(plan, {
      authorization: "approved",
      transports: {},
      redactor: new Redactor(),
    });
    expect(report.state).toBe("waiting_manual");
    expect(report.operations[0].result.status).toBe("waiting_manual");
    const readBack = await adapter.readBack(report, {
      authorization: "approved",
      transports: {},
      redactor: new Redactor(),
    });
    expect(adapter.verify(report, readBack).state).toBe("pending");
  });
});

describe("provider retry classification", () => {
  it.each([
    [429, true, "retryable_rate_limit"],
    [503, true, "retryable_outage"],
    [401, false, "terminal_auth"],
    [422, false, "terminal_validation"],
    [409, false, "terminal_conflict"],
  ] as const)("classifies HTTP %s", (statusCode, retryable, classification) => {
    expect(classifyProviderFailure({ statusCode })).toMatchObject({
      retryable,
      classification,
    });
  });

  it("honors numeric Retry-After for rate limits", () => {
    expect(classifyProviderFailure({ statusCode: 429, retryAfter: "3" })).toMatchObject({
      retryable: true,
      suggestedDelayMs: 3000,
    });
  });

  it("classifies a network failure separately", () => {
    expect(classifyProviderFailure({ networkError: true })).toEqual({
      retryable: true,
      classification: "retryable_network",
    });
  });
});
