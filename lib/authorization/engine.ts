import type { z } from "zod";
import {
  authorizationEnvelopeSchema,
  authorizationProfileIdSchema,
  type AuthorizationEnvelope,
  type PoliciesConfig,
} from "../config/policy-schema";
import type { ProviderOperation } from "../providers";
import {
  assertConsumedCheckpointGrant,
  CheckpointGrantError,
  type AuthorizationSideEffect,
  type OneShotCheckpointGrant,
} from "./checkpoint-grant";

export type AuthorizationProfileId = z.infer<typeof authorizationProfileIdSchema>;

export interface IssueEnvelopeInput {
  runId: string;
  profile: string;
  providers: string[];
  environments: Array<"local" | "test" | "preview" | "production">;
  capabilities?: string[];
  policies: PoliciesConfig;
  approvalRef: string;
  now?: Date;
  ttlMs?: number;
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "profile_unknown"
      | "envelope_expired"
      | "provider_forbidden"
      | "environment_forbidden"
      | "capability_forbidden"
      | "effect_forbidden"
      | "risk_forbidden"
      | "distinct_checkpoint_required"
      | "checkpoint_grant_invalid"
      | "operation_effect_unknown"
      | "operation_effect_mismatch"
      | "permission_flag_required"
      | "spend_estimate_invalid"
      | "spend_estimate_required"
      | "spend_currency_mismatch"
      | "spend_limit_exceeded"
      | "recipient_count_invalid"
      | "recipient_count_required"
      | "recipient_limit_exceeded",
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function canonicalProfile(value: string): string {
  return value.replaceAll("-", "_");
}

export function issueAuthorizationEnvelope(input: IssueEnvelopeInput): AuthorizationEnvelope {
  const profileName = canonicalProfile(input.profile);
  const parsedProfile = authorizationProfileIdSchema.safeParse(profileName);
  if (!parsedProfile.success) {
    throw new AuthorizationError(
      `Unknown authorization profile "${input.profile}".`,
      "profile_unknown",
    );
  }
  const profileId = parsedProfile.data;
  const profile = input.policies.authorization.profiles[profileId];
  const unsupportedEnvironments = input.environments.filter(
    (environment) => !profile.allowed_environments.includes(environment),
  );
  if (unsupportedEnvironments.length > 0) {
    throw new AuthorizationError(
      `${profileId} does not allow environment(s): ${unsupportedEnvironments.join(", ")}.`,
      "environment_forbidden",
    );
  }
  const now = input.now ?? new Date();
  const expires = new Date(now.getTime() + (input.ttlMs ?? 60 * 60 * 1000));
  const requestedCapabilities = input.capabilities
    ? [...new Set(input.capabilities)].sort()
    : undefined;
  if (requestedCapabilities?.includes("*")) {
    throw new AuthorizationError(
      "A graph-scoped authorization request must name exact capabilities, not wildcard '*'.",
      "capability_forbidden",
    );
  }
  if (requestedCapabilities && !profile.allowed_capabilities.includes("*")) {
    const unsupported = requestedCapabilities.filter(
      (capability) => !profile.allowed_capabilities.includes(capability),
    );
    if (unsupported.length > 0) {
      throw new AuthorizationError(
        `${profileId} does not allow graph capability/capabilities: ${unsupported.join(", ")}.`,
        "capability_forbidden",
      );
    }
  }
  return authorizationEnvelopeSchema.parse({
    run_id: input.runId,
    profile: profileId,
    allowed_capabilities: requestedCapabilities ?? profile.allowed_capabilities,
    allowed_side_effect_classes: profile.allowed_side_effect_classes,
    providers: input.providers,
    environments: input.environments,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    max_estimated_spend: profile.max_estimated_spend,
    unknown_external_costs_allowed: profile.unknown_external_costs_allowed,
    max_email_recipients: profile.max_email_recipients,
    production_deploy_allowed: profile.production_deploy_allowed,
    live_products_and_prices_allowed: profile.live_products_and_prices_allowed,
    actual_charges_allowed: profile.actual_charges_allowed,
    transactional_test_email_allowed: profile.transactional_test_email_allowed,
    dns_additions_allowed: profile.dns_additions_allowed,
    nameserver_changes_allowed: profile.nameserver_changes_allowed,
    app_store_submission_allowed: profile.app_store_submission_allowed,
    explicitly_forbidden_actions:
      input.policies.authorization.always_require_distinct_checkpoint_for,
    approval_ref: input.approvalRef,
    extensions: {},
  });
}

type SideEffectClass = AuthorizationEnvelope["allowed_side_effect_classes"][number];
type RiskClass = "low" | "moderate" | "high" | "critical";

interface ClassifiedOperationEffect {
  effect: SideEffectClass;
  allowedProviderEffects: readonly ProviderOperation["effectClass"][];
  reason: string;
}

function classified(
  effect: SideEffectClass,
  reason: string,
  ...allowedProviderEffects: ProviderOperation["effectClass"][]
): ClassifiedOperationEffect {
  return { effect, reason, allowedProviderEffects };
}

function operationEffect(operation: ProviderOperation): ClassifiedOperationEffect {
  const action = operation.action.toLowerCase();
  const actionParts = new Set(action.split(/[._:-]+/));
  const hasAnyPart = (...parts: string[]) => parts.some((part) => actionParts.has(part));
  const writesDataDestructively =
    hasAnyPart("truncate", "drop", "purge") ||
    action.includes("destructive_data") ||
    action.includes("data.destroy");
  if (action.includes("nameserver")) {
    return classified(
      "nameserver_change",
      "the action changes authoritative nameservers",
      "irreversible_external",
      "manual",
    );
  }
  if (writesDataDestructively) {
    return classified(
      "destructive_data_change",
      "the action destructively changes stored data or schema",
      "irreversible_external",
      "manual",
    );
  }
  if (hasAnyPart("delete", "remove", "destroy")) {
    return classified(
      "external_delete",
      "the action deletes an external resource",
      "irreversible_external",
      "manual",
    );
  }
  if (
    action.includes("app_store.release") ||
    action.includes("app_store.publish") ||
    (operation.provider === "app_store_connect" && hasAnyPart("release", "publish", "publication"))
  ) {
    return classified(
      "app_store_publication",
      "the action publishes an App Store release",
      "irreversible_external",
      "manual",
    );
  }
  if (
    action === "ios.submit" ||
    action.includes("testflight.upload") ||
    action.includes("build.submit")
  ) {
    return classified(
      "testflight_upload",
      "the action submits a build for TestFlight processing",
      "reversible_external",
      "irreversible_external",
      "manual",
    );
  }
  if (hasAnyPart("charge", "capture") || action.includes("payment_intent")) {
    return classified(
      operation.environment === "production" ? "customer_charge" : "reversible_external_write",
      "the action creates or captures a customer payment",
      "financial",
    );
  }
  const isFinancialConfiguration =
    (operation.provider === "stripe" &&
      (hasAnyPart("product", "price") || action.includes("billing_portal.configuration"))) ||
    (operation.provider === "revenuecat" && hasAnyPart("app", "entitlement", "offering"));
  if (isFinancialConfiguration) {
    return classified(
      operation.environment === "production" ? "live_commerce_config" : "reversible_external_write",
      "the action configures products, prices, billing, or entitlements",
      "financial",
    );
  }
  if (action.includes("deployment.production")) {
    return classified(
      "production_deploy",
      "the action creates a production deployment",
      "reversible_external",
      "irreversible_external",
    );
  }
  if (action.includes("deployment.preview")) {
    return classified(
      "preview_deploy",
      "the action creates a preview deployment",
      "reversible_external",
      "irreversible_external",
    );
  }
  if (
    (operation.provider === "dns" || operation.provider === "mijndomein") &&
    (action.includes("dns") || action.includes("record"))
  ) {
    return classified(
      "dns_addition",
      "the action adds or changes an individual DNS record",
      "reversible_external",
      "manual",
    );
  }
  if (operation.provider === "mijndomein" && action.includes("domain.attach")) {
    return classified(
      "dns_addition",
      "the manual domain attachment changes individual DNS records",
      "manual",
    );
  }
  if (operation.provider === "vercel" && action === "web_analytics.enable_manual") {
    return classified(
      "reversible_external_write",
      "the manual dashboard action enables project analytics without publishing or sending data",
      "manual",
    );
  }
  const sendsCommunication = hasAnyPart("send", "email", "message", "deliver");
  if (sendsCommunication) {
    const bulk = hasAnyPart("bulk", "campaign", "broadcast", "cold");
    return classified(
      bulk ? "bulk_communication" : "transactional_email",
      bulk ? "the action sends a bulk communication" : "the action sends transactional email",
      "communication",
    );
  }
  const configuresCommunication =
    action.includes("webhook") ||
    action.includes("sending_domain") ||
    action.startsWith("sender.") ||
    action.startsWith("template.") ||
    action.includes("beta_review_details");
  if (configuresCommunication) {
    return classified(
      "reversible_external_write",
      "the action configures communication metadata without sending",
      "communication",
    );
  }
  if (
    operation.effectClass === "local_write" &&
    (action === "project.link" || hasAnyPart("local", "file", "generate"))
  ) {
    return classified("local_write", "the action writes only local state", "local_write");
  }
  if (operation.provider === "github" && action === "repository.create_from_source") {
    return classified(
      "reversible_external_write",
      "the action creates or reconciles a GitHub repository branch to an exact locally verified source tree",
      "reversible_external",
    );
  }
  const writesExternalState = hasAnyPart(
    "add",
    "attach",
    "bootstrap",
    "build",
    "change",
    "confirm",
    "create",
    "migrate",
    "set",
    "submit",
    "update",
    "write",
  );
  if (writesExternalState) {
    if (operation.transport === "manual") {
      return classified(
        "reversible_external_write",
        "the manual action creates or changes external state",
        "manual",
      );
    }
    if (operation.effectClass === "irreversible_external") {
      throw new AuthorizationError(
        `Cannot classify irreversible action "${operation.action}". Add a precise destructive, publication, TestFlight, or reversible action mapping before authorizing it.`,
        "operation_effect_unknown",
      );
    }
    return classified(
      "reversible_external_write",
      "the action creates or changes external state",
      "reversible_external",
    );
  }
  const readsExternalState = hasAnyPart(
    "check",
    "get",
    "inspect",
    "list",
    "read",
    "status",
    "view",
  );
  if (readsExternalState) {
    return classified("external_read", "the action only reads external state", "read");
  }
  switch (operation.effectClass) {
    case "read":
      return classified("external_read", "the provider declares a read", "read");
    case "local_write":
      throw new AuthorizationError(
        `Cannot classify local write action "${operation.action}". Local provider writes need an explicit local action mapping.`,
        "operation_effect_unknown",
      );
    case "reversible_external":
      return classified(
        "reversible_external_write",
        "the provider declares a reversible external write",
        "reversible_external",
      );
    case "irreversible_external":
      throw new AuthorizationError(
        `Cannot classify irreversible action "${operation.action}". Add a precise destructive, publication, TestFlight, or reversible action mapping before authorizing it.`,
        "operation_effect_unknown",
      );
    case "financial":
      throw new AuthorizationError(
        `Cannot classify financial action "${operation.action}". Add an explicit commerce or charge action mapping before authorizing it.`,
        "operation_effect_unknown",
      );
    case "communication":
      throw new AuthorizationError(
        `Cannot classify communication action "${operation.action}". Distinguish configuration from an actual send before authorizing it.`,
        "operation_effect_unknown",
      );
    case "manual":
      throw new AuthorizationError(
        `Cannot classify manual action "${operation.action}". Add a precise action mapping before authorizing it.`,
        "operation_effect_unknown",
      );
  }
}

function assertEffectConsistency(
  operation: ProviderOperation,
  classification: ClassifiedOperationEffect,
): void {
  if (classification.allowedProviderEffects.includes(operation.effectClass)) return;
  throw new AuthorizationError(
    `Action "${operation.action}" is classified as ${classification.effect} because ${classification.reason}, but it declares provider effect ${operation.effectClass}. Expected ${classification.allowedProviderEffects.join(" or ")}.`,
    "operation_effect_mismatch",
  );
}

const PERMISSION_FLAG_BY_EFFECT = {
  production_deploy: "production_deploy_allowed",
  live_commerce_config: "live_products_and_prices_allowed",
  customer_charge: "actual_charges_allowed",
  transactional_email: "transactional_test_email_allowed",
  dns_addition: "dns_additions_allowed",
  nameserver_change: "nameserver_changes_allowed",
  app_store_publication: "app_store_submission_allowed",
} as const satisfies Partial<Record<SideEffectClass, keyof AuthorizationEnvelope>>;

function assertPermissionFlag(
  envelope: AuthorizationEnvelope,
  operation: ProviderOperation,
  effect: SideEffectClass,
): void {
  const flag = PERMISSION_FLAG_BY_EFFECT[effect as keyof typeof PERMISSION_FLAG_BY_EFFECT];
  if (!flag || envelope[flag] === true) return;
  throw new AuthorizationError(
    `${flag}=false blocks ${effect} action "${operation.action}" in ${envelope.profile}.`,
    "permission_flag_required",
  );
}

function assertSpendWithinEnvelope(
  envelope: AuthorizationEnvelope,
  operation: ProviderOperation,
  effect: SideEffectClass,
): void {
  const estimate = operation.estimatedCost;
  if (!estimate) {
    if (effect === "customer_charge") {
      throw new AuthorizationError(
        `Customer charge action "${operation.action}" needs an estimatedCost before authorization.`,
        "spend_estimate_invalid",
      );
    }
    const externalWrite = !["none", "local_write", "git_write", "external_read"].includes(effect);
    if (externalWrite && !envelope.unknown_external_costs_allowed) {
      throw new AuthorizationError(
        `External write action "${operation.action}" needs an estimatedCost or an explicit unknown_external_costs_allowed policy exception.`,
        "spend_estimate_required",
      );
    }
    return;
  }
  if (
    !Number.isFinite(estimate.amount) ||
    estimate.amount < 0 ||
    !/^[A-Z]{3}$/.test(estimate.currency)
  ) {
    throw new AuthorizationError(
      `Action "${operation.action}" has an invalid estimatedCost; use a non-negative finite amount and uppercase ISO-4217 currency.`,
      "spend_estimate_invalid",
    );
  }
  if (estimate.currency !== envelope.max_estimated_spend.currency) {
    throw new AuthorizationError(
      `Action "${operation.action}" estimates ${estimate.currency}, but the run ceiling is denominated in ${envelope.max_estimated_spend.currency}; no currency conversion is authorized.`,
      "spend_currency_mismatch",
    );
  }
  if (estimate.amount > envelope.max_estimated_spend.amount) {
    throw new AuthorizationError(
      `Action "${operation.action}" estimates ${estimate.amount} ${estimate.currency}, exceeding the run ceiling of ${envelope.max_estimated_spend.amount} ${envelope.max_estimated_spend.currency}.`,
      "spend_limit_exceeded",
    );
  }
}

function assertRecipientsWithinEnvelope(
  envelope: AuthorizationEnvelope,
  operation: ProviderOperation,
  effect: SideEffectClass,
): void {
  const recipients = operation.emailRecipientCount;
  const sendsEmail = effect === "transactional_email" || effect === "bulk_communication";
  if (recipients === undefined) {
    if (sendsEmail) {
      throw new AuthorizationError(
        `Email action "${operation.action}" needs an exact emailRecipientCount before authorization.`,
        "recipient_count_required",
      );
    }
    return;
  }
  if (!Number.isInteger(recipients) || recipients < 0) {
    throw new AuthorizationError(
      `Action "${operation.action}" has invalid emailRecipientCount ${String(recipients)}; use a non-negative integer.`,
      "recipient_count_invalid",
    );
  }
  if (!sendsEmail) {
    throw new AuthorizationError(
      `Action "${operation.action}" declares email recipients but is classified as ${effect}, not an email send.`,
      "operation_effect_mismatch",
    );
  }
  if (recipients === 0) {
    throw new AuthorizationError(
      `Email action "${operation.action}" must name at least one recipient.`,
      "recipient_count_invalid",
    );
  }
  if (recipients > envelope.max_email_recipients) {
    throw new AuthorizationError(
      `Email action "${operation.action}" targets ${recipients} recipients, exceeding the run ceiling of ${envelope.max_email_recipients}.`,
      "recipient_limit_exceeded",
    );
  }
}

function operationEnvironment(
  operation: ProviderOperation,
): AuthorizationEnvelope["environments"][number] {
  if (operation.environment === "sandbox") return "test";
  if (operation.environment === "testflight") return "production";
  return operation.environment;
}

function operationRisk(operation: ProviderOperation): RiskClass {
  return operation.riskClass === "medium" ? "moderate" : operation.riskClass;
}

function assertEnvelopeScope(
  envelope: AuthorizationEnvelope,
  operation: ProviderOperation,
  now: Date,
): void {
  if (Date.parse(envelope.expires_at) <= now.getTime()) {
    throw new AuthorizationError(
      `Authorization envelope for ${envelope.run_id} expired at ${envelope.expires_at}.`,
      "envelope_expired",
    );
  }
  if (!envelope.providers.includes(operation.provider)) {
    throw new AuthorizationError(
      `${operation.provider} is outside the run authorization envelope.`,
      "provider_forbidden",
    );
  }
  const environment = operationEnvironment(operation);
  if (!envelope.environments.includes(environment)) {
    throw new AuthorizationError(
      `${operation.environment} is outside the run authorization envelope.`,
      "environment_forbidden",
    );
  }
  if (
    !envelope.allowed_capabilities.includes("*") &&
    !envelope.allowed_capabilities.includes(operation.capability)
  ) {
    throw new AuthorizationError(
      `${operation.capability} is outside the run authorization envelope.`,
      "capability_forbidden",
    );
  }
}

function requiresDistinctCheckpoint(
  envelope: AuthorizationEnvelope,
  policies: PoliciesConfig,
  effect: SideEffectClass,
): boolean {
  return new Set([
    ...policies.authorization.always_require_distinct_checkpoint_for,
    ...envelope.explicitly_forbidden_actions,
  ]).has(effect);
}

export interface OperationAuthorizationInspection {
  effect: AuthorizationSideEffect;
  checkpointRequired: boolean;
}

/**
 * Performs every deterministic authorization check that can run before a
 * one-shot checkpoint is claimed. A configured distinct checkpoint replaces
 * only the inherited effect allowlist and its boolean permission flag; it does
 * not widen provider, environment, capability, risk, spend, or recipient scope.
 */
export function inspectOperationAuthorization(
  envelope: AuthorizationEnvelope,
  operation: ProviderOperation,
  policies: PoliciesConfig,
  now = new Date(),
): OperationAuthorizationInspection {
  assertEnvelopeScope(envelope, operation, now);
  const classification = operationEffect(operation);
  const effect = classification.effect;
  const checkpointRequired = requiresDistinctCheckpoint(envelope, policies, effect);
  assertEffectConsistency(operation, classification);
  if (!checkpointRequired) {
    if (!envelope.allowed_side_effect_classes.includes(effect)) {
      throw new AuthorizationError(
        `${effect} is not allowed by ${envelope.profile}.`,
        "effect_forbidden",
      );
    }
    assertPermissionFlag(envelope, operation, effect);
  }
  assertSpendWithinEnvelope(envelope, operation, effect);
  assertRecipientsWithinEnvelope(envelope, operation, effect);
  const risk = operationRisk(operation);
  const profile = policies.authorization.profiles[envelope.profile];
  if (!profile.allowed_risk_classes.includes(risk)) {
    throw new AuthorizationError(
      `${risk} risk is not allowed by ${envelope.profile}.`,
      "risk_forbidden",
    );
  }
  return { effect, checkpointRequired };
}

export interface OperationAuthorizationOptions {
  nodeId?: string;
  checkpointGrant?: OneShotCheckpointGrant;
}

export function assertOperationAuthorized(
  envelope: AuthorizationEnvelope,
  operation: ProviderOperation,
  policies: PoliciesConfig,
  now = new Date(),
  options: OperationAuthorizationOptions = {},
): void {
  assertEnvelopeScope(envelope, operation, now);
  const classification = operationEffect(operation);
  const effect = classification.effect;
  const checkpointRequired = requiresDistinctCheckpoint(envelope, policies, effect);
  if (checkpointRequired && (!options.nodeId || !options.checkpointGrant)) {
    throw new AuthorizationError(
      `${effect} requires a distinct human checkpoint and cannot inherit session authorization.`,
      "distinct_checkpoint_required",
    );
  }
  inspectOperationAuthorization(envelope, operation, policies, now);
  if (checkpointRequired) {
    try {
      assertConsumedCheckpointGrant(options.checkpointGrant!, {
        scope: {
          runId: envelope.run_id,
          nodeId: options.nodeId!,
          effect,
          operationId: operation.id,
        },
        now: now.toISOString(),
      });
    } catch (error) {
      if (error instanceof CheckpointGrantError) {
        throw new AuthorizationError(error.message, "checkpoint_grant_invalid");
      }
      throw error;
    }
  }
}
