import type { CommandRunner, CredentialBroker, CredentialKind, Redactor } from "../credentials";

export const providerIds = [
  "github",
  "vercel",
  "neon",
  "stripe",
  "revenuecat",
  "brevo",
  "google",
  "bing",
  "dns",
  "mijndomein",
  "app_store_connect",
  "eas",
] as const;

export type ProviderId = (typeof providerIds)[number];

export type ProviderEnvironment = "local" | "preview" | "sandbox" | "production" | "testflight";

export type ProviderTransportKind = "cli" | "http" | "manual" | "mock";
export type ProviderRiskClass = "low" | "medium" | "high" | "critical";
export type ProviderEffectClass =
  | "read"
  | "local_write"
  | "reversible_external"
  | "irreversible_external"
  | "financial"
  | "communication"
  | "manual";
export type ProviderReversibility =
  "reversible" | "conditionally_reversible" | "irreversible" | "manual";
export type ProviderAuthMethod = CredentialKind | "manual" | "none";

export interface ProviderRateLimitPolicy {
  source: "provider_headers" | "provider_documentation" | "unknown";
  retryAfter: boolean;
  retryableStatusCodes: readonly number[];
  defaultMaxAttempts: number;
  notes: string;
}

export interface ProviderIdempotencyPolicy {
  mode: "native" | "client_ledger" | "native_and_client_ledger" | "manual";
  keyPlacement?: "header" | "command" | "request_body";
  notes: string;
}

export interface ProviderVerificationPolicy {
  mode: "read_back" | "response_and_read_back" | "manual";
  evidence: readonly string[];
  notes: string;
}

export interface ProviderCredentialRequirement {
  capabilities: readonly string[];
  acceptedKinds: readonly CredentialKind[];
  purpose: string;
}

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  capabilities: readonly string[];
  authMethods: readonly ProviderAuthMethod[];
  credentialRequirements?: readonly ProviderCredentialRequirement[];
  riskClass: ProviderRiskClass;
  effectClasses: readonly ProviderEffectClass[];
  reversibility: ProviderReversibility;
  requiredScopes: readonly string[];
  environments: readonly ProviderEnvironment[];
  rateLimits: ProviderRateLimitPolicy;
  idempotency: ProviderIdempotencyPolicy;
  verification: ProviderVerificationPolicy;
  redactionRules: readonly string[];
  transports: readonly ProviderTransportKind[];
  limitations: readonly string[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface CommandCredentialBinding {
  name: string;
  credentialRef: string;
}

export interface ProviderCommandSpec {
  binary: string;
  args: readonly string[];
  cwd?: string;
  authEnvironment?: CommandCredentialBinding;
  stdinCredentialRef?: string;
  /**
   * Stores one string field from successful JSON stdout directly behind an
   * already-registered writable credential reference. The raw field is added
   * to the redactor before any command result can leave the transport.
   */
  captureCredential?: {
    credentialRef: string;
    outputPath: string;
  };
}

export interface HttpAuthSpec {
  scheme: "bearer" | "basic" | "api_key_header" | "api_key_query" | "jwt";
  credentialRef: string;
  name?: string;
}

export interface ProviderHttpSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: JsonValue;
  encoding?: "json" | "form";
  auth?: HttpAuthSpec;
  nativeIdempotency?: boolean;
}

export interface ProviderManualSpec {
  system: string;
  url?: string;
  instructions: readonly string[];
  requiredFields: Readonly<Record<string, JsonPrimitive>>;
  completionEvidence: readonly string[];
}

export interface ProviderReadBackSpec {
  transport: Exclude<ProviderTransportKind, "manual">;
  command?: ProviderCommandSpec;
  http?: ProviderHttpSpec;
  description: string;
  assertions?: readonly {
    path: string;
    operator: "equals" | "exists" | "contains";
    expected?: JsonValue;
  }[];
}

export interface ProviderOperation {
  id: string;
  provider: ProviderId;
  capability: string;
  action: string;
  title: string;
  transport: ProviderTransportKind;
  environment: ProviderEnvironment;
  riskClass: ProviderRiskClass;
  effectClass: ProviderEffectClass;
  reversibility: ProviderReversibility;
  credentialRef?: string;
  idempotencyKey: string;
  /**
   * Re-run a deterministic reconciliation command even when the client ledger
   * has a successful entry. Use this when the command binds mutable local state
   * to remote state and must prove that they still match on every resume.
   */
  reconcileOnReplay?: boolean;
  dependsOn: readonly string[];
  command?: ProviderCommandSpec;
  http?: ProviderHttpSpec;
  manual?: ProviderManualSpec;
  readBack?: ProviderReadBackSpec;
  verification: {
    strategy: "response_then_read_back" | "read_back" | "manual";
    description: string;
  };
  /** Operator-side cost estimate for this operation, never a product price. */
  estimatedCost?: {
    amount: number;
    currency: string;
  };
  /** Exact recipients affected by an email-send operation. */
  emailRecipientCount?: number;
}

