import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { looksLikeCredentialValue } from "../config/contracts";
import { Redactor, assertCredentialRef } from "../credentials";
import { launchManualActionContracts, type LaunchManualNodeId } from "../launch/manual-evidence";
import type {
  JsonValue,
  WorkflowBindings,
  WorkflowHandlerContext,
  WorkflowNodeState,
  WorkflowRunState,
  WorkflowRunStatus,
} from "../workflow";

export type LaunchReportOverallState = "succeeded" | "waiting" | "degraded" | "failed";

export interface LaunchReportNodeOutcome {
  id: string;
  capability: string;
  state: WorkflowNodeState;
  provider?: string;
  evidenceRef?: string;
  effectVerified: boolean;
  errorCode?: string;
}

export interface LaunchReportProviderOutcome {
  provider: string;
  capability: string;
  lifecycleState: string;
  environment?: string;
  accountId?: string;
  teamId?: string;
  region?: string;
  resourceRefs?: readonly string[];
  evidenceRef?: string;
  verified: boolean;
}

export interface LaunchReportManualAction {
  nodeId: string;
  resolved: boolean;
  action: string;
  requiredFields: readonly string[];
  risk: string;
  evidenceNeeded: readonly string[];
  resumeCommand: string;
}

export interface LaunchReportCredentialReference {
  ref: string;
  provider: string;
  status: string;
  scopes: readonly string[];
  expiresAt?: string;
  accountId?: string;
}

export interface LaunchReportSections {
  whatBuilt?: readonly string[];
  repository?: readonly string[];
  deploymentsAndBuilds?: readonly string[];
  commerce?: readonly string[];
  email?: readonly string[];
  analyticsAndSearch?: readonly string[];
  asoAndTestflight?: readonly string[];
  checksRun?: readonly string[];
  scheduledLoops?: readonly string[];
  nextReviews?: readonly string[];
}

export interface LaunchReportFirstValidationAction {
  action: string;
  channel: string;
  userHabitat: string;
  state: "planned";
  execution: "human_gated";
  evidenceRequired: string;
}

export interface LaunchReportInput {
  generatedAt: string;
  run: { id: string; status: WorkflowRunStatus };
  brief: { id: string; name: string; synthetic: boolean };
  launch: {
    mode: string;
    rail: string;
    paymentProvider?: string;
    entitlementSource?: string;
    activeEventPacks?: readonly string[];
    consentMode?: string;
    firstValidationAction?: LaunchReportFirstValidationAction;
  };
  authorization?: {
    profile: string;
    approvalRef: string;
    expiresAt: string;
    spendCeiling: { amount: number; currency: string };
    spendScope?: "reviewed_direct_provider_operations_only";
  };
  nodes: readonly LaunchReportNodeOutcome[];
  providers: readonly LaunchReportProviderOutcome[];
  manualActions: readonly LaunchReportManualAction[];
  credentialReferences?: readonly LaunchReportCredentialReference[];
  limitations: readonly string[];
  nextCommands: readonly string[];
  sections?: LaunchReportSections;
}

export interface LaunchReportDocument {
  schemaVersion: 1;
  generatedAt: string;
  run: LaunchReportInput["run"];
  brief: LaunchReportInput["brief"];
  launch: LaunchReportInput["launch"];
  authorization: LaunchReportInput["authorization"] | null;
  overallState: LaunchReportOverallState;
  nodes: LaunchReportNodeOutcome[];
  providers: LaunchReportProviderOutcome[];
  evidenceRefs: string[];
  remainingManualActions: LaunchReportManualAction[];
  credentialReferences: LaunchReportCredentialReference[];
  limitations: string[];
  nextCommands: string[];
  sections: Required<LaunchReportSections>;
}

function rejectUnredactedCredentialStrings(value: unknown, context: z.RefinementCtx): void {
  const visit = (candidate: unknown, path: (string | number)[]) => {
    if (typeof candidate === "string") {
      const withoutRedactionMarkers = candidate
        .replaceAll("[REDACTED]", "redacted")
        .replaceAll("[REDACTED PII]", "redacted-pii");
      if (looksLikeCredentialValue(withoutRedactionMarkers)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "unredacted credential material is forbidden in a Launch Report",
        });
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, item] of Object.entries(candidate)) visit(item, [...path, key]);
  };
  visit(value, []);
}

