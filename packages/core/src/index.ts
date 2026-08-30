export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CredentialMaterialFindingKind =
  | "registered_canary"
  | "credential_pattern"
  | "secret_bearing_field"
  | "invalid_credential_reference"
  | "non_json_value";

export interface CredentialMaterialFinding {
  readonly kind: CredentialMaterialFindingKind;
  readonly path: string;
}

export interface CredentialMaterialScanOptions {
  readonly canaries?: Iterable<string>;
  /** Exact field names whose value must be a canonical cred:// reference. */
  readonly allowedCredentialReferenceKeys?: readonly string[];
}

const CREDENTIAL_VALUE_PATTERNS = [
  /\bwhsec_[a-z0-9_-]{8,}/iu,
  /\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,}/iu,
  /\bsk-[a-z0-9_-]{16,}/iu,
  /\bxkeysib-[a-z0-9_-]{12,}/iu,
  /\bAIza[a-z0-9_-]{30,}/iu,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/iu,
  /\bxox[baprs]-[a-z0-9-]{10,}/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/iu,
  /[?&](?:access_token|api_key|token|secret)=[^&\s]{6,}/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /\b(?:(?:vh|credential)[_-])canary[_-][a-z0-9_-]{6,}/iu,
] as const;

function credentialFieldWords(field: string): readonly string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function secretBearingField(field: string): boolean {
  const words = credentialFieldWords(field);
  if (
    ["secret", "password", "token", "credential", "authorization"].some((word) =>
      words.includes(word),
    )
  ) {
    return true;
  }
  const joined = words.join("");
  return ["apikey", "privatekey", "signingkey"].some((marker) => joined.includes(marker));
}

/**
 * Return only a sanitized path/category for the first credential or non-JSON
 * value. The candidate value itself is never copied into the finding.
 */
export function findCredentialMaterial(
  value: unknown,
  options: CredentialMaterialScanOptions = {},
): CredentialMaterialFinding | null {
  const canaries = [...(options.canaries ?? [])].filter(Boolean);
  const referenceKeys = new Set(options.allowedCredentialReferenceKeys ?? []);
  const visited = new WeakSet<object>();
  const inspect = (candidate: unknown, path: string): CredentialMaterialFinding | null => {
    if (typeof candidate === "string") {
      if (canaries.some((canary) => candidate.includes(canary))) {
        return { kind: "registered_canary", path };
      }
      if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(candidate))) {
        return { kind: "credential_pattern", path };
      }
      return null;
    }
    if (candidate === null || typeof candidate === "boolean") return null;
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? null : { kind: "non_json_value", path };
    }
    if (typeof candidate !== "object") return { kind: "non_json_value", path };
    if (visited.has(candidate)) return { kind: "non_json_value", path };
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const [index, entry] of candidate.entries()) {
        const finding = inspect(entry, `${path}[${index}]`);
        if (finding) return finding;
      }
      return null;
    }
    const prototype = Object.getPrototypeOf(candidate) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: "non_json_value", path };
    }
    for (const [field, entry] of Object.entries(candidate as Record<string, unknown>)) {
      const childPath = `${path}.${field}`;
      if (referenceKeys.has(field)) {
        if (typeof entry !== "string" || !/^cred:\/\/[A-Za-z0-9][A-Za-z0-9/_:.-]*$/u.test(entry)) {
          return { kind: "invalid_credential_reference", path: childPath };
        }
      } else if (secretBearingField(field)) {
        return { kind: "secret_bearing_field", path: childPath };
      }
      const finding = inspect(entry, childPath);
      if (finding) return finding;
    }
    return null;
  };
  return inspect(value, "$");
}

export interface ActorIdentity {
  actorId: string;
  kind: "user" | "service" | "agent";
}

export interface TenantRef {
  organizationId: string;
  ventureId: string;
}

export interface SubscriptionSnapshot {
  subscriptionId: string;
  status: "active" | "trialing" | "past_due" | "cancelled" | "none";
  plan: string;
}

export interface GrantSnapshot {
  grantId: string;
  commandIds: readonly string[];
  scopes: readonly string[];
  expiresAt: string;
  revokedAt?: string;
}

export interface CommandExecutionContext {
  identity: ActorIdentity;
  tenant: TenantRef;
  subscription: SubscriptionSnapshot;
  entitlements: readonly string[];
  grants: readonly GrantSnapshot[];
  scopes: readonly string[];
}

