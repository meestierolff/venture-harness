import type {
  AuthorizationSideEffect,
  OneShotCheckpointGrant,
} from "../authorization/checkpoint-grant";

export const WORKFLOW_NODE_STATES = [
  "pending",
  "ready",
  "running",
  "waiting_for_approval",
  "waiting_for_manual_action",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "skipped",
  "compensated",
] as const;

/**
 * The original public state list is retained for consumers that render the
 * v0.1 manual-action vocabulary. New durable runs use the complete state
 * model below; `waiting_for_manual_action` remains a supported compatibility
 * alias for a human-completed external action.
 */
export const DURABLE_WORKFLOW_NODE_STATES = [
  "pending",
  "ready",
  "running",
  "waiting_for_auth",
  "waiting_for_external_action",
  "waiting_for_approval",
  "waiting_for_manual_action",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "skipped",
  "compensated",
  "cancelled",
] as const;

export type WorkflowNodeState = (typeof DURABLE_WORKFLOW_NODE_STATES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WorkflowNodeKind = "code" | "model" | "provider" | "human_approval" | "manual_action";

export type WorkflowTransport =
  "code" | "model" | "mcp" | "cli" | "api" | "manual" | "human_approval" | "custom";

export type WorkflowEffectClass =
  "none" | "read" | "local_write" | "external_reversible" | "external_irreversible";

export type WorkflowRiskClass = "low" | "medium" | "high" | "critical";

export interface WorkflowCondition {
  kind: "always" | "dependencies_succeeded" | "handler";
  handler?: string;
}

export interface WorkflowIoContract {
  value?: JsonValue;
  validator?: string;
}

export interface WorkflowModelConfig {
  tier: "none" | "cheap" | "capable";
  provider?: string;
  model?: string;
}

export interface WorkflowAuthorizationRequirement {
  required: boolean;
  profile?: string;
  scopes: string[];
}

export interface WorkflowBackoffPolicy {
  strategy: "none" | "fixed" | "exponential";
  initialMs: number;
  maxMs: number;
  multiplier: number;
}

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  retryableCodes: string[];
  backoff: WorkflowBackoffPolicy;
}

export interface WorkflowCostEstimate {
  amount: number;
  unit: string;
}

export type WorkflowCostKind = "code" | "model" | "tool" | "provider";

