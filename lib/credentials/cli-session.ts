import { spawn } from "node:child_process";
import { providerCommandEnvironment } from "./provider-environment";
import type {
  CommandRunner,
  CredentialBackend,
  CredentialBackendInspection,
  CredentialReference,
} from "./types";

interface CliAuthCommands {
  login: { command: string; args: string[] };
  status: { command: string; args: string[] };
  logout: { command: string; args: string[] };
}

export const CLI_AUTH_COMMANDS: Readonly<Record<string, CliAuthCommands>> = {
  github: {
    login: { command: "gh", args: ["auth", "login"] },
    status: { command: "gh", args: ["auth", "status"] },
    logout: { command: "gh", args: ["auth", "logout", "--hostname", "github.com"] },
  },
  vercel: {
    login: { command: "vercel", args: ["login"] },
    status: { command: "vercel", args: ["whoami"] },
    logout: { command: "vercel", args: ["logout"] },
  },
  stripe: {
    login: { command: "stripe", args: ["login"] },
    status: { command: "stripe", args: ["balance", "retrieve"] },
    logout: { command: "stripe", args: ["logout"] },
  },
  eas: {
    login: { command: "eas", args: ["login"] },
    status: { command: "eas", args: ["whoami"] },
    logout: { command: "eas", args: ["logout"] },
  },
};

export function supportsInteractiveCliAuth(provider: string): boolean {
  return Object.hasOwn(CLI_AUTH_COMMANDS, provider);
}

/**
 * Runs the provider's official interactive login with inherited TTY streams.
 * The session is stored by the provider CLI, never captured by the harness.
 */
export function runInteractiveCliLogin(provider: string): Promise<void> {
  const spec = CLI_AUTH_COMMANDS[provider]?.login;
  if (!spec) throw new Error(`No official interactive CLI login is registered for ${provider}.`);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: providerCommandEnvironment(process.env),
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${provider} login exited with ${code ?? "unknown"}`));
    });
  });
}

export class CliSessionCredentialBackend implements CredentialBackend {
  readonly id = "cli_session";
  readonly writable = false;

  constructor(private readonly runner: CommandRunner) {}

  async get(reference: CredentialReference): Promise<string | null> {
    // Official CLIs own their session material. Provider command transports
    // invoke the CLI directly and never need a token copied through the broker.
    void reference;
    return null;
  }

  async set(): Promise<void> {
    throw new Error("CLI sessions are created only through the provider's interactive login.");
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    const spec = CLI_AUTH_COMMANDS[reference.provider]?.logout;
    if (!spec) return false;
    const result = await this.runner.run({ command: spec.command, args: spec.args });
    return result.exitCode === 0;
  }

  async inspect(reference: CredentialReference): Promise<CredentialBackendInspection> {
    const spec = CLI_AUTH_COMMANDS[reference.provider]?.status;
    if (!spec) {
      return {
        status: "unavailable",
        writable: false,
        message: `No CLI session status command is registered for ${reference.provider}`,
      };
    }
    try {
      const result = await this.runner.run({ command: spec.command, args: spec.args });
      return {
        status: result.exitCode === 0 ? "available" : "missing",
        writable: false,
        message:
          result.exitCode === 0
            ? `${reference.provider} CLI session passed an official read check`
            : `${reference.provider} CLI session check exited with ${result.exitCode}`,
      };
    } catch (error) {
      const missingBinary = (error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        status: missingBinary ? "unavailable" : "missing",
        writable: false,
        message: missingBinary
          ? `${CLI_AUTH_COMMANDS[reference.provider]?.status.command ?? reference.provider} is not installed`
          : `CLI session check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
