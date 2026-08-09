import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CredentialBroker, Redactor } from "../credentials";
import { FileProviderIdempotencyLedger } from "../runtime/file-idempotency-ledger";
import { providerRegistry, type ProviderRegistry } from "../providers/registry";
import {
  resolveStackCapability,
  type ProviderStackProfile,
  type StackCapabilityRole,
} from "../providers/stack-profiles";
import type {
  JsonValue,
  ProviderAdapter,
  ProviderDoctorResult,
  ProviderEnvironment,
  ProviderExecutionContext,
  ProviderPlan,
  ProviderTransport,
} from "../providers/types";
import type {
  LaunchEffect,
  LaunchEffectEvidence,
  LaunchGrant,
  ProviderAccountDestination,
  VentureManifest,
  VentureMaterializationPlan,
} from "./types";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

interface LaunchEffectContract {
  role: StackCapabilityRole | ((manifest: VentureManifest) => StackCapabilityRole);
  accountCapabilities: readonly string[];
  requiredEnvironment?: ProviderEnvironment;
}

const launchEffectContracts: Readonly<Record<LaunchEffect, LaunchEffectContract>> = {
  "repository.create": {
    role: "source.repository.create",
    accountCapabilities: ["source.repository.create"],
  },
  "company_stack.provision": {
    role: "database.postgres.provision",
    accountCapabilities: ["database.postgres.provision"],
  },
  "source.push": {
    role: "source.repository.create",
    accountCapabilities: ["source.repository.create"],
  },
  "preview.deploy": {
    role: "hosting.web.deploy",
    accountCapabilities: ["hosting.web.deploy"],
    requiredEnvironment: "preview",
  },
  "production.deploy": {
    role: "hosting.web.deploy",
    accountCapabilities: ["hosting.web.deploy"],
    requiredEnvironment: "production",
  },
  "domain.configure": {
    role: "dns.record",
    accountCapabilities: ["dns.record", "domain.configure"],
    requiredEnvironment: "production",
  },
  "commerce.configure": {
    role: (manifest: VentureManifest) =>
      manifest.rail === "ios" ? "commerce.native_subscription" : "commerce.web_subscription",
    accountCapabilities: ["commerce.web_subscription", "commerce.native_subscription"],
    requiredEnvironment: "production",
  },
  "loops.schedule": {
    role: "source.repository.create",
    accountCapabilities: ["source.repository.create"],
  },
};

export interface LaunchProviderEffectRequest {
  readonly environment: ProviderEnvironment;
  readonly credentialRef?: string;
  readonly inputs: Readonly<Record<string, JsonValue | undefined>>;
}

export interface ProviderLaunchEffectContext {
  readonly authorization: "approved";
  readonly transports: Partial<Record<ProviderTransport["kind"], ProviderTransport>>;
  readonly credentials?: CredentialBroker;
  readonly redactor: Redactor;
  readonly signal?: AbortSignal;
}

export interface ProviderRegistryLaunchEffectExecutorOptions {
  readonly stackProfile: ProviderStackProfile;
  readonly requests: Readonly<Partial<Record<LaunchEffect, LaunchProviderEffectRequest>>>;
  readonly ledgerPath: string;
  readonly evidenceKeyPath?: string;
  readonly context: ProviderLaunchEffectContext;
  readonly fixture: boolean;
  readonly registry?: ProviderRegistry;
  /** Metered usage from any model work composed before provider execution. */
  readonly modelUsage?: LaunchModelUsage;
  readonly now?: () => Date;
}

export interface LaunchModelUsage {
  readonly known: boolean;
  readonly tokens: number;
  readonly costMinorUnits: number;
  readonly currency: string;
  readonly source: "metered" | "deterministic_no_model_execution";
}

export interface LaunchBudgetReservation {
  readonly model: LaunchModelUsage;
  readonly external: {
    readonly resourceCount: number;
    readonly costMinorUnits: number;
    readonly currency: string;
    readonly uniqueProviderRequests: number;
  };
}

export type ProviderLaunchEffectErrorCode =
  | "profile_mismatch"
  | "unsupported_effect"
  | "account_mismatch"
  | "request_missing"
  | "credential_binding"
  | "preflight_failed"
  | "budget_estimate_unknown"
  | "budget_estimate_invalid"
  | "budget_currency_mismatch"
  | "budget_exceeded"
  | "doctor_failed"
  | "provider_apply_unverified"
  | "evidence_invalid";