export function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

export function tenantKey(tenant: TenantRef): string {
  const organizationId = assertNonEmpty(tenant.organizationId, "organizationId");
  const ventureId = assertNonEmpty(tenant.ventureId, "ventureId");
  if (organizationId !== tenant.organizationId) {
    throw new Error("organizationId must not contain leading or trailing whitespace");
  }
  if (ventureId !== tenant.ventureId) {
    throw new Error("ventureId must not contain leading or trailing whitespace");
  }
  const tenantIdPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
  if (!tenantIdPattern.test(organizationId)) {
    throw new Error("organizationId must be a canonical tenant identifier");
  }
  if (!tenantIdPattern.test(ventureId)) {
    throw new Error("ventureId must be a canonical tenant identifier");
  }
  return `${organizationId}:${ventureId}`;
}

export function canonicalCommandId(value: string): string {
  const commandId = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(commandId)) {
    throw new Error(`Invalid command id: ${value}`);
  }
  return commandId;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

/** Throw a sanitized error when the shared scanner finds credential material. */
export function assertCredentialFree(
  value: unknown,
  path = "value",
  canaries: readonly string[] = [],
): void {
  const finding = findCredentialMaterial(value, { canaries });
  if (finding)
    throw new Error(`credential-like material is forbidden at ${path}${finding.path.slice(1)}`);
}

interface SqliteJournalModeStatement {
  get(...values: unknown[]): unknown;
}

/** Minimal SQLite surface needed to configure a durable connection for WAL. */
export interface SqliteWalDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteJournalModeStatement;
}

export interface SqliteWalInitializationOptions {
  readonly label?: string;
  /** SQLite's own wait bound for each busy operation. */
  readonly busyTimeoutMs?: number;
  /** Overall retry bound for a concurrent journal-mode transition. */
  readonly retryTimeoutMs?: number;
}

function sqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: string; errcode?: number };
  return (
    candidate.code === "ERR_SQLITE_BUSY" ||
    candidate.code === "ERR_SQLITE_LOCKED" ||
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    /(?:database is (?:busy|locked)|SQLITE_BUSY|SQLITE_LOCKED)/iu.test(candidate.message)
  );
}

function sqliteJournalMode(database: SqliteWalDatabase, label: string): string {
  const row = database.prepare("PRAGMA journal_mode").get();
  const mode =
    row && typeof row === "object" && "journal_mode" in row
      ? (row as { journal_mode?: unknown }).journal_mode
      : undefined;
  if (typeof mode !== "string" || !mode.trim()) {
    throw new Error(`${label} journal_mode read-back returned no mode`);
  }
  return mode.toLowerCase();
}

function positiveSqliteTimeout(value: number | undefined, fallback: number, field: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return timeout;
}

/**
 * Configure WAL without racing another process opening the same database.
 * A busy journal switch is accepted only after an explicit `wal` read-back.
 */
export function initializeSqliteWal(
  database: SqliteWalDatabase,
  options: SqliteWalInitializationOptions = {},
): void {
  const label = options.label?.trim() || "SQLite database";
  const busyTimeoutMs = positiveSqliteTimeout(options.busyTimeoutMs, 5_000, "SQLite busyTimeoutMs");
  const retryTimeoutMs = positiveSqliteTimeout(
    options.retryTimeoutMs,
    5_000,
    "SQLite retryTimeoutMs",
  );
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const retrySignal = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + retryTimeoutMs;
  let delayMs = 5;

  for (;;) {
    try {
      if (sqliteJournalMode(database, label) === "wal") return;
      database.exec("PRAGMA journal_mode = WAL");
      const observed = sqliteJournalMode(database, label);
      if (observed === "wal") return;
      throw new Error(`${label} journal_mode read back as ${observed}, expected wal`);
    } catch (error) {
      if (!sqliteBusy(error)) throw error;

      try {
        if (sqliteJournalMode(database, label) === "wal") return;
      } catch (readBackError) {
        if (!sqliteBusy(readBackError)) throw readBackError;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `${label} WAL initialization remained busy and journal_mode did not read back as wal`,
          { cause: error },
        );
      }
      Atomics.wait(retrySignal, 0, 0, Math.min(delayMs, remainingMs));
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}
