# Executable database migrations

Apply files in numeric order. The Neon provider resolves
`inputs.databaseCredentialRef` through the credential broker and exposes the
connection string only as `PGDATABASE` in the child `psql` process. The value
never belongs in Git, argv, a plan, or an evidence artifact:

```sh
psql --no-psqlrc --set=ON_ERROR_STOP=1 --file migrations/sql/001_core_evidence.up.sql
```

The forward migration is additive and idempotent. The Neon provider must read
back `vh_schema_migrations`, table names, constraints, and a disposable
read/write probe before reporting the schema verified.

Rollback is deliberately fail-closed:

```sh
psql --no-psqlrc --set=ON_ERROR_STOP=1 --file migrations/sql/001_core_evidence.down.sql
```

It drops the v0.2 tables only when every managed evidence table is empty. If
evidence exists, PostgreSQL error `55000` aborts the transaction without
changing schema or data. Export and explicitly archive/delete evidence before
retrying; do not weaken or bypass the guard. A provider snapshot/branch remains
the preferred recovery path for a database with real evidence.

These SQL files are the executable source of truth. Prose schema examples are
not a substitute for applying and reading back the migrations.
