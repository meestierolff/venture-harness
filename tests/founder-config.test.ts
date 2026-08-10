import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VENTURES_ROOT_UNSET_MESSAGE,
  configuredVenturesRoot,
  defaultFounderConfigPath,
  loadFounderConfig,
  resolveVenturesRoot,
  saveFounderConfig,
  venturePathWithin,
} from "@/lib/founder-launch/founder-config";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = "vh-founder-config-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("founder configuration", () => {
  it("stores settings beside the credential catalog rather than inside a venture", () => {
    const path = defaultFounderConfigPath({ xdgConfigHome: "/tmp/xdg" });
    expect(path).toBe("/tmp/xdg/venture-harness/founder.json");
    expect(defaultFounderConfigPath({ homeDirectory: "/home/f" })).toBe(
      "/home/f/.config/venture-harness/founder.json",
    );
  });

  it("round-trips a ventures root and reports an unset root as absent", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "founder.json");
    expect(loadFounderConfig(path)).toEqual({ schemaVersion: 1 });
    saveFounderConfig({ schemaVersion: 1, venturesRoot: "/srv/ventures" }, path);
    expect(loadFounderConfig(path)).toEqual({ schemaVersion: 1, venturesRoot: "/srv/ventures" });
  });

  it("rejects an unsupported schema and a non-string ventures root", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "founder.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2 }));
    expect(() => loadFounderConfig(path)).toThrow(/schemaVersion 1/);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, venturesRoot: 7 }));
    expect(() => loadFounderConfig(path)).toThrow(/must be a string/);
  });

  it("refuses a ventures root that is not an explicit absolute path", () => {
    const core = temporaryDirectory("vh-core-");
    expect(() => resolveVenturesRoot("ventures", { coreRoot: core })).toThrow(/absolute path/);
    expect(() => resolveVenturesRoot("   ", { coreRoot: core })).toThrow(/non-empty/);
  });

  it("refuses a ventures root entangled with the Venture Harness checkout", () => {
    const parent = temporaryDirectory("vh-parent-");
    const core = join(parent, "venture-harness");
    mkdirSync(core, { recursive: true });

    // Inside Core: ventures would inherit Core's Git history.
    expect(() => resolveVenturesRoot(join(core, "ventures"), { coreRoot: core })).toThrow(
      /must not be inside the Venture Harness repository/,
    );
    // Containing Core: materialization could write over the harness itself.
    expect(() => resolveVenturesRoot(parent, { coreRoot: core })).toThrow(
      /must not contain the Venture Harness repository/,
    );
    // A sibling is the supported layout.
    const sibling = join(parent, "ventures");
    expect(resolveVenturesRoot(sibling, { coreRoot: core })).toBe(realpathSync(sibling));
  });

  it("refuses a symlinked ventures root and sees through a symlinked ancestor", () => {
    const parent = temporaryDirectory("vh-parent-");
    const core = join(parent, "venture-harness");
    mkdirSync(join(core, "ventures"), { recursive: true });
    const link = join(parent, "linked-ventures");
    symlinkSync(join(core, "ventures"), link);

    expect(() => resolveVenturesRoot(link, { coreRoot: core })).toThrow(/symbolic link/);
  });

  it("creates a missing ventures root instead of failing the first launch", () => {
    const parent = temporaryDirectory("vh-parent-");
    const core = join(parent, "venture-harness");
    mkdirSync(core, { recursive: true });
    const target = join(parent, "ventures", "nested");
    expect(resolveVenturesRoot(target, { coreRoot: core })).toBe(realpathSync(target));
  });

  it("resolves the configured root and names the exact action when none is set", () => {
    const parent = temporaryDirectory("vh-parent-");
    const core = join(parent, "venture-harness");
    mkdirSync(core, { recursive: true });
    const configPath = join(parent, "founder.json");

    expect(configuredVenturesRoot({ coreRoot: core, configPath })).toBeUndefined();
    expect(VENTURES_ROOT_UNSET_MESSAGE).toContain("vh config set ventures-root");

    saveFounderConfig({ schemaVersion: 1, venturesRoot: join(parent, "ventures") }, configPath);
    expect(configuredVenturesRoot({ coreRoot: core, configPath })).toBe(
      realpathSync(join(parent, "ventures")),
    );
  });

  it("keeps each venture a direct child of the ventures root", () => {
    const root = temporaryDirectory("vh-ventures-");
    expect(venturePathWithin(root, "launch-receipt")).toBe(join(root, "launch-receipt"));
    expect(() => venturePathWithin(root, "../escape")).toThrow(/direct child/);
    expect(() => venturePathWithin(root, "nested/venture")).toThrow(/direct child/);
    expect(() => venturePathWithin(root, "/absolute")).toThrow(/direct child/);
  });
});
