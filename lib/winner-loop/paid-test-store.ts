import { createRequire } from "node:module";
import { hashMaterialTerms, type PaidTestProposal } from "./paid-test";
import {
  LEGACY_UNSCOPED_ORGANIZATION_ID,
  adoptLegacyTenantPayload,
  assertAddressableTenantScope,
  resolveLegacyTenantAdoptions,
  type LegacyAdoptionOptions,
  type LegacyTenantTarget,
} from "./legacy-adoption";

export interface PaidSafetyState {
  organizationId: string;
  ventureId: string;
  proposalId: string;
  trackingHealthy: boolean;
  attributionHealthy: boolean;
  providerEligible: boolean;
  recordedAt: string;
}

export interface PaidProposalScope {
  organizationId: string;
  ventureId: string;
}

export interface PaidTestStore {
  readonly label: string;
  readonly durable: boolean;
  putProposal(proposal: PaidTestProposal): void;
  getProposal(scope: PaidProposalScope, proposalId: string): PaidTestProposal | undefined;
  listProposals(scope: PaidProposalScope): readonly PaidTestProposal[];
  listProposalHistory(scope: PaidProposalScope, proposalId: string): readonly PaidTestProposal[];
  putSafetyState(state: PaidSafetyState): void;
  getSafetyState(scope: PaidProposalScope, proposalId: string): PaidSafetyState | undefined;
  close(): void;
}

function assertPaidScope(scope: PaidProposalScope): void {
  assertAddressableTenantScope(scope, "paid-test store");
}

function assertProposalIntegrity(proposal: PaidTestProposal): void {
  assertPaidScope(proposal);
  if (proposal.materialHash !== hashMaterialTerms(proposal)) {
    throw new Error(
      `paid-test proposal ${proposal.proposalId} failed its material integrity check`,
    );
  }
}

function freezeProposal(proposal: PaidTestProposal): PaidTestProposal {
  return Object.freeze({
    ...proposal,
    geographies: Object.freeze([...proposal.geographies]),
    audienceConstraints: Object.freeze([...proposal.audienceConstraints]),
    evidence: Object.freeze([...proposal.evidence]),
  });
}

