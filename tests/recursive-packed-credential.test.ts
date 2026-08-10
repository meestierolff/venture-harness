import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const temporaryDirectories: string[] = [];
const closure = [
  "core",
  "audit",
  "billing",
  "config",
  "events",
  "command-bus",
  "connections",
  "entitlements",
  "organizations",
  "policy",
  "telemetry",
  "agent-runtime",
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packed recursive credential boundary", () => {
  it("rejects inbound secondary credentials through ESM and CJS in a clean offline consumer", () => {
    const packDirectory = mkdtempSync(join(tmpdir(), "vh-recursive-pack-"));
    const consumer = mkdtempSync(join(tmpdir(), "vh-recursive-consumer-"));
    temporaryDirectories.push(packDirectory, consumer);
    const dependencies: Record<string, string> = {};
    for (const shortName of closure) {
      const directory = join(root, "packages", shortName);
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
        name: string;
        version: string;
      };
      execFileSync("pnpm", ["pack", "--pack-destination", packDirectory], {
        cwd: directory,
        stdio: "pipe",
      });
      const prefix = `${manifest.name.replace("@venture-harness/", "venture-harness-")}-${manifest.version}`;
      const artifact = readdirSync(packDirectory).find(
        (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
      );
      if (!artifact) throw new Error(`packed artifact missing for ${manifest.name}`);
      dependencies[manifest.name] = `file:${join(packDirectory, artifact)}`;
    }
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "vh-recursive-credential-consumer",
          version: "1.0.0",
          private: true,
          type: "module",
          dependencies,
          pnpm: { overrides: dependencies },
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
      ["install", "--offline", "--ignore-scripts", "--store-dir", storeDirectory],
      { cwd: consumer, encoding: "utf8", timeout: 30_000 },
    );
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    writeFileSync(
      join(consumer, "verify.mjs"),
      `import { createRequire } from "node:module";
import { recursiveServiceExecuteCommand as esm } from "@venture-harness/agent-runtime";
const { recursiveServiceExecuteCommand: cjs } = createRequire(import.meta.url)("@venture-harness/agent-runtime");
const input = {
  customerOrganizationId: "customer-packed",
  subscriptionId: "subscription-packed",
  entitlementId: "entitlement-packed",
  serviceGrantId: "grant-packed",
  providerConnectionId: "connection-packed",
  capability: "packed.execute",
  authorizationEnvelopeId: "envelope-packed",
  runId: "run-packed",
  nodeId: "node-packed",
  correlationId: "correlation-packed",
  causationId: "causation-packed",
  usageUnits: 1,
  payload: { requestId: "safe", receiptHint: "whsec_SYNTHETICNOTAREALsecondaryrotation" }
};
for (const contract of [esm, cjs]) {
  for (const unsafe of [
    input,
    { ...input, payload: { requestId: "safe" }, authorizationEnvelopeId: "whsec_secondary_auditboundary123456" }
  ]) {
    let rejected = false;
    try { contract.input.parse(unsafe); } catch (error) {
      rejected = /credential(?: or non-JSON)? material is forbidden/.test(String(error));
    }
    if (!rejected) throw new Error("packed parser accepted credential material");
  }
}
process.stdout.write("packed-recursive-credential-rejected\\n");
`,
    );
    const verification = spawnSync(process.execPath, ["verify.mjs"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout).toBe("packed-recursive-credential-rejected\n");
    expect(verification.stdout + verification.stderr).not.toContain(
      "whsec_SYNTHETICNOTAREALsecondaryrotation",
    );
  }, 60_000);
});
