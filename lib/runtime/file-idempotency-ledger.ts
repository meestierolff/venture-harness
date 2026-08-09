import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { looksLikeCredentialValue } from "../config/contracts";
import type {
  IdempotencyClaim,
  IdempotencyLedger,
  IdempotencyReplaySelection,
  ProviderTransportResult,
} from "../providers";

type ReplayScalar = string | number | boolean;

interface DurableEntry {
  state: "succeeded" | "definitive_no_write" | "pending_reconciliation";
  requestHash?: string;
  status: ProviderTransportResult["status"];
  statusCode?: number;
  providerCode?: string;
  retryable: boolean;
  verified: boolean;
  replayValues?: Record<string, ReplayScalar>;
  recordedAt: string;
}

interface DurableLedgerDocument {
  version: 4;
  ledgerId: string;
  entries: Record<string, DurableEntry>;
}

export interface FileProviderIdempotencyLedgerOptions {
  now?: () => Date;
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const SAFE_PROVIDER_CODES = new Set([
  "retryable_rate_limit",
  "retryable_outage",
  "retryable_network",
  "terminal_auth",
  "terminal_validation",
  "terminal_conflict",
  "terminal_unknown",
  "transport_exception",
  "shell_binary_forbidden",
  "jwt_signer_missing",
  "jwt_signing_failed",
  "idempotency_conflict",
  "unknown_outcome_reconciliation_required",
]);

function safeProviderCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return SAFE_PROVIDER_CODES.has(code) || /^exit_\d{1,3}$/.test(code) ? code : undefined;
}

const LEDGER_ID = /^ledger_[a-f0-9]{64}$/u;

function newLedgerId(): string {
  return `ledger_${randomBytes(32).toString("hex")}`;
}

function emptyDocument(ledgerId: string): DurableLedgerDocument {
  return { version: 4, ledgerId, entries: {} };
}

const REPLAY_PATH = /^(?:[A-Za-z][A-Za-z0-9_-]*|\d+)(?:\.(?:[A-Za-z][A-Za-z0-9_-]*|\d+))*$/u;
const SENSITIVE_REPLAY_PATH =
  /(?:^|\.)(?:access[_-]?token|api[_-]?key|connection[_-]?(?:string|uri)|credential|password|private[_-]?key|refresh[_-]?token|secret|token)(?:$|\.)/iu;
const PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,499}$/u;

function safeReplayPath(path: string): boolean {
  return path.length <= 200 && REPLAY_PATH.test(path) && !SENSITIVE_REPLAY_PATH.test(path);
}

function safeReplayScalar(value: unknown): ReplayScalar | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || value !== value.trim()) return undefined;
  if (
    value.length === 0 ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("cred://") ||
    value.includes("[REDACTED]") ||
    looksLikeCredentialValue(value) ||
    /\b(?:Bearer|Basic)\s+/iu.test(value)
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return value;
  } catch {
    return PUBLIC_IDENTIFIER.test(value) ? value : undefined;
  }
}

function valueAtPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (Array.isArray(value)) {
      if (/^\d+$/u.test(part)) return value[Number(part)];
      if (value.length !== 1) return undefined;
      value = value[0];
    }
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function selectedReplayValues(
  output: unknown,
  selection: IdempotencyReplaySelection | undefined,
): Record<string, ReplayScalar> | undefined {
  if (!selection || !output || typeof output !== "object") return undefined;
  const selected: Record<string, ReplayScalar> = {};
  for (const path of [...new Set(selection.outputPaths)].sort().slice(0, 32)) {
    if (!safeReplayPath(path)) continue;
    const value = safeReplayScalar(valueAtPath(output, path));
    if (value !== undefined) selected[path] = value;
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function normalizedReplayValues(value: unknown): Record<string, ReplayScalar> | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32) return undefined;
  const normalized: Record<string, ReplayScalar> = {};
  for (const [path, candidate] of entries) {
    const scalar = safeReplayScalar(candidate);
    if (!safeReplayPath(path) || scalar === undefined) return undefined;
    normalized[path] = scalar;
  }
  return normalized;
}

