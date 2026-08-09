import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AuthCommandAction,
  AuthCommandInput,
  AuthCommandRuntime,
  FleetCommandAction,
  FleetCommandInput,
  FleetCommandRuntime,
  FleetOperationInput,
  PlatformOperationBoundary,
  UpgradeCommandAction,
  UpgradeCommandInput,
  UpgradeCommandRuntime,
  UpgradeReleaseInput,
} from "../../packages/agent-runtime/src/platform-operations";
import type { CommandHandlerContext } from "@venture-harness/command-bus";
import type { JsonObject, JsonValue } from "@venture-harness/core";
import { loadHarnessLock } from "../config/harness-lock";
import type { CliAuthRequest, CliServices } from "./types";
import type { CoreReleaseManifest, FleetRunRecord, FleetStateStore, FleetVenture } from "../fleet";
import { fleetTargetKey } from "../fleet";

function jsonObject(value: JsonValue, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} returned a non-object result`);
  }
  return value as JsonObject;
}

function recordStatus(value: JsonObject, fallback: string): string {
  return typeof value.status === "string" ? value.status : fallback;
}

function diagnostic(code: string, message: string, nextAction: string): JsonObject {
  return { diagnostic: { code, message, nextAction } };
}

function authRequest(action: AuthCommandAction, input: AuthCommandInput): CliAuthRequest {
  const providerId = typeof input.providerId === "string" ? input.providerId : undefined;
  const credentialRef = typeof input.credentialRef === "string" ? input.credentialRef : undefined;
  return {
    action,
    ...(providerId ? { provider: providerId } : {}),
    ...(credentialRef ? { ref: credentialRef } : {}),
    ...(typeof input.backend === "string" ? { backend: input.backend } : {}),
    ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
    ...(Array.isArray(input.scopes) ? { scopes: input.scopes as string[] } : {}),
  };
}

/**
 * Exposes the existing credential broker/catalog/official-CLI service through
 * the canonical command runtime. Constructing this adapter alone has no
 * effect; the injected service is invoked only after CommandBus authorization.
 */
export function createAuthCommandRuntime(services: Pick<CliServices, "auth">): AuthCommandRuntime {
  return Object.freeze({
    async execute(
      action: AuthCommandAction,
      input: AuthCommandInput,
    ): Promise<PlatformOperationBoundary> {
      if (!services.auth) {
        return {
          status: "unconfigured",
          effect: "none",
          data: diagnostic(
            "auth_service_unconfigured",
            "The host credential service is not configured",
            "Inject createDefaultCliServices(...).auth into the trusted runtime module",
          ),
        };
      }
      const data = jsonObject(await services.auth(authRequest(action, input)), "auth service");
      return {
        status: recordStatus(data, action === "status" ? "available" : `${action}_completed`),
        effect: action === "status" ? "none" : "applied",
        data,
      };
    },
  });
}

export interface UpgradeCommandRuntimeOptions {
  services: Pick<CliServices, "upgrade">;
  rootDir: string;
}

/** Delegates trusted-local planning/apply to the existing transactional upgrade service. */
export function createUpgradeCommandRuntime(
  options: UpgradeCommandRuntimeOptions,
): UpgradeCommandRuntime {
  const root = resolve(options.rootDir);
  return Object.freeze({
    async execute(
      action: UpgradeCommandAction,
      input: UpgradeCommandInput,
    ): Promise<PlatformOperationBoundary> {
      if (action === "status") {
        const path = resolve(root, "harness.lock");
        if (!existsSync(path)) {
          return {
            status: "unlocked",
            effect: "none",
            data: {
              lockPresent: false,
              nextAction: "Plan a trusted local release before applying an upgrade",
            },
          };
        }
        const lock = loadHarnessLock(path);
        return {
          status: "available",
          effect: "none",
          data: {
            lockPresent: true,
            harnessVersion: lock.harness_version,
            configContractVersion: lock.config_contract_version,
            source: lock.source as JsonObject,
          },
        };
      }
      if (!options.services.upgrade) {
        return {
          status: "unconfigured",
          effect: "none",
          data: diagnostic(
            "upgrade_service_unconfigured",
            "The host upgrade service is not configured",
            "Inject createDefaultCliServices(...).upgrade into the trusted runtime module",
          ),
        };
      }
      const releaseLocator = (input as UpgradeReleaseInput).releaseLocator;
      const data = jsonObject(
        await options.services.upgrade({
          dryRun: action !== "apply",
          releasePath: releaseLocator,
        }),
        "upgrade service",
      );
      const status = recordStatus(data, action === "apply" ? "applied" : "planned");
      if (status === "blocked" || status === "failed") {
        const reportError =
          data.error && typeof data.error === "object" && !Array.isArray(data.error)
            ? (data.error as JsonObject)
            : null;
        const code =
          reportError && typeof reportError.code === "string"
            ? reportError.code
            : `upgrade_${status}`;
        const message =
          reportError && typeof reportError.message === "string"
            ? reportError.message
            : `Upgrade ${status}`;
        return {
          status,
          effect:
            action !== "apply" || status === "blocked" || data.rolledBack === true
              ? "none"
              : "unknown",
          data: {
            ...data,
            diagnostic: {
              code,
              message,
              nextAction:
                reportError && typeof reportError.nextAction === "string"
                  ? reportError.nextAction
                  : "Repair the reported local upgrade state before retrying",
            },
          },
        };
      }
      return {
        status,
        effect: action === "apply" && status === "applied" ? "applied" : "none",
        data: { ...data, requestedAction: action },
      };
    },
  });
}

export interface FleetControllerLike {
  rollout(input: {
    runId: string;
    release: CoreReleaseManifest;
    ventures: readonly FleetVenture[];
    batchSize: number;
  }): Promise<FleetRunRecord>;
}

export interface FleetCommandRuntimeOptions {
  store: FleetStateStore;
  controller: FleetControllerLike;
  resolveRelease(
    releaseId: string,
  ): Promise<CoreReleaseManifest | null> | CoreReleaseManifest | null;
  resolveVentures(
    ventureIds: readonly string[],
    context: CommandHandlerContext,
  ): Promise<readonly FleetVenture[]> | readonly FleetVenture[];
}

function runOrganizations(record: FleetRunRecord): Set<string> {
  return new Set([
    ...(record.canaryTarget ? [record.canaryTarget.organizationId] : []),
    ...record.batches.flatMap((batch) => batch.map(({ organizationId }) => organizationId)),
    ...record.results.map(({ organizationId }) => organizationId),
    ...Object.values(record.checkpoints).map(({ organizationId }) => organizationId),
  ]);
}

async function resolveFleetOperation(
  options: FleetCommandRuntimeOptions,
  input: FleetOperationInput,
  context: CommandHandlerContext,
): Promise<
  { release: CoreReleaseManifest; ventures: readonly FleetVenture[] } | PlatformOperationBoundary
> {
  const release = await options.resolveRelease(input.releaseId);
  if (!release) {
    return {
      status: "blocked",
      effect: "none",
      data: diagnostic(
        "fleet_release_not_found",
        `Trusted Fleet release ${input.releaseId} is not configured`,
        "Configure the exact local release in the trusted host runtime",
      ),
    };
  }
  const ventures = await options.resolveVentures(input.ventureIds, context);
  const requested = [...input.ventureIds].sort();
  const resolved = ventures.map(({ ventureId }) => ventureId).sort();
  if (
    requested.length !== resolved.length ||
    requested.some((ventureId, index) => ventureId !== resolved[index]) ||
    new Set(ventures.map(fleetTargetKey)).size !== ventures.length ||
    ventures.some(({ organizationId }) => organizationId !== context.context.tenant.organizationId)
  ) {
    return {
      status: "blocked",
      effect: "none",
      data: diagnostic(
        "fleet_target_scope_mismatch",
        "Resolved Fleet targets do not exactly match the authorized organization and venture IDs",
        "Use an organization-bound target resolver and request each venture exactly once",
      ),
    };
  }
  return { release, ventures };
}

/** Binds the existing durable Fleet controller to canonical command contracts. */
export function createFleetCommandRuntime(
  options: FleetCommandRuntimeOptions,
): FleetCommandRuntime {
  return Object.freeze({
    async execute(
      action: FleetCommandAction,
      input: FleetCommandInput,
      context: CommandHandlerContext,
    ): Promise<PlatformOperationBoundary> {
      if (action === "status") {
        const runId = typeof input.runId === "string" ? input.runId : undefined;
        if (!runId) {
          return {
            status: "run_required",
            effect: "none",
            data: { nextAction: "Supply the exact Fleet runId to inspect" },
          };
        }
        const record = options.store.get(runId);
        if (!record) return { status: "not_found", effect: "none", data: { runId } };
        const organizations = runOrganizations(record);
        if (organizations.size !== 1 || !organizations.has(context.context.tenant.organizationId)) {
          return {
            status: "blocked",
            effect: "none",
            data: diagnostic(
              "fleet_run_scope_mismatch",
              "Fleet run is outside the authorized organization",
              "Use a Command Grant and tenant context bound to the Fleet run organization",
            ),
          };
        }
        return {
          status: record.status,
          effect: "none",
          data: { run: record as unknown as JsonObject },
        };
      }

      const operation = input as FleetOperationInput;
      const resolved = await resolveFleetOperation(options, operation, context);
      if ("status" in resolved) return resolved;
      if (action === "plan") {
        const canary = resolved.ventures.find(({ canary }) => canary) ?? null;
        return {
          status: "planned",
          effect: "none",
          data: {
            runId: operation.runId,
            releaseId: operation.releaseId,
            releaseVersion: resolved.release.version,
            releaseDigest: resolved.release.digest,
            targetCount: resolved.ventures.length,
            targets: resolved.ventures.map(({ organizationId, ventureId }) => ({
              organizationId,
              ventureId,
            })),
            canary: canary
              ? { organizationId: canary.organizationId, ventureId: canary.ventureId }
              : null,
            batchSize: operation.batchSize,
            hooksInvoked: false,
          },
        };
      }
      const record = await options.controller.rollout({
        runId: operation.runId,
        release: resolved.release,
        ventures: resolved.ventures,
        batchSize: operation.batchSize,
      });
      return {
        status: record.status,
        effect:
          record.results.length > 0 || Object.keys(record.checkpoints).length > 0
            ? "applied"
            : "none",
        data: { run: record as unknown as JsonObject, requestedAction: action },
      };
    },
  });
}

export function createPlatformCommandRuntimes(options: {
  cliServices: Pick<CliServices, "auth" | "upgrade">;
  rootDir: string;
  fleet?: FleetCommandRuntimeOptions;
}): {
  authCommandRuntime: AuthCommandRuntime;
  upgradeCommandRuntime: UpgradeCommandRuntime;
  fleetCommandRuntime?: FleetCommandRuntime;
} {
  return {
    authCommandRuntime: createAuthCommandRuntime(options.cliServices),
    upgradeCommandRuntime: createUpgradeCommandRuntime({
      services: options.cliServices,
      rootDir: options.rootDir,
    }),
    ...(options.fleet ? { fleetCommandRuntime: createFleetCommandRuntime(options.fleet) } : {}),
  };
}
