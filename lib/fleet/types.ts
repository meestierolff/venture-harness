import type { HarnessLock } from "../config/harness-lock";
import type { MigrationFileSystem } from "../migrations";
import type { HarnessRelease } from "../upgrade";
import type { FleetTargetIdentity } from "./identity";

export interface CoreReleaseManifest {
  schemaVersion: 1;
  version: string;
  sourceRef: string;
  workflowRefSha: string;
  changedPackages: Readonly<Record<string, { from: string; to: string }>>;
  affectedCapabilities: readonly string[];
  migrations: readonly string[];
  compatibility: { minimumCoreVersion: string; seedIds: readonly string[] };
  requiredChecks: readonly string[];
  rolloutRisk: "low" | "medium" | "high";
  rollback: { mode: "previous_release" | "forward_fix"; version: string | null };
  files: HarnessRelease["files"];
  digest: string;
}

export interface FleetVentureHooks {
  openUpgradeBranch(
    input: FleetTargetIdentity & {
      branch: string;
      release: CoreReleaseManifest;
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; fixture: boolean; reference: string }>;
  runMigrations(
    input: FleetTargetIdentity & {
      migrations: readonly string[];
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; evidence: readonly string[] }>;
  runChecks(
    input: FleetTargetIdentity & {
      checks: readonly string[];
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; evidence: readonly string[] }>;
  deployPreview(
    input: FleetTargetIdentity & {
      branch: string;
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; fixture: boolean; reference: string }>;
  merge(
    input: FleetTargetIdentity & {
      branch: string;
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; fixture: boolean; reference: string }>;
  deployProduction(
    input: FleetTargetIdentity & {
      release: string;
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; fixture: boolean; reference: string }>;
  smokeProduction(
    input: FleetTargetIdentity & {
      release: string;
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; fixture: boolean; reference: string }>;
  compensate(
    input: FleetTargetIdentity & {
      failedRelease: string;
      rollbackVersion: string | null;
      reason: string;
      mode: CoreReleaseManifest["rollback"]["mode"];
      idempotencyKey: string;
    },
  ): Promise<{ passed: boolean; fixture: boolean; reference: string }>;
  /**
   * Read a phase back after a process stopped while its durable checkpoint was
   * `prepared`. A completed effect is never invoked again; `not_applied` is the
   * only state that permits the same idempotency key to be retried.
   */
  reconcilePhase(
    input: FleetTargetIdentity & {
      release: CoreReleaseManifest;
      phase: FleetHookPhase;
      idempotencyKey: string;
    },
  ): Promise<{
    state: "completed" | "not_applied" | "unknown";
    passed: boolean;
    evidence: readonly string[];
  }>;
}

export interface FleetVenture extends FleetTargetIdentity {
  repository: string;
  designFingerprint: string;
  serviceBlueprintFingerprint: string;
  capabilities: readonly string[];
  providers: readonly string[];
  currentLock: HarnessLock;
  fileSystem: MigrationFileSystem;
  canary: boolean;
  policy: { automaticMerge: boolean; productionDeployment: boolean };
  hooks: FleetVentureHooks;
  deployedHealth(
    input: FleetTargetIdentity & {
      phase: "production" | "compensation";
      expectedVersion: string;
    },
  ): Promise<{ healthy: boolean; version: string }>;
}

export type FleetVentureStatus =
  | "unaffected"
  | "already_current"
  | "planned"
  | "upgrading"
  | "waiting_for_merge_approval"
  | "verified"
  | "paused"
  | "rolled_back"
  | "forward_fix_required";

export type FleetHookPhase =
  "branch" | "migrations" | "checks" | "preview" | "merge" | "production" | "smoke" | "compensate";

export type FleetCheckpointPhase =
  FleetHookPhase | "upgrade" | "lock" | "production_readback" | "compensation_readback";

export interface FleetPhaseCheckpoint {
  phase: FleetCheckpointPhase;
  state: "prepared" | "completed";
  idempotencyKey: string;
  passed: boolean | null;
  evidence: readonly string[];
  updatedAt: string;
}

export interface FleetVentureCheckpoint extends FleetTargetIdentity {
  target: {
    identity: FleetTargetIdentity;
    repository: string;
    designFingerprint: string;
    serviceBlueprintFingerprint: string;
    initialLockDigest: string;
  };
  priorVersion: string;
  targetVersion: string;
  branch: string;
  originals: readonly { path: string; content: string | null }[];
  candidateLock: HarnessLock | null;
  productionTouched: boolean;
  phases: Partial<Record<FleetCheckpointPhase, FleetPhaseCheckpoint>>;
}

export interface FleetRunLease {
  ownerId: string;
  selectionDigest: string;
  targets: readonly FleetTargetIdentity[];
  acquiredAt: string;
  expiresAt: string;
}

export interface FleetVentureResult extends FleetTargetIdentity {
  status: FleetVentureStatus;
  phase: string;
  branch: string | null;
  priorVersion: string;
  targetVersion: string;
  evidence: readonly string[];
  error: string | null;
}

export interface FleetRunRecord {
  runId: string;
  releaseVersion: string;
  releaseDigest: string;
  status: "planned" | "running" | "paused" | "completed";
  canaryTarget: FleetTargetIdentity | null;
  batches: readonly (readonly FleetTargetIdentity[])[];
  selectionDigest: string;
  results: readonly FleetVentureResult[];
  checkpoints: Readonly<Record<string, FleetVentureCheckpoint>>;
  lease: FleetRunLease | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetStateStore {
  get(runId: string): FleetRunRecord | null;
  /** Without an owner this is an atomic create-only write; leased updates require the owner. */
  put(record: FleetRunRecord, leaseOwnerId?: string): void;
  acquireLease(input: {
    runId: string;
    releaseDigest: string;
    selectionDigest: string;
    targets: readonly FleetTargetIdentity[];
    ownerId: string;
    acquiredAt: string;
    expiresAt: string;
  }): FleetRunRecord | null;
  close(): void;
}
