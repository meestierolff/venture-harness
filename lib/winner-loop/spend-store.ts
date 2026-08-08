import { createRequire } from "node:module";

/** Loaded lazily: node:sqlite needs Node >= 22.5, but the rest of Winner Loop
 * runs on the Node >= 20.9 the package declares. Only callers that ask for the
 * SQLite store pay that requirement. */
function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  try {
    return createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
  } catch (error) {
    throw new Error(
      `the SQLite spend store requires Node >= 22.5 (node:sqlite unavailable): ${(error as Error).message}`,
    );
  }
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * The transactional boundary for spend.
 *
 * Correctness here cannot come from JavaScript being single-threaded. Reservations
 * are taken by multiple workers, queue consumers, reconciliation jobs, and
 * serverless instances that share nothing but the database, so the cap check and
 * the reservation write must commit or fail together inside one serialized
 * transaction. The SQLite store uses BEGIN IMMEDIATE, which takes the write lock
 * up front and forces concurrent writers to serialize instead of both reading
 * stale headroom.
 */

export interface StoredGrant {
  grantId: string;
  ventureId: string;
  customerId: string | null;
  network: string;
  externalAccountId: string;
  currency: string;
  totalMinorUnits: number;
  perCreativeMinorUnits: number;
  perPaidTestMinorUnits: number;
  perCampaignMinorUnits: number;
  dailyAccountMinorUnits: number;
  dailyVentureMinorUnits: number;
  monthlyVentureMinorUnits: number;
  allowedCreativeIds: readonly string[];
  approvedBy: string;
  approvalRef: string;
  proposalId: string;
  notBefore: string;
  expiresAt: string;
  grantHash: string;
  issuedAt: string;
}

export interface StoredReservation {
  reservationId: string;
  idempotencyKey: string;
  grantId: string;
  ventureId: string;
  creativeId: string;
  paidTestId: string;
  campaignId: string;
  externalAccountId: string;
  heldMinorUnits: number;
  settledMinorUnits: number | null;
  status: "held" | "settled" | "released";
  dayKey: string;
  monthKey: string;
  createdAt: string;
}

export interface StoredIncident {
  incidentId: string;
  grantId: string;
  kind: string;
  detail: string;
  recordedAt: string;
}

export interface CapUsage {
  grantTotal: number;
  perCreative: number;
  perPaidTest: number;
  perCampaign: number;
  dailyAccount: number;
  dailyVenture: number;
  monthlyVenture: number;
}

export interface ReservationRequest {
  reservationId: string;
  idempotencyKey: string;
  grantId: string;
  creativeId: string;
  paidTestId: string;
  campaignId: string;
  amountMinorUnits: number;
  dayKey: string;
  monthKey: string;
  createdAt: string;
}

export type ReservationOutcome =
  | { kind: "created"; reservation: StoredReservation }
  | { kind: "idempotent_replay"; reservation: StoredReservation }
  | { kind: "cap_exceeded"; cap: keyof CapUsage; attempted: number; limit: number }
  | { kind: "halted"; reason: string };

