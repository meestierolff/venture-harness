import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { CommandInvocation, CommandResult, CommandRunner } from "@/lib/credentials";
import {
  ensureVerifiedGitHubWorkingRepository,
  getProviderAdapter,
  type GitHubWorkingRepositoryCloner,
  type HttpFetcher,
  type HttpRequest,
  type HttpResponse,
  type JsonValue,
  type ProviderOperation,
} from "@/lib/providers";
import type { ProviderWorkflowPlanRequest } from "@/lib/runtime";

type FixturePhase = "apply" | "read_back";

export interface OfficialTransportFixtureRegistration {
  provider: string;
  operationId: string;
  action: string;
  capability: string;
  transport: "cli" | "http";
  phases: FixturePhase[];
}

export interface OfficialTransportFixtureInvocation {
  transport: "cli" | "http";
  key: string;
  registered: OfficialTransportFixtureRegistration[];
  sensitiveInput: boolean;
}

interface FixtureInteraction {
  output: unknown;
  registrations: OfficialTransportFixtureRegistration[];
}

interface CommandFixtureTemplate {
  key: string;
  command: string;
  args: readonly string[];
  cwd?: string;
}

interface HttpFixtureTemplate {
  key: string;
  method: string;
  url: string;
  body?: string;
}

export interface RegisteredOfficialProviderPlan {
  provider: string;
  planId: string;
  adapterConstructor: string;
  operations: Array<{
    id: string;
    action: string;
    capability: string;
    transport: string;
  }>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}

function commandKey(input: { command: string; args: readonly string[]; cwd?: string }): string {
  return stable({ command: input.command, args: [...input.args], cwd: input.cwd ?? null });
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  for (const name of ["apikey", "api_key", "access_token", "token"]) {
    url.searchParams.delete(name);
  }
  return url.toString();
}

function httpKey(input: { method: string; url: string; body?: string }): string {
  return stable({
    method: input.method,
    url: normalizedUrl(input.url),
    body: input.body ?? null,
  });
}

function getPath(input: unknown, path: string): unknown {
  if (!path) return input;
  return path.split(".").reduce<unknown>((value, part) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || Array.isArray(existing) || typeof existing !== "object") cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function placeholderValue(path: string, operation: ProviderOperation): string | boolean {
  const suffix = digest(`${operation.provider}:${operation.id}:${path}`).slice(0, 12);
  if (path === "branch") return "main";
  if (path === "commitOid") return "c".repeat(40);
  if (path === "treeOid") return "d".repeat(40);
  if (path === "url") return `https://${operation.provider}-${suffix}.fixture.invalid`;
  if (path === "verified") return true;
  if (path === "token") return `google-site-verification=fixture-${suffix}`;
  if (path === "name" && operation.capability === "analytics_property") {
    return `properties/${suffix}`;
  }
  if (path === "name" && operation.capability === "analytics_web_stream") {
    return `properties/fixture/dataStreams/${suffix}`;
  }
  return `fixture-${path.replaceAll(".", "-")}-${suffix}`;
}

function placeholders(value: unknown): string[] {
  const matches = stable(value).matchAll(/\{result\.([A-Za-z0-9_.-]+)\}/g);
  return [...new Set([...matches].map((match) => match[1]!))];
}

function interpolate(value: unknown, output: unknown): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{result\.([A-Za-z0-9_.-]+)\}$/);
    if (exact) return getPath(output, exact[1]!);
    return value.replace(/\{result\.([A-Za-z0-9_.-]+)\}/g, (match, path: string) => {
      const selected = getPath(output, path);
      return ["string", "number", "boolean"].includes(typeof selected) ? String(selected) : match;
    });
  }
  if (Array.isArray(value)) return value.map((child) => interpolate(child, output));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        interpolate(child, output),
      ]),
    );
  }
  return value;
}

