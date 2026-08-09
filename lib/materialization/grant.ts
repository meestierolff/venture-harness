import { createHash } from "node:crypto";
import { z } from "zod";
import type { LaunchEffect, LaunchGrant } from "./types";

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const effectSchema = z.enum([
  "repository.create",
  "company_stack.provision",
  "source.push",
  "preview.deploy",
  "production.deploy",
  "domain.configure",
  "commerce.configure",
  "loops.schedule",
]);

const providerDestinationSchema = z
  .object({
    capability: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
    provider: z.string().regex(/^[a-z][a-z0-9-]+$/),
    externalAccountId: z.string().min(1),
    ownerOrganizationId: z.string().min(1),
    stackClass: z.literal("company"),
    ownership: z.enum(["company_owned", "company_owned_dedicated_account"]),
  })
  .strict();

const launchGrantBodySchema = z
  .object({
    ownerOrganizationId: z.string().min(1),
    ventureName: z.string().min(1).max(100),
    ventureSlug: slug,
    ideaDigest: z.string().regex(/^[a-f0-9]{64}$/),
    seed: z
      .object({
        id: z.enum(["agentic-web-saas", "agentic-ios-subscription", "hybrid-agentic-service"]),
        version: semver,
      })
      .strict(),
    stackProfile: z.object({ id: slug, version: semver }).strict(),
    repository: z
      .object({
        owner: z.string().min(1),
        name: slug,
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    providerAccounts: z.array(providerDestinationSchema),
    autonomyProfile: z.enum(["plan_only", "owner_preview", "owner_live_launch"]),
    allowedExternalEffects: z.array(effectSchema).min(1),
    modelBudget: z
      .object({
        maxTokens: z.number().int().nonnegative(),
        maxMinorUnits: z.number().int().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
    externalResourceBudget: z
      .object({
        maxResources: z.number().int().positive(),
        maxMinorUnits: z.number().int().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
    modelExecutionPolicy: z
      .discriminatedUnion("mode", [
        z
          .object({
            mode: z.literal("chatgpt_subscription_non_metered"),
            maxBuildAgentTasks: z.number().int().positive(),
            attestation: z.literal("codex_login_status_chatgpt_subscription"),
            usageAccounting: z.literal("observational"),
          })
          .strict(),
        z
          .object({
            mode: z.literal("fixture_no_model_execution"),
            maxBuildAgentTasks: z.number().int().positive(),
            attestation: z.literal("fixture_build_host"),
            usageAccounting: z.literal("none"),
          })
          .strict(),
      ])
      .optional(),
    providerOperationBudget: z
      .object({
        maxOperations: z.number().int().positive(),
        maxDirectChargeMinorUnits: z.number().int().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        estimateBasis: z.literal("reviewed_known_zero_direct_charge"),
        ongoingAccountPlanUsageCovered: z.literal(false),
      })
      .strict()
      .optional(),
    permissions: z
      .object({
        productionDeployment: z.boolean(),
        domainConfiguration: z.boolean(),
        liveCommerceConfiguration: z.boolean(),
      })
      .strict(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    grantedBy: z
      .object({
        actorId: z.string().min(1),
        actorType: z.enum(["founder", "organization_owner"]),
      })
      .strict(),
    approvalRef: z.string().min(1),
    revokedAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Date(value.expiresAt) <= new Date(value.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Launch Grant expiry must be after creation",
      });
    }
    if (
      value.providerAccounts.some(
        (account) => account.ownerOrganizationId !== value.ownerOrganizationId,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerAccounts"],
        message: "CompanyStack accounts must be owned by the grant owner organization",
      });
    }
    const effects = new Set(value.allowedExternalEffects);
    if (effects.size !== value.allowedExternalEffects.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedExternalEffects"],
        message: "Launch Grant effects must be unique",
      });
    }
    if (effects.has("production.deploy") && !value.permissions.productionDeployment) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions", "productionDeployment"],
        message: "production.deploy requires explicit production deployment permission",
      });
    }
    if (effects.has("domain.configure") && !value.permissions.domainConfiguration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions", "domainConfiguration"],
        message: "domain.configure requires explicit domain permission",
      });
    }
    if (effects.has("commerce.configure") && !value.permissions.liveCommerceConfiguration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions", "liveCommerceConfiguration"],
        message: "commerce.configure requires explicit live-commerce permission",
      });
    }
    if (!value.modelExecutionPolicy && !value.modelBudget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelBudget"],
        message:
          "Launch Grant requires either a canonical model execution policy or the legacy hard-metered model budget",
      });
    }
    if (!value.providerOperationBudget && !value.externalResourceBudget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalResourceBudget"],
        message:
          "Launch Grant requires either a canonical provider-operation budget or the legacy hard-metered external budget",
      });
    }
    if (
      value.providerOperationBudget &&
      value.externalResourceBudget &&
      (value.providerOperationBudget.currency !== value.externalResourceBudget.currency ||
        value.providerOperationBudget.maxOperations !== value.externalResourceBudget.maxResources ||
        value.providerOperationBudget.maxDirectChargeMinorUnits !==
          value.externalResourceBudget.maxMinorUnits)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationBudget"],
        message: "Canonical provider-operation budget must match the legacy compatibility fields",
      });
    }
  });

const launchGrantSchema = z
  .object({
    grantId: z.string().regex(/^lg_[a-f0-9]{26}$/),
    schemaVersion: z.literal(1),
  })
  .merge(launchGrantBodySchema.innerType())
  .strict();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export type LaunchGrantInput = z.input<typeof launchGrantBodySchema>;

function immutableGrantBody(body: z.output<typeof launchGrantBodySchema>) {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "revokedAt"));
}

export function createLaunchGrant(input: LaunchGrantInput): LaunchGrant {
  const body = launchGrantBodySchema.parse(input);
  const grantId = `lg_${createHash("sha256")
    .update(stable(immutableGrantBody(body)))
    .digest("hex")
    .slice(0, 26)}`;
  return freeze(launchGrantSchema.parse({ grantId, schemaVersion: 1, ...body }) as LaunchGrant);
}

export function parseLaunchGrant(input: unknown): LaunchGrant {
  const parsed = launchGrantSchema.parse(input);
  const grantId = parsed.grantId;
  const candidateBody = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "grantId" && key !== "schemaVersion"),
  );
  const body = launchGrantBodySchema.parse(candidateBody);
  const expectedId = `lg_${createHash("sha256")
    .update(stable(immutableGrantBody(body)))
    .digest("hex")
    .slice(0, 26)}`;
  if (grantId !== expectedId)
    throw new Error("Launch Grant content does not match its immutable ID");
  return freeze({ grantId, schemaVersion: 1, ...body } as LaunchGrant);
}

export function assertLaunchGrantActive(grant: LaunchGrant, at: Date): void {
  parseLaunchGrant(grant);
  if (grant.revokedAt) throw new Error("Launch Grant is revoked");
  if (at < new Date(grant.createdAt)) throw new Error("Launch Grant is not active yet");
  if (at >= new Date(grant.expiresAt)) throw new Error("Launch Grant is expired");
}

export function assertLaunchEffectAuthorized(
  grant: LaunchGrant,
  effect: LaunchEffect,
  at: Date,
): void {
  assertLaunchGrantActive(grant, at);
  if (!grant.allowedExternalEffects.includes(effect)) {
    throw new Error(`Launch Grant does not authorize ${effect}`);
  }
}

export function revokeLaunchGrant(grant: LaunchGrant, at: Date): LaunchGrant {
  assertLaunchGrantActive(grant, at);
  return parseLaunchGrant({ ...grant, revokedAt: at.toISOString() });
}