export interface SpendStore {
  readonly label: string;
  readonly productionSafe: boolean;
  putGrant(grant: StoredGrant): void;
  getGrant(grantId: string): StoredGrant | undefined;
  /** Atomically evaluates every cap and writes the reservation, or writes nothing. */
  reserveAtomically(request: ReservationRequest): ReservationOutcome;
  settle(reservationId: string, settledMinorUnits: number): StoredReservation | undefined;
  release(reservationId: string): StoredReservation | undefined;
  getReservation(reservationId: string): StoredReservation | undefined;
  listReservations(grantId: string): readonly StoredReservation[];
  halt(grantId: string, reason: string): void;
  haltReason(grantId: string): string | undefined;
  recordIncident(incident: StoredIncident): void;
  listIncidents(grantId: string): readonly StoredIncident[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_grants (
  grant_id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL,
  customer_id TEXT,
  network TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  per_creative_minor INTEGER NOT NULL,
  per_paid_test_minor INTEGER NOT NULL,
  per_campaign_minor INTEGER NOT NULL,
  daily_account_minor INTEGER NOT NULL,
  daily_venture_minor INTEGER NOT NULL,
  monthly_venture_minor INTEGER NOT NULL,
  allowed_creative_ids TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approval_ref TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  halted_reason TEXT
);
CREATE TABLE IF NOT EXISTS spend_reservations (
  reservation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL REFERENCES spend_grants(grant_id),
  venture_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  paid_test_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  held_minor INTEGER NOT NULL,
  settled_minor INTEGER,
  status TEXT NOT NULL,
  day_key TEXT NOT NULL,
  month_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_res_grant ON spend_reservations(grant_id, status);
CREATE INDEX IF NOT EXISTS spend_res_day ON spend_reservations(external_account_id, day_key);
CREATE TABLE IF NOT EXISTS spend_incidents (
  incident_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
`;

function rowToGrant(row: Record<string, unknown>): StoredGrant {
  return {
    grantId: row.grant_id as string,
    ventureId: row.venture_id as string,
    customerId: (row.customer_id as string | null) ?? null,
    network: row.network as string,
    externalAccountId: row.external_account_id as string,
    currency: row.currency as string,
    totalMinorUnits: Number(row.total_minor),
    perCreativeMinorUnits: Number(row.per_creative_minor),
    perPaidTestMinorUnits: Number(row.per_paid_test_minor),
    perCampaignMinorUnits: Number(row.per_campaign_minor),
    dailyAccountMinorUnits: Number(row.daily_account_minor),
    dailyVentureMinorUnits: Number(row.daily_venture_minor),
    monthlyVentureMinorUnits: Number(row.monthly_venture_minor),
    allowedCreativeIds: JSON.parse(row.allowed_creative_ids as string) as string[],
    approvedBy: row.approved_by as string,
    approvalRef: row.approval_ref as string,
    proposalId: row.proposal_id as string,
    notBefore: row.not_before as string,
    expiresAt: row.expires_at as string,
    grantHash: row.grant_hash as string,
    issuedAt: row.issued_at as string,
  };
}

function rowToReservation(row: Record<string, unknown>): StoredReservation {
  return {
    reservationId: row.reservation_id as string,
    idempotencyKey: row.idempotency_key as string,
    grantId: row.grant_id as string,
    ventureId: row.venture_id as string,
    creativeId: row.creative_id as string,
    paidTestId: row.paid_test_id as string,
    campaignId: row.campaign_id as string,
    externalAccountId: row.external_account_id as string,
    heldMinorUnits: Number(row.held_minor),
    settledMinorUnits: row.settled_minor === null ? null : Number(row.settled_minor),
    status: row.status as StoredReservation["status"],
    dayKey: row.day_key as string,
    monthKey: row.month_key as string,
    createdAt: row.created_at as string,
  };
}

/**
 * Production-capable local store. Multiple processes may open the same file;
 * BEGIN IMMEDIATE plus busy_timeout serializes their writes.
 */
export function createSqliteSpendStore(filename: string): SpendStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  function grantRow(grantId: string): Record<string, unknown> | undefined {
    return db.prepare("SELECT * FROM spend_grants WHERE grant_id = ?").get(grantId) as
      Record<string, unknown> | undefined;
  }

  /** Committed plus held: promised money constrains a cap exactly as hard as spent money. */
  function consumed(where: string, params: unknown[]): number {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN settled_minor ELSE held_minor END), 0) AS total
         FROM spend_reservations WHERE status != 'released' AND ${where}`,
      )
      .get(...(params as never[])) as { total: number };
    return Number(row.total);
  }

  return {
    label: "sqlite",
    productionSafe: true,

    putGrant(grant) {
      db.prepare(
        `INSERT INTO spend_grants (
          grant_id, venture_id, customer_id, network, external_account_id, currency,
          total_minor, per_creative_minor, per_paid_test_minor, per_campaign_minor,
          daily_account_minor, daily_venture_minor, monthly_venture_minor,
          allowed_creative_ids, approved_by, approval_ref, proposal_id,
          not_before, expires_at, grant_hash, issued_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        grant.grantId,
        grant.ventureId,
        grant.customerId,
        grant.network,
        grant.externalAccountId,
        grant.currency,
        grant.totalMinorUnits,
        grant.perCreativeMinorUnits,
        grant.perPaidTestMinorUnits,
        grant.perCampaignMinorUnits,
        grant.dailyAccountMinorUnits,
        grant.dailyVentureMinorUnits,
        grant.monthlyVentureMinorUnits,
        JSON.stringify(grant.allowedCreativeIds),
        grant.approvedBy,
        grant.approvalRef,
        grant.proposalId,
        grant.notBefore,
        grant.expiresAt,
        grant.grantHash,
        grant.issuedAt,
      );
    },

    getGrant(grantId) {
      const row = grantRow(grantId);
      return row ? rowToGrant(row) : undefined;
    },

    reserveAtomically(request) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = grantRow(request.grantId);
        if (!row) throw new Error(`unknown grant ${request.grantId}`);
        const grant = rowToGrant(row);
        const halted = row.halted_reason as string | null;
        if (halted) {
          db.exec("ROLLBACK");
          return { kind: "halted", reason: halted };
        }

        const replay = db
          .prepare("SELECT * FROM spend_reservations WHERE idempotency_key = ?")
          .get(request.idempotencyKey) as Record<string, unknown> | undefined;
        if (replay) {
          db.exec("ROLLBACK");
          return { kind: "idempotent_replay", reservation: rowToReservation(replay) };
        }

        const amount = request.amountMinorUnits;
        const checks: Array<{ cap: keyof CapUsage; used: number; limit: number }> = [
          {
            cap: "grantTotal",
            used: consumed("grant_id = ?", [request.grantId]),
            limit: grant.totalMinorUnits,
          },
          {
            cap: "monthlyVenture",
            used: consumed("venture_id = ? AND month_key = ?", [grant.ventureId, request.monthKey]),
            limit: grant.monthlyVentureMinorUnits,
          },
          {
            cap: "dailyVenture",
            used: consumed("venture_id = ? AND day_key = ?", [grant.ventureId, request.dayKey]),
            limit: grant.dailyVentureMinorUnits,
          },
          {
            cap: "dailyAccount",
            used: consumed("external_account_id = ? AND day_key = ?", [
              grant.externalAccountId,
              request.dayKey,
            ]),
            limit: grant.dailyAccountMinorUnits,
          },
          {
            cap: "perCampaign",
            used: consumed("grant_id = ? AND campaign_id = ?", [
              request.grantId,
              request.campaignId,
            ]),
            limit: grant.perCampaignMinorUnits,
          },
          {
            cap: "perPaidTest",
            used: consumed("grant_id = ? AND paid_test_id = ?", [
              request.grantId,
              request.paidTestId,
            ]),
            limit: grant.perPaidTestMinorUnits,
          },
          {
            cap: "perCreative",
            used: consumed("grant_id = ? AND creative_id = ?", [
              request.grantId,
              request.creativeId,
            ]),
            limit: grant.perCreativeMinorUnits,
          },
        ];

        for (const check of checks) {
          if (check.used + amount > check.limit) {
            db.exec("ROLLBACK");
            return {
              kind: "cap_exceeded",
              cap: check.cap,
              attempted: check.used + amount,
              limit: check.limit,
            };
          }
        }

        db.prepare(
          `INSERT INTO spend_reservations (
            reservation_id, idempotency_key, grant_id, venture_id, creative_id,
            paid_test_id, campaign_id, external_account_id, held_minor, settled_minor,
            status, day_key, month_key, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,NULL,'held',?,?,?)`,
        ).run(
          request.reservationId,
          request.idempotencyKey,
          request.grantId,
          grant.ventureId,
          request.creativeId,
          request.paidTestId,
          request.campaignId,
          grant.externalAccountId,
          amount,
          request.dayKey,
          request.monthKey,
          request.createdAt,
        );
        db.exec("COMMIT");

        return {
          kind: "created",
          reservation: rowToReservation(
            db
              .prepare("SELECT * FROM spend_reservations WHERE reservation_id = ?")
              .get(request.reservationId) as Record<string, unknown>,
          ),
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },

    settle(reservationId, settledMinorUnits) {
      db.prepare(
        "UPDATE spend_reservations SET status = 'settled', settled_minor = ? WHERE reservation_id = ? AND status = 'held'",
      ).run(settledMinorUnits, reservationId);
      return this.getReservation(reservationId);
    },

    release(reservationId) {
      db.prepare(
        "UPDATE spend_reservations SET status = 'released' WHERE reservation_id = ? AND status = 'held'",
      ).run(reservationId);
      return this.getReservation(reservationId);
    },

    getReservation(reservationId) {
      const row = db
        .prepare("SELECT * FROM spend_reservations WHERE reservation_id = ?")
        .get(reservationId) as Record<string, unknown> | undefined;
      return row ? rowToReservation(row) : undefined;
    },

    listReservations(grantId) {
      return (
        db
          .prepare("SELECT * FROM spend_reservations WHERE grant_id = ? ORDER BY created_at")
          .all(grantId) as Record<string, unknown>[]
      ).map(rowToReservation);
    },

    halt(grantId, reason) {
      db.prepare("UPDATE spend_grants SET halted_reason = ? WHERE grant_id = ?").run(
        reason,
        grantId,
      );
    },

    haltReason(grantId) {
      return (grantRow(grantId)?.halted_reason as string | null) ?? undefined;
    },

    recordIncident(incident) {
      db.prepare(
        "INSERT OR REPLACE INTO spend_incidents (incident_id, grant_id, kind, detail, recorded_at) VALUES (?,?,?,?,?)",
      ).run(
        incident.incidentId,
        incident.grantId,
        incident.kind,
        incident.detail,
        incident.recordedAt,
      );
    },

    listIncidents(grantId) {
      return (
        db
          .prepare("SELECT * FROM spend_incidents WHERE grant_id = ? ORDER BY recorded_at")
          .all(grantId) as Record<string, unknown>[]
      ).map((row) => ({
        incidentId: row.incident_id as string,
        grantId: row.grant_id as string,
        kind: row.kind as string,
        detail: row.detail as string,
        recordedAt: row.recorded_at as string,
      }));
    },

    close() {
      db.close();
    },
  };
}

/**
 * Single-process store for unit tests and local fixtures. NOT production safe:
 * it cannot serialize writers in another process, which is exactly the hazard
 * the SQLite store exists to close.
 */
export function createMemorySpendStore(): SpendStore {
  const grants = new Map<string, StoredGrant>();
  const halted = new Map<string, string>();
  const reservations = new Map<string, StoredReservation>();
  const byIdempotency = new Map<string, string>();
  const incidents: StoredIncident[] = [];

  const consumed = (predicate: (entry: StoredReservation) => boolean): number =>
    [...reservations.values()]
      .filter((entry) => entry.status !== "released" && predicate(entry))
      .reduce(
        (sum, entry) =>
          sum +
          (entry.status === "settled" ? (entry.settledMinorUnits ?? 0) : entry.heldMinorUnits),
        0,
      );

  return {
    label: "memory (test only)",
    productionSafe: false,
    putGrant: (grant) => void grants.set(grant.grantId, grant),
    getGrant: (grantId) => grants.get(grantId),

    reserveAtomically(request) {
      const grant = grants.get(request.grantId);
      if (!grant) throw new Error(`unknown grant ${request.grantId}`);
      const haltedReason = halted.get(request.grantId);
      if (haltedReason) return { kind: "halted", reason: haltedReason };

      const replayId = byIdempotency.get(request.idempotencyKey);
      if (replayId) {
        return { kind: "idempotent_replay", reservation: reservations.get(replayId)! };
      }

      const amount = request.amountMinorUnits;
      const checks: Array<{ cap: keyof CapUsage; used: number; limit: number }> = [
        {
          cap: "grantTotal",
          used: consumed((e) => e.grantId === request.grantId),
          limit: grant.totalMinorUnits,
        },
        {
          cap: "monthlyVenture",
          used: consumed((e) => e.ventureId === grant.ventureId && e.monthKey === request.monthKey),
          limit: grant.monthlyVentureMinorUnits,
        },
        {
          cap: "dailyVenture",
          used: consumed((e) => e.ventureId === grant.ventureId && e.dayKey === request.dayKey),
          limit: grant.dailyVentureMinorUnits,
        },
        {
          cap: "dailyAccount",
          used: consumed(
            (e) => e.externalAccountId === grant.externalAccountId && e.dayKey === request.dayKey,
          ),
          limit: grant.dailyAccountMinorUnits,
        },
        {
          cap: "perCampaign",
          used: consumed(
            (e) => e.grantId === request.grantId && e.campaignId === request.campaignId,
          ),
          limit: grant.perCampaignMinorUnits,
        },
        {
          cap: "perPaidTest",
          used: consumed(
            (e) => e.grantId === request.grantId && e.paidTestId === request.paidTestId,
          ),
          limit: grant.perPaidTestMinorUnits,
        },
        {
          cap: "perCreative",
          used: consumed(
            (e) => e.grantId === request.grantId && e.creativeId === request.creativeId,
          ),
          limit: grant.perCreativeMinorUnits,
        },
      ];

      for (const check of checks) {
        if (check.used + amount > check.limit) {
          return {
            kind: "cap_exceeded",
            cap: check.cap,
            attempted: check.used + amount,
            limit: check.limit,
          };
        }
      }

      const reservation: StoredReservation = {
        reservationId: request.reservationId,
        idempotencyKey: request.idempotencyKey,
        grantId: request.grantId,
        ventureId: grant.ventureId,
        creativeId: request.creativeId,
        paidTestId: request.paidTestId,
        campaignId: request.campaignId,
        externalAccountId: grant.externalAccountId,
        heldMinorUnits: amount,
        settledMinorUnits: null,
        status: "held",
        dayKey: request.dayKey,
        monthKey: request.monthKey,
        createdAt: request.createdAt,
      };
      reservations.set(reservation.reservationId, reservation);
      byIdempotency.set(request.idempotencyKey, reservation.reservationId);
      return { kind: "created", reservation };
    },

    settle(reservationId, settledMinorUnits) {
      const entry = reservations.get(reservationId);
      if (!entry || entry.status !== "held") return entry;
      const next = { ...entry, status: "settled" as const, settledMinorUnits };
      reservations.set(reservationId, next);
      return next;
    },

    release(reservationId) {
      const entry = reservations.get(reservationId);
      if (!entry || entry.status !== "held") return entry;
      const next = { ...entry, status: "released" as const };
      reservations.set(reservationId, next);
      return next;
    },

    getReservation: (reservationId) => reservations.get(reservationId),
    listReservations: (grantId) =>
      [...reservations.values()].filter((entry) => entry.grantId === grantId),
    halt: (grantId, reason) => void halted.set(grantId, reason),
    haltReason: (grantId) => halted.get(grantId),
    recordIncident: (incident) => void incidents.push(incident),
    listIncidents: (grantId) => incidents.filter((entry) => entry.grantId === grantId),
    close: () => {},
  };
}
