import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { artifactReferenceSchema, rejectCredentialMaterial } from "../config/contracts";
import { Redactor } from "../credentials";
import {
  orderPublicDnsRecords,
  providerPublicOutputsSchema,
  publicDnsRecordSchema,
  type PublicDnsRecord,
} from "../providers";
import type {
  JsonValue,
  WorkflowBindings,
  WorkflowInterruptEvidenceVerifier,
  WorkflowValidationContext,
} from "../workflow";

const propagationCheckSchema = z
  .object({
    resolver: z.string().min(1).max(253),
    checked_at: z.string().datetime({ offset: true }),
    status: z.literal("matched"),
  })
  .strict();

const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

export const manualDnsOutputSchema = z
  .object({
    mode: z.literal("manual_dns"),
    records: z.array(publicDnsRecordSchema).min(1).max(100),
    preserved_existing_mail_records: z.literal(true),
    preserved_nameservers: z.literal(true),
    propagation_checks: z.array(propagationCheckSchema).min(2).max(10),
  })
  .strict()
  .superRefine(rejectCredentialMaterial);

export const appleFirstAppRecordOutputSchema = z
  .object({
    app_name: z.string().min(1).max(255),
    bundle_identifier: z
      .string()
      // Segments are alphanumeric and separators are "." or "-". The previous
      // pattern allowed "-" in both the separator class and the segment class,
      // so a run of dashes could be split many ways and the match backtracked
      // catastrophically. This accepts the same identifiers unambiguously.
      .regex(/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/, "expected a reverse-DNS bundle ID"),
    sku: z.string().min(1).max(255),
    primary_language: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/),
    apple_app_id: z.string().regex(/^\d{6,20}$/),
    team_id: z.string().regex(/^[A-Z0-9]{10}$/),
    provider_state: z.literal("configured"),
    verified_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine(rejectCredentialMaterial);

const manualOutputSchemas = {
  "dns-records": manualDnsOutputSchema,
  "apple-first-app-record": appleFirstAppRecordOutputSchema,
} as const;

export type LaunchManualNodeId = keyof typeof manualOutputSchemas;

const manualEvidenceArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("manual_action_evidence"),
    run_id: z.string().min(1).max(120),
    node_id: z.string().min(1).max(120),
    status: z.literal("verified"),
    approved_by: z.string().min(1).max(300),
    verified_at: z.string().datetime({ offset: true }),
    output: z.unknown(),
    verification: z.array(z.string().min(1).max(1_000)).min(1).max(20),
    limitations: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  })
  .strict()
  .superRefine(rejectCredentialMaterial);

export interface LaunchManualActionContract {
  nodeId: LaunchManualNodeId;
  requiredFields: readonly string[];
  effect: string;
  risk: "medium" | "high";
  rollback: string;
  completionEvidence: readonly string[];
  evidencePath: string;
}

export const launchManualActionContracts: Readonly<
  Record<LaunchManualNodeId, LaunchManualActionContract>
> = {
  "dns-records": {
    nodeId: "dns-records",
    requiredFields: [
      "mode=manual_dns",
      "records[]: source_provider, type, name, value, ttl, optional priority, reason",
      "preserved_existing_mail_records=true",
      "preserved_nameservers=true",
      "propagation_checks[] from at least two resolvers",
    ],
    effect: "Add only the declared DNS records; do not replace nameservers or remove mail records.",
    risk: "high",
    rollback:
      "Remove only records created by this run after confirming no dependent service uses them.",
    completionEvidence: [
      "typed output matching the ordered DNS plan",
      "matched DNS read-back from at least two named resolvers",
      "explicit confirmation that existing MX, SPF, DKIM, and DMARC records were preserved",
    ],
    evidencePath: "reports/launch/<run-id>/manual/dns-records.json",
  },
  "apple-first-app-record": {
    nodeId: "apple-first-app-record",
    requiredFields: [
      "app_name",
      "bundle_identifier",
      "sku",
      "primary_language",
      "apple_app_id",
      "team_id",
      "provider_state=configured",
      "verified_at",
    ],
    effect: "Create the first App Store Connect app record; do not submit or publish a release.",
    risk: "medium",
    rollback: "No automatic deletion is attempted; correct the app record in App Store Connect.",
    completionEvidence: [
      "typed identifiers copied from the App Store Connect record",
      "provider_state=configured and a verification timestamp",
      "no claim of TestFlight processing or App Store publication",
    ],
    evidencePath: "reports/launch/<run-id>/manual/apple-first-app-record.json",
  },
};

export function expectedDnsRecordsFromDependencies(
  dependencyOutputs: Readonly<Record<string, JsonValue | undefined>>,
): PublicDnsRecord[] {
  const records: PublicDnsRecord[] = [];
  for (const output of Object.values(dependencyOutputs)) {
    if (!output || Array.isArray(output) || typeof output !== "object") continue;
    const parsed = providerPublicOutputsSchema.safeParse(output.publicOutputs);
    if (parsed.success) records.push(...parsed.data.dnsRecords);
  }
  return orderPublicDnsRecords(records);
}