export interface WorkflowCostCharge {
  kind: WorkflowCostKind;
  category: string;
  amount: number;
  unit: string;
  inputTokens?: number;
  outputTokens?: number;
  tool?: string;
  model?: string;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowCostRecord extends WorkflowCostCharge {
  entryId: string;
  nodeId: string;
  attempt: number;
  loopIteration: number;
  recordedAt: string;
}

export interface WorkflowCachePolicy {
  mode: "none" | "run" | "persistent";
  key?: string;
}

export interface WorkflowCompensationDefinition {
  handler: string;
  when: "on_failure" | "on_cancel" | "explicit";
}

export interface WorkflowEvidenceRequirement {
  required: boolean;
  artifact?: string;
}

export interface WorkflowCompletionCriterion {
  description: string;
  validator?: string;
}

export interface WorkflowReconciliationPolicy {
  handler: string;
  pollIntervalMs: number;
  maxPollAttempts: number;
}

export interface WorkflowLoopPolicy {
  /** Maximum handler completions for this node, including the final one. */
  maxIterations: number;
}

/**
 * A JSON-safe node definition. Executable behavior is supplied separately in
 * WorkflowBindings so plans and durable state never need to serialize code or
 * credentials.
 */
export interface WorkflowNodeDefinition {
  id: string;
  purpose: string;
  kind: WorkflowNodeKind;
  capability: string;
  dependencies: string[];
  condition: WorkflowCondition;
  input: WorkflowIoContract;
  output: WorkflowIoContract;
  transport: WorkflowTransport;
  handler?: string;
  model: WorkflowModelConfig;
  effect: WorkflowEffectClass;
  risk: WorkflowRiskClass;
  authorization: WorkflowAuthorizationRequirement;
  idempotencyKey: string;
  timeoutMs: number;
  retry: WorkflowRetryPolicy;
  concurrencyGroup: string;
  cost: WorkflowCostEstimate;
  budgetCategory: string;
  cache: WorkflowCachePolicy;
  isolation: "none" | "worktree" | "process";
  compensation: WorkflowCompensationDefinition | null;
  evidence: WorkflowEvidenceRequirement;
  completion: WorkflowCompletionCriterion;
  reconciliation?: WorkflowReconciliationPolicy;
  loop?: WorkflowLoopPolicy;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  nodes: WorkflowNodeDefinition[];
  maxParallel: number;
  maxIterations: number;
  budgets: Record<string, number>;
  metadata?: Record<string, JsonValue>;
}

export type WorkflowRunStatus =
  | "created"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export interface WorkflowNodeError {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export type WorkflowOperationPhase =
  | "prepared"
  | "external_write_acknowledged"
  | "handler_completed"
  | "pending_external"
  | "partially_applied"
  | "not_applied"
  | "verified"
  | "unknown"
  | "cancelled";

export interface WorkflowOperationRecord {
  attempt: number;
  idempotencyKey: string;
  phase: WorkflowOperationPhase;
  preparedAt: string;
  updatedAt: string;
  reconcileAttempts: number;
  lastReconciledAt?: string;
  externalReference?: string;
  checkpoint?: JsonValue;
}

export interface WorkflowWaitRecord {
  kind: "auth" | "external" | "approval";
  reason: string;
  requestedAt: string;
  pollAfterMs?: number;
  externalReference?: string;
}

export interface WorkflowWorkspaceRecord {
  mode: "worktree" | "process";
  path: string;
  attempt: number;
  createdAt: string;
}

export interface WorkflowNodeRecord {
  definition: WorkflowNodeDefinition;
  state: WorkflowNodeState;
  attempts: number;
  iterationAttempts?: number;
  startedAt?: string;
  finishedAt?: string;
  output?: JsonValue;
  error?: WorkflowNodeError;
  effectVerified: boolean;
  evidenceArtifact?: string;
  cost: number;
  skipReason?: string;
  revision?: number;
  loopIterations?: number;
  operation?: WorkflowOperationRecord;
  waiting?: WorkflowWaitRecord;
  workspace?: WorkflowWorkspaceRecord;
  costEntries?: string[];
}

export interface VerifiedWorkflowEffect {
  nodeId: string;
  output?: JsonValue;
  evidenceArtifact?: string;
  verifiedAt: string;
}

export interface WorkflowBudgetState {
  limits: Record<string, number>;
  consumed: Record<string, number>;
}

export interface WorkflowAuthorizationSpendReservation {
  reservationId: string;
  currency: string;
  maxAmount: number;
  operations: { operationId: string; amount: number }[];
}

export interface WorkflowAuthorizationSpendState {
  currency: string | null;
  totalAmount: number;
  reservations: Record<
    string,
    {
      nodeId: string;
      attempt: number;
      amount: number;
      operationIds: string[];
      reservedAt: string;
    }
  >;
}

export interface WorkflowRunState {
  schemaVersion: 1;
  runId: string;
  graph: { id: string; name: string; version: string; fingerprint: string };
  status: WorkflowRunStatus;
  nodes: Record<string, WorkflowNodeRecord>;
  verifiedEffects: Record<string, VerifiedWorkflowEffect>;
  checkpointGrants?: Record<string, OneShotCheckpointGrant>;
  authorizationSpend?: WorkflowAuthorizationSpendState;
  cache: Record<string, JsonValue>;
  budget: WorkflowBudgetState;
  iterations: number;
  maxIterations: number;
  maxParallel: number;
  eventSequence: number;
  /** Write-ahead event used to recover a crash between state and JSONL persistence. */
  pendingEvent?: WorkflowEvent;
  cancellationReason?: string;
  queuedAt?: string;
  supersedesRunId?: string;
  supersededByRunId?: string;
  steeringRevision?: number;
  costs?: WorkflowCostRecord[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type WorkflowEventType =
  | "run_created"
  | "run_queued"
  | "run_started"
  | "run_waiting"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled"
  | "run_superseded"
  | "run_steered"
  | "run_recovered"
  | "node_ready"
  | "node_started"
  | "node_operation_prepared"
  | "node_operation_checkpointed"
  | "node_reconciliation_started"
  | "node_reconciled"
  | "node_trace"
  | "node_waiting"
  | "node_retryable_failure"
  | "node_terminal_failure"
  | "node_succeeded"
  | "node_skipped"
  | "node_reused"
  | "node_compensated"
  | "node_cancelled"
  | "node_cost_recorded"
  | "interrupt_resolved"
  | "checkpoint_grant_issued"
  | "checkpoint_grant_consumed"
  | "authorization_spend_reserved";

export interface WorkflowEvent {
  sequence: number;
  timestamp: string;
  runId: string;
  type: WorkflowEventType;
  nodeId?: string;
  details?: JsonValue;
}

export interface WorkflowHandlerContext {
  runId: string;
  node: WorkflowNodeDefinition;
  attempt: number;
  input?: JsonValue;
  dependencyOutputs: Record<string, JsonValue | undefined>;
  idempotencyKey: string;
  loopIteration?: number;
  workspacePath?: string;
  signal: AbortSignal;
  trace: (details: JsonValue) => void;
  /** Persist immutable effect-target metadata while the operation is prepared. */
  checkpointOperation?: (details: JsonValue) => void;
  checkpointExternalEffect?: (details?: JsonValue) => void;
  recordCost?: (charge: WorkflowCostCharge) => void;
  claimAuthorizationCheckpoints?: (
    requirements: WorkflowAuthorizationCheckpointRequirement[],
  ) => OneShotCheckpointGrant[];
  reserveAuthorizationSpend?: (reservation: WorkflowAuthorizationSpendReservation) => void;
}

export interface WorkflowAuthorizationCheckpointRequirement {
  effect: AuthorizationSideEffect;
  operationId: string;
  provider: string;
  action: string;
}

export interface WorkflowHandlerResult {
  output?: JsonValue;
  effectVerified?: boolean;
  evidenceArtifact?: string;
  cost?: number;
  costs?: WorkflowCostCharge[];
  continueLoop?: boolean;
  wait?: {
    kind: "auth" | "external" | "approval";
    reason: string;
    pollAfterMs?: number;
    externalReference?: string;
  };
}

export type WorkflowNodeHandler = (
  context: WorkflowHandlerContext,
) => Promise<WorkflowHandlerResult> | WorkflowHandlerResult;

export interface WorkflowReconciliationContext {
  runId: string;
  node: WorkflowNodeDefinition;
  attempt: number;
  /** Exact JSON-safe node input persisted with the graph definition. */
  input?: JsonValue;
  /** Persisted outputs of this node's declared dependencies. */
  dependencyOutputs: Record<string, JsonValue | undefined>;
  idempotencyKey: string;
  operation: WorkflowOperationRecord;
  reason: "restart" | "retry" | "poll" | "cancel";
  signal: AbortSignal;
  trace: (details: JsonValue) => void;
}

export type WorkflowReconciliationResult =
  | {
      status: "verified";
      output?: JsonValue;
      evidenceArtifact?: string;
      cost?: number;
      costs?: WorkflowCostCharge[];
      externalReference?: string;
    }
  | { status: "not_applied" }
  | {
      status: "partially_applied";
      message?: string;
      externalReference?: string;
    }
  | { status: "pending"; pollAfterMs?: number; externalReference?: string }
  | { status: "unknown"; message?: string; externalReference?: string }
  | {
      status: "failed";
      code: string;
      message: string;
      retryable?: boolean;
      /** Defaults to unknown; only confirmed_no_write may clear reconciliation obligations. */
      effectState?: "confirmed_no_write" | "partial_write" | "confirmed_write" | "unknown";
    };

export type WorkflowReconciler = (
  context: WorkflowReconciliationContext,
) => Promise<WorkflowReconciliationResult> | WorkflowReconciliationResult;

export interface WorkflowWorkspaceContext {
  runId: string;
  node: WorkflowNodeDefinition;
  attempt: number;
  mode: "worktree" | "process";
}

export type WorkflowWorkspaceFactory = (
  context: WorkflowWorkspaceContext,
) => Promise<string> | string;

export interface WorkflowValidationContext {
  runId: string;
  node: WorkflowNodeDefinition;
  input?: JsonValue;
  output?: JsonValue;
  dependencyOutputs: Record<string, JsonValue | undefined>;
}

export type WorkflowValidatorResult = boolean | { ok: boolean; message?: string };

export type WorkflowValidator = (
  context: WorkflowValidationContext,
) => Promise<WorkflowValidatorResult> | WorkflowValidatorResult;

export type WorkflowConditionHandler = (
  context: WorkflowValidationContext,
) => Promise<boolean> | boolean;

export interface WorkflowCompensationContext {
  runId: string;
  node: WorkflowNodeDefinition;
  output?: JsonValue;
  reason: "failure" | "cancel" | "explicit";
  signal: AbortSignal;
}

export type WorkflowCompensator = (context: WorkflowCompensationContext) => Promise<void> | void;

export interface WorkflowInterruptEvidenceContext {
  runId: string;
  node: WorkflowNodeDefinition;
  output?: JsonValue;
  evidenceArtifact: string;
  approvedBy: string;
  note?: string;
}

/**
 * Verifies evidence outside the generic graph runtime (for example, a
 * repository-relative, typed evidence file). Merely supplying an artifact
 * string is never proof that a manual external effect occurred.
 */
export type WorkflowInterruptEvidenceVerifier = (
  context: WorkflowInterruptEvidenceContext,
) => Promise<WorkflowValidatorResult> | WorkflowValidatorResult;

export interface WorkflowCheckpointEvidenceContext {
  runId: string;
  node: WorkflowNodeDefinition;
  effect: AuthorizationSideEffect;
  operationId: string;
  evidenceArtifact: string;
  approvedBy: string;
  approvedAt: string;
}

export type WorkflowCheckpointEvidenceVerifier = (
  context: WorkflowCheckpointEvidenceContext,
) => Promise<WorkflowValidatorResult> | WorkflowValidatorResult;

export interface WorkflowBindings {
  handlers?: Record<string, WorkflowNodeHandler>;
  validators?: Record<string, WorkflowValidator>;
  conditions?: Record<string, WorkflowConditionHandler>;
  compensators?: Record<string, WorkflowCompensator>;
  reconcilers?: Record<string, WorkflowReconciler>;
  workspaceFactory?: WorkflowWorkspaceFactory;
  interruptEvidenceVerifier?: WorkflowInterruptEvidenceVerifier;
  checkpointEvidenceVerifier?: WorkflowCheckpointEvidenceVerifier;
  secrets?: string[];
}

export interface WorkflowStartOptions {
  runId?: string;
  maxParallel?: number;
  maxIterations?: number;
  budgets?: Record<string, number>;
  supersedesRunId?: string;
}

export interface WorkflowSteerRequest {
  inputs: Record<string, JsonValue>;
  reason: string;
  steeredBy: string;
}

export interface WorkflowAuthorizationRefresh {
  authorizedBy: string;
  credentialRef?: string;
  expiresAt?: string;
  note?: string;
}

export interface WorkflowSupersedeOptions extends WorkflowStartOptions {
  reason: string;
  supersededBy: string;
  queue?: boolean;
}

export interface WorkflowInterruptResolution {
  output?: JsonValue;
  evidenceArtifact?: string;
  approvedBy?: string;
  note?: string;
}

export interface WorkflowCheckpointGrantResolution {
  effect: AuthorizationSideEffect;
  operationId: string;
  evidenceArtifact: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}
