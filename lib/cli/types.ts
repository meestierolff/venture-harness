import type { JsonValue, WorkflowRunState } from "../workflow";
import type { AuthorizationSideEffect } from "../authorization";
import type { LearningCadence } from "../learning";

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

export interface CliServices {
  create?: (request: CliCreateRequest) => Promise<JsonValue> | JsonValue;
  doctor?: () => Promise<JsonValue> | JsonValue;
  plan?: (request: CliPlanRequest) => Promise<JsonValue> | JsonValue;
  launch?: (request: CliLaunchRequest) => Promise<JsonValue> | JsonValue;
  resume?: (request: CliResumeRequest) => Promise<WorkflowRunState> | WorkflowRunState;
  cancel?: (runId: string, reason: string) => Promise<WorkflowRunState> | WorkflowRunState;
  auth?: (request: CliAuthRequest) => Promise<JsonValue> | JsonValue;
  dataSync?: () => Promise<JsonValue> | JsonValue;
  learn?: (cadence: LearningCadence) => Promise<JsonValue> | JsonValue;
  upgrade?: (options: { dryRun: boolean; releasePath?: string }) => Promise<JsonValue> | JsonValue;
}

export interface CliResult {
  exitCode: number;
}
