import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrustedLegacyTenantAdoptionMapping,
  LEGACY_UNSCOPED_ORGANIZATION_ID,
  type LegacyAdoptionOptions,
  type TrustedLegacyTenantAdoptionMapping,
} from "@/lib/winner-loop/legacy-adoption";
import {
  createSqliteSubscriptionEventStore,
  type SubscriptionScope,
} from "@/lib/winner-loop/subscription-store";
import type { SubscriptionEvent } from "@/lib/winner-loop/subscriptions";
import {
  createSqliteSpendStore,
  type StoredIncident,
  type StoredProviderPauseObligation,
} from "@/lib/winner-loop/spend-store";
import { createSpendLedger, verifySpendGrantHash } from "@/lib/winner-loop/spend";
import { createSqlitePaidTestStore } from "@/lib/winner-loop/paid-test-store";
import {
  hashMaterialTerms,
  type PaidTestProposal,
  type PaidTestProposalInput,
} from "@/lib/winner-loop/paid-test";

interface RawStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (filename: string) => RawDatabase;
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `vh-${label}-`));
  directories.push(directory);
  return join(directory, "winner-loop.sqlite");
}

function adoption(
  mappings: readonly {
    legacyVentureId: string;
    organizationId: string;
    ventureId: string;
  }[],
): LegacyAdoptionOptions {
  return {
    legacyAdoption: createTrustedLegacyTenantAdoptionMapping({
      ownershipVerification: "verified_out_of_band",
      authorizationDisposition: "invalidate_and_require_reapproval",
      approvedBy: "operator-verified-owner",
      approvedAt: "2026-08-09T12:00:00.000Z",
      mappings,
    }),
  };
}

type CredentialIdentityField = "approvedBy" | "legacyVentureId" | "organizationId" | "ventureId";

const CREDENTIAL_IDENTITY_CASES = [
  ["approver", "approvedBy", "whsec_approver_canary"],
  ["legacy venture id", "legacyVentureId", "whsec_legacy_canary"],
  ["target organization id", "organizationId", "whsec_organization_canary"],
  ["target venture id", "ventureId", "whsec_venture_canary"],
] as const satisfies readonly (readonly [string, CredentialIdentityField, string])[];

function forgedCredentialAdoption(
  field: CredentialIdentityField,
  credential: string,
): LegacyAdoptionOptions {
  const entry = {
    legacyVentureId: "legacy-a",
    organizationId: "org-a",
    ventureId: "venture-a",
  };
  const mapping = {
    contractVersion: 1,
    ownershipVerification: "verified_out_of_band",
    authorizationDisposition: "invalidate_and_require_reapproval",
    approvedBy: "operator-verified-owner",
    approvedAt: "2026-08-09T12:00:00.000Z",
    mappings: [
      field === "approvedBy"
        ? entry
        : {
            ...entry,
            [field]: credential,
          },
    ],
    ...(field === "approvedBy" ? { approvedBy: credential } : {}),
  } as TrustedLegacyTenantAdoptionMapping;
  return { legacyAdoption: mapping };
}

function subscriptionEvent(id: string, revenueMinor: number): SubscriptionEvent {
  return {
    providerEventId: id,
    type: "RENEWAL",
    environment: "production",
    subscriberId: `subscriber-${id}`,
    productId: "monthly",
    entitlementId: "pro",
    currency: "EUR",
    revenueMinor,
    occurredAt: "2026-08-01T10:00:00.000Z",
    receivedAt: "2026-08-01T10:00:01.000Z",
    rawReference: `fixture:${id}`,
  };
}

function createLegacySubscriptionDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE subscription_events (
      venture_id TEXT NOT NULL,
      revenuecat_project TEXT NOT NULL,
      environment TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (venture_id, revenuecat_project, environment, provider_event_id)
    );
  `);
  const insert = db.prepare(
    `INSERT INTO subscription_events
     (venture_id, revenuecat_project, environment, provider_event_id,
      event_json, occurred_at, received_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  for (const [ventureId, amount] of [
    ["legacy-a", 999],
    ["legacy-b", 1_999],
  ] as const) {
    const event = {
      ...subscriptionEvent("shared-provider-event", amount),
      organizationId: LEGACY_UNSCOPED_ORGANIZATION_ID,
      ventureId,
    };
    insert.run(
      ventureId,
      "rc-shared",
      "production",
      event.providerEventId,
      JSON.stringify(event),
      event.occurredAt,
      event.receivedAt,
    );
  }
  db.close();
}

