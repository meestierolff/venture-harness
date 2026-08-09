import {
  defineRuntimeSchema,
  objectValue,
  schemaObject,
  stringValue,
  type RuntimeSchema,
} from "@venture-harness/config";
import {
  CommandDefinitiveNoEffectError,
  defineCommandContract,
  type CommandBus,
  type CommandContract,
  type CommandHandlerContext,
} from "@venture-harness/command-bus";
import type { JsonObject, JsonValue } from "@venture-harness/core";

/**
 * Capability-specific provider commands intentionally depend on an injected
 * runtime boundary, not repository source or a fixture. The packaged runtime
 * therefore exposes the same typed surfaces while failing closed until a host
 * binds an authorized provider implementation.
 */

export const WINNER_PROVIDER_COMMAND_IDS = [
  "creative_generation",
  "tiktok_content_posting",
  "tiktok_spark_ads",
  "aggregated_attribution",
  "revenuecat",
] as const;
export type WinnerProviderCommandProviderId = (typeof WINNER_PROVIDER_COMMAND_IDS)[number];

export const WINNER_PROVIDER_COMMAND_FEATURES = [
  "creative.video.generate",
  "distribution.content.draft",
  "distribution.content.publish",
  "ads.organic_post.boost",
  "ads.campaign.pause",
  "attribution.campaign.read",
  "subscription.lifecycle.read",
] as const;
export type WinnerProviderCommandFeature = (typeof WINNER_PROVIDER_COMMAND_FEATURES)[number];

export const PROVIDER_COMMAND_ACTIONS = [
  "doctor",
  "plan",
  "dry_run",
  "apply",
  "status",
  "read_back",
  "reconcile",
] as const;
export type ProviderCommandAction = (typeof PROVIDER_COMMAND_ACTIONS)[number];

export type ProviderSelectionInput = JsonObject & {
  organizationId: string;
  providerId: WinnerProviderCommandProviderId;
  providerAccountId: string;
  feature: WinnerProviderCommandFeature;
};

export type ProviderOperationInput = ProviderSelectionInput & {
  operationId: string;
  providerIdempotencyKey: string;
  payload: JsonObject;
};

export type ProviderCommandInput = ProviderSelectionInput | ProviderOperationInput;

export type ProviderInvocationState = boolean | "unknown";

export interface ProviderCommandBoundaryResult extends JsonObject {
  status: string;
  providerInvoked: ProviderInvocationState;
  externalEffectOccurred: ProviderInvocationState;
  liveVerified: boolean;
  data: JsonObject;
}

export interface ProviderCommandResult extends JsonObject {
  commandId: string;
  action: ProviderCommandAction;
  organizationId: string;
  providerId: WinnerProviderCommandProviderId;
  feature: WinnerProviderCommandFeature;
  status: string;
  providerInvoked: ProviderInvocationState;
  externalEffectOccurred: ProviderInvocationState;
  liveVerified: boolean;
  data: JsonObject;
}

export interface ProviderCommandRuntime {
  execute(
    action: ProviderCommandAction,
    input: ProviderCommandInput,
    context: CommandHandlerContext,
  ): Promise<ProviderCommandBoundaryResult> | ProviderCommandBoundaryResult;
}

export interface ProviderLifecyclePlanShape {
  readonly adapterId: WinnerProviderCommandProviderId;
  readonly organizationId: string;
  readonly feature: WinnerProviderCommandFeature;
  readonly operationId: string;
  readonly requestHash: string;
}

