import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const temporaryDirectories: string[] = [];

/**
 * The packed consumer must receive the complete workspace closure of the
 * package under test. A hand-maintained list silently drifts the moment a
 * dependency is added — `@venture-harness/loops` was missing here, which made
 * the install fail on resolution rather than on anything about credentials.
 * Deriving the closure from the manifests keeps this test measuring the
 * credential boundary instead of list hygiene.
 */
function workspaceClosure(entry: string): string[] {
  const directoryByName = new Map<string, string>();
  for (const directory of readdirSync(join(root, "packages"))) {
    const manifestPath = join(root, "packages", directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string };
    directoryByName.set(manifest.name, directory);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    if (seen.has(directory)) return;
    seen.add(directory);
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", directory, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const child = directoryByName.get(dependency);
      if (child) visit(child);
    }
    // Dependencies are packed before their dependents.
    ordered.push(directory);
  };
  visit(entry);
  return ordered;
}

const closure = workspaceClosure("agent-runtime");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packed recursive credential boundary", () => {
  it("rejects inbound secondary credentials through ESM and CJS in a clean packed consumer", () => {
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
    // Pin every third-party dependency of the packed closure to the version
    // this repository actually has installed, so the consumer resolves from the
    // local store rather than picking up a different version of a transitive
    // dependency than the one the boundary was verified against.
    const externalOverrides: Record<string, string> = {};
    for (const shortName of closure) {
      const manifest = JSON.parse(
        readFileSync(join(root, "packages", shortName, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (dependency.startsWith("@venture-harness/")) continue;
        const installed = join(root, "node_modules", dependency, "package.json");
        if (!existsSync(installed)) continue;
        const { version } = JSON.parse(readFileSync(installed, "utf8")) as { version: string };
        externalOverrides[dependency] = version;
      }
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
          pnpm: { overrides: { ...externalOverrides, ...dependencies } },
        },
        null,
        2,
      )}\n`,
    );
    const storeDirectory = execFileSync("pnpm", ["store", "path"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    // --prefer-offline rather than --offline: a `--frozen-lockfile` install
    // resolves from the lockfile and never populates the registry metadata
    // cache, so a strict offline install fails on metadata rather than on
    // anything this test is about. Package content still comes from the packed
    // tarballs and the local store; only metadata may be fetched.
    const install = spawnSync(
      "pnpm",
      ["install", "--prefer-offline", "--ignore-scripts", "--store-dir", storeDirectory],
      { cwd: consumer, encoding: "utf8", timeout: 120_000 },
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
