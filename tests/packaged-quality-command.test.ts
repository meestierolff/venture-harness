import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVentureRuntime } from "../packages/agent-runtime/src/index";
import { defineCommandContract } from "../packages/command-bus/src/index";
import { defineRuntimeSchema, objectValue, schemaObject } from "../packages/config/src/index";
import {
  createProcessQualityProfileRunner,
  invokeOperationalCli,
} from "../packages/cli-generator/src/index";
import type { CommandExecutionContext } from "../packages/core/src/index";
import type { JsonObject } from "../packages/core/src/index";

const roots: string[] = [];
const context: CommandExecutionContext = {
  identity: { actorId: "quality-operator", kind: "user" },
  tenant: { organizationId: "quality-org", ventureId: "quality-venture" },
  subscription: { subscriptionId: "quality-none", status: "none", plan: "local" },
  entitlements: [],
  scopes: [],
  grants: [],
};

afterEach(() => {
  delete process.env.VH_QUALITY_TEST_SECRET;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "vh-quality-command-"));
  roots.push(directory);
  return directory;
}

function processRunner(directory: string) {
  const fixture = resolve("tests/fixtures/quality-profile-process.mjs");
  return createProcessQualityProfileRunner({
    root: directory,
    commands: {
      fast: [process.execPath, fixture, "{profile}", "{report}", "pass"],
      mvp: [process.execPath, fixture, "{profile}", "{report}", "fail"],
      release: [process.execPath, fixture, "{profile}", "{report}", "skip"],
    },
  });
}

describe("packaged quality command", () => {
  it("executes distinct argv-only profiles and treats failure or skip as non-pass", async () => {
    const directory = root();
    process.env.VH_QUALITY_TEST_SECRET = "quality-secret-canary-value";
    const runner = processRunner(directory);

    const fast = await runner.run("fast");
    const mvp = await runner.run("mvp");
    const release = await runner.run("release");

    expect(fast).toMatchObject({ profile: "fast", status: "PASS", exitCode: 0 });
    expect(mvp).toMatchObject({ profile: "mvp", status: "FAIL", exitCode: 1 });
    expect(release).toMatchObject({ profile: "release", status: "INCOMPLETE", exitCode: 1 });
    for (const result of [fast, mvp, release]) {
      expect(result.command).toContain(result.profile);
      expect(result.stdout).not.toContain("quality-secret-canary-value");
      expect(result.stdout).toContain("[REDACTED]");
    }
  });

  it("propagates PASS, FAIL, INCOMPLETE, and invalid profiles through vh exit codes", async () => {
    const directory = root();
    const run = vi.fn(processRunner(directory).run);
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: context.tenant.organizationId,
          actorId: context.identity.actorId,
          role: "operator",
          active: true,
        },
      ],
      qualityProfileRunner: { run },
      growthContractRoot: directory,
    });
    const invoke = (profile: string) =>
      invokeOperationalCli(runtime.bus, ["verify", profile, "--json"], {
        context,
        idempotencyKey: `quality-${profile}`,
      });

    expect(await invoke("fast")).toMatchObject({ exitCode: 0 });
    expect(await invoke("mvp")).toMatchObject({ exitCode: 1 });
    expect(await invoke("release")).toMatchObject({ exitCode: 1 });
    const invalid = await invoke("everything");
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      error: "command_failed",
      code: "invalid_input",
      message: expect.stringContaining("profile must be one of fast, mvp, release"),
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects a quality command that recursively invokes vh verify", () => {
    expect(() =>
      createProcessQualityProfileRunner({
        root: root(),
        commands: {
          fast: ["vh", "verify", "fast"],
          mvp: ["vh", "verify", "mvp"],
          release: ["vh", "verify", "release"],
        },
      }),
    ).toThrow("must not recurse into vh verify");
  });

  it("routes exact injected commands, never aliases unknown mutations, and renders human output", async () => {
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: context.tenant.organizationId,
          actorId: context.identity.actorId,
          role: "operator",
          active: true,
        },
      ],
    });
    const emptyInput = defineRuntimeSchema<JsonObject>({
      name: "EmptyInjectedInput",
      jsonSchema: schemaObject({}, []),
      parse(value) {
        objectValue(value, "EmptyInjectedInput");
        return {};
      },
    });
    const injectedOutput = defineRuntimeSchema<JsonObject>({
      name: "InjectedAuthOutput",
      jsonSchema: schemaObject(
        { commandId: { const: "auth.connect" }, status: { const: "ready" } },
        ["commandId", "status"],
      ),
      parse(value) {
        const output = objectValue(value, "InjectedAuthOutput");
        if (output.commandId !== "auth.connect" || output.status !== "ready") {
          throw new Error("invalid injected auth output");
        }
        return { commandId: "auth.connect", status: "ready" };
      },
    });
    const injected = defineCommandContract({
      id: "auth.connect",
      version: 1,
      title: "Connect provider authorization",
      description: "Fixture contract proving exact injected CLI routing.",
      input: emptyInput,
      output: injectedOutput,
      requirements: { activeSubscription: false, entitlements: [], grant: false, scopes: [] },
      effect: "read",
    });
    runtime.bus.register(injected, () => ({ commandId: "auth.connect", status: "ready" }));

    const exact = await invokeOperationalCli(runtime.bus, ["auth", "connect", "--json"], {
      context,
      idempotencyKey: "injected-auth",
    });
    expect(JSON.parse(exact.stdout)).toEqual({ commandId: "auth.connect", status: "ready" });

    for (const [args, expected] of [
      [["upgrade", "apply", "--json"], "requires --release"],
      [["fleet", "rollout", "--json"], "requires --run-id, --release-id"],
      [["upgrade", "publish", "--json"], "choose vh upgrade plan|dry-run|apply|status"],
    ] as const) {
      const missing = await invokeOperationalCli(runtime.bus, args, {
        context,
        idempotencyKey: args.join("-"),
      });
      expect(missing).toMatchObject({ exitCode: 1, stdout: "" });
      expect(JSON.parse(missing.stderr)).toMatchObject({
        error: "operational_command_failed",
        message: expect.stringContaining(expected),
      });
    }

    const human = await invokeOperationalCli(runtime.bus, ["doctor"], {
      context,
      idempotencyKey: "human-doctor",
    });
    expect(human).toMatchObject({ exitCode: 0, stderr: "" });
    expect(human.stdout).toMatch(/^system\.doctor: /);
    expect(() => JSON.parse(human.stdout)).toThrow();
  });
});
