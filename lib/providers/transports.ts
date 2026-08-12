import { randomBytes } from "node:crypto";
import type { CommandInvocation } from "../credentials";
import { classifyProviderFailure } from "./retry";
import type {
  CommandExecutorOptions,
  HttpFetcher,
  HttpRequest,
  HttpResponse,
  IdempotencyClaim,
  IdempotencyLedger,
  JsonValue,
  JwtSigner,
  ProviderCommandSpec,
  ProviderHttpSpec,
  ProviderOperation,
  ProviderReadBackResult,
  ProviderTransport,
  ProviderTransportContext,
  ProviderTransportKind,
  ProviderTransportResult,
} from "./types";

function getPath(input: unknown, path: string): unknown {
  if (path === "") return input;
  return path.split(".").reduce<unknown>((value, part) => {
    if (Array.isArray(value) && !/^\d+$/.test(part)) {
      // Several official CLIs (notably EAS build --json) return an array even
      // when one platform was requested. A singleton is unambiguous; zero or
      // multiple results must not be guessed at.
      if (value.length !== 1) return undefined;
      value = value[0];
    }
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function interpolate(template: string, output: unknown): string {
  if (template === "{result}" && ["string", "number", "boolean"].includes(typeof output)) {
    return String(output);
  }
  return template.replace(/\{result\.([a-zA-Z0-9_.-]+)\}/g, (_match, path) => {
    const value = getPath(output, path);
    return ["string", "number", "boolean"].includes(typeof value) ? String(value) : _match;
  });
}

const RESULT_PLACEHOLDER = /\{result(?:\.[a-zA-Z0-9_.-]+)?\}/;

function interpolateJson(value: JsonValue | undefined, output: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const exact = value.match(/^\{result(?:\.([a-zA-Z0-9_.-]+))?\}$/);
    if (exact) {
      const resolved = exact[1] ? getPath(output, exact[1]) : output;
      if (
        resolved === null ||
        ["string", "number", "boolean"].includes(typeof resolved) ||
        Array.isArray(resolved) ||
        (typeof resolved === "object" && resolved !== null)
      ) {
        return resolved as JsonValue;
      }
      return value;
    }
    return interpolate(value, output);
  }
  if (Array.isArray(value)) return value.map((item) => interpolateJson(item, output)!);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateJson(item, output)!]),
    );
  }
  return value;
}

function hasUnresolvedResult(value: unknown): boolean {
  if (typeof value === "string") return RESULT_PLACEHOLDER.test(value);
  if (Array.isArray(value)) return value.some(hasUnresolvedResult);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasUnresolvedResult);
  }
  return false;
}

function resolvedAssertions(
  assertions: NonNullable<ProviderOperation["readBack"]>["assertions"],
  output: unknown,
): NonNullable<ProviderOperation["readBack"]>["assertions"] {
  return assertions?.map((assertion) => ({
    ...assertion,
    expected: interpolateJson(assertion.expected, output),
  }));
}

function deepContains(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual)) {
    if (Array.isArray(expected)) {
      return expected.every((expectedItem) =>
        actual.some((actualItem) => deepContains(actualItem, expectedItem)),
      );
    }
    return actual.some((item) => deepContains(item, expected));
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object" &&
    !Array.isArray(expected)
  ) {
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      deepContains((actual as Record<string, unknown>)[key], value),
    );
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  return false;
}

function assertionsMatch(
  output: unknown,
  assertions: NonNullable<ProviderOperation["readBack"]>["assertions"],
): boolean {
  if (!assertions || assertions.length === 0) return false;
  return assertions.every((assertion) => {
    const actual = assertion.path === "" ? output : getPath(output, assertion.path);
    if (assertion.operator === "exists") return actual !== undefined && actual !== null;
    if (assertion.operator === "equals") return Object.is(actual, assertion.expected);
    return deepContains(actual, assertion.expected);
  });
}

function assertionReadBackStatus(
  output: unknown,
  assertions: NonNullable<ProviderOperation["readBack"]>["assertions"],
): ProviderReadBackResult["status"] {
  if (!assertions || assertions.length === 0) return "unavailable";
  return assertionsMatch(output, assertions) ? "matched" : "mismatched";
}

