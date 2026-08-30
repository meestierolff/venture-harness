import { describe, expect, it, vi } from "vitest";
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
  type ProviderOperation,
  type ProviderPlanRequest,
} from "@/lib/providers";
import { providerPlanFixtures } from "./fixtures/provider/requests";

function planRequest(
  base: ProviderPlanRequest,
  capabilities: readonly string[],
): ProviderPlanRequest {
  return { ...base, capabilities, dryRun: false };
}

function emptyStripeSearch(operation: ProviderOperation) {
  if (!operation.action.endsWith(".search_before_create")) return null;
  return {
    status: "succeeded" as const,
    message: "Fixture search found no deterministic resource",
    output: { data: [], has_more: false },
    effectOutcome: "confirmed_no_write" as const,
  };
}

function stripeCredentialPreflightResponse(
  request: HttpRequest,
  accountId = "acct_venture_example",
) {
  if (request.url === "https://api.stripe.com/v1/account") {
    return { status: 200, body: { id: accountId } };
  }
  if (request.url === "https://api.stripe.com/v1/balance") {
    return { status: 200, body: { livemode: false } };
  }
  return null;
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

  it("classifies read-back outages as unavailable and successful contradictions as mismatched", async () => {
    const operation: ProviderOperation = {
      id: "github.fixture.readback",
      provider: "github",
      capability: "repository",
      action: "repository.create_from_source",
      title: "Fixture read-back classification",
      transport: "cli",
      environment: "preview",
      riskClass: "high",
      effectClass: "reversible_external",
      reversibility: "reversible",
      idempotencyKey: "github:fixture:readback",
      dependsOn: [],
      command: { binary: "gh", args: ["repo", "create", "fixture"] },
      readBack: {
        transport: "cli",
        command: { binary: "gh", args: ["repo", "view", "fixture", "--json", "name"] },
        description: "fixture repository matches",
        assertions: [{ path: "name", operator: "equals", expected: "fixture" }],
      },
      verification: { strategy: "read_back", description: "verify fixture repository" },
    };
    const failedCommand = new CommandProviderTransport({
      runner: {
        async run() {
          return { exitCode: 1, stdout: "", stderr: "fixture provider unavailable" };
        },
      },
    });
    const execution = {
      status: "succeeded" as const,
      message: "fixture apply accepted",
      effectOutcome: "confirmed_write" as const,
    };

    await expect(
      failedCommand.readBack(operation, execution, { redactor: new Redactor() }),
    ).resolves.toMatchObject({ status: "unavailable" });

    const contradictoryHttp = new HttpProviderTransport({
      async fetch() {
        return { status: 200, body: { name: "different" } };
      },
    });
    const httpOperation: ProviderOperation = {
      ...operation,
      transport: "http",
      http: { method: "POST", url: "https://api.example.test/repositories" },
      command: undefined,
      readBack: {
        transport: "http",
        http: { method: "GET", url: "https://api.example.test/repositories/fixture" },
        description: "fixture repository matches",
        assertions: [{ path: "name", operator: "equals", expected: "fixture" }],
      },
    };
    await expect(
      contradictoryHttp.readBack(httpOperation, execution, { redactor: new Redactor() }),
    ).resolves.toMatchObject({ status: "mismatched" });

    const unavailableHttp = new HttpProviderTransport({
      async fetch() {
        return { status: 503, body: { error: "fixture outage" } };
      },
    });
    await expect(
      unavailableHttp.readBack(httpOperation, execution, { redactor: new Redactor() }),
    ).resolves.toMatchObject({ status: "unavailable" });
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
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
    const transport = new MockProviderTransport(
      "http",
      async (operation) =>
        emptyStripeSearch(operation) ?? {
          status: "succeeded",
          message: "Created",
          output: { id: "prod_example" },
        },
    );
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"]));
    const ledger = new InMemoryIdempotencyLedger();
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { http: transport },
      redactor: new Redactor(),
      idempotencyLedger: ledger,
      fixtureMode: true,
    };

    const first = await adapter.apply(plan, context);
    const second = await adapter.apply(plan, context);
    expect(first.operations[0].reused).toBe(false);
    expect(second.operations[0].reused).toBe(true);
    expect(transport.calls).toHaveLength(2);
  });

  it("reuses one exact Stripe search match and fails closed on deterministic drift", async () => {
    const exact = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: "Fixture search completed",
      output: {
        data: [
          {
            id: "prod_fixture_existing",
            name: "Example plan",
            description: "Illustrative fixture product",
            active: true,
            livemode: false,
            metadata: {
              venture_harness_venture: "venture-example",
              venture_harness_resource: "product",
              venture_harness_lookup_key: "vh:venture-example:product:v1",
            },
          },
        ],
        has_more: false,
      },
      effectOutcome: "confirmed_no_write",
    }));
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"]));
    const exactReport = await adapter.apply(plan, {
      authorization: "approved",
      transports: { http: exact },
      redactor: new Redactor(),
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    });
    expect(exactReport.operations[0]).toMatchObject({
      reused: true,
      result: {
        status: "succeeded",
        output: { id: "prod_fixture_existing" },
        effectOutcome: "confirmed_no_write",
      },
    });
    expect(exact.calls).toHaveLength(1);

    const drift = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: "Fixture search completed",
      output: {
        data: [
          {
            id: "prod_fixture_existing",
            name: "Wrong venture product",
            description: "Illustrative fixture product",
            active: true,
            livemode: false,
            metadata: {
              venture_harness_venture: "venture-example",
              venture_harness_lookup_key: "vh:venture-example:product:v1",
            },
          },
        ],
        has_more: false,
      },
    }));
    const driftReport = await adapter.apply(plan, {
      authorization: "approved",
      transports: { http: drift },
      redactor: new Redactor(),
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    });
    expect(driftReport.operations[0]).toMatchObject({
      reused: false,
      result: {
        status: "failed",
        providerCode: "existing_resource_conflict",
        effectOutcome: "confirmed_no_write",
      },
    });
    expect(drift.calls).toHaveLength(1);
  });

  it("refuses to reuse a recurring Stripe price for a reviewed one-time offer", async () => {
    const { recurringInterval, ...baseInputs } = providerPlanFixtures.stripe.inputs;
    expect(recurringInterval).toBe("month");
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan({
      ...providerPlanFixtures.stripe,
      capabilities: ["price"],
      inputs: { ...baseInputs, productId: "prod_one_time" },
      dryRun: false,
    });
    const lookupKey = "vh_venture_example_eur_1900_once";
    const transport = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: "Fixture search completed",
      output: {
        data: [
          {
            id: "price_recurring_conflict",
            product: "prod_one_time",
            currency: "eur",
            unit_amount: 1900,
            active: true,
            livemode: false,
            lookup_key: lookupKey,
            type: "recurring",
            recurring: { interval: "month" },
            metadata: {
              venture_harness_venture: "venture-example",
              venture_harness_resource: "price",
              venture_harness_lookup_key: lookupKey,
            },
          },
        ],
        has_more: false,
      },
      effectOutcome: "confirmed_no_write",
    }));

    const report = await adapter.apply(plan, {
      authorization: "approved",
      transports: { http: transport },
      redactor: new Redactor(),
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    });

    expect(report.operations[0].result).toMatchObject({
      status: "failed",
      providerCode: "existing_resource_conflict",
      effectOutcome: "confirmed_no_write",
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("fails closed when Stripe lookup is ambiguous or pagination makes absence inconclusive", async () => {
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"]));
    const exactCandidate = {
      id: "prod_fixture_existing",
      name: "Example plan",
      description: "Illustrative fixture product",
      active: true,
      livemode: false,
      metadata: {
        venture_harness_venture: "venture-example",
        venture_harness_resource: "product",
        venture_harness_lookup_key: "vh:venture-example:product:v1",
      },
    };
    const cases = [
      {
        output: {
          data: [
            exactCandidate,
            {
              ...exactCandidate,
              id: "prod_fixture_duplicate",
              metadata: { ...exactCandidate.metadata },
            },
          ],
        },
        providerCode: "existing_resource_ambiguous",
      },
      {
        output: { data: [], has_more: true },
        providerCode: "existing_resource_search_incomplete",
      },
    ] as const;

    for (const fixture of cases) {
      const transport = new MockProviderTransport("http", async () => ({
        status: "succeeded",
        message: "Fixture search completed",
        output: fixture.output,
        effectOutcome: "confirmed_no_write",
      }));
      const report = await adapter.apply(plan, {
        authorization: "approved",
        transports: { http: transport },
        redactor: new Redactor(),
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
      });
      expect(report.operations[0].result).toMatchObject({
        status: "failed",
        providerCode: fixture.providerCode,
        effectOutcome: "confirmed_no_write",
      });
      expect(transport.calls).toHaveLength(1);
    }
  });

  it("materializes a declared dependency output before creating an exact Stripe price", async () => {
    const transport = new MockProviderTransport(
      "http",
      async (operation) =>
        emptyStripeSearch(operation) ?? {
          status: "succeeded",
          message: "Fixture operation completed",
          output:
            operation.capability === "product"
              ? { id: "prod_from_verified_create" }
              : { id: "price_from_verified_create" },
          verified: true,
        },
    );
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan({
      environment: "sandbox",
      capabilities: ["product", "price"],
      credentialRef: "cred://stripe/test",
      inputs: {
        ventureSlug: "reviewed-product",
        stripeAccountId: "acct_reviewed_product",
        stripeMode: "test",
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
      fixtureMode: true,
    });

    expect(report.state).toBe("applied");
    expect(transport.calls[3].http?.body).toMatchObject({
      product: "prod_from_verified_create",
      currency: "eur",
      unit_amount: 1995,
    });
    expect(transport.calls[3].readBack?.assertions).toContainEqual({
      path: "product",
      operator: "equals",
      expected: "prod_from_verified_create",
    });
    expect(JSON.stringify(report)).not.toContain("{dependency.");
  });

  it("captures a Stripe webhook secret into a writable credential ref before redacting evidence", async () => {
    const rawSecret = "whsec_fixture_capture_boundary_123456789";
    const requests: HttpRequest[] = [];
    const fetcher: HttpFetcher = {
      async fetch(request) {
        requests.push(request);
        const preflight = stripeCredentialPreflightResponse(request, "acct_webhook_capture");
        if (preflight) return preflight;
        return request.url.includes("webhook_endpoints?limit=")
          ? { status: 200, body: { data: [], has_more: false } }
          : request.method === "POST"
            ? {
                status: 201,
                body: {
                  id: "we_fixture",
                  url: "https://example.test/api/stripe/webhook",
                  enabled_events: ["checkout.session.completed"],
                  status: "enabled",
                  livemode: false,
                  metadata: {
                    venture_harness_lookup_key: "vh:webhook-capture:webhook:v1",
                    venture_harness_venture: "webhook-capture",
                    venture_harness_resource: "webhook",
                  },
                  secret: rawSecret,
                },
              }
            : {
                status: 200,
                body: {
                  id: "we_fixture",
                  url: "https://example.test/api/stripe/webhook",
                  enabled_events: ["checkout.session.completed"],
                  status: "enabled",
                  livemode: false,
                  metadata: {
                    venture_harness_lookup_key: "vh:webhook-capture:webhook:v1",
                    venture_harness_venture: "webhook-capture",
                    venture_harness_resource: "webhook",
                  },
                },
              };
      },
    };
    const memory = new MemoryCredentialBackend();
    const broker = new CredentialBroker([memory]);
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "api_key",
      backend: "memory",
      value: "sk_test_fixture_primary_123456789",
    });
    broker.register({
      ref: "cred://stripe/webhook-secret",
      provider: "stripe",
      kind: "ci_secret",
      backend: "memory",
    });
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan({
      environment: "sandbox",
      capabilities: ["webhook"],
      credentialRef: "cred://stripe/primary",
      inputs: {
        ventureSlug: "webhook-capture",
        stripeAccountId: "acct_webhook_capture",
        stripeMode: "test",
        webhookUrl: "https://example.test/api/stripe/webhook",
        enabledEvents: ["checkout.session.completed"],
        webhookSecretCredentialRef: "cred://stripe/webhook-secret",
      },
      dryRun: false,
    });
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { http: new HttpProviderTransport(fetcher) },
      credentials: broker,
      redactor: broker.redactor,
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    };

    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);
    const captured = await broker.withSecret("cred://stripe/webhook-secret", (value) => value);

    expect(captured).toBe(rawSecret);
    expect(requests).toHaveLength(5);
    expect(readBack.results[0].status).toBe("matched");
    expect(JSON.stringify({ report, readBack })).not.toContain(rawSecret);
    expect(JSON.stringify(report)).toContain("[REDACTED]");
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
      fixtureMode: true,
    };

    const first = await adapter.apply(plan, context);
    const second = await adapter.apply(plan, context);
    expect(first.operations[0].reused).toBe(false);
    expect(second.operations[0].reused).toBe(false);
    expect(transport.calls).toHaveLength(2);
  });

  it("reports a partial provider outage as degraded and keeps evidence per operation", async () => {
    let count = 0;
    const transport = new MockProviderTransport("http", async (operation) => {
      const search = emptyStripeSearch(operation);
      if (search) return search;
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
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
    const transport = new MockProviderTransport(
      "http",
      async (operation) =>
        emptyStripeSearch(operation) ?? {
          status: "succeeded",
          message: `Bearer ${raw}`,
          output: { authorization: raw, diagnostic: `token=${raw}` },
        },
    );
    const adapter = getProviderAdapter("stripe");
    const report = await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"])),
      {
        authorization: "approved",
        transports: { http: transport },
        redactor: broker.redactor,
        credentials: broker,
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    });
    expect(called).toBe(false);
    expect(report.operations[0].result).toMatchObject({
      status: "failed",
      providerCode: "shell_binary_forbidden",
      retryable: false,
    });
  });

  it.each([
    ["neonctl", "NODE_OPTIONS"],
    ["node", "NEON_API_KEY"],
    ["eas", "HTTP_PROXY"],
  ])(
    "rejects the %s/%s auth environment pair before broker access",
    async (binary, environmentName) => {
      const memory = new MemoryCredentialBackend();
      const broker = new CredentialBroker([memory]);
      await broker.store({
        ref: "cred://neon/control-plane",
        provider: "neon",
        kind: "api_key",
        backend: "memory",
        value: "fixture-provider-auth-value",
      });
      const brokerRead = vi.spyOn(memory, "get");
      const runner: CommandRunner = {
        run: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })),
      };
      const operation: ProviderOperation = {
        id: "neon.fixture.environment-boundary",
        provider: "neon",
        capability: "project",
        action: "project.create",
        title: "Fixture provider environment boundary",
        transport: "cli",
        environment: "production",
        riskClass: "critical",
        effectClass: "reversible_external",
        reversibility: "conditionally_reversible",
        idempotencyKey: "neon:fixture:environment-boundary",
        dependsOn: [],
        credentialRef: "cred://neon/control-plane",
        command: {
          binary,
          args: ["projects", "create"],
          authEnvironment: {
            name: environmentName,
            credentialRef: "cred://neon/control-plane",
          },
        },
        verification: { strategy: "read_back", description: "fixture only" },
      };

      await expect(
        new CommandProviderTransport({ runner }).execute(operation, {
          credentials: broker,
          redactor: broker.redactor,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        providerCode: "terminal_validation",
        effectOutcome: "confirmed_no_write",
      });
      expect(brokerRead).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    },
  );

  it("injects HTTP auth at the transport boundary and redacts echoed auth", async () => {
    const requests: HttpRequest[] = [];
    const fetcher: HttpFetcher = {
      async fetch(request) {
        requests.push(request);
        const preflight = stripeCredentialPreflightResponse(request);
        if (preflight) return preflight;
        if (request.url.includes("/products/search")) {
          return { status: 200, body: { data: [], has_more: false } };
        }
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
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
      },
    );

    const expectedAuthorization = `Basic ${Buffer.from(`${raw}:`).toString("base64")}`;
    expect(requests.every(({ headers }) => headers.Authorization === expectedAuthorization)).toBe(
      true,
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
        const preflight = stripeCredentialPreflightResponse(request);
        if (preflight) return preflight;
        if (request.url.includes("/products/search")) {
          return { status: 200, body: { data: [], has_more: false } };
        }
        if (request.method === "POST") {
          return { status: 201, body: { id: "prod_readback" } };
        }
        return {
          status: 200,
          body: {
            id: "prod_readback",
            name: "Example plan",
            active: true,
            livemode: false,
            metadata: {
              venture_harness_lookup_key: "vh:venture-example:product:v1",
              venture_harness_venture: "venture-example",
              venture_harness_resource: "product",
            },
          },
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    };
    const report = await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"])),
      context,
    );
    const readBack = await adapter.readBack(report, context);
    expect(readBack.results[0].status).toBe("matched");
    expect(adapter.verify(report, readBack).state).toBe("verified");
  });

  it.each([
    {
      label: "a different account",
      account: { id: "acct_other" },
      balance: { livemode: false },
    },
    {
      label: "live mode",
      account: { id: "acct_venture_example" },
      balance: { livemode: true },
    },
  ])("blocks a Stripe mutation when the exact backend secret proves $label", async (proof) => {
    const requests: HttpRequest[] = [];
    const rotatedSecret = ["sk", "live", "rotated", "after", "attestation"].join("_");
    const fetcher: HttpFetcher = {
      async fetch(request) {
        requests.push(request);
        if (request.url.includes("/products/search")) {
          return { status: 200, body: { data: [], has_more: false } };
        }
        if (request.url === "https://api.stripe.com/v1/account") {
          return { status: 200, body: proof.account };
        }
        if (request.url === "https://api.stripe.com/v1/balance") {
          return { status: 200, body: proof.balance };
        }
        return { status: 201, body: { id: "must_not_be_created" } };
      },
    };
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      accountId: "acct_venture_example",
      testedAt: "2026-08-12T10:00:00.000Z",
      testStatus: "passed",
      providerMode: "test",
      value: rotatedSecret,
    });
    const adapter = getProviderAdapter("stripe");

    const report = await adapter.apply(
      adapter.plan(planRequest(providerPlanFixtures.stripe, ["product"])),
      {
        authorization: "approved",
        transports: { http: new HttpProviderTransport(fetcher) },
        credentials: broker,
        redactor: broker.redactor,
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
      },
    );

    expect(report.operations[0].result).toMatchObject({
      status: "failed",
      providerCode: "credential_preflight_mismatch",
      effectOutcome: "confirmed_no_write",
    });
    expect(requests.some(({ method }) => method === "POST")).toBe(false);
    expect(JSON.stringify(report)).not.toContain(rotatedSecret);
  });

  it("never sends a provider credential to a cross-origin preflight", async () => {
    const requests: HttpRequest[] = [];
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      value: "fixture-cross-origin-preflight-secret",
    });
    const operation = getProviderAdapter("stripe").plan(
      planRequest(providerPlanFixtures.stripe, ["product"]),
    ).operations[0]!;
    const result = await new HttpProviderTransport({
      async fetch(request) {
        requests.push(request);
        return { status: 200, body: { id: "acct_venture_example" } };
      },
    }).execute(
      {
        ...operation,
        http: {
          ...operation.http!,
          credentialPreflight: {
            requests: [
              {
                url: "https://untrusted.example.test/collect",
                assertions: [{ path: "id", operator: "equals", expected: "acct_venture_example" }],
              },
            ],
          },
        },
      },
      { credentials: broker, redactor: broker.redactor },
    );

    expect(result).toMatchObject({
      status: "failed",
      providerCode: "credential_preflight_invalid",
      effectOutcome: "confirmed_no_write",
    });
    expect(requests).toHaveLength(0);
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
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
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
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
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
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
