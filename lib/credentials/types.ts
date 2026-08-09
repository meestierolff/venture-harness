export const credentialKinds = [
  "oauth",
  "api_key",
  "restricted_api_key",
  "jwt_private_key",
  "cli_session",
  "service_account",
  "connection_string",
  "ci_secret",
] as const;

export type CredentialKind = (typeof credentialKinds)[number];

export type CredentialStatus = "available" | "missing" | "expired" | "revoked" | "unavailable";
export type CredentialTestStatus = "passed" | "failed";

/**
 * A safe pointer to a credential. The secret value never belongs in this
 * object and must stay behind a CredentialBackend.
 */
export interface CredentialReference {
  ref: string;
  provider: string;
  kind: CredentialKind;
  backend: string;
  label?: string;
  scopes: readonly string[];
  accountId?: string;
  expiresAt?: string;
  /** Safe, durable evidence from an injected provider authorization tester. */
  testedAt?: string;
  testStatus?: CredentialTestStatus;
  /** Locally disables the reference even when a read-only backend cannot delete its value. */
  revokedAt?: string;
}

export interface CredentialInspection extends CredentialReference {
  status: CredentialStatus;
  writable: boolean;
  message?: string;
}

export interface CredentialBackendInspection {
  status: Exclude<CredentialStatus, "expired" | "revoked">;
  writable: boolean;
  message?: string;
}

export interface CredentialBackend {
  readonly id: string;
  readonly writable: boolean;
  get(reference: CredentialReference): Promise<string | null>;
  set(reference: CredentialReference, value: string): Promise<void>;
  delete(reference: CredentialReference): Promise<boolean>;
  inspect(reference: CredentialReference): Promise<CredentialBackendInspection>;
}

export interface CredentialTestResult {
  ok: boolean;
  accountId?: string;
  scopes?: readonly string[];
  expiresAt?: string;
  message?: string;
  details?: unknown;
}

export type CredentialTester = (
  secret: string,
  reference: CredentialReference,
) => Promise<CredentialTestResult>;

export interface RegisterCredentialInput {
  ref: string;
  provider: string;
  kind: CredentialKind;
  backend: string;
  label?: string;
  scopes?: readonly string[];
  accountId?: string;
  expiresAt?: string;
  testedAt?: string;
  testStatus?: CredentialTestStatus;
  revokedAt?: string;
}

export interface CredentialRevocationResult {
  ref: string;
  removed: boolean;
  localAccessDisabled: true;
  revokedAt: string;
  localRemovalError?: string;
}

export interface StoreCredentialInput extends RegisterCredentialInput {
  value: string;
}

export interface CommandInvocation {
  /** A binary path or name. This is never interpreted by a shell. */
  command: string;
  /** Literal argv entries. */
  args: readonly string[];
  cwd?: string;
  stdin?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Helps test runners and loggers suppress values without changing argv. */
  sensitiveArgs?: readonly number[];
  sensitiveEnv?: readonly string[];
  sensitiveStdin?: boolean;
  /** Allows a workflow timeout or cancellation to terminate the direct child. */
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_reference"
      | "backend_not_found"
      | "credential_not_found"
      | "backend_read_only"
      | "backend_failure",
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export function assertCredentialRef(ref: string): void {
  if (!/^cred:\/\/[a-z0-9][a-z0-9._/-]*$/i.test(ref)) {
    throw new CredentialError(
      `Credential reference must use the cred:// scheme: ${ref}`,
      "invalid_reference",
    );
  }
}
