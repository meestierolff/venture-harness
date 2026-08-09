import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { InMemoryAuditChain } from "../packages/audit/src/index";
import { createAgentGateway } from "../packages/agent-gateway/src/index";
import {
  InMemoryOperationalStateStore,
  createVentureRuntime,
  operationalCommandContracts,
  ventureCommandContracts,
} from "../packages/agent-runtime/src/index";
import {
  COMMAND_SECURITY_AUDIT_TENANT,
  commandFailureEnvelope,
  commandFailureHttpStatus,
  type CommandFailureEnvelope,
} from "../packages/command-bus/src/index";
import type { CommandExecutionContext, JsonValue } from "../packages/core/src/index";
import { InMemoryEventLog } from "../packages/events/src/index";
import { InMemoryMeteringSink } from "../packages/telemetry/src/index";

const context: CommandExecutionContext = {
  identity: { actorId: "operator-1", kind: "user" },
  tenant: { organizationId: "org-acme", ventureId: "venture-alpha" },
  subscription: { subscriptionId: "sub-1", status: "active", plan: "growth" },
  entitlements: ["campaigns.launch", "launch.execute"],
  scopes: ["campaigns:write", "launch:execute"],
  grants: [
    {
      grantId: "grant-1",
      commandIds: ["campaigns.launch", "launch.execute"],
      scopes: ["campaigns:write", "launch:execute"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ],
};

const inputs: Record<string, JsonValue> = {
  "campaigns.launch": {
    campaignId: "campaign-summer",
    channel: "organic",
    objective: "Validate qualified demand",
  },
  "launch.execute": { launchId: "launch-preview-1", mode: "preview", dryRun: true },
};

function runtimeWithEvidence(options: { growthContractRoot?: string } = {}) {
  const audit = new InMemoryAuditChain();
  const events = new InMemoryEventLog();
  const metering = new InMemoryMeteringSink();
  const runtime = createVentureRuntime({
    commandExecutionMode: "fixture",
    memberships: [
      { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
    ],
    audit,
    events,
    metering,
    growthContractRoot: options.growthContractRoot,
    now: () => new Date("2026-08-09T08:00:00.000Z"),
  });
  return { runtime, audit, events, metering };
}

describe("one command catalog drives every Agent Surface", () => {
  async function failureParity(options: {
    runtime: ReturnType<typeof runtimeWithEvidence>["runtime"];
    commandId: string;
    input: unknown;
    executionContext: CommandExecutionContext;
    idempotencyKey: string;
  }): Promise<CommandFailureEnvelope[]> {
    const gateway = createAgentGateway(options.runtime);
    const contract = options.runtime.contracts.find(({ id }) => id === options.commandId)!;
    const invocation = {
      context: options.executionContext,
      idempotencyKey: options.idempotencyKey,
    };
    const caught = (promise: Promise<unknown>) =>
      promise.then(
        () => {
          throw new Error("expected command surface failure");
        },
        (error: unknown) => commandFailureEnvelope(error),
      );
    const direct = await caught(
      gateway.direct.execute(options.commandId, options.input, invocation),
    );
    const rest = await gateway.rest.handle({
      method: "POST",
      path: contract.surfaces.rest.path,
      body: options.input,
      ...invocation,
    });
    const cli = await gateway.cli.invoke(
      [...contract.surfaces.cli.tokens, "--input", JSON.stringify(options.input), "--json"],
      invocation,
    );
    const mcp = await caught(
      gateway.mcp.callTool(contract.surfaces.mcp.tool, options.input, invocation),
    );
    const sdk = await caught(
      gateway.sdk.commands[contract.surfaces.sdk.namespace]![contract.surfaces.sdk.method]!(
        options.input,
        invocation,
      ),
    );
    const ui = await caught(
      gateway.ui
        .find(({ commandId }) => commandId === options.commandId)!
        .invoke(options.input, invocation),
    );
    expect(cli.exitCode).toBe(1);
    expect(cli.failure).toBeDefined();
    expect(rest.status).toBe(commandFailureHttpStatus(direct.code));
    expect(cli.stdout).toBe("");
    expect(JSON.parse(cli.stderr)).toEqual(cli.failure);
    return [direct, rest.body as CommandFailureEnvelope, cli.failure!, mcp, sdk, ui];
  }

  function expectFailureParity(
    failures: readonly CommandFailureEnvelope[],
    code: CommandFailureEnvelope["code"],
  ): void {
    expect(failures).toHaveLength(6);
    expect(new Set(failures.map((failure) => failure.code))).toEqual(new Set([code]));
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(1);
    expect(failures.every(({ error }) => error === "command_failed")).toBe(true);
  }

  it("maps unsafe command stores before the general idempotency conflict category", () => {
    expect(commandFailureHttpStatus("idempotency_store_unsafe")).toBe(503);
    expect(commandFailureHttpStatus("evidence_sink_unsafe")).toBe(503);
    expect(commandFailureHttpStatus("idempotency_conflict")).toBe(409);
  });

  it("returns one failure envelope for an unconfigured provider apply on all six surfaces", async () => {
    const { runtime } = runtimeWithEvidence();
    const providerContext: CommandExecutionContext = {
      ...context,
      scopes: ["provider.apply"],
      grants: [
        {
          grantId: "provider-apply-grant",
          commandIds: ["provider.apply"],
          scopes: ["provider.apply"],
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    };
    const failures = await failureParity({
      runtime,
      commandId: "provider.apply",
      input: {
        organizationId: "org-acme",
        providerId: "creative_generation",
        providerAccountId: "account-unconfigured",
        feature: "creative.video.generate",
        operationId: "operation-unconfigured",
        providerIdempotencyKey: "provider-key-unconfigured",
        payload: { assetRef: "asset://fixture/input" },
      },
      executionContext: providerContext,
      idempotencyKey: "unconfigured-provider-six-surfaces",
    });
    expectFailureParity(failures, "handler_failed");
    expect(failures[0]?.message).toContain("transport_missing");
  });

  it("derives venture-specific, non-generic names and OpenAPI operations", () => {
    const { runtime } = runtimeWithEvidence();
    const gateway = createAgentGateway(runtime);
    const ventureContracts = runtime.contracts.filter(({ id }) =>
      ["campaigns.launch", "launch.execute"].includes(id),
    );
    expect(ventureContracts.map(({ id }) => id)).toEqual(["campaigns.launch", "launch.execute"]);
    expect(ventureContracts.map(({ surfaces }) => surfaces)).toMatchObject([
      {
        rest: { path: "/v1/commands/campaigns.launch", operationId: "campaignsLaunch" },
        cli: { tokens: ["campaigns", "launch"] },
        mcp: { tool: "campaigns_launch" },
        sdk: { namespace: "campaigns", method: "launch" },
        ui: { actionId: "campaigns.launch", label: "Launch Campaign" },
      },
      {
        rest: { path: "/v1/commands/launch.execute", operationId: "launchExecute" },
        cli: { tokens: ["launch", "execute"] },
        mcp: { tool: "launch_execute" },
        sdk: { namespace: "launch", method: "execute" },
        ui: { actionId: "launch.execute", label: "Execute Venture Launch" },
      },
    ]);
    expect(gateway.rest.openApi.paths).toHaveProperty("/v1/commands/campaigns.launch");
    expect(gateway.rest.openApi.paths).toHaveProperty("/v1/commands/launch.execute");
    expect(gateway.mcp.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["campaigns_launch", "launch_execute"]),
    );
  });

  for (const contract of ventureCommandContracts) {
    it(`returns parity for ${contract.id} through direct, REST, CLI, MCP, SDK, and UI`, async () => {
      const { runtime } = runtimeWithEvidence();
      const gateway = createAgentGateway(runtime);
      const input = inputs[contract.id]!;
      const invoke = (suffix: string) => ({ context, idempotencyKey: `${contract.id}:${suffix}` });

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

      expect(rest).toMatchObject({ status: 200, body: direct });
      expect(JSON.parse(cli.stdout)).toEqual(direct);
      expect(cli.exitCode).toBe(0);
      expect(mcp).toEqual(direct);
      expect(sdk).toEqual(direct);
      expect(ui).toEqual(direct);
    });
  }

  it("derives every packaged operational surface from typed contracts", () => {
    const { runtime } = runtimeWithEvidence();
    const gateway = createAgentGateway(runtime);
    expect(operationalCommandContracts.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "system.doctor",
        "idea.compile",
        "venture.create",
        "venture.plan",
        "venture.launch",
        "venture.status",
        "venture.resume",
        "org.list",
        "stack.list",
        "pack.list",
        "seed.list",
        "grant.list",
        "provider.list",
        "data.sync",
        "learn.run",
        "growth.inspect",
        "auth.login",
        "auth.status",
        "auth.test",
        "auth.revoke",
        "fleet.status",
        "fleet.plan",
        "fleet.rollout",
        "fleet.resume",
        "upgrade.plan",
        "upgrade.dry-run",
        "upgrade.apply",
        "upgrade.status",
        "verify.run",
      ]),
    );
    for (const contract of operationalCommandContracts) {
      expect(gateway.rest.openApi.paths).toHaveProperty(contract.surfaces.rest.path);
      expect(gateway.mcp.tools).toContainEqual(
        expect.objectContaining({ name: contract.surfaces.mcp.tool, commandId: contract.id }),
      );
      expect(gateway.sdk.commands[contract.surfaces.sdk.namespace]).toHaveProperty(
        contract.surfaces.sdk.method,
      );
      expect(gateway.ui).toContainEqual(
        expect.objectContaining({ actionId: contract.id, commandId: contract.id }),
      );
    }
  });

  it("keeps growth.inspect identical across direct, REST, CLI, MCP, SDK, and UI", async () => {
    const { runtime } = runtimeWithEvidence();
    const gateway = createAgentGateway(runtime);
    const contract = runtime.contracts.find(({ id }) => id === "growth.inspect")!;
    const input = { path: resolve("config/growth.yaml") };
    const invoke = (surface: string) => ({
      context,
      idempotencyKey: `growth-inspect:${surface}`,
    });

    const direct = await gateway.direct.execute("growth.inspect", input, invoke("direct"));
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
    const sdk = await gateway.sdk.commands.growth!.inspect!(input, invoke("sdk"));
    const ui = await gateway.ui
      .find(({ actionId }) => actionId === "growth.inspect")!
      .invoke(input, invoke("ui"));

    expect(direct).toMatchObject({
      commandId: "growth.inspect",
      mode: "read_only",
      status: "valid",
      data: {
        schemaVersion: 2,
        originalSchemaVersion: 2,
        migrationApplied: false,
        venture: { ventureId: "sample-venture", currency: "EUR" },
        budgets: { totalTestBudgetMinor: 10_000, perCreativeCapMinor: 10_000 },
        organic: {
          maxAccounts: 2,
          maxPostsPerAccountPerDay: 3,
          defaultReviewMode: "REVIEW_BEFORE_PUBLISH",
        },
        paid: {
          dailyAccountCapMinor: 12_000,
          monthlyVentureCapMinor: 100_000,
          autoPauseAllowed: true,
          autoScaleAllowed: false,
          vboPolicy: "requires_value_ready",
        },
        compliance: {
          rightsRequired: true,
          allowedGeographies: ["NL", "BE"],
          providerPolicyState: "unknown",
        },
        externalEffects: false,
      },
    });
    expect(rest).toEqual({ status: 200, body: direct });
    expect(cli.exitCode, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(direct);
    expect(mcp).toEqual(direct);
    expect(sdk).toEqual(direct);
    expect(ui).toEqual(direct);
  });

  it("migrates v1 only in memory and never returns extension secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-growth-contract-"));
    const current = parseYaml(readFileSync(resolve("config/growth.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    const currentPaid = current.paid as Record<string, unknown>;
    const legacy = structuredClone(current);
    const legacyPaid = legacy.paid as Record<string, unknown>;
    legacy.contract_version = 1;
    legacyPaid.per_creative_test_budget_minor = currentPaid.per_creative_cap_minor;
    delete legacyPaid.test_budget_minor;
    delete legacyPaid.per_creative_cap_minor;
    legacy.extensions = { private_note: "Bearer growth-secret-never-print" };
    const source = stringifyYaml(legacy);
    const path = join(directory, "growth-v1.yaml");
    writeFileSync(path, source);

    const { runtime } = runtimeWithEvidence({ growthContractRoot: directory });
    const output = await runtime.execute(
      "growth.inspect",
      { path },
      {
        context,
        idempotencyKey: "growth-v1",
      },
    );
    expect(output).toMatchObject({
      commandId: "growth.inspect",
      data: {
        schemaVersion: 2,
        originalSchemaVersion: 1,
        migrationApplied: true,
        budgets: { totalTestBudgetMinor: 10_000, perCreativeCapMinor: 10_000 },
      },
    });
    expect(JSON.stringify(output)).not.toContain("growth-secret-never-print");
    expect(readFileSync(path, "utf8")).toBe(source);
  });

  it("fails invalid Growth Contract files closed without echoing their contents", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-growth-invalid-"));
    const canary = "Bearer growth-invalid-never-print";
    const path = join(directory, "invalid-growth.yaml");
    writeFileSync(path, `contract_version: 2\nextensions:\n  private_note: ${canary}\n`);
    const { runtime } = runtimeWithEvidence({ growthContractRoot: directory });
    const gateway = createAgentGateway(runtime);
    const invocation = { context, idempotencyKey: "growth-invalid" };

    await expect(runtime.execute("growth.inspect", { path }, invocation)).rejects.toThrow(
      "growth contract failed schema validation",
    );
    const rest = await gateway.rest.handle({
      method: "POST",
      path: "/v1/commands/growth.inspect",
      body: { path },
      context,
      idempotencyKey: "growth-invalid-rest",
    });
    const cli = await gateway.cli.invoke(
      ["growth", "inspect", "--input", JSON.stringify({ path })],
      { context, idempotencyKey: "growth-invalid-cli" },
    );
    expect(JSON.stringify(rest)).not.toContain(canary);
    expect(`${cli.stdout}\n${cli.stderr}`).not.toContain(canary);
    expect(rest).toMatchObject({
      status: 500,
      body: {
        error: "command_failed",
        code: "handler_failed",
        message: "growth contract failed schema validation",
      },
    });
    expect(cli).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "growth contract failed schema validation",
      failure: { code: "handler_failed" },
    });
  });

  it("contains Growth Contract reads to the configured root and rejects symlink escapes", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "vh-growth-root-"));
    const outsideDirectory = mkdtempSync(join(tmpdir(), "vh-growth-outside-"));
    const outsidePath = join(outsideDirectory, "growth.yaml");
    const canary = "Bearer growth-path-escape-never-print";
    const outsideContract = parseYaml(
      readFileSync(resolve("config/growth.yaml"), "utf8"),
    ) as Record<string, unknown>;
    outsideContract.venture_id = canary;
    writeFileSync(outsidePath, stringifyYaml(outsideContract));
    const symlinkPath = join(rootDirectory, "linked-growth.yaml");
    symlinkSync(outsidePath, symlinkPath);

    const { runtime } = runtimeWithEvidence({ growthContractRoot: rootDirectory });
    const gateway = createAgentGateway(runtime);

    const absoluteMessage = await runtime
      .execute(
        "growth.inspect",
        { path: outsidePath },
        { context, idempotencyKey: "growth-absolute-escape" },
      )
      .then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(absoluteMessage).toBe("growth contract path must stay within the configured root");

    const traversal = await gateway.rest.handle({
      method: "POST",
      path: "/v1/commands/growth.inspect",
      body: { path: relative(rootDirectory, outsidePath) },
      context,
      idempotencyKey: "growth-traversal-escape",
    });
    expect(traversal).toMatchObject({
      status: 500,
      body: {
        error: "command_failed",
        code: "handler_failed",
        message: "growth contract path must stay within the configured root",
      },
    });

    const symlinkMessage = await gateway.mcp
      .callTool(
        "growth_inspect",
        { path: "linked-growth.yaml" },
        { context, idempotencyKey: "growth-symlink-escape" },
      )
      .then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(symlinkMessage).toBe("growth contract path must not contain symbolic links");

    const evidence = JSON.stringify({ absoluteMessage, traversal, symlinkMessage });
    expect(evidence).not.toContain(canary);
    expect(evidence).not.toContain(outsidePath);
  });

  it("keeps new lifecycle business commands identical across direct, REST, CLI, MCP, SDK, and UI", async () => {
    type Surface = "direct" | "rest" | "cli" | "mcp" | "sdk" | "ui";
    const surfaces: Surface[] = ["direct", "rest", "cli", "mcp", "sdk", "ui"];
    const businessCommands = [
      {
        id: "idea.compile",
        input: { idea: "A local evidence notebook", ventureId: "ops-parity", name: "Ops Parity" },
        prepare: [] as string[],
      },
      {
        id: "venture.create",
        input: { ventureId: "ops-parity", name: "Ops Parity" },
        prepare: ["idea.compile"],
      },
      {
        id: "venture.plan",
        input: { ventureId: "ops-parity" },
        prepare: ["idea.compile", "venture.create"],
      },
      {
        id: "venture.launch",
        input: { ventureId: "ops-parity", runId: "run-ops-parity", dryRun: true },
        prepare: ["idea.compile", "venture.create", "venture.plan"],
      },
      {
        id: "venture.resume",
        input: { runId: "run-ops-parity" },
        prepare: ["idea.compile", "venture.create", "venture.plan", "venture.launch"],
      },
    ] as const;
    const prerequisiteInput: Record<string, JsonValue> = {
      "idea.compile": {
        idea: "A local evidence notebook",
        ventureId: "ops-parity",
        name: "Ops Parity",
      },
      "venture.create": { ventureId: "ops-parity", name: "Ops Parity" },
      "venture.plan": { ventureId: "ops-parity" },
      "venture.launch": {
        ventureId: "ops-parity",
        runId: "run-ops-parity",
        dryRun: true,
      },
    };

    for (const command of businessCommands) {
      const outputs: JsonValue[] = [];
      for (const surface of surfaces) {
        const operationalStore = new InMemoryOperationalStateStore();
        const runtime = createVentureRuntime({
          commandExecutionMode: "fixture",
          memberships: [
            { organizationId: "org-acme", actorId: "operator-1", role: "operator", active: true },
          ],
          operationalStore,
          now: () => new Date("2026-08-09T08:00:00.000Z"),
        });
        for (const prerequisite of command.prepare) {
          await runtime.execute(prerequisite, prerequisiteInput[prerequisite], {
            context,
            idempotencyKey: `${surface}:${command.id}:prepare:${prerequisite}`,
          });
        }
        const gateway = createAgentGateway(runtime);
        const contract = runtime.contracts.find(({ id }) => id === command.id)!;
        const invocation = {
          context,
          idempotencyKey: `${surface}:${command.id}:invoke`,
        };
        if (surface === "direct") {
          outputs.push(await gateway.direct.execute(command.id, command.input, invocation));
        } else if (surface === "rest") {
          const response = await gateway.rest.handle({
            method: "POST",
            path: contract.surfaces.rest.path,
            body: command.input,
            ...invocation,
          });
          expect(response.status).toBe(200);
          outputs.push(response.body);
        } else if (surface === "cli") {
          const response = await gateway.cli.invoke(
            [...contract.surfaces.cli.tokens, "--input", JSON.stringify(command.input)],
            invocation,
          );
          expect(response.exitCode, response.stderr).toBe(0);
          outputs.push(JSON.parse(response.stdout) as JsonValue);
        } else if (surface === "mcp") {
          outputs.push(
            await gateway.mcp.callTool(contract.surfaces.mcp.tool, command.input, invocation),
          );
        } else if (surface === "sdk") {
          outputs.push(
            await gateway.sdk.commands[contract.surfaces.sdk.namespace]![
              contract.surfaces.sdk.method
            ]!(command.input, invocation),
          );
        } else {
          outputs.push(
            await gateway.ui
              .find(({ actionId }) => actionId === contract.surfaces.ui.actionId)!
              .invoke(command.input, invocation),
          );
        }
      }
      expect(outputs).toHaveLength(surfaces.length);
      for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
    }
  });

  it("isolates packaged operational state by organization", async () => {
    const operationalStore = new InMemoryOperationalStateStore();
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        { organizationId: "org-one", actorId: "operator-1", role: "owner", active: true },
        { organizationId: "org-two", actorId: "operator-1", role: "owner", active: true },
      ],
      operationalStore,
      now: () => new Date("2026-08-09T08:00:00.000Z"),
    });
    const first = {
      ...context,
      tenant: { organizationId: "org-one", ventureId: "shared-id" },
    };
    const second = {
      ...context,
      tenant: { organizationId: "org-two", ventureId: "shared-id" },
    };
    await runtime.execute(
      "idea.compile",
      { idea: "First tenant idea", ventureId: "shared-id", name: "First" },
      { context: first, idempotencyKey: "first-compile" },
    );
    await runtime.execute(
      "venture.create",
      { ventureId: "shared-id", name: "First" },
      { context: first, idempotencyKey: "first-create" },
    );
    await expect(
      runtime.execute(
        "venture.status",
        { ventureId: "shared-id" },
        { context: second, idempotencyKey: "second-status-before-create" },
      ),
    ).rejects.toThrow('venture "shared-id" is not locally created');
    await runtime.execute(
      "idea.compile",
      { idea: "Second tenant idea", ventureId: "shared-id", name: "Second" },
      { context: second, idempotencyKey: "second-compile" },
    );
    const secondCreated = await runtime.execute(
      "venture.create",
      { ventureId: "shared-id", name: "Second" },
      { context: second, idempotencyKey: "second-create" },
    );
    expect(secondCreated).toMatchObject({
      data: { venture: { organizationId: "org-two", name: "Second" } },
    });
  });

  it("fails closed before handler, event, or metering on entitlement/grant denial", async () => {
    const { runtime, audit, events, metering } = runtimeWithEvidence();
    const denied: CommandExecutionContext = { ...context, entitlements: [], grants: [] };
    await expect(
      runtime.execute("campaigns.launch", inputs["campaigns.launch"], {
        context: denied,
        idempotencyKey: "denied-1",
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
    expect(events.read(context.tenant)).toEqual([]);
    expect(metering.read(context.tenant)).toEqual([]);
    expect(audit.read(context.tenant).map(({ outcome }) => outcome)).toEqual([
      "requested",
      "denied",
    ]);
    expect(audit.verify(context.tenant)).toBe(true);
    expect(audit.read({ organizationId: "org-other", ventureId: "venture-other" })).toEqual([]);
  });

  it.each([
    ["identity", { ...context, identity: { ...context.identity, actorId: "" } }],
    [
      "tenant membership",
      { ...context, tenant: { ...context.tenant, organizationId: "org-other" } },
    ],
    [
      "subscription",
      { ...context, subscription: { ...context.subscription, status: "cancelled" as const } },
    ],
    ["entitlement", { ...context, entitlements: [] }],
    ["grant", { ...context, grants: [] }],
    [
      "expired grant",
      {
        ...context,
        grants: [
          {
            ...context.grants[0]!,
            expiresAt: "2026-08-09T07:59:59.000Z",
          },
        ],
      },
    ],
    ["scope", { ...context, scopes: [] }],
  ])("enforces the %s hook", async (_name, denied) => {
    const { runtime, events, metering } = runtimeWithEvidence();
    await expect(
      runtime.execute("campaigns.launch", inputs["campaigns.launch"], {
        context: denied,
        idempotencyKey: `denied-${_name}`,
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
    expect(events.read(denied.tenant)).toEqual([]);
    expect(metering.read(denied.tenant)).toEqual([]);
  });

  it("routes a non-member denial to tenant-free security audit without mutating the claimed tenant", async () => {
    const { runtime, audit } = runtimeWithEvidence();
    const forged: CommandExecutionContext = {
      ...context,
      identity: { actorId: "untrusted-actor", kind: "user" },
      tenant: { organizationId: "org-victim", ventureId: "venture-victim" },
    };
    await expect(
      runtime.execute("campaigns.launch", inputs["campaigns.launch"], {
        context: forged,
        idempotencyKey: "attacker-controlled-key",
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });

    expect(audit.read(forged.tenant)).toEqual([]);
    const securityRecords = audit.read(COMMAND_SECURITY_AUDIT_TENANT);
    expect(securityRecords).toHaveLength(1);
    expect(securityRecords[0]).toMatchObject({
      actorId: "untrusted-actor",
      action: "campaigns.launch",
      outcome: "denied",
      details: { commandId: "campaigns.launch", commandVersion: 1 },
    });
    const serialized = JSON.stringify(securityRecords);
    expect(serialized).not.toContain("org-victim");
    expect(serialized).not.toContain("venture-victim");
    expect(serialized).not.toContain("attacker-controlled-key");
  });

  it("rejects a whitespace-aliased tenant before membership and preserves the canonical audit namespace", async () => {
    const audit = new InMemoryAuditChain();
    const runtime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: " org-acme ",
          actorId: context.identity.actorId,
          role: "operator",
          active: true,
        },
      ],
      audit,
      securityAudit: audit,
      now: () => new Date("2026-08-09T08:00:00.000Z"),
    });
    const aliased: CommandExecutionContext = {
      ...context,
      tenant: { ...context.tenant, organizationId: " org-acme " },
    };

    await expect(
      runtime.execute("campaigns.launch", inputs["campaigns.launch"], {
        context: aliased,
        idempotencyKey: "whitespace-alias",
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });

    expect(audit.read(context.tenant)).toEqual([]);
    expect(audit.read(COMMAND_SECURITY_AUDIT_TENANT)).toHaveLength(1);
  });

  it("reuses idempotent results and records one event and meter", async () => {
    const { runtime, audit, events, metering } = runtimeWithEvidence();
    const invocation = { context, idempotencyKey: "same-request" };
    const first = await runtime.execute("campaigns.launch", inputs["campaigns.launch"], invocation);
    const second = await runtime.execute(
      "campaigns.launch",
      inputs["campaigns.launch"],
      invocation,
    );
    expect(second).toEqual(first);
    expect(events.read(context.tenant)).toHaveLength(1);
    expect(metering.read(context.tenant)).toHaveLength(1);
    expect(audit.verify(context.tenant)).toBe(true);
  });

  it("binds an idempotency key to the canonical command input", async () => {
    const { runtime, events, metering } = runtimeWithEvidence();
    const invocation = { context, idempotencyKey: "request-bound" };
    const original = inputs["campaigns.launch"] as Record<string, JsonValue>;

    const first = await runtime.execute("campaigns.launch", { ...original }, invocation);
    await expect(
      runtime.execute("campaigns.launch", { ...original, channel: "paid" }, invocation),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const replay = await runtime.execute("campaigns.launch", { ...original }, invocation);

    expect(replay).toEqual(first);
    expect(events.read(context.tenant)).toHaveLength(1);
    expect(metering.read(context.tenant)).toHaveLength(1);
  });

  it("preserves validation, authorization, idempotency, and handler error semantics on all surfaces", async () => {
    const invalidRuntime = runtimeWithEvidence().runtime;
    expectFailureParity(
      await failureParity({
        runtime: invalidRuntime,
        commandId: "campaigns.launch",
        input: {},
        executionContext: context,
        idempotencyKey: "parity-invalid",
      }),
      "invalid_input",
    );

    const deniedRuntime = runtimeWithEvidence().runtime;
    expectFailureParity(
      await failureParity({
        runtime: deniedRuntime,
        commandId: "campaigns.launch",
        input: inputs["campaigns.launch"],
        executionContext: { ...context, entitlements: [], grants: [] },
        idempotencyKey: "parity-denied",
      }),
      "authorization_denied",
    );

    const conflictRuntime = runtimeWithEvidence().runtime;
    const conflictKey = "parity-conflict";
    await conflictRuntime.execute("campaigns.launch", inputs["campaigns.launch"], {
      context,
      idempotencyKey: conflictKey,
    });
    expectFailureParity(
      await failureParity({
        runtime: conflictRuntime,
        commandId: "campaigns.launch",
        input: { ...(inputs["campaigns.launch"] as Record<string, JsonValue>), channel: "paid" },
        executionContext: context,
        idempotencyKey: conflictKey,
      }),
      "idempotency_conflict",
    );

    const growthRoot = mkdtempSync(join(tmpdir(), "vh-handler-parity-"));
    const handlerRuntime = runtimeWithEvidence({ growthContractRoot: growthRoot }).runtime;
    expectFailureParity(
      await failureParity({
        runtime: handlerRuntime,
        commandId: "growth.inspect",
        input: { path: "missing-growth.yaml" },
        executionContext: context,
        idempotencyKey: "parity-handler",
      }),
      "handler_failed",
    );
  });
});