export function createMemoryPaidTestStore(): PaidTestStore {
  const current = new Map<string, PaidTestProposal>();
  const histories = new Map<string, PaidTestProposal[]>();
  const safety = new Map<string, PaidSafetyState>();
  const key = (scope: PaidProposalScope, proposalId: string) => {
    assertPaidScope(scope);
    return JSON.stringify([scope.organizationId, scope.ventureId, proposalId]);
  };
  return {
    label: "memory (test only)",
    durable: false,
    putProposal(proposal) {
      assertProposalIntegrity(proposal);
      const frozen = freezeProposal(proposal);
      const scopedKey = key(proposal, proposal.proposalId);
      current.set(scopedKey, frozen);
      histories.set(scopedKey, [...(histories.get(scopedKey) ?? []), frozen]);
    },
    getProposal: (scope, proposalId) => current.get(key(scope, proposalId)),
    listProposals: (scope) => (
      assertPaidScope(scope),
      Object.freeze(
        [...current.values()].filter(
          (proposal) =>
            proposal.organizationId === scope.organizationId &&
            proposal.ventureId === scope.ventureId,
        ),
      )
    ),
    listProposalHistory: (scope, proposalId) =>
      Object.freeze([...(histories.get(key(scope, proposalId)) ?? [])]),
    putSafetyState(state) {
      assertPaidScope(state);
      safety.set(key(state, state.proposalId), Object.freeze({ ...state }));
    },
    getSafetyState: (scope, proposalId) => safety.get(key(scope, proposalId)),
    close() {},
  };
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

function loadSqlite(): { DatabaseSync: new (path: string) => SqliteDatabase } {
  try {
    return createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
  } catch (error) {
    throw new Error(`paid-test SQLite store unavailable: ${(error as Error).message}`);
  }
}

const PAID_TEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS paid_test_proposal_history (
  record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paid_test_history_by_proposal
  ON paid_test_proposal_history(organization_id, venture_id, proposal_id, record_id);
CREATE TABLE IF NOT EXISTS paid_test_proposals (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, proposal_id)
);
CREATE TABLE IF NOT EXISTS paid_test_safety_state (
  organization_id TEXT NOT NULL,
  venture_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  tracking_healthy INTEGER NOT NULL,
  attribution_healthy INTEGER NOT NULL,
  provider_eligible INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, venture_id, proposal_id),
  FOREIGN KEY (organization_id, venture_id, proposal_id)
    REFERENCES paid_test_proposals(organization_id, venture_id, proposal_id)
);
`;

function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (entry) => entry.name === column,
  );
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

interface LegacyPaidRows {
  current: readonly Record<string, unknown>[];
  history: readonly Record<string, unknown>[];
  safety: readonly Record<string, unknown>[];
}

const LEGACY_REAPPROVAL_REASON = "legacy_tenant_adoption_requires_reapproval";

function paidLegacyVenture(
  row: Record<string, unknown>,
  current: readonly Record<string, unknown>[],
): string {
  if (typeof row.venture_id === "string" && row.venture_id.length > 0) return row.venture_id;
  if (typeof row.proposal_json === "string") {
    const parsed = JSON.parse(row.proposal_json) as { ventureId?: unknown };
    if (typeof parsed.ventureId === "string" && parsed.ventureId.length > 0) {
      return parsed.ventureId;
    }
  }
  const owners = current.filter((candidate) => candidate.proposal_id === row.proposal_id);
  if (owners.length !== 1) {
    throw new Error(`legacy paid-test row ${String(row.proposal_id)} has ambiguous ownership`);
  }
  return paidLegacyVenture(owners[0]!, current);
}

function adoptedHistoricalProposal(
  row: Record<string, unknown>,
  target: LegacyTenantTarget,
): PaidTestProposal {
  const adopted = adoptLegacyTenantPayload(
    JSON.parse(row.proposal_json as string) as PaidTestProposal,
    target,
  );
  return {
    ...adopted,
    materialHash: hashMaterialTerms(adopted),
  };
}

function reviewRequiredProposal(proposal: PaidTestProposal): PaidTestProposal {
  const reset = {
    ...proposal,
    status: "PROPOSED" as const,
    decidedBy: null,
    decidedAt: null,
    approvalRef: null,
    decisionReason: LEGACY_REAPPROVAL_REASON,
  };
  return { ...reset, materialHash: hashMaterialTerms(reset) };
}

function assertNoPaidAdoptionCollision(
  db: SqliteDatabase,
  target: LegacyTenantTarget,
  proposalId: string,
): void {
  for (const table of [
    "paid_test_proposals",
    "paid_test_proposal_history",
    "paid_test_safety_state",
  ]) {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table}
           WHERE organization_id = ? AND venture_id = ? AND proposal_id = ? LIMIT 1`,
        )
        .get(target.organizationId, target.ventureId, proposalId)
    ) {
      throw new Error(
        `legacy paid-test adoption collides with ${target.organizationId}/${target.ventureId}/${proposalId}`,
      );
    }
  }
}

function insertAdoptedPaidRows(
  db: SqliteDatabase,
  rows: LegacyPaidRows,
  adoption: ReadonlyMap<string, LegacyTenantTarget>,
  adoptedAt: string,
): void {
  const checkedTargets = new Set<string>();
  for (const row of [...rows.current, ...rows.history, ...rows.safety]) {
    const target = adoption.get(paidLegacyVenture(row, rows.current))!;
    const targetKey = JSON.stringify([target.organizationId, target.ventureId, row.proposal_id]);
    if (checkedTargets.has(targetKey)) continue;
    checkedTargets.add(targetKey);
    assertNoPaidAdoptionCollision(db, target, row.proposal_id as string);
  }
  const historyInsert = db.prepare(
    `INSERT INTO paid_test_proposal_history
     (organization_id, venture_id, proposal_id, proposal_json, recorded_at)
     VALUES (?,?,?,?,?)`,
  );
  for (const row of rows.history) {
    const target = adoption.get(paidLegacyVenture(row, rows.current))!;
    const proposal = adoptedHistoricalProposal(row, target);
    historyInsert.run(
      target.organizationId,
      target.ventureId,
      row.proposal_id,
      JSON.stringify(proposal),
      row.recorded_at,
    );
  }

  const currentInsert = db.prepare(
    `INSERT INTO paid_test_proposals
     (organization_id, venture_id, proposal_id, proposal_json, recorded_at)
     VALUES (?,?,?,?,?)`,
  );
  const safetyInsert = db.prepare(
    `INSERT INTO paid_test_safety_state
     (organization_id, venture_id, proposal_id, tracking_healthy,
      attribution_healthy, provider_eligible, recorded_at)
     VALUES (?,?,?,0,0,0,?)`,
  );
  for (const row of rows.current) {
    const target = adoption.get(paidLegacyVenture(row, rows.current))!;
    const historical = adoptedHistoricalProposal(row, target);
    const reset = reviewRequiredProposal(historical);
    currentInsert.run(
      target.organizationId,
      target.ventureId,
      row.proposal_id,
      JSON.stringify(reset),
      adoptedAt,
    );
    historyInsert.run(
      target.organizationId,
      target.ventureId,
      row.proposal_id,
      JSON.stringify(reset),
      adoptedAt,
    );
    safetyInsert.run(target.organizationId, target.ventureId, row.proposal_id, adoptedAt);
  }
  for (const row of rows.safety) {
    if (!rows.current.some((candidate) => candidate.proposal_id === row.proposal_id)) {
      throw new Error(`legacy paid-test safety row ${String(row.proposal_id)} has no proposal`);
    }
  }
}

