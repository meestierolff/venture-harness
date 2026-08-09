import { parse, stringify } from "yaml";
import type { z } from "zod";
import {
  createHarnessLock,
  createManagedFileLockEntry,
  HARNESS_FRAMEWORK_CONFIG_PATH,
  harnessLockSchema,
  parseHarnessLock,
} from "../config/harness-lock";
import { createDefaultLaunchConfig, launchSchema } from "../config/launch-schema";
import { createDefaultLoopsConfig, loopsSchema } from "../config/loop-schema";
import { createDefaultMobileConfig, mobileSchema } from "../config/mobile-schema";
import { createDefaultPoliciesConfig, policiesSchema } from "../config/policy-schema";
import {
  createDefaultProvidersConfig,
  providersSchema,
  type ProvidersConfig,
} from "../config/provider-schema";
import { frameworkSchema } from "../config/schemas";
import { legacyVentureSchema, ventureV02Schema, type VentureV02 } from "../config/venture-schema";
import { applyMigrationPlan } from "./runner";
import { migrationReportSchema } from "./types";
import type {
  MigrationFileSystem,
  MigrationOptions,
  MigrationPlan,
  MigrationReport,
} from "./types";

export const V01_TO_V02_MIGRATION_ID = "001-v0-1-to-v0-2";
export const V01_VERSION = "0.1.0";
export const V02_VERSION = "0.2.0";

type Clock = NonNullable<MigrationOptions["clock"]>;

function yaml(value: unknown): string {
  return stringify(value, { lineWidth: 100, sortMapEntries: false });
}

