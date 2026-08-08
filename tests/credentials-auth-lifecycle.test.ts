import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import {
  CredentialBroker,
  EnvironmentCredentialBackend,
  loadCredentialCatalog,
  type CommandRunner,
} from "@/lib/credentials";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("default credential auth lifecycle", () => {
  it("persists successful remote-test evidence and preserves a failed-removal ref disabled", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "vh-auth-lifecycle-"));
    directories.push(rootDir);
    mkdirSync(join(rootDir, "config"), { recursive: true });
    for (const file of ["providers.yaml", "venture.yaml", "mobile.yaml", "offer.yaml"]) {
      copyFileSync(join("config", file), join(rootDir, "config", file));
    }
    const catalogPath = join(rootDir, ".venture", "credentials.json");
    const backend = new EnvironmentCredentialBackend({
      env: { NEON_PRIMARY: "neon-environment-fixture" },
      variableForRef: { "cred://neon/primary": "NEON_PRIMARY" },
    });
    const broker = new CredentialBroker([backend]);
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "fixture 1.0", stderr: "" };
      },
    };
    const services = createDefaultCliServices({
      rootDir,
      credentialCatalogPath: catalogPath,
      credentialBroker: broker,
      credentialTesters: {
        neon: async (secret) => ({
          ok: secret === "neon-environment-fixture",
          accountId: "neon-account",
          scopes: ["*"],
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
      },
      providerCommandRunner: runner,
    });

    await services.auth!({
      action: "login",
      provider: "neon",
      ref: "cred://neon/primary",
      backend: "environment",
      kind: "api_key",
    });
    const tested = (await services.auth!({ action: "test", provider: "neon" })) as Record<
      string,
      unknown
    >;
    expect(tested.tested).toEqual([
      expect.objectContaining({
        ref: "cred://neon/primary",
        mode: "remote_tester",
        result: expect.objectContaining({ ok: true, accountId: "neon-account" }),
      }),
    ]);
    expect(loadCredentialCatalog(catalogPath).references[0]).toMatchObject({
      ref: "cred://neon/primary",
      testedAt: expect.any(String),
      testStatus: "passed",
      accountId: "neon-account",
      scopes: ["*"],
    });
    const doctor = (await services.doctor!()) as {
      authenticatedCredentialRefs: Array<Record<string, unknown>>;
      providerChecks: Array<Record<string, unknown>>;
    };
    expect(doctor.authenticatedCredentialRefs).toContainEqual({
      ref: "cred://neon/primary",
      provider: "neon",
      kind: "api_key",
    });
    expect(doctor.providerChecks.find(({ provider }) => provider === "neon")).toMatchObject({
      authenticatedCredentialRefs: ["cred://neon/primary"],
      missingCredentialKinds: ["connection_string"],
    });

    const response = (await services.auth!({
      action: "revoke",
      provider: "neon",
    })) as { revoked: Array<Record<string, unknown>> };
    expect(response.revoked[0]).toMatchObject({
      removed: false,
      localAccessDisabled: true,
      localRemoval: "failed",
      catalogReference: "preserved_disabled",
      providerSideRevocation: "manual_required",
      nextAction: expect.stringContaining("Neon Console > Account settings > API keys"),
    });
    const persisted = loadCredentialCatalog(catalogPath).references[0]!;
    expect(persisted).toMatchObject({
      ref: "cred://neon/primary",
      revokedAt: expect.any(String),
    });

    const restartedBroker = new CredentialBroker([backend]);
    const restarted = createDefaultCliServices({
      rootDir,
      credentialCatalogPath: catalogPath,
      credentialBroker: restartedBroker,
      providerCommandRunner: runner,
    });
    const status = (await restarted.auth!({
      action: "status",
      provider: "neon",
    })) as { references: Array<Record<string, unknown>> };
    expect(status.references).toEqual([
      expect.objectContaining({
        ref: "cred://neon/primary",
        status: "revoked",
        testStatus: "passed",
        revokedAt: expect.any(String),
      }),
    ]);
  });
});