function replayOutput(values: Readonly<Record<string, ReplayScalar>> | undefined): unknown {
  if (!values) return undefined;
  const output: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const parts = path.split(".");
    let cursor = output;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = value;
  }
  return output;
}

function parsedEntry(value: unknown, legacy = false): DurableEntry {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Provider idempotency ledger contains a non-object entry");
  }
  const candidate = value as Partial<DurableEntry>;
  const allowed = new Set([
    "providerCode",
    "recordedAt",
    "replayValues",
    "requestHash",
    "retryable",
    "state",
    "status",
    "statusCode",
    "verified",
  ]);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new Error("Provider idempotency ledger entry contains an unknown field");
  }
  const states: DurableEntry["state"][] = [
    "succeeded",
    "definitive_no_write",
    "pending_reconciliation",
  ];
  if (!legacy && !states.includes(candidate.state as DurableEntry["state"])) {
    throw new Error("Provider idempotency ledger entry has an invalid durable state");
  }
  if (!["succeeded", "failed", "waiting_manual", "skipped"].includes(candidate.status ?? "")) {
    throw new Error("Provider idempotency ledger entry has an invalid status");
  }
  if (candidate.statusCode !== undefined && !Number.isInteger(candidate.statusCode)) {
    throw new Error("Provider idempotency ledger entry has an invalid status code");
  }
  if (candidate.providerCode !== undefined && !safeProviderCode(candidate.providerCode)) {
    throw new Error("Provider idempotency ledger entry has an invalid provider code");
  }
  if (typeof candidate.retryable !== "boolean" || typeof candidate.verified !== "boolean") {
    throw new Error("Provider idempotency ledger entry has invalid boolean state");
  }
  if (typeof candidate.recordedAt !== "string" || Number.isNaN(Date.parse(candidate.recordedAt))) {
    throw new Error("Provider idempotency ledger entry has an invalid timestamp");
  }
  const replayValues = normalizedReplayValues(candidate.replayValues);
  if (candidate.replayValues !== undefined && replayValues === undefined) {
    throw new Error("Provider idempotency ledger entry has invalid replay values");
  }
  if (
    candidate.requestHash !== undefined &&
    (typeof candidate.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.requestHash))
  ) {
    throw new Error("Provider idempotency ledger entry has an invalid request hash");
  }
  if (
    !legacy &&
    ((candidate.state === "succeeded" && candidate.status !== "succeeded") ||
      (candidate.state !== "succeeded" && candidate.status === "succeeded"))
  ) {
    throw new Error("Provider idempotency ledger entry has inconsistent durable state");
  }
  return {
    state: !legacy
      ? candidate.state!
      : candidate.status === "succeeded"
        ? "succeeded"
        : "pending_reconciliation",
    requestHash: typeof candidate.requestHash === "string" ? candidate.requestHash : undefined,
    status: candidate.status!,
    statusCode:
      typeof candidate.statusCode === "number" && Number.isInteger(candidate.statusCode)
        ? candidate.statusCode
        : undefined,
    providerCode: safeProviderCode(candidate.providerCode),
    retryable: candidate.retryable === true,
    verified: candidate.verified === true,
    replayValues: legacy ? undefined : replayValues,
    recordedAt: new Date(candidate.recordedAt).toISOString(),
  };
}

/**
 * Persists a hashed idempotency key, an allowlisted status summary, and only
 * the scalar public-result paths explicitly required for dependency replay or
 * read-back. Provider messages, arbitrary output, request data, credential
 * refs, and secret-shaped values cannot enter the durable representation.
 */
export class FileProviderIdempotencyLedger implements IdempotencyLedger {
  readonly durability = "durable_atomic" as const;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private knownLedgerId: string | undefined;

