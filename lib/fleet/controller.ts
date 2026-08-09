import { createHash, randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { harnessLockSchema, parseHarnessLock, type HarnessLock } from "../config/harness-lock";
import { applyUpgrade } from "../upgrade";
import { fleetTargetIdentity, fleetTargetKey } from "./identity";
import { asHarnessRelease } from "./release";
import type {
  CoreReleaseManifest,
  FleetCheckpointPhase,
  FleetHookPhase,
  FleetPhaseCheckpoint,
  FleetRunRecord,
  FleetStateStore,
  FleetVenture,
  FleetVentureCheckpoint,
  FleetVentureResult,
} from "./types";

const VERIFIED_STATUSES = new Set(["verified", "already_current"]);

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function affected(venture: FleetVenture, release: CoreReleaseManifest): boolean {
  if (
    venture.currentLock.lock_version === 2 &&
    !release.compatibility.seedIds.includes(venture.currentLock.seed.id)
  ) {
    return false;
  }
  const capabilities = new Set(venture.capabilities);
  if (release.affectedCapabilities.some((capability) => capabilities.has(capability))) return true;
  const packages =
    venture.currentLock.lock_version === 2 ? venture.currentLock.runtime_packages : {};
  return Object.keys(release.changedPackages).some((name) => name in packages);
}

function branchName(version: string): string {
  return `vh/core-${version.replaceAll(".", "-")}`;
}

function targetBinding(venture: FleetVenture) {
  return {
    identity: fleetTargetIdentity(venture),
    repository: venture.repository,
    designFingerprint: venture.designFingerprint,
    serviceBlueprintFingerprint: venture.serviceBlueprintFingerprint,
    initialLockDigest: sha256(venture.currentLock),
  };
}

function assertTargetBinding(venture: FleetVenture, checkpoint: FleetVentureCheckpoint): void {
  if (!checkpoint.target) {
    throw new Error(
      `fleet venture checkpoint for ${fleetTargetKey(venture)} predates target binding and cannot resume`,
    );
  }
  const currentLockDigest = sha256(venture.currentLock);
  const allowedLockDigests = new Set([
    checkpoint.target.initialLockDigest,
    ...(checkpoint.candidateLock ? [sha256(checkpoint.candidateLock)] : []),
  ]);
  if (
    checkpoint.organizationId !== venture.organizationId ||
    checkpoint.ventureId !== venture.ventureId ||
    fleetTargetKey(checkpoint.target.identity) !== fleetTargetKey(venture) ||
    checkpoint.target.repository !== venture.repository ||
    checkpoint.target.designFingerprint !== venture.designFingerprint ||
    checkpoint.target.serviceBlueprintFingerprint !== venture.serviceBlueprintFingerprint ||
    !allowedLockDigests.has(currentLockDigest)
  ) {
    throw new Error(
      `fleet venture checkpoint target changed for ${fleetTargetKey(venture)}; tenant, repository, fingerprints, and lock must match`,
    );
  }
}

async function snapshot(
  venture: FleetVenture,
  release: CoreReleaseManifest,
): Promise<readonly { path: string; content: string | null }[]> {
  const paths = new Set([
    "harness.lock",
    ...release.files.map((file) => file.path),
    ...venture.currentLock.managed_files.map((file) => file.path),
  ]);
  const contents: { path: string; content: string | null }[] = [];
  for (const path of [...paths].sort()) {
    contents.push({ path, content: await venture.fileSystem.readText(path) });
  }
  return contents;
}

async function restore(
  venture: FleetVenture,
  contents: readonly { path: string; content: string | null }[],
): Promise<void> {
  for (const { path, content } of contents) {
    if (content === null) await venture.fileSystem.remove(path);
    else await venture.fileSystem.writeAtomic(path, content);
  }
}

class KnownFleetFailure extends Error {}

interface UpgradePersistence {
  runId: string;
  load(): FleetVentureCheckpoint | null;
  save(checkpoint: FleetVentureCheckpoint): void;
  afterHook?(input: {
    organizationId: string;
    ventureId: string;
    phase: FleetHookPhase;
    idempotencyKey: string;
  }): void | Promise<void>;
  now(): Date;
}

function phaseKey(input: {
  runId: string;
  releaseDigest: string;
  organizationId: string;
  ventureId: string;
  phase: FleetCheckpointPhase;
}): string {
  return `fleet:${sha256(input)}`;
}

function withPhase(
  checkpoint: FleetVentureCheckpoint,
  phase: FleetCheckpointPhase,
  value: FleetPhaseCheckpoint,
): FleetVentureCheckpoint {
  return {
    ...checkpoint,
    phases: { ...checkpoint.phases, [phase]: value },
  };
}

async function upgradeOne(
  venture: FleetVenture,
  release: CoreReleaseManifest,
  persistence: UpgradePersistence,
): Promise<FleetVentureResult> {
  let checkpoint = persistence.load();
  const priorVersion = checkpoint?.priorVersion ?? venture.currentLock.harness_version;
  const branch = checkpoint?.branch ?? branchName(release.version);
  if (!checkpoint && priorVersion === release.version) {
    return {
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      status: "already_current",
      phase: "complete",
      branch: null,
      priorVersion,
      targetVersion: release.version,
      evidence: [],
      error: null,
    };
  }
  if (release.rollback.mode === "previous_release" && release.rollback.version !== priorVersion) {
    throw new Error(
      `fleet rollback version ${release.rollback.version ?? "missing"} does not match prior venture version ${priorVersion}`,
    );
  }
  if (!checkpoint) {
    checkpoint = {
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      target: targetBinding(venture),
      priorVersion,
      targetVersion: release.version,
      branch,
      originals: await snapshot(venture, release),
      candidateLock: null,
      productionTouched: false,
      phases: {},
    };
    persistence.save(checkpoint);
  }
  if (
    checkpoint.organizationId !== venture.organizationId ||
    checkpoint.ventureId !== venture.ventureId ||
    checkpoint.targetVersion !== release.version ||
    checkpoint.branch !== branch
  ) {
    throw new Error("fleet venture checkpoint is not bound to this release");
  }
  assertTargetBinding(venture, checkpoint);

  const save = (next: FleetVentureCheckpoint) => {
    checkpoint = next;
    persistence.save(next);
  };
  const completeLocal = (
    phase: Extract<
      FleetCheckpointPhase,
      "upgrade" | "lock" | "production_readback" | "compensation_readback"
    >,
    passed: boolean,
    evidence: readonly string[],
  ) => {
    const idempotencyKey = phaseKey({
      runId: persistence.runId,
      releaseDigest: release.digest,
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      phase,
    });
    save(
      withPhase(checkpoint!, phase, {
        phase,
        state: "completed",
        idempotencyKey,
        passed,
        evidence,
        updatedAt: persistence.now().toISOString(),
      }),
    );
  };
  const runHook = async (
    phase: FleetHookPhase,
    invoke: (idempotencyKey: string) => Promise<{ passed: boolean; evidence: readonly string[] }>,
  ): Promise<{ passed: boolean; evidence: readonly string[] }> => {
    const idempotencyKey = phaseKey({
      runId: persistence.runId,
      releaseDigest: release.digest,
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      phase,
    });
    const prior = checkpoint!.phases[phase];
    if (prior?.idempotencyKey && prior.idempotencyKey !== idempotencyKey) {
      throw new Error(`fleet ${phase} checkpoint has a mismatched idempotency key`);
    }
    if (prior?.state === "completed") {
      return { passed: prior.passed === true, evidence: prior.evidence };
    }
    if (prior?.state === "prepared") {
      const reconciliation = await venture.hooks.reconcilePhase({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        release,
        phase,
        idempotencyKey,
      });
      if (reconciliation.state === "unknown") {
        throw new Error(
          `fleet ${phase} outcome is unknown; read-back must resolve it before retry`,
        );
      }
      if (reconciliation.state === "completed") {
        const completed: FleetPhaseCheckpoint = {
          phase,
          state: "completed",
          idempotencyKey,
          passed: reconciliation.passed,
          evidence: [...reconciliation.evidence],
          updatedAt: persistence.now().toISOString(),
        };
        save(withPhase(checkpoint!, phase, completed));
        return { passed: completed.passed === true, evidence: completed.evidence };
      }
    }
    save(
      withPhase(checkpoint!, phase, {
        phase,
        state: "prepared",
        idempotencyKey,
        passed: null,
        evidence: [],
        updatedAt: persistence.now().toISOString(),
      }),
    );
    const result = await invoke(idempotencyKey);
    await persistence.afterHook?.({
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      phase,
      idempotencyKey,
    });
    save(
      withPhase(checkpoint!, phase, {
        phase,
        state: "completed",
        idempotencyKey,
        passed: result.passed,
        evidence: [...result.evidence],
        updatedAt: persistence.now().toISOString(),
      }),
    );
    return result;
  };
  const evidence = () =>
    (
      [
        "branch",
        "migrations",
        "checks",
        "preview",
        "merge",
        "production",
        "smoke",
        "production_readback",
        "compensate",
        "compensation_readback",
      ] as const
    ).flatMap((phase) => checkpoint!.phases[phase]?.evidence ?? []);

  let candidateLock: HarnessLock = checkpoint.candidateLock ?? venture.currentLock;
  try {
    const branchResult = await runHook("branch", async (idempotencyKey) => {
      const result = await venture.hooks.openUpgradeBranch({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        branch,
        release,
        idempotencyKey,
      });
      return { passed: result.passed, evidence: [result.reference] };
    });
    if (!branchResult.passed) throw new KnownFleetFailure("upgrade branch creation failed");

    const upgradeCheckpoint = checkpoint.phases.upgrade;
    if (upgradeCheckpoint?.state !== "completed") {
      if (upgradeCheckpoint?.state === "prepared") await restore(venture, checkpoint.originals);
      const idempotencyKey = phaseKey({
        runId: persistence.runId,
        releaseDigest: release.digest,
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        phase: "upgrade",
      });
      save(
        withPhase(checkpoint, "upgrade", {
          phase: "upgrade",
          state: "prepared",
          idempotencyKey,
          passed: null,
          evidence: [],
          updatedAt: persistence.now().toISOString(),
        }),
      );
      const report = await applyUpgrade({
        fileSystem: venture.fileSystem,
        currentLock: venture.currentLock,
        release: asHarnessRelease(release),
      });
      if (report.status !== "applied" && report.status !== "already_current") {
        throw new KnownFleetFailure(report.error?.message ?? `upgrade ${report.status}`);
      }
      const candidateText = await venture.fileSystem.readText("harness.lock");
      if (candidateText === null) throw new KnownFleetFailure("upgrade did not write harness.lock");
      candidateLock = parseHarnessLock(candidateText);
      save({ ...checkpoint, candidateLock });
      completeLocal("upgrade", true, []);
    } else {
      if (!checkpoint.candidateLock) throw new Error("completed upgrade has no candidate lock");
      candidateLock = checkpoint.candidateLock;
    }

    const migrations = await runHook("migrations", async (idempotencyKey) =>
      venture.hooks.runMigrations({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        migrations: release.migrations,
        idempotencyKey,
      }),
    );
    if (!migrations.passed) throw new KnownFleetFailure("venture migrations failed");
    const checks = await runHook("checks", async (idempotencyKey) =>
      venture.hooks.runChecks({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        checks: release.requiredChecks,
        idempotencyKey,
      }),
    );
    if (!checks.passed) throw new KnownFleetFailure("venture-specific checks failed");
    const preview = await runHook("preview", async (idempotencyKey) => {
      const result = await venture.hooks.deployPreview({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        branch,
        idempotencyKey,
      });
      return { passed: result.passed, evidence: [result.reference] };
    });
    if (!preview.passed) throw new KnownFleetFailure("preview verification failed");
    if (!venture.policy.automaticMerge || release.rolloutRisk !== "low") {
      await restore(venture, checkpoint.originals);
      return {
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        status: "waiting_for_merge_approval",
        phase: "merge",
        branch,
        priorVersion,
        targetVersion: release.version,
        evidence: evidence(),
        error: null,
      };
    }
    const merged = await runHook("merge", async (idempotencyKey) => {
      const result = await venture.hooks.merge({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        branch,
        idempotencyKey,
      });
      return { passed: result.passed, evidence: [result.reference] };
    });
    if (!merged.passed) throw new KnownFleetFailure("policy-approved merge failed");
    if (venture.policy.productionDeployment) {
      if (!checkpoint.productionTouched) save({ ...checkpoint, productionTouched: true });
      const deployed = await runHook("production", async (idempotencyKey) => {
        const result = await venture.hooks.deployProduction({
          organizationId: venture.organizationId,
          ventureId: venture.ventureId,
          release: release.version,
          idempotencyKey,
        });
        return { passed: result.passed, evidence: [result.reference] };
      });
      if (!deployed.passed) throw new KnownFleetFailure("production deployment failed");
      const smoke = await runHook("smoke", async (idempotencyKey) => {
        const result = await venture.hooks.smokeProduction({
          organizationId: venture.organizationId,
          ventureId: venture.ventureId,
          release: release.version,
          idempotencyKey,
        });
        return { passed: result.passed, evidence: [result.reference] };
      });
      if (!smoke.passed) throw new KnownFleetFailure("production smoke verification failed");
      let health: { healthy: boolean; version: string };
      try {
        health = await venture.deployedHealth({
          organizationId: venture.organizationId,
          ventureId: venture.ventureId,
          phase: "production",
          expectedVersion: release.version,
        });
      } catch {
        completeLocal("production_readback", false, ["production-health:read-back-failed"]);
        throw new KnownFleetFailure("production health/version read-back failed");
      }
      const productionVerified = health.healthy && health.version === release.version;
      completeLocal("production_readback", productionVerified, [
        productionVerified ? "production-health:matched" : "production-health:mismatch",
      ]);
      if (!productionVerified) {
        throw new KnownFleetFailure(
          "production health/version read-back did not match the release",
        );
      }
    }
    const verifiedAt = persistence.now();
    const verifiedLock = harnessLockSchema.parse(
      candidateLock.lock_version === 2
        ? {
            ...candidateLock,
            runtime_packages: Object.fromEntries(
              Object.entries(candidateLock.runtime_packages).map(([name, version]) => [
                name,
                release.changedPackages[name]?.to ?? version,
              ]),
            ),
            migration_state: [
              ...new Set([...candidateLock.migration_state, ...release.migrations]),
            ],
            applied_migrations: [
              ...candidateLock.applied_migrations,
              ...release.migrations
                .filter(
                  (migration) =>
                    !candidateLock.applied_migrations.some((item) => item.id === migration),
                )
                .map((migration) => ({
                  id: migration,
                  from_version: priorVersion,
                  to_version: release.version,
                  applied_at: verifiedAt.toISOString(),
                })),
            ],
            last_verified_upgrade: verifiedAt.toISOString(),
          }
        : candidateLock,
    );
    if (checkpoint.phases.lock?.state !== "completed") {
      const idempotencyKey = phaseKey({
        runId: persistence.runId,
        releaseDigest: release.digest,
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        phase: "lock",
      });
      save(
        withPhase(checkpoint, "lock", {
          phase: "lock",
          state: "prepared",
          idempotencyKey,
          passed: null,
          evidence: [],
          updatedAt: persistence.now().toISOString(),
        }),
      );
      await venture.fileSystem.writeAtomic(
        "harness.lock",
        stringify(verifiedLock, { lineWidth: 100, sortMapEntries: false }),
      );
      save({ ...checkpoint, candidateLock: verifiedLock });
      completeLocal("lock", true, []);
    }
    venture.currentLock = verifiedLock;
    return {
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      status: "verified",
      phase: "complete",
      branch,
      priorVersion,
      targetVersion: release.version,
      evidence: evidence(),
      error: null,
    };
  } catch (error) {
    if (!(error instanceof KnownFleetFailure)) throw error;
    const message = error.message;
    if (!checkpoint.productionTouched) {
      await restore(venture, checkpoint.originals);
      return {
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        status: "rolled_back",
        phase: "pre-production",
        branch,
        priorVersion,
        targetVersion: release.version,
        evidence: evidence(),
        error: message,
      };
    }
    const compensation = await runHook("compensate", async (idempotencyKey) => {
      const result = await venture.hooks.compensate({
        organizationId: venture.organizationId,
        ventureId: venture.ventureId,
        failedRelease: release.version,
        rollbackVersion: release.rollback.version,
        reason: message,
        mode: release.rollback.mode,
        idempotencyKey,
      });
      return { passed: result.passed, evidence: [result.reference] };
    });
    let rollbackVerified = false;
    if (release.rollback.mode === "previous_release" && compensation.passed) {
      const rollbackVersion = release.rollback.version!;
      try {
        const health = await venture.deployedHealth({
          organizationId: venture.organizationId,
          ventureId: venture.ventureId,
          phase: "compensation",
          expectedVersion: rollbackVersion,
        });
        rollbackVerified = health.healthy && health.version === rollbackVersion;
      } catch {
        rollbackVerified = false;
      }
      completeLocal("compensation_readback", rollbackVerified, [
        rollbackVerified ? "compensation-health:matched" : "compensation-health:mismatch",
      ]);
    }
    if (release.rollback.mode === "previous_release" && compensation.passed && rollbackVerified) {
      await restore(venture, checkpoint.originals);
    } else {
      venture.currentLock = candidateLock;
    }
    return {
      organizationId: venture.organizationId,
      ventureId: venture.ventureId,
      status:
        release.rollback.mode === "previous_release" && compensation.passed && rollbackVerified
          ? "rolled_back"
          : "forward_fix_required",
      phase: "production",
      branch,
      priorVersion,
      targetVersion: release.version,
      evidence: evidence(),
      error:
        release.rollback.mode === "previous_release" && compensation.passed && !rollbackVerified
          ? `${message}; compensation health/version read-back did not match the prior release`
          : message,
    };
  }
}

function selectedFleet(input: {
  ventures: readonly FleetVenture[];
  release: CoreReleaseManifest;
  batchSize: number;
  checkpoints?: FleetRunRecord["checkpoints"];
}) {
  const ordered = [...input.ventures].sort((left, right) =>
    fleetTargetKey(left).localeCompare(fleetTargetKey(right)),
  );
  const targetKeys = ordered.map(fleetTargetKey);
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new Error("fleet venture targets must be unique by organization and venture");
  }
  const selected = ordered.filter((venture) => affected(venture, input.release));
  const unaffected = ordered.filter((venture) => !selected.includes(venture));
  const canary = selected.find((venture) => venture.canary) ?? selected[0] ?? null;
  const remainder = selected.filter((venture) => venture !== canary);
  const batches: Array<Array<{ organizationId: string; ventureId: string }>> = [];
  for (let index = 0; index < remainder.length; index += input.batchSize) {
    batches.push(remainder.slice(index, index + input.batchSize).map(fleetTargetIdentity));
  }
  const selectionDigest = sha256({
    ordered: ordered.map((venture) => {
      const checkpoint = input.checkpoints?.[fleetTargetKey(venture)];
      return {
        identity: fleetTargetIdentity(venture),
        repository: venture.repository,
        designFingerprint: venture.designFingerprint,
        serviceBlueprintFingerprint: venture.serviceBlueprintFingerprint,
        initialLockDigest: checkpoint?.target?.initialLockDigest ?? sha256(venture.currentLock),
      };
    }),
    selected: selected.map(fleetTargetIdentity),
    canary: canary ? fleetTargetIdentity(canary) : null,
    batches,
    batchSize: input.batchSize,
  });
  return { ordered, selected, unaffected, canary, batches, selectionDigest };
}

