import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdempotencyLedger, ProviderTransportResult } from "../providers";

interface DurableEntry {
  status: ProviderTransportResult["status"];
  statusCode?: number;
  providerCode?: string;
  retryable: boolean;
  verified: boolean;
  recordedAt: string;
}

interface DurableLedgerDocument {
  version: 1;
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
]);

function safeProviderCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return SAFE_PROVIDER_CODES.has(code) || /^exit_\d{1,3}$/.test(code) ? code : undefined;
}

function emptyDocument(): DurableLedgerDocument {
  return { version: 1, entries: {} };
}

function safeEntry(value: unknown): DurableEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DurableEntry>;
  if (!["succeeded", "failed", "waiting_manual", "skipped"].includes(candidate.status ?? "")) {
    return null;
  }
  return {
    status: candidate.status!,
    statusCode:
      typeof candidate.statusCode === "number" && Number.isInteger(candidate.statusCode)
        ? candidate.statusCode
        : undefined,
    providerCode: safeProviderCode(candidate.providerCode),
    retryable: candidate.retryable === true,
    verified: candidate.verified === true,
    recordedAt:
      typeof candidate.recordedAt === "string" && !Number.isNaN(Date.parse(candidate.recordedAt))
        ? new Date(candidate.recordedAt).toISOString()
        : new Date(0).toISOString(),
  };
}

/**
 * Persists only a hashed idempotency key and an allowlisted status summary.
 * Provider messages, output, request data, credential refs, and secret values
 * cannot enter the durable representation.
 */
export class FileProviderIdempotencyLedger implements IdempotencyLedger {
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(
    private readonly path: string,
    options: FileProviderIdempotencyLedgerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async get(key: string): Promise<ProviderTransportResult | null> {
    await this.queue;
    const document = await this.read();
    const entry = document.entries[digest(key)];
    if (!entry) return null;
    return {
      status: entry.status,
      statusCode: entry.statusCode,
      providerCode: entry.providerCode,
      message:
        entry.status === "succeeded"
          ? "A prior provider apply is recorded; current read-back verification is required"
          : `A prior provider attempt is recorded as ${entry.status}`,
      retryable: entry.retryable,
      verified: entry.verified,
    };
  }

  async put(key: string, result: ProviderTransportResult): Promise<void> {
    const update = async () => {
      const document = await this.read();
      document.entries[digest(key)] = {
        status: result.status,
        statusCode:
          typeof result.statusCode === "number" && Number.isInteger(result.statusCode)
            ? result.statusCode
            : undefined,
        providerCode: safeProviderCode(result.providerCode),
        retryable: result.retryable === true,
        verified: result.verified === true,
        recordedAt: this.now().toISOString(),
      };
      await this.write(document);
    };
    const pending = this.queue.then(update, update);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async read(): Promise<DurableLedgerDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") return emptyDocument();
      const candidate = parsed as Partial<DurableLedgerDocument>;
      if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
        throw new Error(`Unsupported provider idempotency ledger: ${this.path}`);
      }
      const entries: Record<string, DurableEntry> = {};
      for (const [key, value] of Object.entries(candidate.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue;
        const entry = safeEntry(value);
        if (entry) entries[key] = entry;
      }
      return { version: 1, entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw error;
    }
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
  }
}