export interface ProviderLifecycleAdapter<Context, Plan extends ProviderLifecyclePlanShape> {
  readonly transportKind: "official_api" | "official_sdk" | "contract_fixture" | null;
  readonly descriptor: {
    readonly id: WinnerProviderCommandProviderId;
    readonly features: readonly { readonly feature: WinnerProviderCommandFeature }[];
  };
  doctor(
    request: {
      readonly organizationId: string;
      readonly ventureId: string;
      readonly providerAccountId: string;
      readonly features: readonly WinnerProviderCommandFeature[];
    },
    context: Context,
  ): Promise<unknown>;
  plan(request: {
    readonly organizationId: string;
    readonly ventureId: string;
    readonly providerAccountId: string;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly feature: WinnerProviderCommandFeature;
    readonly payload: JsonObject;
  }): Plan;
  dryRun(plan: Plan): Promise<unknown>;
  apply(plan: Plan, context: Context): Promise<unknown>;
  readBack(plan: Plan, context: Context): Promise<unknown>;
  verify(plan: Plan, context: Context): Promise<unknown>;
  reconcile(plan: Plan, context: Context): Promise<unknown>;
  redact(value: unknown): unknown;
}

export interface ProviderLifecycleContextRequest<Plan extends ProviderLifecyclePlanShape> {
  readonly action: Exclude<ProviderCommandAction, "plan" | "dry_run">;
  readonly organizationId: string;
  readonly providerId: WinnerProviderCommandProviderId;
  readonly providerAccountId: string;
  readonly feature: WinnerProviderCommandFeature;
  readonly plan: Plan | null;
  readonly invocation: CommandHandlerContext;
}

export interface ProviderLifecycleCommandRuntimeOptions<
  Context,
  Plan extends ProviderLifecyclePlanShape,
> {
  readonly adapters: Readonly<
    Record<WinnerProviderCommandProviderId, ProviderLifecycleAdapter<Context, Plan>>
  >;
  /** Resolve broker references and exact grants from trusted server-side state. */
  readonly resolveContext: (
    request: ProviderLifecycleContextRequest<Plan>,
  ) => Promise<Context> | Context;
}

const PROVIDER_ID_VALUES = [...WINNER_PROVIDER_COMMAND_IDS];
const FEATURE_VALUES = [...WINNER_PROVIDER_COMMAND_FEATURES];
const ACTION_VALUES = [...PROVIDER_COMMAND_ACTIONS];
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:~-]{0,254}$/u;
const SECRET_KEY =
  /(?:authorization|api[-_]?key|secret|password|credential|access[-_]?token|refresh[-_]?token|upload[-_]?url)/iu;
const SECRET_VALUE =
  /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;
const SECRET_QUERY_KEY = /(?:token|signature|secret|key|authorization)/iu;

function exactObject(
  value: unknown,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  }
  return record;
}

function identifier(record: Record<string, unknown>, field: string): string {
  const value = stringValue(record, field)!;
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${field} must be a provider-safe identifier of at most 255 characters`);
  }
  return value;
}

function assertNoProviderSecrets(value: unknown, path = "value", allowRedacted = false): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoProviderSecrets(entry, `${path}[${index}]`, allowRedacted),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const isReference = /(?:^|_)(?:ref|reference)$/iu.test(key);
      if (SECRET_KEY.test(key) && !isReference && !(allowRedacted && entry === "[REDACTED]")) {
        throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
      }
      assertNoProviderSecrets(entry, `${path}.${key}`, allowRedacted);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (SECRET_VALUE.test(value)) throw new Error(`credential-like value is forbidden at ${path}`);
  try {
    const url = new URL(value);
    if ([...url.searchParams.keys()].some((key) => SECRET_QUERY_KEY.test(key))) {
      throw new Error(`signed or credential-bearing URL is forbidden at ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("signed or credential-bearing URL")) {
      throw error;
    }
    // Ordinary strings and non-URL references need no URL-specific validation.
  }
}

function parseSelection(value: unknown, name: string): ProviderSelectionInput {
  const input = exactObject(value, name, [
    "organizationId",
    "providerId",
    "providerAccountId",
    "feature",
  ]);
  const parsed = {
    organizationId: identifier(input, "organizationId"),
    providerId: stringValue(input, "providerId", {
      allowed: PROVIDER_ID_VALUES,
    }) as WinnerProviderCommandProviderId,
    providerAccountId: identifier(input, "providerAccountId"),
    feature: stringValue(input, "feature", {
      allowed: FEATURE_VALUES,
    }) as WinnerProviderCommandFeature,
  };
  assertNoProviderSecrets(parsed);
  return parsed;
}

