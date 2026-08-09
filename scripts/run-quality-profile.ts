/**
 * Capability-aware quality profiles. Commands are reviewable in
 * config/quality.yaml, run without a shell, and produce an honest machine
 * report: a SKIP is never counted as a pass and always has an exact next step.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { walk } from "./lib/util";
import {
  evaluateCredentialFindings,
  scanCredentialText,
  validateReleaseScanAllowlist,
} from "./lib/release-security";
import {
  analyticsDestinationsFromProviderStates,
  validateEventPackConfig,
} from "../lib/analytics/pack-config";
import {
  CORE_JOURNEYS,
  validateMeasurementPlan,
  type CoreJourneyId,
  type EventPackId,
} from "../lib/analytics/packs";
import {
  FileProviderLifecycleStore,
  type VerifiedProviderLifecycleRecord,
} from "../lib/runtime/provider-lifecycle-store";

export type QualityProfileId = "fast" | "mvp" | "release";
export type CheckStatus = "PASS" | "FAIL" | "SKIP" | "NOT_APPLICABLE";

export interface GapDefinition {
  why: string;
  missing: string;
  exact_command: string;
  expected_evidence: string;
}

type CheckKind =
  | "command"
  | "changed_format"
  | "changed_lint"
  | "changed_tests"
  | "tracked_secret_scan"
  | "analytics_readiness"
  | "raw_html"
  | "manual"
  | "provider_readback";

export interface QualityCheckDefinition {
  kind: CheckKind;
  phase: number;
  command?: string | string[];
  when_paths?: string[];
  provider?: string;
  gap?: GapDefinition;
}

export interface QualityContract {
  profiles: Record<QualityProfileId, { description: string; checks: string[] }>;
  checks: Record<string, QualityCheckDefinition>;
  capability_checks: Record<string, Partial<Record<QualityProfileId, string[]>>>;
}

export interface ProviderEntry {
  state?: string;
  credential_ref?: string | null;
}

interface QualityContext {
  profile: QualityProfileId;
  root: string;
  activeCapabilities: string[];
  changedFiles: string[];
  providers: Record<string, ProviderEntry>;
  baseUrl?: string;
  allFiles: boolean;
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  phase: number;
  command: string | null;
  duration_ms: number;
  detail: string;
  gap: GapDefinition | null;
}

export interface QualityReport {
  profile: QualityProfileId;
  generated_at: string;
  active_capabilities: string[];
  changed_files: string[];
  results: CheckResult[];
  summary: Record<CheckStatus, number>;
  passed: boolean;
  executed_checks_passed: boolean;
  status: "PASS" | "FAIL" | "INCOMPLETE";
}

const REDACT_PATTERNS = [
  new RegExp("gh" + "[pousr]_[A-Za-z0-9_]{20,}", "g"),
  new RegExp("sk_" + "(?:live|test)_[A-Za-z0-9_]{12,}", "g"),
  new RegExp("xox" + "[baprs]-[A-Za-z0-9-]{10,}", "g"),
  /Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

export function redactQualityOutput(value: string): string {
  let output = REDACT_PATTERNS.reduce(
    (candidate, pattern) => candidate.replace(pattern, "[REDACTED]"),
    value,
  );
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)/i.test(name)) continue;
    if (secret && secret.length >= 8) output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

function asCommand(command: string | string[] | undefined): string[] | null {
  if (!command) return null;
  if (Array.isArray(command)) return command;
  return command.trim().split(/\s+/);
}

function commandText(command: string[] | null): string | null {
  return command ? command.join(" ") : null;
}

function gitLines(root: string, args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function discoverChangedFiles(root: string, base?: string): string[] {
  const files = new Set<string>();
  const range = base ? [`${base}...HEAD`] : ["HEAD"];
  gitLines(root, ["diff", "--name-only", "--diff-filter=ACMR", ...range]).forEach((file) =>
    files.add(file),
  );
  gitLines(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).forEach((file) =>
    files.add(file),
  );
  gitLines(root, ["ls-files", "--others", "--exclude-standard"]).forEach((file) => files.add(file));
  if (files.size === 0 && process.env.CI && !base) {
    gitLines(root, ["diff", "--name-only", "--diff-filter=ACMR", "HEAD^...HEAD"]).forEach((file) =>
      files.add(file),
    );
  }
  return [...files].sort();
}

function matchesPath(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern,
  );
}

export function resolveProfileChecks(
  contract: QualityContract,
  profile: QualityProfileId,
  capabilities: readonly string[],
): string[] {
  const profileDefinition = contract.profiles[profile];
  if (!profileDefinition) throw new Error(`Unknown quality profile: ${profile}`);
  const selected = new Set(profileDefinition.checks);
  for (const capability of capabilities) {
    for (const check of contract.capability_checks[capability]?.[profile] ?? [])
      selected.add(check);
  }
  for (const id of selected) {
    if (!contract.checks[id])
      throw new Error(`Quality profile ${profile} references unknown check ${id}`);
  }
  return [...selected];
}

function changedTestFiles(changedFiles: readonly string[], root: string): string[] {
  const mappings: [RegExp, string[]][] = [
    [/^(lib\/workflow|docs\/plans\/.*\.graph)/, ["tests/workflow-runtime.test.ts"]],
    [
      /^(lib\/cli|bin\/|scripts\/vh)/,
      [
        "tests/cli-runtime.test.ts",
        "tests/cli-launch-integration.test.ts",
        "tests/cli-learning-integration.test.ts",
        "tests/cli-default-provider-runtime.test.ts",
      ],
    ],
    [
      /^lib\/authorization/,
      [
        "tests/authorization.test.ts",
        "tests/checkpoint-evidence.test.ts",
        "tests/launch-authorization-scope.test.ts",
      ],
    ],
    [
      /^(lib\/mobile|config\/mobile)/,
      ["tests/mobile-scaffold.test.ts", "tests/launch-router.test.ts"],
    ],
    [
      /^lib\/runtime/,
      [
        "tests/runtime-build-agent-host.test.ts",
        "tests/runtime-provider.test.ts",
        "tests/runtime-provider-lifecycle.test.ts",
        "tests/runtime-provider-report.test.ts",
        "tests/runtime-provider-transports.test.ts",
      ],
    ],
    [
      /^(lib\/(providers|credentials)|tests\/fixtures\/provider)/,
      [
        "tests/providers-contract.test.ts",
        "tests/providers-execution.test.ts",
        "tests/providers-neon.test.ts",
        "tests/providers-github-source.test.ts",
        "tests/runtime-provider-transports.test.ts",
        "tests/credentials-broker.test.ts",
      ],
    ],
    [
      /^(lib\/analytics|config\/analytics|components\/.*Tracker)/,
      [
        "tests/analytics-packs.test.ts",
        "tests/analytics-taxonomy.test.ts",
        "tests/analytics-weekly.test.ts",
      ],
    ],
    [
      /^(lib\/migrations|migrations\/)/,
      ["tests/migrations.test.ts", "tests/quality-migrations.test.ts", "tests/upgrade.test.ts"],
    ],
    [
      /^(lib\/launch|fixtures\/)/,
      [
        "tests/launch-router.test.ts",
        "tests/launch-fixtures.test.ts",
        "tests/cli-launch-integration.test.ts",
      ],
    ],
    [
      /^lib\/data/,
      [
        "tests/data-sync.test.ts",
        "tests/data-provider-http-connectors.test.ts",
        "tests/default-data-learning-runtime.test.ts",
      ],
    ],
    [
      /^(lib\/learning|packages\/loops)/,
      [
        "tests/operating-loop-runtime.test.ts",
        "tests/learning-loops.test.ts",
        "tests/learning-schedule.test.ts",
        "tests/default-data-learning-runtime.test.ts",
        "tests/cli-learning-integration.test.ts",
      ],
    ],
    [
      /^(\.github\/workflows\/learning-cadence\.yml|config\/loops\.yaml)/,
      ["tests/learning-cadence-workflow.test.ts", "tests/learning-schedule.test.ts"],
    ],
    [/^(lib\/config|config\/)/, ["tests/config-schemas.test.ts"]],
    [
      /^(app\/|components\/)/,
      ["tests/consent.test.ts", "tests/qualification.test.ts", "tests/analytics-taxonomy.test.ts"],
    ],
  ];
  const tests = new Set<string>();
  for (const file of changedFiles) {
    if (file.startsWith("tests/") && file.endsWith(".test.ts")) tests.add(file);
    for (const [pattern, candidates] of mappings) {
      if (pattern.test(file)) candidates.forEach((candidate) => tests.add(candidate));
    }
  }
  return [...tests].filter((file) => existsSync(join(root, file))).sort();
}

async function execute(
  command: string[],
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 16_000) output = output.slice(-16_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => done({ code: 1, output: String(error) }));
    child.once("close", (code) => done({ code: code ?? 1, output: redactQualityOutput(output) }));
  });
}

function notApplicable(id: string, phase: number, detail: string): CheckResult {
  return {
    id,
    status: "NOT_APPLICABLE",
    phase,
    command: null,
    duration_ms: 0,
    detail,
    gap: null,
  };
}

function skipped(
  id: string,
  phase: number,
  definition: QualityCheckDefinition,
  gap?: GapDefinition,
): CheckResult {
  const resolvedGap = gap ?? definition.gap;
  if (!resolvedGap) throw new Error(`Skipped check ${id} has no actionable gap definition`);
  return {
    id,
    status: "SKIP",
    phase,
    command: commandText(asCommand(definition.command)),
    duration_ms: 0,
    detail: resolvedGap.why,
    gap: resolvedGap,
  };
}

export function unresolvedProviderReadbackGap(
  definition: QualityCheckDefinition,
  provider?: ProviderEntry,
): GapDefinition {
  if (!definition.gap) {
    throw new Error("Provider read-back check has no actionable gap definition");
  }
  if (!provider?.credential_ref) return definition.gap;
  return {
    ...definition.gap,
    why: "Provider metadata is marked verified, but a generic doctor exit does not prove this resource read-back.",
    missing: `${definition.gap.missing} A provider-specific sanitized read-back artifact and parser are not wired to this quality check.`,
  };
}

export function qualityProfileExitCode(report: Pick<QualityReport, "passed">): 0 | 1 {
  return report.passed ? 0 : 1;
}

function trackedSecretScan(root: string): { clean: boolean; detail: string } {
  const files = walk(root);
  try {
    const allowlist = validateReleaseScanAllowlist(
      JSON.parse(readFileSync(join(root, ".release-scan-allowlist.json"), "utf8")),
    );
    const findings = files.flatMap((file) => {
      try {
        return scanCredentialText(file, readFileSync(join(root, file), "utf8"));
      } catch {
        return [];
      }
    });
    const result = evaluateCredentialFindings(findings, allowlist);
    if (result.unexpected.length > 0 || result.stale.length > 0) {
      const unexpected = result.unexpected.map((finding) => finding.fingerprint).join(", ");
      const stale = result.stale
        .map((entry) => `${entry.path}:${entry.rule}:${entry.line}:${entry.sha256}`)
        .join(", ");
      return {
        clean: false,
        detail: [
          unexpected ? `Unexpected credential fingerprints: ${unexpected}.` : "",
          stale ? `Stale credential allowlist entries: ${stale}.` : "",
          "Remove and rotate real credentials; review and fingerprint only synthetic canaries.",
        ]
          .filter(Boolean)
          .join(" "),
      };
    }
    return {
      clean: true,
      detail: `No unexpected credential patterns in ${files.length} workspace files; ${result.allowed.length} exact synthetic fingerprint(s) reviewed.`,
    };
  } catch (error) {
    return {
      clean: false,
      detail: `Credential scan configuration failed closed: ${String(error)}`,
    };
  }
}

export function productionServerCommand(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid production server port: ${port}`);
  }
  return ["pnpm", "exec", "next", "start", "-H", "127.0.0.1", "-p", String(port)];
}

async function runRawHtml(
  definition: QualityCheckDefinition,
  context: QualityContext,
): Promise<{ code: number; output: string }> {
  if (context.baseUrl) {
    const command = [...(asCommand(definition.command) ?? [])];
    command.push("--", "--url", context.baseUrl);
    return execute(command, context.root);
  }
  const port = Number(process.env.VH_QUALITY_PORT ?? 3210);
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverCommand: string[];
  try {
    serverCommand = productionServerCommand(port);
  } catch (error) {
    return { code: 1, output: String(error) };
  }
  const server = spawn(serverCommand[0], serverCommand.slice(1), {
    cwd: context.root,
    env: { ...process.env, PORT: String(port) },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  const append = (chunk: Buffer) => {
    serverOutput += chunk.toString("utf8");
    if (serverOutput.length > 8_000) serverOutput = serverOutput.slice(-8_000);
  };
  server.stdout.on("data", append);
  server.stderr.on("data", append);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Server is still starting.
      }
      await new Promise((wait) => setTimeout(wait, 250));
    }
    if (!ready)
      return {
        code: 1,
        output: `Production server did not start. ${redactQualityOutput(serverOutput)}`,
      };
    const command = [...(asCommand(definition.command) ?? [])];
    command.push("--", "--url", baseUrl, "--allow-loopback");
    return await execute(command, context.root);
  } finally {
    server.kill("SIGTERM");
  }
}

async function runCheck(
  id: string,
  definition: QualityCheckDefinition,
  context: QualityContext,
  priorResults: ReadonlyMap<string, CheckResult>,
): Promise<CheckResult> {
  const started = Date.now();
  if (
    !context.allFiles &&
    definition.when_paths &&
    !context.changedFiles.some((file) => matchesPath(file, definition.when_paths!))
  ) {
    return notApplicable(id, definition.phase, "No relevant path changed.");
  }
  if (definition.kind === "manual") return skipped(id, definition.phase, definition);
  if (definition.kind === "provider_readback") {
    const provider = context.providers[definition.provider ?? ""];
    // Provider configuration and a generic doctor exit are readiness evidence,
    // not resource read-back proof. Keep this incomplete until the check has a
    // provider-specific sanitized artifact parser.
    return skipped(
      id,
      definition.phase,
      definition,
      unresolvedProviderReadbackGap(definition, provider),
    );
  }
  if (definition.kind === "raw_html" && priorResults.get("production_build")?.status === "FAIL") {
    return skipped(id, definition.phase, definition, {
      why: "Raw HTML cannot be checked because the production build failed.",
      missing: "A passing pnpm build artifact.",
      exact_command: "pnpm build && pnpm verify:raw-html",
      expected_evidence: "Crawler HTML pass for browser, Googlebot-like, and Bingbot-like agents.",
    });
  }

  let command = asCommand(definition.command);
  if (definition.kind === "changed_format") {
    const extensions = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".json",
      ".yaml",
      ".yml",
      ".md",
      ".css",
    ]);
    const files = context.changedFiles.filter(
      (file) => extensions.has(extname(file)) && existsSync(join(context.root, file)),
    );
    if (files.length === 0)
      return notApplicable(id, definition.phase, "No changed formatted file.");
    command = ["pnpm", "exec", "prettier", "--check", ...files];
  }
  if (definition.kind === "changed_lint") {
    const files = context.changedFiles.filter(
      (file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(join(context.root, file)),
    );
    if (files.length === 0) return notApplicable(id, definition.phase, "No changed lintable file.");
    command = ["pnpm", "exec", "eslint", "--max-warnings=0", ...files];
  }
  if (definition.kind === "changed_tests") {
    const files = changedTestFiles(context.changedFiles, context.root);
    if (files.length === 0) return notApplicable(id, definition.phase, "No affected test mapping.");
    command = ["pnpm", "exec", "vitest", "run", ...files];
  }
  if (definition.kind === "tracked_secret_scan") {
    const result = trackedSecretScan(context.root);
    return {
      id,
      status: result.clean ? "PASS" : "FAIL",
      phase: definition.phase,
      command: "internal tracked secret scan",
      duration_ms: Date.now() - started,
      detail: result.detail,
      gap: null,
    };
  }
  if (definition.kind === "analytics_readiness") {
    const analytics = readYaml<{
      event_packs: { active: EventPackId[] };
      core_journeys: Record<string, { active?: boolean }>;
    }>(context.root, "config/analytics.yaml");
    const staticFailures = validateEventPackConfig(analytics);
    if (staticFailures.length > 0) {
      return {
        id,
        status: "FAIL",
        phase: definition.phase,
        command: "internal analytics pack readiness",
        duration_ms: Date.now() - started,
        detail: staticFailures.join(" "),
        gap: null,
      };
    }
    const providerStates = Object.fromEntries(
      Object.entries(context.providers).map(([provider, entry]) => [
        provider,
        entry.state ?? "unconfigured",
      ]),
    );
    const latestPath = join(context.root, ".venture/data/latest.json");
    const freshness: Record<string, "fresh" | "stale" | "missing"> = {};
    if (existsSync(latestPath)) {
      try {
        const artifact = JSON.parse(readFileSync(latestPath, "utf8")) as {
          freshness?: { source: string; status: "fresh" | "stale" | "missing" }[];
        };
        for (const entry of artifact.freshness ?? []) freshness[entry.source] = entry.status;
      } catch {
        // The exact invalid artifact is reported as unknown freshness below.
      }
    }
    const issues = validateMeasurementPlan({
      activePacks: analytics.event_packs.active,
      activeJourneys: Object.entries(analytics.core_journeys)
        .filter(([, journey]) => journey.active === true)
        .map(([journeyId]) => journeyId)
        .filter((journeyId): journeyId is CoreJourneyId => journeyId in CORE_JOURNEYS),
      configuredDestinations: analyticsDestinationsFromProviderStates(providerStates),
      freshness,
    });
    const structuralIssues = issues.filter((issue) =>
      [
        "pack_missing",
        "journey_start_missing",
        "journey_outcome_missing",
        "commercial_outcome_not_first_party",
      ].includes(issue.code),
    );
    if (structuralIssues.length > 0) {
      return {
        id,
        status: "FAIL",
        phase: definition.phase,
        command: "internal analytics journey readiness",
        duration_ms: Date.now() - started,
        detail: structuralIssues.map((issue) => issue.message).join(" "),
        gap: null,
      };
    }
    const externalIssues = issues.filter((issue) => !structuralIssues.includes(issue));
    if (context.profile === "release" && externalIssues.length > 0) {
      return skipped(id, definition.phase, definition, {
        why: "Active analytics packs do not yet have complete destination and freshness evidence.",
        missing: externalIssues.map((issue) => issue.message).join(" "),
        exact_command: "pnpm vh auth login && pnpm vh data sync",
        expected_evidence:
          "Verified destination lifecycle states and normalized source freshness with account, window, timezone, and limitations.",
      });
    }
    return {
      id,
      status: "PASS",
      phase: definition.phase,
      command: "internal analytics pack readiness",
      duration_ms: Date.now() - started,
      detail:
        externalIssues.length === 0
          ? "Active journeys, pack destinations, and data-source freshness are known."
          : "Active journeys and event-pack wiring are valid; live destination and freshness proof is deferred to the release profile.",
      gap: null,
    };
  }

  if (!command || command.length === 0) {
    return {
      id,
      status: "FAIL",
      phase: definition.phase,
      command: null,
      duration_ms: Date.now() - started,
      detail: "Check has no executable command.",
      gap: null,
    };
  }
  const outcome =
    definition.kind === "raw_html"
      ? await runRawHtml(definition, context)
      : await execute(command, context.root);
  return {
    id,
    status: outcome.code === 0 ? "PASS" : "FAIL",
    phase: definition.phase,
    command: commandText(command),
    duration_ms: Date.now() - started,
    detail:
      outcome.code === 0
        ? outcome.output.trim().split("\n").slice(-3).join(" | ") || "Command exited 0."
        : outcome.output.trim().slice(-4_000) || `Command exited ${outcome.code}.`,
    gap: null,
  };
}

function readYaml<T>(root: string, path: string): T {
  return parse(readFileSync(join(root, path), "utf8")) as T;
}

export function mergeVerifiedProviderLifecycleStates(
  configured: Readonly<Record<string, ProviderEntry>>,
  records: readonly VerifiedProviderLifecycleRecord[],
): Record<string, ProviderEntry> {
  const merged = Object.fromEntries(
    Object.entries(configured).map(([provider, entry]) => [provider, { ...entry }]),
  );
  for (const record of records) {
    merged[record.provider] = { ...merged[record.provider], state: "verified" };
  }
  return merged;
}

function assertContract(contract: QualityContract): void {
  for (const profile of ["fast", "mvp", "release"] as const) {
    if (!contract.profiles[profile]) throw new Error(`Missing quality profile ${profile}`);
  }
  for (const [id, check] of Object.entries(contract.checks)) {
    if (!Number.isInteger(check.phase) || check.phase < 1)
      throw new Error(`${id} needs phase >= 1`);
    if (["manual", "provider_readback"].includes(check.kind) && !check.gap) {
      throw new Error(`${id} can skip but has no actionable gap definition`);
    }
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function runQualityProfile(options: {
  root: string;
  profile: QualityProfileId;
  base?: string;
  baseUrl?: string;
  allFiles?: boolean;
  reportPath?: string;
}): Promise<QualityReport> {
  const contract = readYaml<QualityContract>(options.root, "config/quality.yaml");
  assertContract(contract);
  const venture = readYaml<{
    venture: { capabilities: { active: string[]; open?: string[] } };
  }>(options.root, "config/venture.yaml");
  const providerConfig = readYaml<{ providers: Record<string, ProviderEntry> }>(
    options.root,
    "config/providers.yaml",
  );
  const lifecyclePath = join(options.root, ".venture/provider-lifecycle.json");
  const lifecycleRecords = existsSync(lifecyclePath)
    ? await new FileProviderLifecycleStore(lifecyclePath).list()
    : [];
  const providers = mergeVerifiedProviderLifecycleStates(
    providerConfig.providers,
    lifecycleRecords,
  );
  const capabilities = [
    ...venture.venture.capabilities.active,
    ...(venture.venture.capabilities.open ?? []),
  ];
  const changedFiles = discoverChangedFiles(options.root, options.base);
  const context: QualityContext = {
    profile: options.profile,
    root: options.root,
    activeCapabilities: capabilities,
    changedFiles,
    providers,
    baseUrl: options.baseUrl,
    allFiles: options.allFiles ?? options.profile !== "fast",
  };
  const checkIds = resolveProfileChecks(contract, options.profile, capabilities);
  const phases = [...new Set(checkIds.map((id) => contract.checks[id].phase))].sort(
    (a, b) => a - b,
  );
  const results: CheckResult[] = [];
  const byId = new Map<string, CheckResult>();

  for (const phase of phases) {
    const ids = checkIds.filter((id) => contract.checks[id].phase === phase);
    const phaseResults = await Promise.all(
      ids.map((id) => runCheck(id, contract.checks[id], context, byId)),
    );
    for (const result of phaseResults) {
      results.push(result);
      byId.set(result.id, result);
      const suffix = result.detail ? ` — ${result.detail.split("\n")[0]}` : "";
      console.log(`${result.status.padEnd(14)} ${result.id}${suffix}`);
      if (result.status === "SKIP" && result.gap) {
        console.log(`  missing: ${result.gap.missing}`);
        console.log(`  run: ${result.gap.exact_command}`);
        console.log(`  evidence: ${result.gap.expected_evidence}`);
      }
    }
  }

  const summary: Record<CheckStatus, number> = {
    PASS: 0,
    FAIL: 0,
    SKIP: 0,
    NOT_APPLICABLE: 0,
  };
  results.forEach((result) => summary[result.status]++);
  const report: QualityReport = {
    profile: options.profile,
    generated_at: new Date().toISOString(),
    active_capabilities: capabilities,
    changed_files: changedFiles,
    results,
    summary,
    passed: summary.FAIL === 0 && summary.SKIP === 0,
    executed_checks_passed: summary.FAIL === 0,
    status: summary.FAIL > 0 ? "FAIL" : summary.SKIP > 0 ? "INCOMPLETE" : "PASS",
  };
  const reportPath =
    options.reportPath ??
    join(options.root, ".venture/reports/quality", `${options.profile}-latest.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    `quality ${options.profile} ${report.status}: ${summary.PASS} pass, ${summary.FAIL} fail, ${summary.SKIP} skip, ${summary.NOT_APPLICABLE} not applicable`,
  );
  console.log(`report: ${relative(options.root, reportPath)}`);
  return report;
}

async function main(): Promise<void> {
  const profile = process.argv[2] as QualityProfileId | undefined;
  if (!profile || !["fast", "mvp", "release"].includes(profile)) {
    console.error(
      "usage: tsx scripts/run-quality-profile.ts <fast|mvp|release> [--base <git-ref>] [--url <base-url>] [--all]",
    );
    process.exit(2);
  }
  const root = process.cwd();
  try {
    const report = await runQualityProfile({
      root,
      profile,
      base: argValue("--base"),
      baseUrl: argValue("--url"),
      allFiles: process.argv.includes("--all"),
      reportPath: argValue("--report") ? resolve(root, argValue("--report")!) : undefined,
    });
    process.exit(qualityProfileExitCode(report));
  } catch (error) {
    console.error(
      redactQualityOutput(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
    process.exit(1);
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) void main();