export class ProviderLaunchEffectError extends Error {
  constructor(
    message: string,
    readonly code: ProviderLaunchEffectErrorCode,
  ) {
    super(message);
    this.name = "ProviderLaunchEffectError";
  }
}

export interface ProviderLaunchOperationEvidence {
  readonly operationId: string;
  readonly plannedRequestHash: string;
  readonly executedRequestHash: string;
  readonly executionStatus: "succeeded";
  readonly readBackStatus: "matched";
  readonly readBackEvidenceHash: string;
}

export interface ProviderLaunchEffectEvidence extends LaunchEffectEvidence {
  readonly schemaVersion: 2;
  readonly verificationSource: "provider_adapter_read_back";
  readonly verificationState: "verified";
  readonly grantId: string;
  readonly grantHash: string;
  readonly planDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileHash: string;
  readonly capabilityRole: StackCapabilityRole;
  readonly concreteCapability: string;
  readonly accountHash: string;
  readonly providerPlanId: string;
  readonly providerPlanHash: string;
  readonly providerRequestHash: string;
  readonly invocationHash: string;
  readonly bindingHash: string;
  readonly budget: {
    readonly resourceCount: number;
    readonly costMinorUnits: number;
    readonly currency: string;
  };
  readonly launchBudget: LaunchBudgetReservation;
  readonly lifecycle: {
    readonly doctorStatus: ProviderDoctorResult["status"];
    readonly applyState: "applied";
    readonly verificationState: "verified";
    readonly operations: readonly ProviderLaunchOperationEvidence[];
  };
  readonly proof: {
    readonly algorithm: "hmac-sha256";
    readonly keyId: string;
    readonly signature: string;
  };
}

interface PreparedEffect {
  effect: LaunchEffect;
  planDigest: string;
  grant: LaunchGrant;
  manifest: VentureManifest;
  role: StackCapabilityRole;
  concreteCapability: string;
  account: ProviderAccountDestination;
  adapter: ProviderAdapter;
  request: LaunchProviderEffectRequest;
  plan: ProviderPlan;
  grantHash: string;
  profileHash: string;
  accountHash: string;
  providerRequestHash: string;
  providerPlanHash: string;
  invocationHash: string;
  bindingHash: string;
  plannedOperationHashes: ReadonlyMap<string, string>;
  budget: {
    resourceCount: number;
    costMinorUnits: number;
    currency: string;
  };
}

interface VerifiedLifecycle {
  doctorStatus: ProviderDoctorResult["status"];
  operations: readonly ProviderLaunchOperationEvidence[];
  observedAt: string;
}

function planHash(plan: ProviderPlan): string {
  return sha256({
    id: plan.id,
    provider: plan.provider,
    environment: plan.environment,
    dryRun: plan.dryRun,
    operations: plan.operations,
    limitations: plan.limitations,
  });
}

function roleFor(effect: LaunchEffect, manifest: VentureManifest): StackCapabilityRole {
  const role = launchEffectContracts[effect].role;
  return typeof role === "function" ? role(manifest) : role;
}

function exactAccount(
  grant: LaunchGrant,
  effect: LaunchEffect,
  providerId: string,
  role: StackCapabilityRole,
): ProviderAccountDestination {
  const capabilities = new Set<string>([
    ...launchEffectContracts[effect].accountCapabilities,
    role,
  ]);
  const matches = grant.providerAccounts.filter(
    (account) => account.provider === providerId && capabilities.has(account.capability),
  );
  if (matches.length !== 1) {
    throw new ProviderLaunchEffectError(
      `${effect} requires exactly one ${providerId} account bound to ${role}`,
      "account_mismatch",
    );
  }
  return matches[0]!;
}

function requiresCredential(adapter: ProviderAdapter): boolean {
  return !adapter.descriptor.transports.every((transport) => transport === "manual");
}

function bindProviderPlan(input: {
  plan: ProviderPlan;
  grantId: string;
  profileHash: string;
  accountHash: string;
  role: StackCapabilityRole;
  providerRequestHash: string;
}): ProviderPlan {
  const operations = input.plan.operations.map((operation) => {
    const unboundOperationHash = sha256({ ...operation, idempotencyKey: undefined });
    const idempotencyKey = `launch:${sha256({
      grantId: input.grantId,
      profileHash: input.profileHash,
      accountHash: input.accountHash,
      role: input.role,
      providerRequestHash: input.providerRequestHash,
      operationId: operation.id,
      unboundOperationHash,
    })}`;
    return freeze({ ...operation, idempotencyKey });
  });
  return freeze({ ...input.plan, operations });
}