export interface ProviderPlan {
  id: string;
  provider: ProviderId;
  environment: ProviderEnvironment;
  dryRun: boolean;
  createdAt: string;
  operations: readonly ProviderOperation[];
  limitations: readonly string[];
}

export interface ProviderPlanRequest {
  environment: ProviderEnvironment;
  capabilities: readonly string[];
  credentialRef?: string;
  inputs: Readonly<Record<string, JsonValue | undefined>>;
  dryRun?: boolean;
}

export interface ProviderDoctorRequest {
  credentialRefs?: readonly string[];
  requiredCapabilities?: readonly string[];
}

export interface ProviderDoctorIssue {
  code:
    | "auth_missing"
    | "auth_invalid"
    | "transport_missing"
    | "capability_unknown"
    | "manual_required"
    | "provider_limitation";
  message: string;
  remediation: string;
}

export interface ProviderDoctorResult {
  provider: ProviderId;
  status: "ready" | "auth_required" | "degraded" | "manual_only" | "unavailable";
  credentialRefs: readonly {
    ref: string;
    status: string;
    scopes: readonly string[];
    expiresAt?: string;
  }[];
  transports: readonly {
    kind: ProviderTransportKind;
    available: boolean;
    detail?: string;
  }[];
  issues: readonly ProviderDoctorIssue[];
}

export interface ProviderTransportResult {
  status: "succeeded" | "failed" | "waiting_manual" | "skipped";
  providerCode?: string;
  statusCode?: number;
  message: string;
  output?: unknown;
  retryable?: boolean;
  verified?: boolean;
}

export interface ProviderReadBackResult {
  operationId: string;
  status: "matched" | "mismatched" | "unavailable" | "manual_required";
  message: string;
  evidence?: unknown;
}

export interface ProviderTransportContext {
  credentials?: CredentialBroker;
  redactor: Redactor;
  signal?: AbortSignal;
}

export interface ProviderTransport {
  readonly kind: ProviderTransportKind;
  available(): Promise<{ available: boolean; detail?: string }>;
  execute(
    operation: ProviderOperation,
    context: ProviderTransportContext,
  ): Promise<ProviderTransportResult>;
  readBack?(
    operation: ProviderOperation,
    execution: ProviderTransportResult,
    context: ProviderTransportContext,
  ): Promise<ProviderReadBackResult>;
}

export interface IdempotencyLedger {
  get(key: string): Promise<ProviderTransportResult | null>;
  put(key: string, result: ProviderTransportResult): Promise<void>;
}

export interface ProviderExecutionContext {
  /** External writes only run when this explicit authorization is present. */
  authorization: "dry_run" | "approved";
  transports: Partial<Record<ProviderTransportKind, ProviderTransport>>;
  credentials?: CredentialBroker;
  redactor: Redactor;
  idempotencyLedger?: IdempotencyLedger;
  signal?: AbortSignal;
}

export interface ProviderOperationExecution {
  operation: ProviderOperation;
  result: ProviderTransportResult;
  reused: boolean;
}

export interface ProviderExecutionReport {
  planId: string;
  provider: ProviderId;
  state: "planned" | "applied" | "degraded" | "failed" | "waiting_manual";
  operations: readonly ProviderOperationExecution[];
}

export interface ProviderReadBackReport {
  planId: string;
  provider: ProviderId;
  results: readonly ProviderReadBackResult[];
}

export interface ProviderVerificationReport {
  planId: string;
  provider: ProviderId;
  state: "verified" | "failed" | "pending" | "unavailable";
  checks: readonly ProviderReadBackResult[];
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  doctor(
    request: ProviderDoctorRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderDoctorResult>;
  plan(request: ProviderPlanRequest): ProviderPlan;
  apply(plan: ProviderPlan, context: ProviderExecutionContext): Promise<ProviderExecutionReport>;
  readBack(
    report: ProviderExecutionReport,
    context: ProviderExecutionContext,
  ): Promise<ProviderReadBackReport>;
  verify(
    report: ProviderExecutionReport,
    readBack: ProviderReadBackReport,
  ): ProviderVerificationReport;
}

export interface CommandExecutorOptions {
  runner: CommandRunner;
  available?: () => Promise<{ available: boolean; detail?: string }>;
}

export interface HttpRequest {
  method: ProviderHttpSpec["method"];
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  sensitiveHeaders: readonly string[];
  sensitiveUrl: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}

export interface HttpFetcher {
  fetch(request: HttpRequest): Promise<HttpResponse>;
}

export type JwtSigner = (privateKey: string, operation: ProviderOperation) => Promise<string>;

export class ProviderPlanError extends Error {
  constructor(
    message: string,
    readonly code: "missing_input" | "invalid_input" | "unknown_capability" | "invalid_plan",
  ) {
    super(message);
    this.name = "ProviderPlanError";
  }
}