function parseOperation(value: unknown, name: string): ProviderOperationInput {
  const input = exactObject(value, name, [
    "organizationId",
    "providerId",
    "providerAccountId",
    "feature",
    "operationId",
    "providerIdempotencyKey",
    "payload",
  ]);
  const parsed: ProviderOperationInput = {
    organizationId: identifier(input, "organizationId"),
    providerId: stringValue(input, "providerId", {
      allowed: PROVIDER_ID_VALUES,
    }) as WinnerProviderCommandProviderId,
    providerAccountId: identifier(input, "providerAccountId"),
    feature: stringValue(input, "feature", {
      allowed: FEATURE_VALUES,
    }) as WinnerProviderCommandFeature,
    operationId: identifier(input, "operationId"),
    providerIdempotencyKey: identifier(input, "providerIdempotencyKey"),
    payload: objectValue(input.payload, "payload") as JsonObject,
  };
  assertNoProviderSecrets(parsed);
  return parsed;
}

const selectionInput = defineRuntimeSchema<ProviderSelectionInput>({
  name: "ProviderSelectionInput",
  jsonSchema: schemaObject(
    {
      organizationId: { type: "string", minLength: 1, maxLength: 255 },
      providerId: { type: "string", enum: PROVIDER_ID_VALUES },
      providerAccountId: { type: "string", minLength: 1, maxLength: 255 },
      feature: { type: "string", enum: FEATURE_VALUES },
    },
    ["organizationId", "providerId", "providerAccountId", "feature"],
  ),
  parse(value) {
    return parseSelection(value, "ProviderSelectionInput");
  },
});

const operationInput = defineRuntimeSchema<ProviderOperationInput>({
  name: "ProviderOperationInput",
  jsonSchema: schemaObject(
    {
      organizationId: { type: "string", minLength: 1, maxLength: 255 },
      providerId: { type: "string", enum: PROVIDER_ID_VALUES },
      providerAccountId: { type: "string", minLength: 1, maxLength: 255 },
      feature: { type: "string", enum: FEATURE_VALUES },
      operationId: { type: "string", minLength: 1, maxLength: 255 },
      providerIdempotencyKey: { type: "string", minLength: 1, maxLength: 255 },
      payload: { type: "object" },
    },
    [
      "organizationId",
      "providerId",
      "providerAccountId",
      "feature",
      "operationId",
      "providerIdempotencyKey",
      "payload",
    ],
  ),
  parse(value) {
    return parseOperation(value, "ProviderOperationInput");
  },
});

function providerOutput(commandId: string): RuntimeSchema<ProviderCommandResult> {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject(
      {
        commandId: { const: commandId },
        action: { type: "string", enum: ACTION_VALUES },
        organizationId: { type: "string", minLength: 1, maxLength: 255 },
        providerId: { type: "string", enum: PROVIDER_ID_VALUES },
        feature: { type: "string", enum: FEATURE_VALUES },
        status: { type: "string", minLength: 1 },
        providerInvoked: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
        externalEffectOccurred: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
        liveVerified: { type: "boolean" },
        data: { type: "object" },
      },
      [
        "commandId",
        "action",
        "organizationId",
        "providerId",
        "feature",
        "status",
        "providerInvoked",
        "externalEffectOccurred",
        "liveVerified",
        "data",
      ],
    ),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "action",
        "organizationId",
        "providerId",
        "feature",
        "status",
        "providerInvoked",
        "externalEffectOccurred",
        "liveVerified",
        "data",
      ]);
      if (output.commandId !== commandId) throw new Error(`invalid ${commandId} output`);
      const providerInvoked = output.providerInvoked;
      const externalEffectOccurred = output.externalEffectOccurred;
      if (typeof providerInvoked !== "boolean" && providerInvoked !== "unknown") {
        throw new Error("providerInvoked must be boolean or unknown");
      }
      if (typeof externalEffectOccurred !== "boolean" && externalEffectOccurred !== "unknown") {
        throw new Error("externalEffectOccurred must be boolean or unknown");
      }
      if (typeof output.liveVerified !== "boolean") {
        throw new Error("liveVerified must be boolean");
      }
      const data = objectValue(output.data, "data") as JsonObject;
      assertNoProviderSecrets(data, "data", true);
      return {
        commandId,
        action: stringValue(output, "action", { allowed: ACTION_VALUES }) as ProviderCommandAction,
        organizationId: identifier(output, "organizationId"),
        providerId: stringValue(output, "providerId", {
          allowed: PROVIDER_ID_VALUES,
        }) as WinnerProviderCommandProviderId,
        feature: stringValue(output, "feature", {
          allowed: FEATURE_VALUES,
        }) as WinnerProviderCommandFeature,
        status: stringValue(output, "status")!,
        providerInvoked,
        externalEffectOccurred,
        liveVerified: output.liveVerified,
        data,
      };
    },
  });
}