function parseOutput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isDirectBinary(binary: string): boolean {
  const trimmed = binary.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return false;
  const name = trimmed.split("/").at(-1)?.toLowerCase() ?? trimmed.toLowerCase();
  return !["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].includes(name);
}

function commandErrorIsTransient(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return ["EAI_AGAIN", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "ETIMEDOUT"].includes(code);
}

async function withCredential<T>(
  context: ProviderTransportContext,
  ref: string,
  use: (secret: string) => Promise<T>,
): Promise<T> {
  if (!context.credentials) {
    throw new Error(`Credential broker is required for ${ref}`);
  }
  return context.credentials.withSecret(ref, (secret) => use(secret));
}

export class InMemoryIdempotencyLedger implements IdempotencyLedger {
  readonly durability = "fixture_only" as const;
  private readonly ledgerId = `fixture_${randomBytes(32).toString("hex")}`;
  private readonly results = new Map<
    string,
    {
      requestHash?: string;
      state: "succeeded" | "definitive_no_write" | "pending_reconciliation";
      result: ProviderTransportResult;
    }
  >();

  async identity(): Promise<string> {
    return this.ledgerId;
  }

  async get(key: string): Promise<ProviderTransportResult | null> {
    return this.results.get(key)?.result ?? null;
  }

  async put(key: string, result: ProviderTransportResult): Promise<void> {
    const existing = this.results.get(key);
    this.results.set(key, {
      requestHash: existing?.requestHash,
      state: result.status === "succeeded" ? "succeeded" : "pending_reconciliation",
      result,
    });
  }

  async claim(key: string, requestHash: string): Promise<IdempotencyClaim> {
    const existing = this.results.get(key);
    if (!existing) {
      this.results.set(key, {
        requestHash,
        state: "pending_reconciliation",
        result: {
          status: "failed",
          providerCode: "unknown_outcome_reconciliation_required",
          message: "Provider operation was claimed before execution",
          retryable: false,
          effectOutcome: "unknown",
        },
      });
      return { status: "acquired" };
    }
    if (!existing.requestHash || existing.requestHash !== requestHash) {
      return { status: "conflict" };
    }
    if (existing.state === "succeeded") {
      return { status: "replay", result: existing.result };
    }
    if (existing.state === "pending_reconciliation") {
      return { status: "pending_reconciliation", result: existing.result };
    }
    existing.state = "pending_reconciliation";
    existing.result = {
      status: "failed",
      providerCode: "unknown_outcome_reconciliation_required",
      message: "Provider operation was claimed before retry",
      retryable: false,
      effectOutcome: "unknown",
    };
    return { status: "acquired" };
  }

  async settle(
    key: string,
    requestHash: string,
    state: "succeeded" | "definitive_no_write" | "pending_reconciliation",
    result: ProviderTransportResult,
  ): Promise<void> {
    const existing = this.results.get(key);
    if (!existing || existing.requestHash !== requestHash) {
      throw new Error("Provider idempotency settlement does not match the claimed request");
    }
    this.results.set(key, { requestHash, state, result });
  }
}

export class CommandProviderTransport implements ProviderTransport {
  readonly kind = "cli" as const;
  private readonly runner: CommandExecutorOptions["runner"];
  private readonly availability: NonNullable<CommandExecutorOptions["available"]>;

  constructor(options: CommandExecutorOptions) {
    this.runner = options.runner;
    this.availability = options.available ?? (async () => ({ available: true as const }));
  }

  available(): Promise<{ available: boolean; detail?: string }> {
    return this.availability();
  }

  async execute(
    operation: ProviderOperation,
    context: ProviderTransportContext,
  ): Promise<ProviderTransportResult> {
    if (!operation.command) {
      return {
        status: "failed",
        message: "CLI operation is missing a command specification",
        retryable: false,
        effectOutcome: "confirmed_no_write",
      };
    }
    return this.runSpec(operation.command, operation, context);
  }

  async readBack(
    operation: ProviderOperation,
    execution: ProviderTransportResult,
    context: ProviderTransportContext,
  ): Promise<ProviderReadBackResult> {
    const spec = operation.readBack?.command;
    if (!spec) {
      return {
        operationId: operation.id,
        status: execution.verified ? "matched" : "unavailable",
        message: execution.verified
          ? "The command response carried verification evidence"
          : "No CLI read-back command is declared",
      };
    }
    const resolved: ProviderCommandSpec = {
      ...spec,
      args: spec.args.map((arg) => interpolate(arg, execution.output)),
    };
    const assertions = resolvedAssertions(operation.readBack?.assertions, execution.output);
    if (hasUnresolvedResult(resolved.args) || hasUnresolvedResult(assertions)) {
      return {
        operationId: operation.id,
        status: "unavailable",
        message:
          "CLI read-back was not run because the apply result did not contain one unambiguous value for every {result...} placeholder",
      };
    }
    const result = await this.runSpec(resolved, operation, context);
    const status =
      result.status === "succeeded"
        ? assertionReadBackStatus(result.output, assertions)
        : "unavailable";
    return {
      operationId: operation.id,
      status,
      message:
        status === "matched"
          ? (operation.readBack?.description ?? "CLI read-back succeeded")
          : result.status === "succeeded"
            ? status === "mismatched"
              ? "CLI read-back contradicted a declared assertion for the requested state"
              : "CLI read-back succeeded but no declared assertion proved the requested state"
            : result.message,
      evidence: result.output,
    };
  }

  private async runSpec(
    spec: ProviderCommandSpec,
    operation: ProviderOperation,
    context: ProviderTransportContext,
  ): Promise<ProviderTransportResult> {
    if (!isDirectBinary(spec.binary)) {
      return {
        status: "failed",
        providerCode: "shell_binary_forbidden",
        message: `Commands must invoke an executable directly: ${spec.binary}`,
        retryable: false,
        effectOutcome: "confirmed_no_write",
      };
    }
    const invoke = async (
      authSecret?: string,
      stdinSecret?: string,
    ): Promise<ProviderTransportResult> => {
      const env = spec.authEnvironment ? { [spec.authEnvironment.name]: authSecret } : undefined;
      const invocation: CommandInvocation = {
        command: spec.binary,
        args: [...spec.args],
        cwd: spec.cwd,
        env,
        sensitiveEnv: spec.authEnvironment ? [spec.authEnvironment.name] : undefined,
        stdin: stdinSecret,
        sensitiveStdin: stdinSecret !== undefined,
      };
      try {
        const result = await this.runner.run(invocation);
        if (result.exitCode === 0) {
          const parsedOutput = parseOutput(result.stdout);
          if (spec.captureCredential) {
            if (!context.credentials) {
              return {
                status: "failed",
                providerCode: "terminal_validation",
                message: "Credential capture requires an injected credential broker",
                retryable: false,
              };
            }
            const reference = context.credentials.getReference(
              spec.captureCredential.credentialRef,
            );
            if (!reference) {
              return {
                status: "failed",
                providerCode: "terminal_validation",
                message: `Credential capture target is not registered: ${spec.captureCredential.credentialRef}`,
                retryable: false,
              };
            }
            const captured = getPath(parsedOutput, spec.captureCredential.outputPath);
            if (typeof captured !== "string" || captured.length === 0) {
              return {
                status: "failed",
                providerCode: "terminal_validation",
                message: `Command output did not contain a string at ${spec.captureCredential.outputPath}`,
                retryable: false,
              };
            }
            try {
              await context.credentials.store({ ...reference, value: captured });
            } catch (error) {
              return {
                status: "failed",
                providerCode: "terminal_validation",
                message: context.redactor.redactText(
                  error instanceof Error ? error.message : String(error),
                ),
                retryable: false,
              };
            }
          }
          const output = context.redactor.redact(parsedOutput);
          return {
            status: "succeeded",
            message: `${operation.action} command completed; read-back is still required`,
            output,
            effectOutcome: "confirmed_write",
          };
        }
        return {
          status: "failed",
          providerCode: `exit_${result.exitCode}`,
          message: context.redactor.redactText(
            result.stderr || `${operation.action} exited with ${result.exitCode}`,
          ),
          retryable: false,
          effectOutcome: "unknown",
        };
      } catch (error) {
        const decision = classifyProviderFailure({
          networkError: commandErrorIsTransient(error),
        });
        return {
          status: "failed",
          providerCode: decision.classification,
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          retryable: decision.retryable,
          effectOutcome: "unknown",
        };
      }
    };

    const withStdin = (authSecret?: string) =>
      spec.stdinCredentialRef
        ? withCredential(context, spec.stdinCredentialRef, (secret) => invoke(authSecret, secret))
        : invoke(authSecret);

    return spec.authEnvironment
      ? withCredential(context, spec.authEnvironment.credentialRef, withStdin)
      : withStdin();
  }
}

function flattenForm(
  value: JsonValue,
  prefix = "",
  entries: Array<[string, string]> = [],
): Array<[string, string]> {
  if (value === null) {
    entries.push([prefix, ""]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => flattenForm(item, `${prefix}[${index}]`, entries));
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flattenForm(item, prefix ? `${prefix}[${key}]` : key, entries);
    }
  } else {
    entries.push([prefix, String(value)]);
  }
  return entries;
}

