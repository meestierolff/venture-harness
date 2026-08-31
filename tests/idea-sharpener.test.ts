import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CommandInvocation, CommandRunner } from "@/lib/credentials";
import {
  CodexCliIdeaSharpenerHost,
  IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT,
  ideaSharpenerEnvironment,
  renderLaunchContractYaml,
  sharpenIdea,
  type IdeaSharpenerHost,
} from "@/lib/founder-launch";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

function fakeHost(outputs: string[]): IdeaSharpenerHost & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => {
    const finalText = outputs.shift();
    if (!finalText) throw new Error("unexpected model call");
    return {
      finalText,
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 50 },
    };
  });
  return { id: "fixture_codex", run };
}

const launchReceiptRoughIdea = `# Launch Receipt

A small web SaaS for indie hackers preparing a product launch.

Launch requirements and evidence are scattered across notes and provider
dashboards.

The app should let a founder create one focused launch checklist, complete its
items and publish a clean read-only receipt showing what is actually ready.

It must not become a project-management suite, a generic startup dashboard,
a team collaboration product or another Venture Harness control plane.`;

function launchReceiptWithTransactionalJourney(step: string) {
  const contract = launchReceiptContract();
  return launchReceiptContract({
    product: {
      ...contract.product,
      primaryJourney: [...contract.product.primaryJourney, step],
    },
  });
}

function launchReceiptWithJourney(primaryJourney: string[]) {
  const contract = launchReceiptContract();
  return launchReceiptContract({ product: { ...contract.product, primaryJourney } });
}

type TransactionalProductSurface =
  "product.oneCoreFeature" | "product.primaryCta" | "decision.primarySuccessSignal";

function launchReceiptWithTransactionalSurface(path: TransactionalProductSurface, value: string) {
  const contract = launchReceiptContract();
  switch (path) {
    case "product.oneCoreFeature":
      return launchReceiptContract({
        product: { ...contract.product, oneCoreFeature: value },
      });
    case "product.primaryCta":
      return launchReceiptContract({ product: { ...contract.product, primaryCta: value } });
    case "decision.primarySuccessSignal":
      return launchReceiptContract({
        decision: { ...contract.decision, primarySuccessSignal: value },
      });
  }
}