function providerCommand<Input extends ProviderCommandInput>(definition: {
  id: string;
  title: string;
  description: string;
  input: RuntimeSchema<Input>;
  grant: boolean;
  scopes: readonly string[];
  effect: "read" | "write";
}): CommandContract<Input, ProviderCommandResult> {
  const { grant, scopes, ...contract } = definition;
  return defineCommandContract({
    ...contract,
    version: 2,
    output: providerOutput(definition.id),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant,
      scopes,
    },
  });
}

export const providerDoctorCommand = providerCommand({
  id: "provider.doctor",
  title: "Inspect Provider Capability",
  description:
    "Inspect one exact Winner provider capability through an injected official transport; default is unconfigured and makes no request.",
  input: selectionInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "read",
});

export const providerPlanCommand = providerCommand({
  id: "provider.plan",
  title: "Plan Provider Operation",
  description:
    "Build an immutable capability-specific provider plan without allowing external execution.",
  input: operationInput,
  grant: false,
  scopes: [],
  effect: "read",
});

export const providerDryRunCommand = providerCommand({
  id: "provider.dry-run",
  title: "Dry Run Provider Operation",
  description:
    "Exercise provider plan validation without invoking a provider or creating an effect.",
  input: operationInput,
  grant: false,
  scopes: [],
  effect: "read",
});

export const providerApplyCommand = providerCommand({
  id: "provider.apply",
  title: "Apply Authorized Provider Operation",
  description:
    "Apply once only through an injected official transport, exact grants, and durable atomic operation storage.",
  input: operationInput,
  grant: true,
  scopes: ["provider.apply"],
  effect: "write",
});

export const providerStatusCommand = providerCommand({
  id: "provider.status",
  title: "Verify Provider Operation Status",
  description:
    "Read and verify provider operation status without replaying the original provider mutation.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write",
});

export const providerReadBackCommand = providerCommand({
  id: "provider.read-back",
  title: "Read Back Provider Operation",
  description:
    "Read exact provider state back and validate capability-specific completion invariants.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write",
});

export const providerReconcileCommand = providerCommand({
  id: "provider.reconcile",
  title: "Reconcile Provider Operation",
  description:
    "Reconcile an unresolved provider operation by immutable request hash without reapplying it.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write",
});

export const providerOperationCommandContracts = [
  providerDoctorCommand,
  providerPlanCommand,
  providerDryRunCommand,
  providerApplyCommand,
  providerStatusCommand,
  providerReadBackCommand,
  providerReconcileCommand,
] as const;

function jsonObjectFromAdapter(
  adapter: ProviderLifecycleAdapter<unknown, ProviderLifecyclePlanShape>,
  value: unknown,
  field: string,
): JsonObject {
  const redacted = adapter.redact(value);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined) throw new Error(`${field} is not JSON serializable`);
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  assertNoProviderSecrets(parsed, field, true);
  return parsed as JsonObject;
}

