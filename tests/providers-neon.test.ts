import { describe, expect, it } from "vitest";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import {
  CredentialBroker,
  EnvironmentCredentialBackend,
  MemoryCredentialBackend,
  type CommandInvocation,
  type CommandRunner,
} from "@/lib/credentials";
import {
  CommandProviderTransport,
  getProviderAdapter,
  InMemoryIdempotencyLedger,
  MockProviderTransport,
  providerRegistry,
  type ProviderExecutionContext,
  type ProviderPlanRequest,
} from "@/lib/providers";

const databaseCredentialRef = "cred://neon/database";

function databasePlanRequest(
  capabilities: readonly string[] = ["schema_migration", "read_write_health_check"],
): ProviderPlanRequest {
  return {
    environment: "production",
    capabilities,
    inputs: { databaseCredentialRef },
    dryRun: false,
  };
}

describe("Neon schema and database verification", () => {
  it("keeps API provisioning auth separate from brokered psql connection auth", () => {
    const plan = getProviderAdapter("neon").plan(databasePlanRequest());

    expect(plan.operations.map(({ capability }) => capability)).toEqual([
      "schema_migration",
      "read_write_health_check",
    ]);
    expect(plan.operations[0]).toMatchObject({
      action: "schema.migrate",
      credentialRef: databaseCredentialRef,
      command: {
        binary: "psql",
        args: [
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          "--file",
          "migrations/sql/001_core_evidence.up.sql",
        ],
        authEnvironment: { name: "PGDATABASE", credentialRef: databaseCredentialRef },
      },
    });
    expect(plan.operations[0].readBack?.command).toMatchObject({
      binary: "psql",
      authEnvironment: { name: "PGDATABASE", credentialRef: databaseCredentialRef },
    });
    expect(plan.operations[0].readBack?.assertions?.map(({ expected }) => expected)).toEqual(
      expect.arrayContaining([
        "migration:001_core_evidence",
        "table:vh_schema_migrations",
        "table:provider_webhook_events",
        "constraint:provider_webhook_status",
      ]),
    );
    expect(plan.operations[1].dependsOn).toEqual([plan.operations[0].id]);
    expect(plan.operations[1].command?.args.join(" ")).toContain("rollback;");
    expect(plan.operations[1].readBack?.assertions).toEqual([
      { path: "", operator: "contains", expected: "vh_read_write_ok" },
    ]);

    for (const operation of plan.operations) {
      for (const command of [operation.command, operation.readBack?.command]) {
        expect(command?.args).not.toContain(databaseCredentialRef);
        expect(command?.args.join(" ")).not.toContain("postgresql://");
        expect(command?.authEnvironment).toEqual({
          name: "PGDATABASE",
          credentialRef: databaseCredentialRef,
        });
      }
    }
    expect(plan.limitations.join(" ")).toContain(
      "captures connection_uris[0].connection_uri directly into an already-registered writable databaseCredentialRef",
    );
  });

  it("rejects connection material in place of databaseCredentialRef", () => {
    const rawConnection = "postgresql://venture:never-in-plan@example.test/venture";
    expect(() =>
      getProviderAdapter("neon").plan({
        ...databasePlanRequest(["schema_migration"]),
        inputs: { databaseCredentialRef: rawConnection },
      }),
    ).toThrow(/credential reference: databaseCredentialRef/i);
  });

  it("applies and reads back through PGDATABASE without leaking the connection", async () => {
    const invocations: CommandInvocation[] = [];
    const plan = getProviderAdapter("neon").plan(databasePlanRequest());
    const schemaEvidence = plan.operations[0].readBack?.assertions
      ?.map(({ expected }) => String(expected))
      .join("\n");
    const runner: CommandRunner = {
      async run(invocation) {
        invocations.push(invocation);
        const commandText = invocation.args.join(" ");
        if (commandText.includes("vh_schema_migrations")) {
          return { exitCode: 0, stdout: schemaEvidence ?? "", stderr: "" };
        }
        if (commandText.includes("vh_provider_health_check")) {
          return { exitCode: 0, stdout: "vh_read_write_ok\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "migration applied\n", stderr: "" };
      },
    };
    const rawConnection =
      "postgresql://venture:database-secret@ep-example.eu-central-1.aws.neon.tech/venture?sslmode=require";
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: databaseCredentialRef,
      provider: "neon",
      kind: "connection_string",
      backend: "memory",
      value: rawConnection,
    });
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      credentials: broker,
      redactor: broker.redactor,
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    };

    const adapter = getProviderAdapter("neon");
    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);
    const verification = adapter.verify(report, readBack);

    expect(report.state).toBe("applied");
    expect(readBack.results.map(({ status }) => status)).toEqual(["matched", "matched"]);
    expect(verification.state).toBe("verified");
    expect(invocations).toHaveLength(4);
    for (const invocation of invocations) {
      expect(invocation.command).toBe("psql");
      expect(invocation.args).not.toContain(rawConnection);
      expect(invocation.stdin).toBeUndefined();
      expect(invocation.env).toEqual({ PGDATABASE: rawConnection });
      expect(invocation.sensitiveEnv).toEqual(["PGDATABASE"]);
    }
    expect(JSON.stringify(plan)).not.toContain(rawConnection);
    expect(JSON.stringify(report)).not.toContain(rawConnection);
    expect(JSON.stringify(readBack)).not.toContain(rawConnection);
  });

  it("captures a new-project connection URI into the broker before migration", async () => {
    const apiCredentialRef = "cred://neon/control-plane";
    const rawConnection =
      "postgresql://venture:captured-secret@ep-new.eu-central-1.aws.neon.tech/neondb?sslmode=require";
    const invocations: CommandInvocation[] = [];
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: apiCredentialRef,
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-control-plane-secret",
    });
    broker.register({
      ref: databaseCredentialRef,
      provider: "neon",
      kind: "connection_string",
      backend: "memory",
      label: "Generated project database connection",
    });
    const plan = getProviderAdapter("neon").plan({
      environment: "preview",
      capabilities: ["project", "schema_migration", "read_write_health_check"],
      credentialRef: apiCredentialRef,
      inputs: {
        organizationId: "org-founder",
        projectName: "new-venture",
        regionId: "aws-eu-central-1",
        databaseCredentialRef,
      },
      dryRun: false,
    });
    const schemaEvidence = plan.operations[1].readBack?.assertions
      ?.map(({ expected }) => String(expected))
      .join("\n");
    const runner: CommandRunner = {
      async run(invocation) {
        invocations.push(invocation);
        if (invocation.command === "neonctl" && invocation.args.includes("create")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              project: {
                id: "project-new",
                org_id: "org-founder",
                name: "new-venture",
                region_id: "aws-eu-central-1",
              },
              connection_uris: [{ connection_uri: rawConnection }],
            }),
            stderr: "",
          };
        }
        if (invocation.command === "neonctl") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              id: "project-new",
              org_id: "org-founder",
              name: "new-venture",
              region_id: "aws-eu-central-1",
            }),
            stderr: "",
          };
        }
        const commandText = invocation.args.join(" ");
        if (commandText.includes("vh_schema_migrations")) {
          return { exitCode: 0, stdout: schemaEvidence ?? "", stderr: "" };
        }
        if (commandText.includes("vh_provider_health_check")) {
          return { exitCode: 0, stdout: "vh_read_write_ok\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "migration applied\n", stderr: "" };
      },
    };
    const adapter = getProviderAdapter("neon");
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      credentials: broker,
      redactor: broker.redactor,
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    };

    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);
    const verification = adapter.verify(report, readBack);

    expect(report.state).toBe("applied");
    expect(verification.state).toBe("verified");
    const neonInvocations = invocations.filter(({ command }) => command === "neonctl");
    const organizationIndex = neonInvocations[0].args.indexOf("--org-id");
    expect(organizationIndex).toBeGreaterThanOrEqual(0);
    expect(neonInvocations[0].args[organizationIndex + 1]).toBe("org-founder");
    expect(neonInvocations[1].args).not.toContain("--org-id");
    await expect(broker.withSecret(databaseCredentialRef, (secret) => secret)).resolves.toBe(
      rawConnection,
    );
    expect(invocations.filter(({ command }) => command === "psql")).toHaveLength(4);
    for (const invocation of invocations) {
      expect(invocation.args.join(" ")).not.toContain(rawConnection);
      expect(invocation.stdin).toBeUndefined();
      if (invocation.command === "psql")
        expect(invocation.env).toEqual({ PGDATABASE: rawConnection });
    }
    expect(JSON.stringify(report)).not.toContain(rawConnection);
    expect(JSON.stringify(readBack)).not.toContain(rawConnection);
  });

  it("requires an explicit organization before a Neon control-plane plan can reach transport", () => {
    expect(() =>
      getProviderAdapter("neon").plan({
        environment: "preview",
        capabilities: ["project"],
        credentialRef: "cred://neon/control-plane",
        inputs: {
          projectName: "must-not-be-planned",
          regionId: "aws-eu-central-1",
        },
        dryRun: false,
      }),
    ).toThrow("organizationId");
  });

  it("refuses to verify a project read back from a different Neon organization", async () => {
    const apiCredentialRef = "cred://neon/control-plane";
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: apiCredentialRef,
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-control-plane-secret",
    });
    const plan = getProviderAdapter("neon").plan({
      environment: "preview",
      capabilities: ["project"],
      credentialRef: apiCredentialRef,
      inputs: {
        organizationId: "org-approved",
        projectName: "organization-bound-project",
        regionId: "aws-eu-central-1",
      },
      dryRun: false,
    });
    const runner: CommandRunner = {
      async run(invocation) {
        if (invocation.args.includes("create")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              project: {
                id: "project-wrong-org",
                org_id: "org-approved",
                name: "organization-bound-project",
                region_id: "aws-eu-central-1",
              },
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: "project-wrong-org",
            org_id: "org-other",
            name: "organization-bound-project",
            region_id: "aws-eu-central-1",
          }),
          stderr: "",
        };
      },
    };
    const adapter = getProviderAdapter("neon");
    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      credentials: broker,
      redactor: broker.redactor,
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    };

    const report = await adapter.apply(plan, context);
    const readBack = await adapter.readBack(report, context);

    expect(report.state).toBe("applied");
    expect(readBack.results).toContainEqual(
      expect.objectContaining({ operationId: plan.operations[0].id, status: "mismatched" }),
    );
    expect(adapter.verify(report, readBack).state).toBe("failed");
  });

  it("preflights the credential capture target before creating a Neon project", async () => {
    const invocations: CommandInvocation[] = [];
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://neon/control-plane",
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-control-plane-secret",
    });
    const plan = getProviderAdapter("neon").plan({
      environment: "preview",
      capabilities: ["project", "schema_migration", "read_write_health_check"],
      credentialRef: "cred://neon/control-plane",
      inputs: {
        organizationId: "org-founder",
        projectName: "must-not-be-created",
        regionId: "aws-eu-central-1",
        databaseCredentialRef,
      },
      dryRun: false,
    });

    await expect(
      getProviderAdapter("neon").apply(plan, {
        authorization: "approved",
        transports: {
          cli: new CommandProviderTransport({
            runner: {
              async run(invocation) {
                invocations.push(invocation);
                return { exitCode: 0, stdout: "{}", stderr: "" };
              },
            },
          }),
        },
        credentials: broker,
        redactor: broker.redactor,
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
      }),
    ).rejects.toThrow("credential capture target is not registered");
    expect(invocations).toHaveLength(0);
  });

  it("fails before provisioning when the registered database secret target is read-only", async () => {
    const invocations: CommandInvocation[] = [];
    const memory = new MemoryCredentialBackend();
    const readOnly = new EnvironmentCredentialBackend({
      env: { VH_NEON_DATABASE_URL: "SYNTHETIC_READ_ONLY_SECRET_TARGET" },
      variableForRef: { [databaseCredentialRef]: "VH_NEON_DATABASE_URL" },
    });
    const broker = new CredentialBroker([memory, readOnly]);
    await broker.store({
      ref: "cred://neon/control-plane",
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-control-plane-secret",
    });
    broker.register({
      ref: databaseCredentialRef,
      provider: "neon",
      kind: "connection_string",
      backend: "environment",
    });
    const plan = getProviderAdapter("neon").plan({
      environment: "preview",
      capabilities: ["project", "schema_migration", "read_write_health_check"],
      credentialRef: "cred://neon/control-plane",
      inputs: {
        organizationId: "org-founder",
        projectName: "must-not-be-created-with-read-only-secret-target",
        regionId: "aws-eu-central-1",
        databaseCredentialRef,
      },
      dryRun: false,
    });

    await expect(
      getProviderAdapter("neon").apply(plan, {
        authorization: "approved",
        transports: {
          cli: new CommandProviderTransport({
            runner: {
              async run(invocation) {
                invocations.push(invocation);
                return { exitCode: 0, stdout: "{}", stderr: "" };
              },
            },
          }),
        },
        credentials: broker,
        redactor: broker.redactor,
        idempotencyLedger: new InMemoryIdempotencyLedger(),
        fixtureMode: true,
      }),
    ).rejects.toThrow("credential capture target is not writable");
    expect(invocations).toHaveLength(0);
  });

  it("blocks the health check when the migration fails", async () => {
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 1, stdout: "", stderr: "migration failed" };
      },
    };
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: databaseCredentialRef,
      provider: "neon",
      kind: "connection_string",
      backend: "memory",
      value: "postgresql://venture:secret@example.test/venture",
    });
    const adapter = getProviderAdapter("neon");
    const report = await adapter.apply(adapter.plan(databasePlanRequest()), {
      authorization: "approved",
      transports: { cli: new CommandProviderTransport({ runner }) },
      credentials: broker,
      redactor: broker.redactor,
      idempotencyLedger: new InMemoryIdempotencyLedger(),
      fixtureMode: true,
    });

    expect(report.state).toBe("failed");
    expect(report.operations.map(({ result }) => result.status)).toEqual(["failed", "skipped"]);
    expect(report.operations[1].result.message).toContain("Blocked by incomplete dependencies");
  });

  it("requires distinct control-plane and database credential kinds in doctor", async () => {
    const apiKeyRef = "cred://neon/primary";
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: apiKeyRef,
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-api-key-secret",
    });
    const context: ProviderExecutionContext = {
      authorization: "dry_run",
      transports: { cli: new MockProviderTransport("cli") },
      credentials: broker,
      redactor: broker.redactor,
    };
    const adapter = getProviderAdapter("neon");
    const requiredCapabilities = ["project", "schema_migration", "read_write_health_check"];

    const apiOnly = await adapter.doctor(
      { credentialRefs: [apiKeyRef], requiredCapabilities },
      context,
    );
    expect(apiOnly.status).toBe("auth_required");
    expect(apiOnly.issues).toContainEqual(
      expect.objectContaining({
        code: "auth_missing",
        message: expect.stringContaining("PostgreSQL migration and health-check access"),
      }),
    );

    await broker.store({
      ref: databaseCredentialRef,
      provider: "neon",
      kind: "connection_string",
      backend: "memory",
      value: "postgresql://venture:database-secret@example.test/venture",
    });
    const ready = await adapter.doctor(
      { credentialRefs: [apiKeyRef, databaseCredentialRef], requiredCapabilities },
      context,
    );
    expect(ready.status).toBe("ready");
    expect(ready.issues.some(({ code }) => code === "auth_missing")).toBe(false);
    expect(JSON.stringify(ready)).not.toContain("database-secret");
  });

  it("maps the venture database doctor check to migration and health readiness", async () => {
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    await broker.store({
      ref: "cred://neon/primary",
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-api-key-secret",
    });
    const providerContext: ProviderExecutionContext = {
      authorization: "dry_run",
      transports: {
        cli: new MockProviderTransport("cli"),
        http: new MockProviderTransport("http"),
      },
      credentials: broker,
      redactor: broker.redactor,
    };
    const services = createDefaultCliServices({
      rootDir: process.cwd(),
      credentialBroker: broker,
      providerRegistry,
      providerContext,
    });

    const result = (await services.doctor!()) as unknown as {
      providerChecks: Array<{
        provider: string;
        status: string;
        issues: Array<{ code: string; message: string }>;
      }>;
    };
    const neon = result.providerChecks.find(({ provider }) => provider === "neon");
    expect(neon?.status).toBe("auth_required");
    expect(neon?.issues).toContainEqual(
      expect.objectContaining({
        code: "auth_missing",
        message: expect.stringContaining("PostgreSQL migration and health-check access"),
      }),
    );
  });
});
