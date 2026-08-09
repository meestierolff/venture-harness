import {
  createSqliteMigrationRunner,
  type DurableMigration,
} from "../../../packages/migrations/src";

const filename = process.argv[2];
if (!filename) throw new Error("migration database path is required");

const migration: DurableMigration = {
  stream: { kind: "core" },
  id: "001-concurrent-apply",
  checksumMaterial:
    "CREATE TABLE IF NOT EXISTS concurrent_apply_proof (invocation_id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT; INSERT one invocation",
  recovery: {
    mode: "transaction_rollback",
    note: "The SQLite write lock serializes competing migration owners.",
  },
  apply(context) {
    context.exec(
      "CREATE TABLE IF NOT EXISTS concurrent_apply_proof (invocation_id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT",
    );
    context.run("INSERT INTO concurrent_apply_proof DEFAULT VALUES");
  },
  verify(context) {
    const row = context.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM concurrent_apply_proof",
    );
    return {
      passed: row?.count === 1,
      schemaVersion: "concurrent@1",
      evidence: { invocation_count: row?.count ?? -1 },
    };
  },
};

const runner = createSqliteMigrationRunner(filename);
runner.apply([migration]);
runner.close();