function inside(rootDir: string, artifact: string): string {
  const root = realpathSync(rootDir);
  const target = resolve(root, artifact);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`Evidence artifact escapes the venture root: ${artifact}`);
  }
  return target;
}

function validatorFor(nodeId: string) {
  return manualOutputSchemas[nodeId as LaunchManualNodeId];
}

export function validateLaunchManualOutput(
  nodeId: string,
  output: unknown,
): {
  ok: boolean;
  message?: string;
} {
  const schema = validatorFor(nodeId);
  if (!schema) return { ok: false, message: `No manual output contract exists for ${nodeId}.` };
  const result = schema.safeParse(output);
  return result.success
    ? { ok: true }
    : {
        ok: false,
        message: `${nodeId} output is invalid: ${result.error.issues
          .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
          .join("; ")}`,
      };
}

export function launchManualOutputValidatorName(nodeId: LaunchManualNodeId): string {
  return `launch.manual.${nodeId}`;
}

export function createLaunchManualBindings(): WorkflowBindings {
  return {
    validators: Object.fromEntries(
      (Object.keys(manualOutputSchemas) as LaunchManualNodeId[]).map((nodeId) => [
        launchManualOutputValidatorName(nodeId),
        ({ output, dependencyOutputs }: WorkflowValidationContext) => {
          const validation = validateLaunchManualOutput(nodeId, output);
          if (!validation.ok || nodeId !== "dns-records") return validation;
          const expected = expectedDnsRecordsFromDependencies(dependencyOutputs);
          if (Object.keys(dependencyOutputs).length === 0) return { ok: true };
          if (expected.length === 0) {
            return {
              ok: false,
              message:
                "dns-records has no typed upstream provider record plan; do not infer a DNS value or complete a partial action.",
            };
          }
          const actual = manualDnsOutputSchema.parse(output).records;
          return isDeepStrictEqual(actual, expected)
            ? { ok: true }
            : {
                ok: false,
                message:
                  "dns-records output does not exactly match the ordered Vercel, Google, and Brevo record plan from this run.",
              };
        },
      ]),
    ),
  };
}

export function createRepositoryInterruptEvidenceVerifier(options: {
  rootDir: string;
  redactor?: Redactor;
  maxBytes?: number;
}): WorkflowInterruptEvidenceVerifier {
  const redactor = options.redactor ?? new Redactor();
  const maxBytes = options.maxBytes ?? 1_000_000;
  return (context) => {
    const parsedReference = artifactReferenceSchema.safeParse(context.evidenceArtifact);
    if (!parsedReference.success) {
      return { ok: false, message: parsedReference.error.issues[0]?.message };
    }
    const expected = `reports/launch/${context.runId}/manual/${context.node.id}.json`;
    if (context.evidenceArtifact !== expected) {
      return {
        ok: false,
        message: `Evidence for ${context.node.id} must use ${expected}.`,
      };
    }

    let path: string;
    try {
      path = inside(options.rootDir, context.evidenceArtifact);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    let raw: string;
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { ok: false, message: `Evidence file does not exist: ${expected}.` };
      }
      if (code === "ELOOP") {
        return {
          ok: false,
          message: `Evidence must be a regular non-symlink file: ${expected}.`,
        };
      }
      throw error;
    }
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        return {
          ok: false,
          message: `Evidence must be a regular non-symlink file: ${expected}.`,
        };
      }
      if (stat.size === 0 || stat.size > maxBytes) {
        return {
          ok: false,
          message: `Evidence size must be between 1 and ${maxBytes} bytes: ${expected}.`,
        };
      }
      raw = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }

    let artifact: z.infer<typeof manualEvidenceArtifactSchema>;
    try {
      artifact = manualEvidenceArtifactSchema.parse(JSON.parse(raw));
    } catch (error) {
      return {
        ok: false,
        message: `Evidence file is not valid typed JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (redactor.redactText(raw) !== raw) {
      return { ok: false, message: "Evidence contains registered credential material." };
    }
    if (
      artifact.run_id !== context.runId ||
      artifact.node_id !== context.node.id ||
      artifact.approved_by !== context.approvedBy
    ) {
      return {
        ok: false,
        message: "Evidence run_id, node_id, or approved_by does not match the active interrupt.",
      };
    }
    const outputValidation = validateLaunchManualOutput(context.node.id, artifact.output);
    if (!outputValidation.ok) return outputValidation;
    if (!isDeepStrictEqual(artifact.output, context.output)) {
      return { ok: false, message: "Evidence output does not match the submitted manual output." };
    }
    return { ok: true };
  };
}
