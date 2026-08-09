import { describe, expect, it, vi } from "vitest";
import {
  FOUNDER_CORE_DOMAINS,
  runVhShell,
  type AdvancedCliRunner,
  type FounderCliRunner,
  type VhShellIo,
} from "../scripts/vh-bundle";

function shellHarness(founderExitCode = 0, advancedExitCode = 0) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: VhShellIo = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const founderRunner = vi.fn<FounderCliRunner>(async (_args, options) => {
    expect(options.io).toBe(io);
    options.io.stdout("founder");
    return { exitCode: founderExitCode };
  });
  const advancedRunner = vi.fn<AdvancedCliRunner>(async (_args, options) => {
    expect(options.io).toBe(io);
    options.io.stdout("advanced");
    return advancedExitCode;
  });
  return { advancedRunner, founderRunner, io, stderr, stdout };
}

describe("root vh shell dispatch", () => {
  it("routes every founder-core domain to the canonical root CLI without changing arguments", async () => {
    const harness = shellHarness();
    const invocations = [...FOUNDER_CORE_DOMAINS].map((domain) =>
      domain === "launch"
        ? [
            domain,
            "--idea",
            "A focused analytics product",
            "--stack",
            "founder-default",
            "--production",
            "--apply",
            "--non-interactive",
          ]
        : [domain, "--json"],
    );

    for (const args of invocations) {
      expect(await runVhShell(args, harness)).toBe(0);
    }

    expect(harness.founderRunner.mock.calls.map(([args]) => args)).toEqual(invocations);
    expect(harness.advancedRunner).not.toHaveBeenCalled();
  });

  it("uses the founder CLI for the focused public help surface", async () => {
    const harness = shellHarness();

    for (const args of [[], ["help"], ["--help"], ["-h"], ["--", "--help"]]) {
      expect(await runVhShell(args, harness)).toBe(0);
    }

    expect(harness.founderRunner.mock.calls.map(([args]) => args)).toEqual([
      [],
      ["help"],
      ["--help"],
      ["-h"],
      ["--help"],
    ]);
    expect(harness.advancedRunner).not.toHaveBeenCalled();
  });

  it("preserves generated command-bus and recursive surfaces behind the advanced runner", async () => {
    const harness = shellHarness();
    const invocations = [
      ["commands"],
      ["provider", "list"],
      ["fleet", "status"],
      ["org", "list"],
      ["pack", "list"],
      ["seed", "list"],
      ["grant", "list"],
      ["venture", "plan"],
      ["run", "list"],
      ["campaigns", "launch", "--input", "{}"],
      ["nova-care", "deliver", "--input", "{}"],
      ["growth", "inspect"],
      ["verify", "fast"],
    ];

    for (const args of invocations) {
      expect(await runVhShell(args, harness)).toBe(0);
    }

    expect(harness.advancedRunner.mock.calls.map(([args]) => args)).toEqual(invocations);
    expect(harness.founderRunner).not.toHaveBeenCalled();
  });

  it("returns the selected runner's exit code and shares one injected IO boundary", async () => {
    const founder = shellHarness(7, 9);
    const advanced = shellHarness(7, 9);

    expect(await runVhShell(["doctor"], founder)).toBe(7);
    expect(await runVhShell(["commands"], advanced)).toBe(9);
    expect(founder.stdout).toEqual(["founder"]);
    expect(advanced.stdout).toEqual(["advanced"]);
    expect(founder.stderr).toEqual([]);
    expect(advanced.stderr).toEqual([]);
  });
});