function evidenceBody(
  evidence: ProviderLaunchEffectEvidence,
): Omit<ProviderLaunchEffectEvidence, "proof"> {
  const { proof, ...body } = evidence;
  void proof;
  return body;
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2,
  AUD: 2,
  BGN: 2,
  BHD: 3,
  BIF: 0,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  CZK: 2,
  DJF: 0,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  GNF: 0,
  HKD: 2,
  HUF: 2,
  ILS: 2,
  INR: 2,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  MXN: 2,
  NOK: 2,
  NZD: 2,
  OMR: 3,
  PLN: 2,
  PYG: 0,
  QAR: 2,
  RON: 2,
  RWF: 0,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  TND: 3,
  TRY: 2,
  UGX: 0,
  USD: 2,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  ZAR: 2,
});

function toMinorUnits(amount: number, currency: string, operationId: string): number {
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new ProviderLaunchEffectError(
      `Provider operation ${operationId} has an invalid cost estimate`,
      "budget_estimate_invalid",
    );
  }
  const exponent = MINOR_UNIT_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new ProviderLaunchEffectError(
      `Provider operation ${operationId} uses unsupported minor-unit currency ${currency}`,
      "budget_estimate_invalid",
    );
  }
  const minorUnits = amount * 10 ** exponent;
  if (!Number.isSafeInteger(minorUnits)) {
    throw new ProviderLaunchEffectError(
      `Provider operation ${operationId} cost cannot be converted exactly to minor units`,
      "budget_estimate_invalid",
    );
  }
  return minorUnits;
}

export class ProviderRegistryLaunchEffectExecutor {
  private readonly registry: ProviderRegistry;
  private readonly ledger: FileProviderIdempotencyLedger;
  private readonly evidenceKeyPath: string;
  private readonly now: () => Date;
  private readonly stackProfile: ProviderStackProfile;
  private readonly requests: Readonly<Partial<Record<LaunchEffect, LaunchProviderEffectRequest>>>;
  private preparedPlanDigest: string | null = null;
  private prepared = new Map<LaunchEffect, PreparedEffect>();
  private preparedBudget: LaunchBudgetReservation | null = null;
  private readonly verifiedRequests = new Map<string, VerifiedLifecycle>();

  constructor(private readonly options: ProviderRegistryLaunchEffectExecutorOptions) {
    if (options.context.authorization !== "approved") {
      throw new ProviderLaunchEffectError(
        "Canonical launch provider execution requires explicit approved authorization",
        "preflight_failed",
      );
    }
    this.registry = options.registry ?? providerRegistry;
    this.stackProfile = freeze(structuredClone(options.stackProfile));
    this.requests = freeze(structuredClone(options.requests));
    this.ledger = new FileProviderIdempotencyLedger(options.ledgerPath, {
      now: options.now,
    });
    this.evidenceKeyPath = options.evidenceKeyPath ?? `${options.ledgerPath}.evidence-key`;
    this.now = options.now ?? (() => new Date());
  }

