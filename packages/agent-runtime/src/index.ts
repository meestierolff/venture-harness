import { InMemoryAuditChain, type AuditSink } from "@venture-harness/audit";
import { assertActiveSubscription } from "@venture-harness/billing";
import {
  CommandBus,
  InMemoryIdempotencyStore,
  type AnyCommandContract,
  type CommandInvocationOptions,
  type IdempotencyStore,
} from "@venture-harness/command-bus";
import { selectCommandGrant } from "@venture-harness/connections";
import { assertNonEmpty, tenantKey, type JsonValue } from "@venture-harness/core";
import { assertEntitlements } from "@venture-harness/entitlements";
import { InMemoryEventLog, type EventSink } from "@venture-harness/events";
import {
  assertOrganizationMembership,
  type OrganizationMembership,
} from "@venture-harness/organizations";
import { decideScopes } from "@venture-harness/policy";
import { InMemoryMeteringSink, type MeteringSink } from "@venture-harness/telemetry";
import type { ProductionLoopRuntime } from "@venture-harness/loops";
import {
  campaignLaunchCommand,
  launchExecuteCommand,
  type CampaignLaunchInput,
  type CampaignLaunchOutput,
  type LaunchExecuteInput,
  type LaunchExecuteOutput,
} from "./contracts.js";
import { registerOperationalCommands, type OperationalStateStore } from "./operational.js";
import type { QualityProfileRunner } from "./quality.js";
import {
  registerPlatformOperationCommands,
  type AuthCommandRuntime,
  type FleetCommandRuntime,
  type UpgradeCommandRuntime,
} from "./platform-operations.js";
import {
  registerProviderOperationCommands,
  type ProviderCommandRuntime,
} from "./provider-operations.js";
import {
  registerStackOperationCommands,
  unconfiguredStackCommandRuntime,
  type StackCommandRuntime,
} from "./stack-operations.js";
import {
  recursiveCommandContracts,
  recursiveReconcileCommandRegistrations,
  registerRecursiveCommands,
  registerRecursiveReconcileCommands,
  type RecursiveCommandRuntime,
  type RecursiveServiceCommandContract,
  type RecursiveServiceReconcileRegistration,
} from "./recursive.js";

export * from "./contracts.js";
export * from "./loop-operations.js";
export * from "./operational.js";
export * from "./platform-operations.js";
export * from "./provider-operations.js";
export * from "./quality.js";
export * from "./recursive.js";
export * from "./stack-operations.js";

export interface VentureRuntimeOptions {
  memberships: readonly OrganizationMembership[];
  audit?: AuditSink;
  securityAudit?: AuditSink;
  events?: EventSink;
  metering?: MeteringSink;
  operationalStore?: OperationalStateStore;
  authCommandRuntime?: AuthCommandRuntime;
  upgradeCommandRuntime?: UpgradeCommandRuntime;
  fleetCommandRuntime?: FleetCommandRuntime;
  providerCommandRuntime?: ProviderCommandRuntime;
  stackCommandRuntime?: StackCommandRuntime;
  recursiveCommandRuntime?: RecursiveCommandRuntime;
  recursiveCommands?: readonly RecursiveServiceCommandContract[];
  recursiveReconcileCommands?: readonly RecursiveServiceReconcileRegistration[];
  commandExecutionMode?: "fixture" | "production";
  commandIdempotencyStore?: IdempotencyStore;
  growthContractRoot?: string;
  qualityProfileRunner?: QualityProfileRunner;
  learningLoopRuntime?: ProductionLoopRuntime;
  now?: () => Date;
}

export interface VentureRuntime {
  bus: CommandBus;
  contracts: readonly AnyCommandContract[];
  executionMode: "fixture" | "production";
  durability: {
    commandIdempotency: "fixture_only" | "durable_atomic";
    audit: "fixture_only" | "durable_atomic";
    securityAudit: "fixture_only" | "durable_atomic";
    events: "fixture_only" | "durable_atomic";
    metering: "fixture_only" | "durable_atomic";
  };
  execute(commandId: string, input: unknown, options: CommandInvocationOptions): Promise<JsonValue>;
}

function commandRequirements(contract: AnyCommandContract): AnyCommandContract["requirements"] {
  return contract.requirements;
}