function assertRunTenantBindings(record: FleetRunRecord): void {
  try {
    if (record.canaryTarget) fleetTargetKey(record.canaryTarget);
    for (const batch of record.batches) {
      for (const target of batch) fleetTargetKey(target);
    }
    const resultKeys = record.results.map(fleetTargetKey);
    if (new Set(resultKeys).size !== resultKeys.length) {
      throw new Error("duplicate result target");
    }
    for (const [key, checkpoint] of Object.entries(record.checkpoints)) {
      if (
        fleetTargetKey(checkpoint) !== key ||
        fleetTargetKey(checkpoint.target.identity) !== key
      ) {
        throw new Error(`checkpoint key ${key} does not match its tenant identity`);
      }
    }
    if (record.lease && record.lease.selectionDigest !== record.selectionDigest) {
      throw new Error("lease selection digest does not match the run");
    }
    if (record.lease) {
      const leaseKeys = record.lease.targets.map(fleetTargetKey).sort();
      if (new Set(leaseKeys).size !== leaseKeys.length) {
        throw new Error("lease contains duplicate tenant targets");
      }
      const runKeys = [
        ...(record.canaryTarget ? [fleetTargetKey(record.canaryTarget)] : []),
        ...record.batches.flatMap((batch) => batch.map(fleetTargetKey)),
        ...record.results.map(fleetTargetKey),
      ];
      const expected = [...new Set(runKeys)].sort();
      if (leaseKeys.join("\u0000") !== expected.join("\u0000")) {
        throw new Error("lease tenant targets do not match the run selection");
      }
    }
  } catch (error) {
    throw new Error(
      `fleet run ${record.runId} lacks canonical organization-plus-venture identity and cannot resume: ${(error as Error).message}`,
    );
  }
}

