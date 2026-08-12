import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { findCredentialMaterial } from "../../packages/core/src/index";
import { credentialReferenceSchema } from "../config/contracts";
import {
  defaultCredentialCatalogPath,
  type CredentialBroker,
  type RegisterCredentialInput,
} from "../credentials";
import {
  providerRegistry,
  type ProviderExecutionContext,
  type ProviderId,
  type ProviderRegistry,
} from "../providers";

export const FOUNDER_STACK_PROFILE_ID = "founder-default" as const;
export const FOUNDER_STACK_SCHEMA_VERSION = 1 as const;

export const founderStackRoleDefinitions = {
  "source.repository": {
    providerId: "github",
    capabilities: ["repository"],
  },
  "hosting.web": {
    providerId: "vercel",
    capabilities: ["deployment"],
  },
  "database.postgres": {
    providerId: "neon",
    capabilities: ["project"],
  },
  "commerce.web": {
    providerId: "stripe",
    capabilities: ["product"],
  },
  "commerce.native": {
    providerId: "revenuecat",
    capabilities: ["entitlement"],
  },
  "email.transactional": {
    providerId: "brevo",
    capabilities: ["template"],
  },
  "growth.google": {
    providerId: "google",
    capabilities: ["analytics_property", "search_console_site"],
  },
  "search.bing": {
    providerId: "bing",
    capabilities: ["site"],
  },
  "dns.records": {
    providerId: "dns",
    capabilities: ["record"],
  },
} as const satisfies Readonly<
  Record<string, { providerId: ProviderId; capabilities: readonly string[] }>
>;

export type FounderStackRole = keyof typeof founderStackRoleDefinitions;
export type FounderStackProviderId =
  (typeof founderStackRoleDefinitions)[FounderStackRole]["providerId"];

export const founderStackRequiredRoles = [
  "source.repository",
  "hosting.web",
  "database.postgres",
  "commerce.web",
] as const satisfies readonly FounderStackRole[];

export const founderStackOptionalRoles = [
  "commerce.native",
  "email.transactional",
  "growth.google",
  "search.bing",
  "dns.records",
] as const satisfies readonly FounderStackRole[];

const founderStackOptionalRoleSchema = z.enum(founderStackOptionalRoles);

const canonicalIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u, "expected a canonical organization identifier");

const safeMetadataSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => value.trim() === value, "metadata must not have surrounding whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "metadata contains control characters");

const safeScopeSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => value.trim() === value, "scope must not have surrounding whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "scope contains control characters");

const founderStackVerificationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unverified") }).strict(),
  z
    .object({
      status: z.literal("verified"),
      verifiedAt: z.string().datetime({ offset: true }),
      source: z.enum(["official_cli", "official_api", "manual_read_back"]),
    })
    .strict(),
]);

const founderStackCliSessionSchema = z
  .object({
    installed: z.boolean(),
    authenticated: z.boolean(),
    accountId: safeMetadataSchema.nullable(),
    mode: z.literal("test").nullable(),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.authenticated && (!value.accountId || !value.verifiedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "an authenticated CLI session requires safe account metadata and verification time",
      });
    }
  });

const founderStackCliSessionsSchema = z
  .object({
    github: founderStackCliSessionSchema.nullable(),
    vercel: founderStackCliSessionSchema.nullable(),
    stripe: founderStackCliSessionSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const provider of ["github", "vercel"] as const) {
      if (value[provider] && value[provider].mode !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [provider, "mode"],
          message: `${provider} CLI metadata must not claim a commerce mode`,
        });
      }
    }
    if (value.stripe?.authenticated && value.stripe.mode !== "test") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stripe", "mode"],
        message: "an authenticated Stripe CLI session must prove test mode",
      });
    }
  });

const founderStackRoleConnectionSchema = z
  .object({
    credentialRef: credentialReferenceSchema.optional(),
    accountId: safeMetadataSchema.optional(),
    teamId: safeMetadataSchema.optional(),
    organizationId: safeMetadataSchema.optional(),
    scopes: z
      .array(safeScopeSchema)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    verification: founderStackVerificationSchema,
  })
  .strict();

const founderStackRolesSchema = z
  .object({
    "source.repository": founderStackRoleConnectionSchema,
    "hosting.web": founderStackRoleConnectionSchema,
    "database.postgres": founderStackRoleConnectionSchema,
    "commerce.web": founderStackRoleConnectionSchema,
    "commerce.native": founderStackRoleConnectionSchema,
    "email.transactional": founderStackRoleConnectionSchema,
    "growth.google": founderStackRoleConnectionSchema,
    "search.bing": founderStackRoleConnectionSchema,
    "dns.records": founderStackRoleConnectionSchema,
  })
  .strict();

const durableWritableBackendSchema = z.enum(["macos_keychain", "onepassword"]);
const writableCredentialBackendSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("shared"),
      backend: durableWritableBackendSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("per_template"),
      backends: z
        .object({
          neonDatabaseUri: durableWritableBackendSchema,
          stripeWebhookSigning: durableWritableBackendSchema,
          googleAnalyticsMeasurementId: durableWritableBackendSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("fixture"),
      backend: z.literal("memory"),
      fixtureLabel: canonicalIdentifierSchema,
    })
    .strict(),
]);

