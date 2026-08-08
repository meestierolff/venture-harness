import type { JsonValue } from "../workflow";

export type BuildAgentStatus = "completed" | "blocked";

export interface BuildAgentCheck {
  command: string;
  status: "passed" | "failed" | "skipped";
  evidence: string | null;
}

export interface BuildAgentUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export type BuildAgentArtifactRole =
  | "repository_scaffold"
  | "managed_manifest"
  | "design_record"
  | "design_implementation"
  | "core_journey"
  | "affected_test"
  | "event_contract"
  | "event_instrumentation"
  | "validation_record"
  | "concierge_operations"
  | "usage_proof";

export interface BuildAgentCompletionArtifact {
  path: string;
  role: BuildAgentArtifactRole;
}

export interface BuildAgentCompletion {
  outcome: "changed" | "already_compliant";
  artifacts: BuildAgentCompletionArtifact[];
  /** Exact command of one passed check in `checks` that validates completion. */
  validator: { checkCommand: string };
}

export interface BuildAgentResult {
  status: BuildAgentStatus;
  summary: string;
  changedFiles: string[];
  checks: BuildAgentCheck[];
  limitations: string[];
  eventTypes: string[];
  completion: BuildAgentCompletion | null;
  usage?: BuildAgentUsage;
}

export interface BuildAgentRequest {
  runId: string;
  nodeId: string;
  purpose: string;
  instructions: string;
  context: JsonValue;
  signal?: AbortSignal;
}

export interface BuildAgentHostInspection {
  host: string;
  status: "available" | "missing" | "unavailable";
  version: string | null;
  nextAction: string | null;
}

/**
 * Agent-neutral boundary for repository-local product work. Implementations
 * receive only a bounded task and JSON-safe context; provider credentials and
 * external-effect authorization do not cross this boundary.
 */
export interface BuildAgentHost {
  readonly id: string;
  inspect(): Promise<BuildAgentHostInspection>;
  run(request: BuildAgentRequest): Promise<BuildAgentResult>;
}

export class BuildAgentHostError extends Error {
  constructor(
    readonly code:
      | "host_unavailable"
      | "credential_material"
      | "process_failed"
      | "invalid_jsonl"
      | "missing_final_result"
      | "invalid_final_result",
    message: string,
  ) {
    super(message);
    this.name = "BuildAgentHostError";
  }
}