function preparationFailure(
  message: string,
  code: string,
  nextAction: string,
  clock: Clock,
  warnings: string[] = [],
): MigrationReport {
  const started = clock().toISOString();
  return migrationReportSchema.parse({
    migration_id: V01_TO_V02_MIGRATION_ID,
    from_version: V01_VERSION,
    to_version: V02_VERSION,
    status: "failed",
    dry_run: false,
    started_at: started,
    completed_at: clock().toISOString(),
    changes: [],
    warnings,
    lock_updated: false,
    rolled_back: false,
    error: { code, message, next_action: nextAction },
    rollback_errors: [],
  });
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function valueOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function migrateVenture(legacyInput: unknown): VentureV02 {
  const legacy = legacyVentureSchema.parse(legacyInput);
  const old = legacy.venture as typeof legacy.venture & Record<string, unknown>;
  const validation = legacy.validation;
  const targetMarket = nullableString(old.target_market) ?? nullableString(old.market);
  const locale = nullableString(old.locale) ?? old.language;
  return ventureV02Schema.parse({
    ...legacy,
    venture: {
      ...old,
      name: old.name,
      legal_name: nullableString(old.legal_name),
      domain: old.domain,
      market: nullableString(old.market),
      target_market: targetMarket,
      language: old.language,
      locale,
      currency: old.currency.toUpperCase(),
      timezone: old.timezone,
      stage: old.stage,
      repository_visibility: valueOr(old.repository_visibility, ["private", "public"], "private"),
      production_status: valueOr(
        old.production_status,
        ["none", "preview_live", "validation_site_live", "product_live", "testflight_live"],
        "none",
      ),
      harness_version: V02_VERSION,
      app_kind: valueOr(
        old.app_kind,
        ["web", "mobile_ios", "mobile_cross_platform", "hybrid"],
        "web",
      ),
      launch_mode: valueOr(
        old.launch_mode,
        ["validate_first", "thin_mvp", "product_first", "concierge_first"],
        "validate_first",
      ),
      business_model: valueOr(
        old.business_model,
        ["unselected", "b2b", "b2c", "b2b2c", "marketplace", "internal", "nonprofit"],
        "unselected",
      ),
      monetization_model: valueOr(
        old.monetization_model,
        [
          "unselected",
          "none",
          "subscription",
          "one_time",
          "usage_based",
          "transaction_fee",
          "lead_generation",
          "services",
          "hybrid",
        ],
        "unselected",
      ),
      risk_profile: valueOr(
        old.risk_profile,
        ["unassessed", "low", "moderate", "high", "regulated"],
        "unassessed",
      ),
      privacy_profile: valueOr(
        old.privacy_profile,
        ["unassessed", "minimal", "standard", "sensitive", "special_category"],
        "unassessed",
      ),
      mobile_stack: valueOr(
        old.mobile_stack,
        ["none", "expo_react_native", "swiftui", "auto"],
        "none",
      ),
      outcomes: {
        primary: {
          statement: null,
          success_signal: validation.primary_conversion,
        },
        secondary: [],
      },
      capabilities: {
        active: [
          "public_website",
          "database",
          "ga4",
          "gsc",
          "bing_webmaster",
          "vercel_analytics",
          "web_seo_aeo_geo",
          "feedback_intake",
          "scheduled_learning_loops",
        ],
        open: [],
      },
      extensions:
        old.extensions && typeof old.extensions === "object" && !Array.isArray(old.extensions)
          ? old.extensions
          : {},
    },
    validation,
    infrastructure: legacy.infrastructure,
    extensions:
      legacy.extensions &&
      typeof legacy.extensions === "object" &&
      !Array.isArray(legacy.extensions)
        ? legacy.extensions
        : {},
  });
}

const BOOLEAN_PROVIDER_MAP = {
  domain_registered: "dns",
  vercel_project_created: "vercel",
  neon_database_created: "neon",
  ga4_property_created: "google",
  vercel_analytics_enabled: "vercel",
  google_search_console_verified: "google",
  bing_webmaster_verified: "bing",
} as const;

function migrateProviders(
  infrastructure: Record<string, boolean>,
  warnings: string[],
): ProvidersConfig {
  const config = createDefaultProvidersConfig();
  for (const [legacyKey, providerId] of Object.entries(BOOLEAN_PROVIDER_MAP)) {
    if (infrastructure[legacyKey] !== true) continue;
    const provider = config.providers[providerId];
    provider.state = "configured";
    provider.next_action = "Read provider state back and attach verification evidence.";
    warnings.push(
      `${legacyKey}=true mapped to ${providerId}: configured, not verified; v0.1 stored no evidence artifact.`,
    );
  }
  return providersSchema.parse(config);
}

async function preserveOrDefault<T>(
  fileSystem: MigrationFileSystem,
  path: string,
  schema: z.ZodType<T>,
  fallback: T,
  warnings: string[],
): Promise<string> {
  const existing = await fileSystem.readText(path);
  if (existing === null) return yaml(fallback);
  schema.parse(parse(existing));
  warnings.push(`${path} already existed and was valid; preserved without rewriting.`);
  return existing;
}

export async function planV01ToV02Migration(options: {
  fileSystem: MigrationFileSystem;
  clock: Clock;
}): Promise<MigrationPlan> {
  const { fileSystem, clock } = options;
  const [frameworkText, ventureText] = await Promise.all([
    fileSystem.readText(HARNESS_FRAMEWORK_CONFIG_PATH),
    fileSystem.readText("config/venture.yaml"),
  ]);
  if (frameworkText === null || ventureText === null) {
    throw new Error("config/framework.yaml and config/venture.yaml are required");
  }
  return buildPlan(fileSystem, frameworkText, ventureText, clock);
}

async function buildPlan(
  fileSystem: MigrationFileSystem,
  frameworkText: string,
  ventureText: string,
  clock: Clock,
): Promise<MigrationPlan> {
  const warnings = [
    "Launch mode defaults to validate_first with zero confidence until the launch router evaluates the brief.",
    "Legacy infrastructure booleans remain in config/venture.yaml as a deprecated compatibility view.",
  ];
  const framework = parse(frameworkText) as Record<string, unknown> & {
    framework?: Record<string, unknown>;
  };
  if (!framework.framework) throw new Error("config/framework.yaml is missing framework");
  framework.framework.version = V02_VERSION;
  const migratedFramework = frameworkSchema.parse(framework);
  const migratedFrameworkContent = yaml(migratedFramework);
  const migratedVenture = migrateVenture(parse(ventureText));

  const launch = createDefaultLaunchConfig();
  launch.launch.progressive_commitment.specific_user_or_audience =
    migratedVenture.venture.target_market;
  launch.launch.progressive_commitment.primary_success_signal =
    migratedVenture.venture.outcomes.primary.success_signal;

  const mobile = createDefaultMobileConfig();
  mobile.mobile.app_store_connect.primary_language = migratedVenture.venture.locale;

  const providersPath = "config/providers.yaml";
  const existingProviders = await fileSystem.readText(providersPath);
  const providers =
    existingProviders === null
      ? yaml(migrateProviders(migratedVenture.infrastructure, warnings))
      : await preserveOrDefault(
          fileSystem,
          providersPath,
          providersSchema,
          createDefaultProvidersConfig(),
          warnings,
        );

  const appliedAt = clock().toISOString();
  const lock = createHarnessLock({
    source: { kind: "release", ref: "v0.2.0" },
    managed_files: [
      createManagedFileLockEntry({
        path: HARNESS_FRAMEWORK_CONFIG_PATH,
        ownership: "harness",
        content: migratedFrameworkContent,
      }),
    ],
    applied_migrations: [
      {
        id: V01_TO_V02_MIGRATION_ID,
        from_version: V01_VERSION,
        to_version: V02_VERSION,
        applied_at: appliedAt,
      },
    ],
  });

  return {
    id: V01_TO_V02_MIGRATION_ID,
    fromVersion: V01_VERSION,
    toVersion: V02_VERSION,
    warnings,
    changes: [
      { path: HARNESS_FRAMEWORK_CONFIG_PATH, content: migratedFrameworkContent },
      { path: "config/venture.yaml", content: yaml(migratedVenture) },
      {
        path: "config/launch.yaml",
        content: await preserveOrDefault(
          fileSystem,
          "config/launch.yaml",
          launchSchema,
          launch,
          warnings,
        ),
      },
      { path: providersPath, content: providers },
      {
        path: "config/policies.yaml",
        content: await preserveOrDefault(
          fileSystem,
          "config/policies.yaml",
          policiesSchema,
          createDefaultPoliciesConfig(),
          warnings,
        ),
      },
      {
        path: "config/loops.yaml",
        content: await preserveOrDefault(
          fileSystem,
          "config/loops.yaml",
          loopsSchema,
          createDefaultLoopsConfig(),
          warnings,
        ),
      },
      {
        path: "config/mobile.yaml",
        content: await preserveOrDefault(
          fileSystem,
          "config/mobile.yaml",
          mobileSchema,
          mobile,
          warnings,
        ),
      },
      { path: "harness.lock", content: yaml(lock) },
    ],
  };
}

export async function migrateV01ToV02(options: MigrationOptions): Promise<MigrationReport> {
  const clock = options.clock ?? (() => new Date());
  let lockText: string | null;
  try {
    lockText = await options.fileSystem.readText("harness.lock");
  } catch (error) {
    return preparationFailure(
      error instanceof Error ? error.message : "could not read harness.lock",
      "lock_read_failed",
      "Restore a readable harness.lock or remove the corrupt file, then rerun.",
      clock,
    );
  }

  if (lockText !== null) {
    try {
      const lock = parseHarnessLock(lockText);
      if (lock.harness_version === V02_VERSION) {
        return applyMigrationPlan(
          {
            id: V01_TO_V02_MIGRATION_ID,
            fromVersion: V01_VERSION,
            toVersion: V02_VERSION,
            warnings: [],
            changes: [{ path: "harness.lock", content: lockText }],
          },
          options,
        );
      }
      if (lock.harness_version !== V01_VERSION) {
        return preparationFailure(
          `unsupported harness version ${lock.harness_version}`,
          "unsupported_source_version",
          "Run the migration chain for the locked source version instead.",
          clock,
        );
      }
    } catch (error) {
      return preparationFailure(
        error instanceof Error ? error.message : "invalid harness.lock",
        "invalid_harness_lock",
        "Repair harness.lock from version control before migrating; no files were changed.",
        clock,
      );
    }
  }

  try {
    const plan = await planV01ToV02Migration({ fileSystem: options.fileSystem, clock });
    return applyMigrationPlan(plan, options);
  } catch (error) {
    return preparationFailure(
      error instanceof Error ? error.message : "could not prepare migration",
      "migration_preparation_failed",
      "Fix the reported legacy or v0.2 config validation error and rerun; no files were changed.",
      clock,
    );
  }
}

export function validateHarnessLock(value: unknown) {
  return harnessLockSchema.parse(value);
}