function deepMerge(left: unknown, right: unknown): unknown {
  if (left === undefined) return structuredClone(right);
  if (right === undefined) return structuredClone(left);
  if (Array.isArray(left) && Array.isArray(right)) {
    const values = new Map<string, unknown>();
    for (const value of [...left, ...right]) values.set(stable(value), structuredClone(value));
    return [...values.values()];
  }
  if (
    left &&
    right &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const output: Record<string, unknown> = structuredClone(left as Record<string, unknown>);
    for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
      output[key] = deepMerge(output[key], value);
    }
    return output;
  }
  if (typeof left === "string" && typeof right === "string" && left !== right) {
    return [...new Set([left, right])].join("\n");
  }
  return structuredClone(right);
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function formEntries(
  value: JsonValue,
  prefix = "",
  entries: Array<[string, string]> = [],
): Array<[string, string]> {
  if (value === null) entries.push([prefix, ""]);
  else if (Array.isArray(value)) {
    value.forEach((child, index) => formEntries(child, `${prefix}[${index}]`, entries));
  } else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      formEntries(child, prefix ? `${prefix}[${key}]` : key, entries);
    }
  } else entries.push([prefix, String(value)]);
  return entries;
}

function encodedBody(operation: ProviderOperation, readBack: boolean): string | undefined {
  const spec = readBack ? operation.readBack?.http : operation.http;
  if (!spec?.body) return undefined;
  return spec.encoding === "form"
    ? new URLSearchParams(formEntries(spec.body)).toString()
    : JSON.stringify(spec.body);
}

function templateStringMatches(template: string, actual: string): boolean {
  return templateBindings(template, actual) !== undefined;
}

function templateBindings(template: string, actual: string): Record<string, string> | undefined {
  const placeholder = /\{(?:dependency|result)\.[^}]+\}|%7B(?:dependency|result)\.[^%]+%7D/giu;
  const placeholders = [...template.matchAll(placeholder)];
  let cursor = 0;
  let pattern = "^";
  for (const match of placeholders) {
    const index = match.index ?? 0;
    pattern += template.slice(cursor, index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern += "(.+?)";
    cursor = index + match[0].length;
  }
  pattern += template.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  pattern += "$";
  const matched = new RegExp(pattern, "u").exec(actual);
  if (!matched) return undefined;
  const bindings: Record<string, string> = {};
  for (const [index, item] of placeholders.entries()) {
    const token = decodeURIComponent(item[0]);
    const captured = item[0].startsWith("%")
      ? decodeURIComponent(matched[index + 1]!)
      : matched[index + 1]!;
    if (bindings[token] !== undefined && bindings[token] !== captured) return undefined;
    bindings[token] = captured;
  }
  return bindings;
}

function interpolateBindings(value: unknown, bindings: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    if (bindings[value] !== undefined) return bindings[value];
    return Object.entries(bindings).reduce(
      (output, [placeholder, materialized]) => output.replaceAll(placeholder, materialized),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((child) => interpolateBindings(child, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        interpolateBindings(child, bindings),
      ]),
    );
  }
  return value;
}

function applyOutput(operation: ProviderOperation): Record<string, unknown> {
  const suffix = digest(operation.id).slice(0, 12);
  const output: Record<string, unknown> = {
    fixture: true,
    fixtureProvenance: "official_transport_underlying_fixture",
    id: `fixture-${operation.provider}-${suffix}`,
  };
  for (const path of placeholders({ readBack: operation.readBack })) {
    setPath(output, path, placeholderValue(path, operation));
  }
  if (operation.http?.captureCredential) {
    const capture = operation.http.captureCredential;
    const value =
      operation.provider === "stripe"
        ? `whsec_fixture_${suffix}`
        : operation.provider === "google"
          ? `G-FIXTURE${suffix.toUpperCase()}`
          : `fixture-captured-${suffix}`;
    setPath(output, capture.outputPath, value);
  }
  if (operation.command?.captureCredential) {
    const capture = operation.command.captureCredential;
    setPath(output, capture.outputPath, `postgresql://fixture:fixture@fixture.invalid/${suffix}`);
  }
  if (operation.provider === "brevo" && operation.capability === "sending_domain") {
    Object.assign(output, {
      domain_name: "exception-desk.example.test",
      dns_records: {
        dkim: {
          type: "TXT",
          host_name: "mail._domainkey",
          value: `brevo-code=fixture-${suffix}`,
          ttl: 3600,
        },
      },
    });
  }
  if (operation.provider === "vercel" && operation.capability === "domain") {
    output.verification = [
      {
        type: "CNAME",
        domain: "exception-desk.example.test",
        target: "cname.fixture.vercel-dns.invalid",
        ttl: 300,
      },
    ];
  }
  if (operation.provider === "google" && operation.capability === "site_verification_token") {
    output.method = "DNS_TXT";
    output.token = `google-site-verification=fixture-${suffix}`;
  }
  if (operation.provider === "vercel" && operation.capability === "deployment") {
    output.id = `dpl_${suffix}`;
    output.url = `https://exception-desk-${suffix}.fixture.vercel.app`;
    output.readyState = "READY";
  }
  return output;
}

