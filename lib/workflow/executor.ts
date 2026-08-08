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
  type WorkflowAuthorizationSpendReservation,
  type WorkflowCheckpointGrantResolution,
  type WorkflowCompensationContext,
  type WorkflowDefinition,
  type WorkflowEventType,
  type WorkflowHandlerContext,
  type WorkflowHandlerResult,
  type WorkflowInterruptResolution,
  type WorkflowNodeDefinition,
  type WorkflowNodeError,
  type WorkflowNodeRecord,
  type WorkflowRunState,
  type WorkflowStartOptions,
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

const TERMINAL_NODE_STATES = new Set(["succeeded", "failed_terminal", "skipped", "compensated"]);

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
  return state.status === "cancelled";
}

function nodeWasSkipped(record: WorkflowNodeRecord): boolean {
  return record.state === "skipped";
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
    Omit<WorkflowBindings, "secrets" | "interruptEvidenceVerifier" | "checkpointEvidenceVerifier">
  > & {
    interruptEvidenceVerifier?: WorkflowBindings["interruptEvidenceVerifier"];
    checkpointEvidenceVerifier?: WorkflowBindings["checkpointEvidenceVerifier"];
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
            effectVerified: false,
            cost: 0,
          } satisfies WorkflowNodeRecord,
        ]),
      ),
      verifiedEffects: {},
      checkpointGrants: {},
      authorizationSpend: { currency: null, totalAmount: 0, reservations: {} },
      cache: {},
      budget: { limits, consumed },
      iterations: 0,
      maxIterations: options.maxIterations ?? definition.maxIterations,
      maxParallel: options.maxParallel ?? definition.maxParallel,
      eventSequence: 0,
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

  async resume(definition: WorkflowDefinition, runId: string): Promise<WorkflowRunState> {
    validateWorkflow(definition);
    const state = this.store.load(runId);
    this.assertGraphMatch(definition, state);
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") {
      return state;
    }
    return this.execute(definition, state, true);
  }

  getState(runId: string): WorkflowRunState {
    return this.store.load(runId);
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
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") {
      return state;
    }
    if (definition) this.assertGraphMatch(definition, state);

    state.status = "cancelled";
    state.cancellationReason = reason;
    state.finishedAt = this.timestamp();
    for (const record of Object.values(state.nodes)) {
      if (!isTerminalNode(record)) {
        record.state = "skipped";
        record.skipReason = `run cancelled: ${reason}`;
        record.finishedAt = this.timestamp();
      }
    }
    for (const [key, controller] of this.activeControllers) {
      if (key.startsWith(`${runId}:`)) controller.abort(reason);
    }
    if (definition) await this.compensate(definition, state, "cancel");
    this.record(state, "run_cancelled", undefined, { reason });
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
      if (recovering) this.recoverInterruptedNodes(state);
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
              record.state === "waiting_for_manual_action",
          )
        ) {
          state.status = "waiting";
          this.record(state, "run_waiting", undefined, {
            nodes: records
              .filter(
                (record) =>
                  record.state === "waiting_for_approval" ||
                  record.state === "waiting_for_manual_action",
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

  private recoverInterruptedNodes(state: WorkflowRunState): void {
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
        } else {
          record.state = "pending";
          record.startedAt = undefined;
        }
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
          (dependency) => dependency.state === "failed_terminal" || dependency.state === "skipped",
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

    while (record.attempts < node.retry.maxAttempts && state.status === "running") {
      const budgetError = this.budgetError(state, node);
      if (budgetError) {
        this.markTerminalFailure(state, record, budgetError);
        return;
      }

      record.attempts += 1;
      record.state = "running";
      record.startedAt = this.timestamp();
      record.error = undefined;
      this.record(state, "node_started", nodeId, { attempt: record.attempts });

      try {
        const result = await this.invokeHandler(state, record);
        if (runWasCancelled(state) || nodeWasSkipped(record)) return;
        await this.validateResult(state, node, result);
        if (node.effect !== "none" && node.effect !== "read" && result.effectVerified !== true) {
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
        const actualCost = result.cost ?? node.cost.amount;
        record.cost += actualCost;
        record.finishedAt = this.timestamp();
        state.budget.consumed[node.budgetCategory] =
          (state.budget.consumed[node.budgetCategory] ?? 0) + actualCost;

        if (record.effectVerified) {
          state.verifiedEffects[node.idempotencyKey] = {
            nodeId,
            output: record.output,
            evidenceArtifact: record.evidenceArtifact,
            verifiedAt: record.finishedAt,
          };
        }
        if (node.cache.mode !== "none" && record.output !== undefined) {
          state.cache[cacheKey] = record.output;
        }
        const limit = state.budget.limits[node.budgetCategory];
        if (limit !== undefined && state.budget.consumed[node.budgetCategory] > limit) {
          this.markTerminalFailure(state, record, {
            code: "BUDGET_EXCEEDED_AFTER_EXECUTION",
            message: `Node "${node.id}" reported ${actualCost} ${node.cost.unit}; category "${node.budgetCategory}" is now ${state.budget.consumed[node.budgetCategory]}/${limit}. The verified effect was recorded and will not be repeated.`,
            retryable: false,
          });
          return;
        }
        record.state = "succeeded";
        this.record(state, "node_succeeded", nodeId, {
          attempt: record.attempts,
          effectVerified: record.effectVerified,
          evidenceArtifact: record.evidenceArtifact ?? null,
        });
        return;
      } catch (error) {
        if (runWasCancelled(state) || nodeWasSkipped(record)) return;
        const normalized = this.normalizeError(error);
        if (
          normalized.code === "authorization_checkpoint_required" &&
          this.checkpointRequirements(normalized.details)
        ) {
          record.attempts = Math.max(0, record.attempts - 1);
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
        const permittedCode =
          node.retry.retryableCodes.length === 0 ||
          node.retry.retryableCodes.includes(normalized.code);
        if (normalized.retryable && permittedCode && record.attempts < node.retry.maxAttempts) {
          record.state = "failed_retryable";
          record.error = normalized;
          this.record(state, "node_retryable_failure", nodeId, {
            attempt: record.attempts,
            error: normalized,
          });
          const delay = this.backoffDelay(node, record.attempts);
          if (delay > 0) await this.sleep(delay);
          if (state.status !== "running") return;
          record.state = "ready";
          this.record(state, "node_ready", nodeId, { retry: record.attempts + 1 });
          continue;
        }
        this.markTerminalFailure(state, record, normalized);
        return;
      }
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
      signal: controller.signal,
      trace: (details) => this.record(state, "node_trace", node.id, details),
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
        throw new WorkflowExecutionError(
          "authorization_spend_reservation_invalid",
          `Node "${record.definition.id}" produced an invalid estimated-cost operation.`,
        );
      }
      operationIds.add(operation.operationId);
      amount += operation.amount;
    }
    if (!Number.isFinite(amount)) {
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
      throw new WorkflowExecutionError(
        "authorization_spend_state_invalid",
        `Run "${state.runId}" has invalid persisted authorization spend state.`,
      );
    }
    if (spend.currency !== null && spend.currency !== reservation.currency) {
      throw new WorkflowExecutionError(
        "spend_currency_mismatch",
        `Run "${state.runId}" already reserved ${spend.currency}; ${reservation.currency} cannot be accumulated without conversion.`,
      );
    }
    const existing = spend.reservations[reservation.reservationId];
    if (existing) {
      if (
        existing.nodeId === record.definition.id &&
        existing.attempt === record.attempts &&
        existing.amount === amount &&
        existing.operationIds.length === operationIds.size &&
        existing.operationIds.every((operationId) => operationIds.has(operationId))
      ) {
        return;
      }
      throw new WorkflowExecutionError(
        "authorization_spend_reservation_invalid",
        `Reservation "${reservation.reservationId}" was reused with different spend details.`,
      );
    }
    const cumulative = spend.totalAmount + amount;
    if (!Number.isFinite(cumulative) || cumulative > reservation.maxAmount) {
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
    this.store.save(state);
    this.store.appendEvent({
      sequence: state.eventSequence,
      timestamp: state.updatedAt,
      runId: state.runId,
      type,
      nodeId,
      details: details === undefined ? undefined : sanitizeJson(details, this.bindings.secrets),
    });
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
