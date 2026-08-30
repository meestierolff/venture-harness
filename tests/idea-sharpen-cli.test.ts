import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "@/lib/cli";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import { CodexCliIdeaSharpenerHost, type IdeaSharpenerHost } from "@/lib/founder-launch";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function mockIdeaSharpenerRun(run: IdeaSharpenerHost["run"]): void {
  vi.spyOn(CodexCliIdeaSharpenerHost.prototype, "run").mockImplementation(run);
}

function ioHarness(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

describe("vh idea sharpen", () => {
  it("writes only the reviewed idea, constitution, contract, and sanitized usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-"));
    roots.push(root);
    writeFileSync(
      join(root, "rough.md"),
      "# Tiny launch receipt\nBuild one useful launch receipt.",
    );
    const run = vi.fn(async () => ({
      finalText: JSON.stringify(launchReceiptContract()),
      usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 40 },
    }));
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({
      rootDir: root,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", "rough.md", "--output", "idea.md", "--json"],
      { services, io: harness.io },
    );

    expect(result.exitCode, harness.stderr.join("\n")).toBe(0);
    expect(JSON.parse(harness.stdout[0])).toMatchObject({
      status: "sharpened",
      output: "idea.md",
      launchContract: "idea.launch-contract.yaml",
      productConstitution: "idea.product-constitution.md",
      usage: "idea.usage.json",
      modelCalls: 1,
      providerEffects: false,
      repositoryCreated: false,
      deploymentCreated: false,
    });
    expect(readFileSync(join(root, "idea.md"), "utf8")).toContain("schemaVersion: 1");
    expect(readFileSync(join(root, "idea.product-constitution.md"), "utf8")).toContain(
      "Truth classes",
    );
    expect(JSON.parse(readFileSync(join(root, "idea.usage.json"), "utf8"))).toMatchObject({
      totalTokens: 120,
      transcriptStored: false,
      providerEffects: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic zero-call parsing and rejects escaping output", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-"));
    roots.push(root);
    writeFileSync(join(root, "contract.json"), JSON.stringify(launchReceiptContract()));
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({
      rootDir: root,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    const harness = ioHarness();

    expect(
      (
        await runCli(
          ["idea", "sharpen", "--input", "contract.json", "--output", "review/idea.md", "--json"],
          { services, io: harness.io },
        )
      ).exitCode,
      harness.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(harness.stdout[0])).toMatchObject({
      status: "already_structured",
      modelCalls: 0,
    });
    expect(run).not.toHaveBeenCalled();

    const escaped = ioHarness();
    expect(
      (
        await runCli(["idea", "sharpen", "--input", "contract.json", "--output", "../escaped.md"], {
          services,
          io: escaped.io,
        })
      ).exitCode,
    ).toBe(1);
    expect(escaped.stderr.join("\n")).toMatch(/escapes/);
  });

  it("rejects a symlinked output ancestor before creating any outside directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-"));
    const outside = mkdtempSync(join(tmpdir(), "vh-sharpen-outside-"));
    roots.push(root, outside);
    writeFileSync(join(root, "contract.json"), JSON.stringify(launchReceiptContract()));
    symlinkSync(outside, join(root, "linked"), "dir");
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", "contract.json", "--output", "linked/new/idea.md"],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/symbolic link/);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "new"))).toBe(false);
  });

  it("rejects a symlinked input ancestor before reading or calling the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-"));
    const outside = mkdtempSync(join(tmpdir(), "vh-sharpen-input-outside-"));
    roots.push(root, outside);
    writeFileSync(join(outside, "rough.md"), "# Outside idea\nDo not read this file.");
    symlinkSync(outside, join(root, "linked-input"), "dir");
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", "linked-input/rough.md", "--output", "idea.md"],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/non-symlink directory|symbolic-link alias/);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(root, "idea.md"))).toBe(false);
  });

  it("fails closed when the validated output parent is swapped during model work", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-"));
    const outside = mkdtempSync(join(tmpdir(), "vh-sharpen-race-outside-"));
    roots.push(root, outside);
    writeFileSync(join(root, "rough.md"), "# Tiny receipt\nBuild one useful receipt.");
    mkdirSync(join(root, "review"), { mode: 0o700 });
    const run = vi.fn(async () => {
      renameSync(join(root, "review"), join(root, "review-original"));
      symlinkSync(outside, join(root, "review"), "dir");
      return {
        finalText: JSON.stringify(launchReceiptContract()),
        usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 40 },
      };
    });
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", "rough.md", "--output", "review/idea.md"],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/non-symlink directory|symbolic-link alias|changed/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(outside, "idea.md"))).toBe(false);
    expect(existsSync(join(outside, "idea.launch-contract.yaml"))).toBe(false);
    expect(existsSync(join(outside, "idea.product-constitution.md"))).toBe(false);
    expect(existsSync(join(outside, "idea.usage.json"))).toBe(false);
  });

  it("persists only sanitized accounting when the bounded model refinement is exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-"));
    roots.push(root);
    writeFileSync(join(root, "rough.md"), "# Small tool\nTurn one review into one receipt.");
    const run = vi.fn(async () => ({
      finalText: "{}",
      usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, model: "fixture" },
    }));
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({
      rootDir: root,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", "rough.md", "--output", "failed/idea.md"],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(existsSync(join(root, "failed/idea.md"))).toBe(false);
    expect(existsSync(join(root, "failed/idea.launch-contract.yaml"))).toBe(false);
    expect(existsSync(join(root, "failed/idea.product-constitution.md"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "failed/idea.usage.json"), "utf8"))).toMatchObject({
      status: "failed",
      inputTokens: 40,
      cachedInputTokens: 10,
      outputTokens: 20,
      totalTokens: 60,
      modelCalls: 2,
      host: "codex_cli",
      model: "fixture",
      transcriptStored: false,
      providerEffects: false,
    });
  });

  it("rejects missing, ambiguous, and unknown CLI arguments without a model call", async () => {
    const harness = ioHarness();
    const run = vi.fn();
    const services = { ideaSharpen: run };
    for (const args of [
      ["idea", "sharpen", "--input", "rough.md"],
      ["idea", "sharpen", "--input", "rough.md", "--output", "idea.yaml"],
      ["idea", "sharpen", "--input", "rough.md", "--output", "idea.md", "--provider"],
      ["idea", "loop", "--input", "rough.md", "--output", "idea.md"],
    ]) {
      expect((await runCli(args, { services, io: harness.io })).exitCode).toBe(2);
    }
    expect(run).not.toHaveBeenCalled();
  });
});
