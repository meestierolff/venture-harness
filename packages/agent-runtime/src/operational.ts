import { createHash, randomUUID } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GROWTH_CONTRACT_VERSION,
  defineRuntimeSchema,
  objectValue,
  parseGrowthContract,
  schemaObject,
  stringValue,
  type RuntimeSchema,
} from "@venture-harness/config";
import {
  defineCommandContract,
  type CommandBus,
  type CommandContract,
  type CommandHandlerContext,
} from "@venture-harness/command-bus";
import { stableJson, type JsonObject, type JsonValue } from "@venture-harness/core";
import { parse as parseYaml } from "yaml";
import {
  QUALITY_PROFILE_IDS,
  unconfiguredQualityProfileRunner,
  type QualityProfileId,
  type QualityProfileRunner,
} from "./quality.js";
import { platformOperationCommandContracts } from "./platform-operations.js";
import { runLearningCadence } from "./loop-operations.js";
import type { ProductionLoopRuntime } from "@venture-harness/loops";

export type OperationalMode = "read_only" | "local_write" | "dry_run" | "pending";

export type EmptyOperationalInput = JsonObject;
export type VentureIdentityInput = JsonObject & { ventureId: string };
export type RunIdentityInput = JsonObject & { runId: string };
export type IdeaCompileInput = JsonObject & {
  idea: string;
  ventureId: string;
  name: string;
};
export type VentureCreateInput = JsonObject & {
  ventureId: string;
  name: string;
};
export type VentureLaunchInput = JsonObject & {
  ventureId: string;
  runId: string;
  dryRun: boolean;
};
export type LearningRunInput = JsonObject & {
  cadence: "daily" | "weekly" | "biweekly" | "monthly";
};
export type GrowthInspectInput = JsonObject & { path: string };
export type VerifyRunInput = JsonObject & { profile: QualityProfileId };

export type OperationalCommandOutput = JsonObject & {
  commandId: string;
  mode: OperationalMode;
  status: string;
  data: JsonObject;
};

interface CompiledIdea extends JsonObject {
  ideaId: string;
  organizationId: string;
  ventureId: string;
  name: string;
  summary: string;
  sourceHash: string;
  compiledAt: string;
  assumptions: JsonValue[];
}

interface LocalVenture extends JsonObject {
  organizationId: string;
  ventureId: string;
  name: string;
  ideaId: string;
  status: "created" | "planned" | "dry_run_complete";
  createdAt: string;
  updatedAt: string;
}

interface LocalPlan extends JsonObject {
  planId: string;
  organizationId: string;
  ventureId: string;
  status: "planned";
  createdAt: string;
  externalEffects: 0;
  steps: JsonValue[];
}

interface LocalRun extends JsonObject {
  runId: string;
  organizationId: string;
  ventureId: string;
  planId: string;
  status: "dry_run_complete";
  mode: "dry_run";
  createdAt: string;
  updatedAt: string;
  externalEffects: 0;
  resumable: true;
}

export interface OperationalStateDocument {
  schemaVersion: 1;
  ideas: Record<string, CompiledIdea>;
  ventures: Record<string, LocalVenture>;
  plans: Record<string, LocalPlan>;
  runs: Record<string, LocalRun>;
}

export interface OperationalStateStore {
  read(): OperationalStateDocument;
  write(state: OperationalStateDocument): void;
  readonly description: string;
}

function emptyState(): OperationalStateDocument {
  return { schemaVersion: 1, ideas: {}, ventures: {}, plans: {}, runs: {} };
}

function cloneState(state: OperationalStateDocument): OperationalStateDocument {
  return structuredClone(state);
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseState(value: unknown): OperationalStateDocument {
  const document = assertRecord(value, "operational state");
  if (document.schemaVersion !== 1) throw new Error("unsupported operational state schema");
  return {
    schemaVersion: 1,
    ideas: assertRecord(document.ideas, "ideas") as Record<string, CompiledIdea>,
    ventures: assertRecord(document.ventures, "ventures") as Record<string, LocalVenture>,
    plans: assertRecord(document.plans, "plans") as Record<string, LocalPlan>,
    runs: assertRecord(document.runs, "runs") as Record<string, LocalRun>,
  };
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/i,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}/i,
  /"(?:password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/i,
];

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error("credential-like material is forbidden in operational command state");
  }
}

export class InMemoryOperationalStateStore implements OperationalStateStore {
  readonly description = "memory";
  #state = emptyState();

