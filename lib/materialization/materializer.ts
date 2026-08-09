import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { createVentureHarnessLock } from "../config/harness-lock";
import { assertLaunchEffectAuthorized, assertLaunchGrantActive, parseLaunchGrant } from "./grant";
import { ProviderRegistryLaunchEffectExecutor } from "./provider-effects";
import { ventureSeed } from "./seeds";
import type {
  LaunchEffect,
  LaunchEffectEvidence,
  LaunchGrant,
  MaterializationFileSystem,
  MaterializedFile,
  VentureManifest,
  VentureMaterializationPlan,
} from "./types";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function safeRelativePath(path: string): string {
  if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) {
    throw new Error(`Unsafe materialization path: ${path}`);
  }
  return path;
}

function render(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unknown seed template value: ${key}`);
    return value;
  });
}

export class NodeMaterializationFileSystem implements MaterializationFileSystem {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #inside(path: string): string {
    const target = resolve(this.#root, safeRelativePath(path));
    const child = relative(this.#root, target);
    if (!child || child === ".." || child.startsWith(`..${sep}`)) {
      throw new Error(`Materialization path escapes workspace: ${path}`);
    }
    return target;
  }

  async prepareEmpty(): Promise<void> {
    try {
      const stat = await lstat(this.#root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Venture workspace must be a real directory");
      }
      if ((await readdir(this.#root)).length > 0) {
        throw new Error("Venture workspace must be empty");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(this.#root, { recursive: true });
    }
  }

  async writeExclusive(path: string, content: string): Promise<void> {
    const target = this.#inside(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  async removeCreated(path: string): Promise<void> {
    await unlink(this.#inside(path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export interface CompileVentureMaterializationInput {
  grant: LaunchGrant;
  at: Date;
  coreVersion: string;
  workflowRefSha: string;
  effects?: readonly LaunchEffect[];
}

function accountProviders(grant: LaunchGrant): Record<string, string> {
  return Object.fromEntries(
    [...new Set(grant.providerAccounts.map((account) => account.provider))]
      .sort()
      .map((provider) => [provider, "0.2.0"]),
  );
}

function materialized(
  path: string,
  ownership: MaterializedFile["ownership"],
  content: string,
): MaterializedFile {
  return Object.freeze({
    path: safeRelativePath(path),
    ownership,
    content,
    sha256: sha256(content),
  });
}

export function compileVentureMaterialization(
  input: CompileVentureMaterializationInput,
): VentureMaterializationPlan {
  const grant = parseLaunchGrant(input.grant);
  assertLaunchGrantActive(grant, input.at);
  if (!/^\d+\.\d+\.\d+$/.test(input.coreVersion)) throw new Error("Core version must be exact");
  if (!/^[a-f0-9]{40}$/.test(input.workflowRefSha)) {
    throw new Error("Reusable workflow reference must be an immutable 40-character SHA");
  }
  const seed = ventureSeed(grant.seed.id, grant.seed.version);
  if (!seed.coreCompatibility.startsWith(`^${input.coreVersion.split(".")[0]}.`)) {
    throw new Error(`${seed.id}@${seed.version} is incompatible with Core ${input.coreVersion}`);
  }
  const effects = Object.freeze([...(input.effects ?? grant.allowedExternalEffects)]);
  for (const effect of effects) assertLaunchEffectAuthorized(grant, effect, input.at);

  const manifest: VentureManifest = Object.freeze({
    schemaVersion: 1,
    ventureId: `venture_${sha256(`${grant.ownerOrganizationId}\u0000${grant.ventureSlug}`).slice(0, 20)}`,
    ventureName: grant.ventureName,
    ventureSlug: grant.ventureSlug,
    ownerOrganizationId: grant.ownerOrganizationId,
    repository: grant.repository,
    seed: grant.seed,
    stackProfile: grant.stackProfile,
    rail: seed.rail,
    coreVersion: input.coreVersion,
    ...(seed.serviceRuntime === "recursive"
      ? {
          serviceBlueprints: Object.freeze([`${grant.ventureSlug}.primary`]),
          agentSurface: Object.freeze({
            cli: grant.ventureSlug,
            mcpPrefix: grant.ventureSlug.replaceAll("-", "_"),
            sdkPackage: `@${grant.ventureSlug}/sdk`,
            restPrefix: "/v1",
          }),
        }
      : {}),
    connectorManifest: "config/connectors.json",
    companyResourcesOwnedBy: grant.ownerOrganizationId,
    advertisingSpendAuthorized: false,
  });
  const accentHue = String(Number.parseInt(sha256(grant.ventureSlug).slice(0, 4), 16) % 360);
  const secondaryHue = String((Number(accentHue) + 137) % 360);
  const motifStep = String(6 + (Number.parseInt(sha256(grant.ventureSlug).slice(4, 6), 16) % 7));
  const values = {
    ventureName: grant.ventureName,
    ventureSlug: grant.ventureSlug,
    seedId: seed.id,
    seedVersion: seed.version,
    rail: seed.rail,
    workflowRefSha: input.workflowRefSha,
    accentHue,
    secondaryHue,
    motifStep,
    repositoryVisibility: grant.repository.visibility,
  };
  const files: MaterializedFile[] = seed.files.map((file) =>
    materialized(file.path, file.ownership, render(file.content, values)),
  );
  files.push(
    materialized(
      "venture.manifest.json",
      "venture_owned",
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    materialized(
      "config/connectors.json",
      "venture_owned",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          ventureId: manifest.ventureId,
          providers: grant.providerAccounts.map(({ capability, provider, ownership }) => ({
            capability,
            provider,
            ownership,
            accountSelection: "runtime_connection_required",
          })),
        },
        null,
        2,
      )}\n`,
    ),
    materialized(
      "package.json",
      "merge_managed",
      `${JSON.stringify(
        {
          name: grant.ventureSlug,
          version: "0.1.0",
          private: true,
          type: "module",
          packageManager: "pnpm@9.15.9",
          engines: { node: ">=20.9.0" },
          scripts: seed.packageScripts,
          dependencies: seed.runtimePackages,
          ...(Object.keys(seed.developmentPackages).length > 0
            ? { devDependencies: seed.developmentPackages }
            : {}),
        },
        null,
        2,
      )}\n`,
    ),
    materialized(
      ".gitignore",
      "core_owned",
      "node_modules/\n.next/\ndist/\n.env*\n!.env.example\n.venture/private/\n",
    ),
    materialized(
      ".venture/launch-grant.receipt.json",
      "core_owned",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          grantId: grant.grantId,
          ideaDigest: grant.ideaDigest,
          allowedExternalEffects: grant.allowedExternalEffects,
          ...(grant.modelExecutionPolicy
            ? { modelExecutionPolicy: grant.modelExecutionPolicy }
            : {}),
          ...(grant.providerOperationBudget
            ? { providerOperationBudget: grant.providerOperationBudget }
            : {}),
          createdAt: grant.createdAt,
          expiresAt: grant.expiresAt,
          advertisingSpendAuthorized: false,
        },
        null,
        2,
      )}\n`,
    ),
  );
  files.sort((left, right) => left.path.localeCompare(right.path));
  const lock = createVentureHarnessLock({
    harness_version: input.coreVersion,
    core_version: input.coreVersion,
    config_contract_version: 2,
    source: { kind: "seed", ref: `${seed.id}@${seed.version}` },
    seed: { id: seed.id, version: seed.version },
    runtime_packages: seed.runtimePackages,
    provider_adapters: accountProviders(grant),
    generators: seed.generatorVersions,
    managed_files: files.map(({ path, ownership, sha256: hash }) => ({
      path,
      ownership,
      sha256: hash,
      ...(ownership === "merge_managed" ? { base_sha256: hash } : {}),
    })),
    applied_migrations: [],
    migration_state: [],
    update_channel: "stable",
    workflow_ref_sha: input.workflowRefSha,
    last_verified_upgrade: null,
    extensions: { venture_manifest: "venture.manifest.json" },
  });
  const lockContent = stringify(lock, { lineWidth: 100, sortMapEntries: false });
  files.push(materialized("harness.lock", "core_owned", lockContent));
  files.sort((left, right) => left.path.localeCompare(right.path));
  const planDigest = sha256(
    stable({
      grantId: grant.grantId,
      manifest,
      effects,
      files: files.map(({ path, ownership, sha256: hash }) => ({ path, ownership, sha256: hash })),
    }),
  );
  return Object.freeze({ grant, seed, manifest, files, lock, effects, planDigest });
}

export async function materializeVenture(
  plan: VentureMaterializationPlan,
  fileSystem: MaterializationFileSystem,
  at: Date = new Date(),
): Promise<{ status: "materialized"; files: readonly string[]; planDigest: string }> {
  assertLaunchGrantActive(plan.grant, at);
  await fileSystem.prepareEmpty();
  const created: string[] = [];
  try {
    for (const file of plan.files) {
      await fileSystem.writeExclusive(file.path, file.content);
      created.push(file.path);
    }
    return Object.freeze({
      status: "materialized",
      files: Object.freeze(created),
      planDigest: plan.planDigest,
    });
  } catch (error) {
    for (const path of [...created].reverse()) await fileSystem.removeCreated(path);
    throw error;
  }
}

export async function executeLaunchEffects(options: {
  plan: VentureMaterializationPlan;
  executor: ProviderRegistryLaunchEffectExecutor;
  at: Date;
  priorEvidence?: readonly LaunchEffectEvidence[];
  onEvidence?: (evidence: LaunchEffectEvidence) => void | Promise<void>;
}): Promise<readonly LaunchEffectEvidence[]> {
  assertLaunchGrantActive(options.plan.grant, options.at);
  if (!(options.executor instanceof ProviderRegistryLaunchEffectExecutor)) {
    throw new Error("Launch effects require the provider-registry executor");
  }
  options.executor.prepare(options.plan);
  const evidence: LaunchEffectEvidence[] = [];
  const seen = new Set<LaunchEffect>();
  for (const prior of options.priorEvidence ?? []) {
    if (!options.plan.effects.includes(prior.effect) || seen.has(prior.effect)) {
      throw new Error("Prior provider evidence is duplicated or outside the launch plan");
    }
    const verified = await options.executor.validateEvidence(options.plan, prior);
    evidence.push(verified);
    await options.onEvidence?.(verified);
    seen.add(prior.effect);
  }
  for (const effect of options.plan.effects) {
    assertLaunchEffectAuthorized(options.plan.grant, effect, options.at);
    const prior = evidence.find((item) => item.effect === effect);
    if (prior) continue;
    const result = await options.executor.apply({
      effect,
      grant: options.plan.grant,
      manifest: options.plan.manifest,
      idempotencyKey: `${options.plan.grant.grantId}:${effect}`,
    });
    if (result.effect !== effect)
      throw new Error(`Provider evidence effect mismatch for ${effect}`);
    await options.executor.validateEvidence(options.plan, result);
    const selectedAccount = options.plan.grant.providerAccounts.find(
      (account) =>
        account.provider === result.provider &&
        account.externalAccountId === result.externalAccountId,
    );
    if (!selectedAccount || selectedAccount.ownership !== result.ownership) {
      throw new Error(`${effect} evidence is outside the Launch Grant provider destinations`);
    }
    evidence.push(Object.freeze({ ...result }));
    await options.onEvidence?.(result);
  }
  return Object.freeze(evidence);
}