function readBackOutput(operation: ProviderOperation, execution: unknown): unknown {
  const assertions = operation.readBack?.assertions ?? [];
  let root: unknown = {};
  const rootStrings: string[] = [];
  for (const assertion of assertions) {
    const expected = interpolate(assertion.expected, execution);
    if (assertion.path === "") {
      if (assertion.operator === "contains" && typeof expected === "string") {
        rootStrings.push(expected);
      } else if (expected !== undefined) {
        root = deepMerge(root, expected);
      }
      continue;
    }
    if (!root || Array.isArray(root) || typeof root !== "object") root = {};
    setPath(
      root as Record<string, unknown>,
      assertion.path,
      assertion.operator === "exists" ? `fixture-${digest(operation.id).slice(0, 8)}` : expected,
    );
  }
  if (rootStrings.length > 0) {
    const evidence = rootStrings.join("\n");
    root = isEmptyRecord(root) ? evidence : deepMerge(evidence, root);
  }
  if (operation.provider === "brevo" && operation.capability === "sending_domain") {
    root = deepMerge(root, applyOutput(operation));
  }
  if (operation.provider === "vercel" && operation.capability === "domain") {
    const providerOutput = applyOutput(operation);
    root = typeof root === "string" ? [root, providerOutput] : deepMerge(root, providerOutput);
  }
  if (operation.provider === "google" && operation.capability === "site_verification_token") {
    root = deepMerge(root, applyOutput(operation));
  }
  if (operation.provider === "vercel" && operation.capability === "deployment") {
    root = deepMerge(root, {
      id: getPath(execution, "id"),
      readyState: "READY",
      url: getPath(execution, "url"),
    });
  }
  return root;
}

function credentialPreflightOutput(
  operation: ProviderOperation,
  assertions: NonNullable<
    NonNullable<ProviderOperation["http"]>["credentialPreflight"]
  >["requests"][number]["assertions"],
): unknown {
  let root: unknown = {};
  for (const assertion of assertions) {
    const expected =
      assertion.operator === "exists"
        ? `fixture-${digest(`${operation.id}:${assertion.path}`).slice(0, 8)}`
        : assertion.expected;
    if (assertion.path === "") {
      if (expected !== undefined) root = expected;
      continue;
    }
    if (!root || Array.isArray(root) || typeof root !== "object") root = {};
    setPath(root as Record<string, unknown>, assertion.path, expected);
  }
  return root;
}

function registration(
  operation: ProviderOperation,
  phase: FixturePhase,
): OfficialTransportFixtureRegistration {
  return {
    provider: operation.provider,
    operationId: operation.id,
    action: operation.action,
    capability: operation.capability,
    transport: operation.transport as "cli" | "http",
    phases: [phase],
  };
}

/**
 * Fixture beneath the production CommandProviderTransport/HttpProviderTransport.
 * It never replaces adapters or transport logic: plans register their exact direct
 * command/API requests, then this boundary returns deterministic local evidence.
 */
