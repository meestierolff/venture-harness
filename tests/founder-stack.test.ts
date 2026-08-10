import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "@/lib/cli";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import { CredentialBroker, MemoryCredentialBackend, type CredentialKind } from "@/lib/credentials";
import {
  FileFounderStackStore,
  doctorFounderStackConnection,
  founderStackRoleDefinitions,
  loadFounderStackConnectionFile,
  parseFounderStackConnection,
  registerFounderStackWritableCredentialRefs,
  renderFounderStackProviderConfigOverrides,
  type FounderStackConnection,
  type FounderStackProviderId,
  type FounderStackRole,
} from "@/lib/founder-launch";
import { MockProviderTransport, type ProviderExecutionContext } from "@/lib/providers";
import { FileWorkflowStore } from "@/lib/workflow";

const temporaryDirectories: string[] = [];
const fixturePath = "fixtures/founder-stack/founder-default.json";

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "vh-founder-stack-"));
  temporaryDirectories.push(path);
  return path;
}

function fixture(): FounderStackConnection {
  return parseFounderStackConnection(JSON.parse(readFileSync(fixturePath, "utf8")));
}

function io(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Founder Stack connection", () => {
  it("parses one exact fixed-role profile and renders credential-reference-only overrides", () => {
    const connection = fixture();

    expect(Object.keys(connection.roles)).toEqual(Object.keys(founderStackRoleDefinitions));
    expect(
      Object.entries(founderStackRoleDefinitions).map(([role, definition]) => ({
        role,
        providerId: definition.providerId,
      })),
    ).toEqual([
      { role: "source.repository", providerId: "github" },
      { role: "hosting.web", providerId: "vercel" },
      { role: "database.postgres", providerId: "neon" },
      { role: "commerce.web", providerId: "stripe" },
      { role: "commerce.native", providerId: "revenuecat" },
      { role: "email.transactional", providerId: "brevo" },
      { role: "growth.google", providerId: "google" },
      { role: "search.bing", providerId: "bing" },
      { role: "dns.records", providerId: "dns" },
    ]);

    const overrides = renderFounderStackProviderConfigOverrides(connection, {
      ventureSlug: "invoice-guide",
      domain: "invoice-guide.example.test",
    });
    expect(overrides.writableCredentialRefs).toEqual({
      neonDatabaseUri: "cred://neon/invoice-guide-database",
      stripeWebhookSigning: "cred://stripe/invoice-guide-webhook",
      googleAnalyticsMeasurementId: "cred://google/invoice-guide-measurement-id",
    });
    expect(overrides.writableCredentialRegistrations).toEqual([
      expect.objectContaining({
        purpose: "neon_database_uri",
        ref: "cred://neon/invoice-guide-database",
        backend: "memory",
        kind: "connection_string",
      }),
      expect.objectContaining({
        purpose: "stripe_webhook_signing",
        ref: "cred://stripe/invoice-guide-webhook",
        backend: "memory",
        kind: "ci_secret",
      }),
      expect.objectContaining({
        purpose: "google_analytics_measurement_id",
        ref: "cred://google/invoice-guide-measurement-id",
        backend: "memory",
        kind: "ci_secret",
      }),
    ]);
    expect(overrides.providers.neon).toMatchObject({
      state: "auth_required",
      credential_ref: "cred://neon/founder-default",
      region: "aws-eu-central-1",
      last_verified_at: null,
      external_resource_ids: {
        organization_id: "fixture-neon-org",
        database_credential_ref: "cred://neon/invoice-guide-database",
      },
    });
    expect(overrides.providers.stripe.external_resource_ids).toMatchObject({
      mode: "test",
      webhook_secret_credential_ref: "cred://stripe/invoice-guide-webhook",
    });
    expect(overrides.providers.brevo.external_resource_ids).toMatchObject({
      sender_name: "Synthetic founder",
      sender_email: "hello@fixture.example.test",
      template_name: "Synthetic welcome",
      template_subject: "Welcome to the synthetic fixture",
      template_html: "<p>Synthetic fixture welcome.</p>",
    });
    expect(overrides.providers.google.external_resource_ids).toMatchObject({
      analytics_account_id: "fixture-google-analytics-account",
      measurement_id_credential_ref: "cred://google/invoice-guide-measurement-id",
    });
    expect(overrides.providers.bing.external_resource_ids).toMatchObject({ auth_mode: "api_key" });
    expect(overrides.providers.dns).toMatchObject({
      state: "unconfigured",
      selected_transport: "manual",
      external_resource_ids: {
        adapter: "manual_generic",
        organization_id: "fixture-dns-zone-owner",
        domain: "invoice-guide.example.test",
      },
    });
  });

  it("rejects unknown fields, provider-swapped refs, and credential-shaped nested metadata", () => {
    const base = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(() => parseFounderStackConnection({ ...base, token: "not-allowed" })).toThrow();
    expect(() =>
      parseFounderStackConnection({
        ...base,
        roles: {
          ...base.roles,
          "source.repository": {
            ...base.roles["source.repository"],
            credentialRef: "cred://stripe/founder-default",
          },
        },
      }),
    ).toThrow(/cred:\/\/github/);
    expect(() =>
      parseFounderStackConnection({
        ...base,
        roles: {
          ...base.roles,
          "hosting.web": {
            ...base.roles["hosting.web"],
            accountId: "whsec_secondary_founderstack123456",
          },
        },
      }),
    ).toThrow(/forbidden material/);
    // A credential embedded inside a cred:// reference is refused by the
    // reference schema itself, which is stricter and more specific than the
    // whole-document sweep the other cases exercise.
    expect(() =>
      parseFounderStackConnection({
        ...base,
        roles: {
          ...base.roles,
          "commerce.web": {
            ...base.roles["commerce.web"],
            credentialRef: "cred://stripe/whsec_secondary_founderstack123456",
          },
        },
      }),
    ).toThrow(/credential_ref contains credential material/);
  });

  it("persists atomically, reloads after restart, and rejects tamper, symlinks, and cross-org overwrite", () => {
    const directory = temporaryDirectory();
    const store = new FileFounderStackStore(join(directory, "state"));
    const connection = fixture();

    store.save(connection);
    expect(new FileFounderStackStore(join(directory, "state")).load("founder-default")).toEqual(
      connection,
    );
    expect(readdirSync(join(directory, "state"))).toEqual(["founder-default.v1.json"]);

    expect(() => store.save({ ...connection, ownerOrganizationId: "other-founder-org" })).toThrow(
      /another organization/,
    );

    const statePath = store.pathFor("founder-default");
    writeFileSync(statePath, JSON.stringify({ ...connection, unexpected: "tampered" }), "utf8");
    expect(() => store.load("founder-default")).toThrow();

    unlinkSync(statePath);
    const target = join(directory, "redirected.json");
    writeFileSync(target, JSON.stringify(connection), "utf8");
    symlinkSync(target, statePath);
    expect(() => store.load("founder-default")).toThrow(/non-symlink/);

    const realRoot = join(directory, "real-root");
    mkdirSync(realRoot);
    const linkedRoot = join(directory, "linked-root");
    symlinkSync(realRoot, linkedRoot, "dir");
    expect(() => new FileFounderStackStore(linkedRoot).save(connection)).toThrow(/non-symlink/);
  });

  it("bounds --file to a regular project-relative canonical JSON input", () => {
    const directory = temporaryDirectory();
    const outside = temporaryDirectory();
    cpSync(fixturePath, join(directory, "connection.json"));
    cpSync(fixturePath, join(outside, "outside.json"));
    symlinkSync(outside, join(directory, "linked-outside"), "dir");

    expect(loadFounderStackConnectionFile("connection.json", { baseDir: directory })).toEqual(
      fixture(),
    );
    expect(() => loadFounderStackConnectionFile("../outside.json", { baseDir: directory })).toThrow(
      /escapes/,
    );
    expect(() => loadFounderStackConnectionFile(fixturePath, { baseDir: directory })).toThrow(
      /does not exist/,
    );
    expect(() =>
      loadFounderStackConnectionFile("linked-outside/outside.json", { baseDir: directory }),
    ).toThrow(/outside the project root/);
  });

  it("allows memory capture only in an explicitly fixture-labelled backend", () => {
    const base = fixture();
    expect(() =>
      parseFounderStackConnection({
        ...base,
        writableCredentialBackend: { mode: "shared", backend: "memory" },
      }),
    ).toThrow();
    expect(() =>
      parseFounderStackConnection({
        ...base,
        writableCredentialBackend: {
          mode: "fixture",
          backend: "memory",
          fixtureLabel: "whsec_secondary_backend123456",
        },
      }),
    ).toThrow(/forbidden material/);
  });
});