  read(): OperationalStateDocument {
    return cloneState(this.#state);
  }

  write(state: OperationalStateDocument): void {
    assertNoSecrets(state);
    this.#state = cloneState(state);
  }
}

export class FileOperationalStateStore implements OperationalStateStore {
  readonly rootDir: string;
  readonly path: string;

  constructor(rootDir = resolve(process.cwd(), ".venture-harness")) {
    this.rootDir = resolve(rootDir);
    this.path = join(this.rootDir, "operational-state.json");
  }

  get description(): string {
    return this.path;
  }

  read(): OperationalStateDocument {
    if (!existsSync(this.path)) return emptyState();
    return parseState(JSON.parse(readFileSync(this.path, "utf8")) as unknown);
  }

  write(state: OperationalStateDocument): void {
    assertNoSecrets(state);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(this.rootDir, `.operational-state-${randomUUID()}.tmp`);
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, this.path);
  }
}

function exactObject(
  value: unknown,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  return record;
}

function safeId(record: Record<string, unknown>, field: string): string {
  const value = stringValue(record, field)!;
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value)) {
    throw new Error(`${field} must contain 2-64 letters, digits, dots, underscores, or hyphens`);
  }
  return value;
}

const emptyInput = defineRuntimeSchema<EmptyOperationalInput>({
  name: "EmptyOperationalInput",
  jsonSchema: schemaObject({}, []),
  parse(value) {
    exactObject(value, "EmptyOperationalInput", []);
    return {};
  },
});

const ventureIdentityInput = defineRuntimeSchema<VentureIdentityInput>({
  name: "VentureIdentityInput",
  jsonSchema: schemaObject({ ventureId: { type: "string", minLength: 2, maxLength: 64 } }, [
    "ventureId",
  ]),
  parse(value) {
    const input = exactObject(value, "VentureIdentityInput", ["ventureId"]);
    return { ventureId: safeId(input, "ventureId") };
  },
});

const runIdentityInput = defineRuntimeSchema<RunIdentityInput>({
  name: "RunIdentityInput",
  jsonSchema: schemaObject({ runId: { type: "string", minLength: 2, maxLength: 64 } }, ["runId"]),
  parse(value) {
    const input = exactObject(value, "RunIdentityInput", ["runId"]);
    return { runId: safeId(input, "runId") };
  },
});

const ideaCompileInput = defineRuntimeSchema<IdeaCompileInput>({
  name: "IdeaCompileInput",
  jsonSchema: schemaObject(
    {
      idea: { type: "string", minLength: 3, maxLength: 10_000 },
      ventureId: { type: "string", minLength: 2, maxLength: 64 },
      name: { type: "string", minLength: 1, maxLength: 120 },
    },
    ["idea", "ventureId", "name"],
  ),
  parse(value) {
    const input = exactObject(value, "IdeaCompileInput", ["idea", "ventureId", "name"]);
    const parsed = {
      idea: stringValue(input, "idea")!.trim(),
      ventureId: safeId(input, "ventureId"),
      name: stringValue(input, "name")!.trim(),
    };
    if (parsed.idea.length > 10_000) throw new Error("idea must be at most 10000 characters");
    if (parsed.name.length > 120) throw new Error("name must be at most 120 characters");
    assertNoSecrets(parsed);
    return parsed;
  },
});

const ventureCreateInput = defineRuntimeSchema<VentureCreateInput>({
  name: "VentureCreateInput",
  jsonSchema: schemaObject(
    {
      ventureId: { type: "string", minLength: 2, maxLength: 64 },
      name: { type: "string", minLength: 1, maxLength: 120 },
    },
    ["ventureId", "name"],
  ),
  parse(value) {
    const input = exactObject(value, "VentureCreateInput", ["ventureId", "name"]);
    const name = stringValue(input, "name")!.trim();
    if (name.length > 120) throw new Error("name must be at most 120 characters");
    return { ventureId: safeId(input, "ventureId"), name };
  },
});

const ventureLaunchInput = defineRuntimeSchema<VentureLaunchInput>({
  name: "VentureLaunchInput",
  jsonSchema: schemaObject(
    {
      ventureId: { type: "string", minLength: 2, maxLength: 64 },
      runId: { type: "string", minLength: 2, maxLength: 64 },
      dryRun: { const: true },
    },
    ["ventureId", "runId", "dryRun"],
  ),
  parse(value) {
    const input = exactObject(value, "VentureLaunchInput", ["ventureId", "runId", "dryRun"]);
    if (input.dryRun !== true) {
      throw new Error(
        "the packaged local runtime permits dryRun=true only; no provider effect ran",
      );
    }
    return {
      ventureId: safeId(input, "ventureId"),
      runId: safeId(input, "runId"),
      dryRun: true,
    };
  },
});

