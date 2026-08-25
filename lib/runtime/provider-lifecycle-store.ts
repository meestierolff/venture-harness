import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { looksLikeCredentialValue } from "../config/contracts";
import { providerIds, type ProviderEnvironment, type ProviderId } from "../providers";

export const providerResourceTypes = [
  "account_id",
  "amount_minor",
  "app_id",
  "app_version",
  "apple_build_id",
  "branch",
  "branch_id",
  "build_id",
  "build_number",
  "bundle_id",
  "commit_oid",
  "currency",
  "database_id",
  "database_name",
  "deployment_id",
  "domain",
  "entitlement_id",
  "livemode",
  "lookup_key",
  "measurement_id",
  "offering_id",
  "price_id",
  "product_id",
  "project",
  "project_id",
  "project_name",
  "property_id",
  "repository",
  "repository_id",
  "region",
  "site_url",
  "stream_id",
  "submission_id",
  "team_id",
  "testflight_group_id",
  "tree_oid",
  "url",
  "visibility",
  "webhook_id",
] as const;

export type ProviderResourceType = (typeof providerResourceTypes)[number];

export interface ProviderResourceReference {
  type: ProviderResourceType;
  value: string;
}

export interface ProviderLifecycleScope {
  provider: ProviderId;
  environment: ProviderEnvironment;
  capability: string;
}

export interface VerifiedProviderLifecycleRecord extends ProviderLifecycleScope {
  state: "verified";
  planId: string;
  verifiedAt: string;
  resourceRefs: ProviderResourceReference[];
}

export interface ProviderLifecycleStore {
  list(): Promise<VerifiedProviderLifecycleRecord[]>;
  get(scope: ProviderLifecycleScope): Promise<VerifiedProviderLifecycleRecord | null>;
  recordVerified(records: readonly VerifiedProviderLifecycleRecord[]): Promise<void>;
}

export class ProviderLifecycleStoreError extends Error {
  readonly code = "provider_lifecycle_store_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ProviderLifecycleStoreError";
  }
}

const environments = ["local", "preview", "sandbox", "production", "testflight"] as const;
const capabilitySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,199}$/);

function safeResourceValue(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("cred://") ||
    value.includes("[REDACTED]") ||
    looksLikeCredentialValue(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return true;
  }
}

const resourceReferenceSchema = z
  .object({
    type: z.enum(providerResourceTypes),
    value: z.string(),
  })
  .strict()
  .refine(({ value }) => safeResourceValue(value), {
    message: "resource value is not a safe provider identifier",
  });

const lifecycleRecordSchema = z
  .object({
    provider: z.enum(providerIds),
    environment: z.enum(environments),
    capability: capabilitySchema,
    state: z.literal("verified"),
    planId: z
      .string()
      .regex(/^plan\.[a-z][a-z0-9_-]*\.[a-z0-9]+$/)
      .max(200),
    verifiedAt: z.string().datetime({ offset: true }),
    resourceRefs: z.array(resourceReferenceSchema).max(100),
  })
  .strict();

const lifecycleDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.array(lifecycleRecordSchema).max(10_000),
  })
  .strict();

function scopeKey(scope: ProviderLifecycleScope): string {
  return `${scope.provider}\u0000${scope.environment}\u0000${scope.capability}`;
}

function compareRecords(
  left: VerifiedProviderLifecycleRecord,
  right: VerifiedProviderLifecycleRecord,
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.environment.localeCompare(right.environment) ||
    left.capability.localeCompare(right.capability)
  );
}

function normalizedRecord(input: unknown): VerifiedProviderLifecycleRecord {
  const parsed = lifecycleRecordSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderLifecycleStoreError(
      `Provider lifecycle record is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const refs = [...parsed.data.resourceRefs]
    .sort(
      (left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
    )
    .filter(
      (reference, index, values) =>
        index === 0 ||
        reference.type !== values[index - 1]!.type ||
        reference.value !== values[index - 1]!.value,
    );
  return { ...parsed.data, resourceRefs: refs };
}

/** Parse the durable document for read-only consumers such as quality and data sync. */
export function parseProviderLifecycleDocument(input: unknown): VerifiedProviderLifecycleRecord[] {
  const parsed = lifecycleDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderLifecycleStoreError(
      `Provider lifecycle state is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const records = parsed.data.records.map(normalizedRecord);
  if (new Set(records.map(scopeKey)).size !== records.length) {
    throw new ProviderLifecycleStoreError(
      "Provider lifecycle state contains duplicate provider/environment/capability scopes",
    );
  }
  return records.sort(compareRecords);
}

function cloneRecord(record: VerifiedProviderLifecycleRecord): VerifiedProviderLifecycleRecord {
  return {
    ...record,
    resourceRefs: record.resourceRefs.map((reference) => ({ ...reference })),
  };
}

/**
 * Durable verified provider state. The file contains only scoped lifecycle
 * status and allowlisted resource identifiers; provider bodies, messages,
 * credentials, request payloads, and idempotency keys are never represented.
 */
export class FileProviderLifecycleStore implements ProviderLifecycleStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async list(): Promise<VerifiedProviderLifecycleRecord[]> {
    await this.queue;
    return (await this.read()).map(cloneRecord);
  }

  async get(scope: ProviderLifecycleScope): Promise<VerifiedProviderLifecycleRecord | null> {
    await this.queue;
    const record = (await this.read()).find((candidate) => scopeKey(candidate) === scopeKey(scope));
    return record ? cloneRecord(record) : null;
  }

  async recordVerified(records: readonly VerifiedProviderLifecycleRecord[]): Promise<void> {
    if (records.length === 0) {
      throw new ProviderLifecycleStoreError("At least one verified lifecycle record is required");
    }
    const normalized = records.map(normalizedRecord);
    if (new Set(normalized.map(scopeKey)).size !== normalized.length) {
      throw new ProviderLifecycleStoreError(
        "A verified lifecycle update contains duplicate provider/environment/capability scopes",
      );
    }
    const update = async () => {
      const current = new Map((await this.read()).map((record) => [scopeKey(record), record]));
      for (const record of normalized) current.set(scopeKey(record), record);
      await this.write([...current.values()].sort(compareRecords));
    };
    const pending = this.queue.then(update, update);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async read(): Promise<VerifiedProviderLifecycleRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ProviderLifecycleStoreError(`Provider lifecycle state could not be read`);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new ProviderLifecycleStoreError(
        "Provider lifecycle state is corrupt JSON; restore it from verified evidence before resuming",
      );
    }
    return parseProviderLifecycleDocument(value);
  }

  private async write(records: VerifiedProviderLifecycleRecord[]): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}