function encodeBody(spec: ProviderHttpSpec): {
  body?: string;
  contentType?: string;
} {
  if (spec.body === undefined) return {};
  if (spec.encoding === "form") {
    return {
      body: new URLSearchParams(flattenForm(spec.body)).toString(),
      contentType: "application/x-www-form-urlencoded",
    };
  }
  return { body: JSON.stringify(spec.body), contentType: "application/json" };
}

function credentialPreflightHasSafeOrigins(spec: ProviderHttpSpec): boolean {
  if (!spec.credentialPreflight) return true;
  try {
    const target = new URL(spec.url);
    if (target.protocol !== "https:" || target.username || target.password) return false;
    return spec.credentialPreflight.requests.every(({ url }) => {
      const preflight = new URL(url);
      return (
        preflight.protocol === "https:" &&
        !preflight.username &&
        !preflight.password &&
        preflight.origin === target.origin
      );
    });
  } catch {
    return false;
  }
}

export class HttpProviderTransport implements ProviderTransport {
  readonly kind = "http" as const;

  constructor(
    private readonly fetcher: HttpFetcher,
    private readonly availability: () => Promise<{
      available: boolean;
      detail?: string;
    }> = async () => ({ available: true }),
    private readonly jwtSigner?: JwtSigner,
  ) {}

