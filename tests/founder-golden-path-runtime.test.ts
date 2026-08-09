import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialBroker, MemoryCredentialBackend } from "@/lib/credentials";
import { getProviderAdapter } from "@/lib/providers";
import { createOfficialProviderContext, FileProviderIdempotencyLedger } from "@/lib/runtime";
import { FounderGoldenPathOfficialTransportFixture } from "./fixtures/founder-golden-path-runtime";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), label));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("founder Golden Path official transport fixture", () => {
  it("drives registered adapters through real command and HTTP transports with durable read-back", async () => {
    const fixtureRoot = temporaryDirectory("vh-founder-provider-fixture-");
    const childRoot = temporaryDirectory("vh-founder-provider-child-");
    writeFileSync(join(childRoot, "README.md"), "# Independent child\n");
    const transportFixture = new FounderGoldenPathOfficialTransportFixture({
      fixtureRoot,
      expectedChildRoot: childRoot,
    });
    const backend = new MemoryCredentialBackend();
    const credentials = new CredentialBroker([backend]);
    await credentials.store({
      ref: "cred://github/founder-default",
      provider: "github",
      kind: "cli_session",
      backend: "memory",
      value: "fixture-github-session-value",
    });
    await credentials.store({
      ref: "cred://stripe/founder-default",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      value: "sk_test_fixture_golden_path_123456789",
    });
    credentials.register({
      ref: "cred://stripe/exception-desk-webhook",
      provider: "stripe",
      kind: "ci_secret",
      backend: "memory",
    });
    const runtimeContext = createOfficialProviderContext({
      commandRunner: transportFixture,
      httpFetcher: transportFixture,
      commandAvailable: async () => ({
        available: true,
        detail: "fixture-backed direct command transport",
      }),
      httpAvailable: async () => ({
        available: true,
        detail: "fixture-backed official HTTP transport",
      }),
      credentials,
      idempotencyLedger: new FileProviderIdempotencyLedger(
        join(fixtureRoot, "provider-idempotency.json"),
      ),
    });
    const context = { ...runtimeContext, authorization: "approved" as const };
    expect(runtimeContext.transports.cli?.constructor.name).toBe("CommandProviderTransport");
    expect(runtimeContext.transports.http?.constructor.name).toBe("HttpProviderTransport");

    const githubTarget = transportFixture.register({
      provider: "github",
      request: {
        environment: "preview",
        credentialRef: "cred://github/founder-default",
        capabilities: ["repository"],
        inputs: {
          repository: "fixture-founder-org/exception-desk",
          sourceDirectory: childRoot,
          visibility: "private",
        },
        dryRun: false,
      },
    });
    const github = getProviderAdapter("github");
    const githubPlan = github.plan(githubTarget.request);
    expect(github.constructor.name).toBe("DeclarativeProviderAdapter");
    expect(githubPlan).toMatchObject({
      provider: "github",
      environment: "preview",
      dryRun: false,
      operations: [
        {
          action: "repository.create_from_source",
          transport: "cli",
          credentialRef: "cred://github/founder-default",
        },
      ],
    });
    const githubApply = await github.apply(githubPlan, context);
    const githubReadBack = await github.readBack(githubApply, context);

    expect(githubApply.state).toBe("applied");
    expect(github.verify(githubApply, githubReadBack).state).toBe("verified");
    expect(githubReadBack.results).toEqual([
      expect.objectContaining({ status: "matched", evidence: expect.any(Object) }),
    ]);
    expect(existsSync(join(childRoot, ".git"))).toBe(true);
    expect(existsSync(join(fixtureRoot, "remotes/fixture-founder-org--exception-desk.git"))).toBe(
      true,
    );

    const stripeTarget = transportFixture.register({
      provider: "stripe",
      request: {
        environment: "sandbox",
        credentialRef: "cred://stripe/founder-default",
        capabilities: ["product", "price", "webhook", "billing_portal"],
        inputs: {
          productName: "Exception Desk fixture plan",
          productDescription: "Synthetic fixture; no offer is public.",
          productId: "{dependency.product.id}",
          currency: "eur",
          unitAmount: 1_900,
          recurringInterval: "month",
          webhookUrl: "https://exception-desk.example.test/api/stripe/webhook",
          enabledEvents: ["checkout.session.completed"],
          webhookSecretCredentialRef: "cred://stripe/exception-desk-webhook",
          headline: "Manage Exception Desk fixture plan",
        },
        dryRun: false,
      },
    });
    const stripe = getProviderAdapter("stripe");
    const stripePlan = stripe.plan(stripeTarget.request);
    expect(stripe.constructor.name).toBe("DeclarativeProviderAdapter");
    expect(stripePlan.operations.map(({ action }) => action)).toEqual([
      "product.create",
      "price.create",
      "webhook_endpoint.create",
      "billing_portal.configuration.create",
    ]);
    expect(
      stripePlan.operations.every(
        ({ http }) =>
          http?.encoding === "form" &&
          http.nativeIdempotency === true &&
          http.auth?.scheme === "basic" &&
          http.auth.credentialRef === "cred://stripe/founder-default",
      ),
    ).toBe(true);
    expect(stripePlan.operations[1]!.dependsOn).toEqual([stripePlan.operations[0]!.id]);
    const stripeApply = await stripe.apply(stripePlan, context);
    const stripeReadBack = await stripe.readBack(stripeApply, context);

    expect(stripeApply.state).toBe("applied");
    expect(stripe.verify(stripeApply, stripeReadBack).state).toBe("verified");
    expect(stripeReadBack.results.every(({ status }) => status === "matched")).toBe(true);
    const captured = await credentials.withSecret(
      "cred://stripe/exception-desk-webhook",
      (value) => value,
    );
    expect(captured).toMatch(/^whsec_fixture_/);
    expect(JSON.stringify({ stripeApply, stripeReadBack })).not.toContain(captured);
    expect(JSON.stringify(stripeApply)).toContain("official_transport_underlying_fixture");

    expect(readFileSync(join(fixtureRoot, "provider-idempotency.json"), "utf8")).toContain(
      '"state": "succeeded"',
    );

    const vercelTarget = transportFixture.register({
      provider: "vercel",
      request: {
        environment: "preview",
        credentialRef: "cred://vercel/founder-default",
        capabilities: ["project", "deployment", "domain"],
        inputs: {
          project: "exception-desk",
          scope: "fixture-vercel-team",
          projectIntent: "create",
          domain: "exception-desk.example.test",
        },
        dryRun: false,
      },
    });
    const vercel = getProviderAdapter("vercel");
    const vercelPlan = vercel.plan(vercelTarget.request);
    expect(vercelPlan.operations.map(({ action }) => action)).toEqual([
      "project.create",
      "project.link",
      "deployment.preview",
      "domain.add",
    ]);
    const vercelApply = await vercel.apply(vercelPlan, context);
    const vercelReadBack = await vercel.readBack(vercelApply, context);
    expect(vercel.verify(vercelApply, vercelReadBack).state).toBe("verified");

    transportFixture.assertComplete();
    expect(
      transportFixture.registeredPlans.every(
        ({ adapterConstructor }) => adapterConstructor === "DeclarativeProviderAdapter",
      ),
    ).toBe(true);
    expect(
      transportFixture.invocations.some(
        ({ transport, registered }) =>
          transport === "cli" &&
          registered.some(
            ({ action, phases }) =>
              action === "repository.create_from_source" && phases.includes("read_back"),
          ),
      ),
    ).toBe(true);
    expect(
      transportFixture.invocations.some(
        ({ transport, registered, sensitiveInput }) =>
          transport === "http" &&
          sensitiveInput &&
          registered.some(
            ({ action, phases }) =>
              action === "webhook_endpoint.create" && phases.includes("apply"),
          ),
      ),
    ).toBe(true);
  });
});