const learningRunInput = defineRuntimeSchema<LearningRunInput>({
  name: "LearningRunInput",
  jsonSchema: schemaObject(
    { cadence: { type: "string", enum: ["daily", "weekly", "biweekly", "monthly"] } },
    ["cadence"],
  ),
  parse(value) {
    const input = exactObject(value, "LearningRunInput", ["cadence"]);
    return {
      cadence: stringValue(input, "cadence", {
        allowed: ["daily", "weekly", "biweekly", "monthly"],
      }) as LearningRunInput["cadence"],
    };
  },
});

const verifyRunInput = defineRuntimeSchema<VerifyRunInput>({
  name: "VerifyRunInput",
  jsonSchema: schemaObject({ profile: { type: "string", enum: [...QUALITY_PROFILE_IDS] } }, [
    "profile",
  ]),
  parse(value) {
    const input = exactObject(value, "VerifyRunInput", ["profile"]);
    return {
      profile: stringValue(input, "profile", {
        allowed: QUALITY_PROFILE_IDS,
      }) as QualityProfileId,
    };
  },
});

const growthInspectInput = defineRuntimeSchema<GrowthInspectInput>({
  name: "GrowthInspectInput",
  jsonSchema: schemaObject(
    { path: { type: "string", minLength: 1, maxLength: 4096, default: "config/growth.yaml" } },
    [],
  ),
  parse(value) {
    const input = exactObject(value, "GrowthInspectInput", ["path"]);
    const path = (stringValue(input, "path", { optional: true }) ?? "config/growth.yaml").trim();
    if (path.length > 4096) throw new Error("path must be at most 4096 characters");
    if (!/\.ya?ml$/i.test(path)) throw new Error("growth contract path must end in .yaml or .yml");
    assertNoSecrets({ path });
    return { path };
  },
});

function outputSchema(commandId: string): RuntimeSchema<OperationalCommandOutput> {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject(
      {
        commandId: { const: commandId },
        mode: { type: "string", enum: ["read_only", "local_write", "dry_run", "pending"] },
        status: { type: "string", minLength: 1 },
        data: { type: "object" },
      },
      ["commandId", "mode", "status", "data"],
    ),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "mode",
        "status",
        "data",
      ]);
      if (output.commandId !== commandId) throw new Error(`invalid ${commandId} output`);
      const mode = stringValue(output, "mode", {
        allowed: ["read_only", "local_write", "dry_run", "pending"],
      }) as OperationalMode;
      const data = objectValue(output.data, "data") as JsonObject;
      return {
        commandId,
        mode,
        status: stringValue(output, "status")!,
        data,
      };
    },
  });
}

function operationalCommand<Input extends JsonObject>(definition: {
  id: string;
  title: string;
  description: string;
  input: RuntimeSchema<Input>;
  effect?: "read" | "write";
}): CommandContract<Input, OperationalCommandOutput> {
  return defineCommandContract({
    ...definition,
    effect: definition.effect ?? "read",
    version: 1,
    output: outputSchema(definition.id),
    requirements: { activeSubscription: false, entitlements: [], grant: false, scopes: [] },
  });
}