describe("bounded idea sharpening", () => {
  it("runs Codex in a disposable non-repository with the private idea only on stdin", async () => {
    const invocations: CommandInvocation[] = [];
    const runner: CommandRunner = {
      run: async (invocation) => {
        invocations.push(invocation);
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: JSON.stringify(launchReceiptContract()) },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 50,
              },
              model: "gpt-test-observed",
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    };
    const host = new CodexCliIdeaSharpenerHost({ runner, model: "gpt-test-fixed" });
    const prompt = "private founder idea supplied via stdin";

    const result = await host.run({ prompt, phase: "primary" });

    expect(result).toMatchObject({
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        model: "gpt-test-observed",
      },
    });
    const invocation = invocations[0];
    expect(invocation).toBeDefined();
    if (!invocation) throw new Error("expected one Codex invocation");
    const isolatedRoot = invocation.cwd;
    expect(isolatedRoot).toBeDefined();
    if (!isolatedRoot) throw new Error("expected an isolated Codex working directory");
    expect(invocation.args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--json",
      "--model",
      "gpt-test-fixed",
      "-C",
      isolatedRoot,
      "-",
    ]);
    expect(invocation).toMatchObject({ stdin: prompt, sensitiveStdin: true });
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.env).toBeUndefined();
    expect(existsSync(isolatedRoot)).toBe(false);
  });

  it("projects only Codex session and process essentials into the sharpener runner", () => {
    expect(
      ideaSharpenerEnvironment({
        NODE_ENV: "test",
        PATH: "/bin",
        HOME: "/safe-home",
        CODEX_HOME: "/safe-codex",
        VERCEL_TOKEN: "provider-secret",
        OPENAI_API_KEY: "metered-api-secret",
        DATABASE_URL: "postgresql://user:secret@example.test/db",
        UNRELATED_PRIVATE_VALUE: "founder-private-value",
      }),
    ).toEqual({
      NODE_ENV: "test",
      PATH: "/bin",
      HOME: "/safe-home",
      CODEX_HOME: "/safe-codex",
    });
  });

  it("uses zero model calls for an existing Launch Contract", async () => {
    const contract = launchReceiptContract();
    const host = fakeHost([]);
    const result = await sharpenIdea(JSON.stringify(contract), {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.status).toBe("already_structured");
    expect(result.accounting).toMatchObject({
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      host: null,
      model: null,
      assumptionsAdded: [],
    });
    expect(host.run).not.toHaveBeenCalled();
  });

  it("accepts a valid primary result in exactly one call with measured usage", async () => {
    const host = fakeHost([JSON.stringify(launchReceiptContract())]);
    const result = await sharpenIdea("# Launch Receipt\nA small useful SaaS launch proof tool.", {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.status).toBe("sharpened");
    expect(result.accounting).toMatchObject({
      modelCalls: 1,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      totalTokens: 150,
      host: "fixture_codex",
    });
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(host.run.mock.calls[0]?.[0]).toMatchObject({ phase: "primary" });
    expect(host.run.mock.calls[0]?.[0].prompt).toContain("Do not browse, use tools, read files");
    expect(host.run.mock.calls[0]?.[0].prompt).toContain('"proposition"');
    expect(host.run.mock.calls[0]?.[0].prompt).toContain('"privacyAndConsent"');
    expect(result.launchContract.capabilities).toEqual(launchReceiptContract().capabilities);
  });

  it("instructs the exact Launch Receipt brief to use an explicitly uncertain SaaS commerce hypothesis", async () => {
    const host = fakeHost([JSON.stringify(launchReceiptContract())]);

    await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(host.run).toHaveBeenCalledTimes(1);
    const request = host.run.mock.calls[0]?.[0];
    expect(request).toMatchObject({ phase: "primary" });
    expect(request?.prompt).toContain(launchReceiptRoughIdea);
    expect(request?.prompt).toContain(
      "only when the founder describes the product itself as an unqualified web SaaS and supplies no conflicting commercial model",
    );
    expect(request?.prompt).toContain(
      "set business.model to subscription, paymentProvider to stripe, priceHypothesis to one positive numeric monthly EUR amount, capabilities.backend, capabilities.payments, and capabilities.entitlements to REQUIRED",
    );
    expect(request?.prompt).toContain(
      "commercialCommitmentEvent to a non-transactional willingness-to-pay or displayed-price-interest signal for that exact EUR amount per month",
    );
    expect(request?.prompt).toContain(
      "must not create a customer, collect or attach a payment method, open checkout, activate a subscription, or charge anyone",
    );
    expect(request?.prompt).toContain("The primary journey remains the core product outcome");
    expect(request?.prompt).toContain(
      "Include indispensable authentication or sign-in, create/edit persistence, and public read-back steps whenever REQUIRED capabilities or the promised artifact imply them",
    );
    expect(request?.prompt).toContain(
      `set product.primaryJourney to exactly this JSON array and do not paraphrase, combine, or append clauses: ${JSON.stringify(launchReceiptContract().product.primaryJourney)}`,
    );
    expect(request?.prompt).toContain(
      "Record the subscription model and exact displayed monthly price in truth.assumptions, and record willingness to pay separately in truth.unknowns",
    );
    expect(request?.prompt).toContain(
      "never present the model, amount, demand, or provider state as truth.facts or external evidence",
    );
  });

  it("refines invented checkout out of the exact Launch Receipt journey while preserving commerce", async () => {
    const inventedCheckout = launchReceiptWithTransactionalJourney(
      "Start Stripe test-mode subscription checkout for EUR 9 per month",
    );
    const host = fakeHost([
      JSON.stringify(inventedCheckout),
      JSON.stringify(launchReceiptContract()),
    ]);

    const result = await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(host.run.mock.calls.map(([request]) => request.phase)).toEqual([
      "primary",
      "refinement",
    ]);
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      "rough-idea sharpening cannot put checkout, customer creation, payment-method collection, subscription activation, purchases, or charges in the executed primary journey",
    );
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      `set product.primaryJourney to exactly this JSON array and do not paraphrase, combine, or append clauses: ${JSON.stringify(launchReceiptContract().product.primaryJourney)}`,
    );
    expect(result.launchContract.product.primaryJourney).toEqual([
      "Sign in with email",
      "Create one launch checklist",
      "Edit checklist items and persist their state",
      "Publish the launch receipt",
      "Open the public read-only receipt",
    ]);
    expect(result.launchContract.business).toEqual({
      model: "subscription",
      priceHypothesis: 9,
      currency: "EUR",
      paymentProvider: "stripe",
      commercialCommitmentEvent:
        "Non-transactional price interest recorded for the displayed EUR 9 monthly amount",
    });
    expect(result.launchContract.capabilities).toMatchObject({
      backend: "REQUIRED",
      payments: "REQUIRED",
      entitlements: "REQUIRED",
    });
  });

  it.each([
    "A small web SaaS for founders to create a launch checklist.",
    "A web SaaS may create a launch checklist and complete its items, but it must not publish a read-only receipt.",
    "The app should let a founder create no launch checklist, complete no items, and never publish a read-only receipt.",
    "The app should not let a founder create one focused launch checklist, complete its items, or publish a clean read-only receipt.",
    'A competitor says, "The app should let a founder create one focused launch checklist, complete its items and publish a clean read-only receipt showing what is actually ready."',
  ])(
    "does not inject the canonical Launch Receipt journey for a covered non-promise source form",
    async (source) => {
      const host = fakeHost([JSON.stringify(launchReceiptContract())]);

      await sharpenIdea(source, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      });

      expect(host.run).toHaveBeenCalledTimes(1);
      expect(host.run.mock.calls[0]?.[0].prompt).not.toContain(
        "launch-checklist/read-only-receipt source",
      );
    },
  );

  it("keeps explicitly requested checkout as future non-executed context outside the journey", async () => {
    const source = `${launchReceiptRoughIdea}\n\nA future price test may explicitly open Stripe checkout, but it is not the product outcome.`;
    const host = fakeHost([
      JSON.stringify(launchReceiptWithTransactionalJourney("Open Stripe checkout")),
      JSON.stringify(launchReceiptContract()),
    ]);

    const result = await sharpenIdea(source, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(host.run).toHaveBeenCalledTimes(2);
    expect(result.launchContract.product.primaryJourney).toEqual(
      launchReceiptContract().product.primaryJourney,
    );
    expect(result.launchContract.business).toEqual(launchReceiptContract().business);
  });

  it("treats negated checkout as forbidden journey text and fails closed after refinement", async () => {
    const source = `${launchReceiptRoughIdea}\n\nThe primary journey must not include checkout or charge anyone.`;
    const invalid = launchReceiptWithTransactionalJourney("Do not open checkout or charge anyone");
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    const attempt = sharpenIdea(source, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    await expect(attempt).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/exhausted its 2-call limit.*executed primary journey/u),
      accounting: { modelCalls: 2 },
    });
    expect(host.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["product.oneCoreFeature", "core feature", "A checklist that creates a Stripe customer"],
    ["product.primaryCta", "primary CTA", "Start checkout"],
    ["decision.primarySuccessSignal", "primary success signal", "stripe_subscription_activated"],
    ["decision.primarySuccessSignal", "primary success signal", "eur_9_plan_activated"],
  ] as const)(
    "fails closed when %s makes commerce part of the %s",
    async (path, _surface, transactionalValue) => {
      const invalid = launchReceiptWithTransactionalSurface(path, transactionalValue);
      const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

      await expect(
        sharpenIdea(launchReceiptRoughIdea, {
          host,
          now: () => new Date("2026-08-12T12:00:00.000Z"),
        }),
      ).rejects.toMatchObject({
        name: "IdeaSharpenError",
        message: expect.stringMatching(
          new RegExp(
            `${path.replaceAll(".", "\\.")}: rough-idea sharpening cannot put .*keep the product outcome non-transactional`,
            "u",
          ),
        ),
        accounting: { modelCalls: 2 },
      });
      expect(host.run).toHaveBeenCalledTimes(2);
    },
  );

  it.each(
    [
      ["plan activation", "Activate EUR 9 plan", "activate_eur_9_plan"],
      ["autopay", "Enable autopay", "autopay_enabled"],
      ["Paddle", "Connect Paddle", "paddle_connected"],
      ["entitlement", "Provision entitlement", "entitlement_provisioned"],
      ["IBAN", "Enter IBAN", "iban_entered"],
      ["fund collection", "Collect funds", "funds_collected"],
      ["plural customer creation", "Create customers", "customers_created"],
    ].flatMap(([label, proseValue, signalValue]) => [
      [`${label} in the core feature`, "product.oneCoreFeature", proseValue],
      [`${label} in the primary CTA`, "product.primaryCta", proseValue],
      [`${label} in the primary success signal`, "decision.primarySuccessSignal", signalValue],
    ]) as Array<[string, TransactionalProductSurface, string]>,
  )("rejects %s", async (_label, path, transactionalValue) => {
    const invalid = launchReceiptWithTransactionalSurface(path, transactionalValue);
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(
        new RegExp(`${path.replaceAll(".", "\\.")}: rough-idea sharpening cannot put`, "u"),
      ),
      accounting: { modelCalls: 2 },
    });
    expect(host.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Subscribe for EUR 9 per month",
    "Complete payment for EUR 9 per month",
    "Upgrade to the paid plan",
    "Pay EUR 9 per month",
    "Buy the EUR 9 monthly plan",
    "Subscribe now",
    "Provide card details",
    "Set up recurring billing",
    "Confirm the order",
    "Create a Stripe customer",
    "Start a free trial",
    "Start premium access",
    "Update to premium tier",
    "Complete enrollment in monthly membership",
    "Start direct debit",
    "Create a SEPA mandate",
    "Mark premium plan active",
    "Activate EUR 9 plan",
    "Enable autopay",
    "Connect Paddle",
    "Provision entitlement",
    "Enter IBAN",
    "Collect funds",
    "Create customers",
  ])("rejects the transactional journey paraphrase %j", async (step) => {
    const invalid = launchReceiptWithTransactionalJourney(step);
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/exhausted its 2-call limit.*executed primary journey/u),
      accounting: { modelCalls: 2 },
    });
    expect(host.run).toHaveBeenCalledTimes(2);
  });

  it("refines a journey that omits required authentication and persistence", async () => {
    const incomplete = launchReceiptWithJourney([
      "Create one launch checklist",
      "Edit checklist items",
      "Publish the launch receipt",
      "Open the public read-only receipt",
    ]);
    const host = fakeHost([JSON.stringify(incomplete), JSON.stringify(launchReceiptContract())]);

    const result = await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.launchContract.product.primaryJourney).toEqual(
      launchReceiptContract().product.primaryJourney,
    );
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      "rough-idea sharpening requires an authentication or sign-in step",
    );
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      "rough-idea sharpening requires an explicit save or persistence step",
    );
  });

  it("accepts grounded journey paraphrases without forcing literal fixture wording", async () => {
    const paraphrased = launchReceiptWithJourney([
      "Access the app using an email link",
      "Make a new launch checklist",
      "Check off checklist items and save their state",
      "Share the finished receipt publicly",
      "Inspect the public receipt",
    ]);
    const host = fakeHost([JSON.stringify(paraphrased)]);

    const result = await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.launchContract.product.primaryJourney).toEqual(
      paraphrased.product.primaryJourney,
    );
    expect(result.accounting.modelCalls).toBe(1);
  });

  it("accepts a six-step journey with explicit evidence and persistence", async () => {
    const paraphrased = launchReceiptWithJourney([
      "The founder signs in with a magic link",
      "The founder creates one focused launch checklist",
      "The founder completes each requirement and attaches concise evidence",
      "The founder saves the checklist state",
      "The founder publishes a clean read-only receipt and copies its shareable link",
      "The founder opens the public read-only receipt",
    ]);
    const host = fakeHost([JSON.stringify(paraphrased)]);

    const result = await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.launchContract.product.primaryJourney).toEqual(
      paraphrased.product.primaryJourney,
    );
    expect(result.accounting.modelCalls).toBe(1);
  });

  it("accepts concise journey synonyms and the task's create-a-launch wording", async () => {
    const paraphrased = launchReceiptWithJourney([
      "Sign into the app with email",
      "Create one launch",
      "Finish checklist items and save their state",
      "Add supporting evidence",
      "Publish a shareable receipt",
      "Visit the public receipt URL",
    ]);
    const host = fakeHost([JSON.stringify(paraphrased)]);

    const result = await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.launchContract.product.primaryJourney).toEqual(
      paraphrased.product.primaryJourney,
    );
    expect(result.accounting.modelCalls).toBe(1);
  });

  it("rejects an ungrounded commerce paraphrase even without a listed payment term", async () => {
    const invalid = launchReceiptWithTransactionalJourney("Enroll in the premium tier");
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/complete step is not one allowed/u),
      accounting: { modelCalls: 2 },
    });
  });

  it("refines away capability downgrades for an owned published web artifact", async () => {
    const contract = launchReceiptContract();
    const incomplete = launchReceiptContract({
      capabilities: {
        ...contract.capabilities,
        database: "NOT_APPLICABLE",
        authentication: "NOT_APPLICABLE",
        authorization: "NOT_APPLICABLE",
      },
    });
    const host = fakeHost([JSON.stringify(incomplete), JSON.stringify(contract)]);

    const result = await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.launchContract.capabilities).toEqual(contract.capabilities);
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      "an owned published web artifact requires database to be REQUIRED",
    );
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      "an owned published web artifact requires authentication to be REQUIRED",
    );
  });

  it("fails closed when publication never receives a distinct public read-back", async () => {
    const incomplete = launchReceiptWithJourney([
      "Sign in with email",
      "Create one launch checklist",
      "Edit checklist items and persist their state",
      "Publish the launch receipt and copy its shareable link",
    ]);
    const host = fakeHost([JSON.stringify(incomplete), JSON.stringify(incomplete)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/distinct open, view, read, or visit step/u),
      accounting: { modelCalls: 2 },
    });
    expect(host.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "creation before authentication",
      [
        "Create one launch checklist",
        "Sign in with email",
        "Edit checklist items and persist their state",
        "Publish the launch receipt",
        "Open the public read-only receipt",
      ],
      /authentication must precede the create step/u,
    ],
    [
      "publication before persistence",
      [
        "Sign in with email",
        "Create one launch checklist",
        "Publish the launch receipt",
        "Edit checklist items and persist their state",
        "Open the public read-only receipt",
      ],
      /persistence must precede publication/u,
    ],
    [
      "public read before publication",
      [
        "Sign in with email",
        "Create one launch checklist",
        "Edit checklist items and persist their state",
        "Open the public read-only receipt",
        "Publish the launch receipt",
      ],
      /published artifact must be opened or read in a later step/u,
    ],
  ] as const)("fails closed on %s", async (_label, primaryJourney, message) => {
    const invalid = launchReceiptWithJourney([...primaryJourney]);
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(message),
      accounting: { modelCalls: 2 },
    });
  });

  it.each([
    [
      "authentication noun without sign-in",
      [
        "Review authentication requirements",
        "Create one launch checklist",
        "Edit checklist items and persist their state",
        "Publish the launch receipt",
        "Open the public read-only receipt",
      ],
      /authentication or sign-in step/u,
    ],
    [
      "start verb without artifact creation",
      [
        "Sign in with email",
        "Start from the launch overview",
        "Edit checklist items and persist their state",
        "Publish the launch receipt",
        "Open the public read-only receipt",
      ],
      /source-promised create step/u,
    ],
    [
      "unrelated completion before saving state",
      [
        "Sign in with email",
        "Create one launch checklist",
        "Complete onboarding and save checklist state",
        "Publish the launch receipt",
        "Open the public read-only receipt",
      ],
      /source-promised edit or completion step/u,
    ],
    [
      "opening an editor instead of the public artifact",
      [
        "Sign in with email",
        "Create one launch checklist",
        "Edit checklist items and persist their state",
        "Publish the launch receipt",
        "Open the receipt editor",
      ],
      /distinct open, view, read, or visit step/u,
    ],
  ] as const)("rejects %s", async (_label, primaryJourney, message) => {
    const invalid = launchReceiptWithJourney([...primaryJourney]);
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(message),
      accounting: { modelCalls: 2 },
    });
  });

  it.each([
    [
      "plan activation appended to creation",
      1,
      "Create one launch checklist and activate the EUR 9 monthly plan",
    ],
    [
      "IBAN collection appended to editing",
      2,
      "Edit checklist items, enter an IBAN, and save their state",
    ],
    [
      "plan enrollment appended to publication",
      3,
      "Publish the launch receipt and enroll in the EUR 9 monthly plan",
    ],
    [
      "plan enrollment appended to public read",
      4,
      "Open the public read-only receipt after joining the EUR 9 monthly plan",
    ],
    ["autopay appended to creation", 1, "Create one launch checklist and set up autopay"],
    ["Paddle appended to publication", 3, "Publish the launch receipt and configure Paddle"],
    ["RevenueCat appended to creation", 1, "Create one launch checklist and connect RevenueCat"],
    ["entitlement appended to sign-in", 0, "Sign in with email and provision an entitlement"],
    [
      "fund collection appended to editing",
      2,
      "Edit checklist items, collect funds, and save their state",
    ],
    ["signature authentication substituted for sign-in", 0, "Authenticate the receipt signature"],
    ["receipt-link creation substituted for checklist creation", 1, "Create a receipt link"],
    [
      "state marking substituted for item progress",
      2,
      "Mark the state complete and save their state",
    ],
    ["receipt-image saving substituted for persistence", 2, "Save the receipt image"],
    [
      "Vercel configuration appended to editing",
      2,
      "Edit checklist items and persist their state, then configure Vercel",
    ],
    [
      "checklist publication substituted for receipt publication",
      3,
      "Publish the launch checklist",
    ],
    ["public settings substituted for receipt read-back", 4, "View the public settings"],
    [
      "Brevo sending appended to public read-back",
      4,
      "Open the public read-only receipt and send it through Brevo",
    ],
  ] as const)("rejects %s", async (_label, stepIndex, replacement) => {
    const primaryJourney = [...launchReceiptContract().product.primaryJourney];
    primaryJourney[stepIndex] = replacement;
    const invalid = launchReceiptWithJourney(primaryJourney);
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/complete step is not one allowed/u),
      accounting: { modelCalls: 2 },
    });
  });

  it.each([
    ["before authentication", 0, /evidence must follow launch or checklist creation/u],
    [
      "between authentication and creation",
      1,
      /evidence must follow launch or checklist creation/u,
    ],
    ["after publication", 4, /evidence must precede receipt publication/u],
  ] as const)("rejects a separate evidence step %s", async (_label, insertion, message) => {
    const primaryJourney = [...launchReceiptContract().product.primaryJourney];
    primaryJourney.splice(insertion, 0, "Add supporting evidence");
    const invalid = launchReceiptWithJourney(primaryJourney);
    const host = fakeHost([JSON.stringify(invalid), JSON.stringify(invalid)]);

    await expect(
      sharpenIdea(launchReceiptRoughIdea, {
        host,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(message),
      accounting: { modelCalls: 2 },
    });
  });

  it("documents free, deferred, alternative-model, and non-product SaaS precedence in the prompt contract", async () => {
    const host = fakeHost([JSON.stringify(launchReceiptContract())]);

    await sharpenIdea(launchReceiptRoughIdea, {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    const prompt = host.run.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain(
      "Default business.model to free, paymentProvider to none, priceHypothesis to null, and capabilities.payments and capabilities.entitlements to NOT_APPLICABLE when generic founder prose does not propose commerce",
    );
    expect(prompt).toContain(
      "An explicit statement that the whole product is free or needs no payments overrides the web-SaaS hypothesis",
    );
    expect(prompt).toContain(
      "Explicitly deferred payments or monetization also override it and make both capabilities DEFERRED",
    );
    expect(prompt).toContain(
      "An explicit one-time, service, usage, take-rate, native-commerce, advertising, sponsorship, or donation model takes precedence",
    );
    expect(prompt).toContain(
      "A SaaS mention only in the audience, a competitor, a negation, or an explicit not-building boundary does not describe the product itself",
    );
    expect(prompt).toContain(
      "A free trial, free tier, freemium offer, or the phrase not free does not by itself make the whole product free",
    );
  });

  it("allows one schema refinement and never a third call", async () => {
    const host = fakeHost(["{ bad json", JSON.stringify(launchReceiptContract())]);
    const result = await sharpenIdea("# Launch Receipt\nA small useful SaaS launch proof tool.", {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(result.accounting.modelCalls).toBe(2);
    expect(host.run.mock.calls.map(([request]) => request.phase)).toEqual([
      "primary",
      "refinement",
    ]);
    expect(host.run.mock.calls[1]?.[0].prompt).toContain(
      "For founder alpha, only when the founder describes the product itself as an unqualified web SaaS",
    );

    const invalid = fakeHost(["not json", "still not json"]);
    const exhausted = sharpenIdea("# Launch Receipt\nA small useful SaaS launch proof tool.", {
      host: invalid,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    await expect(exhausted).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/exhausted its 2-call limit/),
      accounting: {
        modelCalls: 2,
        inputTokens: 200,
        cachedInputTokens: 40,
        outputTokens: 100,
        totalTokens: 300,
        host: "fixture_codex",
      },
    });
    expect(invalid.run).toHaveBeenCalledTimes(2);
  });

  it("rejects a credential-bearing candidate before the refinement prompt", async () => {
    const host = fakeHost(["not json\npassword: hunter2"]);
    const attempt = sharpenIdea("# Launch Receipt\nA small useful SaaS launch proof tool.", {
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    await expect(attempt).rejects.toMatchObject({
      name: "IdeaSharpenError",
      message: expect.stringMatching(/credential-like material/u),
      accounting: { modelCalls: 1 },
    });
    await expect(attempt).rejects.not.toThrow("hunter2");
    expect(host.run).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and credential-bearing input before a model call", async () => {
    const host = fakeHost([]);
    await expect(
      sharpenIdea("x".repeat(IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT + 1), { host }),
    ).rejects.toThrow(/context limit/);
    await expect(
      sharpenIdea(`# Idea\nToken: ${["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_")}`, {
        host,
      }),
    ).rejects.toThrow(/credential/);
    expect(host.run).not.toHaveBeenCalled();
  });

  it("does not send malformed structured input to the model repair path", async () => {
    const host = fakeHost([]);
    await expect(
      sharpenIdea("schemaVerison: 1\ncapabilites:\n  frontend: REQUIRED\n", { host }),
    ).rejects.toMatchObject({
      code: "LAUNCH_CONTRACT_SOURCE_INVALID",
      invalidPath: "schemaVersion",
    });
    expect(host.run).not.toHaveBeenCalled();
  });

  it("rejects low-entropy credential-labeled text inside a structured contract", async () => {
    const host = fakeHost([]);
    const source = renderLaunchContractYaml(launchReceiptContract()).replace(
      "- Whether founders will pay EUR 9 per month",
      '- "password: hunter2"',
    );

    await expect(sharpenIdea(source, { host })).rejects.toThrow(/credential-labeled text/);
    expect(host.run).not.toHaveBeenCalled();
  });
});
