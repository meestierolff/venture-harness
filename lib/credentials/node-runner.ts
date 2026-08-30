import { spawn } from "node:child_process";
import { providerCommandEnvironment } from "./provider-environment";
import type { CommandInvocation, CommandResult, CommandRunner } from "./types";

const SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

function executableName(command: string): string {
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

export function assertDirectCommand(command: string): void {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed !== command || /\s/.test(trimmed)) {
    throw new Error(
      "Commands must name one executable directly; shell command strings are forbidden",
    );
  }
  if (SHELL_BINARIES.has(executableName(trimmed))) {
    throw new Error(`Shell executables are forbidden: ${executableName(trimmed)}`);
  }
}

export interface NodeCommandRunnerOptions {
  /** Complete base environment for the child; this never merges with process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional allowlist for per-invocation additions such as brokered provider auth. */
  allowedInvocationEnv?: readonly string[];
  maxOutputBytes?: number;
}

/**
 * Executes one binary with a literal argv array. No input is ever interpreted
 * by a shell, including arguments containing shell metacharacters.
 */
export class NodeCommandRunner implements CommandRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly allowedInvocationEnv: ReadonlySet<string>;
  private readonly maxOutputBytes: number;

  constructor(options: NodeCommandRunnerOptions = {}) {
    this.env = { ...(options.env ?? providerCommandEnvironment(process.env)) };
    this.allowedInvocationEnv = new Set(options.allowedInvocationEnv ?? []);
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  }

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    assertDirectCommand(invocation.command);
    const forbidden = Object.entries(invocation.env ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .find((key) => !this.allowedInvocationEnv.has(key));
    if (forbidden) {
      throw new Error(`Command environment variable is not allowlisted: ${forbidden}`);
    }
    const environment = Object.fromEntries(
      Object.entries({ ...this.env, ...invocation.env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ) as NodeJS.ProcessEnv;

    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let exceededLimit = false;
      const abort = () => child.kill("SIGTERM");

      const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (exceededLimit) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > this.maxOutputBytes) {
          exceededLimit = true;
          child.kill("SIGTERM");
          return;
        }
        if (stream === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };

      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        invocation.signal?.removeEventListener("abort", abort);
        if (exceededLimit) {
          reject(new Error(`Command output exceeded ${this.maxOutputBytes} bytes`));
          return;
        }
        resolve({
          exitCode: code ?? (signal ? 1 : 0),
          stdout,
          stderr,
        });
      });

      if (invocation.signal?.aborted) abort();
      else invocation.signal?.addEventListener("abort", abort, { once: true });

      if (invocation.stdin !== undefined) child.stdin.end(invocation.stdin);
      else child.stdin.end();
    });
  }
}