export function createFleetController(options: {
  store: FleetStateStore;
  now?: () => Date;
  controllerId?: string;
  leaseDurationMs?: number;
  afterHook?: UpgradePersistence["afterHook"];
}) {
  const now = options.now ?? (() => new Date());
  const controllerId = options.controllerId ?? randomUUID();
  const leaseDurationMs = options.leaseDurationMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error("Fleet lease duration must be a positive integer");
  }

  async function rollout(input: {
    runId: string;
    release: CoreReleaseManifest;
    ventures: readonly FleetVenture[];
    batchSize: number;
  }): Promise<FleetRunRecord> {
    if (!Number.isInteger(input.batchSize) || input.batchSize < 1) {
      throw new Error("Fleet batch size must be a positive integer");
    }
    let record = options.store.get(input.runId);
    if (record) assertRunTenantBindings(record);
    const fleet = selectedFleet({ ...input, checkpoints: record?.checkpoints });
    if (input.release.rollback.mode === "previous_release") {
      for (const venture of fleet.selected) {
        const priorVersion =
          record?.checkpoints[fleetTargetKey(venture)]?.priorVersion ??
          venture.currentLock.harness_version;
        if (
          priorVersion !== input.release.version &&
          input.release.rollback.version !== priorVersion
        ) {
          throw new Error(
            `fleet rollback version ${input.release.rollback.version ?? "missing"} does not match prior venture version ${priorVersion}`,
          );
        }
      }
    }
    if (record) {
      if (record.releaseDigest !== input.release.digest) {
        throw new Error("fleet run ID is already bound to another release");
      }
      if (record.selectionDigest !== fleet.selectionDigest) {
        throw new Error("fleet run selection or batch shape changed during resume");
      }
      for (const [ventureId, checkpoint] of Object.entries(record.checkpoints)) {
        const venture = fleet.ordered.find((candidate) => fleetTargetKey(candidate) === ventureId);
        if (!venture) throw new Error(`fleet checkpoint target ${ventureId} is unavailable`);
        assertTargetBinding(venture, checkpoint);
      }
      if (record.status === "completed" || record.status === "paused") return record;
    } else {
      const createdAt = now().toISOString();
      record = {
        runId: input.runId,
        releaseVersion: input.release.version,
        releaseDigest: input.release.digest,
        status: "running",
        canaryTarget: fleet.canary ? fleetTargetIdentity(fleet.canary) : null,
        batches: fleet.batches,
        selectionDigest: fleet.selectionDigest,
        results: fleet.unaffected.map((venture) => ({
          organizationId: venture.organizationId,
          ventureId: venture.ventureId,
          status: "unaffected",
          phase: "selection",
          branch: null,
          priorVersion: venture.currentLock.harness_version,
          targetVersion: input.release.version,
          evidence: [],
          error: null,
        })),
        checkpoints: {},
        lease: null,
        createdAt,
        updatedAt: createdAt,
      };
      options.store.put(record);
    }

    const acquireAt = now();
    const leased = options.store.acquireLease({
      runId: input.runId,
      releaseDigest: input.release.digest,
      selectionDigest: fleet.selectionDigest,
      targets: fleet.ordered.map(fleetTargetIdentity),
      ownerId: controllerId,
      acquiredAt: acquireAt.toISOString(),
      expiresAt: new Date(acquireAt.getTime() + leaseDurationMs).toISOString(),
    });
    if (!leased) throw new Error("fleet run is leased by another active controller");
    record = leased;

    const persist = (next: FleetRunRecord): FleetRunRecord => {
      const renewalAt = now();
      const renewed = options.store.acquireLease({
        runId: input.runId,
        releaseDigest: input.release.digest,
        selectionDigest: fleet.selectionDigest,
        targets: fleet.ordered.map(fleetTargetIdentity),
        ownerId: controllerId,
        acquiredAt: renewalAt.toISOString(),
        expiresAt: new Date(renewalAt.getTime() + leaseDurationMs).toISOString(),
      });
      if (!renewed) throw new Error("fleet run lease was lost while persisting progress");
      record = {
        ...next,
        lease: renewed.lease,
        updatedAt: renewalAt.toISOString(),
      };
      options.store.put(record, controllerId);
      return record;
    };
    const finish = (status: "paused" | "completed"): FleetRunRecord => {
      record = { ...record!, status, lease: null, updatedAt: now().toISOString() };
      options.store.put(record, controllerId);
      return record;
    };
    const saveCheckpoint = (checkpoint: FleetVentureCheckpoint) => {
      persist({
        ...record!,
        checkpoints: { ...record!.checkpoints, [fleetTargetKey(checkpoint)]: checkpoint },
      });
    };
    const saveResult = (result: FleetVentureResult) => {
      const resultKey = fleetTargetKey(result);
      persist({
        ...record!,
        results: [
          ...record!.results.filter((candidate) => fleetTargetKey(candidate) !== resultKey),
          result,
        ],
      });
    };
    if (!fleet.canary) return finish("completed");

    const runVenture = async (venture: FleetVenture) => {
      const ventureKey = fleetTargetKey(venture);
      const prior = record!.results.find((result) => fleetTargetKey(result) === ventureKey);
      if (prior && VERIFIED_STATUSES.has(prior.status)) return prior;
      const result = await upgradeOne(venture, input.release, {
        runId: input.runId,
        load: () => record!.checkpoints[ventureKey] ?? null,
        save: saveCheckpoint,
        afterHook: options.afterHook,
        now,
      });
      saveResult(result);
      return result;
    };

    const canaryResult = await runVenture(fleet.canary);
    if (!VERIFIED_STATUSES.has(canaryResult.status)) return finish("paused");
    for (const batch of record.batches) {
      for (const target of batch) {
        const targetKey = fleetTargetKey(target);
        const venture = fleet.selected.find((candidate) => fleetTargetKey(candidate) === targetKey);
        if (!venture) throw new Error(`fleet venture ${targetKey} is unavailable during resume`);
        const result = await runVenture(venture);
        if (!VERIFIED_STATUSES.has(result.status)) return finish("paused");
      }
    }
    return finish("completed");
  }

  return { rollout };
}
