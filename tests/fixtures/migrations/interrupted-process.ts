import {
  createSqliteMigrationRunner,
  type DurableMigration,
} from "../../../packages/migrations/src";

const filename = process.argv[2];
if (!filename) throw new Error("migration database path is required");

const migration: DurableMigration = {
  stream: { kind: "core" },
  id: "001-process-crash",
  checksumMaterial: "CREATE TABLE process_crash_proof (id TEXT PRIMARY KEY) STRICT",
  recovery: {
    mode: "transaction_rollback",
    note: "The operating system closes the uncommitted SQLite transaction on process exit.",
  },
  apply(context) {
    context.exec("CREATE TABLE process_crash_proof (id TEXT PRIMARY KEY) STRICT");
    process.exit(73);
  },
  verify: () => ({
    passed: false,
    schemaVersion: "never-reached",
    evidence: null,
  }),
};

createSqliteMigrationRunner(filename).apply([migration]);
