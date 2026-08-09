import { randomBytes } from "node:crypto";
import {
  consumeOneShotCheckpointGrant,
  issueOneShotCheckpointGrant,
  oneShotCheckpointGrantSchema,
  type AuthorizationCheckpointScope,
  type OneShotCheckpointGrant,
} from "../authorization/checkpoint-grant";
import { sideEffectClassSchema } from "../config/policy-schema";
import { WorkflowExecutionError } from "./errors";
import { sanitizeJson } from "./redaction";
import type { WorkflowStore } from "./store";
import {
  type JsonValue,
  type WorkflowBindings,
  type WorkflowAuthorizationCheckpointRequirement,
  type WorkflowAuthorizationRefresh,
  type WorkflowAuthorizationSpendReservation,
  type WorkflowCheckpointGrantResolution,
  type WorkflowCompensationContext,
  type WorkflowCostRecord,
  type WorkflowDefinition,
  type WorkflowEventType,
  type WorkflowHandlerContext,
  type WorkflowHandlerResult,
  type WorkflowInterruptResolution,
  type WorkflowNodeDefinition,
  type WorkflowNodeError,
  type WorkflowNodeRecord,
  type WorkflowReconciliationResult,
  type WorkflowRunState,
  type WorkflowStartOptions,
  type WorkflowSteerRequest,
  type WorkflowSupersedeOptions,
  type WorkflowValidationContext,
  type WorkflowValidatorResult,
} from "./types";
import { topologicalOrder, validateWorkflow, workflowFingerprint } from "./validation";

export interface WorkflowExecutorOptions {
  store: WorkflowStore;
  bindings?: WorkflowBindings;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

const TERMINAL_NODE_STATES = new Set([
  "succeeded",
  "failed_terminal",
  "skipped",
  "compensated",
  "cancelled",
]);

function isTerminalNode(record: WorkflowNodeRecord): boolean {
  return TERMINAL_NODE_STATES.has(record.state);
}

function successfulDependency(record: WorkflowNodeRecord): boolean {
  return record.state === "succeeded" || record.state === "compensated";
}

// State can change while an awaited handler is running (for example through
// cancel()). Keep these checks behind functions so TypeScript does not assume
// the pre-await discriminant is still authoritative.
function runWasCancelled(state: WorkflowRunState): boolean {
  return state.status === "cancelled" || state.status === "superseded";
}

function nodeWasSkipped(record: WorkflowNodeRecord): boolean {
  return record.state === "skipped" || record.state === "cancelled";
}

function currentNodeState(record: WorkflowNodeRecord): WorkflowNodeRecord["state"] {
  return record.state;
}

function isProviderPlanCheckpoint(value: JsonValue | undefined): boolean {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    value.kind === "provider_plan"
  );
}

function normalizedValidatorResult(result: WorkflowValidatorResult): {
  ok: boolean;
  message?: string;
} {
  return typeof result === "boolean" ? { ok: result } : result;
}

export class WorkflowExecutor {
  private readonly store: WorkflowStore;
  private readonly bindings: Required<
    Omit<
      WorkflowBindings,
      "secrets" | "interruptEvidenceVerifier" | "checkpointEvidenceVerifier" | "workspaceFactory"
    >
  > & {
    interruptEvidenceVerifier?: WorkflowBindings["interruptEvidenceVerifier"];
    checkpointEvidenceVerifier?: WorkflowBindings["checkpointEvidenceVerifier"];
    workspaceFactory?: WorkflowBindings["workspaceFactory"];
    secrets: string[];
  };
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeStates = new Map<string, WorkflowRunState>();

  constructor(options: WorkflowExecutorOptions) {
    this.store = options.store;
    this.bindings = {
      handlers: options.bindings?.handlers ?? {},
      validators: options.bindings?.validators ?? {},
      conditions: options.bindings?.conditions ?? {},
      compensators: options.bindings?.compensators ?? {},
      reconcilers: options.bindings?.reconcilers ?? {},
      workspaceFactory: options.bindings?.workspaceFactory,
      interruptEvidenceVerifier: options.bindings?.interruptEvidenceVerifier,
      checkpointEvidenceVerifier: options.bindings?.checkpointEvidenceVerifier,
      secrets: options.bindings?.secrets ?? [],
    };
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  create(definition: WorkflowDefinition, options: WorkflowStartOptions = {}): WorkflowRunState {
    validateWorkflow(definition);
    const runId = options.runId ?? this.generateRunId(definition.id);
    const timestamp = this.timestamp();
    const limits = { ...definition.budgets, ...options.budgets };
    const maxIterations = options.maxIterations ?? definition.maxIterations;
    const maxParallel = options.maxParallel ?? definition.maxParallel;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new Error("Workflow maxIterations override must be a positive integer.");
    }
    if (!Number.isInteger(maxParallel) || maxParallel < 1) {
      throw new Error("Workflow maxParallel override must be a positive integer.");
    }
    for (const [category, limit] of Object.entries(limits)) {
      if (!category.trim() || !Number.isFinite(limit) || limit < 0) {
        throw new Error(`Workflow budget override "${category}" must be non-negative and finite.`);
      }
    }
    const consumed = Object.fromEntries(
      [...new Set(definition.nodes.map((node) => node.budgetCategory))].map((category) => [
        category,
        0,
      ]),
    );
    const state: WorkflowRunState = {
      schemaVersion: 1,
      runId,
      graph: {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        fingerprint: workflowFingerprint(definition),
      },
      status: "created",
      nodes: Object.fromEntries(
        definition.nodes.map((node) => [
          node.id,
          {
            definition: sanitizeJson(
              node,
              this.bindings.secrets,
            ) as unknown as WorkflowNodeDefinition,
            state: "pending",
            attempts: 0,
            iterationAttempts: 0,
            effectVerified: false,
            cost: 0,
            revision: 0,
            loopIterations: 0,
            costEntries: [],
          } satisfies WorkflowNodeRecord,
        ]),
      ),
      verifiedEffects: {},
      checkpointGrants: {},
      authorizationSpend: { currency: null, totalAmount: 0, reservations: {} },
      cache: {},
      budget: { limits, consumed },
      iterations: 0,
      maxIterations,
      maxParallel,
      eventSequence: 0,
      steeringRevision: 0,
      costs: [],
      supersedesRunId: options.supersedesRunId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.create(state);
    this.record(state, "run_created", undefined, {
      graphId: definition.id,
      graphVersion: definition.version,
    });
    return state;
  }

  async start(
    definition: WorkflowDefinition,
    options: WorkflowStartOptions = {},
  ): Promise<WorkflowRunState> {
    const state = this.create(definition, options);
    return this.execute(definition, state, false);
  }

  enqueue(definition: WorkflowDefinition, options: WorkflowStartOptions = {}): WorkflowRunState {
    const state = this.create(definition, options);
    state.status = "queued";
    state.queuedAt = this.timestamp();
    this.record(state, "run_queued", undefined, {
      queuedAt: state.queuedAt,
      supersedesRunId: state.supersedesRunId ?? null,
    });
    return state;
  }

  listQueue(): WorkflowRunState[] {
    return this.store
      .listRuns()
      .map((runId) => this.getState(runId))
      .filter(({ status }) => status === "queued")
      .sort((left, right) =>
        (left.queuedAt ?? left.createdAt).localeCompare(right.queuedAt ?? right.createdAt),
      );
  }

  async startQueued(definition: WorkflowDefinition, runId: string): Promise<WorkflowRunState> {
    const state = this.store.load(runId);
    this.normalizeState(state);
    this.assertGraphMatch(definition, state);
    if (state.status !== "queued" && state.status !== "created") {
      throw new Error(`Workflow run "${runId}" is ${state.status}; only queued runs can start.`);
    }
    return this.execute(definition, state, false);
  }

  async resume(definition: WorkflowDefinition, runId: string): Promise<WorkflowRunState> {
    validateWorkflow(definition);
    const state = this.store.load(runId);
    this.normalizeState(state);
    this.assertGraphMatch(definition, state);
    if (
      state.status === "succeeded" ||
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "superseded"
    ) {
      return state;
    }
    return this.execute(definition, state, true);
  }

  getState(runId: string): WorkflowRunState {
    const state = this.store.load(runId);
    this.normalizeState(state);
    return state;
  }

  async approve(
    runId: string,
    nodeId: string,
    resolution: WorkflowInterruptResolution,
  ): Promise<WorkflowRunState> {
    return this.resolveInterrupt(runId, nodeId, "waiting_for_approval", resolution);
  }

  async completeManualAction(
    runId: string,
    nodeId: string,
    resolution: WorkflowInterruptResolution,
  ): Promise<WorkflowRunState> {
    return this.resolveInterrupt(runId, nodeId, "waiting_for_manual_action", resolution);
  }

  async refreshAuthorization(
    runId: string,
    nodeId: string,
    resolution: WorkflowAuthorizationRefresh,
  ): Promise<WorkflowRunState> {
    const state = this.store.load(runId);
    this.normalizeState(state);
    const record = state.nodes[nodeId];
    if (!record) throw new Error(`Workflow run "${runId}" has no node "${nodeId}".`);
    if (record.state !== "waiting_for_auth") {
      throw new Error(`Node "${nodeId}" is ${record.state}; expected waiting_for_auth.`);
    }
    if (!resolution.authorizedBy.trim()) {
      throw new Error(`Authorization refresh for node "${nodeId}" requires an identity.`);
    }
    if (
      resolution.credentialRef !== undefined &&
      !/^cred:\/\/[a-z0-9][a-z0-9._/-]*$/i.test(resolution.credentialRef)
    ) {
      throw new Error("Authorization refresh accepts only a credential reference, never a value.");
    }
    if (
      resolution.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(resolution.expiresAt)) ||
        Date.parse(resolution.expiresAt) <= Date.parse(this.timestamp()))
    ) {
      throw new Error("Authorization refresh expiry must be a future ISO timestamp.");
    }

