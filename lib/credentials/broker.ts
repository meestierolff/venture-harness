import { Redactor } from "./redaction";
import {
  assertCredentialRef,
  CredentialBackend,
  CredentialError,
  CredentialInspection,
  CredentialRevocationResult,
  CredentialReference,
  CredentialTestResult,
  CredentialTester,
  RegisterCredentialInput,
  StoreCredentialInput,
} from "./types";

function publicReference(input: RegisterCredentialInput): CredentialReference {
  assertCredentialRef(input.ref);
  if ((input.testedAt === undefined) !== (input.testStatus === undefined)) {
    throw new CredentialError(
      `Credential test evidence requires both testedAt and testStatus: ${input.ref}`,
      "invalid_reference",
    );
  }
  for (const [field, value] of [
    ["testedAt", input.testedAt],
    ["revokedAt", input.revokedAt],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new CredentialError(
        `Credential ${field} must be an ISO timestamp: ${input.ref}`,
        "invalid_reference",
      );
    }
  }
  return {
    ref: input.ref,
    provider: input.provider,
    kind: input.kind,
    backend: input.backend,
    label: input.label,
    scopes: [...(input.scopes ?? [])],
    accountId: input.accountId,
    expiresAt: input.expiresAt,
    testedAt: input.testedAt,
    testStatus: input.testStatus,
    revokedAt: input.revokedAt,
  };
}

export class CredentialBroker {
  readonly redactor: Redactor;
  private readonly backends = new Map<string, CredentialBackend>();
  private readonly references = new Map<string, CredentialReference>();
  private readonly revoked = new Set<string>();

  constructor(backends: readonly CredentialBackend[] = [], redactor = new Redactor()) {
    this.redactor = redactor;
    for (const backend of backends) this.addBackend(backend);
  }

  addBackend(backend: CredentialBackend): void {
    if (this.backends.has(backend.id)) {
      throw new CredentialError(
        `Credential backend already registered: ${backend.id}`,
        "backend_failure",
      );
    }
    this.backends.set(backend.id, backend);
  }

  register(input: RegisterCredentialInput): CredentialReference {
    const reference = publicReference(input);
    this.requireBackend(reference.backend);
    this.references.set(reference.ref, reference);
    if (reference.revokedAt) this.revoked.add(reference.ref);
    else this.revoked.delete(reference.ref);
    return { ...reference, scopes: [...reference.scopes] };
  }

  async store(input: StoreCredentialInput): Promise<CredentialReference> {
    const { value, ...metadata } = input;
    const reference = publicReference(metadata);
    const backend = this.requireBackend(reference.backend);
    if (!backend.writable) {
      throw new CredentialError(
        `Credential backend is read-only: ${backend.id}`,
        "backend_read_only",
      );
    }
    await backend.set(reference, value);
    this.redactor.addSecret(value);
    this.references.set(reference.ref, reference);
    if (reference.revokedAt) this.revoked.add(reference.ref);
    else this.revoked.delete(reference.ref);
    return { ...reference, scopes: [...reference.scopes] };
  }

  getReference(ref: string): CredentialReference | null {
    const reference = this.references.get(ref);
    return reference ? { ...reference, scopes: [...reference.scopes] } : null;
  }

  list(): CredentialReference[] {
    return [...this.references.values()].map((reference) => ({
      ...reference,
      scopes: [...reference.scopes],
    }));
  }

  async inspect(ref: string): Promise<CredentialInspection> {
    const reference = this.requireReference(ref);
    const backend = this.requireBackend(reference.backend);
    if (this.revoked.has(ref)) {
      return {
        ...reference,
        status: "revoked",
        writable: backend.writable,
      };
    }
    const backendInspection = await backend.inspect(reference);
    const expired =
      reference.expiresAt !== undefined && new Date(reference.expiresAt).getTime() <= Date.now();
    return {
      ...reference,
      status:
        backendInspection.status === "available" && expired ? "expired" : backendInspection.status,
      writable: backendInspection.writable,
      message: backendInspection.message
        ? this.redactor.redactText(backendInspection.message)
        : undefined,
    };
  }

  async withSecret<T>(
    ref: string,
    consume: (secret: string, reference: CredentialReference) => Promise<T> | T,
  ): Promise<T> {
    const reference = this.requireReference(ref);
    if (this.revoked.has(ref) || reference.revokedAt) {
      throw new CredentialError(`Credential is revoked: ${ref}`, "credential_not_found");
    }
    const backend = this.requireBackend(reference.backend);
    const secret = await backend.get(reference);
    if (secret === null || secret.length === 0) {
      throw new CredentialError(`Credential is unavailable: ${ref}`, "credential_not_found");
    }
    this.redactor.addSecret(secret);
    return consume(secret, { ...reference, scopes: [...reference.scopes] });
  }

  async test(ref: string, tester: CredentialTester): Promise<CredentialTestResult> {
    let result: CredentialTestResult;
    try {
      result = await this.withSecret(ref, tester);
    } catch (error) {
      throw new CredentialError(
        this.redactor.redactText(error instanceof Error ? error.message : String(error)),
        "backend_failure",
      );
    }
    const testedAt = new Date().toISOString();

    const current = this.requireReference(ref);
    this.references.set(ref, {
      ...current,
      testedAt,
      testStatus: result.ok ? "passed" : "failed",
      accountId: result.ok ? (result.accountId ?? current.accountId) : current.accountId,
      scopes: result.ok && result.scopes ? [...result.scopes] : current.scopes,
      expiresAt: result.ok ? (result.expiresAt ?? current.expiresAt) : current.expiresAt,
    });

    return this.redactor.redact(result);
  }

  async revoke(ref: string): Promise<CredentialRevocationResult> {
    const reference = this.requireReference(ref);
    const backend = this.requireBackend(reference.backend);
    let removed = false;
    let localRemovalError: string | undefined;
    try {
      removed = await backend.delete(reference);
    } catch (error) {
      localRemovalError = this.redactor.redactText(
        error instanceof Error ? error.message : String(error),
      );
    }
    const revokedAt = new Date().toISOString();
    this.references.set(ref, { ...reference, revokedAt });
    this.revoked.add(ref);
    return {
      ref,
      removed,
      localAccessDisabled: true,
      revokedAt,
      ...(localRemovalError ? { localRemovalError } : {}),
    };
  }

  private requireBackend(id: string): CredentialBackend {
    const backend = this.backends.get(id);
    if (!backend) {
      throw new CredentialError(`Credential backend is not registered: ${id}`, "backend_not_found");
    }
    return backend;
  }

  private requireReference(ref: string): CredentialReference {
    assertCredentialRef(ref);
    const reference = this.references.get(ref);
    if (!reference) {
      throw new CredentialError(
        `Credential reference is not registered: ${ref}`,
        "credential_not_found",
      );
    }
    return reference;
  }
}