const founderStackLaunchDefaultsSchema = z
  .object({
    neon: z.object({ region: safeMetadataSchema.nullable() }).strict(),
    stripe: z.object({ mode: z.literal("test") }).strict(),
    brevo: z
      .object({
        senderName: safeMetadataSchema.nullable(),
        senderEmail: z.string().email().max(300).nullable(),
        templateName: safeMetadataSchema.nullable(),
        templateSubject: safeMetadataSchema.nullable(),
        templateHtml: safeMetadataSchema.nullable(),
      })
      .strict(),
    google: z.object({ analyticsAccountId: safeMetadataSchema.nullable() }).strict(),
    bing: z.object({ authMode: z.enum(["api_key", "oauth"]).nullable() }).strict(),
    dns: z
      .object({
        providerId: z.literal("dns"),
        adapter: z.enum(["manual_generic", "mijndomein_manual"]).nullable(),
        registrarAccountId: safeMetadataSchema.nullable(),
        zoneId: safeMetadataSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const founderStackConnectionSchema = z
  .object({
    schemaVersion: z.literal(FOUNDER_STACK_SCHEMA_VERSION),
    profileId: z.literal(FOUNDER_STACK_PROFILE_ID),
    ownerOrganizationId: canonicalIdentifierSchema,
    selectedOptionalRoles: z
      .array(founderStackOptionalRoleSchema)
      .max(founderStackOptionalRoles.length)
      .refine((values) => new Set(values).size === values.length)
      .default(["email.transactional", "growth.google", "search.bing", "dns.records"]),
    inspectedCliSessions: founderStackCliSessionsSchema.default({
      github: null,
      vercel: null,
      stripe: null,
    }),
    roles: founderStackRolesSchema,
    writableCredentialBackend: writableCredentialBackendSchema,
    launchDefaults: founderStackLaunchDefaultsSchema,
    writableRefs: z
      .object({
        neonDatabaseUriTemplate: z.literal("cred://neon/{ventureSlug}-database"),
        stripeWebhookSigningTemplate: z.literal("cred://stripe/{ventureSlug}-webhook"),
        googleAnalyticsMeasurementIdTemplate: z.literal(
          "cred://google/{ventureSlug}-measurement-id",
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [role, definition] of Object.entries(founderStackRoleDefinitions) as Array<
      [FounderStackRole, (typeof founderStackRoleDefinitions)[FounderStackRole]]
    >) {
      const credentialRef = value.roles[role].credentialRef;
      if (credentialRef && !credentialRef.startsWith(`cred://${definition.providerId}/`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", role, "credentialRef"],
          message: `${role} requires a cred://${definition.providerId}/ reference`,
        });
      }
      if (definition.providerId === "dns" && credentialRef) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", role, "credentialRef"],
          message:
            "the provider-neutral DNS role is manual-only and must not store a credential reference",
        });
      }
      if (
        definition.providerId !== "dns" &&
        value.roles[role].verification.status === "verified" &&
        !credentialRef
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", role, "verification"],
          message: `${role} cannot declare credential verification without a credential reference`,
        });
      }
    }
  });

export type FounderStackRoleConnection = z.infer<typeof founderStackRoleConnectionSchema>;
export type FounderStackConnection = z.infer<typeof founderStackConnectionSchema>;

export interface FounderStackConnectionDraftRole {
  readonly role: FounderStackRole;
  readonly credentialRef?: string;
  readonly accountId?: string;
  readonly teamId?: string;
  readonly organizationId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: string;
  readonly verifiedBy?: "official_cli" | "official_api" | "manual_read_back";
}

export interface FounderStackConnectionDraftInput {
  readonly ownerOrganizationId: string;
  readonly roles: readonly FounderStackConnectionDraftRole[];
  readonly inspectedCliSessions?: {
    readonly github?: z.input<typeof founderStackCliSessionSchema> | null;
    readonly vercel?: z.input<typeof founderStackCliSessionSchema> | null;
    readonly stripe?: z.input<typeof founderStackCliSessionSchema> | null;
  };
  readonly selectedOptionalRoles?: readonly (typeof founderStackOptionalRoles)[number][];
  readonly writableCredentialBackend?:
    | { readonly mode: "shared"; readonly backend: "macos_keychain" | "onepassword" }
    | {
        readonly mode: "per_template";
        readonly backends: {
          readonly neonDatabaseUri: "macos_keychain" | "onepassword";
          readonly stripeWebhookSigning: "macos_keychain" | "onepassword";
          readonly googleAnalyticsMeasurementId: "macos_keychain" | "onepassword";
        };
      };
  readonly launchDefaults?: {
    readonly neonRegion?: string | null;
    readonly brevo?: {
      readonly senderName?: string | null;
      readonly senderEmail?: string | null;
      readonly templateName?: string | null;
      readonly templateSubject?: string | null;
      readonly templateHtml?: string | null;
    };
    readonly googleAnalyticsAccountId?: string | null;
    readonly bingAuthMode?: "api_key" | "oauth" | null;
    readonly dns?: {
      readonly adapter?: "manual_generic" | "mijndomein_manual" | null;
      readonly registrarAccountId?: string | null;
      readonly zoneId?: string | null;
    };
  };
  readonly verifiedAt?: string;
}

