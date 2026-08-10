import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("workspace distribution", () => {
  it("packs allowlisted artifacts and runs CLI, SDK, and MCP in a clean consumer", () => {
    const packDirectory = mkdtempSync(join(tmpdir(), "vh-workspace-pack-test-"));
    const consumer = mkdtempSync(join(tmpdir(), "vh-workspace-consumer-"));
    execFileSync(
      process.execPath,
      [resolve(root, "scripts/workspace-pack.mjs"), "--output", packDirectory],
      { cwd: root, stdio: "pipe" },
    );
    const tarballs = readdirSync(packDirectory)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => join(packDirectory, name))
      .sort();
    expect(tarballs).toHaveLength(31);

    for (const tarball of tarballs) {
      const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
        .trim()
        .split("\n");
      expect(entries.some((entry) => entry.includes("/src/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/tests/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/.agents/"))).toBe(false);
      expect(entries.some((entry) => entry.includes("/memory/"))).toBe(false);
    }

    const dependencies: Record<string, string> = {};
    const overrides: Record<string, string> = {};
    for (const tarball of tarballs) {
      const manifest = JSON.parse(
        execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
      ) as { name: string };
      if (manifest.name.startsWith("@venture-harness/")) {
        dependencies[manifest.name] = `file:${tarball}`;
        overrides[manifest.name] = `file:${tarball}`;
      }
    }
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "vh-clean-consumer",
          version: "1.0.0",
          private: true,
          type: "module",
          dependencies,
          pnpm: { overrides },
        },
        null,
        2,
      )}\n`,
    );
    const storeDirectory = execFileSync("pnpm", ["store", "path"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const install = spawnSync(
      "pnpm",
      // --prefer-offline rather than --offline: a `--frozen-lockfile` install
      // resolves from the lockfile and never populates the registry metadata
      // cache, so a strict offline install fails on missing metadata for a
      // third-party dependency rather than on anything this test is about.
      ["install", "--prefer-offline", "--ignore-scripts", "--store-dir", storeDirectory],
      {
        cwd: consumer,
        encoding: "utf8",
      },
    );
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);

    // This suite verifies the cli-generator package itself. Commands such as
    // auth, launch, resume, stack, and upgrade intentionally belong to the
    // founder shell in the public root binary, so invoke the packaged advanced
    // entry directly instead of depending on a package-manager bin collision.
    const advancedCliEntry = join(
      consumer,
      "node_modules",
      "@venture-harness",
      "cli-generator",
      "dist",
      "bin.js",
    );
    const invokeAdvancedCli = (args: readonly string[], timeout = 10_000) =>
      spawnSync(process.execPath, [advancedCliEntry, ...args], {
        cwd: consumer,
        encoding: "utf8",
        timeout,
      });

    const cli = invokeAdvancedCli(["commands"]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).map(({ id }: { id: string }) => id)).toEqual(
      expect.arrayContaining([
        "campaigns.launch",
        "launch.execute",
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
    expect(cli.stderr).not.toContain("tsx");

    const packagedVentureCommand = invokeAdvancedCli([
      "campaigns",
      "launch",
      "--input",
      JSON.stringify({
        campaignId: "packed-cli",
        channel: "organic",
        objective: "prove the bundled command bus",
      }),
      "--context",
      JSON.stringify({
        identity: { actorId: "consumer", kind: "user" },
        tenant: { organizationId: "org-consumer", ventureId: "venture-consumer" },
        subscription: { subscriptionId: "sub-consumer", status: "active", plan: "test" },
        entitlements: ["campaigns.launch"],
        scopes: ["campaigns:write"],
        grants: [
          {
            grantId: "grant-consumer",
            commandIds: ["campaigns.launch"],
            scopes: ["campaigns:write"],
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
      "--idempotency-key",
      "packed-cli-campaign",
    ]);
    expect(packagedVentureCommand.status, packagedVentureCommand.stderr).toBe(0);
    expect(packagedVentureCommand.stdout.trim()).toBe("campaigns.launch: planned");
    expect(packagedVentureCommand.stderr).not.toContain("tsx");

    writeFileSync(
      join(consumer, "consumer.mjs"),
      `import { createVentureRuntime } from "@venture-harness/agent-runtime";
