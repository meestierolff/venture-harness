import { describe, expect, it, vi } from "vitest";
import { NodeCommandRunner, Redactor } from "@/lib/credentials";
import { NativeHttpFetcher, type RedactedHttpRequestMetadata } from "@/lib/runtime";

describe("official native provider transports", () => {
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