/** Build a strict, credential-value-free profile from wizard-safe metadata. */
export function createFounderStackConnectionDraft(
  input: FounderStackConnectionDraftInput,
): FounderStackConnection {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const byRole = new Map(input.roles.map((role) => [role.role, role]));
  const roles = Object.fromEntries(
    (Object.keys(founderStackRoleDefinitions) as FounderStackRole[]).map((role) => {
      const collected = byRole.get(role);
      return [
        role,
        {
          ...(collected?.credentialRef ? { credentialRef: collected.credentialRef } : {}),
          ...(collected?.accountId ? { accountId: collected.accountId } : {}),
          ...(collected?.teamId ? { teamId: collected.teamId } : {}),
          ...(collected?.organizationId ? { organizationId: collected.organizationId } : {}),
          scopes: [...(collected?.scopes ?? [])],
          ...(collected?.expiresAt ? { expiresAt: collected.expiresAt } : {}),
          verification:
            collected?.verifiedBy && collected.credentialRef
              ? { status: "verified", verifiedAt, source: collected.verifiedBy }
              : { status: "unverified" },
        },
      ];
    }),
  );
  const defaults = input.launchDefaults;
  const brevo = defaults?.brevo;
  const dns = defaults?.dns;
  return parseFounderStackConnection({
    schemaVersion: FOUNDER_STACK_SCHEMA_VERSION,
    profileId: FOUNDER_STACK_PROFILE_ID,
    ownerOrganizationId: input.ownerOrganizationId,
    selectedOptionalRoles: input.selectedOptionalRoles ?? [
      "email.transactional",
      "growth.google",
      "search.bing",
      "dns.records",
    ],
    inspectedCliSessions: {
      github: input.inspectedCliSessions?.github ?? null,
      vercel: input.inspectedCliSessions?.vercel ?? null,
      stripe: input.inspectedCliSessions?.stripe ?? null,
    },
    roles,
    writableCredentialBackend: input.writableCredentialBackend ?? {
      mode: "shared",
      backend: "macos_keychain",
    },
    launchDefaults: {
      neon: { region: defaults?.neonRegion ?? null },
      stripe: { mode: "test" },
      brevo: {
        senderName: brevo?.senderName ?? null,
        senderEmail: brevo?.senderEmail ?? null,
        templateName: brevo?.templateName ?? null,
        templateSubject: brevo?.templateSubject ?? null,
        templateHtml: brevo?.templateHtml ?? null,
      },
      google: { analyticsAccountId: defaults?.googleAnalyticsAccountId ?? null },
      bing: { authMode: defaults?.bingAuthMode ?? null },
      dns: {
        providerId: "dns",
        adapter: dns?.adapter ?? null,
        registrarAccountId: dns?.registrarAccountId ?? null,
        zoneId: dns?.zoneId ?? null,
      },
    },
    writableRefs: {
      neonDatabaseUriTemplate: "cred://neon/{ventureSlug}-database",
      stripeWebhookSigningTemplate: "cred://stripe/{ventureSlug}-webhook",
      googleAnalyticsMeasurementIdTemplate: "cred://google/{ventureSlug}-measurement-id",
    },
  });
}

export function founderStackCliSessionCredentialRegistrations(
  connection: FounderStackConnection,
): RegisterCredentialInput[] {
  const parsed = parseFounderStackConnection(connection);
  return (
    Object.entries(founderStackRoleDefinitions) as Array<
      [FounderStackRole, (typeof founderStackRoleDefinitions)[FounderStackRole]]
    >
  ).flatMap(([role, definition]) => {
    const metadata = parsed.roles[role];
    if (
      (definition.providerId !== "github" && definition.providerId !== "vercel") ||
      !metadata.credentialRef ||
      metadata.verification.status !== "verified" ||
      metadata.verification.source !== "official_cli"
    ) {
      return [];
    }
    return [
      {
        ref: metadata.credentialRef,
        provider: definition.providerId,
        kind: "cli_session" as const,
        backend: "cli_session",
        label: `${definition.providerId} official CLI session`,
        scopes: [...metadata.scopes],
        ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
        ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
        testedAt: metadata.verification.verifiedAt,
        testStatus: "passed" as const,
      },
    ];
  });
}

export function founderStackDnsDestinationId(
  connection: FounderStackConnection | null,
): string | null {
  const selected = connection?.roles["dns.records"];
  return (
    connection?.launchDefaults.dns.registrarAccountId ??
    selected?.accountId ??
    selected?.organizationId ??
    null
  );
}

function credentialFinding(
  value: FounderStackConnection,
): ReturnType<typeof findCredentialMaterial> {
  const { writableCredentialBackend, ...credentialSafeRecord } = value;
  return (
    findCredentialMaterial(credentialSafeRecord, {
      allowedCredentialReferenceKeys: ["credentialRef"],
    }) ?? findCredentialMaterial(writableCredentialBackend)
  );
}

/** Parse an exact v1 profile without ever echoing rejected credential-like input. */
export function parseFounderStackConnection(value: unknown): FounderStackConnection {
  const parsed = founderStackConnectionSchema.parse(value);
  const finding = credentialFinding(parsed);
  if (finding) {
    throw new Error(`Founder Stack connection contains forbidden material at ${finding.path}`);
  }
  return parsed;
}

