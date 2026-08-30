import { describe, expect, it, vi } from "vitest";
import {
  NodeCommandRunner,
  onePasswordCommandEnvironment,
  providerCommandEnvironment,
  PROVIDER_COMMAND_AUTH_ENVIRONMENT_NAMES,
  PROVIDER_COMMAND_INVOCATION_ENVIRONMENT_NAMES,
  Redactor,
} from "@/lib/credentials";
import { NativeHttpFetcher, type RedactedHttpRequestMetadata } from "@/lib/runtime";

describe("official native provider transports", () => {
  it("uses the least-privilege provider environment by default", async () => {
    const previous = process.env.VH_UNRELATED_PROVIDER_SECRET;
    process.env.VH_UNRELATED_PROVIDER_SECRET = "must-not-cross-default-runner";
    const runner = new NodeCommandRunner();
    if (previous === undefined) delete process.env.VH_UNRELATED_PROVIDER_SECRET;
    else process.env.VH_UNRELATED_PROVIDER_SECRET = previous;

    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.VH_UNRELATED_PROVIDER_SECRET ?? 'missing')"],
    });

    expect(result.stdout).toBe("missing");
  });

  it("executes a binary directly and passes shell metacharacters as literal argv", async () => {
    const runner = new NodeCommandRunner();
    const literal = "value; echo not-a-second-command && still-literal";
    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", literal],
    });

    expect(result).toEqual({ exitCode: 0, stdout: literal, stderr: "" });
    await expect(runner.run({ command: "sh", args: ["-c", "echo forbidden"] })).rejects.toThrow(
      /Shell executables are forbidden/,
    );

    const scrubbedRunner = new NodeCommandRunner({
      env: { NODE_ENV: "test", VH_REMOVE_IN_CHILD: "must-not-survive" },
    });
    const scrubbed = await scrubbedRunner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.VH_REMOVE_IN_CHILD ?? 'missing')"],
      env: { VH_REMOVE_IN_CHILD: undefined },
    });
    expect(scrubbed.stdout).toBe("missing");
  });

  it("replaces the host environment with a provider allowlist and one brokered auth value", async () => {
    const hostEnvironment = {
      PATH: process.env.PATH,
      HOME: "/fixture/provider-session-home",
      LANG: "en_US.UTF-8",
      GH_TOKEN: "must-not-cross",
      NODE_OPTIONS: "--require=/tmp/injected.cjs",
      GIT_CONFIG_GLOBAL: "/tmp/attacker.gitconfig",
      npm_config_userconfig: "/tmp/attacker.npmrc",
      HTTPS_PROXY: "https://proxy-user:proxy-password@example.test",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      OP_SERVICE_ACCOUNT_TOKEN: "must-stay-at-credential-helper",
    } satisfies Record<string, string | undefined>;
    const runner = new NodeCommandRunner({
      env: providerCommandEnvironment(hostEnvironment),
      allowedInvocationEnv: PROVIDER_COMMAND_AUTH_ENVIRONMENT_NAMES,
    });
    const result = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).sort())))",
      ],
      env: { NEON_API_KEY: "brokered-for-one-call" },
      sensitiveEnv: ["NEON_API_KEY"],
    });

    const environment = JSON.parse(result.stdout) as Record<string, string>;
    expect(environment).toMatchObject({
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: "/fixture/provider-session-home",
      LANG: "en_US.UTF-8",
      NEON_API_KEY: "brokered-for-one-call",
      NODE_ENV: "production",
      NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
    });
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment.GIT_CONFIG_GLOBAL).not.toBe("/tmp/attacker.gitconfig");
    expect(environment.npm_config_userconfig).not.toBe("/tmp/attacker.npmrc");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(environment).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");

    await expect(
      runner.run({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { NODE_OPTIONS: "--inspect" },
      }),
    ).rejects.toThrow(/not allowlisted: NODE_OPTIONS/);
  });

  it("keeps 1Password authentication in an explicit credential-helper environment", () => {
    const source = {
      HOME: "/fixture/home",
      OP_SERVICE_ACCOUNT_TOKEN: "service-account-fixture",
      OP_CONNECT_HOST: "https://connect.example.test",
      OP_CONNECT_TOKEN: "connect-fixture",
      OP_SESSION_FOUNDER: "session-fixture",
      OP_SESSION_founder_secondary: "second-session-fixture",
      OP_FORMAT: "json",
      GH_TOKEN: "must-not-cross",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    } satisfies Record<string, string | undefined>;

    expect(providerCommandEnvironment(source)).toEqual({
      NODE_ENV: "production",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      NPM_CONFIG_GLOBALCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
      NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
      npm_config_globalconfig: process.platform === "win32" ? "NUL" : "/dev/null",
      npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
      HOME: "/fixture/home",
    });
    expect(onePasswordCommandEnvironment(source)).toEqual({
      NODE_ENV: "production",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      NPM_CONFIG_GLOBALCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
      NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
      npm_config_globalconfig: process.platform === "win32" ? "NUL" : "/dev/null",
      npm_config_userconfig: process.platform === "win32" ? "NUL" : "/dev/null",
      HOME: "/fixture/home",
      OP_SERVICE_ACCOUNT_TOKEN: "service-account-fixture",
      OP_CONNECT_HOST: "https://connect.example.test",
      OP_CONNECT_TOKEN: "connect-fixture",
      OP_SESSION_FOUNDER: "session-fixture",
      OP_SESSION_founder_secondary: "second-session-fixture",
    });
  });

  it("permits only the finite broker-derived psql environment used by aggregate learning", async () => {
    const runner = new NodeCommandRunner({
      env: providerCommandEnvironment({ DATABASE_URL: "must-not-cross" }),
      allowedInvocationEnv: PROVIDER_COMMAND_INVOCATION_ENVIRONMENT_NAMES,
    });
    const result = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        [
          "const expected = ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGAPPNAME','PGOPTIONS','PGSSLMODE','PGCHANNELBINDING','PGCONNECT_TIMEOUT'];",
          "process.exit(expected.every((key) => Object.hasOwn(process.env, key)) && process.env.DATABASE_URL === undefined ? 0 : 1);",
        ].join(""),
      ],
      env: {
        DATABASE_URL: undefined,
        PGSERVICE: undefined,
        PGPASSFILE: undefined,
        PGHOST: "ep-fixture.neon.tech",
        PGPORT: "5432",
        PGDATABASE: "fixture",
        PGUSER: "fixture",
        PGPASSWORD: "fixture-password",
        PGAPPNAME: "venture-harness-data-sync",
        PGOPTIONS: "",
        PGSSLMODE: "require",
        PGCHANNELBINDING: "require",
        PGCONNECT_TIMEOUT: "10",
      },
      sensitiveEnv: ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"],
    });

    expect(result.exitCode).toBe(0);
  });

  it("uses native fetch while exposing only redacted sensitive metadata", async () => {
    const secret = "fetcher-secret-value";
    const redactor = new Redactor();
    redactor.addSecret(secret);
    const metadata: RedactedHttpRequestMetadata[] = [];
    let receivedAuthorization = "";
    const fetcher = new NativeHttpFetcher({
      redactor,
      onRequest: (entry) => metadata.push(entry),
      allowedHosts: ["api.example.test"],
      resolveHost: async () => ["93.184.216.34"],
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json", "set-cookie": secret },
        });
      }) as typeof globalThis.fetch,
    });

    const result = await fetcher.fetch({
      method: "GET",
      url: `https://api.example.test/resource?api_key=${secret}`,
      headers: { Authorization: `Bearer ${secret}`, "X-Trace": `trace-${secret}` },
      sensitiveHeaders: ["authorization"],
      sensitiveUrl: true,
    });

    expect(receivedAuthorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(metadata)).not.toContain(secret);
    expect(metadata[0]).toMatchObject({
      method: "GET",
      headers: { Authorization: "[REDACTED]", "X-Trace": "trace-[REDACTED]" },
      hasBody: false,
    });
    expect(metadata[0].url).toContain("api_key=%5BREDACTED%5D");
    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
  });

  it("revalidates redirects, strips cross-host credentials, and forbids write redirects", async () => {
    const seenAuthorization: Array<string | null> = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async (_input, init) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization"));
        return new Response(null, {
          status: 302,
          headers: { location: "https://read.example.test/result" },
        });
      })
      .mockImplementationOnce(async (_input, init) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization"));
        return new Response('{"ok":true}', { status: 200 });
      });
    const fetcher = new NativeHttpFetcher({
      fetch,
      allowedHosts: ["api.example.test", "read.example.test"],
      resolveHost: async () => ["93.184.216.34"],
    });
    await expect(
      fetcher.fetch({
        method: "GET",
        url: "https://api.example.test/start",
        headers: { Authorization: "Bearer fixture-secret" },
        sensitiveHeaders: ["authorization"],
        sensitiveUrl: false,
      }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(seenAuthorization).toEqual(["Bearer fixture-secret", null]);

    const writeRedirect = new NativeHttpFetcher({
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { location: "https://api.example.test/other" },
          }),
        ),
      ),
      allowedHosts: ["api.example.test"],
      resolveHost: async () => ["93.184.216.34"],
    });
    await expect(
      writeRedirect.fetch({
        method: "POST",
        url: "https://api.example.test/write",
        headers: {},
        body: "{}",
        sensitiveHeaders: [],
        sensitiveUrl: false,
      }),
    ).rejects.toThrow(/write redirects are forbidden/);
  });
});