  available(): Promise<{ available: boolean; detail?: string }> {
    return this.availability();
  }

  async execute(
    operation: ProviderOperation,
    context: ProviderTransportContext,
  ): Promise<ProviderTransportResult> {
    if (!operation.http) {
      return {
        status: "failed",
        message: "HTTP operation is missing a request specification",
        retryable: false,
        effectOutcome: "confirmed_no_write",
      };
    }
    return this.runSpec(operation.http, operation, context);
  }

  async readBack(
    operation: ProviderOperation,
    execution: ProviderTransportResult,
    context: ProviderTransportContext,
  ): Promise<ProviderReadBackResult> {
    const source = operation.readBack?.http;
    if (!source) {
      return {
        operationId: operation.id,
        status: execution.verified ? "matched" : "unavailable",
        message: execution.verified
          ? "The API response carried verification evidence"
          : "No HTTP read-back request is declared",
      };
    }
    const spec: ProviderHttpSpec = {
      ...source,
      url: interpolate(source.url, execution.output),
    };
    const assertions = resolvedAssertions(operation.readBack?.assertions, execution.output);
    if (hasUnresolvedResult(spec.url) || hasUnresolvedResult(assertions)) {
      return {
        operationId: operation.id,
        status: "unavailable",
        message:
          "API read-back was not run because the apply result did not contain one unambiguous value for every {result...} placeholder",
      };
    }
    const result = await this.runSpec(spec, operation, context);
    const status =
      result.status === "succeeded"
        ? assertionReadBackStatus(result.output, assertions)
        : "unavailable";
    return {
      operationId: operation.id,
      status,
      message:
        status === "matched"
          ? (operation.readBack?.description ?? "API read-back succeeded")
          : result.status === "succeeded"
            ? status === "mismatched"
              ? "API read-back contradicted a declared assertion for the requested state"
              : "API read-back succeeded but no declared assertion proved the requested state"
            : result.message,
      evidence: result.output,
    };
  }