const boundedText = z.string().max(4_000);
const boundedTextArray = z.array(boundedText).max(1_000);
const workflowRunStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
]);
const workflowNodeStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_for_auth",
  "waiting_for_external_action",
  "waiting_for_approval",
  "waiting_for_manual_action",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "skipped",
  "compensated",
  "cancelled",
]);
const launchReportNodeOutcomeSchema = z
  .object({
    id: z.string().min(1).max(128),
    capability: z.string().min(1).max(500),
    state: workflowNodeStateSchema,
    provider: z.string().min(1).max(100).optional(),
    evidenceRef: z.string().min(1).max(1_000).optional(),
    effectVerified: z.boolean(),
    errorCode: z.string().min(1).max(200).optional(),
  })
  .strict();
const launchReportProviderOutcomeSchema = z
  .object({
    provider: z.string().min(1).max(100),
    capability: z.string().min(1).max(1_000),
    lifecycleState: z.string().min(1).max(100),
    environment: z.string().min(1).max(200).optional(),
    accountId: z.string().min(1).max(500).optional(),
    teamId: z.string().min(1).max(500).optional(),
    region: z.string().min(1).max(500).optional(),
    resourceRefs: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    evidenceRef: z.string().min(1).max(1_000).optional(),
    verified: z.boolean(),
  })
  .strict();
const launchReportManualActionSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    resolved: z.boolean(),
    action: boundedText,
    requiredFields: boundedTextArray,
    risk: z.string().min(1).max(100),
    evidenceNeeded: boundedTextArray,
    resumeCommand: boundedText,
  })
  .strict();
const launchReportCredentialReferenceSchema = z
  .object({
    ref: z.string().regex(/^cred:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    provider: z.string().min(1).max(100),
    status: z.string().min(1).max(100),
    scopes: z.array(z.string().min(1).max(300)).max(100),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    accountId: z.string().min(1).max(500).optional(),
  })
  .strict();
const launchReportSectionsSchema = z
  .object({
    whatBuilt: boundedTextArray,
    repository: boundedTextArray,
    deploymentsAndBuilds: boundedTextArray,
    commerce: boundedTextArray,
    email: boundedTextArray,
    analyticsAndSearch: boundedTextArray,
    asoAndTestflight: boundedTextArray,
    checksRun: boundedTextArray,
    scheduledLoops: boundedTextArray,
    nextReviews: boundedTextArray,
  })
  .strict();

/** Canonical strict parser used by local persistence and imported live-evidence verification. */
export const launchReportDocumentSchema: z.ZodType<LaunchReportDocument> = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    run: z.object({ id: z.string().min(1).max(128), status: workflowRunStatusSchema }).strict(),
    brief: z
      .object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        synthetic: z.boolean(),
      })
      .strict(),
    launch: z
      .object({
        mode: z.string().min(1).max(100),
        rail: z.string().min(1).max(100),
        paymentProvider: z.string().min(1).max(100).optional(),
        entitlementSource: z.string().min(1).max(100).optional(),
        activeEventPacks: z.array(z.string().min(1).max(200)).max(100).optional(),
        consentMode: z.string().min(1).max(100).optional(),
        firstValidationAction: z
          .object({
            action: boundedText,
            channel: boundedText,
            userHabitat: boundedText,
            state: z.literal("planned"),
            execution: z.literal("human_gated"),
            evidenceRequired: boundedText,
          })
          .strict()
          .optional(),
      })
      .strict(),
    authorization: z
      .object({
        profile: z.string().min(1).max(100),
        approvalRef: z.string().min(1).max(300),
        expiresAt: z.string().datetime({ offset: true }),
        spendCeiling: z
          .object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/u) })
          .strict(),
        spendScope: z.literal("reviewed_direct_provider_operations_only").optional(),
      })
      .strict()
      .nullable(),
    overallState: z.enum(["succeeded", "waiting", "degraded", "failed"]),
    nodes: z.array(launchReportNodeOutcomeSchema).max(1_000),
    providers: z.array(launchReportProviderOutcomeSchema).max(1_000),
    evidenceRefs: z.array(z.string().min(1).max(1_000)).max(2_000),
    remainingManualActions: z.array(launchReportManualActionSchema).max(1_000),
    credentialReferences: z.array(launchReportCredentialReferenceSchema).max(1_000),
    limitations: boundedTextArray,
    nextCommands: boundedTextArray,
    sections: launchReportSectionsSchema,
  })
  .strict()
  .superRefine(rejectUnredactedCredentialStrings);