describe("trusted subscription tenant adoption", () => {
  it("does not silently upgrade even an empty venture-only schema without ownership authority", () => {
    const path = databasePath("subscription-empty-legacy-schema");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE subscription_events (
        venture_id TEXT NOT NULL,
        revenuecat_project TEXT NOT NULL,
        environment TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, revenuecat_project, environment, provider_event_id)
      )
    `);
    db.close();
    expect(() => createSqliteSubscriptionEventStore(path)).toThrow(/explicit trusted adoption/i);
    const adopted = createSqliteSubscriptionEventStore(
      path,
      adoption([
        {
          legacyVentureId: "verified-empty-owner",
          organizationId: "org-empty",
          ventureId: "venture-empty",
        },
      ]),
    );
    expect(
      adopted.list({
        organizationId: "org-empty",
        ventureId: "venture-empty",
        revenueCatProject: "rc-empty",
        environment: "production",
      }),
    ).toEqual([]);
    adopted.close();
  });

  it("rejects absent, partial, duplicate, and forged ownership mappings", () => {
    const path = databasePath("subscription-adoption-reject");
    createLegacySubscriptionDatabase(path);

    expect(() => createSqliteSubscriptionEventStore(path)).toThrow(/explicit trusted adoption/i);
    expect(() =>
      createSqliteSubscriptionEventStore(
        path,
        adoption([{ legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" }]),
      ),
    ).toThrow(/incomplete.*legacy-b/i);
    expect(() =>
      createTrustedLegacyTenantAdoptionMapping({
        ownershipVerification: "verified_out_of_band",
        authorizationDisposition: "invalidate_and_require_reapproval",
        approvedBy: "operator",
        approvedAt: "2026-08-09T12:00:00.000Z",
        mappings: [
          { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" },
          { legacyVentureId: "legacy-a", organizationId: "org-b", ventureId: "venture" },
        ],
      }),
    ).toThrow(/mapped more than once/i);
    expect(() =>
      createTrustedLegacyTenantAdoptionMapping({
        ownershipVerification: "verified_out_of_band",
        authorizationDisposition: "invalidate_and_require_reapproval",
        approvedBy: "operator",
        approvedAt: "2026-08-09T12:00:00.000Z",
        mappings: [
          { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" },
          { legacyVentureId: "legacy-b", organizationId: "org-a", ventureId: "venture" },
        ],
      }),
    ).toThrow(/may not merge/i);
    for (const invalidIdentifier of [" legacy-a", "legacy/a", "legacy\0a"]) {
      expect(() =>
        createTrustedLegacyTenantAdoptionMapping({
          ownershipVerification: "verified_out_of_band",
          authorizationDisposition: "invalidate_and_require_reapproval",
          approvedBy: "operator",
          approvedAt: "2026-08-09T12:00:00.000Z",
          mappings: [
            {
              legacyVentureId: invalidIdentifier,
              organizationId: "org-a",
              ventureId: "venture",
            },
          ],
        }),
      ).toThrow(/canonical tenant identifier/i);
    }
    expect(() =>
      createSqliteSubscriptionEventStore(path, {
        legacyAdoption: {
          ...adoption([
            { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture-a" },
            { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture-b" },
          ]).legacyAdoption!,
          contractVersion: 2 as 1,
        },
      }),
    ).toThrow(/unsupported.*contract version/i);
    expect(() =>
      createSqliteSubscriptionEventStore(path, {
        legacyAdoption: {
          contractVersion: 1,
          ownershipVerification: "unverified" as "verified_out_of_band",
          authorizationDisposition: "invalidate_and_require_reapproval",
          approvedBy: "operator",
          approvedAt: "2026-08-09T12:00:00.000Z",
          mappings: [
            { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" },
            { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture" },
          ],
        },
      }),
    ).toThrow(/verified ownership/i);
  });

  it("atomically remaps evidence, integrity, economics, order, and same IDs across organizations", () => {
    const path = databasePath("subscription-adoption-success");
    createLegacySubscriptionDatabase(path);
    const options = adoption([
      { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" },
      { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture" },
    ]);
    const store = createSqliteSubscriptionEventStore(path, options);
    const scopeA: SubscriptionScope = {
      organizationId: "org-a",
      ventureId: "venture",
      revenueCatProject: "rc-shared",
      environment: "production",
    };
    const scopeB = { ...scopeA, organizationId: "org-b" };
    const eventA = store.list(scopeA)[0]!;
    const eventB = store.list(scopeB)[0]!;
    expect(eventA).toMatchObject({
      providerEventId: "shared-provider-event",
      revenueMinor: 999,
      occurredAt: "2026-08-01T10:00:00.000Z",
      organizationId: "org-a",
      ventureId: "venture",
    });
    expect(eventB).toMatchObject({
      providerEventId: "shared-provider-event",
      revenueMinor: 1_999,
      organizationId: "org-b",
      ventureId: "venture",
    });
    expect(() =>
      store.list({ ...scopeA, organizationId: LEGACY_UNSCOPED_ORGANIZATION_ID }),
    ).toThrow(/sentinel/i);
    store.close();

    const reopened = createSqliteSubscriptionEventStore(path);
    expect(reopened.list(scopeA)).toEqual([eventA]);
    expect(reopened.list(scopeB)).toEqual([eventB]);
    reopened.close();
    const db = new DatabaseSync(path);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM subscription_events WHERE organization_id = ?")
        .get(LEGACY_UNSCOPED_ORGANIZATION_ID),
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT content_hash FROM subscription_events").all()).toEqual([
      { content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    db.close();
  });

  it("rolls back a sentinel adoption when the verified target key already exists", () => {
    const path = databasePath("subscription-adoption-collision");
    createSqliteSubscriptionEventStore(path).close();
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO subscription_events
       (organization_id, venture_id, revenuecat_project, environment, provider_event_id,
        event_json, content_hash, occurred_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const event = subscriptionEvent("collision", 999);
    for (const [organizationId, ventureId] of [
      ["org-target", "venture-target"],
      [LEGACY_UNSCOPED_ORGANIZATION_ID, "legacy-collision"],
    ]) {
      insert.run(
        organizationId,
        ventureId,
        "rc-collision",
        "production",
        event.providerEventId,
        JSON.stringify({ ...event, organizationId, ventureId }),
        "legacy-content-hash",
        event.occurredAt,
        event.receivedAt,
      );
    }
    db.close();

    expect(() => createSqliteSubscriptionEventStore(path)).toThrow(/explicit trusted adoption/i);
    expect(() =>
      createSqliteSubscriptionEventStore(
        path,
        adoption([
          {
            legacyVentureId: "legacy-collision",
            organizationId: "org-target",
            ventureId: "venture-target",
          },
        ]),
      ),
    ).toThrow(/unique constraint/i);
    const readback = new DatabaseSync(path);
    expect(
      readback
        .prepare(
          `SELECT organization_id FROM subscription_events
           WHERE provider_event_id = 'collision' ORDER BY organization_id`,
        )
        .all(),
    ).toEqual([
      { organization_id: LEGACY_UNSCOPED_ORGANIZATION_ID },
      { organization_id: "org-target" },
    ]);
    readback.close();
  });

  it("adopts identical already-scoped sentinel events into two independent owners", () => {
    const path = databasePath("subscription-sentinel-two-owner");
    createSqliteSubscriptionEventStore(path).close();
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO subscription_events
       (organization_id, venture_id, revenuecat_project, environment, provider_event_id,
        event_json, content_hash, occurred_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    for (const [ventureId, amount] of [
      ["legacy-a", 700],
      ["legacy-b", 900],
    ] as const) {
      const event = subscriptionEvent("same-event", amount);
      insert.run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
        ventureId,
        "rc-shared",
        "production",
        event.providerEventId,
        JSON.stringify({
          ...event,
          organizationId: LEGACY_UNSCOPED_ORGANIZATION_ID,
          ventureId,
        }),
        "legacy-content-hash",
        event.occurredAt,
        event.receivedAt,
      );
    }
    db.close();

    const store = createSqliteSubscriptionEventStore(
      path,
      adoption([
        { legacyVentureId: "legacy-a", organizationId: "owner-a", ventureId: "venture" },
        { legacyVentureId: "legacy-b", organizationId: "owner-b", ventureId: "venture" },
      ]),
    );
    expect(
      store.list({
        organizationId: "owner-a",
        ventureId: "venture",
        revenueCatProject: "rc-shared",
        environment: "production",
      }),
    ).toEqual([expect.objectContaining({ providerEventId: "same-event", revenueMinor: 700 })]);
    expect(
      store.list({
        organizationId: "owner-b",
        ventureId: "venture",
        revenueCatProject: "rc-shared",
        environment: "production",
      }),
    ).toEqual([expect.objectContaining({ providerEventId: "same-event", revenueMinor: 900 })]);
    store.close();
  });
});

function createLegacySpendDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE spend_grants (
      venture_id TEXT NOT NULL, grant_id TEXT NOT NULL, customer_id TEXT,
      network TEXT NOT NULL, external_account_id TEXT NOT NULL, currency TEXT NOT NULL,
      total_minor INTEGER NOT NULL, per_creative_minor INTEGER NOT NULL,
      per_paid_test_minor INTEGER NOT NULL, per_campaign_minor INTEGER NOT NULL,
      daily_account_minor INTEGER NOT NULL, daily_venture_minor INTEGER NOT NULL,
      monthly_venture_minor INTEGER NOT NULL, daily_customer_minor INTEGER NOT NULL,
      monthly_customer_minor INTEGER NOT NULL, emergency_platform_minor INTEGER NOT NULL,
      allowed_creative_ids TEXT NOT NULL, approved_by TEXT NOT NULL,
      approval_ref TEXT NOT NULL, proposal_id TEXT NOT NULL, not_before TEXT NOT NULL,
      expires_at TEXT NOT NULL, grant_hash TEXT NOT NULL, issued_at TEXT NOT NULL,
      halted_reason TEXT, PRIMARY KEY (venture_id, grant_id)
    );
    CREATE TABLE spend_reservations (
      venture_id TEXT NOT NULL, reservation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      grant_id TEXT NOT NULL, creative_id TEXT NOT NULL, paid_test_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL, external_account_id TEXT NOT NULL, held_minor INTEGER NOT NULL,
      settled_minor INTEGER, status TEXT NOT NULL, pending_reason TEXT, pending_at TEXT,
      reconciliation_outcome TEXT, reconciled_at TEXT, day_key TEXT NOT NULL,
      month_key TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (venture_id, reservation_id), UNIQUE (venture_id, idempotency_key)
    );
    CREATE TABLE spend_incidents (
      venture_id TEXT NOT NULL, incident_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL, recorded_at TEXT NOT NULL,
      PRIMARY KEY (venture_id, incident_id)
    );
    CREATE TABLE provider_pause_obligations (
      venture_id TEXT NOT NULL, obligation_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      network TEXT NOT NULL, provider_adapter_id TEXT, external_account_id TEXT NOT NULL,
      campaign_id TEXT, target_key TEXT NOT NULL, operation_id TEXT, idempotency_key TEXT,
      request_hash TEXT, payload_json TEXT, reasons_json TEXT NOT NULL,
      incident_ids_json TEXT NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      provider_operation_id TEXT, last_diagnostic_code TEXT, last_diagnostic_message TEXT,
      evidence_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_attempted_at TEXT, last_apply_state TEXT, last_read_back_state TEXT,
      last_read_back_at TEXT, last_reconciled_at TEXT, verified_at TEXT,
      PRIMARY KEY (venture_id, obligation_id)
    );
  `);
  const insertGrant = db.prepare(
    `INSERT INTO spend_grants VALUES
     (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertReservation = db.prepare(
    `INSERT INTO spend_reservations VALUES
     (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const ventureId of ["legacy-a", "legacy-b"]) {
    insertGrant.run(
      ventureId,
      "grant-shared",
      null,
      "tiktok_paid",
      "ad-account-shared",
      "EUR",
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      1_000,
      JSON.stringify(["creative-shared"]),
      "legacy-approver",
      "checkpoint:legacy",
      "proposal-shared",
      "2026-08-01T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
      "legacy-hash",
      "2026-08-01T00:00:00.000Z",
      null,
    );
    insertReservation.run(
      ventureId,
      "reservation-held",
      "legacy-retry",
      "grant-shared",
      "creative-shared",
      "proposal-shared",
      "campaign-shared",
      "ad-account-shared",
      ventureId === "legacy-a" ? 600 : 400,
      null,
      "held",
      null,
      null,
      null,
      null,
      "2026-08-09",
      "2026-08",
      "2026-08-09T10:00:00.000Z",
    );
  }
  db.prepare("INSERT INTO spend_reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "legacy-a",
    "reservation-settled",
    "legacy-settled-retry",
    "grant-shared",
    "creative-shared",
    "proposal-shared",
    "campaign-settled",
    "ad-account-shared",
    200,
    150,
    "settled",
    null,
    null,
    null,
    null,
    "2026-08-08",
    "2026-08",
    "2026-08-08T10:00:00.000Z",
  );
  db.prepare("INSERT INTO spend_incidents VALUES (?,?,?,?,?,?)").run(
    "legacy-a",
    "incident-history",
    "grant-shared",
    "provider_overspend",
    "historical provider evidence",
    "2026-08-08T11:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO provider_pause_obligations VALUES
     (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "legacy-a",
    "pause-old",
    "grant-shared",
    "tiktok_paid",
    "tiktok_spark_ads",
    "ad-account-shared",
    "campaign-shared",
    "campaign-shared",
    "operation-old",
    "pause-retry-old",
    "a".repeat(64),
    JSON.stringify({ organizationId: "legacy-org", ventureId: "legacy-a" }),
    JSON.stringify(["provider_overspend"]),
    JSON.stringify(["incident-history"]),
    "verified",
    1,
    "provider-operation-old",
    null,
    null,
    JSON.stringify({ organizationId: "legacy-org", ventureId: "legacy-a", matched: true }),
    "2026-08-08T11:00:00.000Z",
    "2026-08-08T11:01:00.000Z",
    "2026-08-08T11:00:30.000Z",
    "accepted_unverified",
    "matched",
    "2026-08-08T11:01:00.000Z",
    "2026-08-08T11:01:00.000Z",
    "2026-08-08T11:01:00.000Z",
  );
  db.close();
}

describe("trusted spend tenant adoption", () => {
  it.each(CREDENTIAL_IDENTITY_CASES)(
    "rejects credential-like %s material without mutating the raw financial database",
    (_label, field, credential) => {
      const path = databasePath(`spend-credential-${field}`);
      createLegacySpendDatabase(path);
      const snapshot = () => {
        const raw = new DatabaseSync(path);
        const result = {
          columns: raw.prepare("PRAGMA table_info(spend_grants)").all(),
          grants: raw
            .prepare(
              "SELECT venture_id, grant_id, approved_by FROM spend_grants ORDER BY venture_id, grant_id",
            )
            .all(),
          journal: raw
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'legacy_tenant_adoptions'",
            )
            .get(),
        };
        raw.close();
        return result;
      };
      const before = snapshot();
      let failure: unknown;
      try {
        createSqliteSpendStore(path, forgedCredentialAdoption(field, credential));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "invalid_legacy_tenant_mapping" });
      expect((failure as Error).message).toMatch(/credential-like material/i);
      expect((failure as Error).message).not.toContain(credential);
      expect(snapshot()).toEqual(before);
    },
  );

  it("requires a complete mapping and atomically invalidates legacy financial authority", () => {
    const path = databasePath("spend-adoption");
    createLegacySpendDatabase(path);
    expect(() => createSqliteSpendStore(path)).toThrow(/explicit trusted adoption/i);
    expect(() =>
      createSqliteSpendStore(
        path,
        adoption([{ legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" }]),
      ),
    ).toThrow(/incomplete.*legacy-b/i);

    const options = adoption([
      { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture" },
      { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture" },
    ]);
    const store = createSqliteSpendStore(path, options);
    const scopeA = { organizationId: "org-a", ventureId: "venture" };
    const scopeB = { organizationId: "org-b", ventureId: "venture" };
    const grantA = store.getGrant(scopeA, "grant-shared")!;
    const grantB = store.getGrant(scopeB, "grant-shared")!;
    expect(verifySpendGrantHash(grantA)).toBe(true);
    expect(verifySpendGrantHash(grantB)).toBe(true);
    expect(store.haltReason(scopeA, grantA.grantId)).toContain(
      "legacy_tenant_adoption_requires_reapproval",
    );
    expect(store.listReservations(scopeA, grantA.grantId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reservationId: "reservation-held",
          status: "released",
          settledMinorUnits: null,
        }),
        expect.objectContaining({
          reservationId: "reservation-settled",
          status: "settled",
          settledMinorUnits: 150,
        }),
      ]),
    );
    expect(store.listIncidents(scopeA, grantA.grantId)).toEqual([
      expect.objectContaining({
        incidentId: "incident-history",
        detail: "historical provider evidence",
      }),
    ]);
    expect(store.listProviderPauseObligations(scopeA, grantA.grantId)).toEqual([
      expect.objectContaining({
        state: "blocked",
        operationId: null,
        idempotencyKey: null,
        requestHash: null,
        providerOperationId: null,
        lastDiagnosticCode: "legacy_tenant_adoption_requires_reapproval",
      }),
    ]);
    expect(() =>
      store.getGrant(
        { organizationId: LEGACY_UNSCOPED_ORGANIZATION_ID, ventureId: "legacy-a" },
        grantA.grantId,
      ),
    ).toThrow(/sentinel/i);

    const ledger = createSpendLedger({
      store,
      now: () => new Date("2026-08-09T12:30:00.000Z"),
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 1),
    });
    expect(() =>
      ledger.reserve({
        ...scopeA,
        grantId: grantA.grantId,
        creativeId: "creative-shared",
        campaignId: "campaign-new",
        amountMinorUnits: 1,
        idempotencyKey: "must-not-reuse-adopted-grant",
      }),
    ).toThrow(/halted/i);
    const replacement = ledger.registerGrant({
      ...scopeA,
      network: "tiktok_paid",
      externalAccountId: "ad-account-shared",
      currency: "EUR",
      totalMinorUnits: 1_000,
      perCreativeMinorUnits: 1_000,
      perPaidTestMinorUnits: 1_000,
      perCampaignMinorUnits: 1_000,
      dailyAccountMinorUnits: 1_000,
      dailyVentureMinorUnits: 1_000,
      monthlyVentureMinorUnits: 1_000,
      dailyCustomerMinorUnits: 1_000,
      monthlyCustomerMinorUnits: 1_000,
      emergencyPlatformMinorUnits: 1_000,
      allowedCreativeIds: ["creative-new"],
      approvedBy: "fresh-human-approver",
      approvalRef: "checkpoint:fresh-reapproval",
      proposalId: "proposal-new",
      notBefore: "2026-08-09T12:00:00.000Z",
      expiresAt: "2026-08-10T12:00:00.000Z",
    });
    expect(() =>
      ledger.reserve({
        ...scopeA,
        grantId: replacement.grantId,
        creativeId: "creative-new",
        campaignId: "campaign-new",
        amountMinorUnits: 401,
        idempotencyKey: "conservative-headroom",
      }),
    ).toThrow(/exceeds.*cap/i);
    store.close();

    const reopened = createSqliteSpendStore(path);
    expect(reopened.getGrant(scopeA, "grant-shared")).toMatchObject({ organizationId: "org-a" });
    expect(reopened.getGrant(scopeB, "grant-shared")).toMatchObject({ organizationId: "org-b" });
    expect(
      reopened.getGrant({ ...scopeA, organizationId: "org-b" }, replacement.grantId),
    ).toBeUndefined();
    reopened.close();
  });

  it.each(["spend_reservations", "spend_incidents", "provider_pause_obligations"])(
    "rejects and leaves the venture-only database untouched when %s references another venture's grant",
    (childTable) => {
      const path = databasePath(`spend-cross-venture-${childTable}`);
      createLegacySpendDatabase(path);
      const corrupted = new DatabaseSync(path);
      corrupted
        .prepare("UPDATE spend_grants SET grant_id = ? WHERE venture_id = ?")
        .run("grant-only-a", "legacy-a");
      for (const table of ["spend_reservations", "spend_incidents", "provider_pause_obligations"]) {
        corrupted
          .prepare(`UPDATE ${table} SET grant_id = ? WHERE venture_id = ?`)
          .run("grant-only-a", "legacy-a");
      }
      if (childTable === "spend_reservations") {
        corrupted
          .prepare(
            `UPDATE spend_reservations
                SET reservation_id = reservation_id || '-cross',
                    idempotency_key = idempotency_key || '-cross'
              WHERE venture_id = ? AND grant_id = ?`,
          )
          .run("legacy-a", "grant-only-a");
      }
      corrupted
        .prepare(`UPDATE ${childTable} SET venture_id = ? WHERE grant_id = ?`)
        .run("legacy-b", "grant-only-a");
      corrupted.close();

      expect(() =>
        createSqliteSpendStore(
          path,
          adoption([
            { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture-a" },
            { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture-b" },
          ]),
        ),
      ).toThrow(/cross-venture.*grant ownership/i);
      const unchanged = new DatabaseSync(path);
      expect(
        unchanged
          .prepare("PRAGMA table_info(spend_grants)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).not.toContain("organization_id");
      expect(unchanged.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      unchanged.close();
    },
  );

  it("rejects a provider pause whose incident evidence has no same-grant parent", () => {
    const path = databasePath("spend-pause-incident-orphan");
    createLegacySpendDatabase(path);
    const corrupted = new DatabaseSync(path);
    corrupted
      .prepare(
        "UPDATE provider_pause_obligations SET incident_ids_json = ? WHERE obligation_id = ?",
      )
      .run(JSON.stringify(["missing-incident"]), "pause-old");
    corrupted.close();

    expect(() =>
      createSqliteSpendStore(
        path,
        adoption([
          { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture-a" },
          { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture-b" },
        ]),
      ),
    ).toThrow(/provider pause.*missing.*incident ownership/i);
    const unchanged = new DatabaseSync(path);
    expect(
      unchanged
        .prepare("PRAGMA table_info(spend_grants)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).not.toContain("organization_id");
    expect(
      unchanged
        .prepare("SELECT incident_ids_json FROM provider_pause_obligations WHERE obligation_id = ?")
        .get("pause-old"),
    ).toEqual({ incident_ids_json: JSON.stringify(["missing-incident"]) });
    unchanged.close();
  });

  it.each(["spend_reservations", "spend_incidents", "provider_pause_obligations"])(
    "rejects a scoped sentinel %s row whose grant belongs to another legacy venture",
    (childTable) => {
      const path = databasePath(`spend-sentinel-cross-venture-${childTable}`);
      const initial = createSqliteSpendStore(path);
      const ledger = createSpendLedger({
        store: initial,
        now: () => new Date("2026-08-09T12:30:00.000Z"),
        randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 31),
      });
      const grant = ledger.registerGrant({
        organizationId: "holding-a",
        ventureId: "legacy-a",
        network: "tiktok_paid",
        externalAccountId: "ad-sentinel",
        currency: "EUR",
        totalMinorUnits: 1_000,
        perCreativeMinorUnits: 1_000,
        dailyAccountMinorUnits: 1_000,
        allowedCreativeIds: ["creative-sentinel"],
        approvedBy: "legacy-approver",
        approvalRef: "checkpoint:legacy",
        proposalId: "proposal-sentinel",
        notBefore: "2026-08-09T12:00:00.000Z",
        expiresAt: "2026-08-10T12:00:00.000Z",
      });
      ledger.reserve({
        organizationId: "holding-a",
        ventureId: "legacy-a",
        grantId: grant.grantId,
        creativeId: "creative-sentinel",
        campaignId: "campaign-sentinel",
        amountMinorUnits: 100,
        idempotencyKey: "reservation-cross-venture",
      });
      const incident: StoredIncident = {
        organizationId: "holding-a",
        ventureId: "legacy-a",
        grantId: grant.grantId,
        incidentId: "incident-cross-venture",
        kind: "provider_overspend",
        detail: "sanitized fixture incident",
        recordedAt: "2026-08-09T12:31:00.000Z",
      };
      const pause: StoredProviderPauseObligation = {
        organizationId: "holding-a",
        ventureId: "legacy-a",
        grantId: grant.grantId,
        obligationId: "pause-cross-venture",
        network: "tiktok_paid",
        providerAdapterId: "tiktok_spark_ads",
        externalAccountId: "ad-sentinel",
        campaignId: "campaign-sentinel",
        operationId: "operation-cross-venture",
        idempotencyKey: "pause-cross-venture",
        requestHash: "c".repeat(64),
        payloadJson: JSON.stringify({
          organizationId: "holding-a",
          ventureId: "legacy-a",
          operation: "pause",
        }),
        reasons: ["provider_overspend"],
        incidentIds: [incident.incidentId],
        state: "verified",
        attemptCount: 1,
        providerOperationId: "provider-operation-cross-venture",
        lastDiagnosticCode: null,
        lastDiagnosticMessage: null,
        evidenceJson: JSON.stringify({ matched: true }),
        createdAt: "2026-08-09T12:31:00.000Z",
        updatedAt: "2026-08-09T12:32:00.000Z",
        lastAttemptedAt: "2026-08-09T12:31:30.000Z",
        lastApplyState: "accepted_unverified",
        lastReadBackState: "matched",
        lastReadBackAt: "2026-08-09T12:32:00.000Z",
        lastReconciledAt: "2026-08-09T12:32:00.000Z",
        verifiedAt: "2026-08-09T12:32:00.000Z",
      };
      initial.haltAndQueueProviderPauses(
        { organizationId: "holding-a", ventureId: "legacy-a" },
        grant.grantId,
        "legacy fixture halt",
        [pause],
        [incident],
      );
      initial.close();
      const corrupted = new DatabaseSync(path);
      corrupted.exec("PRAGMA foreign_keys = OFF");
      for (const table of ["spend_reservations", "spend_incidents", "provider_pause_obligations"]) {
        corrupted
          .prepare(`UPDATE ${table} SET organization_id = ?`)
          .run(LEGACY_UNSCOPED_ORGANIZATION_ID);
      }
      corrupted
        .prepare("UPDATE spend_grants SET organization_id = ? WHERE grant_id = ?")
        .run(LEGACY_UNSCOPED_ORGANIZATION_ID, grant.grantId);
      corrupted.prepare(`UPDATE ${childTable} SET venture_id = ?`).run("legacy-b");
      corrupted.close();

      expect(() =>
        createSqliteSpendStore(
          path,
          adoption([
            { legacyVentureId: "legacy-a", organizationId: "org-a", ventureId: "venture-a" },
            { legacyVentureId: "legacy-b", organizationId: "org-b", ventureId: "venture-b" },
          ]),
        ),
      ).toThrow(/cross-venture.*grant ownership/i);
      const unchanged = new DatabaseSync(path);
      expect(
        unchanged.prepare(`SELECT organization_id, venture_id FROM ${childTable}`).get(),
      ).toEqual({
        organization_id: LEGACY_UNSCOPED_ORGANIZATION_ID,
        venture_id: "legacy-b",
      });
      unchanged.close();
    },
  );

  it("keeps sentinel and target financial rows unchanged when an adopted key collides", () => {
    const path = databasePath("spend-adoption-collision");
    const initial = createSqliteSpendStore(path);
    const ledger = createSpendLedger({
      store: initial,
      now: () => new Date("2026-08-09T12:30:00.000Z"),
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 3),
    });
    const target = ledger.registerGrant({
      organizationId: "org-target",
      ventureId: "venture-target",
      network: "tiktok_paid",
      externalAccountId: "ad-target",
      currency: "EUR",
      totalMinorUnits: 1_000,
      perCreativeMinorUnits: 1_000,
      dailyAccountMinorUnits: 1_000,
      allowedCreativeIds: ["creative-target"],
      approvedBy: "target-approver",
      approvalRef: "checkpoint:target",
      proposalId: "proposal-target",
      notBefore: "2026-08-09T12:00:00.000Z",
      expiresAt: "2026-08-10T12:00:00.000Z",
    });
    initial.close();
    const db = new DatabaseSync(path);
    db.prepare(
      `INSERT INTO spend_grants (
        organization_id, venture_id, grant_id, customer_id, network, external_account_id,
        currency, total_minor, per_creative_minor, per_paid_test_minor, per_campaign_minor,
        daily_account_minor, daily_venture_minor, monthly_venture_minor,
        daily_customer_minor, monthly_customer_minor, emergency_platform_minor,
        allowed_creative_ids, approved_by, approval_ref, proposal_id, not_before,
        expires_at, grant_hash, issued_at, halted_reason
      ) SELECT ?, ?, grant_id, customer_id, network, external_account_id,
               currency, total_minor, per_creative_minor, per_paid_test_minor, per_campaign_minor,
               daily_account_minor, daily_venture_minor, monthly_venture_minor,
               daily_customer_minor, monthly_customer_minor, emergency_platform_minor,
               allowed_creative_ids, approved_by, approval_ref, proposal_id, not_before,
               expires_at, grant_hash, issued_at, halted_reason
        FROM spend_grants
       WHERE organization_id = ? AND venture_id = ? AND grant_id = ?`,
    ).run(
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      "legacy-collision",
      target.organizationId,
      target.ventureId,
      target.grantId,
    );
    db.close();

    expect(() =>
      createSqliteSpendStore(
        path,
        adoption([
          {
            legacyVentureId: "legacy-collision",
            organizationId: target.organizationId,
            ventureId: target.ventureId,
          },
        ]),
      ),
    ).toThrow(/unique constraint/i);
    const readback = new DatabaseSync(path);
    expect(
      readback
        .prepare("SELECT COUNT(*) AS count FROM spend_grants WHERE grant_id = ?")
        .get(target.grantId),
    ).toEqual({ count: 2 });
    readback.close();
  });

  it("does not launder an existing target-scope provider pause orphan through parent adoption", () => {
    const path = databasePath("spend-adoption-target-orphan");
    const initial = createSqliteSpendStore(path);
    const ledger = createSpendLedger({
      store: initial,
      now: () => new Date("2026-08-09T12:30:00.000Z"),
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index + 41),
    });
    const grant = ledger.registerGrant({
      organizationId: "holding-owner",
      ventureId: "legacy-orphan",
      network: "tiktok_paid",
      externalAccountId: "ad-orphan",
      currency: "EUR",
      totalMinorUnits: 1_000,
      perCreativeMinorUnits: 1_000,
      dailyAccountMinorUnits: 1_000,
      allowedCreativeIds: ["creative-orphan"],
      approvedBy: "legacy-approver",
      approvalRef: "checkpoint:legacy",
      proposalId: "proposal-orphan",
      notBefore: "2026-08-09T12:00:00.000Z",
      expiresAt: "2026-08-10T12:00:00.000Z",
    });
    initial.close();

    const corrupted = new DatabaseSync(path);
    corrupted.exec("PRAGMA foreign_keys = OFF");
    corrupted
      .prepare("UPDATE spend_grants SET organization_id = ? WHERE grant_id = ?")
      .run(LEGACY_UNSCOPED_ORGANIZATION_ID, grant.grantId);
    corrupted
      .prepare(
        `INSERT INTO provider_pause_obligations (
          organization_id, venture_id, obligation_id, grant_id, network, provider_adapter_id,
          external_account_id, campaign_id, target_key, operation_id, idempotency_key,
          request_hash, payload_json, reasons_json, incident_ids_json, state, attempt_count,
          provider_operation_id, last_diagnostic_code, last_diagnostic_message, evidence_json,
          created_at, updated_at, last_attempted_at, last_apply_state, last_read_back_state,
          last_read_back_at, last_reconciled_at, verified_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "owner-target",
        "venture-target",
        "pause-orphan",
        grant.grantId,
        "tiktok_paid",
        "tiktok_spark_ads",
        "ad-orphan",
        "campaign-orphan",
        "campaign-orphan",
        "operation-orphan",
        "pause-retry-orphan",
        "b".repeat(64),
        JSON.stringify({
          organizationId: "owner-target",
          ventureId: "venture-target",
          operation: "pause",
        }),
        JSON.stringify(["provider_overspend"]),
        JSON.stringify(["incident-orphan"]),
        "verified",
        1,
        "provider-operation-orphan",
        null,
        null,
        JSON.stringify({ matched: true }),
        "2026-08-09T12:31:00.000Z",
        "2026-08-09T12:32:00.000Z",
        "2026-08-09T12:31:30.000Z",
        "accepted_unverified",
        "matched",
        "2026-08-09T12:32:00.000Z",
        "2026-08-09T12:32:00.000Z",
        "2026-08-09T12:32:00.000Z",
      );
    corrupted.close();

    const options = adoption([
      {
        legacyVentureId: "legacy-orphan",
        organizationId: "owner-target",
        ventureId: "venture-target",
      },
    ]);
    expect(() => createSqliteSpendStore(path, options)).toThrow(/invalid parent-child/i);
    expect(() => createSqliteSpendStore(path, options)).toThrow(/invalid parent-child/i);
    const unchanged = new DatabaseSync(path);
    expect(
      unchanged
        .prepare("SELECT organization_id, venture_id FROM spend_grants WHERE grant_id = ?")
        .get(grant.grantId),
    ).toEqual({
      organization_id: LEGACY_UNSCOPED_ORGANIZATION_ID,
      venture_id: "legacy-orphan",
    });
    expect(
      unchanged
        .prepare(
          `SELECT state, operation_id, provider_operation_id
             FROM provider_pause_obligations WHERE obligation_id = ?`,
        )
        .get("pause-orphan"),
    ).toEqual({
      state: "verified",
      operation_id: "operation-orphan",
      provider_operation_id: "provider-operation-orphan",
    });
    unchanged.close();
  });

  it("adopts already-scoped sentinel rows with identical opaque IDs into two isolated owners", () => {
    const path = databasePath("spend-sentinel-two-owner");
    const initial = createSqliteSpendStore(path);
    const fixedRandom = (size: number) =>
      Uint8Array.from({ length: size }, (_, index) => index + 9);
    const seed = (organizationId: string, ventureId: string) => {
      const ledger = createSpendLedger({
        store: initial,
        now: () => new Date("2026-08-09T12:30:00.000Z"),
        randomBytes: fixedRandom,
      });
      const grant = ledger.registerGrant({
        organizationId,
        ventureId,
        network: "tiktok_paid",
        externalAccountId: "ad-shared",
        currency: "EUR",
        totalMinorUnits: 1_000,
        perCreativeMinorUnits: 1_000,
        dailyAccountMinorUnits: 1_000,
        allowedCreativeIds: ["creative-shared"],
        approvedBy: "legacy-approver",
        approvalRef: "checkpoint:legacy",
        proposalId: "proposal-shared",
        notBefore: "2026-08-09T12:00:00.000Z",
        expiresAt: "2026-08-10T12:00:00.000Z",
      });
      const reservation = ledger.reserve({
        organizationId,
        ventureId,
        grantId: grant.grantId,
        creativeId: "creative-shared",
        campaignId: "campaign-shared",
        amountMinorUnits: 250,
        idempotencyKey: "retry-shared",
      });
      const incident: StoredIncident = {
        organizationId,
        ventureId,
        grantId: grant.grantId,
        incidentId: "incident-shared",
        kind: "provider_overspend",
        detail: "sanitized sentinel fixture incident",
        recordedAt: "2026-08-09T12:31:00.000Z",
      };
      const pause: StoredProviderPauseObligation = {
        organizationId,
        ventureId,
        grantId: grant.grantId,
        obligationId: "pause-shared",
        network: "tiktok_paid",
        providerAdapterId: "tiktok_spark_ads",
        externalAccountId: "ad-shared",
        campaignId: "campaign-shared",
        operationId: "operation-shared",
        idempotencyKey: "pause-retry-shared",
        requestHash: "a".repeat(64),
        payloadJson: JSON.stringify({ organizationId, ventureId, operation: "pause" }),
        reasons: ["provider_overspend"],
        incidentIds: [incident.incidentId],
        state: "verified",
        attemptCount: 1,
        providerOperationId: "provider-operation-shared",
        lastDiagnosticCode: null,
        lastDiagnosticMessage: null,
        evidenceJson: JSON.stringify({ organizationId, ventureId, matched: true }),
        createdAt: "2026-08-09T12:31:00.000Z",
        updatedAt: "2026-08-09T12:32:00.000Z",
        lastAttemptedAt: "2026-08-09T12:31:30.000Z",
        lastApplyState: "accepted_unverified",
        lastReadBackState: "matched",
        lastReadBackAt: "2026-08-09T12:32:00.000Z",
        lastReconciledAt: "2026-08-09T12:32:00.000Z",
        verifiedAt: "2026-08-09T12:32:00.000Z",
      };
      initial.haltAndQueueProviderPauses(
        { organizationId, ventureId },
        grant.grantId,
        "legacy fixture halt",
        [pause],
        [incident],
      );
      return { grant, reservation, incident, pause };
    };
    const first = seed("holding-a", "legacy-a");
    const second = seed("holding-b", "legacy-b");
    expect(second.grant.grantId).toBe(first.grant.grantId);
    expect(second.reservation.reservationId).toBe(first.reservation.reservationId);
    initial.close();

    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE spend_reservations SET organization_id = ?").run(
      LEGACY_UNSCOPED_ORGANIZATION_ID,
    );
    db.prepare("UPDATE spend_incidents SET organization_id = ?").run(
      LEGACY_UNSCOPED_ORGANIZATION_ID,
    );
    db.prepare("UPDATE provider_pause_obligations SET organization_id = ?").run(
      LEGACY_UNSCOPED_ORGANIZATION_ID,
    );
    db.prepare("UPDATE spend_grants SET organization_id = ?").run(LEGACY_UNSCOPED_ORGANIZATION_ID);
    db.close();

    const adopted = createSqliteSpendStore(
      path,
      adoption([
        { legacyVentureId: "legacy-a", organizationId: "owner-a", ventureId: "venture" },
        { legacyVentureId: "legacy-b", organizationId: "owner-b", ventureId: "venture" },
      ]),
    );
    for (const organizationId of ["owner-a", "owner-b"]) {
      const scope = { organizationId, ventureId: "venture" };
      expect(adopted.getGrant(scope, first.grant.grantId)).toMatchObject({ organizationId });
      expect(adopted.listReservations(scope, first.grant.grantId)).toEqual([
        expect.objectContaining({
          reservationId: first.reservation.reservationId,
          status: "released",
        }),
      ]);
      expect(adopted.listIncidents(scope, first.grant.grantId)).toEqual([
        expect.objectContaining({
          incidentId: first.incident.incidentId,
          organizationId,
          ventureId: "venture",
        }),
      ]);
      expect(adopted.listProviderPauseObligations(scope, first.grant.grantId)).toEqual([
        expect.objectContaining({
          organizationId,
          ventureId: "venture",
          state: "blocked",
          operationId: null,
          idempotencyKey: null,
          requestHash: null,
          payloadJson: null,
          providerOperationId: null,
          incidentIds: [first.incident.incidentId],
          lastDiagnosticCode: "legacy_tenant_adoption_requires_reapproval",
        }),
      ]);
    }
    adopted.close();

    const reopened = createSqliteSpendStore(path);
    for (const organizationId of ["owner-a", "owner-b"]) {
      const scope = { organizationId, ventureId: "venture" };
      expect(reopened.listIncidents(scope, first.grant.grantId)).toHaveLength(1);
      expect(reopened.listProviderPauseObligations(scope, first.grant.grantId)).toEqual([
        expect.objectContaining({ state: "blocked", operationId: null, payloadJson: null }),
      ]);
    }
    reopened.close();
  });
});

function proposalInput(ventureId: string): PaidTestProposalInput {
  return {
    organizationId: LEGACY_UNSCOPED_ORGANIZATION_ID,
    ventureId,
    creativeId: "creative-shared",
    deliveryVariantId: "delivery-shared",
    organicPostId: "post-shared",
    network: "tiktok_paid",
    adAccountId: "ad-account-shared",
    objective: "APP_PROMOTION",
    optimizationEvent: "SUBSCRIBE",
    geographies: ["NL"],
    audienceConstraints: ["18+"],
    totalBudgetMinor: 1_000,
    dailyCapMinor: 500,
    currency: "EUR",
    startAt: "2026-08-10T00:00:00.000Z",
    endAt: "2026-08-20T00:00:00.000Z",
    targetCacMinor: 500,
    hardMaxCacMinor: 800,
    paybackTargetDays: 30,
    maxSpendWithoutTrialMinor: 500,
    maxSpendWithoutPurchaseMinor: 1_000,
    trackingHealthy: true,
    attributionHealthy: true,
    rightsState: "approved_for_paid",
    disclosureState: "present",
    providerEligible: true,
    recommendationId: "recommendation-shared",
    evidence: ["fixture:legacy-evidence"],
    createdBy: "legacy-system",
    expiresAt: "2026-08-15T00:00:00.000Z",
  };
}

function approvedProposal(ventureId: string): PaidTestProposal {
  const input = proposalInput(ventureId);
  return {
    ...input,
    proposalId: "proposal-shared",
    proposalVersion: 1,
    status: "APPROVED",
    materialHash: hashMaterialTerms(input),
    createdAt: "2026-08-09T10:00:00.000Z",
    decidedBy: "legacy-human",
    decidedAt: "2026-08-09T10:05:00.000Z",
    approvalRef: "checkpoint:legacy-paid",
    decisionReason: null,
  };
}

function createLegacyPaidDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE paid_test_proposal_history (
      record_id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL, proposal_json TEXT NOT NULL, recorded_at TEXT NOT NULL
    );
    CREATE TABLE paid_test_proposals (
      proposal_id TEXT NOT NULL PRIMARY KEY, proposal_json TEXT NOT NULL, recorded_at TEXT NOT NULL
    );
    CREATE TABLE paid_test_safety_state (
      proposal_id TEXT NOT NULL PRIMARY KEY, tracking_healthy INTEGER NOT NULL,
      attribution_healthy INTEGER NOT NULL, provider_eligible INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );
  `);
  const proposal = approvedProposal("legacy-paid");
  db.prepare("INSERT INTO paid_test_proposals VALUES (?,?,?)").run(
    proposal.proposalId,
    JSON.stringify(proposal),
    proposal.decidedAt,
  );
  db.prepare(
    `INSERT INTO paid_test_proposal_history (proposal_id, proposal_json, recorded_at)
     VALUES (?,?,?)`,
  ).run(proposal.proposalId, JSON.stringify(proposal), proposal.decidedAt);
  db.prepare("INSERT INTO paid_test_safety_state VALUES (?,?,?,?,?)").run(
    proposal.proposalId,
    1,
    1,
    1,
    proposal.decidedAt,
  );
  db.close();
}

describe("trusted paid-proposal tenant adoption", () => {
  it("preserves proposal history but clears every approval and safety authority across restart", () => {
    const path = databasePath("paid-adoption");
    createLegacyPaidDatabase(path);
    expect(() => createSqlitePaidTestStore(path)).toThrow(/explicit trusted adoption/i);
    const options = adoption([
      { legacyVentureId: "legacy-paid", organizationId: "org-paid", ventureId: "venture-paid" },
    ]);
    const store = createSqlitePaidTestStore(path, options);
    const scope = { organizationId: "org-paid", ventureId: "venture-paid" };
    const current = store.getProposal(scope, "proposal-shared")!;
    expect(current).toMatchObject({
      organizationId: "org-paid",
      ventureId: "venture-paid",
      status: "PROPOSED",
      decidedBy: null,
      decidedAt: null,
      approvalRef: null,
      decisionReason: "legacy_tenant_adoption_requires_reapproval",
    });
    expect(current.materialHash).toBe(hashMaterialTerms(current));
    const history = store.listProposalHistory(scope, current.proposalId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      status: "APPROVED",
      decidedBy: "legacy-human",
      approvalRef: "checkpoint:legacy-paid",
      organizationId: "org-paid",
      ventureId: "venture-paid",
    });
    expect(history[0]!.materialHash).toBe(hashMaterialTerms(history[0]!));
    expect(history[1]).toEqual(current);
    expect(store.getSafetyState(scope, current.proposalId)).toMatchObject({
      trackingHealthy: false,
      attributionHealthy: false,
      providerEligible: false,
    });
    expect(() =>
      store.getProposal(
        { organizationId: LEGACY_UNSCOPED_ORGANIZATION_ID, ventureId: "legacy-paid" },
        current.proposalId,
      ),
    ).toThrow(/sentinel/i);
    store.close();

    const reopened = createSqlitePaidTestStore(path);
    expect(reopened.getProposal(scope, current.proposalId)).toEqual(current);
    expect(reopened.listProposalHistory(scope, current.proposalId)).toEqual(history);
    reopened.close();
  });

  it("does not merge a sentinel proposal into an occupied tenant key", () => {
    const path = databasePath("paid-adoption-collision");
    createSqlitePaidTestStore(path).close();
    const legacy = approvedProposal("legacy-collision");
    const targetBase = {
      ...legacy,
      organizationId: "org-target",
      ventureId: "venture-target",
    };
    const target = { ...targetBase, materialHash: hashMaterialTerms(targetBase) };
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO paid_test_proposals
       (organization_id, venture_id, proposal_id, proposal_json, recorded_at)
       VALUES (?,?,?,?,?)`,
    );
    insert.run(
      target.organizationId,
      target.ventureId,
      target.proposalId,
      JSON.stringify(target),
      target.decidedAt,
    );
    insert.run(
      LEGACY_UNSCOPED_ORGANIZATION_ID,
      legacy.ventureId,
      legacy.proposalId,
      JSON.stringify(legacy),
      legacy.decidedAt,
    );
    db.close();

    expect(() =>
      createSqlitePaidTestStore(
        path,
        adoption([
          {
            legacyVentureId: legacy.ventureId,
            organizationId: target.organizationId,
            ventureId: target.ventureId,
          },
        ]),
      ),
    ).toThrow(/collides/i);
    const readback = new DatabaseSync(path);
    expect(
      readback
        .prepare("SELECT COUNT(*) AS count FROM paid_test_proposals WHERE proposal_id = ?")
        .get(target.proposalId),
    ).toEqual({ count: 2 });
    readback.close();
  });

  it("adopts identical sentinel proposal IDs into two separately owned organizations", () => {
    const path = databasePath("paid-sentinel-two-owner");
    createSqlitePaidTestStore(path).close();
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      `INSERT INTO paid_test_proposals
       (organization_id, venture_id, proposal_id, proposal_json, recorded_at)
       VALUES (?,?,?,?,?)`,
    );
    for (const ventureId of ["legacy-a", "legacy-b"]) {
      const proposal = approvedProposal(ventureId);
      insert.run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
        ventureId,
        proposal.proposalId,
        JSON.stringify(proposal),
        proposal.decidedAt,
      );
    }
    db.close();

    const store = createSqlitePaidTestStore(
      path,
      adoption([
        { legacyVentureId: "legacy-a", organizationId: "owner-a", ventureId: "venture" },
        { legacyVentureId: "legacy-b", organizationId: "owner-b", ventureId: "venture" },
      ]),
    );
    for (const organizationId of ["owner-a", "owner-b"]) {
      const scope = { organizationId, ventureId: "venture" };
      expect(store.getProposal(scope, "proposal-shared")).toMatchObject({
        organizationId,
        ventureId: "venture",
        status: "PROPOSED",
        approvalRef: null,
      });
      expect(store.listProposalHistory(scope, "proposal-shared")).toHaveLength(1);
    }
    expect(
      store.getProposal({ organizationId: "owner-a", ventureId: "venture" }, "proposal-shared"),
    ).not.toEqual(
      store.getProposal({ organizationId: "owner-b", ventureId: "venture" }, "proposal-shared"),
    );
    store.close();
  });
});