  prepare(plan: VentureMaterializationPlan): LaunchBudgetReservation {
    if (this.preparedPlanDigest === plan.planDigest && this.preparedBudget) {
      return this.preparedBudget;
    }
    if (plan.grant.modelExecutionPolicy || plan.grant.providerOperationBudget) {
      throw new ProviderLaunchEffectError(
        "Canonical founder Launch Grants use the provider-operation and model-task workflow runtime, not the legacy hard-metered materialization-effect executor",
        "preflight_failed",
      );
    }
    const modelBudget = plan.grant.modelBudget;
    const externalBudget = plan.grant.externalResourceBudget;
    if (!modelBudget || !externalBudget) {
      throw new ProviderLaunchEffectError(
        "Legacy materialization-effect execution requires explicit hard-metered model and external budgets",
        "preflight_failed",
      );
    }
    if (
      plan.grant.stackProfile.id !== this.stackProfile.profileId ||
      plan.grant.stackProfile.version !== this.stackProfile.version
    ) {
      throw new ProviderLaunchEffectError(
        `Launch Grant Stack Profile ${plan.grant.stackProfile.id}@${plan.grant.stackProfile.version} does not match ${this.stackProfile.profileId}@${this.stackProfile.version}`,
        "profile_mismatch",
      );
    }
    if (new Set(plan.effects).size !== plan.effects.length) {
      throw new ProviderLaunchEffectError(
        "Launch effects must be unique before provider execution",
        "preflight_failed",
      );
    }

    const next = new Map<LaunchEffect, PreparedEffect>();
    for (const effect of plan.effects) {
      const contract = launchEffectContracts[effect];
      if (!contract) {
        throw new ProviderLaunchEffectError(
          `No provider capability contract exists for ${effect}`,
          "unsupported_effect",
        );
      }
      const role = roleFor(effect, plan.manifest);
      const resolved = resolveStackCapability(this.stackProfile, role, this.registry);
      const account = exactAccount(plan.grant, effect, resolved.providerId, role);
      const request = this.requests[effect];
      if (!request) {
        throw new ProviderLaunchEffectError(
          `No provider request is bound to ${effect}`,
          "request_missing",
        );
      }
      if (contract.requiredEnvironment && request.environment !== contract.requiredEnvironment) {
        throw new ProviderLaunchEffectError(
          `${effect} requires the ${contract.requiredEnvironment} provider environment`,
          "preflight_failed",
        );
      }
      if (!resolved.adapter.descriptor.environments.includes(request.environment)) {
        throw new ProviderLaunchEffectError(
          `${resolved.providerId} does not support ${request.environment} for ${effect}`,
          "preflight_failed",
        );
      }
      if (requiresCredential(resolved.adapter)) {
        if (!request.credentialRef || !this.options.context.credentials) {
          throw new ProviderLaunchEffectError(
            `${effect} requires a brokered credential reference bound to ${account.externalAccountId}`,
            "credential_binding",
          );
        }
        const reference = this.options.context.credentials.getReference(request.credentialRef);
        if (
          !reference ||
          reference.provider !== resolved.providerId ||
          reference.accountId !== account.externalAccountId
        ) {
          throw new ProviderLaunchEffectError(
            `${effect} credential is not bound to the Launch Grant provider account`,
            "credential_binding",
          );
        }
      }

      const grantHash = sha256(plan.grant);
      const profileHash = sha256(this.stackProfile);
      const accountHash = sha256(account);
      const providerRequestHash = sha256({
        grantId: plan.grant.grantId,
        profileHash,
        accountHash,
        role,
        providerId: resolved.providerId,
        capability: resolved.capability,
        environment: request.environment,
        credentialRef: request.credentialRef,
        inputs: request.inputs,
      });
      let providerPlan: ProviderPlan;
      try {
        providerPlan = resolved.adapter.plan({
          environment: request.environment,
          capabilities: [resolved.capability],
          credentialRef: request.credentialRef,
          inputs: request.inputs,
          dryRun: false,
        });
      } catch (error) {
        throw new ProviderLaunchEffectError(
          `${effect} provider plan failed before invocation: ${this.options.context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          )}`,
          "preflight_failed",
        );
      }
      if (
        providerPlan.dryRun ||
        providerPlan.operations.length === 0 ||
        !providerPlan.operations.some(
          (operation) => operation.capability === resolved.capability,
        ) ||
        providerPlan.operations.some(
          (operation) =>
            operation.provider !== resolved.providerId ||
            operation.environment !== request.environment ||
            !resolved.adapter.descriptor.capabilities.includes(operation.capability),
        )
      ) {
        throw new ProviderLaunchEffectError(
          `${effect} did not produce a concrete non-empty provider plan`,
          "preflight_failed",
        );
      }
      if (
        new Set(providerPlan.operations.map((operation) => operation.id)).size !==
        providerPlan.operations.length
      ) {
        throw new ProviderLaunchEffectError(
          `${effect} provider plan contains duplicate operation IDs`,
          "preflight_failed",
        );
      }
      providerPlan = bindProviderPlan({
        plan: providerPlan,
        grantId: plan.grant.grantId,
        profileHash,
        accountHash,
        role,
        providerRequestHash,
      });
      const providerPlanHash = planHash(providerPlan);
      const invocationHash = sha256(`${plan.grant.grantId}:${effect}`);
      const bindingHash = sha256({
        effect,
        grantHash,
        planDigest: plan.planDigest,
        profileHash,
        accountHash,
        providerRequestHash,
        providerPlanHash,
        invocationHash,
      });
      let costMinorUnits = 0;
      for (const operation of providerPlan.operations) {
        if (!operation.estimatedCost) {
          throw new ProviderLaunchEffectError(
            `${effect} provider operation ${operation.id} has unknown cost`,
            "budget_estimate_unknown",
          );
        }
        if (operation.estimatedCost.currency !== externalBudget.currency) {
          throw new ProviderLaunchEffectError(
            `${effect} estimates ${operation.estimatedCost.currency}, but the Launch Grant ceiling is ${externalBudget.currency}; currency conversion is not authorized`,
            "budget_currency_mismatch",
          );
        }
        costMinorUnits += toMinorUnits(
          operation.estimatedCost.amount,
          operation.estimatedCost.currency,
          operation.id,
        );
        if (!Number.isSafeInteger(costMinorUnits)) {
          throw new ProviderLaunchEffectError(
            `${effect} provider cost estimate is not a safe integer`,
            "budget_estimate_invalid",
          );
        }
      }
      next.set(effect, {
        effect,
        planDigest: plan.planDigest,
        grant: plan.grant,
        manifest: plan.manifest,
        role,
        concreteCapability: resolved.capability,
        account,
        adapter: resolved.adapter,
        request,
        plan: providerPlan,
        grantHash,
        profileHash,
        accountHash,
        providerRequestHash,
        providerPlanHash,
        invocationHash,
        bindingHash,
        plannedOperationHashes: new Map(
          providerPlan.operations.map((operation) => [operation.id, sha256(operation)]),
        ),
        budget: {
          resourceCount: providerPlan.operations.length,
          costMinorUnits,
          currency: externalBudget.currency,
        },
      });
    }
    const uniqueRequests = new Map<string, PreparedEffect>();
    for (const prepared of next.values()) {
      const prior = uniqueRequests.get(prepared.providerRequestHash);
      if (prior && prior.providerPlanHash !== prepared.providerPlanHash) {
        throw new ProviderLaunchEffectError(
          "One canonical provider request produced divergent provider plans",
          "preflight_failed",
        );
      }
      uniqueRequests.set(prepared.providerRequestHash, prepared);
    }
    const completePlanOperationIds = new Set<string>();
    for (const prepared of uniqueRequests.values()) {
      for (const operation of prepared.plan.operations) {
        if (completePlanOperationIds.has(operation.id)) {
          throw new ProviderLaunchEffectError(
            `Complete launch provider plan contains duplicate operation ID ${operation.id}`,
            "preflight_failed",
          );
        }
        completePlanOperationIds.add(operation.id);
      }
    }
    const resourceCount = [...uniqueRequests.values()].reduce(
      (total, item) => total + item.budget.resourceCount,
      0,
    );
    const externalCostMinorUnits = [...uniqueRequests.values()].reduce(
      (total, item) => total + item.budget.costMinorUnits,
      0,
    );
    if (!Number.isSafeInteger(resourceCount) || !Number.isSafeInteger(externalCostMinorUnits)) {
      throw new ProviderLaunchEffectError(
        "Launch provider budget estimate is not a safe integer",
        "budget_estimate_invalid",
      );
    }
    if (resourceCount > externalBudget.maxResources) {
      throw new ProviderLaunchEffectError(
        `Launch provider plans require ${resourceCount} operations, exceeding the legacy ${externalBudget.maxResources}-operation ceiling`,
        "budget_exceeded",
      );
    }
    if (externalCostMinorUnits > externalBudget.maxMinorUnits) {
      throw new ProviderLaunchEffectError(
        `Launch provider plans require ${externalCostMinorUnits} ${externalBudget.currency} minor units, exceeding the legacy ${externalBudget.maxMinorUnits}-minor-unit ceiling`,
        "budget_exceeded",
      );
    }
    const model = this.options.modelUsage ?? {
      known: true,
      tokens: 0,
      costMinorUnits: 0,
      currency: modelBudget.currency,
      source: "deterministic_no_model_execution" as const,
    };
    if (!model.known) {
      throw new ProviderLaunchEffectError(
        "Launch model usage is unknown and cannot be authorized by a hard ceiling",
        "budget_estimate_unknown",
      );
    }
    if (
      !Number.isSafeInteger(model.tokens) ||
      model.tokens < 0 ||
      !Number.isSafeInteger(model.costMinorUnits) ||
      model.costMinorUnits < 0 ||
      !/^[A-Z]{3}$/.test(model.currency)
    ) {
      throw new ProviderLaunchEffectError(
        "Launch model usage meter returned an invalid value",
        "budget_estimate_invalid",
      );
    }
    if (model.currency !== modelBudget.currency) {
      throw new ProviderLaunchEffectError(
        `Launch model usage is denominated in ${model.currency}, but the legacy Launch Grant ceiling is ${modelBudget.currency}`,
        "budget_currency_mismatch",
      );
    }
    if (model.tokens > modelBudget.maxTokens || model.costMinorUnits > modelBudget.maxMinorUnits) {
      throw new ProviderLaunchEffectError(
        "Launch model usage exceeds the token or monetary ceiling",
        "budget_exceeded",
      );
    }
    const budget: LaunchBudgetReservation = freeze({
      model: { ...model },
      external: {
        resourceCount,
        costMinorUnits: externalCostMinorUnits,
        currency: externalBudget.currency,
        uniqueProviderRequests: uniqueRequests.size,
      },
    });
    this.prepared = new Map(
      [...next.entries()].map(([effect, prepared]) => [
        effect,
        {
          ...prepared,
          bindingHash: sha256({
            effect,
            grantHash: prepared.grantHash,
            planDigest: prepared.planDigest,
            profileHash: prepared.profileHash,
            accountHash: prepared.accountHash,
            providerRequestHash: prepared.providerRequestHash,
            providerPlanHash: prepared.providerPlanHash,
            invocationHash: prepared.invocationHash,
            launchBudget: budget,
          }),
        },
      ]),
    );
    this.preparedBudget = budget;
    this.preparedPlanDigest = plan.planDigest;
    return budget;
  }