  private async runSpec(
    spec: ProviderHttpSpec,
    operation: ProviderOperation,
    context: ProviderTransportContext,
  ): Promise<ProviderTransportResult> {
    const send = async (secret?: string): Promise<ProviderTransportResult> => {
      let url = spec.url;
      const headers: Record<string, string> = { ...(spec.headers ?? {}) };
      const sensitiveHeaders: string[] = [];
      if (spec.auth && secret !== undefined) {
        if (spec.auth.scheme === "bearer" || spec.auth.scheme === "jwt") {
          headers.Authorization = `Bearer ${secret}`;
          sensitiveHeaders.push("authorization");
        } else if (spec.auth.scheme === "basic") {
          const encoded = Buffer.from(`${secret}:`).toString("base64");
          context.redactor.addSecret(encoded);
          headers.Authorization = `Basic ${encoded}`;
          sensitiveHeaders.push("authorization");
        } else if (spec.auth.scheme === "api_key_header") {
          const name = spec.auth.name ?? "api-key";
          headers[name] = secret;
          sensitiveHeaders.push(name.toLowerCase());
        } else {
          const parsed = new URL(url);
          parsed.searchParams.set(spec.auth.name ?? "apikey", secret);
          url = parsed.toString();
        }
      }
      if (spec.credentialPreflight) {
        if (
          !spec.auth ||
          secret === undefined ||
          spec.credentialPreflight.requests.length === 0 ||
          spec.credentialPreflight.requests.length > 4 ||
          spec.credentialPreflight.requests.some(({ assertions }) => assertions.length === 0) ||
          !credentialPreflightHasSafeOrigins(spec)
        ) {
          return {
            status: "failed",
            providerCode: "credential_preflight_invalid",
            message: "Credential preflight is incomplete; the provider mutation was not sent",
            retryable: false,
            effectOutcome: "confirmed_no_write",
          };
        }
        for (const preflight of spec.credentialPreflight.requests) {
          let preflightUrl = preflight.url;
          if (spec.auth.scheme === "api_key_query") {
            const parsed = new URL(preflightUrl);
            parsed.searchParams.set(spec.auth.name ?? "apikey", secret);
            preflightUrl = parsed.toString();
          }
          let response: HttpResponse;
          try {
            response = await this.fetcher.fetch({
              method: "GET",
              url: preflightUrl,
              headers: { ...headers },
              sensitiveHeaders: [...sensitiveHeaders],
              sensitiveUrl: spec.auth.scheme === "api_key_query",
              signal: context.signal,
            });
          } catch (error) {
            const decision = classifyProviderFailure({ networkError: true });
            return {
              status: "failed",
              providerCode: decision.classification,
              message: context.redactor.redactText(
                error instanceof Error
                  ? `Credential preflight was unavailable: ${error.message}`
                  : "Credential preflight was unavailable",
              ),
              retryable: decision.retryable,
              effectOutcome: "confirmed_no_write",
            };
          }
          if (response.status < 200 || response.status >= 300) {
            const decision = classifyProviderFailure({
              statusCode: response.status,
              retryAfter: response.headers?.["retry-after"],
            });
            return {
              status: "failed",
              statusCode: response.status,
              providerCode: decision.classification,
              message: `Credential preflight returned HTTP ${response.status}; the provider mutation was not sent`,
              retryable: decision.retryable,
              effectOutcome: "confirmed_no_write",
            };
          }
          if (!assertionsMatch(response.body, preflight.assertions)) {
            return {
              status: "failed",
              providerCode: "credential_preflight_mismatch",
              message:
                "Credential preflight did not match the exact provider account and mode; the provider mutation was not sent",
              retryable: false,
              effectOutcome: "confirmed_no_write",
            };
          }
        }
      }
      if (spec.nativeIdempotency) {
        headers["Idempotency-Key"] = operation.idempotencyKey;
      }
      const encoded = encodeBody(spec);
      if (encoded.contentType && !headers["Content-Type"]) {
        headers["Content-Type"] = encoded.contentType;
      }
      const request: HttpRequest = {
        method: spec.method,
        url,
        headers,
        body: encoded.body,
        sensitiveHeaders,
        sensitiveUrl: spec.auth?.scheme === "api_key_query",
        signal: context.signal,
      };
      let response: HttpResponse;
      try {
        response = await this.fetcher.fetch(request);
      } catch (error) {
        const decision = classifyProviderFailure({ networkError: true });
        return {
          status: "failed",
          providerCode: decision.classification,
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          retryable: decision.retryable,
          effectOutcome: "unknown",
        };
      }
      if (response.status >= 200 && response.status < 300) {
        if (spec.captureCredential) {
          if (!context.credentials) {
            return {
              status: "failed",
              providerCode: "terminal_validation",
              message: "Credential capture requires an injected credential broker",
              retryable: false,
              effectOutcome: "unknown",
            };
          }
          const reference = context.credentials.getReference(spec.captureCredential.credentialRef);
          if (!reference) {
            return {
              status: "failed",
              providerCode: "terminal_validation",
              message: `Credential capture target is not registered: ${spec.captureCredential.credentialRef}`,
              retryable: false,
              effectOutcome: "unknown",
            };
          }
          const captured = getPath(response.body, spec.captureCredential.outputPath);
          if (typeof captured !== "string" || captured.length === 0) {
            return {
              status: "failed",
              providerCode: "terminal_validation",
              message: `HTTP response did not contain a string at ${spec.captureCredential.outputPath}`,
              retryable: false,
              effectOutcome: "unknown",
            };
          }
          try {
            await context.credentials.store({ ...reference, value: captured });
            context.redactor.addSecret(captured);
          } catch (error) {
            return {
              status: "failed",
              providerCode: "terminal_validation",
              message: context.redactor.redactText(
                error instanceof Error ? error.message : "Credential capture failed",
              ),
              retryable: false,
              effectOutcome: "unknown",
            };
          }
        }
        const output = context.redactor.redact(response.body);
        return {
          status: "succeeded",
          statusCode: response.status,
          message:
            operation.effectClass === "read"
              ? `${operation.action} returned HTTP ${response.status}; no provider write was requested`
              : `${operation.action} returned HTTP ${response.status}; read-back is still required`,
          output,
          effectOutcome:
            operation.effectClass === "read" ? "confirmed_no_write" : "confirmed_write",
        };
      }
      const output = context.redactor.redact(response.body);
      const retryAfter = response.headers?.["retry-after"];
      const decision = classifyProviderFailure({
        statusCode: response.status,
        retryAfter,
      });
      return {
        status: "failed",
        statusCode: response.status,
        providerCode: decision.classification,
        message: `Provider returned HTTP ${response.status}`,
        output,
        retryable: decision.retryable,
        effectOutcome: ["retryable_rate_limit", "terminal_auth", "terminal_validation"].includes(
          decision.classification,
        )
          ? "confirmed_no_write"
          : "unknown",
      };
    };
    if (!spec.auth) return send();
    return withCredential(context, spec.auth.credentialRef, async (secret) => {
      if (spec.auth?.scheme !== "jwt") return send(secret);
      if (!this.jwtSigner) {
        return {
          status: "failed",
          providerCode: "jwt_signer_missing",
          message: "A JWT signer must be injected for private-key authentication",
          retryable: false,
          effectOutcome: "confirmed_no_write",
        };
      }
      try {
        const token = await this.jwtSigner(secret, operation);
        context.redactor.addSecret(token);
        return send(token);
      } catch (error) {
        return {
          status: "failed",
          providerCode: "jwt_signing_failed",
          message: context.redactor.redactText(
            error instanceof Error ? error.message : String(error),
          ),
          retryable: false,
          effectOutcome: "confirmed_no_write",
        };
      }
    });
  }
}

