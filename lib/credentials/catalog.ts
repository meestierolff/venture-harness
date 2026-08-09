import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertCredentialRef, credentialKinds } from "./types";
import type { CredentialReference } from "./types";

export interface CredentialCatalog {
  schemaVersion: 1;
  references: CredentialReference[];
}

const FORBIDDEN_KEYS = /token|secret|password|private.?key|api.?key|credential.?value/i;

function parseReference(value: unknown): CredentialReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential catalog reference must be an object");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new Error(`credential catalog contains forbidden field ${key}`);
    }
  }
  if (typeof input.ref !== "string") throw new Error("credential catalog ref is required");
  assertCredentialRef(input.ref);
  if (typeof input.provider !== "string" || !input.provider) {
    throw new Error(`credential ${input.ref} requires provider metadata`);
  }
  if (typeof input.kind !== "string" || !credentialKinds.includes(input.kind as never)) {
    throw new Error(`credential ${input.ref} has unsupported kind`);
  }
  if (typeof input.backend !== "string" || !input.backend) {
    throw new Error(`credential ${input.ref} requires backend metadata`);
  }
  if (!Array.isArray(input.scopes) || input.scopes.some((scope) => typeof scope !== "string")) {
    throw new Error(`credential ${input.ref} scopes must be strings`);
  }
  for (const optional of ["label", "accountId", "expiresAt", "testedAt", "revokedAt"] as const) {
    if (input[optional] !== undefined && typeof input[optional] !== "string") {
      throw new Error(`credential ${input.ref} ${optional} must be a string`);
    }
  }
  if (
    input.testStatus !== undefined &&
    input.testStatus !== "passed" &&
    input.testStatus !== "failed"
  ) {
    throw new Error(`credential ${input.ref} testStatus must be passed or failed`);
  }
  if ((input.testedAt === undefined) !== (input.testStatus === undefined)) {
    throw new Error(`credential ${input.ref} requires testedAt and testStatus together`);
  }
  for (const timestamp of ["testedAt", "revokedAt"] as const) {
    if (
      typeof input[timestamp] === "string" &&
      Number.isNaN(Date.parse(input[timestamp] as string))
    ) {
      throw new Error(`credential ${input.ref} ${timestamp} must be an ISO timestamp`);
    }
  }
  return {
    ref: input.ref,
    provider: input.provider,
    kind: input.kind as CredentialReference["kind"],
    backend: input.backend,
    label: input.label as string | undefined,
    scopes: [...(input.scopes as string[])],
    accountId: input.accountId as string | undefined,
    expiresAt: input.expiresAt as string | undefined,
    testedAt: input.testedAt as string | undefined,
    testStatus: input.testStatus as CredentialReference["testStatus"],
    revokedAt: input.revokedAt as string | undefined,
  };
}

export function defaultCredentialCatalogPath(
  options: {
    homeDirectory?: string;
    xdgConfigHome?: string;
  } = {},
): string {
  const configRoot = options.xdgConfigHome
    ? resolve(options.xdgConfigHome)
    : join(resolve(options.homeDirectory ?? homedir()), ".config");
  return join(configRoot, "venture-harness", "credentials.json");
}

export function loadCredentialCatalog(path = defaultCredentialCatalogPath()): CredentialCatalog {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { schemaVersion: 1, references: [] };
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.references)) {
    throw new Error("unsupported credential catalog; expected schemaVersion 1 and references[]");
  }
  const references = value.references.map(parseReference);
  if (new Set(references.map((reference) => reference.ref)).size !== references.length) {
    throw new Error("credential catalog contains duplicate refs");
  }
  return { schemaVersion: 1, references };
}

export function saveCredentialCatalog(
  catalog: CredentialCatalog,
  path = defaultCredentialCatalogPath(),
): void {
  const references = catalog.references
    .map(parseReference)
    .sort((a, b) => a.ref.localeCompare(b.ref));
  if (new Set(references.map((reference) => reference.ref)).size !== references.length) {
    throw new Error("credential catalog contains duplicate refs");
  }
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.next-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, references }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, absolute);
}

export function upsertCredentialReference(
  catalog: CredentialCatalog,
  reference: CredentialReference,
): CredentialCatalog {
  const parsed = parseReference(reference);
  return {
    schemaVersion: 1,
    references: [...catalog.references.filter((candidate) => candidate.ref !== parsed.ref), parsed],
  };
}

export function removeCredentialReferences(
  catalog: CredentialCatalog,
  refs: string[],
): CredentialCatalog {
  const removed = new Set(refs);
  return {
    schemaVersion: 1,
    references: catalog.references.filter((reference) => !removed.has(reference.ref)),
  };
}