function lifecycleFailure(
  status: string,
  code: string,
  message: string,
  nextAction: string,
  providerInvoked: ProviderInvocationState,
): ProviderCommandBoundaryResult {
  return {
    status,
    providerInvoked,
    externalEffectOccurred: providerInvoked === false ? false : "unknown",
    liveVerified: false,
    data: { diagnostic: { code, message, nextAction } },
  };
}

function invocationState(
  record: JsonObject,
  field: "providerInvoked" | "externalEffectOccurred",
  fallback: ProviderInvocationState,
): ProviderInvocationState {
  const value = record[field];
  return typeof value === "boolean" || value === "unknown" ? value : fallback;
}

function lifecycleResult(
  action: ProviderCommandAction,
  adapter: ProviderLifecycleAdapter<unknown, ProviderLifecyclePlanShape>,
  raw: unknown,
  plan: ProviderLifecyclePlanShape | null,
): ProviderCommandBoundaryResult {
  const result = jsonObjectFromAdapter(adapter, raw, "providerResult");
  const providerInvoked = invocationState(
    result,
    "providerInvoked",
    action === "plan" || action === "dry_run" ? false : "unknown",
  );
  const externalEffectOccurred = invocationState(
    result,
    "externalEffectOccurred",
    action === "apply" ? "unknown" : false,
  );
  const state = result.status ?? result.state;
  const status = typeof state === "string" && state.trim() ? state : `${action}_complete`;
  const data: JsonObject = { result };
  if (plan) data.plan = jsonObjectFromAdapter(adapter, plan, "providerPlan");
  return {
    status,
    providerInvoked,
    externalEffectOccurred,
    liveVerified: result.liveVerified === true,
    data,
  };
}

/**
 * Bind the generated command surfaces to the production provider lifecycle.
 * Context resolution stays host-owned so credential broker references and
 * authorization envelopes never become command input or generated UI state.
 */
export function createProviderLifecycleCommandRuntime<
  Context,
  Plan extends ProviderLifecyclePlanShape,