import { createSdkSurface } from "@venture-harness/sdk-generator";
import { createMcpSurface } from "@venture-harness/mcp-generator";
const context = {
  identity: { actorId: "consumer", kind: "user" },
  tenant: { organizationId: "org-consumer", ventureId: "venture-consumer" },
  subscription: { subscriptionId: "sub-consumer", status: "active", plan: "test" },
  entitlements: ["campaigns.launch", "launch.execute"],
  scopes: ["campaigns:write", "launch:execute"],
  grants: [{ grantId: "grant-consumer", commandIds: ["campaigns.launch", "launch.execute"], scopes: ["campaigns:write", "launch:execute"], expiresAt: "2099-01-01T00:00:00.000Z" }]
};
const runtime = createVentureRuntime({ commandExecutionMode: "fixture", memberships: [{ organizationId: "org-consumer", actorId: "consumer", role: "owner", active: true }] });
const sdk = createSdkSurface(runtime.bus);
const mcp = createMcpSurface(runtime.bus);
const campaign = await sdk.commands.campaigns.launch({ campaignId: "clean", channel: "organic", objective: "prove package" }, { context, idempotencyKey: "sdk-clean" });
const launch = await mcp.callTool("launch_execute", { launchId: "clean", mode: "preview", dryRun: true }, { context, idempotencyKey: "mcp-clean" });
console.log(JSON.stringify({ campaign, launch, tools: mcp.tools.map(({ name }) => name).filter((name) => ["campaigns_launch", "launch_execute"].includes(name)) }));
`,
    );
    const consumerRun = spawnSync(process.execPath, ["consumer.mjs"], {
      cwd: consumer,
      encoding: "utf8",
    });
    expect(consumerRun.status, consumerRun.stderr).toBe(0);
    expect(JSON.parse(consumerRun.stdout)).toMatchObject({
      campaign: { commandId: "campaigns.launch", ventureId: "venture-consumer" },
      launch: { commandId: "launch.execute", ventureId: "venture-consumer" },
      tools: ["campaigns_launch", "launch_execute"],
    });

    writeFileSync(
      join(consumer, "consumer.cjs"),
      `const { tenantKey } = require("@venture-harness/core");