  async apply(input: {
    effect: LaunchEffect;
    grant: LaunchGrant;
    manifest: VentureManifest;
    idempotencyKey: string;
  }): Promise<ProviderLaunchEffectEvidence> {
    const prepared = this.prepared.get(input.effect);
    if (!prepared || this.preparedPlanDigest === null) {
      throw new ProviderLaunchEffectError(
        "Provider effects must be preflighted as one complete launch plan",
        "preflight_failed",
      );
    }
    if (
      input.idempotencyKey !== `${prepared.grant.grantId}:${input.effect}` ||
      sha256(input.grant) !== prepared.grantHash ||
      input.manifest.stackProfile.id !== this.stackProfile.profileId ||
      input.manifest.stackProfile.version !== this.stackProfile.version ||
      input.manifest.ventureId !== prepared.manifest.ventureId
    ) {
      throw new ProviderLaunchEffectError(
        `${input.effect} invocation is not bound to the preflighted Launch Grant`,
        "preflight_failed",
      );
    }

    const cached = this.verifiedRequests.get(prepared.providerRequestHash);
    if (cached) return this.createEvidence(prepared, cached);

    const context: ProviderExecutionContext = {
      authorization: "approved",
      transports: this.options.context.transports,
      credentials: this.options.context.credentials,
      redactor: this.options.context.redactor,
      idempotencyLedger: this.ledger,
      signal: this.options.context.signal,
    };
    const doctor = await prepared.adapter.doctor(
      {
        requiredCapabilities: [prepared.concreteCapability],
        credentialRefs: prepared.request.credentialRef
          ? [prepared.request.credentialRef]
          : undefined,
      },
      context,
    );
    if (doctor.status !== "ready" && doctor.status !== "manual_only") {
      throw new ProviderLaunchEffectError(
        `${prepared.effect} provider doctor is ${doctor.status}`,
        "doctor_failed",
      );
    }

    const execution = await prepared.adapter.apply(prepared.plan, context);
    const readBack = await prepared.adapter.readBack(execution, context);
    const verification = prepared.adapter.verify(execution, readBack);
    const operations: ProviderLaunchOperationEvidence[] = execution.operations.map(
      ({ operation, result }) => {
        const check = readBack.results.find((candidate) => candidate.operationId === operation.id);
        if (result.status !== "succeeded" || check?.status !== "matched") {
          throw new ProviderLaunchEffectError(
            `${prepared.effect} has no verified provider read-back for ${operation.id}`,
            "provider_apply_unverified",
          );
        }
        return {
          operationId: operation.id,
          plannedRequestHash:
            prepared.plannedOperationHashes.get(operation.id) ?? sha256(operation),
          executedRequestHash: sha256(operation),
          executionStatus: "succeeded" as const,
          readBackStatus: "matched" as const,
          readBackEvidenceHash: sha256(
            this.options.context.redactor.redact(check.evidence ?? null),
          ),
        };
      },
    );
    if (
      execution.state !== "applied" ||
      verification.state !== "verified" ||
      operations.length !== prepared.plan.operations.length
    ) {
      throw new ProviderLaunchEffectError(
        `${prepared.effect} provider lifecycle ended ${execution.state}/${verification.state}`,
        "provider_apply_unverified",
      );
    }
    const lifecycle: VerifiedLifecycle = freeze({
      doctorStatus: doctor.status,
      operations,
      observedAt: this.now().toISOString(),
    });
    this.verifiedRequests.set(prepared.providerRequestHash, lifecycle);
    return this.createEvidence(prepared, lifecycle);
  }

