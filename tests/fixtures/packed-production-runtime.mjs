import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createVentureRuntime } from "@venture-harness/agent-runtime";
import { SqliteAuditChain } from "@venture-harness/audit";
import { SqliteIdempotencyStore } from "@venture-harness/command-bus";
import { SqliteEventLog } from "@venture-harness/events";
import { SqliteMeteringSink } from "@venture-harness/telemetry";

function boundaryFailure(code, message) {
  return {
    status: "context_unavailable",
    providerInvoked: false,
    externalEffectOccurred: false,
    liveVerified: false,
    data: { diagnostic: { code, message, nextAction: "Configure the trusted fixture binding" } },
  };
}

export function createVhRuntime({ schemaVersion, stateDirectory }) {
  if (schemaVersion !== 1) throw new Error("unsupported runtime factory schema");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const operations = new DatabaseSync(join(stateDirectory, "provider-operations.sqlite"));
  operations.exec("PRAGMA journal_mode = WAL");
  operations.exec(`
    CREATE TABLE IF NOT EXISTS fixture_operations (
      kind TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      venture_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_json TEXT NOT NULL,
      PRIMARY KEY (kind, organization_id, venture_id, operation_id)
    )
  `);
  const put = (kind, organizationId, ventureId, operationId, request) => {
    operations
      .prepare(
        `INSERT OR IGNORE INTO fixture_operations
           (kind, organization_id, venture_id, operation_id, request_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(kind, organizationId, ventureId, operationId, JSON.stringify(request));
  };
  const get = (kind, organizationId, ventureId, operationId) =>
    operations
      .prepare(
        `SELECT request_json FROM fixture_operations
          WHERE kind = ? AND organization_id = ? AND venture_id = ? AND operation_id = ?`,
      )
      .get(kind, organizationId, ventureId, operationId);
  const operationCount = (kind, organizationId, ventureId, operationId) =>
    Number(
      operations
        .prepare(
          `SELECT COUNT(*) AS count FROM fixture_operations
            WHERE kind = ? AND organization_id = ? AND venture_id = ? AND operation_id = ?`,
        )
        .get(kind, organizationId, ventureId, operationId).count,
    );

  const providerCommandRuntime = {
    async execute(action, input, invocation) {
      if (
        input.organizationId !== invocation.context.tenant.organizationId ||
        input.providerAccountId === "missing-account"
      ) {
        return boundaryFailure(
          "fixture_credential_reference_missing",
          "The trusted runtime has no credential reference for this account",
        );
      }
      if (!("operationId" in input)) {
        return boundaryFailure("fixture_operation_missing", "An immutable operation is required");
      }
      if (action === "apply") {
        put(
          "provider",
          input.organizationId,
          invocation.context.tenant.ventureId,
          input.operationId,
          input,
        );
        return {
          status: "accepted_unverified",
          providerInvoked: true,
          externalEffectOccurred: true,
          liveVerified: false,
          data: {
            evidenceClass: "fixture",
            transportKind: "official_api",
            fixtureOfficialTransport: true,
          },
        };
      }
      if (action === "read_back") {
        const stored = get(
          "provider",
          input.organizationId,
          invocation.context.tenant.ventureId,
          input.operationId,
        );
        if (!stored)
          return boundaryFailure("fixture_operation_not_found", "No apply record exists");
        return {
          status: "verified_fixture",
          providerInvoked: true,
          externalEffectOccurred: false,
          liveVerified: false,
          data: { evidenceClass: "fixture", matched: true, reapplied: false },
        };
      }
      return {
        status: action === "plan" ? "planned" : "fixture_ready",
        providerInvoked: false,
        externalEffectOccurred: false,
        liveVerified: false,
        data: { evidenceClass: "fixture" },
      };
    },
  };

  const stackCommandRuntime = {
    catalog: [
      {
        profileId: "packed-fixture",
        profileVersion: "0.2.0",
        label: "Packed fake official fixture",
        verification: "local_contract_only",
        implementationConfigured: true,
        credentialState: "host_managed",
        liveVerification: "pending",
        providerEffectsConfigured: true,
        bindings: {
          "hosting.web.deploy": { providerId: "vercel", capability: "deployment" },
        },
      },
    ],
    async execute(action, input, invocation) {
      if (input.providerId === "missing-provider") {
        return boundaryFailure(
          "fixture_stack_binding_missing",
          "The trusted runtime has no configured Stack binding",
        );
      }
      if (!("operationId" in input)) {
        return boundaryFailure("fixture_operation_missing", "An immutable operation is required");
      }
      const organizationId = invocation.context.tenant.organizationId;
      const ventureId = invocation.context.tenant.ventureId;
      if (action === "apply") {
        put("stack", organizationId, ventureId, input.operationId, input);
        return {
          status: "applied_unverified",
          providerInvoked: true,
          externalEffectOccurred: true,
          liveVerified: false,
          data: {
            evidenceClass: "fixture",
            transportKind: "official_api",
            fixtureOfficialTransport: true,
          },
        };
      }
      if (action === "read_back") {
        const stored = get("stack", organizationId, ventureId, input.operationId);
        if (!stored)
          return boundaryFailure("fixture_operation_not_found", "No apply record exists");
        return {
          status: "verified_fixture",
          providerInvoked: true,
          externalEffectOccurred: false,
          liveVerified: false,
          data: { evidenceClass: "fixture", matched: true, reapplied: false },
        };
      }
      return {
        status: action === "plan" ? "planned" : "fixture_ready",
        providerInvoked: false,
        externalEffectOccurred: false,
        liveVerified: false,
        data: { evidenceClass: "fixture" },
      };
    },
  };

  const authCommandRuntime = {
    async execute(action, input, invocation) {
      const organizationId = invocation.context.tenant.organizationId;
      const ventureId = invocation.context.tenant.ventureId;
      const providerId = input.providerId ?? "all";
      if (providerId === "missing-provider") {
        return boundaryFailure(
          "fixture_auth_binding_missing",
          "The trusted runtime has no configured credential binding",
        );
      }
      const operationId = `${action}:${providerId}:${invocation.idempotencyKey}`;
      if (["login", "test", "revoke"].includes(action)) {
        put("auth", organizationId, ventureId, operationId, {
          action,
          providerId,
          credentialRef: input.credentialRef ?? null,
        });
      }
      return {
        status: action === "status" ? "available" : `${action}_completed`,
        effect: action === "status" ? "none" : "applied",
        data: {
          providerId,
          credentialRef: input.credentialRef ?? `cred://${providerId}/fixture`,
          valuesExposed: false,
          fixture: true,
          operationCount:
            action === "status"
              ? 0
              : operationCount("auth", organizationId, ventureId, operationId),
        },
      };
    },
  };

  const upgradeCommandRuntime = {
    async execute(action, input, invocation) {
      const organizationId = invocation.context.tenant.organizationId;
      const ventureId = invocation.context.tenant.ventureId;
      if (action === "status") {
        return {
          status: "available",
          effect: "none",
          data: { currentVersion: "0.2.0", fixture: true },
        };
      }
      if (input.releaseLocator === "missing-release") {
        return {
          status: "blocked",
          effect: "none",
          data: {
            diagnostic: {
              code: "fixture_release_missing",
              message: "The trusted local release fixture is missing",
              nextAction: "Select the configured local fixture release",
            },
          },
        };
      }
      const operationId = `${action}:${input.releaseLocator}:${invocation.idempotencyKey}`;
      if (action === "apply") {
        put("upgrade", organizationId, ventureId, operationId, {
          releaseLocator: input.releaseLocator,
        });
      }
      return {
        status: action === "apply" ? "applied" : "planned",
        effect: action === "apply" ? "applied" : "none",
        data: {
          releaseLocator: input.releaseLocator,
          fixture: true,
          filesChanged: action === "apply" ? 1 : 0,
          applyCount:
            action === "apply"
              ? operationCount("upgrade", organizationId, ventureId, operationId)
              : 0,
        },
      };
    },
  };

  const fleetCommandRuntime = {
    async execute(action, input, invocation) {
      const organizationId = invocation.context.tenant.organizationId;
      const ventureId = invocation.context.tenant.ventureId;
      if (action === "status") {
        return {
          status: input.runId ? "available" : "run_required",
          effect: "none",
          data: { runId: input.runId ?? null, fixture: true },
        };
      }
      if (input.releaseId === "missing-release") {
        return {
          status: "blocked",
          effect: "none",
          data: {
            diagnostic: {
              code: "fixture_fleet_release_missing",
              message: "The trusted Fleet release fixture is missing",
              nextAction: "Select the configured Fleet fixture release",
            },
          },
        };
      }
      const operationId = input.runId;
      if (action === "rollout" || action === "resume") {
        put("fleet", organizationId, ventureId, operationId, {
          releaseId: input.releaseId,
          ventureIds: input.ventureIds,
          batchSize: input.batchSize,
        });
      }
      return {
        status: action === "plan" ? "planned" : "completed",
        effect: action === "plan" ? "none" : "applied",
        data: {
          runId: input.runId,
          releaseId: input.releaseId,
          targets: input.ventureIds,
          fixture: true,
          hookApplyCount:
            action === "plan" ? 0 : operationCount("fleet", organizationId, ventureId, operationId),
        },
      };
    },
  };

  return createVentureRuntime({
    commandExecutionMode: "production",
    memberships: [
      {
        organizationId: "org-consumer",
        actorId: "operator-consumer",
        role: "operator",
        active: true,
      },
    ],
    commandIdempotencyStore: new SqliteIdempotencyStore(
      join(stateDirectory, "command-idempotency.sqlite"),
    ),
    audit: new SqliteAuditChain(join(stateDirectory, "command-audit.sqlite")),
    events: new SqliteEventLog(join(stateDirectory, "command-events.sqlite")),
    metering: new SqliteMeteringSink(join(stateDirectory, "command-metering.sqlite")),
    providerCommandRuntime,
    stackCommandRuntime,
    authCommandRuntime,
    upgradeCommandRuntime,
    fleetCommandRuntime,
  });
}