const credentialKinds: Record<Exclude<FounderStackProviderId, "dns">, CredentialKind> = {
  github: "restricted_api_key",
  vercel: "api_key",
  neon: "api_key",
  stripe: "restricted_api_key",
  revenuecat: "restricted_api_key",
  brevo: "api_key",
  google: "oauth",
  bing: "api_key",
};

async function verifiedContext(
  connection: FounderStackConnection,
): Promise<ProviderExecutionContext> {
  const backend = new MemoryCredentialBackend();
  const broker = new CredentialBroker([backend]);
  for (const role of Object.keys(founderStackRoleDefinitions) as FounderStackRole[]) {
    const providerId = founderStackRoleDefinitions[role].providerId;
    const metadata = connection.roles[role];
    if (providerId === "dns" || !metadata.credentialRef) continue;
    await broker.store({
      ref: metadata.credentialRef,
      provider: providerId,
      kind: credentialKinds[providerId],
      backend: "memory",
      scopes: metadata.scopes,
      accountId: metadata.accountId,
      expiresAt: metadata.expiresAt,
      testedAt: "2026-08-09T10:00:00.000Z",
      testStatus: "passed",
      value: `fixture-${providerId}-credential-value`,
    });
  }
  return {
    authorization: "dry_run",
    transports: {
      cli: new MockProviderTransport("cli"),
      http: new MockProviderTransport("http"),
    },
    credentials: broker,
    redactor: broker.redactor,
  };
}

