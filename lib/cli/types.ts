import type { JsonValue, WorkflowRunState } from "../workflow";
import type { AuthorizationSideEffect } from "../authorization";
import type { LearningCadence } from "../learning";
import type { LaunchGrant } from "../materialization";
import type { FounderLaunchGap, FounderStackConnection, FounderStackRole } from "../founder-launch";
import type { CredentialKind } from "../credentials";

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

export interface CliIdeaSharpenRequest {
  input: string;
  output: string;
  json: boolean;
}

export interface CliLaunchRequest {
  mode: "dry-run" | "apply";
  authorization?: string;
  runId?: string;
  json: boolean;
  /** Internal one-prompt binding; never accepted from an arbitrary JSON file. */
  launchGrant?: LaunchGrant;
  /** Internal typed non-critical provider gaps carried into durable launch/report state. */
  founderLaunchGaps?: readonly FounderLaunchGap[];
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
  /** Immediate hidden read consumed only by a writable credential backend. */
  readValue?: () => Promise<string>;
}

export interface CliStackRequest {
  action: "create" | "connect" | "doctor";
  profileId: "founder-default";
  file?: string;
  /** Credential-free wizard output. Credential values never cross this boundary. */
  connection?: FounderStackConnection;
  /** Roles refreshed by this invocation; omitted retains legacy full-replace behavior. */
  updatedRoles?: readonly FounderStackRole[];
  /** A full interactive wizard may replace, rather than extend, optional selection. */
  replaceOptionalRoles?: boolean;
  /** Change generated-output capture only when the founder selected that backend. */
  updateWritableCredentialBackend?: boolean;
  /** Immediate broker write; the reader closure is consumed and never persisted. */
  credentialWrites?: readonly {
    reference: string;
    provider: string;
    kind: CredentialKind;
    backend: "macos_keychain" | "onepassword";
    scopes: readonly string[];
    accountId?: string;
    readValue: () => Promise<string>;
  }[];
}

export interface CliServices {
  ideaSharpen?: (request: CliIdeaSharpenRequest) => Promise<JsonValue> | JsonValue;
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