function requiredPaidLegacyVentures(rows: LegacyPaidRows): readonly string[] {
  return [
    ...rows.current.map((row) => paidLegacyVenture(row, rows.current)),
    ...rows.history.map((row) => paidLegacyVenture(row, rows.current)),
    ...rows.safety.map((row) => paidLegacyVenture(row, rows.current)),
  ];
}

function migratePaidTestOrganizationScope(
  db: SqliteDatabase,
  options: LegacyAdoptionOptions,
): void {
  if (!hasTable(db, "paid_test_proposals")) return;
  const hasOrganization = hasColumn(db, "paid_test_proposals", "organization_id");
  const where = hasOrganization
    ? ` WHERE organization_id = '${LEGACY_UNSCOPED_ORGANIZATION_ID}'`
    : "";
  const rows: LegacyPaidRows = {
    current: db.prepare(`SELECT * FROM paid_test_proposals${where}`).all() as Record<
      string,
      unknown
    >[],
    history: hasTable(db, "paid_test_proposal_history")
      ? (db
          .prepare(`SELECT * FROM paid_test_proposal_history${where} ORDER BY record_id`)
          .all() as Record<string, unknown>[])
      : [],
    safety: hasTable(db, "paid_test_safety_state")
      ? (db.prepare(`SELECT * FROM paid_test_safety_state${where}`).all() as Record<
          string,
          unknown
        >[])
      : [],
  };
  const requiredLegacyVentureIds = requiredPaidLegacyVentures(rows);
  const adoption = resolveLegacyTenantAdoptions(
    !hasOrganization && requiredLegacyVentureIds.length === 0
      ? (options.legacyAdoption?.mappings.map((entry) => entry.legacyVentureId) ?? [
          "empty-legacy-paid-schema",
        ])
      : requiredLegacyVentureIds,
    options.legacyAdoption,
    "paid-test store",
  );
  if (
    hasOrganization &&
    rows.current.length === 0 &&
    rows.history.length === 0 &&
    rows.safety.length === 0
  ) {
    return;
  }

  if (hasOrganization) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(PAID_TEST_SCHEMA);
      insertAdoptedPaidRows(db, rows, adoption, options.legacyAdoption!.approvedAt);
      db.prepare("DELETE FROM paid_test_safety_state WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      db.prepare("DELETE FROM paid_test_proposals WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      db.prepare("DELETE FROM paid_test_proposal_history WHERE organization_id = ?").run(
        LEGACY_UNSCOPED_ORGANIZATION_ID,
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* transaction already closed */
      }
      throw error;
    }
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (hasTable(db, "paid_test_proposal_history")) {
      db.exec("ALTER TABLE paid_test_proposal_history RENAME TO paid_test_proposal_history_legacy");
    }
    db.exec("ALTER TABLE paid_test_proposals RENAME TO paid_test_proposals_legacy");
    if (hasTable(db, "paid_test_safety_state")) {
      db.exec("ALTER TABLE paid_test_safety_state RENAME TO paid_test_safety_state_legacy");
    }
    db.exec("DROP INDEX IF EXISTS paid_test_history_by_proposal");
    db.exec(PAID_TEST_SCHEMA);
    insertAdoptedPaidRows(db, rows, adoption, options.legacyAdoption!.approvedAt);
    if (hasTable(db, "paid_test_safety_state_legacy")) {
      db.exec("DROP TABLE paid_test_safety_state_legacy");
    }
    db.exec("DROP TABLE paid_test_proposals_legacy");
    if (hasTable(db, "paid_test_proposal_history_legacy")) {
      db.exec("DROP TABLE paid_test_proposal_history_legacy");
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already closed */
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function createSqlitePaidTestStore(
  filename: string,
  options: LegacyAdoptionOptions = {},
): PaidTestStore {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 5000");
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  if (journal.journal_mode.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL");
  try {
    migratePaidTestOrganizationScope(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec(PAID_TEST_SCHEMA);

  const parseProposal = (row: Record<string, unknown>): PaidTestProposal => {
    const proposal = JSON.parse(row.proposal_json as string) as PaidTestProposal;
    if (proposal.organizationId !== row.organization_id || proposal.ventureId !== row.venture_id) {
      throw new Error("stored paid-test proposal scope disagrees with its database key");
    }
    assertProposalIntegrity(proposal);
    return freezeProposal(proposal);
  };
  const parseSafety = (row: Record<string, unknown>): PaidSafetyState =>
    Object.freeze({
      organizationId: row.organization_id as string,
      ventureId: row.venture_id as string,
      proposalId: row.proposal_id as string,
      trackingHealthy: Number(row.tracking_healthy) === 1,
      attributionHealthy: Number(row.attribution_healthy) === 1,
      providerEligible: Number(row.provider_eligible) === 1,
      recordedAt: row.recorded_at as string,
    });

  return {
    label: "sqlite",
    durable: true,
    putProposal(proposal) {
      assertProposalIntegrity(proposal);
      const json = JSON.stringify(proposal);
      const recordedAt = proposal.decidedAt ?? proposal.createdAt;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO paid_test_proposal_history
           (organization_id, venture_id, proposal_id, proposal_json, recorded_at)
           VALUES (?,?,?,?,?)`,
        ).run(proposal.organizationId, proposal.ventureId, proposal.proposalId, json, recordedAt);
        db.prepare(
          `INSERT INTO paid_test_proposals
           (organization_id, venture_id, proposal_id, proposal_json, recorded_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(organization_id, venture_id, proposal_id) DO UPDATE SET
             proposal_json = excluded.proposal_json,
             recorded_at = excluded.recorded_at`,
        ).run(proposal.organizationId, proposal.ventureId, proposal.proposalId, json, recordedAt);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* transaction already closed */
        }
        throw error;
      }
    },
    getProposal(scope, proposalId) {
      assertPaidScope(scope);
      const row = db
        .prepare(
          `SELECT * FROM paid_test_proposals
           WHERE organization_id = ? AND venture_id = ? AND proposal_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, proposalId) as
        Record<string, unknown> | undefined;
      return row ? parseProposal(row) : undefined;
    },
    listProposals(scope) {
      assertPaidScope(scope);
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT * FROM paid_test_proposals
               WHERE organization_id = ? AND venture_id = ? ORDER BY recorded_at`,
            )
            .all(scope.organizationId, scope.ventureId) as Record<string, unknown>[]
        ).map(parseProposal),
      );
    },
    listProposalHistory(scope, proposalId) {
      assertPaidScope(scope);
      return Object.freeze(
        (
          db
            .prepare(
              `SELECT * FROM paid_test_proposal_history
               WHERE organization_id = ? AND venture_id = ? AND proposal_id = ?
               ORDER BY record_id`,
            )
            .all(scope.organizationId, scope.ventureId, proposalId) as Record<string, unknown>[]
        ).map(parseProposal),
      );
    },
    putSafetyState(state) {
      assertPaidScope(state);
      db.prepare(
        `INSERT INTO paid_test_safety_state
         (organization_id, venture_id, proposal_id, tracking_healthy,
          attribution_healthy, provider_eligible, recorded_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(organization_id, venture_id, proposal_id) DO UPDATE SET
           tracking_healthy = excluded.tracking_healthy,
           attribution_healthy = excluded.attribution_healthy,
           provider_eligible = excluded.provider_eligible,
           recorded_at = excluded.recorded_at`,
      ).run(
        state.organizationId,
        state.ventureId,
        state.proposalId,
        state.trackingHealthy ? 1 : 0,
        state.attributionHealthy ? 1 : 0,
        state.providerEligible ? 1 : 0,
        state.recordedAt,
      );
    },
    getSafetyState(scope, proposalId) {
      assertPaidScope(scope);
      const row = db
        .prepare(
          `SELECT * FROM paid_test_safety_state
           WHERE organization_id = ? AND venture_id = ? AND proposal_id = ?`,
        )
        .get(scope.organizationId, scope.ventureId, proposalId) as
        Record<string, unknown> | undefined;
      return row ? parseSafety(row) : undefined;
    },
    close() {
      db.close();
    },
  };
}