>(options: ProviderLifecycleCommandRuntimeOptions<Context, Plan>): ProviderCommandRuntime {
  const runtime: ProviderCommandRuntime = {
    async execute(
      action: ProviderCommandAction,
      input: ProviderCommandInput,
      invocation: CommandHandlerContext,
    ): Promise<ProviderCommandBoundaryResult> {
      if (input.organizationId !== invocation.context.tenant.organizationId) {
        return lifecycleFailure(
          "tenant_mismatch",
          "provider_tenant_mismatch",
          "Provider input organization does not match the authenticated command tenant",
          "Use the authenticated organization and resolve its provider grants server-side",
          false,
        );
      }
      const adapter = options.adapters[input.providerId];
      const supportsFeature = adapter.descriptor.features.some(
        ({ feature }) => feature === input.feature,
      );
      if (!supportsFeature) {
        return lifecycleFailure(
          "unsupported_feature",
          "provider_capability_mismatch",
          `${input.providerId} does not implement ${input.feature}`,
          "Select the provider bound to this exact capability in the active Stack Profile",
          false,
        );
      }

      if (action === "doctor") {
        let context: Context;
        try {
          context = await options.resolveContext({
            action,
            organizationId: input.organizationId,
            providerId: input.providerId,
            providerAccountId: input.providerAccountId,
            feature: input.feature,
            plan: null,
            invocation,
          });
        } catch {
          return lifecycleFailure(
            "context_unavailable",
            "provider_context_unavailable",
            "The trusted provider context could not be resolved",
            "Configure broker references and exact active grants without placing values in input",
            false,
          );
        }
        try {
          const raw = await adapter.doctor(
            {
              organizationId: input.organizationId,
              ventureId: invocation.context.tenant.ventureId,
              providerAccountId: input.providerAccountId,
              features: [input.feature],
            },
            context,
          );
          return lifecycleResult(
            action,
            adapter as ProviderLifecycleAdapter<unknown, ProviderLifecyclePlanShape>,
            raw,
            null,
          );
        } catch {
          return lifecycleFailure(
            "doctor_failed",
            "provider_doctor_failed",
            "Provider doctor failed without verified readiness evidence",
            "Inspect redacted server-side diagnostics before another bounded doctor call",
            "unknown",
          );
        }
      }

      if (
        !("operationId" in input) ||
        !("providerIdempotencyKey" in input) ||
        !("payload" in input)
      ) {
        return lifecycleFailure(
          "invalid_request",
          "operation_input_missing",
          `${action} requires operationId, providerIdempotencyKey, and payload`,
          "Supply the exact immutable operation input",
          false,
        );
      }
      const operationInput = input as ProviderOperationInput;

      let plan: Plan;
      try {
        plan = adapter.plan({
          organizationId: input.organizationId,
          ventureId: invocation.context.tenant.ventureId,
          providerAccountId: input.providerAccountId,
          operationId: operationInput.operationId,
          idempotencyKey: operationInput.providerIdempotencyKey,
          feature: input.feature,
          payload: operationInput.payload,
        });
      } catch {
        return lifecycleFailure(
          "invalid_request",
          "provider_plan_invalid",
          "The capability-specific provider plan rejected this input",
          "Correct the immutable payload against the selected provider contract",
          false,
        );
      }

      const unknownAdapter = adapter as ProviderLifecycleAdapter<
        unknown,
        ProviderLifecyclePlanShape
      >;
      if (action === "plan") {
        return {
          status: "planned",
          providerInvoked: false,
          externalEffectOccurred: false,
          liveVerified: false,
          data: { plan: jsonObjectFromAdapter(unknownAdapter, plan, "providerPlan") },
        };
      }
      if (action === "dry_run") {
        try {
          return lifecycleResult(action, unknownAdapter, await adapter.dryRun(plan), plan);
        } catch {
          return lifecycleFailure(
            "dry_run_failed",
            "provider_dry_run_failed",
            "Provider dry run failed before external execution",
            "Correct the local plan; no provider call should be retried",
            false,
          );
        }
      }

      if (
        action === "apply" &&
        adapter.transportKind !== "official_api" &&
        adapter.transportKind !== "official_sdk"
      ) {
        return lifecycleFailure(
          "official_transport_required",
          "official_transport_required",
          "Provider apply requires an explicitly injected official API or SDK transport",
          "Configure the official transport; contract fixtures are limited to lower-level tests",
          false,
        );
      }

      let context: Context;
      try {
        context = await options.resolveContext({
          action,
          organizationId: input.organizationId,
          providerId: input.providerId,
          providerAccountId: input.providerAccountId,
          feature: input.feature,
          plan,
          invocation,
        });
      } catch {
        return lifecycleFailure(
          "context_unavailable",
          "provider_context_unavailable",
          "The trusted provider context could not be resolved",
          "Configure broker references and exact active grants without placing values in input",
          false,
        );
      }

      try {
        const raw =
          action === "apply"
            ? await adapter.apply(plan, context)
            : action === "status"
              ? await adapter.verify(plan, context)
              : action === "read_back"
                ? await adapter.readBack(plan, context)
                : await adapter.reconcile(plan, context);
        return lifecycleResult(action, unknownAdapter, raw, plan);
      } catch {
        return lifecycleFailure(
          "provider_outcome_unknown",
          "provider_runtime_failed",
          "The provider lifecycle failed without a verified outcome",
          "Reconcile the immutable request before any attempt to apply again",
          "unknown",
        );
      }
    },
  };
  return Object.freeze(runtime);
}