export class FounderGoldenPathOfficialTransportFixture implements CommandRunner, HttpFetcher {
  readonly registeredPlans: RegisteredOfficialProviderPlan[] = [];
  readonly invocations: OfficialTransportFixtureInvocation[] = [];
  readonly #commands = new Map<string, FixtureInteraction>();
  readonly #http = new Map<string, FixtureInteraction>();
  readonly #commandTemplates: CommandFixtureTemplate[] = [];
  readonly #httpTemplates: HttpFixtureTemplate[] = [];
  readonly #operationBindings = new Map<string, Record<string, string>>();
  readonly #fixtureRoot: string;
  readonly #expectedChildRoot: string;

  constructor(options: { fixtureRoot: string; expectedChildRoot: string }) {
    this.#fixtureRoot = resolve(options.fixtureRoot);
    this.#expectedChildRoot = resolve(options.expectedChildRoot);
    mkdirSync(this.#fixtureRoot, { recursive: true });
  }

  register(target: ProviderWorkflowPlanRequest): ProviderWorkflowPlanRequest {
    const adapter = target.adapter ?? getProviderAdapter(target.provider);
    const plan = adapter.plan({ ...target.request, dryRun: false });
    this.registeredPlans.push({
      provider: plan.provider,
      planId: plan.id,
      adapterConstructor: adapter.constructor.name,
      operations: plan.operations.map(({ id, action, capability, transport }) => ({
        id,
        action,
        capability,
        transport,
      })),
    });
    for (const operation of plan.operations) this.#registerOperation(operation);
    return target;
  }

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    if (this.#isGitPublish(invocation)) return this.#runGitPublish(invocation);
    const key = commandKey(invocation);
    const interaction = this.#commands.get(key) ?? this.#commandTemplateInteraction(invocation);
    if (!interaction) {
      throw new Error(
        `Unregistered official CLI fixture request: ${invocation.command} ${invocation.args.join(" ")}`,
      );
    }
    this.invocations.push({
      transport: "cli",
      key,
      registered: structuredClone(interaction.registrations),
      sensitiveInput: Boolean(invocation.sensitiveStdin || invocation.sensitiveEnv?.length),
    });
    return {
      exitCode: 0,
      stdout: JSON.stringify(this.#materializedOutput(interaction)),
      stderr: "",
    };
  }

  async fetch(request: HttpRequest): Promise<HttpResponse> {
    const key = httpKey(request);
    const interaction = this.#http.get(key) ?? this.#httpTemplateInteraction(request);
    if (!interaction) {
      throw new Error(
        `Unregistered official HTTP fixture request: ${request.method} ${request.url}`,
      );
    }
    this.invocations.push({
      transport: "http",
      key,
      registered: structuredClone(interaction.registrations),
      sensitiveInput: request.sensitiveHeaders.length > 0 || request.sensitiveUrl === true,
    });
    return {
      status: request.method === "GET" ? 200 : 201,
      body: this.#materializedOutput(interaction),
    };
  }

  assertComplete(): void {
    if (this.registeredPlans.length === 0) throw new Error("No provider plans were registered");
    if (!this.invocations.some(({ transport }) => transport === "cli")) {
      throw new Error("No CommandProviderTransport fixture invocation was observed");
    }
    if (!this.invocations.some(({ transport }) => transport === "http")) {
      throw new Error("No HttpProviderTransport fixture invocation was observed");
    }
    const phases = new Set(
      this.invocations.flatMap(({ registered }) =>
        registered.flatMap(({ phases: registeredPhases }) => registeredPhases),
      ),
    );
    if (!phases.has("apply") || !phases.has("read_back")) {
      throw new Error("Official transport fixture did not observe both apply and read-back");
    }
  }

  #registerOperation(operation: ProviderOperation): void {
    if (operation.command) {
      const execution = applyOutput(operation);
      const applyRequest = {
        command: operation.command.binary,
        args: operation.command.args,
        cwd: operation.command.cwd,
      };
      const applyKey = commandKey(applyRequest);
      this.#addCommand(applyKey, execution, registration(operation, "apply"));
      this.#commandTemplates.push({ key: applyKey, ...applyRequest });
      if (operation.readBack?.command) {
        const command = operation.readBack.command;
        const readBackRequest = {
          command: command.binary,
          args: command.args.map((arg) => String(interpolate(arg, execution))),
          cwd: command.cwd,
        };
        const readBackKey = commandKey(readBackRequest);
        this.#addCommand(
          readBackKey,
          readBackOutput(operation, execution),
          registration(operation, "read_back"),
        );
        this.#commandTemplates.push({
          key: readBackKey,
          command: command.binary,
          args: command.args,
          cwd: command.cwd,
        });
      }
      return;
    }
    if (operation.http) {
      const execution = applyOutput(operation);
      if (operation.existingResource?.http) {
        const lookup = operation.existingResource.http;
        const lookupRequest = {
          method: lookup.method,
          url: lookup.url,
          body: undefined,
        };
        const lookupKey = httpKey(lookupRequest);
        this.#addHttp(lookupKey, { data: [], has_more: false }, registration(operation, "apply"));
        this.#httpTemplates.push({ key: lookupKey, ...lookupRequest });
      }
      for (const preflight of operation.http.credentialPreflight?.requests ?? []) {
        const preflightRequest = {
          method: "GET",
          url: preflight.url,
          body: undefined,
        };
        const preflightKey = httpKey(preflightRequest);
        this.#addHttp(
          preflightKey,
          credentialPreflightOutput(operation, preflight.assertions),
          registration(operation, "apply"),
        );
        this.#httpTemplates.push({ key: preflightKey, ...preflightRequest });
      }
      const applyRequest = {
        method: operation.http.method,
        url: operation.http.url,
        body: encodedBody(operation, false),
      };
      const applyKey = httpKey(applyRequest);
      this.#addHttp(applyKey, execution, registration(operation, "apply"));
      this.#httpTemplates.push({ key: applyKey, ...applyRequest });
      if (operation.readBack?.http) {
        const readBack = operation.readBack.http;
        const readBackRequest = {
          method: readBack.method,
          url: String(interpolate(readBack.url, execution)),
          body: encodedBody(operation, true),
        };
        const readBackKey = httpKey(readBackRequest);
        this.#addHttp(
          readBackKey,
          readBackOutput(operation, execution),
          registration(operation, "read_back"),
        );
        this.#httpTemplates.push({
          key: readBackKey,
          method: readBack.method,
          url: readBack.url,
          body: encodedBody(operation, true),
        });
      }
    }
  }

  #commandTemplateInteraction(invocation: CommandInvocation): FixtureInteraction | undefined {
    const matches = this.#commandTemplates.filter(
      (template) =>
        template.command === invocation.command &&
        resolve(template.cwd ?? ".") === resolve(invocation.cwd ?? ".") &&
        template.args.length === invocation.args.length &&
        template.args.every((arg, index) => templateStringMatches(arg, invocation.args[index]!)),
    );
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous official CLI fixture request: ${invocation.command} ${invocation.args.join(" ")}`,
      );
    }
    const matched = matches[0];
    const interaction = matched ? this.#commands.get(matched.key) : undefined;
    if (matched && interaction) {
      const bindings = Object.assign(
        {},
        ...matched.args.map((arg, index) => templateBindings(arg, invocation.args[index]!) ?? {}),
      ) as Record<string, string>;
      this.#rememberBindings(interaction, bindings);
    }
    return interaction;
  }

  #httpTemplateInteraction(request: HttpRequest): FixtureInteraction | undefined {
    const actualUrl = normalizedUrl(request.url);
    const matches = this.#httpTemplates.filter(
      (template) =>
        template.method === request.method &&
        templateStringMatches(normalizedUrl(template.url), actualUrl) &&
        (template.body === undefined
          ? request.body === undefined
          : request.body !== undefined && templateStringMatches(template.body, request.body)),
    );
    if (matches.length > 1) {
      throw new Error(`Ambiguous official HTTP fixture request: ${request.method} ${request.url}`);
    }
    const matched = matches[0];
    const interaction = matched ? this.#http.get(matched.key) : undefined;
    if (matched && interaction) {
      const bindings = {
        ...(templateBindings(normalizedUrl(matched.url), actualUrl) ?? {}),
        ...(matched.body && request.body
          ? (templateBindings(matched.body, request.body) ?? {})
          : {}),
      };
      this.#rememberBindings(interaction, bindings);
    }
    return interaction;
  }

  #rememberBindings(
    interaction: FixtureInteraction,
    bindings: Readonly<Record<string, string>>,
  ): void {
    const dependencies = Object.fromEntries(
      Object.entries(bindings).filter(([placeholder]) => placeholder.startsWith("{dependency.")),
    );
    if (Object.keys(dependencies).length === 0) return;
    for (const { operationId } of interaction.registrations) {
      this.#operationBindings.set(operationId, {
        ...this.#operationBindings.get(operationId),
        ...dependencies,
      });
    }
  }

  #materializedOutput(interaction: FixtureInteraction): unknown {
    const bindings = Object.assign(
      {},
      ...interaction.registrations.map(
        ({ operationId }) => this.#operationBindings.get(operationId) ?? {},
      ),
    ) as Record<string, string>;
    return interpolateBindings(structuredClone(interaction.output), bindings);
  }

  #addCommand(key: string, output: unknown, item: OfficialTransportFixtureRegistration): void {
    const current = this.#commands.get(key);
    this.#commands.set(key, {
      // Provider plans are registered immediately before execution. Multiple
      // Vercel deployment phases intentionally use the same direct CLI argv,
      // but each invocation returns a new deployment id and URL. Keep the most
      // recently registered response instead of merging those scalar values
      // into an impossible synthetic response.
      output: structuredClone(output),
      registrations: [...(current?.registrations ?? []), item],
    });
  }

  #addHttp(key: string, output: unknown, item: OfficialTransportFixtureRegistration): void {
    const current = this.#http.get(key);
    this.#http.set(key, {
      output: deepMerge(current?.output, output),
      registrations: [...(current?.registrations ?? []), item],
    });
  }

  #isGitPublish(invocation: CommandInvocation): boolean {
    return (
      invocation.command === "node" &&
      invocation.args.includes("scripts/github-publish-source.ts") &&
      (invocation.args.includes("apply") || invocation.args.includes("verify"))
    );
  }

  async #runGitPublish(invocation: CommandInvocation): Promise<CommandResult> {
    const key = commandKey(invocation);
    const repository = this.#argument(invocation.args, "--repository");
    const phase = invocation.args.includes("verify") ? "read_back" : "apply";
    const interaction =
      this.#commands.get(key) ??
      [...this.#commands.entries()].find(
        ([registeredKey, candidate]) =>
          registeredKey.includes(JSON.stringify(repository)) &&
          candidate.registrations.some(
            ({ action, phases }) =>
              action === "repository.create_from_source" && phases.includes(phase),
          ),
      )?.[1];
    if (!interaction) throw new Error("Git publish command was not registered by an official plan");
    const cwd = resolve(invocation.cwd ?? ".");
    if (cwd !== this.#expectedChildRoot) {
      throw new Error(
        `Git publish fixture must target the independent child root (${this.#expectedChildRoot}), received ${cwd}`,
      );
    }
    const visibility = this.#argument(invocation.args, "--visibility");
    const remote = resolve(this.#fixtureRoot, "remotes", `${repository.replaceAll("/", "--")}.git`);
    mkdirSync(resolve(remote, ".."), { recursive: true });

    if (invocation.args.includes("apply")) {
      if (!existsSync(remote)) {
        if (existsSync(resolve(cwd, ".git"))) {
          throw new Error(
            "Git publication fixture must not pre-create child Git before verified remote read-back",
          );
        }
        const temporaryRoot = mkdtempSync(join(this.#fixtureRoot, "source-publication-"));
        const isolatedGit = join(temporaryRoot, "source.git");
        try {
          this.#git(cwd, ["init", "--bare", "--object-format=sha1", isolatedGit]);
          const isolated = [`--git-dir=${isolatedGit}`, `--work-tree=${cwd}`];
          // Mirror GitLocalSourceSnapshotLoader exactly: the child's reviewed
          // .gitignore owns private-state exclusion. Adding ignored paths as
          // explicit negative pathspecs makes Git fail before publication.
          this.#git(cwd, [...isolated, "add", "-A", "--", "."]);
          const tree = this.#git(cwd, [...isolated, "write-tree"]).trim();
          const commit = this.#git(
            cwd,
            [...isolated, "commit-tree", tree, "-m", "fixture: publish verified source"],
            {
              GIT_AUTHOR_NAME: "Venture Harness Fixture",
              GIT_AUTHOR_EMAIL: "fixture@venture-harness.invalid",
              GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
              GIT_COMMITTER_NAME: "Venture Harness Fixture",
              GIT_COMMITTER_EMAIL: "fixture@venture-harness.invalid",
              GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
            },
          ).trim();
          this.#git(this.#fixtureRoot, ["init", "--bare", remote]);
          this.#git(cwd, [`--git-dir=${isolatedGit}`, "push", remote, `${commit}:refs/heads/main`]);
          this.#git(this.#fixtureRoot, [
            `--git-dir=${remote}`,
            "symbolic-ref",
            "HEAD",
            "refs/heads/main",
          ]);
        } finally {
          rmSync(temporaryRoot, { recursive: true, force: true });
        }
      }
    }

    const branch = "main";
    const commitOid = this.#git(this.#fixtureRoot, [
      `--git-dir=${remote}`,
      "rev-parse",
      `refs/heads/${branch}`,
    ]).trim();
    const treeOid = this.#git(this.#fixtureRoot, [
      `--git-dir=${remote}`,
      "rev-parse",
      `${commitOid}^{tree}`,
    ]).trim();
    const expectedCommit = invocation.args.includes("verify")
      ? this.#argument(invocation.args, "--commit")
      : commitOid;
    const expectedTree = invocation.args.includes("verify")
      ? this.#argument(invocation.args, "--tree")
      : treeOid;
    const cloner: GitHubWorkingRepositoryCloner = {
      clone: async ({ repository: target, branch: targetBranch, destination }) => {
        this.#git(this.#fixtureRoot, [
          "clone",
          "--no-checkout",
          "--single-branch",
          "--branch",
          targetBranch,
          remote,
          destination,
        ]);
        this.#git(destination, ["remote", "set-url", "origin", `https://github.com/${target}.git`]);
      },
    };
    const workingRepository = await ensureVerifiedGitHubWorkingRepository(
      { repository, rootDir: cwd, branch, commitOid },
      { cloner },
    );
    const output = {
      fixture: true,
      fixtureProvenance: "official_command_transport_local_bare_git_remote",
      verified: commitOid === expectedCommit && treeOid === expectedTree,
      repository,
      visibility,
      branch,
      commitOid,
      treeOid,
      remoteKind: "local_bare_fixture",
      workingRepository,
    };
    this.invocations.push({
      transport: "cli",
      key,
      registered: structuredClone(interaction.registrations),
      sensitiveInput: false,
    });
    return { exitCode: 0, stdout: JSON.stringify(output), stderr: "" };
  }

  #argument(args: readonly string[], name: string): string {
    const index = args.indexOf(name);
    const value = index < 0 ? undefined : args[index + 1];
    if (!value) throw new Error(`Fixture command is missing ${name}`);
    return value;
  }

  #git(cwd: string, args: string[], extraEnv: Readonly<Record<string, string>> = {}): string {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        [
          `fixture git ${args.join(" ")} failed`,
          result.error?.message,
          result.stderr,
          result.stdout,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return result.stdout;
  }
}