export const systemDoctorCommand = operationalCommand({
  id: "system.doctor",
  title: "Inspect Packaged Runtime",
  description: "Inspect local packaged-runtime readiness without contacting a provider.",
  input: emptyInput,
});
export const organizationListCommand = operationalCommand({
  id: "org.list",
  title: "List Organizations",
  description: "List the current local organization boundary.",
  input: emptyInput,
});
export const stackListCommand = operationalCommand({
  id: "stack.list",
  title: "List Stack Profiles",
  description: "List bundled provider-neutral stack profiles and their effect posture.",
  input: emptyInput,
});
export const packListCommand = operationalCommand({
  id: "pack.list",
  title: "List Packs",
  description: "List bundled command and runtime packs without installing anything.",
  input: emptyInput,
});
export const seedListCommand = operationalCommand({
  id: "seed.list",
  title: "List Venture Seeds",
  description: "List known venture seed rails without claiming that templates were materialized.",
  input: emptyInput,
});
export const grantListCommand = operationalCommand({
  id: "grant.list",
  title: "List Grants",
  description: "List sanitized grants visible in the current invocation context.",
  input: emptyInput,
});
export const providerListCommand = operationalCommand({
  id: "provider.list",
  title: "List Providers",
  description:
    "List provider capabilities as unconfigured; no authentication or network probe occurs.",
  input: emptyInput,
});
export const verifyRunCommand = operationalCommand({
  id: "verify.run",
  title: "Run Repository Quality Profile",
  description:
    "Execute the selected fast, MVP, or release quality profile and preserve failures and incomplete checks.",
  input: verifyRunInput,
});
export const dataSyncCommand = operationalCommand({
  id: "data.sync",
  title: "Inspect Data Sync",
  description: "Return an explicit skipped result when no read-only connector is configured.",
  input: emptyInput,
});
export const learningRunCommand = operationalCommand({
  id: "learn.run",
  title: "Run Bounded Learning Cadence",
  description:
    "Fetch connected provider evidence and execute one bounded no-effect report or proposal cadence; return insufficient evidence when unconfigured.",
  input: learningRunInput,
});
export const growthInspectCommand = operationalCommand({
  id: "growth.inspect",
  title: "Inspect Growth Contract",
  description:
    "Validate and summarize a local Growth Contract without persisting it or contacting a provider.",
  input: growthInspectInput,
});
export const ideaCompileCommand = operationalCommand({
  id: "idea.compile",
  title: "Compile Venture Idea",
  description: "Compile and persist one local founder idea with explicit assumptions.",
  input: ideaCompileInput,
  effect: "write",
});
export const ventureCreateCommand = operationalCommand({
  id: "venture.create",
  title: "Create Local Venture",
  description: "Create a local venture from a previously compiled idea.",
  input: ventureCreateInput,
  effect: "write",
});
export const venturePlanCommand = operationalCommand({
  id: "venture.plan",
  title: "Plan Local Venture",
  description: "Persist a provider-neutral, no-effect local venture plan.",
  input: ventureIdentityInput,
  effect: "write",
});
export const ventureLaunchCommand = operationalCommand({
  id: "venture.launch",
  title: "Dry Launch Local Venture",
  description: "Persist a dry launch run; production/provider effects are not available.",
  input: ventureLaunchInput,
  effect: "write",
});
export const ventureStatusCommand = operationalCommand({
  id: "venture.status",
  title: "Inspect Venture Status",
  description: "Read one locally persisted venture and its latest plan/run status.",
  input: ventureIdentityInput,
});
export const ventureResumeCommand = operationalCommand({
  id: "venture.resume",
  title: "Resume Local Dry Run",
  description: "Reload a persisted dry run without repeating or introducing an effect.",
  input: runIdentityInput,
});
export const runListCommand = operationalCommand({
  id: "run.list",
  title: "List Local Runs",
  description: "List locally persisted dry runs.",
  input: emptyInput,
});
export const runStatusCommand = operationalCommand({
  id: "run.status",
  title: "Inspect Local Run",
  description: "Read one locally persisted dry run.",
  input: runIdentityInput,
});

export const operationalCommandContracts = [
  systemDoctorCommand,
  organizationListCommand,
  stackListCommand,
  packListCommand,
  seedListCommand,
  grantListCommand,
  providerListCommand,
  ...platformOperationCommandContracts,
  verifyRunCommand,
  dataSyncCommand,
  learningRunCommand,
  growthInspectCommand,
  ideaCompileCommand,
  ventureCreateCommand,
  venturePlanCommand,
  ventureLaunchCommand,
  ventureStatusCommand,
  ventureResumeCommand,
  runListCommand,
  runStatusCommand,
] as const;

function result(
  commandId: string,
  mode: OperationalMode,
  status: string,
  data: JsonObject,
): OperationalCommandOutput {
  return { commandId, mode, status, data };
}

function stateValues<T extends JsonObject>(records: Record<string, T>): T[] {
  return Object.values(records).sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right)),
  );
}

function latestForVenture<
  T extends {
    organizationId: string;
    ventureId: string;
    updatedAt?: string;
    createdAt: string;
  },