const MAX_CONNECTION_FILE_BYTES = 1_000_000;

function checkedProfileId(profileId: string): typeof FOUNDER_STACK_PROFILE_ID {
  if (profileId !== FOUNDER_STACK_PROFILE_ID) {
    throw new Error(`Unsupported Founder Stack profile: ${profileId}`);
  }
  return profileId;
}

function readRegularFile(path: string, label: string): string {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    if (metadata.size > MAX_CONNECTION_FILE_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_CONNECTION_FILE_BYTES}-byte limit`);
    }
    return readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} must be a readable regular non-symlink file`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function containedInputPath(baseDir: string, file: string): string {
  if (!file || isAbsolute(file)) {
    throw new Error("Founder Stack --file must be a project-relative path");
  }
  const root = resolve(baseDir);
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Founder Stack --file escapes the project root");
  }
  return path;
}

function assertRealInputContainment(baseDir: string, path: string): void {
  const root = realpathSync(resolve(baseDir));
  const target = realpathSync(path);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Founder Stack --file resolves outside the project root");
  }
}

export function loadFounderStackConnectionFile(
  file: string,
  options: { baseDir?: string } = {},
): FounderStackConnection {
  const path = containedInputPath(options.baseDir ?? process.cwd(), file);
  if (!existsSync(path)) throw new Error(`Founder Stack connection file does not exist: ${file}`);
  assertRealInputContainment(options.baseDir ?? process.cwd(), path);
  const content = readRegularFile(path, "Founder Stack connection file");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Founder Stack connection file must contain canonical JSON");
  }
  return parseFounderStackConnection(value);
}

export function defaultFounderStackStateRoot(): string {
  return join(dirname(defaultCredentialCatalogPath()), "founder-stacks");
}

export interface FounderStackStore {
  load(profileId: typeof FOUNDER_STACK_PROFILE_ID): FounderStackConnection | null;
  save(connection: FounderStackConnection): FounderStackConnection;
}

function ensureStateRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Founder Stack state root must be a regular non-symlink directory");
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export class FileFounderStackStore implements FounderStackStore {
  readonly rootDir: string;

  constructor(rootDir = defaultFounderStackStateRoot()) {
    this.rootDir = resolve(rootDir);
  }

  pathFor(profileId: typeof FOUNDER_STACK_PROFILE_ID): string {
    return join(this.rootDir, `${checkedProfileId(profileId)}.v1.json`);
  }

  load(profileId: typeof FOUNDER_STACK_PROFILE_ID): FounderStackConnection | null {
    ensureStateRoot(this.rootDir);
    const path = this.pathFor(profileId);
    if (!existsSync(path)) return null;
    const content = readRegularFile(path, "Founder Stack state file");
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error(
        "Founder Stack state file is not valid JSON; restore it from trusted metadata",
      );
    }
    return parseFounderStackConnection(value);
  }

  save(connection: FounderStackConnection): FounderStackConnection {
    const parsed = parseFounderStackConnection(connection);
    ensureStateRoot(this.rootDir);
    const path = this.pathFor(parsed.profileId);
    if (existsSync(path)) {
      const current = this.load(parsed.profileId);
      if (current && current.ownerOrganizationId !== parsed.ownerOrganizationId) {
        throw new Error("Founder Stack profile belongs to another organization");
      }
    }
    const temporary = join(this.rootDir, `.${parsed.profileId}.${process.pid}.${Date.now()}.next`);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      writeFileSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      syncDirectory(this.rootDir);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    return parsed;
  }
}

export type FounderStackDoctorRoleStatus =
  "ready" | "auth_required" | "manual_only" | "unconfigured";

export interface FounderStackDoctorRoleResult {
  readonly role: FounderStackRole;
  readonly providerId: FounderStackProviderId;
  readonly blocksLaunch: boolean;
  readonly status: FounderStackDoctorRoleStatus;
  readonly credentialRef: string | null;
  readonly accountId: string | null;
  readonly teamId: string | null;
  readonly organizationId: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly declaredVerification: FounderStackRoleConnection["verification"];
  readonly providerDoctorStatus: string;
  readonly issueCodes: readonly string[];
  readonly missingLaunchDefaults: readonly string[];
  readonly nextCommand: string;
  readonly liveProviderState: "not_checked";
}

export interface FounderStackDoctorResult {
  readonly schemaVersion: 1;
  readonly profileId: typeof FOUNDER_STACK_PROFILE_ID;
  readonly ownerOrganizationId: string | null;
  /** Present for persisted Stack profiles; optional for older in-memory doctor fixtures. */
  readonly inspectedCliSessions?: FounderStackConnection["inspectedCliSessions"];
  readonly status: "ready" | "attention_required";
  readonly launchReady: boolean;
  readonly roles: readonly FounderStackDoctorRoleResult[];
  readonly unresolvedActions: readonly {
    role: FounderStackRole;
    providerId: FounderStackProviderId;
    why: string;
    command: string;
    blocksLaunch: boolean;
  }[];
  readonly writableCredentialTargets: FounderStackWritableCredentialPreflight;
  readonly externalEffects: false;
  readonly launchGrantRequired: false;
  readonly verificationScope: "credential_and_transport_readiness_only";
  readonly liveProviderState: "not_checked";
}

