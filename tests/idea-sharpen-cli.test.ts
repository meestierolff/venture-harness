import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

  it("reads and writes explicit absolute founder documents outside Core", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-core-"));
    const founderDocuments = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-documents-"));
    roots.push(root, founderDocuments);
    const coreReadme = join(root, "README.md");
    const canonicalDocuments = realpathSync(founderDocuments);
    const input = join(canonicalDocuments, "launch-receipt-rough.md");
    const output = join(canonicalDocuments, "launch-receipt.md");
    writeFileSync(coreReadme, "# Core sentinel\n");
    writeFileSync(input, "# Launch Receipt\nBuild one useful launch receipt.");
    const run = vi.fn(async () => ({
      finalText: JSON.stringify(launchReceiptContract()),
      usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 40 },
    }));
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", input, "--output", output, "--json"],
      { services, io: harness.io },
    );

    const canonicalOutput = join(canonicalDocuments, "launch-receipt.md");
    const baseOutput = canonicalOutput.slice(0, -3);
    expect(result.exitCode, harness.stderr.join("\n")).toBe(0);
    expect(JSON.parse(harness.stdout[0])).toMatchObject({
      output: canonicalOutput,
      productConstitution: `${baseOutput}.product-constitution.md`,
      launchContract: `${baseOutput}.launch-contract.yaml`,
      usage: `${baseOutput}.usage.json`,
    });
    expect(readFileSync(coreReadme, "utf8")).toBe("# Core sentinel\n");
    expect(readFileSync(output, "utf8")).toContain("schemaVersion: 1");
    expect(existsSync(`${baseOutput}.product-constitution.md`)).toBe(true);
    expect(existsSync(`${baseOutput}.launch-contract.yaml`)).toBe(true);
    expect(existsSync(`${baseOutput}.usage.json`)).toBe(true);
    expect(existsSync(join(root, ".vh-idea-sharpen.lock"))).toBe(false);
    expect(existsSync(join(canonicalDocuments, ".vh-idea-sharpen-input.lock"))).toBe(false);
    expect(existsSync(join(canonicalDocuments, ".vh-idea-sharpen-output.lock"))).toBe(false);
    expect(existsSync(join(dirname(canonicalDocuments), ".vh-idea-sharpen-output.lock"))).toBe(
      false,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects an absolute external input through a symlinked parent before model work", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-core-"));
    const aliasContainer = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-input-alias-"));
    const external = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-input-external-"));
    roots.push(root, aliasContainer, external);
    writeFileSync(join(external, "rough.md"), "# Outside idea\nDo not read this file.");
    symlinkSync(external, join(aliasContainer, "documents"), "dir");
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      [
        "idea",
        "sharpen",
        "--input",
        join(aliasContainer, "documents", "rough.md"),
        "--output",
        "idea.md",
      ],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/real non-symlink directory/);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(root, "idea.md"))).toBe(false);
    expect(existsSync(join(root, ".vh-idea-sharpen.lock"))).toBe(false);
  });

  it("never overwrites Core README when it is selected by an absolute output path", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-core-"));
    roots.push(root);
    const readme = join(realpathSync(root), "README.md");
    writeFileSync(join(root, "rough.md"), "# Tiny receipt\nBuild one useful receipt.");
    writeFileSync(readme, "# Core sentinel\n");
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(["idea", "sharpen", "--input", "rough.md", "--output", readme], {
      services,
      io: harness.io,
    });

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/already exists/);
    expect(readFileSync(readme, "utf8")).toBe("# Core sentinel\n");
    expect(run).not.toHaveBeenCalled();
  });

  it("preflights every artifact and never calls the model when any target exists", async () => {
    const run = vi.fn(async () => ({
      finalText: JSON.stringify(launchReceiptContract()),
      usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 40 },
    }));
    mockIdeaSharpenerRun(run);
    for (const existingName of [
      "idea.md",
      "idea.product-constitution.md",
      "idea.launch-contract.yaml",
      "idea.usage.json",
    ]) {
      const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-preflight-"));
      roots.push(root);
      writeFileSync(join(root, "rough.md"), "# Tiny receipt\nBuild one useful receipt.");
      writeFileSync(join(root, existingName), `sentinel:${existingName}\n`);
      const services = createDefaultCliServices({ rootDir: root });
      const harness = ioHarness();

      const result = await runCli(
        ["idea", "sharpen", "--input", "rough.md", "--output", "idea.md"],
        { services, io: harness.io },
      );

      expect(result.exitCode).toBe(1);
      expect(harness.stderr.join("\n")).toMatch(/already exists/);
      expect(readFileSync(join(root, existingName), "utf8")).toBe(`sentinel:${existingName}\n`);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects symlinked absolute output parents and dangling output files", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-core-"));
    const aliasContainer = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-alias-"));
    const external = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-external-"));
    roots.push(root, aliasContainer, external);
    writeFileSync(join(root, "rough.md"), "# Tiny receipt\nBuild one useful receipt.");
    symlinkSync(external, join(aliasContainer, "documents"), "dir");
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });

    const aliased = ioHarness();
    expect(
      (
        await runCli(
          [
            "idea",
            "sharpen",
            "--input",
            "rough.md",
            "--output",
            join(aliasContainer, "documents", "idea.md"),
          ],
          { services, io: aliased.io },
        )
      ).exitCode,
    ).toBe(1);
    expect(aliased.stderr.join("\n")).toMatch(/real non-symlink directory/);

    const canonicalExternal = realpathSync(external);
    const danglingTarget = join(canonicalExternal, "missing-target.md");
    const danglingOutput = join(canonicalExternal, "idea.md");
    symlinkSync(danglingTarget, danglingOutput);
    const dangling = ioHarness();
    expect(
      (
        await runCli(["idea", "sharpen", "--input", "rough.md", "--output", danglingOutput], {
          services,
          io: dangling.io,
        })
      ).exitCode,
    ).toBe(1);
    expect(dangling.stderr.join("\n")).toMatch(/already exists/);
    expect(existsSync(danglingTarget)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not overwrite an artifact created while the model is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-race-"));
    roots.push(root);
    const output = join(root, "idea.md");
    writeFileSync(join(root, "rough.md"), "# Tiny receipt\nBuild one useful receipt.");
    const run = vi.fn(async () => {
      writeFileSync(output, "race winner\n");
      return {
        finalText: JSON.stringify(launchReceiptContract()),
        usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 40 },
      };
    });
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(["idea", "sharpen", "--input", "rough.md", "--output", "idea.md"], {
      services,
      io: harness.io,
    });

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/already exists/);
    expect(readFileSync(output, "utf8")).toBe("race winner\n");
    expect(existsSync(join(root, "idea.product-constitution.md"))).toBe(false);
    expect(existsSync(join(root, "idea.launch-contract.yaml"))).toBe(false);
    expect(existsSync(join(root, "idea.usage.json"))).toBe(false);
  });

  it("fails closed and releases both locks when an absolute output parent is swapped", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-core-"));
    const founderDocuments = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-race-documents-"));
    const outside = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-race-outside-"));
    const movedDocuments = `${founderDocuments}-original`;
    roots.push(root, founderDocuments, outside, movedDocuments);
    writeFileSync(join(root, "rough.md"), "# Tiny receipt\nBuild one useful receipt.");
    const canonicalDocuments = realpathSync(founderDocuments);
    const outputLock = join(dirname(canonicalDocuments), ".vh-idea-sharpen-output.lock");
    const run = vi.fn(async () => {
      renameSync(founderDocuments, movedDocuments);
      symlinkSync(outside, founderDocuments, "dir");
      return {
        finalText: JSON.stringify(launchReceiptContract()),
        usage: { inputTokens: 80, cachedInputTokens: 10, outputTokens: 40 },
      };
    });
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", "rough.md", "--output", join(canonicalDocuments, "idea.md")],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/non-symlink directory|changed/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(join(outside, "idea.md"))).toBe(false);
    expect(existsSync(join(outside, "idea.product-constitution.md"))).toBe(false);
    expect(existsSync(join(outside, "idea.launch-contract.yaml"))).toBe(false);
    expect(existsSync(join(outside, "idea.usage.json"))).toBe(false);
    expect(existsSync(join(root, ".vh-idea-sharpen.lock"))).toBe(false);
    expect(existsSync(outputLock)).toBe(false);
    expect(existsSync(join(movedDocuments, ".vh-idea-sharpen-output.lock"))).toBe(false);
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

  it("keeps relative parent escapes rejected for founder inputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-core-"));
    const outside = mkdtempSync(join(tmpdir(), "vh-sharpen-cli-input-"));
    roots.push(root, outside);
    const outsideInput = join(outside, "rough.md");
    writeFileSync(outsideInput, "# Outside idea\nDo not read this file.");
    const run = vi.fn();
    mockIdeaSharpenerRun(run);
    const services = createDefaultCliServices({ rootDir: root });
    const harness = ioHarness();

    const result = await runCli(
      ["idea", "sharpen", "--input", relative(root, outsideInput), "--output", "idea.md"],
      { services, io: harness.io },
    );

    expect(result.exitCode).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/escapes/);
    expect(run).not.toHaveBeenCalled();
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