describe("Founder Stack doctor", () => {
  it("reports every role through existing provider doctors without a Launch Grant or effect", async () => {
    const connection = fixture();
    const context = await verifiedContext(connection);

    const report = await doctorFounderStackConnection({
      connection,
      context,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "ready",
      externalEffects: false,
      launchGrantRequired: false,
      verificationScope: "credential_and_transport_readiness_only",
      liveProviderState: "not_checked",
      writableCredentialTargets: {
        status: "ready",
        fixtureOnly: true,
        targets: expect.arrayContaining([
          expect.objectContaining({ purpose: "neon_database_uri", backend: "memory" }),
          expect.objectContaining({ purpose: "stripe_webhook_signing", backend: "memory" }),
          expect.objectContaining({
            purpose: "google_analytics_measurement_id",
            backend: "memory",
          }),
        ]),
      },
    });
    expect(report.roles).toHaveLength(9);
    expect(report.roles.filter(({ status }) => status === "ready")).toHaveLength(8);
    expect(report.roles.find(({ role }) => role === "dns.records")).toMatchObject({
      providerId: "dns",
      status: "manual_only",
      nextCommand: "vh launch --dry-run",
      liveProviderState: "not_checked",
    });
  });

  it("fails writable capture preflight before any provider operation when the backend is absent", async () => {
    const base = fixture();
    const connection = parseFounderStackConnection({
      ...base,
      writableCredentialBackend: { mode: "shared", backend: "onepassword" },
    });
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);

    await expect(
      registerFounderStackWritableCredentialRefs(
        connection,
        { ventureSlug: "backend-absent" },
        broker,
      ),
    ).rejects.toThrow(/backend/i);
    const report = await doctorFounderStackConnection({
      connection,
      context: {
        authorization: "approved",
        transports: {
          cli: new MockProviderTransport("cli"),
          http: new MockProviderTransport("http"),
        },
        credentials: broker,
        redactor: broker.redactor,
      },
    });
    expect(report.writableCredentialTargets).toMatchObject({
      status: "unconfigured",
      fixtureOnly: false,
      nextCommand: "vh stack create founder-default --file <connection.json>",
    });
    expect(
      report.roles
        .filter(({ role }) => ["database.postgres", "commerce.web", "growth.google"].includes(role))
        .every(({ status }) => status !== "ready"),
    ).toBe(true);
  });

  it("keeps provider-factory defaults explicit and marks a missing value as attention required", async () => {
    const base = fixture();
    const connection = parseFounderStackConnection({
      ...base,
      launchDefaults: {
        ...base.launchDefaults,
        google: { analyticsAccountId: null },
      },
    });
    const context = await verifiedContext(connection);
    const report = await doctorFounderStackConnection({ connection, context });

    expect(report.status).toBe("attention_required");
    expect(report.roles.find(({ role }) => role === "growth.google")).toMatchObject({
      status: "unconfigured",
      missingLaunchDefaults: ["launchDefaults.google.analyticsAccountId"],
      nextCommand: "vh stack create founder-default --file <connection.json>",
    });
  });

  it("requires one exact manual DNS adapter and destination before reporting DNS readiness", async () => {
    const base = JSON.parse(readFileSync(fixturePath, "utf8"));
    const missingAdapter = parseFounderStackConnection({
      ...base,
      launchDefaults: {
        ...base.launchDefaults,
        dns: { ...base.launchDefaults.dns, adapter: null },
      },
    });
    const missingDestinationInput = structuredClone(base);
    delete missingDestinationInput.roles["dns.records"].organizationId;
    const missingDestination = parseFounderStackConnection(missingDestinationInput);
    const [adapterReport, destinationReport] = await Promise.all([
      doctorFounderStackConnection({
        connection: missingAdapter,
        context: await verifiedContext(missingAdapter),
      }),
      doctorFounderStackConnection({
        connection: missingDestination,
        context: await verifiedContext(missingDestination),
      }),
    ]);

    expect(adapterReport.status).toBe("attention_required");
    expect(adapterReport.roles.find(({ role }) => role === "dns.records")).toMatchObject({
      status: "unconfigured",
      missingLaunchDefaults: ["launchDefaults.dns.adapter"],
    });
    expect(destinationReport.status).toBe("attention_required");
    expect(destinationReport.roles.find(({ role }) => role === "dns.records")).toMatchObject({
      status: "unconfigured",
      missingLaunchDefaults: [
        "launchDefaults.dns.registrarAccountId or roles.dns.records.accountId/organizationId",
      ],
    });
  });

  it("does not trust declared verification when the credential broker cannot prove access", async () => {
    const base = fixture();
    const connection = parseFounderStackConnection({
      ...base,
      roles: {
        ...base.roles,
        "source.repository": {
          ...base.roles["source.repository"],
          verification: {
            status: "verified",
            verifiedAt: "2026-08-09T10:00:00.000Z",
            source: "official_cli",
          },
        },
      },
    });
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    const report = await doctorFounderStackConnection({
      connection,
      context: {
        authorization: "approved",
        transports: {
          cli: new MockProviderTransport("cli"),
          http: new MockProviderTransport("http"),
        },
        credentials: broker,
        redactor: broker.redactor,
      },
    });

    expect(report.externalEffects).toBe(false);
    expect(report.roles.find(({ role }) => role === "source.repository")).toMatchObject({
      status: "auth_required",
      providerDoctorStatus: "auth_required",
      nextCommand: "vh auth test github --ref cred://github/founder-default",
      liveProviderState: "not_checked",
    });
  });

  it("routes create and restart doctor through the root CLI service", async () => {
    const directory = temporaryDirectory();
    cpSync(fixturePath, join(directory, "connection.json"));
    const stateRoot = join(directory, "founder-state");
    const workflowStore = new FileWorkflowStore({ rootDir: join(directory, "runs") });
    const context = await verifiedContext(fixture());
    const first = io();
    const services = createDefaultCliServices({
      rootDir: directory,
      founderStackRoot: stateRoot,
      store: workflowStore,
      credentialBroker: context.credentials,
      providerContext: context,
    });

    const created = await runCli(
      ["stack", "create", "founder-default", "--file", "connection.json", "--json"],
      { io: first.io, store: workflowStore, services },
    );
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(first.stdout[0])).toMatchObject({
      status: "created",
      profileId: "founder-default",
      roleCount: 9,
      valuesExposed: false,
      externalEffects: false,
    });

    const second = io();
    const restarted = createDefaultCliServices({
      rootDir: directory,
      founderStackRoot: stateRoot,
      store: workflowStore,
      credentialBroker: context.credentials,
      providerContext: context,
    });
    const diagnosed = await runCli(["stack", "doctor", "founder-default", "--json"], {
      io: second.io,
      store: workflowStore,
      services: restarted,
    });
    expect(diagnosed.exitCode).toBe(0);
    expect(second.stderr).toEqual([]);
    expect(JSON.parse(second.stdout[0])).toMatchObject({
      profileId: "founder-default",
      status: "ready",
      externalEffects: false,
      launchGrantRequired: false,
      roles: expect.arrayContaining([
        expect.objectContaining({ role: "source.repository", status: "ready" }),
        expect.objectContaining({ role: "dns.records", status: "manual_only" }),
      ]),
    });
  });
});