function defaultRoleConnection(): FounderStackRoleConnection {
  return { scopes: [], verification: { status: "unverified" } };
}

function loginCommand(providerId: FounderStackProviderId): string {
  if (providerId === "github" || providerId === "vercel") {
    return `vh auth login ${providerId} --ref cred://${providerId}/founder-default`;
  }
  const role = (
    Object.entries(founderStackRoleDefinitions) as Array<
      [FounderStackRole, (typeof founderStackRoleDefinitions)[FounderStackRole]]
    >
  ).find(([, definition]) => definition.providerId === providerId)?.[0];
  return role && providerId !== "revenuecat"
    ? `vh stack connect founder-default --role ${role}`
    : `vh auth login ${providerId} --ref cred://${providerId}/founder-default`;
}

function includesScopes(actual: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => actual.includes(scope) || actual.includes("*"));
}

const writableCaptureRoles = new Set<FounderStackRole>([
  "database.postgres",
  "commerce.web",
  "growth.google",
]);

const defaultSelectedOptionalRoles = new Set<FounderStackRole>([
  "email.transactional",
  "growth.google",
  "search.bing",
  "dns.records",
]);

function activeFounderStackRoles(connection: FounderStackConnection | null): FounderStackRole[] {
  const selected = new Set<FounderStackRole>(
    connection?.selectedOptionalRoles ?? defaultSelectedOptionalRoles,
  );
  return (Object.keys(founderStackRoleDefinitions) as FounderStackRole[]).filter((role) => {
    if (founderStackRequiredRoles.includes(role as (typeof founderStackRequiredRoles)[number])) {
      return true;
    }
    if (selected.has(role)) return true;
    const configured = connection?.roles[role];
    return Boolean(
      configured?.credentialRef ||
      configured?.accountId ||
      configured?.teamId ||
      configured?.organizationId,
    );
  });
}

function missingLaunchDefaults(
  connection: FounderStackConnection | null,
  role: FounderStackRole,
): string[] {
  if (role === "database.postgres" && !connection?.launchDefaults.neon.region) {
    return ["launchDefaults.neon.region"];
  }
  if (role === "email.transactional") {
    const brevo = connection?.launchDefaults.brevo;
    return [
      ["senderName", brevo?.senderName],
      ["senderEmail", brevo?.senderEmail],
      ["templateName", brevo?.templateName],
      ["templateSubject", brevo?.templateSubject],
      ["templateHtml", brevo?.templateHtml],
    ]
      .filter(([, value]) => !value)
      .map(([field]) => `launchDefaults.brevo.${field}`);
  }
  if (role === "growth.google" && !connection?.launchDefaults.google.analyticsAccountId) {
    return ["launchDefaults.google.analyticsAccountId"];
  }
  if (role === "search.bing" && !connection?.launchDefaults.bing.authMode) {
    return ["launchDefaults.bing.authMode"];
  }
  if (role === "dns.records") {
    return [
      ...(!connection?.launchDefaults.dns.adapter ? ["launchDefaults.dns.adapter"] : []),
      ...(!founderStackDnsDestinationId(connection)
        ? ["launchDefaults.dns.registrarAccountId or roles.dns.records.accountId/organizationId"]
        : []),
    ];
  }
  return [];
}

function exactRoleRepairCommand(
  role: FounderStackRole,
  providerId: FounderStackProviderId,
  status: FounderStackDoctorRoleStatus,
  credentialRef: string | undefined,
  credentialTestStatus: "passed" | "failed" | null,
  missingDefaults: readonly string[],
  writableCredentialTargets: FounderStackWritableCredentialPreflight,
): string {
  if (status === "ready" || status === "manual_only") return "vh launch --dry-run";
  if (role === "source.repository" || role === "hosting.web") {
    return loginCommand(providerId);
  }
  if (status === "auth_required" && credentialRef) {
    if (
      credentialTestStatus === "failed" &&
      (role === "database.postgres" ||
        role === "commerce.web" ||
        role === "email.transactional" ||
        role === "growth.google" ||
        role === "search.bing")
    ) {
      return `vh stack connect founder-default --role ${role}`;
    }
    return `vh auth test ${providerId} --ref ${credentialRef}`;
  }
  if (
    role === "database.postgres" ||
    role === "commerce.web" ||
    role === "email.transactional" ||
    role === "growth.google" ||
    role === "search.bing" ||
    role === "dns.records"
  ) {
    return `vh stack connect founder-default --role ${role}`;
  }
  if (missingDefaults.length > 0 || writableCredentialTargets.status !== "ready") {
    return "vh stack create founder-default --file <connection.json>";
  }
  return loginCommand(providerId);
}

