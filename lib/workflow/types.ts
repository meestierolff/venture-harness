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

export type WorkflowNodeState = (typeof WORKFLOW_NODE_STATES)[number];

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
  "created" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface WorkflowNodeError {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export interface WorkflowNodeRecord {
  definition: WorkflowNodeDefinition;
  state: WorkflowNodeState;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  output?: JsonValue;
  error?: WorkflowNodeError;
  effectVerified: boolean;
  evidenceArtifact?: string;
  cost: number;
  skipReason?: string;
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
  cancellationReason?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type WorkflowEventType =
  | "run_created"
  | "run_started"
  | "run_waiting"
  | "run_succeeded"
  | "run_failed"
  | "run_cancelled"
  | "run_recovered"
  | "node_ready"
  | "node_started"
  | "node_trace"
  | "node_waiting"
  | "node_retryable_failure"
  | "node_terminal_failure"
  | "node_succeeded"
  | "node_skipped"
  | "node_reused"
  | "node_compensated"
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
  signal: AbortSignal;
  trace: (details: JsonValue) => void;
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
}

export type WorkflowNodeHandler = (
  context: WorkflowHandlerContext,
) => Promise<WorkflowHandlerResult> | WorkflowHandlerResult;

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
  interruptEvidenceVerifier?: WorkflowInterruptEvidenceVerifier;
  checkpointEvidenceVerifier?: WorkflowCheckpointEvidenceVerifier;
  secrets?: string[];
}

export interface WorkflowStartOptions {
  runId?: string;
  maxParallel?: number;
  maxIterations?: number;
  budgets?: Record<string, number>;
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