>(records: Record<string, T>, organizationId: string, ventureId: string): T | null {
  return (
    Object.values(records)
      .filter(
        (record) => record.organizationId === organizationId && record.ventureId === ventureId,
      )
      .sort((left, right) =>
        (left.updatedAt ?? left.createdAt).localeCompare(right.updatedAt ?? right.createdAt),
      )
      .at(-1) ?? null
  );
}

function recordKey(organizationId: string, id: string): string {
  return `${organizationId.length}:${organizationId}:${id}`;
}

const MAX_GROWTH_CONTRACT_BYTES = 1024 * 1024;

function growthContractVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).contract_version;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

function pathEscapesRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}

interface GrowthContractRoot {
  declaredPath: string;
  canonicalPath: string;
}

function assertGrowthPath(
  root: GrowthContractRoot,
  inputPath: string,
): { path: string; displayPath: string } {
  const candidate = resolve(root.declaredPath, inputPath);
  if (pathEscapesRoot(root.declaredPath, candidate)) {
    throw new Error("growth contract path must stay within the configured root");
  }

  const pathFromRoot = relative(root.declaredPath, candidate);
  let current = root.declaredPath;
  try {
    for (const component of pathFromRoot.split(sep).filter(Boolean)) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("growth contract path must not contain symbolic links");
      }
    }
    const details = lstatSync(candidate);
    if (!details.isFile()) throw new Error("growth contract path must reference a regular file");
    const canonical = realpathSync(candidate);
    if (pathEscapesRoot(root.canonicalPath, canonical)) {
      throw new Error("growth contract path must stay within the configured root");
    }
    return { path: canonical, displayPath: relative(root.canonicalPath, canonical) };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("symbolic links") || error.message.includes("regular file"))
    ) {
      throw error;
    }
    throw new Error("growth contract file could not be read");
  }
}

function inspectGrowthContract(
  input: GrowthInspectInput,
  growthContractRoot: GrowthContractRoot,
): OperationalCommandOutput {
  const source = assertGrowthPath(growthContractRoot, input.path);
  let text: string;
  let handle: number | undefined;
  try {
    handle = openSync(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = fstatSync(handle);
    if (!details.isFile()) throw new Error("growth contract path must reference a regular file");
    if (details.size > MAX_GROWTH_CONTRACT_BYTES) {
      throw new Error("growth contract exceeds the 1 MiB inspection limit");
    }
    text = readFileSync(handle, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("1 MiB inspection limit") || error.message.includes("regular file"))
    ) {
      throw error;
    }
    throw new Error("growth contract file could not be read");
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_GROWTH_CONTRACT_BYTES) {
    throw new Error("growth contract exceeds the 1 MiB inspection limit");
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    throw new Error("growth contract YAML is invalid");
  }
  const originalSchemaVersion = growthContractVersion(document);
  let contract: ReturnType<typeof parseGrowthContract>;
  try {
    contract = parseGrowthContract(document);
  } catch {
    throw new Error("growth contract failed schema validation");
  }

  return result("growth.inspect", "read_only", "valid", {
    source: {
      path: source.displayPath,
      format: "yaml",
      readOnly: true,
    },
    schemaVersion: contract.contract_version,
    originalSchemaVersion,
    migrationApplied:
      originalSchemaVersion === 1 && contract.contract_version === GROWTH_CONTRACT_VERSION,
    venture: {
      ventureId: contract.venture_id,
      currency: contract.economics.currency,
      primaryEvent: contract.goal.primary_event,
      currentOptimizationEvent: contract.goal.current_optimization_event,
    },
    budgets: {
      currency: contract.economics.currency,
      totalTestBudgetMinor: contract.paid.test_budget_minor,
      perCreativeCapMinor: contract.paid.per_creative_cap_minor,
    },
    organic: {
      allowedProviders: contract.organic.allowed_providers,
      allowedAccountCount: contract.organic.allowed_accounts.length,
      maxAccounts: contract.organic.max_accounts,
      maxPostsPerAccountPerDay: contract.organic.max_posts_per_account_per_day,
      duplicateContentPolicy: contract.organic.duplicate_content_policy,
      defaultReviewMode: contract.organic.default_review_mode,
      snapshotCadenceMinutes: contract.organic.snapshot_cadence_minutes,
      aiDisclosureRequired: contract.organic.ai_disclosure_required,
    },
    paid: {
      allowedNetworks: contract.paid.allowed_networks,
      allowedAccountCount: contract.paid.allowed_accounts.length,
      allowedObjectives: contract.paid.allowed_objectives,
      allowedEvents: contract.paid.allowed_events,
      dailyAccountCapMinor: contract.paid.daily_account_cap_minor,
      dailyVentureCapMinor: contract.paid.daily_venture_cap_minor,
      monthlyVentureCapMinor: contract.paid.monthly_venture_cap_minor,
      dailyCustomerCapMinor: contract.paid.daily_customer_cap_minor,
      monthlyCustomerCapMinor: contract.paid.monthly_customer_cap_minor,
      emergencyPlatformCapMinor: contract.paid.emergency_platform_cap_minor,
      approvalThresholdMinor: contract.paid.approval_threshold_minor,
      autoPauseAllowed: contract.paid.auto_pause_allowed,
      autoScaleAllowed: contract.paid.auto_scale_allowed,
      vboPolicy: contract.paid.vbo_policy,
      stopConditions: {
        maxSpendWithoutTrialMinor: contract.paid.stop_conditions.max_spend_without_trial_minor,
        maxSpendWithoutPurchaseMinor:
          contract.paid.stop_conditions.max_spend_without_purchase_minor,
        maxCacBreachCount: contract.paid.stop_conditions.max_cac_breach_count,
      },
    },
    compliance: {
      rightsRequired: contract.compliance.rights_required,
      aiDisclosureRequired: contract.compliance.ai_disclosure_required,
      prohibitedClaims: contract.compliance.prohibited_claims,
      allowedGeographies: contract.compliance.allowed_geographies,
      restrictedAudiences: contract.compliance.restricted_audiences,
      restrictedCategories: contract.compliance.restricted_categories,
      providerPolicyState: contract.compliance.provider_policy_state,
    },
    externalEffects: false,
  });
}