export async function doctorFounderStackConnection(options: {
  connection: FounderStackConnection | null;
  context: ProviderExecutionContext;
  registry?: ProviderRegistry;
  now?: () => Date;
}): Promise<FounderStackDoctorResult> {
  const registry = options.registry ?? providerRegistry;
  const now = options.now ?? (() => new Date());
  const context = { ...options.context, authorization: "dry_run" as const };
  let writableCredentialTargets: FounderStackWritableCredentialPreflight;
  if (!options.connection || !context.credentials) {
    writableCredentialTargets = {
      status: "unconfigured",
      fixtureOnly: options.connection?.writableCredentialBackend.mode === "fixture",
      targets: [],
      nextCommand: "vh stack create founder-default --file <connection.json>",
    };
  } else {
    try {
      const registered = await registerFounderStackWritableCredentialRefs(
        options.connection,
        { ventureSlug: "founder-stack-doctor" },
        context.credentials,
      );
      writableCredentialTargets = {
        status: "ready",
        fixtureOnly: options.connection.writableCredentialBackend.mode === "fixture",
        targets: registered.inspections.map(({ purpose, ref, backend, status }) => ({
          purpose,
          ref,
          backend,
          status,
        })),
        nextCommand: "vh launch --dry-run",
      };
    } catch {
      writableCredentialTargets = {
        status: "unconfigured",
        fixtureOnly: options.connection.writableCredentialBackend.mode === "fixture",
        targets: [],
        nextCommand:
          options.connection.writableCredentialBackend.mode === "shared"
            ? `vh stack connect founder-default --role database.postgres --credential-backend ${options.connection.writableCredentialBackend.backend}`
            : "vh stack connect founder-default --role database.postgres",
      };
    }
  }
  const roles = await Promise.all(
    activeFounderStackRoles(options.connection).map(async (role) => {
      const definition = founderStackRoleDefinitions[role];
      const connection = options.connection?.roles[role] ?? defaultRoleConnection();
      const missingDefaults = missingLaunchDefaults(options.connection, role);
      const adapter = registry.get(definition.providerId);
      const doctor = await adapter.doctor(
        {
          credentialRefs: connection.credentialRef ? [connection.credentialRef] : [],
          requiredCapabilities: [...definition.capabilities],
        },
        context,
      );
      const manualOnly = adapter.descriptor.transports.every((transport) => transport === "manual");
      let authenticated = false;
      let metadataMatches = true;
      let credentialTestStatus: "passed" | "failed" | null = null;
      if (connection.credentialRef && context.credentials) {
        try {
          const inspection = await context.credentials.inspect(connection.credentialRef);
          const reference = context.credentials.getReference(connection.credentialRef);
          credentialTestStatus = inspection.testStatus ?? null;
          authenticated =
            inspection.status === "available" &&
            ((inspection.kind === "cli_session" && inspection.backend === "cli_session") ||
              (inspection.testStatus === "passed" &&
                inspection.testedAt !== undefined &&
                (definition.providerId !== "stripe" || inspection.providerMode === "test")));
          metadataMatches =
            reference?.provider === definition.providerId &&
            (definition.providerId === "stripe"
              ? Boolean(connection.accountId && reference.accountId === connection.accountId)
              : !connection.accountId ||
                !reference.accountId ||
                connection.accountId === reference.accountId) &&
            includesScopes(reference.scopes, connection.scopes) &&
            (!connection.expiresAt || Date.parse(connection.expiresAt) > now().getTime());
        } catch {
          authenticated = false;
          metadataMatches = false;
        }
      }
      let status: FounderStackDoctorRoleStatus = manualOnly
        ? "manual_only"
        : !connection.credentialRef
          ? "unconfigured"
          : doctor.status === "ready" && authenticated && metadataMatches
            ? "ready"
            : doctor.status === "unavailable" || doctor.status === "degraded"
              ? "unconfigured"
              : "auth_required";
      if (
        status === "ready" &&
        writableCaptureRoles.has(role) &&
        writableCredentialTargets.status !== "ready"
      ) {
        status = "unconfigured";
      }
      if (missingDefaults.length > 0) status = "unconfigured";
      const nextCommand = exactRoleRepairCommand(
        role,
        definition.providerId,
        status,
        connection.credentialRef,
        credentialTestStatus,
        missingDefaults,
        writableCredentialTargets,
      );
      return {
        role,
        providerId: definition.providerId,
        blocksLaunch: founderStackRequiredRoles.includes(
          role as (typeof founderStackRequiredRoles)[number],
        ),
        status,
        credentialRef: connection.credentialRef ?? null,
        accountId: connection.accountId ?? null,
        teamId: connection.teamId ?? null,
        organizationId: connection.organizationId ?? null,
        scopes: [...connection.scopes],
        expiresAt: connection.expiresAt ?? null,
        declaredVerification: connection.verification,
        providerDoctorStatus: doctor.status,
        issueCodes: doctor.issues.map(({ code }) => code),
        missingLaunchDefaults: missingDefaults,
        nextCommand,
        liveProviderState: "not_checked" as const,
      };
    }),
  );
  const launchReady = roles
    .filter(({ blocksLaunch }) => blocksLaunch)
    .every(({ status }) => status === "ready" || status === "manual_only");
  const unresolvedActions = roles
    .filter(({ status }) => status !== "ready" && status !== "manual_only")
    .map(
      ({
        role,
        providerId,
        status,
        issueCodes,
        missingLaunchDefaults,
        nextCommand,
        blocksLaunch,
      }) => ({
        role,
        providerId,
        why:
          missingLaunchDefaults.length > 0
            ? `Missing ${missingLaunchDefaults.join(", ")}.`
            : issueCodes.length > 0
              ? `${providerId} doctor reported ${issueCodes.join(", ")} (${status}).`
              : `${providerId} is ${status}.`,
        command: nextCommand,
        blocksLaunch,
      }),
    );
  return {
    schemaVersion: 1,
    profileId: FOUNDER_STACK_PROFILE_ID,
    ownerOrganizationId: options.connection?.ownerOrganizationId ?? null,
    inspectedCliSessions: options.connection?.inspectedCliSessions ?? {
      github: null,
      vercel: null,
      stripe: null,
    },
    status: roles.every(({ status }) => status === "ready" || status === "manual_only")
      ? "ready"
      : "attention_required",
    launchReady,
    roles,
    unresolvedActions,
    writableCredentialTargets,
    externalEffects: false,
    launchGrantRequired: false,
    verificationScope: "credential_and_transport_readiness_only",
    liveProviderState: "not_checked",
  };
}

const ventureSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, "expected a canonical venture slug");

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "expected a lowercase domain without a scheme or path",
  );

export interface FounderProviderConfigOverride {
  readonly state: "unconfigured" | "auth_required";
  readonly credential_ref: string | null;
  readonly account_id: string | null;
  readonly team_id: string | null;
  readonly region: string | null;
  readonly required_scopes: readonly string[];
  readonly last_verified_at: null;
  readonly external_resource_ids: Readonly<Record<string, string>>;
  readonly selected_transport?: "manual";
}

export interface RenderedFounderStackProviderOverrides {
  readonly profileId: typeof FOUNDER_STACK_PROFILE_ID;
  readonly ownerOrganizationId: string;
  readonly ventureSlug: string;
  readonly domain: string | null;
  readonly writableCredentialRefs: {
    readonly neonDatabaseUri: string;
    readonly stripeWebhookSigning: string;
    readonly googleAnalyticsMeasurementId: string;
  };
  readonly writableCredentialRegistrations: readonly FounderStackWritableCredentialRegistration[];
  readonly providers: Readonly<Record<FounderStackProviderId, FounderProviderConfigOverride>>;
}

export interface FounderStackWritableCredentialRegistration extends RegisterCredentialInput {
  readonly purpose:
    "neon_database_uri" | "stripe_webhook_signing" | "google_analytics_measurement_id";
}

export interface FounderStackWritableCredentialPreflight {
  readonly status: "ready" | "unconfigured";
  readonly fixtureOnly: boolean;
  readonly targets: readonly {
    purpose: FounderStackWritableCredentialRegistration["purpose"];
    ref: string;
    backend: string;
    status: string;
  }[];
  readonly nextCommand: string;
}

function writableBackendFor(
  connection: FounderStackConnection,
  template: "neonDatabaseUri" | "stripeWebhookSigning" | "googleAnalyticsMeasurementId",
): string {
  const selection = connection.writableCredentialBackend;
  if (selection.mode === "fixture" || selection.mode === "shared") return selection.backend;
  return selection.backends[template];
}