  async validateEvidence(
    plan: VentureMaterializationPlan,
    evidence: LaunchEffectEvidence,
  ): Promise<ProviderLaunchEffectEvidence> {
    this.prepare(plan);
    const prepared = this.prepared.get(evidence.effect);
    const candidate = evidence as Partial<ProviderLaunchEffectEvidence>;
    if (
      !prepared ||
      candidate.schemaVersion !== 2 ||
      candidate.verificationSource !== "provider_adapter_read_back" ||
      candidate.verificationState !== "verified" ||
      candidate.requestAccepted !== true ||
      candidate.readBackVerified !== true ||
      candidate.fixture !== this.options.fixture ||
      candidate.grantId !== prepared.grant.grantId ||
      candidate.grantHash !== prepared.grantHash ||
      candidate.planDigest !== plan.planDigest ||
      candidate.profileId !== this.stackProfile.profileId ||
      candidate.profileVersion !== this.stackProfile.version ||
      candidate.profileHash !== prepared.profileHash ||
      candidate.provider !== prepared.adapter.descriptor.id ||
      candidate.externalAccountId !== prepared.account.externalAccountId ||
      candidate.ownership !== prepared.account.ownership ||
      candidate.capabilityRole !== prepared.role ||
      candidate.concreteCapability !== prepared.concreteCapability ||
      candidate.accountHash !== prepared.accountHash ||
      candidate.providerPlanId !== prepared.plan.id ||
      candidate.providerPlanHash !== prepared.providerPlanHash ||
      candidate.providerRequestHash !== prepared.providerRequestHash ||
      candidate.invocationHash !== prepared.invocationHash ||
      candidate.bindingHash !== prepared.bindingHash ||
      !candidate.budget ||
      candidate.budget.resourceCount !== prepared.budget.resourceCount ||
      candidate.budget.costMinorUnits !== prepared.budget.costMinorUnits ||
      candidate.budget.currency !== prepared.budget.currency ||
      !candidate.launchBudget ||
      !this.preparedBudget ||
      sha256(candidate.launchBudget) !== sha256(this.preparedBudget) ||
      !candidate.lifecycle ||
      candidate.lifecycle.applyState !== "applied" ||
      candidate.lifecycle.verificationState !== "verified" ||
      !Array.isArray(candidate.lifecycle.operations) ||
      candidate.lifecycle.operations.length !== prepared.plan.operations.length ||
      typeof candidate.observedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.observedAt)) ||
      !candidate.proof ||
      candidate.proof.algorithm !== "hmac-sha256"
    ) {
      throw new ProviderLaunchEffectError(
        `${evidence.effect} evidence is not bound to this Launch Grant and Stack Profile`,
        "evidence_invalid",
      );
    }
    const observedAt = new Date(candidate.observedAt).getTime();
    if (
      observedAt < new Date(prepared.grant.createdAt).getTime() ||
      observedAt >= new Date(prepared.grant.expiresAt).getTime()
    ) {
      throw new ProviderLaunchEffectError(
        `${evidence.effect} evidence was observed outside the Launch Grant window`,
        "evidence_invalid",
      );
    }
    for (const [index, operationEvidence] of candidate.lifecycle.operations.entries()) {
      const operation = prepared.plan.operations[index];
      if (
        !operation ||
        operationEvidence.operationId !== operation.id ||
        operationEvidence.plannedRequestHash !==
          prepared.plannedOperationHashes.get(operation.id) ||
        !validHash(operationEvidence.executedRequestHash) ||
        operationEvidence.executionStatus !== "succeeded" ||
        operationEvidence.readBackStatus !== "matched" ||
        !validHash(operationEvidence.readBackEvidenceHash)
      ) {
        throw new ProviderLaunchEffectError(
          `${evidence.effect} operation evidence is incomplete or mismatched`,
          "evidence_invalid",
        );
      }
    }
    const key = await this.evidenceKey(false);
    const keyId = sha256(key);
    const expectedSignature = createHmac("sha256", key)
      .update(canonical(evidenceBody(candidate as ProviderLaunchEffectEvidence)))
      .digest("hex");
    if (
      candidate.proof.keyId !== keyId ||
      !validHash(candidate.proof.signature) ||
      !timingSafeEqual(
        Buffer.from(candidate.proof.signature, "hex"),
        Buffer.from(expectedSignature, "hex"),
      )
    ) {
      throw new ProviderLaunchEffectError(
        `${evidence.effect} evidence signature is invalid`,
        "evidence_invalid",
      );
    }
    const verified = candidate as ProviderLaunchEffectEvidence;
    this.verifiedRequests.set(prepared.providerRequestHash, {
      doctorStatus: verified.lifecycle.doctorStatus,
      operations: verified.lifecycle.operations,
      observedAt: verified.observedAt,
    });
    return verified;
  }

  private async createEvidence(
    prepared: PreparedEffect,
    lifecycle: VerifiedLifecycle,
  ): Promise<ProviderLaunchEffectEvidence> {
    const key = await this.evidenceKey(true);
    const body: Omit<ProviderLaunchEffectEvidence, "proof"> = {
      schemaVersion: 2,
      verificationSource: "provider_adapter_read_back",
      verificationState: "verified",
      effect: prepared.effect,
      provider: prepared.adapter.descriptor.id,
      externalAccountId: prepared.account.externalAccountId,
      externalResourceId: `verified-evidence:${prepared.adapter.descriptor.id}:${sha256(
        lifecycle.operations,
      ).slice(0, 24)}`,
      ownership: prepared.account.ownership,
      requestAccepted: true,
      readBackVerified: true,
      fixture: this.options.fixture,
      observedAt: lifecycle.observedAt,
      grantId: prepared.grant.grantId,
      grantHash: prepared.grantHash,
      planDigest: prepared.planDigest,
      profileId: this.stackProfile.profileId,
      profileVersion: this.stackProfile.version,
      profileHash: prepared.profileHash,
      capabilityRole: prepared.role,
      concreteCapability: prepared.concreteCapability,
      accountHash: prepared.accountHash,
      providerPlanId: prepared.plan.id,
      providerPlanHash: prepared.providerPlanHash,
      providerRequestHash: prepared.providerRequestHash,
      invocationHash: prepared.invocationHash,
      bindingHash: prepared.bindingHash,
      budget: prepared.budget,
      launchBudget: this.preparedBudget!,
      lifecycle: {
        doctorStatus: lifecycle.doctorStatus,
        applyState: "applied",
        verificationState: "verified",
        operations: lifecycle.operations,
      },
    };
    const signature = createHmac("sha256", key).update(canonical(body)).digest("hex");
    return freeze({
      ...body,
      proof: {
        algorithm: "hmac-sha256",
        keyId: sha256(key),
        signature,
      },
    });
  }

  private async evidenceKey(create: boolean): Promise<Buffer> {
    try {
      const encoded = (await readFile(this.evidenceKeyPath, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(encoded)) {
        throw new ProviderLaunchEffectError(
          "Provider evidence key file is invalid",
          "evidence_invalid",
        );
      }
      return Buffer.from(encoded, "hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) {
        throw new ProviderLaunchEffectError(
          "Provider evidence key is unavailable",
          "evidence_invalid",
        );
      }
    }

    await mkdir(dirname(this.evidenceKeyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      const handle = await open(this.evidenceKeyPath, "wx", 0o600);
      try {
        await handle.writeFile(`${key.toString("hex")}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const encoded = (await readFile(this.evidenceKeyPath, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(encoded)) {
        throw new ProviderLaunchEffectError(
          "Provider evidence key file is invalid",
          "evidence_invalid",
        );
      }
      return Buffer.from(encoded, "hex");
    }
  }
}