export function createVentureRuntime(options: VentureRuntimeOptions): VentureRuntime {
  const executionMode = options.commandExecutionMode ?? "production";
  if (executionMode === "production") {
    const required = [
      ["command idempotency", options.commandIdempotencyStore?.durability],
      ["audit", options.audit?.durability],
      ["event", options.events?.durability],
      ["metering", options.metering?.durability],
    ] as const;
    const unsafe = required
      .filter(([, durability]) => durability !== "durable_atomic")
      .map(([name]) => name);
    if (unsafe.length > 0) {
      throw new Error(
        `Production venture runtime requires injected durable atomic stores for: ${unsafe.join(", ")}`,
      );
    }
    if (
      options.securityAudit !== undefined &&
      options.securityAudit.durability !== "durable_atomic"
    ) {
      throw new Error("Production venture runtime security audit sink must be durable atomic");
    }
  }
  const audit = options.audit ?? new InMemoryAuditChain();
  const securityAudit = options.securityAudit ?? audit;
  const events = options.events ?? new InMemoryEventLog();
  const metering = options.metering ?? new InMemoryMeteringSink();
  const idempotency = options.commandIdempotencyStore ?? new InMemoryIdempotencyStore();
  const bus = new CommandBus(
    {
      identity(context) {
        assertNonEmpty(context.identity.actorId, "actorId");
      },
      tenant(context) {
        tenantKey(context.tenant);
        assertOrganizationMembership(context.identity, context.tenant, options.memberships);
      },
      subscription(contract, context) {
        if (commandRequirements(contract).activeSubscription)
          assertActiveSubscription(context.subscription);
      },
      entitlement(contract, context) {
        assertEntitlements(context.entitlements, commandRequirements(contract).entitlements);
      },
      grant(contract, context, now) {
        if (commandRequirements(contract).grant) {
          selectCommandGrant(
            context.grants,
            contract.id,
            commandRequirements(contract).scopes,
            now,
          );
        }
      },
      scope(contract, context) {
        const decision = decideScopes(context, commandRequirements(contract).scopes);
        if (!decision.allowed) throw new Error(decision.reason);
      },
      idempotency,
      audit,
      securityAudit,
      metering,
      events,
    },
    { now: options.now, executionMode },
  );

  bus.register<CampaignLaunchInput, CampaignLaunchOutput>(
    campaignLaunchCommand,
    (input, context) => ({
      commandId: "campaigns.launch",
      ventureId: context.context.tenant.ventureId,
      campaignId: input.campaignId,
      channel: input.channel,
      status: "planned",
    }),
  );
  bus.register<LaunchExecuteInput, LaunchExecuteOutput>(launchExecuteCommand, (input, context) => ({
    commandId: "launch.execute",
    ventureId: context.context.tenant.ventureId,
    runId: `run-${context.context.tenant.ventureId}-${input.launchId}`.replace(
      /[^a-zA-Z0-9._-]/g,
      "-",
    ),
    mode: input.mode,
    status: "accepted",
    dryRun: input.dryRun,
  }));
  const stackRuntime = options.stackCommandRuntime ?? unconfiguredStackCommandRuntime;
  registerOperationalCommands(bus, {
    store: options.operationalStore,
    growthContractRoot: options.growthContractRoot,
    stackCatalog: stackRuntime.catalog,
    qualityProfileRunner: options.qualityProfileRunner,
    learningLoopRuntime: options.learningLoopRuntime,
    now: options.now,
  });
  registerPlatformOperationCommands(bus, {
    auth: options.authCommandRuntime,
    upgrade: options.upgradeCommandRuntime,
    fleet: options.fleetCommandRuntime,
  });
  registerProviderOperationCommands(bus, options.providerCommandRuntime);
  registerStackOperationCommands(bus, stackRuntime);
  if (options.recursiveCommandRuntime) {
    registerRecursiveCommands(
      bus,
      options.recursiveCommandRuntime,
      options.recursiveCommands ?? recursiveCommandContracts,
    );
    registerRecursiveReconcileCommands(
      bus,
      options.recursiveCommandRuntime,
      options.recursiveReconcileCommands ??
        (options.recursiveCommands ? [] : recursiveReconcileCommandRegistrations),
    );
  } else if (options.recursiveCommands || options.recursiveReconcileCommands) {
    throw new Error("recursive commands require an injected recursive command runtime");
  }

  return {
    bus,
    contracts: bus.contracts(),
    executionMode,
    durability: {
      commandIdempotency: idempotency.durability,
      audit: audit.durability ?? "fixture_only",
      securityAudit: securityAudit.durability ?? "fixture_only",
      events: events.durability ?? "fixture_only",
      metering: metering.durability ?? "fixture_only",
    },
    execute: (commandId, input, invocation) => bus.executeById(commandId, input, invocation),
  };
}
