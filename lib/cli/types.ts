import type { JsonValue, WorkflowRunState } from "../workflow";
import type { AuthorizationSideEffect } from "../authorization";
import type { LearningCadence } from "../learning";
import type { LaunchGrant } from "../materialization";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CliPlanRequest {
  brief?: string;
  json: boolean;
}

export interface CliCreateRequest {
  brief: string;
  json: boolean;
}

export interface CliLaunchRequest {
  mode: "dry-run" | "apply";
  authorization?: string;
  runId?: string;
  json: boolean;
  /** Internal one-prompt binding; never accepted from an arbitrary JSON file. */
  launchGrant?: LaunchGrant;
  /**
   * Internal continuation marker. The child service re-reads and validates the
   * exact pending founder transaction before renewing an expired run envelope.
   */
  pendingFounderGrantRenewal?: true;
}

export interface CliFounderLaunchRequest {
  mode: "dry-run" | "apply";
  idea: string;
  stackProfile: "founder-default";
  production: true;
  nonInteractive: true;
  output?: string;
  json: boolean;
}

export interface CliResumeRequest {
  runId: string;
  authorization?: string;
  nodeId?: string;
  resolutionKind?: "manual" | "approval" | "checkpoint_grant";
  evidenceArtifact?: string;
  effect?: AuthorizationSideEffect;
  operationId?: string;
  outputFile?: string;
  note?: string;
}

export interface CliAuthRequest {
  action: "login" | "status" | "test" | "revoke";
  provider?: string;
  ref?: string;
  backend?: string;
  kind?: string;
  scopes?: string[];
}

export interface CliStackRequest {
  action: "create" | "doctor";
  profileId: "founder-default";
  file?: string;
}

export interface CliServices {
  create?: (request: CliCreateRequest) => Promise<JsonValue> | JsonValue;
  doctor?: () => Promise<JsonValue> | JsonValue;
  plan?: (request: CliPlanRequest) => Promise<JsonValue> | JsonValue;
  launch?: (request: CliLaunchRequest) => Promise<JsonValue> | JsonValue;
  founderLaunch?: (request: CliFounderLaunchRequest) => Promise<JsonValue> | JsonValue;
  resume?: (request: CliResumeRequest) => Promise<WorkflowRunState> | WorkflowRunState;
  cancel?: (runId: string, reason: string) => Promise<WorkflowRunState> | WorkflowRunState;
  auth?: (request: CliAuthRequest) => Promise<JsonValue> | JsonValue;
  stack?: (request: CliStackRequest) => Promise<JsonValue> | JsonValue;
  dataSync?: () => Promise<JsonValue> | JsonValue;
  learn?: (cadence: LearningCadence) => Promise<JsonValue> | JsonValue;
  upgrade?: (options: { dryRun: boolean; releasePath?: string }) => Promise<JsonValue> | JsonValue;
}

export interface CliResult {
  exitCode: number;
}