const { InMemoryAssetVault } = require("@venture-harness/assets");
const tenant = { organizationId: "org-cjs", ventureId: "venture-cjs" };
const vault = new InMemoryAssetVault();
const asset = vault.put(tenant, "asset-cjs", "text/plain", new TextEncoder().encode("safe"));
console.log(JSON.stringify({ tenant: tenantKey(tenant), sha256: asset.sha256 }));
`,
    );
    const commonJsConsumerRun = spawnSync(process.execPath, ["consumer.cjs"], {
      cwd: consumer,
      encoding: "utf8",
    });
    expect(commonJsConsumerRun.status, commonJsConsumerRun.stderr).toBe(0);
    expect(JSON.parse(commonJsConsumerRun.stdout)).toMatchObject({
      tenant: "org-cjs:venture-cjs",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const stateDirectory = join(consumer, "operational-state");
    mkdirSync(join(consumer, "config"), { recursive: true });
    const growthV2Source = readFileSync(join(root, "config/growth.yaml"), "utf8");
    writeFileSync(join(consumer, "config/growth.yaml"), growthV2Source);
    const invokeVh = (...args: string[]) => {
      const invocation = invokeAdvancedCli([...args, "--state-dir", stateDirectory, "--json"]);
      expect(invocation.error, invocation.stderr).toBeUndefined();
      expect(invocation.stderr).not.toContain("tsx");
      return invocation;
    };

    writeFileSync(
      join(consumer, "vh-runtime.mjs"),
      readFileSync(join(root, "tests/fixtures/packed-production-runtime.mjs"), "utf8"),
    );
    const productionContext = {
      identity: { actorId: "operator-consumer", kind: "user" },
      tenant: { organizationId: "org-consumer", ventureId: "venture-consumer" },
      subscription: { subscriptionId: "provider-operator", status: "active", plan: "operator" },
      entitlements: [],
      scopes: [
        "provider.apply",
        "provider.read",
        "auth.manage",
        "auth.read",
        "auth.test",
        "upgrade.read",
        "upgrade.apply",
        "fleet.read",
        "fleet.rollout",
      ],
      grants: [
        {
          grantId: "packed-production-grant",
          commandIds: [
            "provider.apply",
            "provider.read-back",
            "stack.apply",
            "stack.read-back",
            "auth.login",
            "auth.status",
            "auth.test",
            "auth.revoke",
            "upgrade.plan",
            "upgrade.dry-run",
            "upgrade.apply",
            "upgrade.status",
            "fleet.status",
            "fleet.plan",
            "fleet.rollout",
            "fleet.resume",
          ],
          scopes: [
            "provider.apply",
            "provider.read",
            "auth.manage",
            "auth.read",
            "auth.test",
            "upgrade.read",
            "upgrade.apply",
            "fleet.read",
            "fleet.rollout",
          ],
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    };
    let productionInvocation = 0;
    const invokeProductionVhWithKey = (idempotencyKey: string, ...command: string[]) =>
      invokeAdvancedCli([
        ...command,
        "--runtime-module",
        "vh-runtime.mjs",
        "--project-root",
        consumer,
        "--state-dir",
        ".trusted-runtime",
        "--context",
        JSON.stringify(productionContext),
        "--idempotency-key",
        idempotencyKey,
        "--json",
      ]);
    const invokeProductionVh = (...command: string[]) =>
      invokeProductionVhWithKey(`packed-production-${++productionInvocation}`, ...command);
    const providerInput = {
      organizationId: "org-consumer",
      providerId: "creative_generation",
      providerAccountId: "creative-account",
      feature: "creative.video.generate",
      operationId: "packed-provider-operation",
      providerIdempotencyKey: "packed-provider-idempotency",
      payload: { creativeId: "creative-packed", assetRef: "asset://packed/input" },
    };
    const providerApply = invokeProductionVh(
      "provider",
      "apply",
      "--input",
      JSON.stringify(providerInput),
    );
    const providerReadBack = invokeProductionVh(
      "provider",
      "read-back",
      "--input",
      JSON.stringify(providerInput),
    );
    expect(providerApply.status, providerApply.stderr).toBe(0);
    expect(providerReadBack.status, providerReadBack.stderr).toBe(0);
    expect(JSON.parse(providerApply.stdout)).toMatchObject({
      status: "accepted_unverified",
      providerInvoked: true,
      liveVerified: false,
      data: { evidenceClass: "fixture", fixtureOfficialTransport: true },
    });
    expect(JSON.parse(providerReadBack.stdout)).toMatchObject({
      status: "verified_fixture",
      data: { evidenceClass: "fixture", matched: true, reapplied: false },
    });

    const stackInput = {
      profileId: "packed-fixture",
      profileVersion: "0.2.0",
      role: "hosting.web.deploy",
      providerId: "vercel",
      capability: "deployment",
      environment: "production",
      operationId: "packed-stack-operation",
      payload: { project: "packed-fixture" },
    };
    const stackApply = invokeProductionVh("stack", "apply", "--input", JSON.stringify(stackInput));
    const stackReadBack = invokeProductionVh(
      "stack",
      "read-back",
      "--input",
      JSON.stringify(stackInput),
    );
    expect(stackApply.status, stackApply.stderr).toBe(0);
    expect(stackReadBack.status, stackReadBack.stderr).toBe(0);
    expect(JSON.parse(stackApply.stdout)).toMatchObject({
      status: "applied_unverified",
      providerInvoked: true,
      data: { evidenceClass: "fixture", fixtureOfficialTransport: true },
    });
    expect(JSON.parse(stackReadBack.stdout)).toMatchObject({
      status: "verified_fixture",
      data: { evidenceClass: "fixture", matched: true, reapplied: false },
    });

    const authLogin = invokeProductionVhWithKey(
      "packed-auth-login-once",
      "auth",
      "login",
      "github",
      "--ref",
      "cred://github/packed-fixture",
      "--backend",
      "cli_session",
      "--kind",
      "cli_session",
    );
    const authReplay = invokeProductionVhWithKey(
      "packed-auth-login-once",
      "auth",
      "login",
      "github",
      "--ref",
      "cred://github/packed-fixture",
      "--backend",
      "cli_session",
      "--kind",
      "cli_session",
    );
    expect(authLogin.status, authLogin.stderr).toBe(0);
    expect(authReplay.status, authReplay.stderr).toBe(0);
    expect(JSON.parse(authReplay.stdout)).toEqual(JSON.parse(authLogin.stdout));
    expect(JSON.parse(authLogin.stdout)).toMatchObject({
      commandId: "auth.login",
      status: "login_completed",
      data: { valuesExposed: false, fixture: true, operationCount: 1 },
    });

    const upgradeApply = invokeProductionVhWithKey(
      "packed-upgrade-apply-once",
      "upgrade",
      "apply",
      "--release",
      "trusted-fixture-release",
    );
    const upgradeReplay = invokeProductionVhWithKey(
      "packed-upgrade-apply-once",
      "upgrade",
      "apply",
      "--release",
      "trusted-fixture-release",
    );
    expect(upgradeApply.status, upgradeApply.stderr).toBe(0);
    expect(upgradeReplay.status, upgradeReplay.stderr).toBe(0);
    expect(JSON.parse(upgradeReplay.stdout)).toEqual(JSON.parse(upgradeApply.stdout));
    expect(JSON.parse(upgradeApply.stdout)).toMatchObject({
      commandId: "upgrade.apply",
      status: "applied",
      data: { fixture: true, applyCount: 1 },
    });

    const fleetInput = [
      "--run-id",
      "packed-fleet-run",
      "--release-id",
      "packed-fleet-release",
      "--venture-ids",
      "venture-consumer",
      "--batch-size",
      "1",
    ];
    const fleetRollout = invokeProductionVhWithKey(
      "packed-fleet-rollout-once",
      "fleet",
      "rollout",
      ...fleetInput,
    );
    const fleetResume = invokeProductionVhWithKey(
      "packed-fleet-resume-once",
      "fleet",
      "resume",
      ...fleetInput,
    );
    expect(fleetRollout.status, fleetRollout.stderr).toBe(0);
    expect(fleetResume.status, fleetResume.stderr).toBe(0);
    expect(JSON.parse(fleetRollout.stdout)).toMatchObject({
      commandId: "fleet.rollout",
      status: "completed",
      data: { fixture: true, hookApplyCount: 1 },
    });
    expect(JSON.parse(fleetResume.stdout)).toMatchObject({
      commandId: "fleet.resume",
      status: "completed",
      data: { fixture: true, hookApplyCount: 1 },
    });

    const blockedUpgrade = invokeProductionVh("upgrade", "apply", "--release", "missing-release");
    expect(blockedUpgrade.status).toBe(1);
    expect(blockedUpgrade.stdout).toBe("");
    expect(JSON.parse(blockedUpgrade.stderr)).toMatchObject({
      error: "command_failed",
      code: "handler_failed",
      message: expect.stringContaining("fixture_release_missing"),
    });

    const missingCredential = invokeProductionVh(
      "provider",
      "apply",
      "--input",
      JSON.stringify({ ...providerInput, providerAccountId: "missing-account" }),
    );
    expect(missingCredential.status).toBe(1);
    expect(missingCredential.stdout).toBe("");
    expect(JSON.parse(missingCredential.stderr)).toMatchObject({
      error: "command_failed",
      code: "handler_failed",
      message: expect.stringContaining("fixture_credential_reference_missing"),
    });

    const defaultUnconfigured = invokeVh(
      "provider",
      "apply",
      "--input",
      JSON.stringify(providerInput),
      "--context",
      JSON.stringify(productionContext),
      "--idempotency-key",
      "default-provider-unconfigured",
    );
    expect(defaultUnconfigured.status).toBe(1);
    expect(defaultUnconfigured.stdout).toBe("");
    expect(JSON.parse(defaultUnconfigured.stderr)).toMatchObject({
      error: "command_failed",
      code: "handler_failed",
      message: expect.stringContaining("transport_missing"),
    });

    const defaultAuthUnconfigured = invokeVh(
      "auth",
      "login",
      "github",
      "--ref",
      "cred://github/default",
      "--context",
      JSON.stringify(productionContext),
      "--idempotency-key",
      "default-auth-unconfigured",
    );
    expect(defaultAuthUnconfigured.status).toBe(1);
    expect(defaultAuthUnconfigured.stdout).toBe("");
    expect(JSON.parse(defaultAuthUnconfigured.stderr)).toMatchObject({
      error: "command_failed",
      code: "handler_failed",
      message: expect.stringContaining("auth_runtime_unconfigured"),
    });

    const noUpgradeAlias = invokeProductionVh("upgrade", "check");
    expect(noUpgradeAlias.status).toBe(1);
    expect(noUpgradeAlias.stdout).toBe("");
    expect(JSON.parse(noUpgradeAlias.stderr)).toMatchObject({
      error: "operational_command_failed",
      message: expect.stringContaining("choose vh upgrade plan|dry-run|apply|status"),
    });

    const humanAuthStatus = invokeAdvancedCli([
      "auth",
      "status",
      "github",
      "--runtime-module",
      "vh-runtime.mjs",
      "--project-root",
      consumer,
      "--state-dir",
      ".trusted-runtime",
      "--context",
      JSON.stringify(productionContext),
      "--idempotency-key",
      "packed-auth-human-status",
    ]);
    expect(humanAuthStatus.status, humanAuthStatus.stderr).toBe(0);
    expect(humanAuthStatus.stdout.trim()).toBe("auth.status: available (read_only)");
    expect(humanAuthStatus.stderr).toBe("");

    const missingExplicitContext = invokeAdvancedCli([
      "provider",
      "apply",
      "--input",
      JSON.stringify(providerInput),
      "--runtime-module",
      "vh-runtime.mjs",
      "--idempotency-key",
      "missing-explicit-context",
      "--json",
    ]);
    expect(missingExplicitContext.status).toBe(1);
    expect(missingExplicitContext.stdout).toBe("");
    expect(JSON.parse(missingExplicitContext.stderr)).toMatchObject({
      error: "cli_initialization_failed",
      message: expect.stringContaining("--context is required"),
    });
    for (const invocation of [
      providerApply,
      providerReadBack,
      stackApply,
      stackReadBack,
      authLogin,
      authReplay,
      upgradeApply,
      upgradeReplay,
      fleetRollout,
      fleetResume,
      blockedUpgrade,
      missingCredential,
      defaultUnconfigured,
      defaultAuthUnconfigured,
      noUpgradeAlias,
      humanAuthStatus,
      missingExplicitContext,
    ]) {
      expect(invocation.stderr).not.toContain("tsx");
    }

    const growth = invokeVh("growth", "inspect");
    expect(growth.status, growth.stderr).toBe(0);
    expect(JSON.parse(growth.stdout)).toMatchObject({
      commandId: "growth.inspect",
      mode: "read_only",
      status: "valid",
      data: {
        schemaVersion: 2,
        originalSchemaVersion: 2,
        migrationApplied: false,
        venture: { ventureId: "sample-venture", currency: "EUR" },
        budgets: { totalTestBudgetMinor: 10_000, perCreativeCapMinor: 10_000 },
        organic: { maxAccounts: 2, defaultReviewMode: "REVIEW_BEFORE_PUBLISH" },
        paid: {
          dailyVentureCapMinor: 15_000,
          autoPauseAllowed: true,
          autoScaleAllowed: false,
          vboPolicy: "requires_value_ready",
        },
        compliance: { rightsRequired: true, providerPolicyState: "unknown" },
        externalEffects: false,
      },
    });

    const growthV1 = parseYaml(growthV2Source) as Record<string, unknown>;
    const growthV1Paid = growthV1.paid as Record<string, unknown>;
    growthV1.contract_version = 1;
    growthV1Paid.per_creative_test_budget_minor = growthV1Paid.per_creative_cap_minor;
    delete growthV1Paid.test_budget_minor;
    delete growthV1Paid.per_creative_cap_minor;
    const growthV1Source = stringifyYaml(growthV1);
    writeFileSync(join(consumer, "growth-v1.yaml"), growthV1Source);
    const migratedGrowth = invokeVh("growth", "inspect", "--file", "growth-v1.yaml");
    expect(migratedGrowth.status, migratedGrowth.stderr).toBe(0);
    expect(JSON.parse(migratedGrowth.stdout)).toMatchObject({
      data: {
        schemaVersion: 2,
        originalSchemaVersion: 1,
        migrationApplied: true,
        budgets: { totalTestBudgetMinor: 10_000, perCreativeCapMinor: 10_000 },
      },
    });
    expect(readFileSync(join(consumer, "growth-v1.yaml"), "utf8")).toBe(growthV1Source);

    const growthCanary = "Bearer packed-growth-secret-never-print";
    const redactedGrowth = parseYaml(growthV2Source) as Record<string, unknown>;
    redactedGrowth.extensions = { private_note: growthCanary };
    writeFileSync(join(consumer, "growth-redacted.yaml"), stringifyYaml(redactedGrowth));
    const inspectedRedacted = invokeVh("growth", "inspect", "--file", "growth-redacted.yaml");
    expect(inspectedRedacted.status, inspectedRedacted.stderr).toBe(0);
    expect(`${inspectedRedacted.stdout}\n${inspectedRedacted.stderr}`).not.toContain(growthCanary);

    writeFileSync(
      join(consumer, "growth-invalid.yaml"),
      `contract_version: 2\nextensions:\n  private_note: ${growthCanary}\n`,
    );
    const invalidGrowth = invokeVh("growth", "inspect", "--file", "growth-invalid.yaml");
    expect(invalidGrowth.status).toBe(1);
    expect(`${invalidGrowth.stdout}\n${invalidGrowth.stderr}`).not.toContain(growthCanary);
    expect(invalidGrowth.stdout).toBe("");
    expect(JSON.parse(invalidGrowth.stderr)).toMatchObject({
      error: "command_failed",
      message: "growth contract failed schema validation",
    });

    const escapeCanary = "Bearer packed-growth-path-escape-never-print";
    const escapeGrowth = parseYaml(growthV2Source) as Record<string, unknown>;
    escapeGrowth.venture_id = escapeCanary;
    const escapePath = join(packDirectory, "outside-growth.yaml");
    writeFileSync(escapePath, stringifyYaml(escapeGrowth));
    const absoluteEscape = invokeVh("growth", "inspect", "--file", escapePath);
    const traversalEscape = invokeVh("growth", "inspect", "--file", relative(consumer, escapePath));
    const symlinkPath = join(consumer, "linked-growth.yaml");
    symlinkSync(escapePath, symlinkPath);
    const symlinkEscape = invokeVh("growth", "inspect", "--file", "linked-growth.yaml");
    expect(JSON.parse(absoluteEscape.stderr)).toMatchObject({
      message: "growth contract path must stay within the configured root",
    });
    expect(JSON.parse(traversalEscape.stderr)).toMatchObject({
      message: "growth contract path must stay within the configured root",
    });
    expect(JSON.parse(symlinkEscape.stderr)).toMatchObject({
      message: "growth contract path must not contain symbolic links",
    });
    for (const rejected of [absoluteEscape, traversalEscape, symlinkEscape]) {
      expect(rejected.status).toBe(1);
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(escapeCanary);
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(escapePath);
    }

    const doctor = invokeVh("doctor");
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      commandId: "system.doctor",
      mode: "read_only",
      status: "ready_local",
      data: { runtime: "packaged", sourceFallback: false, externalEffects: false },
    });

    const compiled = invokeVh(
      "idea",
      "compile",
      "--idea",
      "A private local evidence notebook",
      "--venture-id",
      "clean-venture",
      "--name",
      "Clean Venture",
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(JSON.parse(compiled.stdout)).toMatchObject({
      commandId: "idea.compile",
      status: "compiled",
      data: { idea: { ventureId: "clean-venture", name: "Clean Venture" } },
    });

    const created = invokeVh("create", "--venture-id", "clean-venture", "--name", "Clean Venture");
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      commandId: "venture.create",
      status: "created",
    });

    const planned = invokeVh("venture", "plan", "--venture-id", "clean-venture");
    expect(planned.status, planned.stderr).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({
      commandId: "venture.plan",
      status: "planned",
      data: { plan: { externalEffects: 0 } },
    });

    const launched = invokeVh(
      "launch",
      "--dry-run",
      "--venture-id",
      "clean-venture",
      "--run-id",
      "run-clean-venture",
    );
    expect(launched.status, launched.stderr).toBe(0);
    expect(JSON.parse(launched.stdout)).toMatchObject({
      commandId: "venture.launch",
      mode: "dry_run",
      status: "dry_run_complete",
      data: { run: { runId: "run-clean-venture", externalEffects: 0 } },
    });

    const status = invokeVh("venture", "status", "--venture-id", "clean-venture");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      commandId: "venture.status",
      status: "dry_run_complete",
      data: { venture: { ventureId: "clean-venture" }, run: { runId: "run-clean-venture" } },
    });

    const resumed = invokeVh("resume", "run-clean-venture");
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      commandId: "venture.resume",
      status: "no_pending_work",
      data: { repeatedEffects: 0 },
    });

    const introspectionCommands = [
      ["org", "list"],
      ["stack", "list"],
      ["pack", "list"],
      ["seed", "list"],
      ["grant", "list"],
      ["provider", "list"],
      ["run", "list"],
      ["data", "sync"],
      ["learn", "weekly"],
    ];
    for (const command of introspectionCommands) {
      const inspection = invokeVh(...command);
      expect(inspection.status, `${command.join(" ")}: ${inspection.stderr}`).toBe(0);
      expect(JSON.parse(inspection.stdout)).toMatchObject({ commandId: expect.any(String) });
      if (command[0] === "learn") {
        expect(JSON.parse(inspection.stdout)).toEqual({
          commandId: "learn.run",
          mode: "pending",
          status: "insufficient_evidence",
          data: {
            cadence: "weekly",
            actionsApplied: 0,
            externalEffects: false,
            providerRequestMade: false,
            reason: "no normalized provider evidence is configured",
            runtime: "unconfigured",
          },
        });
      }
    }

    const verification = invokeVh("verify", "fast");
    expect(verification.status).toBe(1);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      commandId: "verify.run",
      status: "INCOMPLETE",
      data: { profile: { profile: "fast", status: "INCOMPLETE" } },
    });

    const apply = invokeVh("launch", "--apply", "--venture-id", "clean-venture");
    expect(apply.status).toBe(1);
    expect(apply.stdout).toBe("");
    expect(JSON.parse(apply.stderr)).toMatchObject({
      error: "operational_command_failed",
      message: expect.stringContaining("no effect ran"),
    });

    const credentialCanary = "Bearer packed-secret-never-print";
    const rejectedSecret = invokeVh(
      "idea",
      "compile",
      "--input",
      JSON.stringify({
        idea: credentialCanary,
        ventureId: "secret-venture",
        name: "Secret Venture",
      }),
    );
    expect(rejectedSecret.status).toBe(1);
    expect(`${rejectedSecret.stdout}\n${rejectedSecret.stderr}`).not.toContain(credentialCanary);
    expect(rejectedSecret.stdout).toBe("");
    expect(JSON.parse(rejectedSecret.stderr)).toMatchObject({
      error: "command_failed",
      message: expect.stringContaining("credential-like material is forbidden"),
    });
    expect(readFileSync(join(stateDirectory, "operational-state.json"), "utf8")).not.toContain(
      credentialCanary,
    );
  }, 120_000);
});
