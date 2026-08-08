import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const up = readFileSync("migrations/sql/001_core_evidence.up.sql", "utf8");
const down = readFileSync("migrations/sql/001_core_evidence.down.sql", "utf8");
const readme = readFileSync("migrations/sql/README.md", "utf8");

const managedTables = [
  "experiment_events",
  "commercial_events",
  "submissions",
  "consent_events",
  "product_events",
  "provider_webhook_events",
  "analytics_sync_runs",
] as const;

describe("executable SQL migrations", () => {
  it("uses one additive idempotent forward transaction", () => {
    expect(up).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(up.trimEnd()).toMatch(/commit;$/i);
    for (const table of ["vh_schema_migrations", ...managedTables]) {
      expect(up, table).toMatch(new RegExp(`create table if not exists ${table}\\b`, "i"));
    }
    expect(up).toContain("on conflict (version) do nothing");
    expect(up).not.toMatch(/\b(drop|truncate)\s+(table\s+)?/i);
    expect(up).not.toMatch(/\balter\s+table\b[\s\S]*\bdrop\b/i);
  });

  it("preserves first-party outcome, price, webhook, and provenance invariants", () => {
    expect(up).toMatch(/commercial_events[\s\S]*displayed_price text/i);
    expect(up).toMatch(/product_events[\s\S]*event_id text unique/i);
    expect(up).toMatch(/provider_webhook_events[\s\S]*unique \(provider, external_event_id\)/i);
    expect(up).toMatch(/analytics_sync_runs[\s\S]*source_account text not null/i);
    expect(up).toMatch(/analytics_sync_runs[\s\S]*window_start timestamptz not null/i);
    expect(up).toMatch(/analytics_sync_runs[\s\S]*timezone text not null/i);
    expect(up).toMatch(/analytics_sync_runs[\s\S]*limitations jsonb not null/i);
    expect(up).toContain(
      "missing source has\n-- no row and must never be converted into a zero-valued dataset",
    );
  });

  it("fails closed before any rollback drop when evidence exists", () => {
    expect(down).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(down.trimEnd()).toMatch(/commit;$/i);
    expect(down).toContain("errcode = '55000'");
    expect(down).toContain("safe rollback refused");
    expect(down).toContain("if to_regclass('public.vh_schema_migrations') is not null then");
    const guard = down.indexOf("do $$");
    const firstDrop = down.indexOf("drop table if exists");
    expect(guard).toBeGreaterThan(-1);
    expect(firstDrop).toBeGreaterThan(guard);
    expect(down).not.toMatch(/\bcascade\b/i);
    for (const table of managedTables) {
      expect(down, table).toContain(`'${table}'`);
      expect(down, table).toMatch(new RegExp(`drop table if exists ${table};`, "i"));
    }
  });

  it("documents exact apply/read-back and guarded rollback commands", () => {
    expect(readme).toContain(
      "psql --no-psqlrc --set=ON_ERROR_STOP=1 --file migrations/sql/001_core_evidence.up.sql",
    );
    expect(readme).toContain(
      "psql --no-psqlrc --set=ON_ERROR_STOP=1 --file migrations/sql/001_core_evidence.down.sql",
    );
    expect(readme).toContain("inputs.databaseCredentialRef");
    expect(readme).toContain("`PGDATABASE`");
    expect(readme).not.toContain("$DATABASE_URL");
    expect(readme).toContain("error `55000`");
    expect(readme).toContain("executable source of truth");
  });
});