export class ManualProviderTransport implements ProviderTransport {
  readonly kind = "manual" as const;

  async available(): Promise<{ available: boolean; detail?: string }> {
    return { available: true, detail: "Human completion is required" };
  }

  async execute(operation: ProviderOperation): Promise<ProviderTransportResult> {
    return {
      status: "waiting_manual",
      message: operation.manual
        ? `Manual action required in ${operation.manual.system}`
        : "Manual action is missing instructions",
      retryable: false,
      effectOutcome: "confirmed_no_write",
    };
  }

  async readBack(operation: ProviderOperation): Promise<ProviderReadBackResult> {
    return {
      operationId: operation.id,
      status: "manual_required",
      message: "A human must provide the declared completion evidence",
    };
  }
}

export type MockTransportHandler = (
  operation: ProviderOperation,
) => ProviderTransportResult | Promise<ProviderTransportResult>;

export class MockProviderTransport implements ProviderTransport {
  readonly calls: ProviderOperation[] = [];

  constructor(
    readonly kind: ProviderTransportKind,
    private readonly handler: MockTransportHandler = async () => ({
      status: "succeeded",
      message: "Mock operation completed",
      verified: true,
    }),
    private readonly readBackHandler?: (
      operation: ProviderOperation,
      execution: ProviderTransportResult,
    ) => ProviderReadBackResult | Promise<ProviderReadBackResult>,
  ) {}

  async available(): Promise<{ available: boolean; detail?: string }> {
    return { available: true, detail: "Injected mock transport" };
  }

  async execute(operation: ProviderOperation): Promise<ProviderTransportResult> {
    this.calls.push(operation);
    return this.handler(operation);
  }

  async readBack(
    operation: ProviderOperation,
    execution: ProviderTransportResult,
  ): Promise<ProviderReadBackResult> {
    if (this.readBackHandler) return this.readBackHandler(operation, execution);
    return {
      operationId: operation.id,
      status: execution.verified ? "matched" : "unavailable",
      message: execution.verified
        ? "Mock result was marked verified"
        : "Mock result did not include verification evidence",
      evidence: execution.output,
    };
  }
}

export function transportMap(
  ...transports: readonly ProviderTransport[]
): Partial<Record<ProviderTransportKind, ProviderTransport>> {
  return Object.fromEntries(transports.map((transport) => [transport.kind, transport]));
}
