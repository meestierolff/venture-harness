/**
 * Layer 3 persistence — the source of truth for commercial evidence.
 * Production: the venture's own Neon database (DATABASE_URL).
 * Development: JSONL fallback under .data/ (gitignored) when
 * EVIDENCE_LOCAL_FALLBACK=true. Production never silently no-ops: with no
 * store configured, persist() throws and the API returns 503 so evidence
 * loss is loud, not silent. Schema: docs/engineering/BACKEND.md.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface EvidenceRecord {
  event: string;
  visitor_id: string;
  props: Record<string, string | number | boolean>;
  occurred_at?: string;
}

export interface SubmissionRecord {
  form_id: string;
  visitor_id: string;
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

function appendLocal(file: string, record: unknown): void {
  const dir = join(process.cwd(), ".data");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, file),
    JSON.stringify({ occurred_at: new Date().toISOString(), ...(record as object) }) + "\n",
  );
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
    await sql`insert into submissions (form_id, visitor_id, payload, qualified, qualification_tier)
      values (${record.form_id}, ${record.visitor_id}, ${JSON.stringify(record.payload)}, ${record.qualified}, ${record.qualification_tier})`;
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