export function renderFounderStackProviderConfigOverrides(
  connection: FounderStackConnection,
  input: { ventureSlug: string; domain?: string | null },
): RenderedFounderStackProviderOverrides {
  const parsed = parseFounderStackConnection(connection);
  const ventureSlug = ventureSlugSchema.parse(input.ventureSlug);
  const domain =
    input.domain === undefined || input.domain === null ? null : domainSchema.parse(input.domain);
  const roleForProvider = new Map<FounderStackProviderId, FounderStackRoleConnection>();
  for (const [role, definition] of Object.entries(founderStackRoleDefinitions) as Array<
    [FounderStackRole, (typeof founderStackRoleDefinitions)[FounderStackRole]]
  >) {
    roleForProvider.set(definition.providerId, parsed.roles[role]);
  }
  const neonDatabaseUri = parsed.writableRefs.neonDatabaseUriTemplate.replace(
    "{ventureSlug}",
    ventureSlug,
  );
  const stripeWebhookSigning = parsed.writableRefs.stripeWebhookSigningTemplate.replace(
    "{ventureSlug}",
    ventureSlug,
  );
  const googleAnalyticsMeasurementId =
    parsed.writableRefs.googleAnalyticsMeasurementIdTemplate.replace("{ventureSlug}", ventureSlug);
  const writableCredentialRegistrations: FounderStackWritableCredentialRegistration[] = [
    {
      purpose: "neon_database_uri",
      ref: neonDatabaseUri,
      provider: "neon",
      kind: "connection_string",
      backend: writableBackendFor(parsed, "neonDatabaseUri"),
      label: `${ventureSlug} Neon database URI capture`,
      scopes: [],
    },
    {
      purpose: "stripe_webhook_signing",
      ref: stripeWebhookSigning,
      provider: "stripe",
      kind: "ci_secret",
      backend: writableBackendFor(parsed, "stripeWebhookSigning"),
      label: `${ventureSlug} Stripe webhook signing capture`,
      scopes: [],
    },
    {
      purpose: "google_analytics_measurement_id",
      ref: googleAnalyticsMeasurementId,
      provider: "google",
      kind: "ci_secret",
      backend: writableBackendFor(parsed, "googleAnalyticsMeasurementId"),
      label: `${ventureSlug} Google Analytics measurement ID capture`,
      scopes: [],
    },
  ];
  const overrideFor = (providerId: FounderStackProviderId): FounderProviderConfigOverride => {
    const role = roleForProvider.get(providerId)!;
    const externalResourceIds: Record<string, string> = {};
    if (role.organizationId) externalResourceIds.organization_id = role.organizationId;
    if (providerId === "stripe") externalResourceIds.mode = parsed.launchDefaults.stripe.mode;
    if (providerId === "brevo") {
      const defaults = parsed.launchDefaults.brevo;
      if (defaults.senderName) externalResourceIds.sender_name = defaults.senderName;
      if (defaults.senderEmail) externalResourceIds.sender_email = defaults.senderEmail;
      if (defaults.templateName) externalResourceIds.template_name = defaults.templateName;
      if (defaults.templateSubject) externalResourceIds.template_subject = defaults.templateSubject;
      if (defaults.templateHtml) externalResourceIds.template_html = defaults.templateHtml;
    }
    if (providerId === "google" && parsed.launchDefaults.google.analyticsAccountId) {
      externalResourceIds.analytics_account_id = parsed.launchDefaults.google.analyticsAccountId;
    }
    if (providerId === "bing" && parsed.launchDefaults.bing.authMode) {
      externalResourceIds.auth_mode = parsed.launchDefaults.bing.authMode;
    }
    if (providerId === "dns") {
      const defaults = parsed.launchDefaults.dns;
      externalResourceIds.provider_id = defaults.providerId;
      if (defaults.adapter) externalResourceIds.adapter = defaults.adapter;
      if (defaults.registrarAccountId) {
        externalResourceIds.registrar_account_id = defaults.registrarAccountId;
      }
      if (defaults.zoneId) externalResourceIds.zone_id = defaults.zoneId;
    }
    if (providerId === "neon") externalResourceIds.database_credential_ref = neonDatabaseUri;
    if (providerId === "stripe") {
      externalResourceIds.webhook_secret_credential_ref = stripeWebhookSigning;
    }
    if (providerId === "google") {
      externalResourceIds.measurement_id_credential_ref = googleAnalyticsMeasurementId;
    }
    if (domain && providerId === "vercel") externalResourceIds.domain = domain;
    if (domain && providerId === "google") {
      externalResourceIds.site_url = `sc-domain:${domain}`;
      externalResourceIds.sitemap_url = `https://${domain}/sitemap.xml`;
    }
    if (domain && providerId === "bing") externalResourceIds.site_url = `https://${domain}/`;
    if (domain && providerId === "dns") externalResourceIds.domain = domain;
    return {
      state: role.credentialRef ? "auth_required" : "unconfigured",
      credential_ref: role.credentialRef ?? null,
      account_id: role.accountId ?? null,
      team_id: role.teamId ?? null,
      region: providerId === "neon" ? parsed.launchDefaults.neon.region : null,
      required_scopes: [...role.scopes],
      last_verified_at: null,
      external_resource_ids: externalResourceIds,
      ...(providerId === "dns" ? { selected_transport: "manual" as const } : {}),
    };
  };
  const providers: Record<FounderStackProviderId, FounderProviderConfigOverride> = {
    github: overrideFor("github"),
    vercel: overrideFor("vercel"),
    neon: overrideFor("neon"),
    stripe: overrideFor("stripe"),
    revenuecat: overrideFor("revenuecat"),
    brevo: overrideFor("brevo"),
    google: overrideFor("google"),
    bing: overrideFor("bing"),
    dns: overrideFor("dns"),
  };
  return {
    profileId: parsed.profileId,
    ownerOrganizationId: parsed.ownerOrganizationId,
    ventureSlug,
    domain,
    writableCredentialRefs: {
      neonDatabaseUri,
      stripeWebhookSigning,
      googleAnalyticsMeasurementId,
    },
    writableCredentialRegistrations,
    providers,
  };
}

export async function registerFounderStackWritableCredentialRefs(
  connection: FounderStackConnection,
  input: { ventureSlug: string; domain?: string | null },
  broker: CredentialBroker,
): Promise<{
  rendered: RenderedFounderStackProviderOverrides;
  inspections: ReadonlyArray<
    FounderStackWritableCredentialRegistration & { status: string; writable: boolean }
  >;
}> {
  const rendered = renderFounderStackProviderConfigOverrides(connection, input);
  const inspections: Array<
    FounderStackWritableCredentialRegistration & { status: string; writable: boolean }
  > = [];
  for (const registration of rendered.writableCredentialRegistrations) {
    const existing = broker.getReference(registration.ref);
    if (
      existing &&
      (existing.provider !== registration.provider ||
        existing.kind !== registration.kind ||
        existing.backend !== registration.backend)
    ) {
      throw new Error(`Writable credential target metadata conflicts at ${registration.ref}`);
    }
    if (!existing) {
      broker.register({
        ref: registration.ref,
        provider: registration.provider,
        kind: registration.kind,
        backend: registration.backend,
        label: registration.label,
        scopes: registration.scopes,
      });
    }
    const inspection = await broker.inspect(registration.ref);
    const backendReady = inspection.writable && inspection.status !== "unavailable";
    if (!backendReady) {
      throw new Error(`Writable credential backend is unavailable for ${registration.purpose}`);
    }
    inspections.push({ ...registration, status: inspection.status, writable: inspection.writable });
  }
  return { rendered, inspections };
}