  constructor(
    private readonly path: string,
    options: FileProviderIdempotencyLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async identity(): Promise<string> {
    if (this.knownLedgerId) return this.knownLedgerId;
    return this.enqueue(() =>
      this.withLock(async () => {
        const document = await this.readOrInitialize();
        this.knownLedgerId = document.ledgerId;
        return document.ledgerId;
      }),
    );
  }

  async get(key: string): Promise<ProviderTransportResult | null> {
    await this.identity();
    await this.queue;
    const document = await this.read();
    const entry = document.entries[digest(key)];
    if (!entry) return null;
    return this.result(entry);
  }

  async put(key: string, result: ProviderTransportResult): Promise<void> {
    await this.identity();
    const update = async () => {
      await this.withLock(async () => {
        const document = await this.read();
        const existing = document.entries[digest(key)];
        if (!existing?.requestHash) {
          throw new Error("Provider idempotency promotion does not match a claimed request");
        }
        document.entries[digest(key)] = this.entry(
          result.status === "succeeded" ? "succeeded" : "pending_reconciliation",
          result,
          existing?.requestHash,
          undefined,
          existing?.replayValues,
        );
        await this.write(document);
      });
    };
    const pending = this.queue.then(update, update);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async claim(key: string, requestHash: string): Promise<IdempotencyClaim> {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) {
      throw new Error("Provider idempotency request hash must be SHA-256 hex");
    }
    await this.identity();
    return this.enqueue(() =>
      this.withLock(async () => {
        const document = await this.read();
        const hashedKey = digest(key);
        const existing = document.entries[hashedKey];
        if (!existing) {
          document.entries[hashedKey] = this.entry(
            "pending_reconciliation",
            unknownAttempt("Provider operation was claimed before execution"),
            requestHash,
          );
          await this.write(document);
          return { status: "acquired" } as const;
        }
        if (!existing.requestHash || existing.requestHash !== requestHash) {
          return { status: "conflict" } as const;
        }
        if (existing.state === "succeeded") {
          return { status: "replay", result: this.result(existing) } as const;
        }
        if (existing.state === "pending_reconciliation") {
          return {
            status: "pending_reconciliation",
            result: this.result(existing),
          } as const;
        }
        document.entries[hashedKey] = this.entry(
          "pending_reconciliation",
          unknownAttempt("Provider operation was claimed before retry"),
          requestHash,
        );
        await this.write(document);
        return { status: "acquired" } as const;
      }),
    );
  }

  async settle(
    key: string,
    requestHash: string,
    state: "succeeded" | "definitive_no_write" | "pending_reconciliation",
    result: ProviderTransportResult,
    replay?: IdempotencyReplaySelection,
  ): Promise<void> {
    await this.identity();
    await this.enqueue(() =>
      this.withLock(async () => {
        const document = await this.read();
        const hashedKey = digest(key);
        const existing = document.entries[hashedKey];
        if (!existing || existing.requestHash !== requestHash) {
          throw new Error("Provider idempotency settlement does not match the claimed request");
        }
        document.entries[hashedKey] = this.entry(state, result, requestHash, replay);
        await this.write(document);
      }),
    );
  }

  private async read(): Promise<DurableLedgerDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Provider idempotency ledger is missing: ${this.path}`);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Provider idempotency ledger is corrupt JSON: ${this.path}`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`Provider idempotency ledger is not an object: ${this.path}`);
    }
    const candidate = parsed as {
      version?: number;
      ledgerId?: unknown;
      entries?: unknown;
    };
    if (
      candidate.version !== 4 ||
      typeof candidate.ledgerId !== "string" ||
      !LEDGER_ID.test(candidate.ledgerId) ||
      !candidate.entries ||
      Array.isArray(candidate.entries) ||
      typeof candidate.entries !== "object" ||
      Object.keys(candidate).sort().join(",") !== "entries,ledgerId,version"
    ) {
      throw new Error(`Unsupported or corrupt provider idempotency ledger: ${this.path}`);
    }
    if (this.knownLedgerId && candidate.ledgerId !== this.knownLedgerId) {
      throw new Error(`Provider idempotency ledger identity changed: ${this.path}`);
    }
    const entries: Record<string, DurableEntry> = {};
    for (const [key, value] of Object.entries(candidate.entries)) {
      if (!/^[a-f0-9]{64}$/u.test(key)) {
        throw new Error(`Provider idempotency ledger contains an invalid entry key: ${this.path}`);
      }
      entries[key] = parsedEntry(value);
    }
    return { version: 4, ledgerId: candidate.ledgerId, entries };
  }

  private async readOrInitialize(): Promise<DurableLedgerDocument> {
    try {
      return await this.read();
    } catch (error) {
      if (
        !String(error instanceof Error ? error.message : error).startsWith(
          "Provider idempotency ledger is missing:",
        )
      ) {
        return this.migrateLegacy();
      }
      const document = emptyDocument(newLedgerId());
      await this.write(document);
      return document;
    }
  }

  private async migrateLegacy(): Promise<DurableLedgerDocument> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch {
      throw new Error(`Provider idempotency ledger is corrupt JSON: ${this.path}`);
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`Provider idempotency ledger is not an object: ${this.path}`);
    }
    const candidate = parsed as { version?: unknown; entries?: unknown };
    if (
      ![1, 2, 3].includes(Number(candidate.version)) ||
      !candidate.entries ||
      Array.isArray(candidate.entries) ||
      typeof candidate.entries !== "object" ||
      Object.keys(candidate).sort().join(",") !== "entries,version"
    ) {
      throw new Error(`Unsupported or corrupt provider idempotency ledger: ${this.path}`);
    }
    const entries: Record<string, DurableEntry> = {};
    for (const [key, value] of Object.entries(candidate.entries)) {
      if (!/^[a-f0-9]{64}$/u.test(key)) {
        throw new Error(`Provider idempotency ledger contains an invalid entry key: ${this.path}`);
      }
      entries[key] = parsedEntry(value, candidate.version !== 3);
    }
    const document: DurableLedgerDocument = { version: 4, ledgerId: newLedgerId(), entries };
    await this.write(document);
    return document;
  }

  private async write(document: DurableLedgerDocument): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  private entry(
    state: DurableEntry["state"],
    result: ProviderTransportResult,
    requestHash?: string,
    replay?: IdempotencyReplaySelection,
    preservedReplayValues?: Record<string, ReplayScalar>,
  ): DurableEntry {
    const replayValues =
      state === "succeeded" && result.status === "succeeded"
        ? (selectedReplayValues(result.output, replay) ?? preservedReplayValues)
        : undefined;
    return {
      state,
      requestHash,
      status: result.status,
      statusCode:
        typeof result.statusCode === "number" && Number.isInteger(result.statusCode)
          ? result.statusCode
          : undefined,
      providerCode: safeProviderCode(result.providerCode),
      retryable: result.retryable === true,
      verified: result.verified === true,
      replayValues,
      recordedAt: this.now().toISOString(),
    };
  }

  private result(entry: DurableEntry): ProviderTransportResult {
    const output = replayOutput(entry.replayValues);
    return {
      status: entry.status,
      statusCode: entry.statusCode,
      providerCode: entry.providerCode,
      message:
        entry.state === "succeeded"
          ? "A request-bound provider apply is recorded; read-back verification is required"
          : entry.state === "definitive_no_write"
            ? "Provider evidence confirms the prior attempt did not write"
            : "The prior provider attempt has an unknown outcome and requires reconciliation",
      retryable: entry.retryable,
      verified: entry.verified,
      ...(output === undefined ? {} : { output }),
      effectOutcome:
        entry.state === "succeeded"
          ? "confirmed_write"
          : entry.state === "definitive_no_write"
            ? "confirmed_no_write"
            : "unknown",
    };
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let handle;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!handle) {
      throw new Error(`Provider idempotency ledger is locked: ${this.path}`);
    }
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
      return await work();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

function unknownAttempt(message: string): ProviderTransportResult {
  return {
    status: "failed",
    providerCode: "unknown_outcome_reconciliation_required",
    message,
    retryable: false,
    effectOutcome: "unknown",
  };
}