function requireVenture(
  state: OperationalStateDocument,
  organizationId: string,
  ventureId: string,
): LocalVenture {
  const venture = state.ventures[recordKey(organizationId, ventureId)];
  if (!venture) throw new Error(`venture "${ventureId}" is not locally created`);
  return venture;
}

function requireRun(
  state: OperationalStateDocument,
  organizationId: string,
  runId: string,
): LocalRun {
  const run = state.runs[recordKey(organizationId, runId)];
  if (!run) throw new Error(`run "${runId}" is not locally persisted`);
  return run;
}

function mutate<T>(
  store: OperationalStateStore,
  update: (state: OperationalStateDocument) => T,
): T {
  const state = store.read();
  const output = update(state);
  store.write(state);
  return output;
}

export interface OperationalRuntimeOptions {
  store?: OperationalStateStore;
  now?: () => Date;
  growthContractRoot?: string;
  stackCatalog?: readonly JsonObject[];
  qualityProfileRunner?: QualityProfileRunner;
  learningLoopRuntime?: ProductionLoopRuntime;
}

export function registerOperationalCommands(
  bus: CommandBus,
  options: OperationalRuntimeOptions = {},
): void {
  const store = options.store ?? new InMemoryOperationalStateStore();
  const timestamp = () => (options.now ?? (() => new Date()))().toISOString();
  const declaredGrowthContractRoot = resolve(options.growthContractRoot ?? process.cwd());
  const rootDetails = lstatSync(declaredGrowthContractRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error("growth contract root must be a regular directory, not a symbolic link");
  }
  const growthContractRoot: GrowthContractRoot = {
    declaredPath: declaredGrowthContractRoot,
    canonicalPath: realpathSync(declaredGrowthContractRoot),
  };

  bus.register(systemDoctorCommand, (_input, handler) => {
    const state = store.read();
    const organizationId = handler.context.tenant.organizationId;
    return result("system.doctor", "read_only", "ready_local", {
      runtime: "packaged",
      sourceFallback: false,
      stateStore: store.description,
      externalEffects: false,
      providersChecked: false,
      knownVentures: Object.values(state.ventures).filter(
        (venture) => venture.organizationId === organizationId,
      ).length,
      knownRuns: Object.values(state.runs).filter((run) => run.organizationId === organizationId)
        .length,
    });
  });
  bus.register(organizationListCommand, (_input, handler) =>
    result("org.list", "read_only", "available", {
      organizations: [{ organizationId: handler.context.tenant.organizationId, source: "context" }],
    }),
  );
  bus.register(stackListCommand, () =>
    result("stack.list", "read_only", "available", {
      stacks: (options.stackCatalog ?? [
        {
          profileId: "local-safe",
          profileVersion: "0.2.0",
          label: "Local safe",
          verification: "unconfigured",
          implementationConfigured: false,
          credentialState: "unconfigured",
          liveVerification: "pending",
          providerEffectsConfigured: false,
          bindings: {},
        },
      ]) as JsonValue,
    }),
  );
  bus.register(packListCommand, () =>
    result("pack.list", "read_only", "available", {
      packs: [
        { id: "venture-operations", version: "0.2.0", state: "bundled" },
        { id: "agent-surfaces", version: "0.2.0", state: "bundled" },
      ],
    }),
  );
  bus.register(seedListCommand, () =>
    result("seed.list", "read_only", "catalog_only", {
      seeds: [
        { id: "web", rail: "web", action: "inspect_only" },
        { id: "ios", rail: "ios", action: "inspect_only" },
        { id: "hybrid", rail: "hybrid", action: "inspect_only" },
      ],
      materialized: false,
    }),
  );
  bus.register(grantListCommand, (_input, handler) =>
    result("grant.list", "read_only", "available", {
      grants: handler.context.grants.map((grant) => ({
        grantId: grant.grantId,
        commandIds: [...grant.commandIds],
        scopes: [...grant.scopes],
        expiresAt: grant.expiresAt,
        state: grant.revokedAt ? "revoked" : "declared",
      })),
      productionEffectsAuthorized: false,
    }),
  );
  bus.register(providerListCommand, () =>
    result("provider.list", "read_only", "unconfigured", {
      providers: [
        "app_store_connect",
        "bing",
        "brevo",
        "eas",
        "github",
        "google",
        "neon",
        "revenuecat",
        "stripe",
        "vercel",
      ].map((provider) => ({ provider, state: "unconfigured", networkChecked: false })),
      externalEffects: false,
    }),
  );
  bus.register(verifyRunCommand, async (input) => {
    const state = store.read();
    parseState(state);
    const profile = await (options.qualityProfileRunner ?? unconfiguredQualityProfileRunner).run(
      input.profile,
    );
    return result("verify.run", "read_only", profile.status, {
      profile,
      releaseGate: input.profile === "release",
      stateSchemaVersion: state.schemaVersion,
      credentialMaterialPersisted: false,
    });
  });
  bus.register(dataSyncCommand, () =>
    result("data.sync", "read_only", "skipped", {
      reason: "no read-only connector is configured in the packaged local runtime",
      records: null,
      externalRequestMade: false,
    }),
  );
  bus.register(learningRunCommand, (input, handler) => {
    if (options.learningLoopRuntime) {
      return runLearningCadence(options.learningLoopRuntime, input, handler);
    }
    return result("learn.run", "pending", "insufficient_evidence", {
      cadence: input.cadence,
      actionsApplied: 0,
      externalEffects: false,
      providerRequestMade: false,
      reason: "no normalized provider evidence is configured",
      runtime: "unconfigured",
    });
  });
  bus.register(growthInspectCommand, (input) => inspectGrowthContract(input, growthContractRoot));
  bus.register(ideaCompileCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const compiled = mutate(store, (state) => {
      const sourceHash = `sha256:${createHash("sha256").update(input.idea).digest("hex")}`;
      const key = recordKey(organizationId, input.ventureId);
      const existing = state.ideas[key];
      if (existing) {
        if (existing.sourceHash !== sourceHash || existing.name !== input.name) {
          throw new Error(`venture "${input.ventureId}" is bound to a different compiled idea`);
        }
        return existing;
      }
      const record: CompiledIdea = {
        ideaId: `idea-${sourceHash.slice("sha256:".length, "sha256:".length + 12)}`,
        organizationId,
        ventureId: input.ventureId,
        name: input.name,
        summary: input.idea,
        sourceHash,
        compiledAt: timestamp(),
        assumptions: [
          "Provider credentials and production authorization are not inferred.",
          "The packaged runtime will plan and dry-run locally only.",
        ],
      };
      state.ideas[key] = record;
      return record;
    });
    return result("idea.compile", "local_write", "compiled", { idea: compiled });
  });
  bus.register(ventureCreateCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const venture = mutate(store, (state) => {
      const key = recordKey(organizationId, input.ventureId);
      const idea = state.ideas[key];
      if (!idea) throw new Error(`compile idea "${input.ventureId}" before creating the venture`);
      if (idea.name !== input.name) throw new Error("venture name differs from the compiled idea");
      const existing = state.ventures[key];
      if (existing) return existing;
      const createdAt = timestamp();
      const record: LocalVenture = {
        organizationId,
        ventureId: input.ventureId,
        name: input.name,
        ideaId: idea.ideaId,
        status: "created",
        createdAt,
        updatedAt: createdAt,
      };
      state.ventures[key] = record;
      return record;
    });
    return result("venture.create", "local_write", "created", { venture });
  });
  bus.register(venturePlanCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const plan = mutate(store, (state) => {
      const venture = requireVenture(state, organizationId, input.ventureId);
      const planId = `plan-${input.ventureId}`;
      const key = recordKey(organizationId, planId);
      const existing = state.plans[key];
      if (existing) return existing;
      const record: LocalPlan = {
        planId,
        organizationId,
        ventureId: input.ventureId,
        status: "planned",
        createdAt: timestamp(),
        externalEffects: 0,
        steps: [
          { id: "validate-input", effect: "none", state: "planned" },
          { id: "materialization-preview", effect: "local", state: "planned" },
          { id: "provider-readiness", effect: "read", state: "blocked_unconfigured" },
        ],
      };
      state.plans[key] = record;
      venture.status = "planned";
      venture.updatedAt = record.createdAt;
      return record;
    });
    return result("venture.plan", "local_write", "planned", { plan });
  });
  bus.register(ventureLaunchCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const run = mutate(store, (state) => {
      const venture = requireVenture(state, organizationId, input.ventureId);
      const plan = state.plans[recordKey(organizationId, `plan-${input.ventureId}`)];
      if (!plan) throw new Error(`plan venture "${input.ventureId}" before launching`);
      const key = recordKey(organizationId, input.runId);
      const existing = state.runs[key];
      if (existing) {
        if (existing.ventureId !== input.ventureId) {
          throw new Error(`run "${input.runId}" belongs to another venture`);
        }
        return existing;
      }
      const createdAt = timestamp();
      const record: LocalRun = {
        runId: input.runId,
        organizationId,
        ventureId: input.ventureId,
        planId: plan.planId,
        status: "dry_run_complete",
        mode: "dry_run",
        createdAt,
        updatedAt: createdAt,
        externalEffects: 0,
        resumable: true,
      };
      state.runs[key] = record;
      venture.status = "dry_run_complete";
      venture.updatedAt = createdAt;
      return record;
    });
    return result("venture.launch", "dry_run", "dry_run_complete", { run });
  });
  bus.register(ventureStatusCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const state = store.read();
    const venture = requireVenture(state, organizationId, input.ventureId);
    return result("venture.status", "read_only", venture.status, {
      venture,
      plan: latestForVenture(state.plans, organizationId, input.ventureId),
      run: latestForVenture(state.runs, organizationId, input.ventureId),
    });
  });
  bus.register(ventureResumeCommand, (input, handler) => {
    const state = store.read();
    const run = requireRun(state, handler.context.tenant.organizationId, input.runId);
    return result("venture.resume", "read_only", "no_pending_work", {
      run,
      repeatedEffects: 0,
      nextAction: "configure the full authorized runtime before any provider apply",
    });
  });
  bus.register(runListCommand, (_input, handler) => {
    const state = store.read();
    const runs = Object.fromEntries(
      Object.entries(state.runs).filter(
        ([, run]) => run.organizationId === handler.context.tenant.organizationId,
      ),
    );
    return result("run.list", "read_only", "available", { runs: stateValues(runs) });
  });
  bus.register(runStatusCommand, (input, handler) => {
    const state = store.read();
    return result("run.status", "read_only", "available", {
      run: requireRun(state, handler.context.tenant.organizationId, input.runId),
    });
  });
}

export function operationalInputFor(commandId: string): RuntimeSchema<JsonObject> | null {
  const contract = operationalCommandContracts.find((candidate) => candidate.id === commandId);
  return (contract?.input as RuntimeSchema<JsonObject> | undefined) ?? null;
}

export function summarizeOperationalContract(commandId: string): JsonObject {
  const contract = operationalCommandContracts.find((candidate) => candidate.id === commandId);
  if (!contract) throw new Error(`unknown operational command: ${commandId}`);
  return {
    id: contract.id,
    title: contract.title,
    description: contract.description,
    surfaces: contract.surfaces as unknown as JsonValue,
  };
}

export type OperationalHandlerContext = CommandHandlerContext;
