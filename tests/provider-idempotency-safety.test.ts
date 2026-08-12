import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CredentialBroker, MemoryCredentialBackend, Redactor } from "@/lib/credentials";
import {
  getProviderAdapter,
  InMemoryIdempotencyLedger,
  MockProviderTransport,
  type ProviderExecutionContext,
  type ProviderOperation,
  type ProviderPlan,
} from "@/lib/providers";
import { FileProviderIdempotencyLedger } from "@/lib/runtime";
import { providerPlanFixtures } from "./fixtures/provider/requests";

function fixturePlan(): ProviderPlan {
  return getProviderAdapter("stripe").plan({
    ...providerPlanFixtures.stripe,
    capabilities: ["product"],
    dryRun: false,
  });
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

function context(path: string, transport: MockProviderTransport): ProviderExecutionContext {
  return {
    authorization: "approved",
    transports: { http: transport },
    redactor: new Redactor(),
    idempotencyLedger: new FileProviderIdempotencyLedger(path),
  };
}

describe("provider write idempotency safety", () => {
  it("persists one opaque ledger generation and fails closed on later corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-ledger-identity-"));
    const ledgerPath = join(directory, "ledger.json");
    const first = new FileProviderIdempotencyLedger(ledgerPath);
    const identity = await first.identity();

    expect(identity).toMatch(/^ledger_[a-f0-9]{64}$/u);
    expect(await new FileProviderIdempotencyLedger(ledgerPath).identity()).toBe(identity);

    await writeFile(ledgerPath, "{corrupt-json\n", "utf8");
    await expect(new FileProviderIdempotencyLedger(ledgerPath).identity()).rejects.toThrow(
      /corrupt JSON/u,
    );
    expect(await readFile(ledgerPath, "utf8")).toBe("{corrupt-json\n");
  });

  it("fails closed before transport when an approved external apply has no ledger", async () => {
    const transport = new MockProviderTransport("http", async () => ({
      status: "succeeded",
      message: "must not execute",
      effectOutcome: "confirmed_write",
    }));
    const adapter = getProviderAdapter("stripe");

    await expect(
      adapter.apply(fixturePlan(), {
        authorization: "approved",
        transports: { http: transport },
        redactor: new Redactor(),
      }),
    ).rejects.toMatchObject({
      name: "ProviderPlanError",
      code: "invalid_plan",
      message: "Approved external provider apply requires a durable idempotency ledger",
    });
    await expect(
      adapter.apply(fixturePlan(), {
        authorization: "approved",
        transports: { http: transport },
        redactor: new Redactor(),
        idempotencyLedger: new InMemoryIdempotencyLedger(),
      }),
    ).rejects.toMatchObject({
      name: "ProviderPlanError",
      code: "invalid_plan",
      message: "Approved external provider apply requires a durable idempotency ledger",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("reconciles an unclaimed plan as definitive no-write before a later authorized apply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-no-attempt-"));
    const ledgerPath = join(directory, "ledger.json");
    const transport = new MockProviderTransport(
      "http",
      async (operation) =>
        emptyStripeSearch(operation) ?? {
          status: "succeeded",
          message: "fixture product created",
          verified: true,
          effectOutcome: "confirmed_write",
        },
    );
    const adapter = getProviderAdapter("stripe");
    const plan = fixturePlan();

    const reconciled = await adapter.reconcile!(plan, context(ledgerPath, transport));
    expect(reconciled.operations[0]).toMatchObject({
      reused: true,
      result: { status: "failed", effectOutcome: "confirmed_no_write" },
    });
    expect(transport.calls).toHaveLength(0);

    const applied = await adapter.apply(plan, context(ledgerPath, transport));
    expect(applied.operations[0].result.status).toBe("succeeded");
    expect(transport.calls).toHaveLength(2);
  });

  it("reconciles a timeout after the provider write without repeating the write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-unknown-"));
    const ledgerPath = join(directory, "ledger.json");
    let externalWrites = 0;
    const transport = new MockProviderTransport(
      "http",
      async (operation) => {
        const search = emptyStripeSearch(operation);
        if (search) return search;
        externalWrites += 1;
        throw new Error("fixture timeout after provider commit");
      },
      async (operation) => ({
        operationId: operation.id,
        status: externalWrites === 1 ? "matched" : "mismatched",
        message: "deterministic provider lookup found the fixture product",
        evidence: { id: "fixture_product" },
      }),
    );
    const adapter = getProviderAdapter("stripe");
    const plan = fixturePlan();

    const first = await adapter.apply(plan, context(ledgerPath, transport));
    const second = await adapter.apply(plan, context(ledgerPath, transport));

    expect(first.operations[0].result).toMatchObject({
      status: "failed",
      effectOutcome: "unknown",
    });
    expect(second.operations[0]).toMatchObject({
      reused: true,
      result: { status: "succeeded", verified: true, effectOutcome: "confirmed_write" },
    });
    expect(externalWrites).toBe(1);
    expect(transport.calls).toHaveLength(3);
  });

  it.each(["product", "price", "webhook", "billing_portal"] as const)(
    "recovers an ambiguous Stripe %s POST with the same native idempotency key",
    async (capability) => {
      const directory = await mkdtemp(join(tmpdir(), `vh-provider-native-${capability}-`));
      const ledgerPath = join(directory, "ledger.json");
      let postCalls = 0;
      let externalWrites = 0;
      const transport = new MockProviderTransport("http", async (operation) => {
        const search = emptyStripeSearch(operation);
        if (search) return search;
        postCalls += 1;
        if (postCalls === 1) {
          externalWrites += 1;
          throw new Error("fixture connection closed after Stripe committed the idempotent POST");
        }
        return {
          status: "succeeded",
          message: "Stripe replayed the original idempotent response",
          output: { id: `${capability}_fixture_replayed` },
          effectOutcome: "confirmed_write",
        };
      });
      const adapter = getProviderAdapter("stripe");
      const plan = adapter.plan({
        ...providerPlanFixtures.stripe,
        capabilities: [capability],
        inputs: {
          ...providerPlanFixtures.stripe.inputs,
          productId: "prod_fixture_existing",
        },
        dryRun: false,
      });

      const providerContext = context(ledgerPath, transport);
      if (capability === "webhook") {
        const broker = new CredentialBroker([new MemoryCredentialBackend()]);
        broker.register({
          ref: "cred://stripe/webhook-secret",
          provider: "stripe",
          kind: "ci_secret",
          backend: "memory",
        });
        providerContext.credentials = broker;
        providerContext.redactor = broker.redactor;
      }
      const first = await adapter.apply(plan, providerContext);
      const resumed = await adapter.apply(plan, providerContext);

      expect(first.operations[0]?.result.effectOutcome).toBe("unknown");
      expect(resumed.operations[0]).toMatchObject({
        reused: true,
        result: {
          status: "succeeded",
          effectOutcome: "confirmed_write",
          message: expect.stringContaining("native idempotency key"),
        },
      });
      expect(postCalls).toBe(2);
      expect(externalWrites).toBe(1);
    },
  );

  it("blocks reinvocation while an ambiguous write cannot be reconciled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-blocked-"));
    const ledgerPath = join(directory, "ledger.json");
    const transport = new MockProviderTransport(
      "http",
      async (operation) => {
        const search = emptyStripeSearch(operation);
        if (search) return search;
        throw new Error("fixture connection reset after request send");
      },
      async (operation) => ({
        operationId: operation.id,
        status: "unavailable",
        message: "provider lookup is unavailable",
      }),
    );
    const adapter = getProviderAdapter("stripe");
    const plan = fixturePlan();

    await adapter.apply(plan, context(ledgerPath, transport));
    const replay = await adapter.apply(plan, context(ledgerPath, transport));

    expect(replay.operations[0]).toMatchObject({
      reused: true,
      result: {
        status: "failed",
        providerCode: "unknown_outcome_reconciliation_required",
        effectOutcome: "unknown",
      },
    });
    expect(transport.calls).toHaveLength(4);
  });

  it("rejects a reused key whose complete provider request differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-conflict-"));
    const ledgerPath = join(directory, "ledger.json");
    const privateResult = "sk_test_SYNTHETICNOTAREALconflictcanary1";
    const transport = new MockProviderTransport(
      "http",
      async (operation) =>
        emptyStripeSearch(operation) ?? {
          status: "succeeded",
          message: "created private first result",
          output: { id: privateResult },
          verified: true,
        },
    );
    const adapter = getProviderAdapter("stripe");
    const firstPlan = fixturePlan();
    const first = await adapter.apply(firstPlan, context(ledgerPath, transport));
    const operation = firstPlan.operations[0];
    const conflictingPlan: ProviderPlan = {
      ...firstPlan,
      id: `${firstPlan.id}.conflict`,
      operations: [
        {
          ...operation,
          title: `${operation.title} with different bound input`,
        },
      ],
    };

    const conflict = await adapter.apply(conflictingPlan, context(ledgerPath, transport));

    expect(first.operations[0].result.status).toBe("succeeded");
    expect(conflict.operations[0].result).toMatchObject({
      status: "failed",
      providerCode: "idempotency_conflict",
    });
    expect(JSON.stringify(conflict)).not.toContain(privateResult);
    expect(transport.calls).toHaveLength(2);
    const durable = await readFile(ledgerPath, "utf8");
    expect(durable).not.toContain(firstPlan.operations[0].idempotencyKey);
    expect(durable).not.toContain(privateResult);
  });

  it("recovers only dependency-safe public identifiers after a ledger restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-dependency-restart-"));
    const ledgerPath = join(directory, "ledger.json");
    const rawSecret = "sk_test_dependency_restart_must_never_persist_123456";
    const privateCanary = "private-canary-must-not-enter-replay-output";
    const transport = new MockProviderTransport(
      "http",
      async (operation) =>
        emptyStripeSearch(operation) ?? {
          status: "succeeded",
          message: "fixture provider write completed before the simulated crash",
          output:
            operation.capability === "product"
              ? { id: "prod_restart_public", secret: rawSecret, privateNote: privateCanary }
              : { id: "price_restart_public", privateNote: privateCanary },
          effectOutcome: "confirmed_write",
        },
      async (operation, execution) => {
        const id = (execution.output as { id?: unknown } | undefined)?.id;
        return {
          operationId: operation.id,
          status: typeof id === "string" ? "matched" : "unavailable",
          message:
            typeof id === "string"
              ? "fixture read-back recovered the exact public id"
              : "fixture read-back could not recover the public id",
          evidence: typeof id === "string" ? { id } : undefined,
        };
      },
    );
    const adapter = getProviderAdapter("stripe");
    const plan = adapter.plan({
      environment: "sandbox",
      capabilities: ["product", "price"],
      credentialRef: "cred://stripe/restart",
      inputs: {
        ventureSlug: "restart-fixture",
        stripeAccountId: "acct_restart_fixture",
        stripeMode: "test",
        productName: "Restart fixture",
        productId: "{dependency.product.id}",
        currency: "eur",
        unitAmount: 1_900,
        recurringInterval: "month",
      },
      dryRun: false,
    });

    const first = await adapter.apply(plan, context(ledgerPath, transport));
    expect(first.state).toBe("applied");
    expect(transport.calls).toHaveLength(4);

    const durable = await readFile(ledgerPath, "utf8");
    expect(durable).toContain('"version": 4');
    expect(durable).toMatch(/"ledgerId": "ledger_[a-f0-9]{64}"/u);
    expect(durable).toContain("prod_restart_public");
    expect(durable).toContain("price_restart_public");
    expect(durable).not.toContain(rawSecret);
    expect(durable).not.toContain(privateCanary);
    expect(durable).not.toContain("Restart fixture");

    const restarted = await adapter.apply(plan, context(ledgerPath, transport));
    expect(restarted.state).toBe("applied");
    expect(restarted.operations.every(({ reused }) => reused)).toBe(true);
    expect(restarted.operations[0]!.result.output).toEqual({ id: "prod_restart_public" });
    expect(restarted.operations[1]!.operation.http?.body).toMatchObject({
      product: "prod_restart_public",
    });
    expect(restarted.operations[1]!.result.output).toEqual({ id: "price_restart_public" });
    expect(transport.calls).toHaveLength(4);

    const readBack = await adapter.readBack(restarted, context(ledgerPath, transport));
    expect(adapter.verify(restarted, readBack).state).toBe("verified");
    expect(readBack.results.every(({ status }) => status === "matched")).toBe(true);
  });

  it("retries only after a transport explicitly confirms that no write occurred", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-no-write-"));
    const ledgerPath = join(directory, "ledger.json");
    let attempts = 0;
    const transport = new MockProviderTransport("http", async (operation) => {
      const search = emptyStripeSearch(operation);
      if (search) return search;
      attempts += 1;
      return attempts === 1
        ? {
            status: "failed",
            providerCode: "retryable_rate_limit",
            message: "fixture rejected before write",
            retryable: true,
            effectOutcome: "confirmed_no_write",
          }
        : {
            status: "succeeded",
            message: "fixture created",
            verified: true,
            effectOutcome: "confirmed_write",
          };
    });
    const adapter = getProviderAdapter("stripe");
    const plan = fixturePlan();

    const first = await adapter.apply(plan, context(ledgerPath, transport));
    const second = await adapter.apply(plan, context(ledgerPath, transport));

    expect(first.operations[0].result.effectOutcome).toBe("confirmed_no_write");
    expect(second.operations[0].result.status).toBe("succeeded");
    expect(transport.calls).toHaveLength(4);
  });

  it("serializes two Node processes and replays without a duplicate provider write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vh-provider-process-replay-"));
    const ledgerPath = join(directory, "ledger.json");
    const markerPath = join(directory, "provider-write.marker");
    const callsPath = join(directory, "transport-calls.log");
    const worker = join(process.cwd(), "tests/fixtures/provider/concurrent-apply-worker.ts");
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", worker, ledgerPath, markerPath, callsPath],
        { cwd: process.cwd(), timeout: 15_000 },
      );

    const [first, second] = await Promise.all([run(), run()]);
    const third = await run();
    const reports = [first, second, third].map(
      ({ stdout }) =>
        JSON.parse(stdout) as {
          operations: Array<{ reused: boolean; result: { status: string } }>;
        },
    );
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");

    expect(calls).toHaveLength(1);
    expect(reports.flatMap(({ operations }) => operations)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: expect.objectContaining({ status: "succeeded" }) }),
      ]),
    );
    expect(reports[2]!.operations[0]).toMatchObject({ reused: true });
  }, 20_000);
});