    record.state = record.operation ? "failed_retryable" : "pending";
    record.error = undefined;
    record.waiting = undefined;
    record.startedAt = undefined;
    record.finishedAt = undefined;
    state.status = "created";
    state.finishedAt = undefined;
    this.record(state, "interrupt_resolved", nodeId, {
      kind: "auth",
      authorizedBy: resolution.authorizedBy,
      credentialRef: resolution.credentialRef ?? null,
      expiresAt: resolution.expiresAt ?? null,
      note: resolution.note ?? null,
    });
    return state;
  }

  async reconcile(
    runId: string,
    nodeId: string,
    reason: "restart" | "retry" | "poll" | "cancel" = "poll",
  ): Promise<WorkflowRunState> {
    const state = this.activeStates.get(runId) ?? this.store.load(runId);
    this.normalizeState(state);
    const record = state.nodes[nodeId];
    if (!record) throw new Error(`Workflow run "${runId}" has no node "${nodeId}".`);
    await this.reconcileNode(state, record, reason);
    return state;
  }

  async steer(
    definition: WorkflowDefinition,
    runId: string,
    request: WorkflowSteerRequest,
  ): Promise<WorkflowRunState> {
    validateWorkflow(definition);
    const state = this.activeStates.get(runId) ?? this.store.load(runId);
    this.normalizeState(state);
    this.assertGraphMatch(definition, state);
    if (!request.reason.trim() || !request.steeredBy.trim()) {
      throw new Error("A steer requires both reason and steeredBy.");
    }
    const targets = Object.keys(request.inputs).sort();
    if (targets.length === 0) throw new Error("A steer requires at least one node input.");
    for (const target of targets) {
      if (!state.nodes[target]) throw new Error(`Workflow run "${runId}" has no node "${target}".`);
    }

    const affected = this.affectedDescendants(state, targets);
    for (const nodeId of affected) {
      const record = state.nodes[nodeId];
      const effectful = record.definition.effect !== "none" && record.definition.effect !== "read";
      if (
        effectful &&
        (record.effectVerified ||
          Boolean(state.verifiedEffects[record.definition.idempotencyKey]) ||
          record.attempts > 0 ||
          Boolean(record.operation))
      ) {
        throw new Error(
          `Steer would invalidate effectful node "${nodeId}" after execution began; supersede the run instead.`,
        );
      }
    }

    for (const nodeId of affected) {
      this.activeControllers.get(`${runId}:${nodeId}`)?.abort("workflow steered");
      const record = state.nodes[nodeId];
      record.revision = (record.revision ?? 0) + 1;
      record.state = "pending";
      record.attempts = 0;
      record.loopIterations = 0;
      record.startedAt = undefined;
      record.finishedAt = undefined;
      record.output = undefined;
      record.error = undefined;
      record.effectVerified = false;
      record.evidenceArtifact = undefined;
      record.skipReason = undefined;
      record.operation = undefined;
      record.waiting = undefined;
      record.workspace = undefined;
      const cacheKey = record.definition.cache.key ?? record.definition.idempotencyKey;
      delete state.cache[cacheKey];
      if (Object.hasOwn(request.inputs, nodeId)) {
        record.definition = {
          ...record.definition,
          input: { ...record.definition.input, value: request.inputs[nodeId] },
        };
      }
    }

    state.steeringRevision = (state.steeringRevision ?? 0) + 1;
    state.finishedAt = undefined;
    if (!this.activeStates.has(runId)) {
      state.status = state.status === "queued" ? "queued" : "created";
    }
    const preserved = Object.keys(state.nodes)
      .filter((nodeId) => !affected.has(nodeId))
      .sort();
    this.record(state, "run_steered", undefined, {
      revision: state.steeringRevision,
      steeredBy: request.steeredBy,
      reason: request.reason,
      targets,
      invalidated: [...affected].sort(),
      preserved,
    });
    return state;
  }

  async supersede(
    runId: string,
    currentDefinition: WorkflowDefinition,
    replacementDefinition: WorkflowDefinition,
    options: WorkflowSupersedeOptions,
  ): Promise<{ superseded: WorkflowRunState; replacement: WorkflowRunState }> {
    validateWorkflow(currentDefinition);
    validateWorkflow(replacementDefinition);
    const state = this.activeStates.get(runId) ?? this.store.load(runId);
    this.normalizeState(state);
    this.assertGraphMatch(currentDefinition, state);
    if (["succeeded", "failed", "cancelled", "superseded"].includes(state.status)) {
      throw new Error(`Workflow run "${runId}" is already terminal (${state.status}).`);
    }
    if (!options.reason.trim() || !options.supersededBy.trim()) {
      throw new Error("Supersede requires both reason and supersededBy.");
    }

    const replacementOptions: WorkflowStartOptions = {
      runId: options.runId,
      maxParallel: options.maxParallel,
      maxIterations: options.maxIterations,
      budgets: options.budgets,
      supersedesRunId: runId,
    };
    const replacement =
      options.queue === false
        ? this.create(replacementDefinition, replacementOptions)
        : this.enqueue(replacementDefinition, replacementOptions);

    state.status = "superseded";
    state.supersededByRunId = replacement.runId;
    state.finishedAt = this.timestamp();
    const cancelledNodes: string[] = [];
    const skippedNodes: string[] = [];
    const interruptedEffects: WorkflowNodeRecord[] = [];
    for (const record of Object.values(state.nodes)) {
      if (isTerminalNode(record)) continue;
      const wasRunning = record.state === "running";
      record.state = wasRunning ? "cancelled" : "skipped";
      record.skipReason = `run superseded by ${replacement.runId}: ${options.reason}`;
      record.finishedAt = this.timestamp();
      this.activeControllers.get(`${runId}:${record.definition.id}`)?.abort("workflow superseded");
      (wasRunning ? cancelledNodes : skippedNodes).push(record.definition.id);
      if (wasRunning && this.isEffectful(record.definition)) interruptedEffects.push(record);
    }
    this.record(state, "run_superseded", undefined, {
      replacementRunId: replacement.runId,
      supersededBy: options.supersededBy,
      reason: options.reason,
      cancelledNodes: cancelledNodes.sort(),
      skippedNodes: skippedNodes.sort(),
    });
    for (const nodeId of cancelledNodes) {
      this.record(state, "node_cancelled", nodeId, {
        reason: `run superseded by ${replacement.runId}`,
      });
    }
    for (const nodeId of skippedNodes) {
      this.record(state, "node_skipped", nodeId, {
        reason: `run superseded by ${replacement.runId}`,
      });
    }
    for (const record of interruptedEffects) {
      await this.reconcileNode(state, record, "cancel");
    }
    const readyReplacement =
      options.queue === false
        ? await this.execute(replacementDefinition, replacement, false)
        : replacement;
    return { superseded: state, replacement: readyReplacement };
  }

  async grantAuthorizationCheckpoint(
    runId: string,
    nodeId: string,
    resolution: WorkflowCheckpointGrantResolution,
  ): Promise<WorkflowRunState> {
    const state = this.store.load(runId);
    const record = state.nodes[nodeId];
    if (!record) throw new Error(`Workflow run "${runId}" has no node "${nodeId}".`);
    if (
      record.state !== "waiting_for_approval" ||
      record.error?.code !== "authorization_checkpoint_required"
    ) {
      throw new Error(`Node "${nodeId}" is not waiting for a provider authorization checkpoint.`);
    }
    const requirements = this.checkpointRequirements(record.error.details);
    const requestedAt = this.checkpointRequestedAt(record.error.details);
    if (!requirements || !requestedAt) {
      throw new Error(`Node "${nodeId}" has invalid persisted checkpoint requirements.`);
    }
    const requirement = requirements.find(
      ({ effect, operationId }) =>
        effect === resolution.effect && operationId === resolution.operationId,
    );
    if (!requirement) {
      throw new Error(
        `Checkpoint scope ${resolution.effect}/${resolution.operationId} was not requested by node "${nodeId}".`,
      );
    }
    if (!resolution.approvedBy.trim()) {
      throw new Error(`Checkpoint for node "${nodeId}" requires an approvedBy identity.`);
    }
    if (Date.parse(resolution.approvedAt) < Date.parse(requestedAt)) {
      throw new Error(
        `Checkpoint approval for node "${nodeId}" predates the current request at ${requestedAt}.`,
      );
    }
    const verifyEvidence = this.bindings.checkpointEvidenceVerifier;
    if (!verifyEvidence) {
      throw new Error(
        `Node "${nodeId}" has a dangerous effect but no checkpoint evidence verifier is registered.`,
      );
    }
    const verified = normalizedValidatorResult(
      await verifyEvidence({
        runId,
        node: record.definition,
        effect: resolution.effect,
        operationId: resolution.operationId,
        evidenceArtifact: resolution.evidenceArtifact,
        approvedBy: resolution.approvedBy,
        approvedAt: resolution.approvedAt,
      }),
    );
    if (!verified.ok) {
      throw new Error(
        verified.message ?? `Checkpoint evidence for node "${nodeId}" was not verified.`,
      );
    }

    const now = this.timestamp();
    const scope: AuthorizationCheckpointScope = {
      runId,
      nodeId,
      effect: resolution.effect,
      operationId: resolution.operationId,
    };
    const priorGrants = Object.values(state.checkpointGrants ?? {});
    if (
      priorGrants.some(({ evidenceArtifact }) => evidenceArtifact === resolution.evidenceArtifact)
    ) {
      throw new Error(
        `Checkpoint evidence ${resolution.evidenceArtifact} has already issued a one-shot grant.`,
      );
    }
    if (
      priorGrants.some(
        (grant) =>
          grant.runId === runId &&
          grant.nodeId === nodeId &&
          grant.effect === resolution.effect &&
          grant.operationId === resolution.operationId &&
          Date.parse(grant.approvedAt) >= Date.parse(resolution.approvedAt),
      )
    ) {
      throw new Error(
        `Checkpoint for node "${nodeId}" requires a fresh approval after the prior one-shot grant.`,
      );
    }
    const existing = this.availableCheckpointGrant(state, scope, now);
    if (existing) {
      throw new Error(
        `Node "${nodeId}" already has an unused checkpoint grant for ${resolution.effect}/${resolution.operationId}.`,
      );
    }
    const grant = issueOneShotCheckpointGrant({
      grantId: `checkpoint-${randomBytes(16).toString("hex")}`,
      scope,
      approvedBy: resolution.approvedBy,
      approvedAt: resolution.approvedAt,
      evidenceArtifact: resolution.evidenceArtifact,
      issuedAt: now,
      expiresAt: resolution.expiresAt,
    });
    state.checkpointGrants ??= {};
    state.checkpointGrants[grant.grantId] = grant;

    const allGranted = requirements.every(({ effect, operationId }) =>
      Boolean(this.availableCheckpointGrant(state, { runId, nodeId, effect, operationId }, now)),
    );
    if (allGranted) {
      record.state = "pending";
      record.error = undefined;
      record.startedAt = undefined;
      record.finishedAt = undefined;
      state.status = "created";
      state.finishedAt = undefined;
    }
    this.record(state, "checkpoint_grant_issued", nodeId, {
      grantId: grant.grantId,
      effect: grant.effect,
      operationId: grant.operationId,
      approvedBy: grant.approvedBy,
      approvedAt: grant.approvedAt,
      evidenceArtifact: grant.evidenceArtifact,
      expiresAt: grant.expiresAt,
      ready: allGranted,
    });
    return state;
  }

  async cancel(
    runId: string,
    reason: string,
    definition?: WorkflowDefinition,
  ): Promise<WorkflowRunState> {
    const state = this.activeStates.get(runId) ?? this.store.load(runId);
    this.normalizeState(state);
    if (
      state.status === "succeeded" ||
      state.status === "failed" ||
      state.status === "cancelled" ||
      state.status === "superseded"
    ) {
      return state;
    }
    if (definition) this.assertGraphMatch(definition, state);
    if (!reason.trim()) throw new Error("Workflow cancellation requires a reason.");

    state.status = "cancelled";
    state.cancellationReason = reason;
    state.finishedAt = this.timestamp();
    const interruptedEffects: WorkflowNodeRecord[] = [];
    const cancelledNodes: string[] = [];
    const skippedNodes: string[] = [];
    for (const record of Object.values(state.nodes)) {
      if (!isTerminalNode(record)) {
        const wasRunning = record.state === "running";
        record.state = wasRunning ? "cancelled" : "skipped";
        record.skipReason = `run cancelled: ${reason}`;
        record.finishedAt = this.timestamp();
        if (wasRunning && this.isEffectful(record.definition)) interruptedEffects.push(record);
        (wasRunning ? cancelledNodes : skippedNodes).push(record.definition.id);
      }
    }
    for (const [key, controller] of this.activeControllers) {
      if (key.startsWith(`${runId}:`)) controller.abort(reason);
    }
    // Persist the terminal intent before reconciliation or compensation. A
    // crash during either phase must never make the run runnable again.
    this.record(state, "run_cancelled", undefined, {
      reason,
      cancelledNodes: cancelledNodes.sort(),
      skippedNodes: skippedNodes.sort(),
    });
    for (const nodeId of cancelledNodes) {
      this.record(state, "node_cancelled", nodeId, { reason });
    }
    for (const nodeId of skippedNodes) {
      this.record(state, "node_skipped", nodeId, { reason: `run cancelled: ${reason}` });
    }
    for (const record of interruptedEffects) {
      await this.reconcileNode(state, record, "cancel");
    }
    if (definition) await this.compensate(definition, state, "cancel");
    return state;
  }

  private async execute(
    definition: WorkflowDefinition,
    state: WorkflowRunState,
    recovering: boolean,
  ): Promise<WorkflowRunState> {
    this.assertGraphMatch(definition, state);
    this.activeStates.set(state.runId, state);
    try {
      this.normalizeState(state);
      if (recovering) await this.recoverInterruptedNodes(state);
      state.status = "running";
      this.record(state, "run_started", undefined, { recovering });

      const order = topologicalOrder(definition);
      while (state.status === "running") {
        if (state.iterations >= state.maxIterations) {
          this.failUnfinishedNodes(
            state,
            "MAX_ITERATIONS_EXCEEDED",
            `Workflow exceeded ${state.maxIterations} scheduler iterations.`,
          );
          break;
        }

        await this.prepareNodes(order, state);
        const batch = this.selectReadyBatch(order, state);
        if (batch.length > 0) {
          state.iterations += 1;
          await Promise.all(batch.map((nodeId) => this.executeNode(state, nodeId)));
          continue;
        }

        const records = Object.values(state.nodes);
        if (records.some((record) => record.state === "running")) continue;
        if (records.some((record) => record.state === "failed_terminal")) {
          this.skipUnfinishedNodesAfterFailure(state);
          break;
        }
        if (
          records.some(
            (record) =>
              record.state === "waiting_for_approval" ||
              record.state === "waiting_for_manual_action" ||
              record.state === "waiting_for_auth" ||
              record.state === "waiting_for_external_action",
          )
        ) {
          state.status = "waiting";
          this.record(state, "run_waiting", undefined, {
            nodes: records
              .filter(
                (record) =>
                  record.state === "waiting_for_approval" ||
                  record.state === "waiting_for_manual_action" ||
                  record.state === "waiting_for_auth" ||
                  record.state === "waiting_for_external_action",
              )
              .map((record) => record.definition.id),
          });
          return state;
        }
        if (records.every(isTerminalNode)) {
          state.status = "succeeded";
          state.finishedAt = this.timestamp();
          this.record(state, "run_succeeded");
          return state;
        }

        this.failUnfinishedNodes(
          state,
          "SCHEDULER_DEADLOCK",
          "No node was runnable and no persisted interrupt explained the pause.",
        );
        break;
      }

      if (!runWasCancelled(state)) {
        await this.compensate(definition, state, "failure");
        state.status = "failed";
        state.finishedAt = this.timestamp();
        this.record(state, "run_failed");
      }
      return state;
    } finally {
      this.activeStates.delete(state.runId);
    }
  }

  private async recoverInterruptedNodes(state: WorkflowRunState): Promise<void> {
    const recovered: string[] = [];
    for (const record of Object.values(state.nodes)) {
      if (record.state === "running" || record.state === "failed_retryable") {
        const verified = state.verifiedEffects[record.definition.idempotencyKey];
        if (verified) {
          record.state = "succeeded";
          record.output = verified.output;
          record.evidenceArtifact = verified.evidenceArtifact;
          record.effectVerified = true;
          record.finishedAt = verified.verifiedAt;
          if (record.operation) {
            record.operation.phase = "verified";
            record.operation.updatedAt = verified.verifiedAt;
          }
        } else if (this.requiresOutcomeReconciliation(record)) {
          if (!record.operation) {
            const timestamp = this.timestamp();
            record.operation = {
              attempt: Math.max(1, record.attempts),
              idempotencyKey: record.definition.idempotencyKey,
              phase: "prepared",
              preparedAt: record.startedAt ?? timestamp,
              updatedAt: timestamp,
              reconcileAttempts: 0,
            };
          }
          await this.reconcileNode(state, record, "restart");
        } else {
          record.state = "pending";
          record.startedAt = undefined;
        }
        recovered.push(record.definition.id);
      } else if (record.state === "waiting_for_external_action") {
        await this.reconcileNode(state, record, "poll");
        recovered.push(record.definition.id);
      }
    }
    if (recovered.length > 0) this.record(state, "run_recovered", undefined, { nodes: recovered });
  }

  private async prepareNodes(order: string[], state: WorkflowRunState): Promise<void> {
    for (const nodeId of order) {
      const record = state.nodes[nodeId];
      if (record.state !== "pending") continue;
      const dependencies = record.definition.dependencies.map((id) => state.nodes[id]);
      if (
        dependencies.some(
          (dependency) =>
            dependency.state === "failed_terminal" ||
            dependency.state === "skipped" ||
            dependency.state === "cancelled",
        )
      ) {
        record.state = "skipped";
        record.skipReason = "a dependency did not complete successfully";
        record.finishedAt = this.timestamp();
        this.record(state, "node_skipped", nodeId, { reason: record.skipReason });
        continue;
      }
      if (!dependencies.every(successfulDependency)) continue;

      try {
        const shouldRun = await this.evaluateCondition(state, record.definition);
        if (!shouldRun) {
          record.state = "skipped";
          record.skipReason = "condition evaluated to false";
          record.finishedAt = this.timestamp();
          this.record(state, "node_skipped", nodeId, { reason: record.skipReason });
          continue;
        }
      } catch (error) {
        this.markTerminalFailure(state, record, this.normalizeError(error, "CONDITION_FAILED"));
        continue;
      }

      record.state = "ready";
      this.record(state, "node_ready", nodeId);
    }
  }

  private selectReadyBatch(order: string[], state: WorkflowRunState): string[] {
    const selected: string[] = [];
    const groups = new Set<string>();
    for (const nodeId of order) {
      const record = state.nodes[nodeId];
      if (record.state !== "ready") continue;
      if (groups.has(record.definition.concurrencyGroup)) continue;
      selected.push(nodeId);
      groups.add(record.definition.concurrencyGroup);
      if (selected.length >= state.maxParallel) break;
    }
    return selected;
  }

  private async executeNode(state: WorkflowRunState, nodeId: string): Promise<void> {
    const record = state.nodes[nodeId];
    const node = record.definition;

    const verified = state.verifiedEffects[node.idempotencyKey];
    if (verified) {
      record.state = "succeeded";
      record.output = verified.output;
      record.evidenceArtifact = verified.evidenceArtifact;
      record.effectVerified = true;
      record.finishedAt = verified.verifiedAt;
      this.record(state, "node_reused", nodeId, { idempotencyKey: node.idempotencyKey });
      return;
    }

    const cacheKey = node.cache.key ?? node.idempotencyKey;
    if (node.cache.mode !== "none" && Object.hasOwn(state.cache, cacheKey)) {
      record.state = "succeeded";
      record.output = state.cache[cacheKey];
      record.finishedAt = this.timestamp();
      this.record(state, "node_reused", nodeId, { cacheKey });
      return;
    }

    if (node.kind === "human_approval" || node.transport === "human_approval") {
      record.state = "waiting_for_approval";
      this.record(state, "node_waiting", nodeId, {
        state: record.state,
        requiredAuthorization: node.authorization,
      });
      return;
    }
    if (node.kind === "manual_action" || node.transport === "manual") {
      record.state = "waiting_for_manual_action";
      this.record(state, "node_waiting", nodeId, {
        state: record.state,
        completion: node.completion.description,
      });
      return;
    }

    const loopLimit = node.loop?.maxIterations ?? 1;
    if ((record.loopIterations ?? 0) >= loopLimit) {
      this.markTerminalFailure(state, record, {
        code: "LOOP_LIMIT_EXCEEDED",
        message: `Node "${node.id}" exceeded its ${loopLimit}-iteration loop limit.`,
        retryable: false,
      });
      return;
    }
    if ((record.iterationAttempts ?? 0) >= node.retry.maxAttempts) {
      this.markTerminalFailure(state, record, {
        code: "RETRY_LIMIT_EXCEEDED",
        message: `Node "${node.id}" exhausted ${node.retry.maxAttempts} attempts.`,
        retryable: false,
      });
      return;
    }

    const budgetError = this.budgetError(state, node);
    if (budgetError) {
      this.markTerminalFailure(state, record, budgetError);
      return;
    }

    record.attempts += 1;
    record.iterationAttempts = (record.iterationAttempts ?? 0) + 1;
    record.state = "running";
    record.startedAt = this.timestamp();
    record.error = undefined;
    record.waiting = undefined;
    const executionRevision = record.revision ?? 0;
    this.record(state, "node_started", nodeId, {
      attempt: record.attempts,
      iterationAttempt: record.iterationAttempts,
      loopIteration: (record.loopIterations ?? 0) + 1,
      revision: executionRevision,
    });

    try {
      const costBefore = record.cost;
      const result = await this.invokeHandler(state, record);
      if (
        runWasCancelled(state) ||
        nodeWasSkipped(record) ||
        record.state !== "running" ||
        (record.revision ?? 0) !== executionRevision
      ) {
        return;
      }
      if (record.operation) {
        record.operation.phase = "handler_completed";
        record.operation.updatedAt = this.timestamp();
        this.record(state, "node_operation_checkpointed", nodeId, {
          attempt: record.attempts,
          phase: record.operation.phase,
        });
      }
      if (result.wait) {
        this.markWaiting(state, record, result.wait);
        return;
      }

      await this.validateResult(state, node, result);
      if (this.isEffectful(node) && result.effectVerified !== true) {
        throw new WorkflowExecutionError(
          "EFFECT_UNVERIFIED",
          `Node "${node.id}" reported an effect without verified read-back evidence.`,
        );
      }
      if (node.evidence.required && !result.evidenceArtifact) {
        throw new WorkflowExecutionError(
          "EVIDENCE_MISSING",
          `Node "${node.id}" requires an evidence artifact before completion.`,
        );
      }

      record.output =
        result.output === undefined
          ? undefined
          : sanitizeJson(result.output, this.bindings.secrets);
      record.effectVerified = result.effectVerified ?? false;
      record.evidenceArtifact = result.evidenceArtifact;
      record.finishedAt = this.timestamp();

      if (record.effectVerified) {
        state.verifiedEffects[node.idempotencyKey] = {
          nodeId,
          output: record.output,
          evidenceArtifact: record.evidenceArtifact,
          verifiedAt: record.finishedAt,
        };
        if (record.operation) {
          record.operation.phase = "verified";
          record.operation.updatedAt = record.finishedAt;
        }
        // Persist verified read-back before accounting or later validation can
        // fail. Resume will then reuse the effect instead of applying it again.
        this.record(state, "node_operation_checkpointed", nodeId, {
          attempt: record.attempts,
          phase: "verified",
          evidenceArtifact: record.evidenceArtifact ?? null,
        });
      }

      for (const charge of result.costs ?? []) this.recordCost(state, record, charge);
      if (result.cost !== undefined) {
        this.recordCost(state, record, {
          kind: node.kind === "model" ? "model" : node.kind === "provider" ? "provider" : "code",
          category: node.budgetCategory,
          amount: result.cost,
          unit: node.cost.unit,
        });
      } else if ((result.costs?.length ?? 0) === 0 && record.cost === costBefore) {
        this.recordCost(state, record, {
          kind: node.kind === "model" ? "model" : node.kind === "provider" ? "provider" : "code",
          category: node.budgetCategory,
          amount: node.cost.amount,
          unit: node.cost.unit,
        });
      }

      record.loopIterations = (record.loopIterations ?? 0) + 1;
      record.iterationAttempts = 0;
      if (result.continueLoop) {
        if (!node.loop) {
          this.markTerminalFailure(state, record, {
            code: "LOOP_NOT_DECLARED",
            message: `Node "${node.id}" requested another iteration without a loop policy.`,
            retryable: false,
          });
          return;
        }
        if (record.loopIterations >= node.loop.maxIterations) {
          this.markTerminalFailure(state, record, {
            code: "LOOP_LIMIT_EXCEEDED",
            message: `Node "${node.id}" requested iteration ${record.loopIterations + 1}, beyond its ${node.loop.maxIterations}-iteration limit.`,
            retryable: false,
          });
          return;
        }
        record.state = "ready";
        record.startedAt = undefined;
        record.finishedAt = undefined;
        record.operation = undefined;
        this.record(state, "node_ready", nodeId, {
          loopIteration: record.loopIterations + 1,
        });
        return;
      }

      if (node.cache.mode !== "none" && record.output !== undefined) {
        state.cache[cacheKey] = record.output;
      }
      record.state = "succeeded";
      this.record(state, "node_succeeded", nodeId, {
        attempt: record.attempts,
        loopIterations: record.loopIterations,
        effectVerified: record.effectVerified,
        evidenceArtifact: record.evidenceArtifact ?? null,
      });
    } catch (error) {
      if (
        runWasCancelled(state) ||
        nodeWasSkipped(record) ||
        (record.revision ?? 0) !== executionRevision
      ) {
        return;
      }
      const normalized = this.normalizeError(error);
      if (this.errorConfirmsNoWrite(normalized)) {
        this.checkpointNoWrite(state, record, "handler reported a definitive no-write outcome");
      }
      if (
        normalized.code === "authorization_checkpoint_required" &&
        this.checkpointRequirements(normalized.details)
      ) {
        record.attempts = Math.max(0, record.attempts - 1);
        record.iterationAttempts = Math.max(0, (record.iterationAttempts ?? 1) - 1);
        record.state = "waiting_for_approval";
        record.startedAt = undefined;
        record.finishedAt = undefined;
        record.error = normalized;
        this.record(state, "node_waiting", nodeId, {
          state: record.state,
          checkpoint: normalized.details,
        });
        return;
      }
      if (this.isAuthorizationError(normalized)) {
        this.markWaiting(state, record, {
          kind: "auth",
          reason: normalized.message,
        });
        record.error = normalized;
        return;
      }
      if (this.isExternalWaitError(normalized)) {
        this.markWaiting(state, record, {
          kind: "external",
          reason: normalized.message,
        });
        record.error = normalized;
        return;
      }

      const permittedCode =
        node.retry.retryableCodes.length === 0 ||
        node.retry.retryableCodes.includes(normalized.code);
      const canRetry =
        normalized.retryable &&
        permittedCode &&
        (record.iterationAttempts ?? 0) < node.retry.maxAttempts;
      if (canRetry) {
        record.state = "failed_retryable";
        record.error = normalized;
        this.record(state, "node_retryable_failure", nodeId, {
          attempt: record.attempts,
          error: normalized,
        });
        if (this.requiresOutcomeReconciliation(record)) {
          await this.reconcileNode(state, record, "retry");
          if (currentNodeState(record) !== "pending") return;
        }
        const delay = this.backoffDelay(node, record.iterationAttempts ?? 1);
        if (delay > 0) await this.sleep(delay);
        if (state.status !== "running") return;
        record.state = "ready";
        this.record(state, "node_ready", nodeId, { retry: (record.iterationAttempts ?? 0) + 1 });
        return;
      }

      if (this.requiresOutcomeReconciliation(record)) {
        await this.reconcileNode(state, record, "retry");
        if (
          currentNodeState(record) === "succeeded" ||
          currentNodeState(record) === "waiting_for_external_action" ||
          currentNodeState(record) === "waiting_for_auth" ||
          currentNodeState(record) === "pending"
        )
          return;
      }
      this.markTerminalFailure(state, record, normalized);
    }
  }

  private async invokeHandler(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
  ): Promise<WorkflowHandlerResult> {
    const node = record.definition;
    const handlerName = node.handler ?? node.transport;
    const handler = this.bindings.handlers[handlerName];
    if (!handler) {
      throw new WorkflowExecutionError(
        "HANDLER_NOT_REGISTERED",
        `No handler is registered for "${handlerName}". Register it in WorkflowBindings.handlers and resume the run.`,
      );
    }

    const dependencyOutputs = this.dependencyOutputs(state, node);
    await this.runValidator(
      node.input.validator,
      {
        runId: state.runId,
        node,
        input: node.input.value,
        dependencyOutputs,
      },
      "INPUT_VALIDATION_FAILED",
    );

    const workspacePath = await this.ensureWorkspace(state, record);
    if (this.isEffectful(node)) {
      const timestamp = this.timestamp();
      const previousOperation = record.operation;
      const providerCheckpoint = isProviderPlanCheckpoint(previousOperation?.checkpoint)
        ? previousOperation?.checkpoint
        : undefined;
      record.operation = {
        attempt: record.attempts,
        idempotencyKey: node.idempotencyKey,
        phase: previousOperation?.phase === "partially_applied" ? "partially_applied" : "prepared",
        preparedAt: timestamp,
        updatedAt: timestamp,
        reconcileAttempts: 0,
        ...(providerCheckpoint === undefined ? {} : { checkpoint: providerCheckpoint }),
      };
      this.record(state, "node_operation_prepared", node.id, {
        attempt: record.attempts,
        idempotencyKey: node.idempotencyKey,
      });
    }

    const controller = new AbortController();
    const controllerKey = `${state.runId}:${node.id}`;
    this.activeControllers.set(controllerKey, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const context: WorkflowHandlerContext = {
      runId: state.runId,
      node,
      attempt: record.attempts,
      input: node.input.value,
      dependencyOutputs,
      idempotencyKey: node.idempotencyKey,
      loopIteration: (record.loopIterations ?? 0) + 1,
      workspacePath,
      signal: controller.signal,
      trace: (details) => this.record(state, "node_trace", node.id, details),
      checkpointOperation: (details) => {
        if (!record.operation) {
          throw new WorkflowExecutionError(
            "OPERATION_NOT_PREPARED",
            `Node "${node.id}" cannot checkpoint an operation target because it is not effectful.`,
          );
        }
        const checkpoint = sanitizeJson(details, this.bindings.secrets);
        if (
          isProviderPlanCheckpoint(record.operation.checkpoint) &&
          JSON.stringify(record.operation.checkpoint) !== JSON.stringify(checkpoint)
        ) {
          throw new WorkflowExecutionError(
            "OPERATION_CHECKPOINT_MISMATCH",
            `Node "${node.id}" cannot replace its immutable provider-plan checkpoint on retry.`,
          );
        }
        record.operation.checkpoint = checkpoint;
        record.operation.updatedAt = this.timestamp();
        this.record(state, "node_operation_checkpointed", node.id, {
          attempt: record.attempts,
          phase: record.operation.phase,
          checkpoint: record.operation.checkpoint,
        });
      },
      checkpointExternalEffect: (details) => {
        if (!record.operation) {
          throw new WorkflowExecutionError(
            "OPERATION_NOT_PREPARED",
            `Node "${node.id}" cannot checkpoint an external effect because it is not effectful.`,
          );
        }
        record.operation.phase = "external_write_acknowledged";
        record.operation.updatedAt = this.timestamp();
        record.operation.checkpoint =
          details === undefined ? undefined : sanitizeJson(details, this.bindings.secrets);
        this.record(state, "node_operation_checkpointed", node.id, {
          attempt: record.attempts,
          phase: record.operation.phase,
          checkpoint: record.operation.checkpoint ?? null,
        });
      },
      recordCost: (charge) => this.recordCost(state, record, charge),
      claimAuthorizationCheckpoints: (requirements) =>
        this.claimAuthorizationCheckpoints(state, record, requirements),
      reserveAuthorizationSpend: (reservation) =>
        this.reserveAuthorizationSpend(state, record, reservation),
    };

    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new WorkflowExecutionError(
              "TIMEOUT",
              `Node "${node.id}" exceeded its ${node.timeoutMs}ms timeout.`,
              { retryable: true },
            ),
          );
          controller.abort("timeout");
        }, node.timeoutMs);
      });
      return await Promise.race([Promise.resolve(handler(context)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.activeControllers.delete(controllerKey);
    }
  }

  private async validateResult(
    state: WorkflowRunState,
    node: WorkflowNodeDefinition,
    result: WorkflowHandlerResult,
  ): Promise<void> {
    const context: WorkflowValidationContext = {
      runId: state.runId,
      node,
      input: node.input.value,
      output: result.output,
      dependencyOutputs: this.dependencyOutputs(state, node),
    };
    await this.runValidator(node.output.validator, context, "OUTPUT_VALIDATION_FAILED");
    await this.runValidator(node.completion.validator, context, "COMPLETION_CRITERION_FAILED");
  }

  private async runValidator(
    name: string | undefined,
    context: WorkflowValidationContext,
    errorCode: string,
  ): Promise<void> {
    if (!name) return;
    const validator = this.bindings.validators[name];
    if (!validator) {
      throw new WorkflowExecutionError(
        "VALIDATOR_NOT_REGISTERED",
        `Validator "${name}" is not registered. Register it and resume the run.`,
      );
    }
    const result = normalizedValidatorResult(await validator(context));
    if (!result.ok) {
      throw new WorkflowExecutionError(
        errorCode,
        result.message ?? `Validator "${name}" rejected node "${context.node.id}".`,
      );
    }
  }

  private async evaluateCondition(
    state: WorkflowRunState,
    node: WorkflowNodeDefinition,
  ): Promise<boolean> {
    if (node.condition.kind !== "handler") return true;
    const name = node.condition.handler!;
    const handler = this.bindings.conditions[name];
    if (!handler) {
      throw new WorkflowExecutionError(
        "CONDITION_NOT_REGISTERED",
        `Condition "${name}" is not registered. Register it and resume the run.`,
      );
    }
    return handler({
      runId: state.runId,
      node,
      input: node.input.value,
      dependencyOutputs: this.dependencyOutputs(state, node),
    });
  }

  private dependencyOutputs(
    state: WorkflowRunState,
    node: WorkflowNodeDefinition,
  ): Record<string, JsonValue | undefined> {
    return Object.fromEntries(
      node.dependencies.map((dependency) => [dependency, state.nodes[dependency].output]),
    );
  }

  private isEffectful(node: WorkflowNodeDefinition): boolean {
    return node.effect !== "none" && node.effect !== "read";
  }

  private requiresOutcomeReconciliation(record: WorkflowNodeRecord): boolean {
    const phase = record.operation?.phase;
    return (
      this.isEffectful(record.definition) &&
      phase !== undefined &&
      !["not_applied", "verified", "cancelled"].includes(phase)
    );
  }

  private checkpointNoWrite(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    reason: string,
  ): void {
    if (!record.operation) return;
    const preservesEarlierWrite = record.operation.phase === "partially_applied";
    if (!preservesEarlierWrite) record.operation.phase = "not_applied";
    record.operation.updatedAt = this.timestamp();
    if (!isProviderPlanCheckpoint(record.operation.checkpoint)) {
      record.operation.checkpoint = { reason };
    }
    this.record(state, "node_operation_checkpointed", record.definition.id, {
      attempt: record.attempts,
      phase: record.operation.phase,
      reason,
    });
  }

  private isAuthorizationError(error: WorkflowNodeError): boolean {
    if (
      [
        "AUTH_REQUIRED",
        "AUTH_EXPIRED",
        "AUTHORIZATION_EXPIRED",
        "CREDENTIAL_EXPIRED",
        "CREDENTIAL_UNAVAILABLE",
        "PROVIDER_RECONCILIATION_AUTHORIZATION_REJECTED",
      ].includes(error.code.toUpperCase())
    ) {
      return true;
    }
    if (error.code.toUpperCase() !== "AUTHORIZATION_REJECTED") return false;
    const details = error.details;
    return (
      details !== null &&
      details !== undefined &&
      !Array.isArray(details) &&
      typeof details === "object" &&
      ["envelope_expired", "credential_expired", "credential_not_found"].includes(
        String(details.reason),
      )
    );
  }

  private isExternalWaitError(error: WorkflowNodeError): boolean {
    return [
      "EXTERNAL_ACTION_REQUIRED",
      "EXTERNAL_PENDING",
      "PROVIDER_PENDING",
      "POLL_PENDING",
    ].includes(error.code.toUpperCase());
  }

  private errorConfirmsNoWrite(error: WorkflowNodeError): boolean {
    if (
      [
        "provider_plan_factory_failed",
        "provider_plan_failed",
        "provider_plan_only",
        "provider_plan_empty",
      ].includes(error.code.toLowerCase())
    ) {
      return true;
    }
    const details = error.details;
    if (!details || Array.isArray(details) || typeof details !== "object") return false;
    if (details.effectOutcome === "confirmed_no_write") return true;
    if (!Array.isArray(details.outcomes) || details.outcomes.length === 0) return false;
    return details.outcomes.every((outcome) => {
      if (outcome === null || Array.isArray(outcome) || typeof outcome !== "object") {
        return false;
      }
      if (outcome.effectOutcome === "confirmed_no_write") return true;
      if (outcome.status === "skipped") return true;

      // Older provider transports did not emit effectOutcome. These response
      // classifications are provider-side rejections that happen before a
      // write, so retaining their established no-write meaning is safe. All
      // network, outage, timeout, conflict, and unknown classifications still
      // fail closed into reconciliation rather than being replayed.
      return ["retryable_rate_limit", "terminal_auth", "terminal_validation"].includes(
        String(outcome.providerCode),
      );
    });
  }

  private markWaiting(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    wait: {
      kind: "auth" | "external" | "approval";
      reason: string;
      pollAfterMs?: number;
      externalReference?: string;
    },
  ): void {
    if (!wait.reason.trim()) {
      throw new WorkflowExecutionError("WAIT_REASON_REQUIRED", "A durable wait requires a reason.");
    }
    if (
      wait.pollAfterMs !== undefined &&
      (!Number.isInteger(wait.pollAfterMs) || wait.pollAfterMs < 0)
    ) {
      throw new WorkflowExecutionError(
        "WAIT_POLL_INVALID",
        "A durable wait pollAfterMs must be a non-negative integer.",
      );
    }
    record.state =
      wait.kind === "auth"
        ? "waiting_for_auth"
        : wait.kind === "external"
          ? "waiting_for_external_action"
          : "waiting_for_approval";
    record.waiting = {
      kind: wait.kind,
      reason: sanitizeJson(wait.reason, this.bindings.secrets) as string,
      requestedAt: this.timestamp(),
      pollAfterMs: wait.pollAfterMs,
      externalReference:
        wait.externalReference === undefined
          ? undefined
          : (sanitizeJson(wait.externalReference, this.bindings.secrets) as string),
    };
    record.finishedAt = undefined;
    if (wait.kind === "external" && record.operation) {
      record.operation.phase = "pending_external";
      record.operation.updatedAt = this.timestamp();
      record.operation.externalReference = record.waiting.externalReference;
    }
    this.record(state, "node_waiting", record.definition.id, {
      state: record.state,
      reason: record.waiting.reason,
      pollAfterMs: record.waiting.pollAfterMs ?? null,
      externalReference: record.waiting.externalReference ?? null,
    });
  }

  private async ensureWorkspace(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
  ): Promise<string | undefined> {
    const mode = record.definition.isolation;
    if (mode === "none") return undefined;
    if (record.workspace?.attempt === record.attempts && record.workspace.mode === mode) {
      return record.workspace.path;
    }
    const context = {
      runId: state.runId,
      node: record.definition,
      attempt: record.attempts,
      mode,
    } as const;
    const factory = this.bindings.workspaceFactory;
    const path = factory
      ? await factory(context)
      : this.store.createWorkspace
        ? this.store.createWorkspace(context)
        : undefined;
    if (!path?.trim()) {
      throw new WorkflowExecutionError(
        "WORKSPACE_FACTORY_NOT_REGISTERED",
        `Node "${record.definition.id}" requires ${mode} isolation, but the store and bindings provide no workspace factory.`,
      );
    }
    record.workspace = {
      mode,
      path: sanitizeJson(path, this.bindings.secrets) as string,
      attempt: record.attempts,
      createdAt: this.timestamp(),
    };
    this.record(state, "node_trace", record.definition.id, {
      workspace: { mode, path: record.workspace.path, attempt: record.attempts },
    });
    return record.workspace.path;
  }

  private recordCost(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    charge: {
      kind: "code" | "model" | "tool" | "provider";
      category: string;
      amount: number;
      unit: string;
      inputTokens?: number;
      outputTokens?: number;
      tool?: string;
      model?: string;
      metadata?: Record<string, JsonValue>;
    },
  ): void {
    if (
      !charge.category.trim() ||
      !charge.unit.trim() ||
      !Number.isFinite(charge.amount) ||
      charge.amount < 0 ||
      (charge.inputTokens !== undefined &&
        (!Number.isInteger(charge.inputTokens) || charge.inputTokens < 0)) ||
      (charge.outputTokens !== undefined &&
        (!Number.isInteger(charge.outputTokens) || charge.outputTokens < 0))
    ) {
      throw new WorkflowExecutionError(
        "COST_RECORD_INVALID",
        `Node "${record.definition.id}" produced an invalid cost record.`,
      );
    }
    if (charge.amount === 0 && !charge.inputTokens && !charge.outputTokens) return;
    state.costs ??= [];
    record.costEntries ??= [];
    const entryId = `${record.definition.id}:${record.attempts}:${record.loopIterations ?? 0}:${state.costs.length + 1}`;
    const cost: WorkflowCostRecord = {
      kind: charge.kind,
      category: charge.category,
      amount: charge.amount,
      unit: charge.unit,
      entryId,
      nodeId: record.definition.id,
      attempt: record.attempts,
      loopIteration: (record.loopIterations ?? 0) + 1,
      recordedAt: this.timestamp(),
    };
    if (charge.inputTokens !== undefined) cost.inputTokens = charge.inputTokens;
    if (charge.outputTokens !== undefined) cost.outputTokens = charge.outputTokens;
    if (charge.tool !== undefined) cost.tool = charge.tool;
    if (charge.model !== undefined) cost.model = charge.model;
    if (charge.metadata !== undefined) {
      cost.metadata = sanitizeJson(charge.metadata, this.bindings.secrets) as Record<
        string,
        JsonValue
      >;
    }
    state.costs.push(cost);
    record.costEntries.push(entryId);
    record.cost += charge.amount;
    state.budget.consumed[charge.category] =
      (state.budget.consumed[charge.category] ?? 0) + charge.amount;
    this.record(state, "node_cost_recorded", record.definition.id, cost);
    const limit = state.budget.limits[charge.category];
    if (limit !== undefined && state.budget.consumed[charge.category] > limit) {
      throw new WorkflowExecutionError(
        "BUDGET_EXCEEDED_AFTER_EXECUTION",
        `Node "${record.definition.id}" recorded ${charge.amount} ${charge.unit}; category "${charge.category}" is now ${state.budget.consumed[charge.category]}/${limit}.`,
      );
    }
  }

  private async reconcileNode(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    reason: "restart" | "retry" | "poll" | "cancel",
  ): Promise<void> {
    const node = record.definition;
    const verified = state.verifiedEffects[node.idempotencyKey];
    if (verified) {
      record.state = "succeeded";
      record.output = verified.output;
      record.evidenceArtifact = verified.evidenceArtifact;
      record.effectVerified = true;
      record.error = undefined;
      record.waiting = undefined;
      record.finishedAt = verified.verifiedAt;
      if (record.operation) {
        record.operation.phase = "verified";
        record.operation.updatedAt = verified.verifiedAt;
      }
      this.record(state, "node_reconciled", node.id, { status: "verified", source: "ledger" });
      return;
    }
    if (!record.operation) {
      if (reason !== "cancel") {
        record.state = "pending";
        record.startedAt = undefined;
        record.iterationAttempts = Math.max(0, (record.iterationAttempts ?? 0) - 1);
      }
      return;
    }

    const policy = node.reconciliation;
    const handlerName = policy?.handler ?? node.handler ?? node.transport;
    const reconciler = this.bindings.reconcilers[handlerName];
    if (!reconciler) {
      record.operation.phase = "unknown";
      record.operation.updatedAt = this.timestamp();
      record.error = {
        code: "UNKNOWN_OUTCOME_RECONCILIATION_REQUIRED",
        message: `Node "${node.id}" may have produced an effect; register reconciler "${handlerName}" before retrying.`,
        retryable: false,
      };
      if (reason !== "cancel") {
        this.markWaiting(state, record, {
          kind: "external",
          reason: record.error.message,
          externalReference: record.operation.externalReference,
        });
      } else {
        this.record(state, "node_reconciled", node.id, {
          status: "unknown",
          reason: "reconciler_not_registered",
        });
      }
      return;
    }

    const maximum = policy?.maxPollAttempts ?? 1;
    if (record.operation.reconcileAttempts >= maximum) {
      this.markTerminalFailure(state, record, {
        code: "RECONCILIATION_LIMIT_EXCEEDED",
        message: `Node "${node.id}" exceeded ${maximum} reconciliation attempts without a verified outcome.`,
        retryable: false,
      });
      return;
    }

    record.operation.reconcileAttempts += 1;
    record.operation.lastReconciledAt = this.timestamp();
    record.operation.updatedAt = record.operation.lastReconciledAt;
    this.record(state, "node_reconciliation_started", node.id, {
      reason,
      attempt: record.operation.reconcileAttempts,
      maximum,
    });

    const controller = new AbortController();
    const controllerKey = `${state.runId}:${node.id}:reconcile`;
    this.activeControllers.set(controllerKey, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: WorkflowReconciliationResult;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort("reconciliation timeout");
          reject(
            new WorkflowExecutionError(
              "RECONCILIATION_TIMEOUT",
              `Reconciliation for node "${node.id}" exceeded ${node.timeoutMs}ms.`,
              { retryable: true },
            ),
          );
        }, node.timeoutMs);
      });
      result = await Promise.race([
        Promise.resolve(
          reconciler({
            runId: state.runId,
            node,
            attempt: record.attempts,
            input: node.input.value,
            dependencyOutputs: this.dependencyOutputs(state, node),
            idempotencyKey: node.idempotencyKey,
            operation: structuredClone(record.operation),
            reason,
            signal: controller.signal,
            trace: (details) => this.record(state, "node_trace", node.id, details),
          }),
        ),
        timeout,
      ]);
    } catch (error) {
      const normalized = this.normalizeError(error, "RECONCILIATION_FAILED");
      if (record.operation.reconcileAttempts >= maximum) {
        record.operation.phase = "unknown";
        record.operation.updatedAt = this.timestamp();
        this.markTerminalFailure(state, record, { ...normalized, retryable: false });
      } else if (reason !== "cancel") {
        record.error = normalized;
        this.markWaiting(state, record, {
          kind: "external",
          reason: normalized.message,
          pollAfterMs: policy?.pollIntervalMs,
          externalReference: record.operation.externalReference,
        });
      }
      return;
    } finally {
      if (timer) clearTimeout(timer);
      this.activeControllers.delete(controllerKey);
    }

    if (!this.isReconciliationResult(result)) {
      record.operation.phase = "unknown";
      record.operation.updatedAt = this.timestamp();
      this.markTerminalFailure(state, record, {
        code: "RECONCILIATION_RESULT_INVALID",
        message: `Reconciler "${handlerName}" returned an invalid result for node "${node.id}".`,
        retryable: false,
      });
      return;
    }

    record.operation.lastReconciledAt = this.timestamp();
    record.operation.updatedAt = record.operation.lastReconciledAt;
    if (result.status === "verified") {
      if (node.evidence.required && !result.evidenceArtifact) {
        this.markTerminalFailure(state, record, {
          code: "RECONCILIATION_EVIDENCE_MISSING",
          message: `Reconciler for node "${node.id}" verified an effect without required evidence.`,
          retryable: false,
        });
        return;
      }
      record.output =
        result.output === undefined
          ? undefined
          : sanitizeJson(result.output, this.bindings.secrets);
      record.effectVerified = true;
      record.evidenceArtifact = result.evidenceArtifact;
      record.error = undefined;
      record.waiting = undefined;
      record.state = "succeeded";
      record.finishedAt = this.timestamp();
      record.operation.phase = "verified";
      record.operation.externalReference =
        result.externalReference === undefined
          ? undefined
          : (sanitizeJson(result.externalReference, this.bindings.secrets) as string);
      state.verifiedEffects[node.idempotencyKey] = {
        nodeId: node.id,
        output: record.output,
        evidenceArtifact: record.evidenceArtifact,
        verifiedAt: record.finishedAt,
      };
      this.record(state, "node_reconciled", node.id, {
        status: "verified",
        evidenceArtifact: record.evidenceArtifact ?? null,
      });
      try {
        await this.validateResult(state, node, {
          output: result.output,
          effectVerified: true,
          evidenceArtifact: result.evidenceArtifact,
        });
      } catch (error) {
        this.markTerminalFailure(
          state,
          record,
          this.normalizeError(error, "RECONCILIATION_RESULT_INVALID"),
        );
        return;
      }
      try {
        for (const charge of result.costs ?? []) this.recordCost(state, record, charge);
        if (result.cost !== undefined) {
          this.recordCost(state, record, {
            kind: node.kind === "model" ? "model" : "provider",
            category: node.budgetCategory,
            amount: result.cost,
            unit: node.cost.unit,
          });
        }
      } catch (error) {
        this.markTerminalFailure(
          state,
          record,
          this.normalizeError(error, "RECONCILIATION_COST_INVALID"),
        );
      }
      return;
    }
    if (result.status === "not_applied") {
      record.operation.phase = "not_applied";
      record.error = undefined;
      record.waiting = undefined;
      if (reason === "cancel") {
        record.state = "cancelled";
      } else {
        record.state = "pending";
        record.startedAt = undefined;
        record.finishedAt = undefined;
        if (reason === "restart") {
          record.iterationAttempts = Math.max(0, (record.iterationAttempts ?? 0) - 1);
        }
      }
      this.record(state, "node_reconciled", node.id, { status: "not_applied" });
      return;
    }
    if (result.status === "partially_applied") {
      record.operation.phase = "partially_applied";
      record.operation.externalReference =
        result.externalReference === undefined
          ? undefined
          : (sanitizeJson(result.externalReference, this.bindings.secrets) as string);
      record.error = undefined;
      record.waiting = undefined;
      record.startedAt = undefined;
      record.finishedAt = undefined;
      if (reason === "cancel") {
        record.state = "cancelled";
        record.error = {
          code: "CANCELLED_WITH_PARTIAL_EFFECT",
          message: sanitizeJson(
            result.message ?? "The run was cancelled after only part of the provider plan applied.",
            this.bindings.secrets,
          ) as string,
          retryable: false,
        };
      } else {
        record.state = "pending";
      }
      this.record(state, "node_reconciled", node.id, {
        status: "partially_applied",
        cancelled: reason === "cancel",
      });
      return;
    }
    if (result.status === "failed") {
      const effectState = result.effectState ?? "unknown";
      record.operation.phase =
        effectState === "confirmed_no_write"
          ? "not_applied"
          : effectState === "partial_write"
            ? "partially_applied"
            : effectState === "confirmed_write"
              ? "external_write_acknowledged"
              : "unknown";
      const error: WorkflowNodeError = {
        code: result.code,
        message: sanitizeJson(result.message, this.bindings.secrets) as string,
        retryable: result.retryable ?? false,
      };
      if (reason === "cancel") {
        record.state = "cancelled";
        record.error = error;
        record.waiting = undefined;
        this.record(state, "node_reconciled", node.id, {
          status: "failed",
          effectState,
          cancelled: true,
        });
        return;
      }
      if (this.isAuthorizationError(error)) {
        record.operation.reconcileAttempts = Math.max(0, record.operation.reconcileAttempts - 1);
        this.markWaiting(state, record, { kind: "auth", reason: error.message });
        record.error = error;
        this.record(state, "node_reconciled", node.id, {
          status: "failed_authorization",
          effectState,
        });
        return;
      }
      if (
        effectState === "confirmed_no_write" &&
        error.retryable &&
        (record.iterationAttempts ?? 0) < node.retry.maxAttempts
      ) {
        record.state = "pending";
        record.error = error;
        record.waiting = undefined;
        this.record(state, "node_reconciled", node.id, { status: "failed_retryable", error });
      } else {
        this.markTerminalFailure(state, record, error);
      }
      return;
    }

    record.operation.phase = result.status === "pending" ? "pending_external" : "unknown";
    record.operation.externalReference = result.externalReference;
    const exhausted = record.operation.reconcileAttempts >= maximum;
    if (exhausted) {
      this.markTerminalFailure(state, record, {
        code:
          result.status === "pending"
            ? "RECONCILIATION_POLL_EXHAUSTED"
            : "UNKNOWN_OUTCOME_UNRESOLVED",
        message:
          result.status === "pending"
            ? `Node "${node.id}" remained pending after ${maximum} reconciliation attempts.`
            : (sanitizeJson(
                result.message ?? `Node "${node.id}" has an unresolved external outcome.`,
                this.bindings.secrets,
              ) as string),
        retryable: false,
      });
      return;
    }
    if (reason === "cancel") {
      record.state = "cancelled";
      record.error = {
        code: "CANCELLED_WITH_UNRESOLVED_OUTCOME",
        message:
          result.status === "unknown"
            ? (sanitizeJson(
                result.message ?? "External outcome remains unknown after cancellation.",
                this.bindings.secrets,
              ) as string)
            : "External operation is still pending after cancellation.",
        retryable: false,
      };
      this.record(state, "node_reconciled", node.id, {
        status: result.status,
        cancelled: true,
      });
      return;
    }
    this.markWaiting(state, record, {
      kind: "external",
      reason:
        result.status === "unknown"
          ? (sanitizeJson(
              result.message ?? `Node "${node.id}" has an unknown external outcome.`,
              this.bindings.secrets,
            ) as string)
          : `Node "${node.id}" is still pending provider read-back.`,
      pollAfterMs:
        result.status === "pending"
          ? (result.pollAfterMs ?? policy?.pollIntervalMs)
          : policy?.pollIntervalMs,
      externalReference: result.externalReference,
    });
    this.record(state, "node_reconciled", node.id, { status: result.status });
  }

  private affectedDescendants(state: WorkflowRunState, roots: readonly string[]): Set<string> {
    const affected = new Set(roots);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of Object.values(state.nodes)) {
        if (affected.has(record.definition.id)) continue;
        if (record.definition.dependencies.some((dependency) => affected.has(dependency))) {
          affected.add(record.definition.id);
          changed = true;
        }
      }
    }
    return affected;
  }

  private isReconciliationResult(value: unknown): value is WorkflowReconciliationResult {
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    const hasOnly = (...allowed: string[]) =>
      Object.keys(candidate).every((key) => allowed.includes(key));
    if (candidate.status === "verified") {
      return (
        hasOnly("status", "output", "evidenceArtifact", "cost", "costs", "externalReference") &&
        (candidate.externalReference === undefined ||
          typeof candidate.externalReference === "string") &&
        (candidate.evidenceArtifact === undefined ||
          typeof candidate.evidenceArtifact === "string") &&
        (candidate.cost === undefined ||
          (typeof candidate.cost === "number" && Number.isFinite(candidate.cost))) &&
        (candidate.costs === undefined || Array.isArray(candidate.costs))
      );
    }
    if (candidate.status === "not_applied") return hasOnly("status");
    if (candidate.status === "partially_applied") {
      return (
        hasOnly("status", "message", "externalReference") &&
        (candidate.message === undefined || typeof candidate.message === "string") &&
        (candidate.externalReference === undefined ||
          typeof candidate.externalReference === "string")
      );
    }
    if (candidate.status === "pending") {
      return (
        hasOnly("status", "pollAfterMs", "externalReference") &&
        (candidate.pollAfterMs === undefined ||
          (Number.isInteger(candidate.pollAfterMs) && Number(candidate.pollAfterMs) >= 0)) &&
        (candidate.externalReference === undefined ||
          typeof candidate.externalReference === "string")
      );
    }
    if (candidate.status === "unknown") {
      return (
        hasOnly("status", "message", "externalReference") &&
        (candidate.message === undefined || typeof candidate.message === "string") &&
        (candidate.externalReference === undefined ||
          typeof candidate.externalReference === "string")
      );
    }
    if (candidate.status === "failed") {
      return (
        hasOnly("status", "code", "message", "retryable", "effectState") &&
        typeof candidate.code === "string" &&
        candidate.code.length > 0 &&
        typeof candidate.message === "string" &&
        (candidate.retryable === undefined || typeof candidate.retryable === "boolean") &&
        (candidate.effectState === undefined ||
          (typeof candidate.effectState === "string" &&
            ["confirmed_no_write", "partial_write", "confirmed_write", "unknown"].includes(
              candidate.effectState,
            )))
      );
    }
    return false;
  }

  private normalizeState(state: WorkflowRunState): void {
    state.verifiedEffects ??= {};
    state.cache ??= {};
    state.costs ??= [];
    state.steeringRevision ??= 0;
    state.checkpointGrants ??= {};
    state.authorizationSpend ??= { currency: null, totalAmount: 0, reservations: {} };
    for (const record of Object.values(state.nodes)) {
      record.revision ??= 0;
      record.loopIterations ??= 0;
      record.iterationAttempts ??= 0;
      record.costEntries ??= [];
    }
  }

  private checkpointRequirements(
    details: JsonValue | undefined,
  ): WorkflowAuthorizationCheckpointRequirement[] | null {
    if (!details || Array.isArray(details) || typeof details !== "object") return null;
    const raw = details.requirements;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const parsed: WorkflowAuthorizationCheckpointRequirement[] = [];
    const scopes = new Set<string>();
    for (const candidate of raw) {
      if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") return null;
      const effect = sideEffectClassSchema.safeParse(candidate.effect);
      if (
        !effect.success ||
        typeof candidate.operationId !== "string" ||
        candidate.operationId.length === 0 ||
        candidate.operationId.length > 500 ||
        typeof candidate.provider !== "string" ||
        candidate.provider.length === 0 ||
        candidate.provider.length > 100 ||
        typeof candidate.action !== "string" ||
        candidate.action.length === 0 ||
        candidate.action.length > 500
      ) {
        return null;
      }
      const key = `${effect.data}\u0000${candidate.operationId}`;
      if (scopes.has(key)) return null;
      scopes.add(key);
      parsed.push({
        effect: effect.data,
        operationId: candidate.operationId,
        provider: candidate.provider,
        action: candidate.action,
      });
    }
    return parsed;
  }

  private checkpointRequestedAt(details: JsonValue | undefined): string | null {
    if (!details || Array.isArray(details) || typeof details !== "object") return null;
    const requestedAt = details.requestedAt;
    return typeof requestedAt === "string" && Number.isFinite(Date.parse(requestedAt))
      ? requestedAt
      : null;
  }

  private availableCheckpointGrant(
    state: WorkflowRunState,
    scope: AuthorizationCheckpointScope,
    now: string,
  ): OneShotCheckpointGrant | undefined {
    for (const candidate of Object.values(state.checkpointGrants ?? {})) {
      const parsed = oneShotCheckpointGrantSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const grant = parsed.data;
      if (
        grant.runId === scope.runId &&
        grant.nodeId === scope.nodeId &&
        grant.effect === scope.effect &&
        grant.operationId === scope.operationId &&
        grant.consumedAt === null &&
        Date.parse(grant.expiresAt) > Date.parse(now)
      ) {
        return grant;
      }
    }
    return undefined;
  }

  private claimAuthorizationCheckpoints(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    requirements: WorkflowAuthorizationCheckpointRequirement[],
  ): OneShotCheckpointGrant[] {
    const now = this.timestamp();
    const details: JsonValue = {
      requestedAt: now,
      requirements: requirements.map(({ effect, operationId, provider, action }) => ({
        effect,
        operationId,
        provider,
        action,
      })),
    };
    const parsed = this.checkpointRequirements(details);
    if (!parsed) {
      throw new WorkflowExecutionError(
        "authorization_checkpoint_requirements_invalid",
        `Node "${record.definition.id}" produced invalid authorization checkpoint requirements.`,
      );
    }
    const scopes = parsed.map(({ effect, operationId }) => ({
      runId: state.runId,
      nodeId: record.definition.id,
      effect,
      operationId,
    }));
    const grants = scopes.map((scope) => this.availableCheckpointGrant(state, scope, now));
    if (grants.some((grant) => grant === undefined)) {
      throw new WorkflowExecutionError(
        "authorization_checkpoint_required",
        `Node "${record.definition.id}" requires one-shot human authorization before provider execution.`,
        { details },
      );
    }

    const consumed = grants.map((grant, index) =>
      consumeOneShotCheckpointGrant(grant!, {
        scope: scopes[index],
        attempt: record.attempts,
        now,
      }),
    );
    state.checkpointGrants ??= {};
    for (const grant of consumed) state.checkpointGrants[grant.grantId] = grant;
    this.record(state, "checkpoint_grant_consumed", record.definition.id, {
      attempt: record.attempts,
      grants: consumed.map(({ grantId, effect, operationId, consumedAt }) => ({
        grantId,
        effect,
        operationId,
        consumedAt,
      })),
    });
    return consumed;
  }

  private reserveAuthorizationSpend(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    reservation: WorkflowAuthorizationSpendReservation,
  ): void {
    if (
      !reservation.reservationId.trim() ||
      reservation.reservationId.length > 500 ||
      !/^[A-Z]{3}$/.test(reservation.currency) ||
      !Number.isFinite(reservation.maxAmount) ||
      reservation.maxAmount < 0 ||
      reservation.operations.length === 0
    ) {
      this.checkpointNoWrite(state, record, "authorization spend reservation was invalid");
      throw new WorkflowExecutionError(
        "authorization_spend_reservation_invalid",
        `Node "${record.definition.id}" produced an invalid authorization spend reservation.`,
      );
    }
    const operationIds = new Set<string>();
    let amount = 0;
    for (const operation of reservation.operations) {
      if (
        !operation.operationId ||
        operation.operationId.length > 500 ||
        operationIds.has(operation.operationId) ||
        !Number.isFinite(operation.amount) ||
        operation.amount < 0
      ) {
        this.checkpointNoWrite(state, record, "estimated-cost operation was invalid");
        throw new WorkflowExecutionError(
          "authorization_spend_reservation_invalid",
          `Node "${record.definition.id}" produced an invalid estimated-cost operation.`,
        );
      }
      operationIds.add(operation.operationId);
      amount += operation.amount;
    }
    if (!Number.isFinite(amount)) {
      this.checkpointNoWrite(state, record, "cumulative estimate was non-finite");
      throw new WorkflowExecutionError(
        "authorization_spend_reservation_invalid",
        `Node "${record.definition.id}" produced a non-finite cumulative estimate.`,
      );
    }

    const spend = (state.authorizationSpend ??= {
      currency: null,
      totalAmount: 0,
      reservations: {},
    });
    if (!Number.isFinite(spend.totalAmount) || spend.totalAmount < 0) {
      this.checkpointNoWrite(state, record, "persisted authorization spend was invalid");
      throw new WorkflowExecutionError(
        "authorization_spend_state_invalid",
        `Run "${state.runId}" has invalid persisted authorization spend state.`,
      );
    }
    if (spend.currency !== null && spend.currency !== reservation.currency) {
      this.checkpointNoWrite(state, record, "spend currency did not match");
      throw new WorkflowExecutionError(
        "spend_currency_mismatch",
        `Run "${state.runId}" already reserved ${spend.currency}; ${reservation.currency} cannot be accumulated without conversion.`,
      );
    }
    const existing = spend.reservations[reservation.reservationId];
    if (existing) {
      if (
        existing.nodeId === record.definition.id &&
        existing.amount === amount &&
        existing.operationIds.length === operationIds.size &&
        existing.operationIds.every((operationId) => operationIds.has(operationId))
      ) {
        if (spend.totalAmount > reservation.maxAmount) {
          this.checkpointNoWrite(
            state,
            record,
            "current authorization spend ceiling rejected the existing reservation",
          );
          throw new WorkflowExecutionError(
            "spend_limit_exceeded",
            `Run "${state.runId}" has already reserved ${spend.totalAmount} ${reservation.currency}, exceeding the current cumulative ceiling of ${reservation.maxAmount} ${reservation.currency}.`,
            {
              details: {
                currency: reservation.currency,
                previouslyReserved: spend.totalAmount,
                requested: 0,
                ceiling: reservation.maxAmount,
              },
            },
          );
        }
        return;
      }
      this.checkpointNoWrite(state, record, "reservation id was reused with different details");
      throw new WorkflowExecutionError(
        "authorization_spend_reservation_invalid",
        `Reservation "${reservation.reservationId}" was reused with different spend details.`,
      );
    }
    const cumulative = spend.totalAmount + amount;
    if (!Number.isFinite(cumulative) || cumulative > reservation.maxAmount) {
      this.checkpointNoWrite(state, record, "cumulative spend ceiling rejected the operation");
      throw new WorkflowExecutionError(
        "spend_limit_exceeded",
        `Run "${state.runId}" would reserve ${cumulative} ${reservation.currency}, exceeding its cumulative ceiling of ${reservation.maxAmount} ${reservation.currency}.`,
        {
          details: {
            currency: reservation.currency,
            previouslyReserved: spend.totalAmount,
            requested: amount,
            ceiling: reservation.maxAmount,
          },
        },
      );
    }
    const reservedAt = this.timestamp();
    spend.currency = reservation.currency;
    spend.totalAmount = cumulative;
    spend.reservations[reservation.reservationId] = {
      nodeId: record.definition.id,
      attempt: record.attempts,
      amount,
      operationIds: [...operationIds].sort(),
      reservedAt,
    };
    this.record(state, "authorization_spend_reserved", record.definition.id, {
      reservationId: reservation.reservationId,
      attempt: record.attempts,
      amount,
      currency: reservation.currency,
      cumulative,
      ceiling: reservation.maxAmount,
      operationIds: [...operationIds].sort(),
    });
  }

  private budgetError(
    state: WorkflowRunState,
    node: WorkflowNodeDefinition,
  ): WorkflowNodeError | null {
    const limit = state.budget.limits[node.budgetCategory];
    if (limit === undefined) return null;
    const consumed = state.budget.consumed[node.budgetCategory] ?? 0;
    if (consumed + node.cost.amount <= limit) return null;
    return {
      code: "BUDGET_EXHAUSTED",
      message: `Node "${node.id}" needs ${node.cost.amount} ${node.cost.unit}, but ${consumed}/${limit} is already consumed in "${node.budgetCategory}".`,
      retryable: false,
    };
  }

  private backoffDelay(node: WorkflowNodeDefinition, failedAttempt: number): number {
    const policy = node.retry.backoff;
    if (policy.strategy === "none") return 0;
    if (policy.strategy === "fixed") return policy.initialMs;
    return Math.min(
      policy.maxMs,
      policy.initialMs * Math.pow(policy.multiplier, Math.max(0, failedAttempt - 1)),
    );
  }

  private markTerminalFailure(
    state: WorkflowRunState,
    record: WorkflowNodeRecord,
    error: WorkflowNodeError,
  ): void {
    record.state = "failed_terminal";
    record.error = error;
    record.finishedAt = this.timestamp();
    this.record(state, "node_terminal_failure", record.definition.id, { error });
  }

  private failUnfinishedNodes(state: WorkflowRunState, code: string, message: string): void {
    for (const record of Object.values(state.nodes)) {
      if (isTerminalNode(record)) continue;
      this.markTerminalFailure(state, record, { code, message, retryable: false });
    }
  }

  private skipUnfinishedNodesAfterFailure(state: WorkflowRunState): void {
    for (const record of Object.values(state.nodes)) {
      if (isTerminalNode(record)) continue;
      record.state = "skipped";
      record.skipReason = "run stopped after a terminal node failure";
      record.finishedAt = this.timestamp();
      this.record(state, "node_skipped", record.definition.id, { reason: record.skipReason });
    }
  }

  private normalizeError(error: unknown, fallbackCode = "NODE_FAILED"): WorkflowNodeError {
    if (error instanceof WorkflowExecutionError) {
      return {
        code: error.code,
        message: sanitizeJson(error.message, this.bindings.secrets) as string,
        retryable: error.retryable,
        details:
          error.details === undefined
            ? undefined
            : sanitizeJson(error.details, this.bindings.secrets),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: fallbackCode,
      message: sanitizeJson(message, this.bindings.secrets) as string,
      retryable: false,
    };
  }

  private async compensate(
    definition: WorkflowDefinition,
    state: WorkflowRunState,
    reason: "failure" | "cancel" | "explicit",
  ): Promise<void> {
    const wanted =
      reason === "cancel" ? "on_cancel" : reason === "failure" ? "on_failure" : "explicit";
    for (const nodeId of topologicalOrder(definition).reverse()) {
      const record = state.nodes[nodeId];
      const compensation = record.definition.compensation;
      const compensableState =
        record.state === "succeeded" ||
        (record.state === "failed_terminal" && record.effectVerified);
      if (!compensableState || !compensation || compensation.when !== wanted) continue;
      const handler = this.bindings.compensators[compensation.handler];
      if (!handler) {
        this.record(state, "node_trace", nodeId, {
          compensation: "not run",
          nextAction: `register compensator "${compensation.handler}" and run explicit compensation`,
        });
        continue;
      }
      const controller = new AbortController();
      const context: WorkflowCompensationContext = {
        runId: state.runId,
        node: record.definition,
        output: record.output,
        reason,
        signal: controller.signal,
      };
      try {
        await handler(context);
        record.state = "compensated";
        record.finishedAt = this.timestamp();
        this.record(state, "node_compensated", nodeId, { reason });
      } catch (error) {
        this.record(state, "node_trace", nodeId, {
          compensation: "failed",
          error: this.normalizeError(error, "COMPENSATION_FAILED"),
        });
      }
    }
  }

  private async resolveInterrupt(
    runId: string,
    nodeId: string,
    expectedState: "waiting_for_approval" | "waiting_for_manual_action",
    resolution: WorkflowInterruptResolution,
  ): Promise<WorkflowRunState> {
    const state = this.store.load(runId);
    const record = state.nodes[nodeId];
    if (!record) throw new Error(`Workflow run "${runId}" has no node "${nodeId}".`);
    if (record.state !== expectedState) {
      throw new Error(
        `Node "${nodeId}" is ${record.state}; expected ${expectedState} before resolving it.`,
      );
    }
    if (record.definition.evidence.required && !resolution.evidenceArtifact) {
      throw new Error(`Node "${nodeId}" requires an evidence artifact before it can resume.`);
    }
    if (!resolution.approvedBy?.trim()) {
      throw new Error(`Node "${nodeId}" requires an explicit approvedBy identity.`);
    }

    const dependencyOutputs = this.dependencyOutputs(state, record.definition);
    const validationContext: WorkflowValidationContext = {
      runId,
      node: record.definition,
      input: record.definition.input.value,
      output: resolution.output,
      dependencyOutputs,
    };
    await this.runValidator(
      record.definition.output.validator,
      validationContext,
      "OUTPUT_VALIDATION_FAILED",
    );
    await this.runValidator(
      record.definition.completion.validator,
      validationContext,
      "COMPLETION_CRITERION_FAILED",
    );

    const effectful = record.definition.effect !== "none" && record.definition.effect !== "read";
    if (effectful) {
      if (!resolution.evidenceArtifact) {
        throw new Error(
          `Node "${nodeId}" has an external effect and requires verified evidence before it can resume.`,
        );
      }
      const verifyEvidence = this.bindings.interruptEvidenceVerifier;
      if (!verifyEvidence) {
        throw new Error(
          `Node "${nodeId}" has an external effect but no interrupt evidence verifier is registered.`,
        );
      }
      const verified = normalizedValidatorResult(
        await verifyEvidence({
          runId,
          node: record.definition,
          output: resolution.output,
          evidenceArtifact: resolution.evidenceArtifact,
          approvedBy: resolution.approvedBy,
          note: resolution.note,
        }),
      );
      if (!verified.ok) {
        throw new Error(verified.message ?? `Evidence for node "${nodeId}" was not verified.`);
      }
    }

    record.output =
      resolution.output === undefined
        ? undefined
        : sanitizeJson(resolution.output, this.bindings.secrets);
    record.evidenceArtifact = resolution.evidenceArtifact;
    record.effectVerified = effectful;
    record.state = "succeeded";
    record.finishedAt = this.timestamp();
    if (record.effectVerified) {
      state.verifiedEffects[record.definition.idempotencyKey] = {
        nodeId,
        output: record.output,
        evidenceArtifact: record.evidenceArtifact,
        verifiedAt: record.finishedAt,
      };
    }
    state.status = "created";
    state.finishedAt = undefined;
    this.record(state, "interrupt_resolved", nodeId, {
      approvedBy: resolution.approvedBy ?? null,
      note: resolution.note ?? null,
      evidenceArtifact: resolution.evidenceArtifact ?? null,
    });
    return state;
  }

  private assertGraphMatch(definition: WorkflowDefinition, state: WorkflowRunState): void {
    const fingerprint = workflowFingerprint(definition);
    if (state.graph.fingerprint !== fingerprint) {
      throw new Error(
        `Workflow definition changed for run "${state.runId}". Resume with graph ${state.graph.id}@${state.graph.version} (${state.graph.fingerprint.slice(0, 12)}).`,
      );
    }
  }

  private record(
    state: WorkflowRunState,
    type: WorkflowEventType,
    nodeId?: string,
    details?: unknown,
  ): void {
    state.eventSequence += 1;
    state.updatedAt = this.timestamp();
    const event = {
      sequence: state.eventSequence,
      timestamp: state.updatedAt,
      runId: state.runId,
      type,
      nodeId,
      details: details === undefined ? undefined : sanitizeJson(details, this.bindings.secrets),
    };
    if (this.store.checkpoint) this.store.checkpoint(state, event);
    else {
      this.store.save(state);
      this.store.appendEvent(event);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private generateRunId(graphId: string): string {
    const timestamp = this.timestamp()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14);
    return `${graphId}-${timestamp}-${randomBytes(4).toString("hex")}`;
  }
}
