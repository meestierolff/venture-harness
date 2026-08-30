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
      "commercialCommitmentEvent to starting a Stripe test-mode monthly subscription checkout for the displayed EUR amount per month rather than a completed payment or charge",
    );
    expect(request?.prompt).toContain(
      "Record the subscription model and exact displayed monthly price in truth.assumptions, and record willingness to pay separately in truth.unknowns",
    );
    expect(request?.prompt).toContain(
      "never present the model, amount, demand, or provider state as truth.facts or external evidence",
    );
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
