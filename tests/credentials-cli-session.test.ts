import { describe, expect, it } from "vitest";
import {
  CLI_AUTH_COMMANDS,
  CliSessionCredentialBackend,
  supportsInteractiveCliAuth,
  type CommandInvocation,
  type CommandRunner,
} from "@/lib/credentials";

class FakeRunner implements CommandRunner {
  calls: CommandInvocation[] = [];
  constructor(private readonly exitCode = 0) {}
  async run(invocation: CommandInvocation) {
    this.calls.push(invocation);
    return { exitCode: this.exitCode, stdout: "", stderr: "" };
  }
}

const github = {
  ref: "cred://github/default",
  provider: "github",
  kind: "cli_session" as const,
  backend: "cli_session",
  scopes: ["repo"],
};

describe("official CLI session backend", () => {
  it("checks and revokes without reading or copying a session token", async () => {
    const runner = new FakeRunner();
    const backend = new CliSessionCredentialBackend(runner);
    expect(await backend.get(github)).toBeNull();
    expect(await backend.inspect(github)).toMatchObject({ status: "available", writable: false });
    expect(await backend.delete(github)).toBe(true);
    expect(runner.calls).toEqual([
      { command: "gh", args: ["auth", "status"] },
      { command: "gh", args: ["auth", "logout", "--hostname", "github.com"] },
    ]);
  });

  it("publishes only literal official command and argv specifications", () => {
    expect(supportsInteractiveCliAuth("github")).toBe(true);
    expect(supportsInteractiveCliAuth("brevo")).toBe(false);
    for (const commands of Object.values(CLI_AUTH_COMMANDS)) {
      for (const spec of Object.values(commands)) {
        expect(spec.command).not.toMatch(/\s|sh$/);
        expect(Array.isArray(spec.args)).toBe(true);
      }
    }
  });
});
