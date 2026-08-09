import { describe, expect, it } from "vitest";
import { InMemoryAuditChain } from "../packages/audit/src/index";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import {
  createVentureRuntime,
  platformOperationCommandContracts,
  type AuthCommandAction,
  type AuthCommandRuntime,
  type FleetCommandAction,
  type FleetCommandRuntime,
  type PlatformOperationBoundary,
  type UpgradeCommandAction,
  type UpgradeCommandRuntime,
} from "../packages/agent-runtime/src/index";
import {
  commandFailureEnvelope,
  commandFailureHttpStatus,
  type CommandFailureEnvelope,
} from "../packages/command-bus/src/index";
import type { CommandExecutionContext, JsonObject, JsonValue } from "../packages/core/src/index";
import { InMemoryEventLog } from "../packages/events/src/index";
import { InMemoryMeteringSink } from "../packages/telemetry/src/index";

const scopes = [
  "auth.manage",
  "auth.read",
  "auth.test",
  "upgrade.read",
  "upgrade.apply",
  "fleet.read",
  "fleet.rollout",
];

const context: CommandExecutionContext = {
  identity: { actorId: "operator-platform", kind: "user" },
  tenant: { organizationId: "org-platform", ventureId: "venture-platform" },
  subscription: { subscriptionId: "operator-subscription", status: "active", plan: "operator" },
  entitlements: [],
  scopes,
  grants: [
    {
      grantId: "platform-commands",
      commandIds: platformOperationCommandContracts.map(({ id }) => id),
      scopes,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ],
};

const inputs: Record<string, JsonObject> = {
  "auth.login": {
    providerId: "github",
    credentialRef: "cred://github/default",
    backend: "cli_session",
    kind: "cli_session",
    scopes: ["repo.read"],
  },
  "auth.status": { providerId: "github" },
  "auth.test": { providerId: "github", credentialRef: "cred://github/default" },
  "auth.revoke": { providerId: "github", credentialRef: "cred://github/default" },
  "upgrade.plan": { releaseLocator: "fixtures/release" },
  "upgrade.dry-run": { releaseLocator: "fixtures/release" },
  "upgrade.apply": { releaseLocator: "fixtures/release" },
  "upgrade.status": {},
  "fleet.status": { runId: "fleet-run-one" },
  "fleet.plan": {
    runId: "fleet-run-one",
    releaseId: "release-one",
    ventureIds: ["venture-platform"],
    batchSize: 1,
  },
  "fleet.rollout": {
    runId: "fleet-run-one",
    releaseId: "release-one",
    ventureIds: ["venture-platform"],
    batchSize: 1,
  },
  "fleet.resume": {
    runId: "fleet-run-one",
    releaseId: "release-one",
    ventureIds: ["venture-platform"],
    batchSize: 1,
  },
};

function success(action: string, domain: string): PlatformOperationBoundary {
  return {
    status:
      action === "status"
        ? "available"
        : action === "plan" || action === "dry_run"
          ? "planned"
          : action === "rollout" || action === "resume"
            ? "completed"
            : `${action}_completed`,
    effect: ["login", "test", "revoke", "apply", "rollout", "resume"].includes(action)
      ? "applied"
      : "none",
    data: { domain, action, fixture: true },
  };
}

function configuredRuntimes() {
  const counts = new Map<string, number>();
  const count = (domain: string, action: string) => {
    const key = `${domain}.${action}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return success(action, domain);
  };
  const auth: AuthCommandRuntime = {
    execute: (action: AuthCommandAction) => count("auth", action),
  };
  const upgrade: UpgradeCommandRuntime = {
    execute: (action: UpgradeCommandAction) => count("upgrade", action),
  };
  const fleet: FleetCommandRuntime = {
    execute: (action: FleetCommandAction) => count("fleet", action),
  };
  return { auth, upgrade, fleet, counts };
}

function runtime(options: { configured: boolean }) {
  const configured = configuredRuntimes();
  const runtime = createVentureRuntime({
    commandExecutionMode: "fixture",
    memberships: [
      {
        organizationId: "org-platform",
        actorId: "operator-platform",
        role: "operator",
        active: true,
      },
    ],
    audit: new InMemoryAuditChain(),
    events: new InMemoryEventLog(),
    metering: new InMemoryMeteringSink(),
    ...(options.configured
      ? {
          authCommandRuntime: configured.auth,
          upgradeCommandRuntime: configured.upgrade,
          fleetCommandRuntime: configured.fleet,
        }
      : {}),
  });
  return { runtime, counts: configured.counts };
}

async function caught(promise: Promise<unknown>): Promise<CommandFailureEnvelope> {
  return promise.then(
    () => {
      throw new Error("expected command failure");
    },
    (error: unknown) => commandFailureEnvelope(error),
  );
}

describe("auth, upgrade, and Fleet command surfaces", () => {
  it("declares exact contracts, effects, grants, scopes, and six derived surfaces", () => {
    const { runtime: commandRuntime } = runtime({ configured: true });
    const gateway = createAgentGateway(commandRuntime);
    const expected = {
      "auth.login": ["write", "auth.manage"],
      "auth.status": ["read", "auth.read"],
      "auth.test": ["write", "auth.test"],
      "auth.revoke": ["write", "auth.manage"],
      "upgrade.plan": ["read", "upgrade.read"],
      "upgrade.dry-run": ["read", "upgrade.read"],
      "upgrade.apply": ["write", "upgrade.apply"],
      "upgrade.status": ["read", "upgrade.read"],
      "fleet.status": ["read", "fleet.read"],
      "fleet.plan": ["read", "fleet.read"],
      "fleet.rollout": ["write", "fleet.rollout"],
      "fleet.resume": ["write", "fleet.rollout"],
    } as const;
    expect(platformOperationCommandContracts.map(({ id }) => id).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const contract of platformOperationCommandContracts) {
      const [effect, scope] = expected[contract.id as keyof typeof expected];
      expect(contract.effect).toBe(effect);
      expect(contract.requirements).toMatchObject({ grant: true, scopes: [scope] });
      expect(gateway.rest.openApi.paths).toHaveProperty(contract.surfaces.rest.path);
      expect(gateway.mcp.tools).toContainEqual(
        expect.objectContaining({ name: contract.surfaces.mcp.tool, commandId: contract.id }),
      );
      expect(gateway.sdk.commands[contract.surfaces.sdk.namespace]).toHaveProperty(
        contract.surfaces.sdk.method,
      );
      expect(gateway.ui).toContainEqual(expect.objectContaining({ actionId: contract.id }));
    }
  });

  for (const contract of platformOperationCommandContracts) {
    it(`keeps ${contract.id} identical across direct, REST, CLI, MCP, SDK, and UI`, async () => {
      const { runtime: commandRuntime } = runtime({ configured: true });
      const gateway = createAgentGateway(commandRuntime);
      const input = inputs[contract.id]!;
      const invoke = (surface: string) => ({
        context,
        idempotencyKey: `${contract.id}-${surface}`,
      });
      const direct = await gateway.direct.execute(contract.id, input, invoke("direct"));
      const rest = await gateway.rest.handle({
        method: "POST",
        path: contract.surfaces.rest.path,
        body: input,
        ...invoke("rest"),
      });
      const cli = await gateway.cli.invoke(
        [...contract.surfaces.cli.tokens, "--input", JSON.stringify(input)],
        invoke("cli"),
      );
      const mcp = await gateway.mcp.callTool(contract.surfaces.mcp.tool, input, invoke("mcp"));
      const sdk = await gateway.sdk.commands[contract.surfaces.sdk.namespace]![
        contract.surfaces.sdk.method
      ]!(input, invoke("sdk"));
      const ui = await gateway.ui
        .find(({ actionId }) => actionId === contract.surfaces.ui.actionId)!
        .invoke(input, invoke("ui"));

      expect(rest).toEqual({ status: 200, body: direct });
      expect(cli).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(cli.stdout) as JsonValue).toEqual(direct);
      expect(mcp).toEqual(direct);
      expect(sdk).toEqual(direct);
      expect(ui).toEqual(direct);
    });
  }

  for (const commandId of ["auth.login", "upgrade.apply", "fleet.rollout"] as const) {
    it(`fails ${commandId} closed with one sanitized error on all six surfaces`, async () => {
      const { runtime: commandRuntime } = runtime({ configured: false });
      const gateway = createAgentGateway(commandRuntime);
      const contract = platformOperationCommandContracts.find(({ id }) => id === commandId)!;
      const input = inputs[contract.id]!;
      const invocation = { context, idempotencyKey: `${commandId}-unconfigured-six-surfaces` };
      const direct = await caught(gateway.direct.execute(contract.id, input, invocation));
      const rest = await gateway.rest.handle({
        method: "POST",
        path: contract.surfaces.rest.path,
        body: input,
        ...invocation,
      });
      const cli = await gateway.cli.invoke(
        [...contract.surfaces.cli.tokens, "--input", JSON.stringify(input), "--json"],
        invocation,
      );
      const mcp = await caught(gateway.mcp.callTool(contract.surfaces.mcp.tool, input, invocation));
      const sdk = await caught(
        gateway.sdk.commands[contract.surfaces.sdk.namespace]![contract.surfaces.sdk.method]!(
          input,
          invocation,
        ),
      );
      const ui = await caught(
        gateway.ui.find(({ actionId }) => actionId === contract.id)!.invoke(input, invocation),
      );
      const failures = [direct, rest.body as CommandFailureEnvelope, cli.failure!, mcp, sdk, ui];
      expect(rest.status).toBe(commandFailureHttpStatus("handler_failed"));
      expect(cli).toMatchObject({ exitCode: 1, stdout: "" });
      expect(JSON.parse(cli.stderr)).toEqual(cli.failure);
      expect(new Set(failures.map(({ code }) => code))).toEqual(new Set(["handler_failed"]));
      expect(new Set(failures.map(({ message }) => message)).size).toBe(1);
      expect(direct.message).toContain(`${commandId.split(".")[0]}_runtime_unconfigured`);
    });
  }

  it("authorizes before handlers and replays a mutation only once per idempotency key", async () => {
    const { runtime: commandRuntime, counts } = runtime({ configured: true });
    const input = inputs["upgrade.apply"]!;
    const invocation = { context, idempotencyKey: "upgrade-apply-once" };
    const first = await commandRuntime.execute("upgrade.apply", input, invocation);
    const replay = await commandRuntime.execute("upgrade.apply", input, invocation);
    expect(replay).toEqual(first);
    expect(counts.get("upgrade.apply")).toBe(1);

    const deniedContext: CommandExecutionContext = { ...context, scopes: [], grants: [] };
    const failure = await caught(
      commandRuntime.execute("fleet.rollout", inputs["fleet.rollout"]!, {
        context: deniedContext,
        idempotencyKey: "fleet-denied",
      }),
    );
    expect(failure.code).toBe("authorization_denied");
    expect(counts.get("fleet.rollout") ?? 0).toBe(0);
  });
});