function unconfiguredResult(
  action: ProviderCommandAction,
  input: ProviderCommandInput,
): ProviderCommandBoundaryResult {
  return {
    status: "unconfigured",
    providerInvoked: false,
    externalEffectOccurred: false,
    liveVerified: false,
    data: {
      organizationId: input.organizationId,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      feature: input.feature,
      action,
      externalRequestMade: false,
      fixtureFallbackUsed: false,
      diagnostic: {
        code: "transport_missing",
        message: "No authorized Winner provider runtime is injected",
        nextAction:
          "Bind an official provider transport, broker reference, grants, and durable operation store",
      },
    },
  };
}

export const unconfiguredProviderCommandRuntime: ProviderCommandRuntime = Object.freeze({
  execute: unconfiguredResult,
});

function commandResult(
  commandId: string,
  action: ProviderCommandAction,
  input: ProviderCommandInput,
  boundary: ProviderCommandBoundaryResult,
): ProviderCommandResult {
  return {
    commandId,
    action,
    organizationId: input.organizationId,
    providerId: input.providerId,
    feature: input.feature,
    status: boundary.status,
    providerInvoked: boundary.providerInvoked,
    externalEffectOccurred: boundary.externalEffectOccurred,
    liveVerified: boundary.liveVerified,
    data: boundary.data,
  };
}

function register<Input extends ProviderCommandInput>(
  bus: CommandBus,
  runtime: ProviderCommandRuntime,
  contract: CommandContract<Input, ProviderCommandResult>,
  action: ProviderCommandAction,
): void {
  bus.register(contract, async (input, handler) => {
    let boundary: ProviderCommandBoundaryResult;
    try {
      boundary = await runtime.execute(action, input, handler);
    } catch {
      throw new Error(
        "The injected provider runtime failed without a verified outcome; reconcile before retry",
      );
    }
    const direct = boundary.data.diagnostic;
    const nested =
      boundary.data.result &&
      typeof boundary.data.result === "object" &&
      !Array.isArray(boundary.data.result)
        ? (boundary.data.result as JsonObject).diagnostic
        : undefined;
    const diagnostic = direct ?? nested;
    const failureStatuses = new Set([
      "unconfigured",
      "tenant_mismatch",
      "unsupported_feature",
      "context_unavailable",
      "invalid_request",
      "dry_run_failed",
      "doctor_failed",
      "official_transport_required",
      "provider_outcome_unknown",
      "runtime_failed",
      "blocked",
      "failed",
      "idempotency_conflict",
    ]);
    if (
      failureStatuses.has(boundary.status) &&
      diagnostic &&
      typeof diagnostic === "object" &&
      !Array.isArray(diagnostic)
    ) {
      const record = diagnostic as JsonObject;
      const code = typeof record.code === "string" ? record.code : "provider_command_failed";
      const message =
        typeof record.message === "string"
          ? record.message
          : "The provider command did not complete successfully";
      const failure = `${code}: ${message}`;
      if (boundary.externalEffectOccurred === false) {
        throw new CommandDefinitiveNoEffectError(failure, "handler_failed");
      }
      throw new Error(failure);
    }
    return commandResult(contract.id, action, input, boundary);
  });
}

export function registerProviderOperationCommands(
  bus: CommandBus,
  runtime: ProviderCommandRuntime = unconfiguredProviderCommandRuntime,
): void {
  register(bus, runtime, providerDoctorCommand, "doctor");
  register(bus, runtime, providerPlanCommand, "plan");
  register(bus, runtime, providerDryRunCommand, "dry_run");
  register(bus, runtime, providerApplyCommand, "apply");
  register(bus, runtime, providerStatusCommand, "status");
  register(bus, runtime, providerReadBackCommand, "read_back");
  register(bus, runtime, providerReconcileCommand, "reconcile");
}

export function providerCommandInputFor(commandId: string): RuntimeSchema<JsonObject> | null {
  const contract = providerOperationCommandContracts.find(({ id }) => id === commandId);
  return (contract?.input as RuntimeSchema<JsonObject> | undefined) ?? null;
}

export type ProviderCommandJsonValue = JsonValue;
