import { describe, expect, it, vi } from "vitest";
import {
  CodexCliIdeaSharpenerHost,
  IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT,
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

describe("bounded idea sharpening", () => {
  it("fails closed before a Codex invocation because founder alpha has no audited driver", async () => {
    const host = new CodexCliIdeaSharpenerHost();

    await expect(host.run({ prompt: "safe fixture prompt", phase: "primary" })).rejects.toThrow(
      /outer read-isolation/iu,
    );
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
