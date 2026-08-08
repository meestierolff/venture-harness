# Neon

Use one Neon project per venture. The adapter exposes official CLI primitives for
project, optional branch, database and role resources. The built-in launch
composition can start from explicitly identified, read-back-verified resources or
create a project and capture its generated connection URI directly behind a
pre-registered writable credential reference.

## Plan

Confirm account, project/branch/database/role names, region and environment.
Register a writable `databaseCredentialRef` before creation. The command transport
extracts only `connection_uris[0].connection_uri`, stores it through the broker,
adds it to redaction, and never places it in argv, config, reports, or durable output.
Generated role passwords are not captured.

For an existing database, set `external_resource_ids.project_intent` to
`use_verified` and record `project_id`, `branch_id`, `database_name`, and
`database_credential_ref`. For new creation, set `project_intent: create`, an exact
region and project name, and the registered database credential reference. Missing,
wrong-provider, or read-only capture targets stop before the create command. A
project-only create result is not database completion; migration and read/write
health must still pass read-back.

## Schema gate

Apply only versioned executable SQL migrations. The harness v0.1→v0.2 migration
is a config migration; `migrations/sql/001_core_evidence.up.sql` is the separate,
idempotent evidence-schema migration. If the child has no applicable database
migration files, leave database capability unverified and report the gap—never
paste a schema from documentation.

## Verify

Read back project, branch, database and role metadata, then use the brokered
connection to run a non-secret connectivity and read/write health check. Verify
the migration ledger and expected schema version. Do not include a connection
string in evidence.

## Safety and rollback

Branch/database/role deletion and destructive schema changes are separate
checkpoints. Prefer a branch, forward migration or role rotation. Never delete
commercial evidence to make a rollback appear clean.