export function parseLaunchReportDocument(input: unknown): LaunchReportDocument {
  return launchReportDocumentSchema.parse(input);
}

export interface RenderedLaunchReport {
  document: LaunchReportDocument;
  json: string;
  markdown: string;
}

export interface PersistedLaunchReport extends RenderedLaunchReport {
  jsonPath: string;
  markdownPath: string;
}

export interface LaunchReportRendererOptions {
  redactor?: Redactor;
}

export interface LaunchRunReportInput {
  generatedAt: string;
  state: WorkflowRunState;
  brief: { id: string; name: string; synthetic: boolean; scheduledLearning?: boolean };
  launch: LaunchReportInput["launch"];
  authorization?: LaunchReportInput["authorization"];
  providerByNode?: Readonly<Record<string, string>>;
  providerMetadata?: Readonly<
    Record<string, { accountId?: string; teamId?: string; region?: string }>
  >;
  credentialReferences?: readonly LaunchReportCredentialReference[];
  limitations?: readonly string[];
  nextCommands?: readonly string[];
  sections?: LaunchReportSections;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<![\w])\+\d(?:[\d .()-]{7,}\d)/g;
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g;
const QUERY_VALUE = /([?&][a-z0-9_.~-]+)=([^&\s#]+)/gi;

function sanitizeText(value: string, redactor: Redactor): string {
  return redactor
    .redactText(value)
    .replace(PRIVATE_KEY, "[REDACTED]")
    .replace(EMAIL, "[REDACTED PII]")
    .replace(PHONE, "[REDACTED PII]")
    .replace(QUERY_VALUE, "$1=[REDACTED]");
}

function outcomeLine(outcome: LaunchReportNodeOutcome): string {
  return `${outcome.id}: ${outcome.state}; evidence ${outcome.evidenceRef ?? "not recorded"}`;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function providerFacts(record: WorkflowRunState["nodes"][string]): {
  environments: string[];
  capabilities: string[];
  resourceRefs: string[];
  accountId?: string;
  teamId?: string;
  region?: string;
} {
  const output = objectValue(record.output);
  if (output?.state !== "verified") {
    return { environments: [], capabilities: [], resourceRefs: [] };
  }
  const resourceRefs = stringArray(output.resourceRefs);
  const valueFor = (type: string) =>
    resourceRefs.find((reference) => reference.startsWith(`${type}=`))?.slice(type.length + 1);
  return {
    environments: stringArray(output.environments),
    capabilities: stringArray(output.capabilities),
    resourceRefs,
    accountId: valueFor("account_id"),
    teamId: valueFor("team_id"),
    region: valueFor("region"),
  };
}

function productOutcomeLine(record: WorkflowRunState["nodes"][string]): string {
  const output = objectValue(record.output);
  const summary = typeof output?.summary === "string" ? output.summary : null;
  const changedFiles = stringArray(output?.changedFiles);
  return summary
    ? `${record.definition.id}: ${summary}${
        changedFiles.length > 0 ? `; files ${changedFiles.join(", ")}` : ""
      }`
    : outcomeLine({
        id: record.definition.id,
        capability: record.definition.capability,
        state: record.state,
        evidenceRef: record.evidenceArtifact,
        effectVerified: record.effectVerified,
      });
}

function qualityOutcomeLine(record: WorkflowRunState["nodes"][string]): string {
  const output = objectValue(record.output);
  const command = stringArray(output?.command);
  const exitCode = typeof output?.exitCode === "number" ? output.exitCode : null;
  return command.length > 0 && exitCode !== null
    ? `${command.join(" ")}: ${exitCode === 0 ? "PASS" : `FAIL (${exitCode})`}; evidence ${
        record.evidenceArtifact ?? "not recorded"
      }`
    : outcomeLine({
        id: record.definition.id,
        capability: record.definition.capability,
        state: record.state,
        evidenceRef: record.evidenceArtifact,
        effectVerified: record.effectVerified,
      });
}

function providerOutcomeLine(outcome: LaunchReportProviderOutcome): string {
  const resources = outcome.resourceRefs?.length
    ? `; resources ${outcome.resourceRefs.join(", ")}`
    : "; resource identifiers not returned by the verified read-back";
  const scope = [
    outcome.accountId ? `account ${outcome.accountId}` : null,
    outcome.teamId ? `team ${outcome.teamId}` : null,
    outcome.region ? `region ${outcome.region}` : null,
  ]
    .filter(Boolean)
    .join("; ");
  return `${outcome.provider} / ${outcome.capability}: ${outcome.lifecycleState}; verified ${
    outcome.verified ? "yes" : "no"
  }; ${scope || "account/team/region not recorded"}${resources}; evidence ${outcome.evidenceRef ?? "not recorded"}`;
}

/**
 * Derives a report from durable workflow state without copying arbitrary node
 * output or provider responses into the report.
 */
export function createLaunchReportInputFromRun(input: LaunchRunReportInput): LaunchReportInput {
  const providerByNode = input.providerByNode ?? {};
  const nodes: LaunchReportNodeOutcome[] = Object.values(input.state.nodes).map((record) => ({
    id: record.definition.id,
    capability: record.definition.capability,
    state: record.state,
    provider: providerByNode[record.definition.id],
    evidenceRef: record.evidenceArtifact,
    effectVerified: record.effectVerified,
    errorCode: record.error?.code,
  }));
  const providers: LaunchReportProviderOutcome[] = nodes
    .filter((node) => input.state.nodes[node.id].definition.kind === "provider")
    .map((node) => {
      const facts = providerFacts(input.state.nodes[node.id]);
      const metadata = input.providerMetadata?.[node.provider ?? ""];
      return {
        provider: node.provider ?? "unmapped-provider",
        capability: facts.capabilities.length > 0 ? facts.capabilities.join(", ") : node.capability,
        lifecycleState: node.state === "succeeded" && node.effectVerified ? "verified" : node.state,
        environment: facts.environments.join(", ") || undefined,
        accountId: metadata?.accountId ?? facts.accountId,
        teamId: metadata?.teamId ?? facts.teamId,
        region: metadata?.region ?? facts.region,
        resourceRefs: facts.resourceRefs,
        evidenceRef: node.evidenceRef,
        verified: node.state === "succeeded" && node.effectVerified,
      };
    });
  const manualActions: LaunchReportManualAction[] = Object.values(input.state.nodes)
    .filter(
      (record) =>
        record.definition.kind === "manual_action" ||
        record.error?.code === "provider_manual_action_required" ||
        record.state === "waiting_for_auth" ||
        record.state === "waiting_for_external_action",
    )
    .map((record) => {
      const contract = launchManualActionContracts[record.definition.id as LaunchManualNodeId];
      const evidencePath = contract?.evidencePath.replace("<run-id>", input.state.runId);
      return {
        nodeId: record.definition.id,
        resolved: record.state === "succeeded" || record.state === "compensated",
        action: contract?.effect ?? record.waiting?.reason ?? record.definition.purpose,
        requiredFields: contract?.requiredFields ?? [],
        risk: contract?.risk ?? record.definition.risk,
        evidenceNeeded: contract?.completionEvidence ?? [record.definition.completion.description],
        resumeCommand:
          record.definition.kind === "manual_action"
            ? `vh resume ${input.state.runId} --manual ${record.definition.id} --evidence ${
                evidencePath ?? "<repository-relative-artifact>"
              }`
            : `vh explain ${input.state.runId} ${record.definition.id}`,
      };
    });
  const unverifiedProviders = providers
    .filter(({ verified }) => !verified)
    .map(
      ({ provider, capability, lifecycleState }) =>
        `${provider} / ${capability} remains ${lifecycleState}; no verified provider state was inferred.`,
    );
  const waiting = manualActions.filter(({ resolved }) => !resolved);
  const failedNodes = nodes.filter(
    ({ state }) => state === "failed_terminal" || state === "failed_retryable",
  );
  const generatedNextCommands =
    waiting.length > 0
      ? waiting.map(({ resumeCommand }) => resumeCommand)
      : failedNodes.length > 0
        ? failedNodes.map(({ id }) => `vh explain ${input.state.runId} ${id}`)
        : [`vh status ${input.state.runId}`];
  const records = input.state.nodes;
  const productIds = ["prepare-repository", "review-product"];
  const generatedSections: LaunchReportSections = {
    whatBuilt: productIds.filter((id) => records[id]).map((id) => productOutcomeLine(records[id])),
    repository: providers.filter(({ provider }) => provider === "github").map(providerOutcomeLine),
    deploymentsAndBuilds: providers
      .filter(({ provider }) => ["vercel", "eas", "app_store_connect"].includes(provider))
      .map(providerOutcomeLine),
    commerce: [
      `Payment provider ${input.launch.paymentProvider ?? "not recorded"}; entitlement source ${input.launch.entitlementSource ?? "not recorded"}.`,
      ...providers
        .filter(({ provider }) => ["stripe", "revenuecat"].includes(provider))
        .map(providerOutcomeLine),
    ],
    email: providers.filter(({ provider }) => provider === "brevo").map(providerOutcomeLine),
    analyticsAndSearch: [
      `Event packs ${input.launch.activeEventPacks?.join(", ") || "not recorded"}; consent ${input.launch.consentMode ?? "not recorded"}.`,
      ...(records["prepare-repository"] ? [productOutcomeLine(records["prepare-repository"])] : []),
      ...providers
        .filter(({ provider }) => ["google", "bing"].includes(provider))
        .map(providerOutcomeLine),
    ],
    asoAndTestflight: providers
      .filter(({ provider }) => ["app_store_connect", "eas", "revenuecat"].includes(provider))
      .map(providerOutcomeLine),
    checksRun: ["verify-local", "verify-launch"]
      .filter((id) => records[id])
      .map((id) => qualityOutcomeLine(records[id])),
    scheduledLoops: input.brief.scheduledLearning
      ? [
          "Scheduled learning was requested; no external schedule is inferred by this launch report.",
        ]
      : [],
    nextReviews: [],
  };
  const sections = Object.fromEntries(
    Object.entries(generatedSections).map(([key, values]) => [
      key,
      [...(values ?? []), ...(input.sections?.[key as keyof LaunchReportSections] ?? [])],
    ]),
  ) as LaunchReportSections;

  return {
    generatedAt: input.generatedAt,
    run: { id: input.state.runId, status: input.state.status },
    brief: input.brief,
    launch: input.launch,
    authorization: input.authorization,
    nodes,
    providers,
    manualActions,
    credentialReferences: input.credentialReferences,
    limitations: [...unverifiedProviders, ...(input.limitations ?? [])],
    nextCommands: [...generatedNextCommands, ...(input.nextCommands ?? [])],
    sections,
  };
}

function sortedUnique(values: readonly string[], redactor: Redactor): string[] {
  return [...new Set(values.map((value) => sanitizeText(value, redactor)))].sort();
}

function overallState(input: LaunchReportInput): LaunchReportOverallState {
  if (
    input.run.status === "failed" ||
    input.nodes.some(({ state }) => state === "failed_terminal")
  ) {
    return "failed";
  }
  if (
    input.run.status === "waiting" ||
    input.nodes.some(
      ({ state }) =>
        state === "waiting_for_approval" ||
        state === "waiting_for_manual_action" ||
        state === "waiting_for_auth" ||
        state === "waiting_for_external_action",
    )
  ) {
    return "waiting";
  }
  if (
    input.run.status === "succeeded" &&
    input.nodes.every(({ state }) => ["succeeded", "skipped", "compensated"].includes(state))
  ) {
    return "succeeded";
  }
  return "degraded";
}

function isGenuinelyUnresolved(
  action: LaunchReportManualAction,
  nodes: ReadonlyMap<string, LaunchReportNodeOutcome>,
): boolean {
  if (action.resolved) return false;
  const node = nodes.get(action.nodeId);
  if (!node) return false;
  return (
    node.state === "waiting_for_approval" ||
    node.state === "waiting_for_manual_action" ||
    node.state === "waiting_for_auth" ||
    node.state === "waiting_for_external_action" ||
    node.errorCode === "provider_manual_action_required"
  );
}

function normalizeSections(
  sections: LaunchReportSections | undefined,
  redactor: Redactor,
): Required<LaunchReportSections> {
  const normalize = (values: readonly string[] | undefined) => sortedUnique(values ?? [], redactor);
  return {
    whatBuilt: normalize(sections?.whatBuilt),
    repository: normalize(sections?.repository),
    deploymentsAndBuilds: normalize(sections?.deploymentsAndBuilds),
    commerce: normalize(sections?.commerce),
    email: normalize(sections?.email),
    analyticsAndSearch: normalize(sections?.analyticsAndSearch),
    asoAndTestflight: normalize(sections?.asoAndTestflight),
    checksRun: normalize(sections?.checksRun),
    scheduledLoops: normalize(sections?.scheduledLoops),
    nextReviews: normalize(sections?.nextReviews),
  };
}

function cleanCredentialReference(
  input: LaunchReportCredentialReference,
  redactor: Redactor,
): LaunchReportCredentialReference {
  assertCredentialRef(input.ref);
  return {
    ref: input.ref,
    provider: sanitizeText(input.provider, redactor),
    status: sanitizeText(input.status, redactor),
    scopes: sortedUnique(input.scopes, redactor),
    expiresAt: input.expiresAt,
    accountId: input.accountId ? sanitizeText(input.accountId, redactor) : undefined,
  };
}

function lineItems(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `_${empty}_`;
}

function renderMarkdown(document: LaunchReportDocument): string {
  const authorization = document.authorization
    ? `${document.authorization.profile}; approval ${document.authorization.approvalRef}; expires ${document.authorization.expiresAt}; ${document.authorization.spendScope === "reviewed_direct_provider_operations_only" ? "reviewed direct-operation ceiling" : "ceiling"} ${document.authorization.spendCeiling.amount} ${document.authorization.spendCeiling.currency}${document.authorization.spendScope === "reviewed_direct_provider_operations_only" ? "; ongoing account-plan usage excluded" : ""}`
    : "No session authorization metadata was supplied";
  const nodeLines = document.nodes.map(
    (node) =>
      `${node.id}: ${node.state}; capability ${node.capability}; evidence ${node.evidenceRef ?? "not recorded"}`,
  );
  const providerLines = document.providers.map(
    (provider) =>
      `${provider.provider} / ${provider.capability}: ${provider.lifecycleState}; verified ${provider.verified ? "yes" : "no"}; account ${provider.accountId ?? "not recorded"}; team ${provider.teamId ?? "not recorded"}; region ${provider.region ?? "not recorded"}; evidence ${provider.evidenceRef ?? "not recorded"}`,
  );
  const credentialLines = document.credentialReferences.map(
    (credential) =>
      `${credential.ref}: ${credential.status}; scopes ${credential.scopes.join(", ") || "not recorded"}; expiry ${credential.expiresAt ?? "not recorded"}`,
  );
  const manualLines = document.remainingManualActions.map(
    (action) =>
      `${action.nodeId}: ${action.action}; fields ${action.requiredFields.join(", ") || "none"}; risk ${action.risk}; evidence ${action.evidenceNeeded.join(", ") || "not recorded"}; resume \`${action.resumeCommand}\``,
  );
  const sections = document.sections;

  return `# Launch report: ${document.brief.name} / ${document.run.id}

- Generated: ${document.generatedAt}
- Launch mode / rail: ${document.launch.mode} / ${document.launch.rail}
- Payment / entitlement source: ${document.launch.paymentProvider ?? "none recorded"} / ${document.launch.entitlementSource ?? "none recorded"}
- Event packs / consent: ${document.launch.activeEventPacks?.join(", ") || "none recorded"} / ${document.launch.consentMode ?? "not recorded"}
- First validation action: ${document.launch.firstValidationAction ? `${document.launch.firstValidationAction.action}; channel ${document.launch.firstValidationAction.channel}; habitat ${document.launch.firstValidationAction.userHabitat}; ${document.launch.firstValidationAction.state}; ${document.launch.firstValidationAction.execution}; evidence required ${document.launch.firstValidationAction.evidenceRequired}` : "not recorded"}
- Authorization: ${authorization}
- Overall state: ${document.overallState}
- Brief: ${document.brief.id}${document.brief.synthetic ? " (synthetic fixture)" : ""}

## What was built

${lineItems(sections.whatBuilt, "No verified build summary was supplied.")}

## Repository

${lineItems(sections.repository, "No verified repository state was supplied.")}

## Deployments and builds

${lineItems(sections.deploymentsAndBuilds, "No verified deployment or build state was supplied.")}

## Provider resources

${lineItems(providerLines, "No verified provider resource state was supplied.")}

## Commerce

${lineItems(sections.commerce, "No commerce state was supplied.")}

## Email

${lineItems(sections.email, "No email state was supplied.")}

## Analytics and search

${lineItems(sections.analyticsAndSearch, "No analytics or search state was supplied.")}

## ASO and TestFlight

${lineItems(sections.asoAndTestflight, "No ASO or TestFlight state was supplied.")}

## Checks run

${lineItems(sections.checksRun, "No quality check state was supplied.")}

## Node outcomes

${lineItems(nodeLines, "No node outcomes were supplied.")}

## Active credential references

${lineItems(credentialLines, "No active credential references were supplied.")}

## Remaining manual actions

${lineItems(manualLines, "No genuinely unresolved manual action remains.")}

## Known limitations

${lineItems(document.limitations, "No known limitation was supplied.")}

## Scheduled loops

${lineItems(sections.scheduledLoops, "No scheduled loop was supplied.")}

## Next reviews

${lineItems(sections.nextReviews, "No review date was supplied.")}

## Next commands

${lineItems(
  document.nextCommands.map((command) => `\`${command}\``),
  "No next command is required.",
)}
`;
}

export function renderLaunchReport(
  input: LaunchReportInput,
  options: LaunchReportRendererOptions = {},
): RenderedLaunchReport {
  const redactor = options.redactor ?? new Redactor();
  const nodeMap = new Map(input.nodes.map((node) => [node.id, node]));
  const nodes = input.nodes
    .map((node) => ({
      ...node,
      id: sanitizeText(node.id, redactor),
      capability: sanitizeText(node.capability, redactor),
      provider: node.provider ? sanitizeText(node.provider, redactor) : undefined,
      evidenceRef: node.evidenceRef ? sanitizeText(node.evidenceRef, redactor) : undefined,
      errorCode: node.errorCode ? sanitizeText(node.errorCode, redactor) : undefined,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const providers = input.providers
    .map((provider) => ({
      ...provider,
      provider: sanitizeText(provider.provider, redactor),
      capability: sanitizeText(provider.capability, redactor),
      lifecycleState: sanitizeText(provider.lifecycleState, redactor),
      environment: provider.environment ? sanitizeText(provider.environment, redactor) : undefined,
      accountId: provider.accountId ? sanitizeText(provider.accountId, redactor) : undefined,
      teamId: provider.teamId ? sanitizeText(provider.teamId, redactor) : undefined,
      region: provider.region ? sanitizeText(provider.region, redactor) : undefined,
      resourceRefs: sortedUnique(provider.resourceRefs ?? [], redactor),
      evidenceRef: provider.evidenceRef ? sanitizeText(provider.evidenceRef, redactor) : undefined,
    }))
    .sort((left, right) =>
      `${left.provider}:${left.capability}`.localeCompare(`${right.provider}:${right.capability}`),
    );
  const remainingManualActions = input.manualActions
    .filter((action) => isGenuinelyUnresolved(action, nodeMap))
    .map((action) => ({
      ...action,
      nodeId: sanitizeText(action.nodeId, redactor),
      action: sanitizeText(action.action, redactor),
      requiredFields: sortedUnique(action.requiredFields, redactor),
      risk: sanitizeText(action.risk, redactor),
      evidenceNeeded: sortedUnique(action.evidenceNeeded, redactor),
      resumeCommand: sanitizeText(action.resumeCommand, redactor),
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const authorization = input.authorization
    ? {
        ...input.authorization,
        profile: sanitizeText(input.authorization.profile, redactor),
        approvalRef: sanitizeText(input.authorization.approvalRef, redactor),
      }
    : null;
  const document = parseLaunchReportDocument({
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    run: { id: sanitizeText(input.run.id, redactor), status: input.run.status },
    brief: {
      id: sanitizeText(input.brief.id, redactor),
      name: sanitizeText(input.brief.name, redactor),
      synthetic: input.brief.synthetic,
    },
    launch: {
      mode: sanitizeText(input.launch.mode, redactor),
      rail: sanitizeText(input.launch.rail, redactor),
      paymentProvider: input.launch.paymentProvider
        ? sanitizeText(input.launch.paymentProvider, redactor)
        : undefined,
      entitlementSource: input.launch.entitlementSource
        ? sanitizeText(input.launch.entitlementSource, redactor)
        : undefined,
      activeEventPacks: sortedUnique(input.launch.activeEventPacks ?? [], redactor),
      consentMode: input.launch.consentMode
        ? sanitizeText(input.launch.consentMode, redactor)
        : undefined,
      firstValidationAction: input.launch.firstValidationAction
        ? {
            action: sanitizeText(input.launch.firstValidationAction.action, redactor),
            channel: sanitizeText(input.launch.firstValidationAction.channel, redactor),
            userHabitat: sanitizeText(input.launch.firstValidationAction.userHabitat, redactor),
            state: "planned",
            execution: "human_gated",
            evidenceRequired: sanitizeText(
              input.launch.firstValidationAction.evidenceRequired,
              redactor,
            ),
          }
        : undefined,
    },
    authorization,
    overallState: overallState(input),
    nodes,
    providers,
    evidenceRefs: sortedUnique(
      [
        ...nodes.map(({ evidenceRef }) => evidenceRef),
        ...providers.map(({ evidenceRef }) => evidenceRef),
      ].filter((value): value is string => value !== undefined),
      redactor,
    ),
    remainingManualActions,
    credentialReferences: (input.credentialReferences ?? [])
      .map((credential) => cleanCredentialReference(credential, redactor))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
    limitations: sortedUnique(input.limitations, redactor),
    nextCommands: sortedUnique(input.nextCommands, redactor),
    sections: normalizeSections(input.sections, redactor),
  });
  const json = `${JSON.stringify(document, null, 2)}\n`;
  return { document, json, markdown: renderMarkdown(document) };
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function persistLaunchReport(
  report: RenderedLaunchReport,
  outputDirectory = "reports/launch",
): Promise<PersistedLaunchReport> {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jsonPath = join(directory, "final.json");
  const markdownPath = join(directory, "final.md");
  await atomicWrite(jsonPath, report.json);
  await atomicWrite(markdownPath, report.markdown);
  const [storedJson, storedMarkdown] = await Promise.all([
    readFile(jsonPath, "utf8"),
    readFile(markdownPath, "utf8"),
  ]);
  if (storedJson !== report.json || storedMarkdown !== report.markdown) {
    throw new Error("Launch report read-back did not match the rendered artifacts");
  }
  return { ...report, jsonPath, markdownPath };
}

export interface LaunchReportWorkflowBindingOptions extends LaunchReportRendererOptions {
  input: (context: WorkflowHandlerContext) => LaunchReportInput | Promise<LaunchReportInput>;
  outputDirectory?: string;
  artifactReferences?: { json: string; markdown: string };
  handler?: string;
}

export function createLaunchReportWorkflowBinding(
  options: LaunchReportWorkflowBindingOptions,
): WorkflowBindings {
  const handler = options.handler ?? "launch.report";
  return {
    handlers: {
      [handler]: async (context) => {
        const persisted = await persistLaunchReport(
          renderLaunchReport(await options.input(context), { redactor: options.redactor }),
          options.outputDirectory,
        );
        return {
          output: {
            schemaVersion: 1,
            overallState: persisted.document.overallState,
            jsonPath: options.artifactReferences?.json ?? persisted.jsonPath,
            markdownPath: options.artifactReferences?.markdown ?? persisted.markdownPath,
            remainingManualActions: persisted.document.remainingManualActions.length,
          } satisfies JsonValue,
          effectVerified: true,
          evidenceArtifact: options.artifactReferences?.json ?? persisted.jsonPath,
        };
      },
    },
  };
}
