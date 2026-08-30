import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { rejectCredentialMaterial } from "../config/contracts";
import { Redactor } from "../credentials";
import {
  launchContractSchema,
  renderLaunchContractYaml,
  type LaunchContract,
} from "../founder-launch";
import type { LaunchDecision } from "../launch";
import type { LaunchGrant } from "../materialization";
import type { WorkflowRunState } from "../workflow";
import type { LaunchReportDocument } from "./launch-report";

export const launchReceiptEvidenceStateSchema = z.enum([
  "planned",
  "requested",
  "accepted",
  "waiting",
  "verified",
  "failed",
  "fixture",
]);
export type LaunchReceiptEvidenceState = z.infer<typeof launchReceiptEvidenceStateSchema>;

const nullableCount = z.number().int().nonnegative().nullable();
const stackState = launchReceiptEvidenceStateSchema;

export const launchReceiptPrimaryJourneyEvidenceSchema = z
  .object({
    scope: z.literal("product_specific_end_to_end"),
    journeyId: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
    steps: z.array(z.string().trim().min(1).max(1_000)).min(1).max(20),
    state: z.enum(["verified", "failed", "fixture"]),
    evidenceRef: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type LaunchReceiptPrimaryJourneyEvidence = z.infer<
  typeof launchReceiptPrimaryJourneyEvidenceSchema
>;

export const launchReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    launchContract: launchContractSchema,
    venture: z
      .object({
        name: z.string().max(200),
        repository: z.string().max(1_000),
        productionUrl: z.string().max(1_000),
        customDomain: z.string().max(253).nullable(),
      })
      .strict(),
    decision: z
      .object({
        launchMode: z.string().min(1).max(100),
        primarySuccessSignal: z.string().min(1).max(200),
        reviewDate: z.string().max(100),
        firstValidationAction: z.string().max(2_000),
      })
      .strict(),
    build: z
      .object({
        seed: z.string().min(1).max(200),
        coreVersion: z.string().min(1).max(100),
        buildAgent: z.string().min(1).max(200),
        /** Distinct model-task nodes compiled into the run graph. */
        taskCount: z.number().int().nonnegative(),
        /** Attempted model executions, including retries. */
        modelCalls: z.number().int().nonnegative(),
        inputTokens: nullableCount,
        cachedInputTokens: nullableCount,
        outputTokens: nullableCount,
        totalTokens: nullableCount,
        toolCalls: nullableCount,
        retries: z.number().int().nonnegative(),
        failedCommands: nullableCount,
        elapsedMs: z.number().int().nonnegative(),
        filesRead: nullableCount,
        filesChanged: z.number().int().nonnegative(),
      })
      .strict(),
    stack: z
      .object({
        github: stackState,
        vercel: stackState,
        neon: stackState,
        commerce: stackState,
        email: stackState,
        analytics: stackState,
        search: stackState,
        dns: stackState,
      })
      .strict(),
    verification: z
      .object({
        repository: stackState,
        deployment: stackState,
        database: stackState,
        commerce: stackState,
        primaryJourney: stackState,
        primaryJourneyEvidence: launchReceiptPrimaryJourneyEvidenceSchema.nullable(),
        evidenceArtifact: z.string().trim().min(1).max(1_000).nullable(),
        accessibility: stackState,
        rawHtml: stackState,
        providerReadBack: z
          .array(
            z
              .object({
                provider: z.string().min(1).max(200),
                capability: z.string().min(1).max(500),
                state: launchReceiptEvidenceStateSchema,
                evidenceRef: z.string().max(1_000).nullable(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    manualActions: z
      .array(
        z
          .object({
            action: z.string().min(1).max(2_000),
            command: z.string().min(1).max(2_000),
            evidence: z.string().min(1).max(2_000),
            impact: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(100),
    limitations: z.array(z.string().min(1).max(4_000)).max(100),
  })
  .strict()
  .superRefine((receipt, context) => {
    rejectCredentialMaterial(receipt, context);
    const contract = receipt.launchContract;
    const linkedDecisionFields = [
      ["launchMode", receipt.decision.launchMode, contract.decision.launchMode],
      [
        "primarySuccessSignal",
        receipt.decision.primarySuccessSignal,
        contract.decision.primarySuccessSignal,
      ],
      ["reviewDate", receipt.decision.reviewDate, contract.decision.reviewDate],
      [
        "firstValidationAction",
        receipt.decision.firstValidationAction,
        contract.distribution.firstValidationAction,
      ],
    ] as const;
    for (const [field, actual, expected] of linkedDecisionFields) {
      if (actual !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decision", field],
          message: "must match launchContract",
        });
      }
    }
    const journey = receipt.verification.primaryJourneyEvidence;
    if (
      journey &&
      (journey.journeyId !== contract.decision.primarySuccessSignal ||
        JSON.stringify(journey.steps) !== JSON.stringify(contract.product.primaryJourney))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification", "primaryJourneyEvidence"],
        message: "must identify and enumerate the canonical Launch Contract primary journey",
      });
    }
  });

export type LaunchReceipt = z.infer<typeof launchReceiptSchema>;

export interface LaunchReceiptInput {
  state: WorkflowRunState;
  report: LaunchReportDocument;
  decision: LaunchDecision;
  launchContract: LaunchContract;
  launchGrant?: LaunchGrant;
  filesRead?: number | null;
  launchGaps?: readonly {
    code: string;
    role?: string;
    provider?: string;
    message: string;
    nextAction: string;
    state: "waiting_for_auth" | "waiting_for_external_action";
    blocksLaunch: false;
  }[];
  verification?: {
    accessibility?: LaunchReceipt["verification"]["accessibility"];
    rawHtml?: LaunchReceipt["verification"]["rawHtml"];
    primaryJourneyEvidence?: LaunchReceiptPrimaryJourneyEvidence;
    deploymentEvidence?: {
      state: Extract<LaunchReceiptEvidenceState, "verified" | "fixture">;
      productionUrl: string;
      customDomain: string | null;
      evidenceRef: string;
    };
  };
}

function providerState(
  report: LaunchReportDocument,
  providers: readonly string[],
  capability?: (value: string) => boolean,
): LaunchReceiptEvidenceState {
  const matches = report.providers.filter(
    (outcome) =>
      providers.includes(outcome.provider) && (!capability || capability(outcome.capability)),
  );
  if (matches.length === 0) return "planned";
  const states = matches.map((outcome) => providerOutcomeState(outcome, report.brief.synthetic));
  // A provider category is only as complete as its weakest material requested/planned outcome.
  for (const state of ["failed", "waiting", "planned", "requested", "accepted"] as const) {
    if (states.includes(state)) return state;
  }
  return states.every((state) => state === "fixture") ? "fixture" : "verified";
}

function providerOutcomeState(
  provider: LaunchReportDocument["providers"][number],
  fixture: boolean,
): LaunchReceiptEvidenceState {
  if (provider.verified) return fixture ? "fixture" : "verified";
  const lifecycle = provider.lifecycleState.toLowerCase();
  if (/fail|error|cancel/u.test(lifecycle)) return "failed";
  if (/wait|auth|manual|pending/u.test(lifecycle)) return "waiting";
  if (/accept|applied|created|configured|succeed|completed/u.test(lifecycle)) return "accepted";
  if (/request|running|execut/u.test(lifecycle)) return "requested";
  return "planned";
}

function resource(report: LaunchReportDocument, provider: string, keys: readonly string[]): string {
  const refs = report.providers
    .filter((item) => item.provider === provider && item.verified)
    .flatMap((item) => item.resourceRefs ?? []);
  for (const key of keys) {
    const value = refs.find((reference) => reference.startsWith(`${key}=`));
    if (value) return value.slice(key.length + 1);
  }
  return "";
}

function modelUsage(state: WorkflowRunState): {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  buildAgent: string;
  toolCalls: number | null;
  failedCommands: number | null;
  complete: boolean;
} {
  const expectedModelCalls = Object.values(state.nodes)
    .filter(({ definition }) => definition.kind === "model")
    .reduce((total, node) => total + node.attempts, 0);
  const costs = (state.costs ?? []).filter(
    ({ kind, unit, inputTokens, outputTokens }) =>
      kind === "model" &&
      unit === "tokens" &&
      (inputTokens !== undefined || outputTokens !== undefined),
  );
  if (costs.length === 0) {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      buildAgent: "not_recorded",
      toolCalls: null,
      failedCommands: null,
      complete: expectedModelCalls === 0,
    };
  }
  const complete =
    costs.length === expectedModelCalls &&
    costs.every(
      ({ inputTokens, outputTokens }) => inputTokens !== undefined && outputTokens !== undefined,
    );
  const inputTokens = complete
    ? costs.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0)
    : null;
  const outputTokens = complete
    ? costs.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0)
    : null;
  const cachedComplete =
    complete && costs.every(({ metadata }) => typeof metadata?.cachedInputTokens === "number");
  const toolCallsComplete =
    complete && costs.every(({ metadata }) => typeof metadata?.toolCalls === "number");
  const failedCommandsComplete =
    complete && costs.every(({ metadata }) => typeof metadata?.failedCommands === "number");
  return {
    inputTokens,
    cachedInputTokens: cachedComplete
      ? costs.reduce((sum, item) => sum + Number(item.metadata?.cachedInputTokens ?? 0), 0)
      : null,
    outputTokens,
    totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    buildAgent:
      [
        ...new Set(
          costs
            .map(({ tool, model }) =>
              tool ? `${tool}${model ? ` (${model})` : " (model unrecorded)"}` : null,
            )
            .filter(Boolean),
        ),
      ].join(", ") || "not_recorded",
    toolCalls: toolCallsComplete
      ? costs.reduce((sum, item) => sum + Number(item.metadata?.toolCalls ?? 0), 0)
      : null,
    failedCommands: failedCommandsComplete
      ? costs.reduce((sum, item) => sum + Number(item.metadata?.failedCommands ?? 0), 0)
      : null,
    complete,
  };
}

function primaryJourneyFallback(state: WorkflowRunState): LaunchReceiptEvidenceState {
  const node = state.nodes["verify-production"];
  switch (node?.state) {
    case "failed_retryable":
    case "failed_terminal":
    case "cancelled":
      return "failed";
    case "waiting_for_approval":
    case "waiting_for_manual_action":
    case "waiting_for_auth":
    case "waiting_for_external_action":
      return "waiting";
    default:
      return "planned";
  }
}

function uniqueChangedFiles(state: WorkflowRunState): number {
  const files = new Set<string>();
  for (const record of Object.values(state.nodes)) {
    const output = record.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    const changed = output.changedFiles;
    if (!Array.isArray(changed)) continue;
    for (const path of changed) if (typeof path === "string") files.add(path);
  }
  return files.size;
}

export function createLaunchReceipt(
  input: LaunchReceiptInput,
  options: { redactor?: Redactor } = {},
): LaunchReceipt {
  const redactor = options.redactor ?? new Redactor();
  const fixture = input.report.brief.synthetic;
  const modelTasks = Object.values(input.state.nodes).filter(
    ({ definition }) => definition.kind === "model",
  );
  const modelTaskCount = modelTasks.length;
  const modelCalls = modelTasks.reduce((total, node) => total + node.attempts, 0);
  const usage = modelUsage(input.state);
  // Validate before redaction so a credential-bearing or malformed contract is
  // rejected instead of being persisted as a lossy pseudo-contract.
  const contract = launchContractSchema.parse(input.launchContract);
  const reportedValidationAction = input.report.launch.firstValidationAction;
  if (!reportedValidationAction) {
    throw new Error(
      "Launch Report must link the reviewed human-gated first validation action before a receipt can be created",
    );
  }
  if (
    reportedValidationAction.action !== contract.distribution.firstValidationAction ||
    reportedValidationAction.channel !== contract.distribution.firstChannel ||
    reportedValidationAction.userHabitat !== contract.distribution.firstUserHabitat
  ) {
    throw new Error("Launch Report first validation action does not match the Launch Contract");
  }
  if (input.decision.mode.selectedMode !== contract.decision.launchMode) {
    throw new Error("Launch Decision mode does not match the Launch Contract");
  }
  if (fixture !== (contract.synthetic === true)) {
    throw new Error("Launch Report synthetic state does not match the Launch Contract");
  }
  const primaryJourneyEvidence = input.verification?.primaryJourneyEvidence
    ? launchReceiptPrimaryJourneyEvidenceSchema.parse(input.verification.primaryJourneyEvidence)
    : null;
  if (
    primaryJourneyEvidence &&
    (primaryJourneyEvidence.journeyId !== contract.decision.primarySuccessSignal ||
      JSON.stringify(primaryJourneyEvidence.steps) !==
        JSON.stringify(contract.product.primaryJourney))
  ) {
    throw new Error(
      "Primary-journey evidence must identify and enumerate the reviewed Launch Contract journey",
    );
  }
  if (fixture && primaryJourneyEvidence?.state === "verified") {
    throw new Error("Synthetic launch evidence must use the fixture state, not verified");
  }
  const deploymentEvidence = input.verification?.deploymentEvidence;
  if (
    primaryJourneyEvidence &&
    (!deploymentEvidence || primaryJourneyEvidence.evidenceRef !== deploymentEvidence.evidenceRef)
  ) {
    throw new Error(
      "Primary-journey and deployment verification must reference the same exact run-scoped evidence artifact",
    );
  }
  if (
    [input.verification?.accessibility, input.verification?.rawHtml].some(
      (evidenceState) => evidenceState === "verified" || evidenceState === "fixture",
    ) &&
    !deploymentEvidence
  ) {
    throw new Error(
      "Verified accessibility and raw-HTML states require exact same-run deployment evidence",
    );
  }
  const elapsedMs = Math.max(
    0,
    Date.parse(input.state.finishedAt ?? input.state.updatedAt) - Date.parse(input.state.createdAt),
  );
  const github = providerState(input.report, ["github"]);
  const vercel = input.verification?.deploymentEvidence?.state ?? "planned";
  const neon = providerState(input.report, ["neon"]);
  const commerce = providerState(input.report, ["stripe", "revenuecat"]);
  const email = providerState(input.report, ["brevo"]);
  const analytics = providerState(input.report, ["google"], (capability) =>
    /^analytics_/u.test(capability),
  );
  const search = providerState(input.report, ["google", "bing"], (capability) =>
    /^(?:search_console_|site(?:_|$)|sitemap$|url_submission$)/u.test(capability),
  );
  const dns = providerState(input.report, ["dns"]);
  const productionUrl = input.verification?.deploymentEvidence?.productionUrl ?? "";
  const customDomain = input.verification?.deploymentEvidence?.customDomain ?? null;
  const accountingLimitations = [
    ...(modelCalls > 0 && !usage.complete
      ? [
          `Model usage is incomplete: ${modelCalls} model call(s) were recorded but complete token observations were not available for every call.`,
        ]
      : []),
    ...(input.filesRead === undefined || input.filesRead === null
      ? [
          "Observed file-read accounting is unavailable; selected context-manifest file counts are not reported as files actually read.",
        ]
      : []),
    ...(modelCalls > 0 && usage.failedCommands === null
      ? ["Build-agent failed-command accounting is unavailable for one or more model calls."]
      : []),
  ];
  const providerManualActions = input.report.remainingManualActions.map((action) => ({
    action: action.action,
    command: action.resumeCommand,
    evidence: action.evidenceNeeded.join("; ") || "Provider read-back evidence",
    impact: `Launch remains incomplete for ${action.nodeId} until this evidence is verified.`,
  }));
  if (reportedValidationAction && providerManualActions.length >= 100) {
    throw new Error(
      "Launch Receipt manual-action limit leaves no room for the reviewed first validation action",
    );
  }
  const validationManualAction = reportedValidationAction
    ? {
        action: reportedValidationAction.action,
        command:
          "Do not execute automatically; the founder performs this action outside Venture Harness after review",
        evidence: reportedValidationAction.evidenceRequired,
        impact:
          "This demand-validation action remains planned and human-gated; no outreach, response, demand, or conversion result is inferred.",
      }
    : null;
  const launchGapActions = (input.launchGaps ?? []).map((gap) => ({
    action: gap.nextAction,
    command: gap.nextAction,
    evidence: `${gap.provider ?? gap.role ?? gap.code} same-run provider read-back`,
    impact: `${gap.message} (${gap.state.replaceAll("_", " ")}; does not block the provider-URL launch).`,
  }));
  if (
    providerManualActions.length + launchGapActions.length + (validationManualAction ? 1 : 0) >
    100
  ) {
    throw new Error("Launch Receipt manual-action limit is too small for current launch gaps");
  }
  const candidate = {
    schemaVersion: 2 as const,
    launchContract: contract,
    venture: {
      name: input.report.brief.name,
      repository: resource(input.report, "github", ["repository_url", "repository"]),
      productionUrl,
      customDomain,
    },
    decision: {
      launchMode: contract.decision.launchMode,
      primarySuccessSignal: contract.decision.primarySuccessSignal,
      reviewDate: contract.decision.reviewDate,
      firstValidationAction: contract.distribution.firstValidationAction,
    },
    build: {
      seed: input.launchGrant?.seed.id ?? "not_recorded",
      coreVersion: input.launchGrant?.seed.version ?? "not_recorded",
      buildAgent:
        usage.buildAgent !== "not_recorded"
          ? usage.buildAgent
          : (input.launchGrant?.modelExecutionPolicy?.attestation ?? "not_recorded"),
      taskCount: modelTaskCount,
      modelCalls,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      toolCalls: usage.toolCalls,
      retries: Object.values(input.state.nodes).reduce(
        (sum, record) => sum + Math.max(0, record.attempts - 1),
        0,
      ),
      failedCommands: usage.failedCommands,
      elapsedMs,
      filesRead: input.filesRead ?? null,
      filesChanged: uniqueChangedFiles(input.state),
    },
    stack: { github, vercel, neon, commerce, email, analytics, search, dns },
    verification: {
      repository: github,
      deployment: vercel,
      database: neon,
      commerce,
      primaryJourney: primaryJourneyEvidence?.state ?? primaryJourneyFallback(input.state),
      primaryJourneyEvidence,
      evidenceArtifact: deploymentEvidence?.evidenceRef ?? null,
      accessibility: input.verification?.accessibility ?? "planned",
      rawHtml: input.verification?.rawHtml ?? "planned",
      providerReadBack: input.report.providers.map((provider) => ({
        provider: provider.provider,
        capability: provider.capability,
        state: providerOutcomeState(provider, fixture),
        evidenceRef: provider.evidenceRef ?? null,
      })),
    },
    manualActions: [
      ...providerManualActions,
      ...launchGapActions,
      ...(validationManualAction ? [validationManualAction] : []),
    ],
    limitations: [
      ...new Set([
        ...input.report.limitations,
        ...accountingLimitations,
        ...(input.launchGaps ?? []).map(
          (gap) =>
            `${gap.code}: ${gap.message} Next: ${gap.nextAction}. State: ${gap.state}; blocksLaunch=false.`,
        ),
        ...(reportedValidationAction
          ? [
              "The first validation action is planned and human-gated; Venture Harness did not send, post, or infer a result.",
            ]
          : []),
      ]),
    ],
  };
  // The generic redactor deliberately treats fields named "authorization" as
  // sensitive. That name is also a legitimate capability classification, so
  // preserve the already credential-rejected canonical contract byte-for-byte
  // while redacting the runtime/report-derived receipt fields around it.
  const redactableCandidate: Partial<typeof candidate> = { ...candidate };
  delete redactableCandidate.launchContract;
  return launchReceiptSchema.parse({
    ...redactor.redact(redactableCandidate),
    launchContract: contract,
  });
}

export function renderLaunchReceiptMarkdown(receiptInput: LaunchReceipt): string {
  const receipt = launchReceiptSchema.parse(receiptInput);
  const line = (label: string, state: LaunchReceiptEvidenceState) => `- ${label}: ${state}`;
  const renderedContract = renderLaunchContractYaml(receipt.launchContract)
    .trimEnd()
    .split("\n")
    .map((contractLine) => `    ${contractLine}`);
  return [
    `# Launch Receipt: ${receipt.venture.name}`,
    "",
    `- Repository: ${receipt.venture.repository || "not verified"}`,
    `- Production URL: ${receipt.venture.productionUrl || "not verified"}`,
    `- Custom domain: ${receipt.venture.customDomain ?? "not verified"}`,
    `- Mode: ${receipt.decision.launchMode}`,
    `- Success signal: ${receipt.decision.primarySuccessSignal}`,
    `- Review date: ${receipt.decision.reviewDate || "not recorded"}`,
    `- First validation action: ${receipt.decision.firstValidationAction || "not recorded"}`,
    "",
    "## Canonical Launch Contract",
    "",
    ...renderedContract,
    "",
    "## Build accounting",
    "",
    `- Seed / Core: ${receipt.build.seed} / ${receipt.build.coreVersion}`,
    `- Build agent: ${receipt.build.buildAgent}`,
    `- Model tasks / model calls: ${receipt.build.taskCount} / ${receipt.build.modelCalls}`,
    `- Tokens (input / cached / output / total): ${receipt.build.inputTokens ?? "unavailable"} / ${receipt.build.cachedInputTokens ?? "unavailable"} / ${receipt.build.outputTokens ?? "unavailable"} / ${receipt.build.totalTokens ?? "unavailable"}`,
    `- Retries / failed commands / elapsed ms: ${receipt.build.retries} / ${receipt.build.failedCommands ?? "unavailable"} / ${receipt.build.elapsedMs}`,
    `- Tool calls: ${receipt.build.toolCalls ?? "unavailable"}`,
    `- Files read / changed: ${receipt.build.filesRead ?? "unavailable"} / ${receipt.build.filesChanged}`,
    "",
    "## Stack and verification",
    "",
    ...Object.entries(receipt.stack).map(([label, state]) => line(label, state)),
    ...Object.entries(receipt.verification)
      .filter(
        ([label]) =>
          !["providerReadBack", "primaryJourneyEvidence", "evidenceArtifact"].includes(label),
      )
      .map(([label, state]) => line(label, state as LaunchReceiptEvidenceState)),
    `- primaryJourney evidence: ${receipt.verification.primaryJourneyEvidence?.evidenceRef ?? "not recorded"}`,
    `- production evidence artifact: ${receipt.verification.evidenceArtifact ?? "not recorded"}`,
    ...receipt.verification.providerReadBack.map(
      ({ provider, capability, state, evidenceRef }) =>
        `- providerReadBack ${provider}/${capability}: ${state}; evidence ${evidenceRef ?? "not recorded"}`,
    ),
    "",
    "## Manual actions",
    "",
    ...(receipt.manualActions.length > 0
      ? receipt.manualActions.map(
          (action) =>
            `- ${action.action} — run \`${action.command}\`; evidence: ${action.evidence}`,
        )
      : ["_No unresolved manual action is recorded._"]),
    "",
    "## Limitations",
    "",
    ...(receipt.limitations.length > 0
      ? receipt.limitations.map((limitation) => `- ${limitation}`)
      : ["_No limitation was recorded._"]),
    "",
    "This sanitized receipt is stored locally. Venture Harness does not upload it or phone home.",
    "",
  ].join("\n");
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

export async function persistLaunchReceipt(
  receiptInput: LaunchReceipt,
  outputDirectory: string,
): Promise<{ receipt: LaunchReceipt; jsonPath: string; markdownPath: string }> {
  const receipt = launchReceiptSchema.parse(receiptInput);
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jsonPath = join(directory, "receipt.json");
  const markdownPath = join(directory, "receipt.md");
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  const markdown = renderLaunchReceiptMarkdown(receipt);
  await Promise.all([atomicWrite(jsonPath, json), atomicWrite(markdownPath, markdown)]);
  const [storedJson, storedMarkdown] = await Promise.all([
    readFile(jsonPath, "utf8"),
    readFile(markdownPath, "utf8"),
  ]);
  if (storedJson !== json || storedMarkdown !== markdown) {
    throw new Error("Launch Receipt read-back did not match its rendered artifacts");
  }
  return { receipt, jsonPath, markdownPath };
}
