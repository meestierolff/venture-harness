import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CommandInvocation, CommandRunner } from "@/lib/credentials";
import {
  CodexCliIdeaSharpenerHost,
  IDEA_SHARPENER_CONTEXT_CHARACTER_LIMIT,
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
              usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    };
    const previous = process.env.UNRELATED_PRIVATE_VALUE;
    process.env.UNRELATED_PRIVATE_VALUE = "must-not-enter-the-model-environment";
    try {
      const host = new CodexCliIdeaSharpenerHost({
        runner,
        model: "gpt-test-fixed",
      });
      const prompt = "private founder idea supplied via stdin";
      const result = await host.run({ prompt, phase: "primary" });

      expect(result).toMatchObject({
        usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 50 },
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
      expect(invocation).toMatchObject({
        stdin: prompt,
        sensitiveStdin: true,
      });
      expect(invocation.args).not.toContain(prompt);
      expect(invocation.env).not.toHaveProperty("UNRELATED_PRIVATE_VALUE");
      expect(existsSync(isolatedRoot)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.UNRELATED_PRIVATE_VALUE;
      else process.env.UNRELATED_PRIVATE_VALUE = previous;
    }
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
});
