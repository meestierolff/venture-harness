import { describe, expect, it } from "vitest";
import {
  CredentialBroker,
  credentialKinds,
  EnvironmentCredentialBackend,
  MacOSKeychainCredentialBackend,
  MemoryCredentialBackend,
  OnePasswordCredentialBackend,
  Redactor,
  type CommandInvocation,
  type CommandResult,
  type CommandRunner,
} from "@/lib/credentials";

class RecordingRunner implements CommandRunner {
  readonly invocations: CommandInvocation[] = [];

  constructor(
    private readonly respond: (invocation: CommandInvocation) => CommandResult = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  ) {}

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.invocations.push(invocation);
    return this.respond(invocation);
  }
}

describe("credential broker", () => {
  it("stores every supported credential kind behind references only", async () => {
    const backend = new MemoryCredentialBackend();
    const broker = new CredentialBroker([backend]);

    for (const kind of credentialKinds) {
      const secret = `secret-${kind}-value`;
      const reference = await broker.store({
        ref: `cred://example/${kind}`,
        provider: "example",
        kind,
        backend: "memory",
        scopes: ["read", "write"],
        value: secret,
      });
      expect(reference).not.toHaveProperty("value");
      expect(JSON.stringify(reference)).not.toContain(secret);
      expect(await broker.withSecret(reference.ref, async (value) => value)).toBe(secret);
      expect(await broker.inspect(reference.ref)).toMatchObject({
        status: "available",
        kind,
      });
    }

    expect(broker.list()).toHaveLength(credentialKinds.length);
    expect(JSON.stringify(broker.list())).not.toContain("secret-api_key-value");
  });

  it("tests, updates safe metadata, redacts tester output, and revokes", async () => {
    const backend = new MemoryCredentialBackend();
    const broker = new CredentialBroker([backend]);
    const raw = "sk_live_do_not_log";
    await broker.store({
      ref: "cred://stripe/primary",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "memory",
      value: raw,
      scopes: [],
    });

    const tested = await broker.test("cred://stripe/primary", async (secret) => ({
      ok: true,
      accountId: "acct_example",
      scopes: ["products:write"],
      message: `Bearer ${secret}`,
      details: { authorization: secret },
    }));
    expect(tested).toMatchObject({
      ok: true,
      accountId: "acct_example",
      scopes: ["products:write"],
      message: "Bearer [REDACTED]",
      details: { authorization: "[REDACTED]" },
    });
    expect(await broker.inspect("cred://stripe/primary")).toMatchObject({
      status: "available",
      accountId: "acct_example",
      scopes: ["products:write"],
      testStatus: "passed",
    });

    await expect(broker.revoke("cred://stripe/primary")).resolves.toMatchObject({
      ref: "cred://stripe/primary",
      removed: true,
      localAccessDisabled: true,
      revokedAt: expect.any(String),
    });
    expect(await broker.inspect("cred://stripe/primary")).toMatchObject({
      status: "revoked",
    });
    await expect(
      broker.withSecret("cred://stripe/primary", async () => "unexpected"),
    ).rejects.toThrow(/revoked/);
  });

  it("persists failed remote tests without accepting returned identity metadata", async () => {
    const backend = new MemoryCredentialBackend();
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://neon/failed-test",
      provider: "neon",
      kind: "api_key",
      backend: "memory",
      value: "neon-test-value",
      accountId: "original-account",
      scopes: ["read"],
    });

    await expect(
      broker.test("cred://neon/failed-test", async () => ({
        ok: false,
        accountId: "untrusted-account",
        scopes: ["*"],
      })),
    ).resolves.toMatchObject({ ok: false });
    expect(await broker.inspect("cred://neon/failed-test")).toMatchObject({
      status: "available",
      testedAt: expect.any(String),
      testStatus: "failed",
      accountId: "original-account",
      scopes: ["read"],
    });
  });

  it("keeps a read-only reference durably disabled when backend removal fails", async () => {
    const backend = new EnvironmentCredentialBackend({
      env: { NEON_READ_ONLY: "environment-neon-secret" },
      variableForRef: { "cred://neon/read-only": "NEON_READ_ONLY" },
    });
    const broker = new CredentialBroker([backend]);
    broker.register({
      ref: "cred://neon/read-only",
      provider: "neon",
      kind: "api_key",
      backend: "environment",
    });

    await expect(broker.revoke("cred://neon/read-only")).resolves.toMatchObject({
      removed: false,
      localAccessDisabled: true,
    });
    const disabled = broker.getReference("cred://neon/read-only")!;
    expect(disabled.revokedAt).toEqual(expect.any(String));

    const restarted = new CredentialBroker([backend]);
    restarted.register(disabled);
    await expect(restarted.inspect(disabled.ref)).resolves.toMatchObject({ status: "revoked" });
    await expect(restarted.withSecret(disabled.ref, async () => "unexpected")).rejects.toThrow(
      /revoked/,
    );
  });

  it("disables access even when backend deletion throws and redacts the failure", async () => {
    const backend = new MemoryCredentialBackend();
    const raw = "delete-error-secret";
    backend.delete = async () => {
      throw new Error(`could not delete ${raw}`);
    };
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://github/delete-error",
      provider: "github",
      kind: "api_key",
      backend: "memory",
      value: raw,
    });

    const result = await broker.revoke("cred://github/delete-error");
    expect(result).toMatchObject({
      removed: false,
      localAccessDisabled: true,
      localRemovalError: "could not delete [REDACTED]",
    });
    expect(JSON.stringify(result)).not.toContain(raw);
    await expect(broker.inspect("cred://github/delete-error")).resolves.toMatchObject({
      status: "revoked",
    });
  });

  it("redacts a credential tester exception before it crosses the broker", async () => {
    const broker = new CredentialBroker([new MemoryCredentialBackend()]);
    const raw = "oauth-token-in-error";
    await broker.store({
      ref: "cred://google/error",
      provider: "google",
      kind: "oauth",
      backend: "memory",
      value: raw,
    });
    await expect(
      broker.test("cred://google/error", async () => {
        throw new Error(`Authorization: Bearer ${raw}`);
      }),
    ).rejects.toMatchObject({
      message: "Authorization=[REDACTED]",
    });
  });

  it("marks expired references without reading the secret", async () => {
    const backend = new MemoryCredentialBackend();
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://google/expired",
      provider: "google",
      kind: "oauth",
      backend: "memory",
      value: "expired-access-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(await broker.inspect("cred://google/expired")).toMatchObject({
      status: "expired",
    });
  });

  it("resolves a mapped environment variable and stays read-only", async () => {
    const backend = new EnvironmentCredentialBackend({
      env: { STRIPE_TEST_KEY: "environment-secret" },
      variableForRef: {
        "cred://stripe/test": "STRIPE_TEST_KEY",
      },
    });
    const broker = new CredentialBroker([backend]);
    broker.register({
      ref: "cred://stripe/test",
      provider: "stripe",
      kind: "restricted_api_key",
      backend: "environment",
    });

    expect(await broker.inspect("cred://stripe/test")).toMatchObject({
      status: "available",
      writable: false,
    });
    await expect(
      broker.store({
        ref: "cred://stripe/replacement",
        provider: "stripe",
        kind: "api_key",
        backend: "environment",
        value: "new-secret",
      }),
    ).rejects.toMatchObject({ code: "backend_read_only" });
  });

  it("uses direct macOS Keychain argv and marks the secret argument sensitive", async () => {
    const raw = "keychain-secret";
    const runner = new RecordingRunner((invocation) => {
      if (invocation.args.includes("-w") && invocation.args[0] === "find-generic-password") {
        return { exitCode: 0, stdout: `${raw}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const backend = new MacOSKeychainCredentialBackend({ runner });
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://github/keychain",
      provider: "github",
      kind: "api_key",
      backend: "macos_keychain",
      value: raw,
    });

    const write = runner.invocations[0];
    expect(write.command).toBe("/usr/bin/security");
    expect(write.command).not.toMatch(/\s|sh$/);
    expect(write.args.at(-1)).toBe(raw);
    expect(write.sensitiveArgs).toEqual([write.args.length - 1]);
    expect(await broker.withSecret("cred://github/keychain", async (value) => value)).toBe(raw);
  });

  it("supports optional 1Password command storage without a shell", async () => {
    const runner = new RecordingRunner((invocation) =>
      invocation.args.includes("--reveal")
        ? { exitCode: 0, stdout: "op-secret\n", stderr: "" }
        : { exitCode: 0, stdout: "{}", stderr: "" },
    );
    const backend = new OnePasswordCredentialBackend({
      runner,
      vault: "Venture Harness",
      itemForRef: () => "GitHub automation",
    });
    const broker = new CredentialBroker([backend]);
    await broker.store({
      ref: "cred://github/onepassword",
      provider: "github",
      kind: "api_key",
      backend: "onepassword",
      value: "op-secret",
    });

    expect(runner.invocations[0]).toMatchObject({
      command: "op",
      args: [
        "item",
        "edit",
        "GitHub automation",
        "--vault",
        "Venture Harness",
        "credential=op-secret",
      ],
      sensitiveArgs: [5],
    });
    expect(await broker.withSecret("cred://github/onepassword", async (v) => v)).toBe("op-secret");
  });
});

describe("credential redaction", () => {
  it("redacts known values, auth schemes, URLs, and sensitive object keys", () => {
    const redactor = new Redactor();
    redactor.addSecret("known-secret");
    const result = redactor.redact({
      safe: "kept",
      nested: {
        token: "another-secret",
        message: "Bearer known-secret and password=hunter2",
        url: "https://user:known-secret@example.test/path",
      },
    });
    expect(result).toEqual({
      safe: "kept",
      nested: {
        token: "[REDACTED]",
        message: "Bearer [REDACTED] and password=[REDACTED]",
        url: "https://user:[REDACTED]@example.test/path",
      },
    });
  });
});
