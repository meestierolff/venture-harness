import {
  CredentialBackend,
  CredentialBackendInspection,
  CredentialError,
  CredentialReference,
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "./types";

function commandFailure(backend: string, action: string, result: CommandResult): CredentialError {
  return new CredentialError(
    `${backend} could not ${action} credential (exit ${result.exitCode})`,
    "backend_failure",
  );
}

function assertNoShell(invocation: CommandInvocation): void {
  const binary = invocation.command.trim();
  if (
    binary.length === 0 ||
    /\s/.test(binary) ||
    ["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].includes(
      binary.split("/").at(-1) ?? binary,
    )
  ) {
    throw new CredentialError(
      `Credential commands must call a binary directly: ${invocation.command}`,
      "backend_failure",
    );
  }
}

async function runDirect(
  runner: CommandRunner,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  assertNoShell(invocation);
  return runner.run(invocation);
}

export class MemoryCredentialBackend implements CredentialBackend {
  readonly id: string;
  readonly writable = true;
  private readonly values = new Map<string, string>();

  constructor(id = "memory") {
    this.id = id;
  }

  async get(reference: CredentialReference): Promise<string | null> {
    return this.values.get(reference.ref) ?? null;
  }

  async set(reference: CredentialReference, value: string): Promise<void> {
    this.values.set(reference.ref, value);
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    return this.values.delete(reference.ref);
  }

  async inspect(reference: CredentialReference): Promise<CredentialBackendInspection> {
    return {
      status: this.values.has(reference.ref) ? "available" : "missing",
      writable: true,
    };
  }
}

export interface EnvironmentBackendOptions {
  env?: Readonly<Record<string, string | undefined>>;
  variableForRef?: Readonly<Record<string, string>> | ((ref: string) => string);
  id?: string;
}

export class EnvironmentCredentialBackend implements CredentialBackend {
  readonly id: string;
  readonly writable = false;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly variableForRef: Readonly<Record<string, string>> | ((ref: string) => string);

  constructor(options: EnvironmentBackendOptions = {}) {
    this.id = options.id ?? "environment";
    this.env = options.env ?? process.env;
    this.variableForRef =
      options.variableForRef ??
      ((ref) =>
        ref
          .replace(/^cred:\/\//, "")
          .replace(/[^a-z0-9]+/gi, "_")
          .toUpperCase());
  }

  private variable(reference: CredentialReference): string {
    return typeof this.variableForRef === "function"
      ? this.variableForRef(reference.ref)
      : (this.variableForRef[reference.ref] ?? "");
  }

  async get(reference: CredentialReference): Promise<string | null> {
    const variable = this.variable(reference);
    return variable ? (this.env[variable] ?? null) : null;
  }

  async set(): Promise<void> {
    throw new CredentialError(
      "Environment credentials are read-only; update the process environment",
      "backend_read_only",
    );
  }

  async delete(): Promise<boolean> {
    return false;
  }

  async inspect(reference: CredentialReference): Promise<CredentialBackendInspection> {
    const variable = this.variable(reference);
    return {
      status: variable && this.env[variable] ? "available" : "missing",
      writable: false,
      message: variable
        ? `Resolved from environment variable ${variable}`
        : "No environment variable is mapped to this credential reference",
    };
  }
}

export interface MacOSKeychainBackendOptions {
  runner: CommandRunner;
  service?: string;
  binary?: string;
  id?: string;
}

export class MacOSKeychainCredentialBackend implements CredentialBackend {
  readonly id: string;
  readonly writable = true;
  private readonly runner: CommandRunner;
  private readonly service: string;
  private readonly binary: string;

  constructor(options: MacOSKeychainBackendOptions) {
    this.id = options.id ?? "macos_keychain";
    this.runner = options.runner;
    this.service = options.service ?? "venture-harness";
    this.binary = options.binary ?? "/usr/bin/security";
  }

  async get(reference: CredentialReference): Promise<string | null> {
    const result = await runDirect(this.runner, {
      command: this.binary,
      args: ["find-generic-password", "-s", this.service, "-a", reference.ref, "-w"],
    });
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw commandFailure(this.id, "read", result);
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(reference: CredentialReference, value: string): Promise<void> {
    const args = [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      reference.ref,
      "-w",
      value,
    ];
    const result = await runDirect(this.runner, {
      command: this.binary,
      args,
      sensitiveArgs: [args.length - 1],
    });
    if (result.exitCode !== 0) throw commandFailure(this.id, "store", result);
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    const result = await runDirect(this.runner, {
      command: this.binary,
      args: ["delete-generic-password", "-s", this.service, "-a", reference.ref],
    });
    if (result.exitCode === 44) return false;
    if (result.exitCode !== 0) throw commandFailure(this.id, "delete", result);
    return true;
  }

  async inspect(reference: CredentialReference): Promise<CredentialBackendInspection> {
    const result = await runDirect(this.runner, {
      command: this.binary,
      args: ["find-generic-password", "-s", this.service, "-a", reference.ref],
    });
    if (result.exitCode === 44) return { status: "missing", writable: true };
    if (result.exitCode !== 0) {
      return {
        status: "unavailable",
        writable: true,
        message: `Keychain inspection failed with exit ${result.exitCode}`,
      };
    }
    return { status: "available", writable: true };
  }
}

export interface OnePasswordBackendOptions {
  runner: CommandRunner;
  itemForRef?: (ref: string) => string;
  field?: string;
  vault?: string;
  binary?: string;
  id?: string;
}

export class OnePasswordCredentialBackend implements CredentialBackend {
  readonly id: string;
  readonly writable = true;
  private readonly runner: CommandRunner;
  private readonly itemForRef: (ref: string) => string;
  private readonly field: string;
  private readonly vault?: string;
  private readonly binary: string;

  constructor(options: OnePasswordBackendOptions) {
    this.id = options.id ?? "onepassword";
    this.runner = options.runner;
    this.itemForRef = options.itemForRef ?? ((ref) => ref);
    this.field = options.field ?? "credential";
    this.vault = options.vault;
    this.binary = options.binary ?? "op";
  }

  private vaultArgs(): string[] {
    return this.vault ? ["--vault", this.vault] : [];
  }

  async get(reference: CredentialReference): Promise<string | null> {
    const result = await runDirect(this.runner, {
      command: this.binary,
      args: [
        "item",
        "get",
        this.itemForRef(reference.ref),
        ...this.vaultArgs(),
        "--fields",
        `label=${this.field}`,
        "--reveal",
      ],
    });
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw commandFailure(this.id, "read", result);
    return result.stdout.replace(/\r?\n$/, "");
  }

  async set(reference: CredentialReference, value: string): Promise<void> {
    const assignment = `${this.field}=${value}`;
    const args = ["item", "edit", this.itemForRef(reference.ref), ...this.vaultArgs(), assignment];
    const result = await runDirect(this.runner, {
      command: this.binary,
      args,
      sensitiveArgs: [args.length - 1],
    });
    if (result.exitCode !== 0) throw commandFailure(this.id, "store", result);
  }

  async delete(reference: CredentialReference): Promise<boolean> {
    const result = await runDirect(this.runner, {
      command: this.binary,
      args: ["item", "delete", this.itemForRef(reference.ref), ...this.vaultArgs(), "--archive"],
    });
    if (result.exitCode === 1) return false;
    if (result.exitCode !== 0) throw commandFailure(this.id, "archive", result);
    return true;
  }

  async inspect(reference: CredentialReference): Promise<CredentialBackendInspection> {
    const result = await runDirect(this.runner, {
      command: this.binary,
      args: [
        "item",
        "get",
        this.itemForRef(reference.ref),
        ...this.vaultArgs(),
        "--format",
        "json",
      ],
    });
    if (result.exitCode === 1) return { status: "missing", writable: true };
    if (result.exitCode !== 0) {
      return {
        status: "unavailable",
        writable: true,
        message: `1Password CLI inspection failed with exit ${result.exitCode}`,
      };
    }
    return { status: "available", writable: true };
  }
}
