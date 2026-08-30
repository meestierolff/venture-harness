/**
 * Layer 3 persistence — the source of truth for commercial evidence.
 * Production: the venture's own Neon database (DATABASE_URL).
 * Development: JSONL fallback under .data/ (gitignored) when
 * EVIDENCE_LOCAL_FALLBACK=true. Production never silently no-ops: with no
 * store configured, persist() throws and the API returns 503 so evidence
 * loss is loud, not silent. Schema: docs/engineering/BACKEND.md.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface EvidenceRecord {
  event: string;
  visitor_id: string;
  props: Record<string, string | number | boolean>;
  occurred_at?: string;
}

export interface SubmissionRecord {
  form_id: string;
  payload: Record<string, string>;
  qualified: boolean;
  qualification_tier: string;
}

function tableFor(event: string): "experiment_events" | "consent_events" | "commercial_events" {
  if (event.startsWith("experiment_")) return "experiment_events";
  if (
    event.startsWith("consent_") ||
    event === "analytics_accepted" ||
    event === "analytics_declined"
  )
    return "consent_events";
  return "commercial_events";
}

async function neonSql(): Promise<
  ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) | null
> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { neon } = await import("@neondatabase/serverless");
  return neon(url) as unknown as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
}

function localFallbackAllowed(): boolean {
  return process.env.EVIDENCE_LOCAL_FALLBACK === "true" && process.env.NODE_ENV !== "production";
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function ensurePrivateLocalDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  let metadata = lstatSync(dir);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !ownedByCurrentUser(metadata.uid) ||
    realpathSync(dir) !== dir
  ) {
    throw new Error("local evidence directory is not a private owned directory");
  }

  chmodSync(dir, PRIVATE_DIRECTORY_MODE);
  metadata = lstatSync(dir);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !ownedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    realpathSync(dir) !== dir
  ) {
    throw new Error("local evidence directory permissions could not be secured");
  }
}

function appendLocal(file: string, record: unknown): void {
  const dir = resolve(realpathSync(resolve(process.cwd())), ".data");
  ensurePrivateLocalDirectory(dir);
  const target = resolve(dir, file);
  if (dirname(target) !== dir) {
    throw new Error("local evidence filename escaped its private directory");
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    let metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1 || !ownedByCurrentUser(metadata.uid)) {
      throw new Error("local evidence target must be one owned regular file with one link");
    }
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      !ownedByCurrentUser(metadata.uid) ||
      (metadata.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new Error("local evidence file permissions could not be secured");
    }
    appendFileSync(
      descriptor,
      JSON.stringify({ occurred_at: new Date().toISOString(), ...(record as object) }) + "\n",
      "utf8",
    );
    fsyncSync(descriptor);
    metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error("local evidence target changed during append");
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export async function persistEvidence(record: EvidenceRecord): Promise<void> {
  const sql = await neonSql();
  if (sql) {
    const table = tableFor(record.event);
    const p = record.props;
    if (table === "experiment_events") {
      await sql`insert into experiment_events (event, experiment_id, variant_key, visitor_id, route, displayed_offer, displayed_price, metric)
        values (${record.event}, ${p.experiment_id ?? null}, ${p.variant_key ?? null}, ${record.visitor_id}, ${p.route ?? null}, ${p.displayed_offer ?? null}, ${p.displayed_price ?? null}, ${p.metric ?? null})`;
    } else if (table === "consent_events") {
      await sql`insert into consent_events (event, visitor_id, from_state, to_state)
        values (${record.event}, ${record.visitor_id}, ${p.from_state ?? null}, ${p.to_state ?? null})`;
    } else {
      await sql`insert into commercial_events (event, visitor_id, plan_key, displayed_price, billing_period, experiment_id, variant_key, qualified, qualification_tier)
        values (${record.event}, ${record.visitor_id}, ${p.plan_key ?? null}, ${p.displayed_price ?? null}, ${p.billing_period ?? null}, ${p.experiment_id ?? null}, ${p.variant_key ?? null}, ${typeof p.qualified === "boolean" ? p.qualified : null}, ${p.qualification_tier ?? null})`;
    }
    return;
  }
  if (localFallbackAllowed()) {
    appendLocal("evidence.jsonl", record);
    return;
  }
  throw new Error(
    "no evidence store configured (set DATABASE_URL, or EVIDENCE_LOCAL_FALLBACK=true in development)",
  );
}

export async function persistSubmission(record: SubmissionRecord): Promise<void> {
  const sql = await neonSql();
  if (sql) {
    // Compatibility field for already-applied founder-alpha schemas. This
    // server-generated nonce is deliberately unrelated to the analytics ID.
    const submissionPrivateNonce = randomUUID();
    await sql`insert into submissions (form_id, visitor_id, payload, qualified, qualification_tier)
      values (${record.form_id}, ${submissionPrivateNonce}, ${JSON.stringify(record.payload)}, ${record.qualified}, ${record.qualification_tier})`;
    return;
  }
  if (localFallbackAllowed()) {
    appendLocal("submissions.jsonl", record);
    return;
  }
  throw new Error(
    "no evidence store configured (set DATABASE_URL, or EVIDENCE_LOCAL_FALLBACK=true in development)",
  );
}
