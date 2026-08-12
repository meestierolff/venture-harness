import { FileWorkflowStore, WorkflowExecutor, type WorkflowStore } from "../workflow";
import { sideEffectClassSchema } from "../config/policy-schema";
import { createDefaultCliServices } from "./default-services";
import {
  FOUNDER_CONFIG_KEYS,
  defaultFounderConfigPath,
  loadFounderConfig,
  resolveVenturesRoot,
  saveFounderConfig,
} from "../founder-launch/founder-config";
import { assertNoSecretsInArgv, type DetectedSession } from "../founder-launch/stack-connect";
import {
  collectFounderStackWizard,
  collectedCliSessionRoles,
  detectSessions,
  founderStackConnectionDraftRoles,
  safeCliSessionMetadata,
  systemFounderStackWizardPrompt,
  type FounderStackWizardPrompt,
  type GuidedFounderStackRole,
} from "../founder-launch/stack-connect-shell";
import { createFounderStackConnectionDraft } from "../founder-launch/stack";
import type { CliIo, CliLaunchRequest, CliResult, CliServices } from "./types";

export * from "./types";
export * from "./platform-command-runtime";

export interface RunCliOptions {
  io?: CliIo;
  services?: CliServices;
  store?: WorkflowStore;
  /** Deterministic seam for the credential-free Stack wizard session inspection. */
  stackSessions?: readonly DetectedSession[];
  /** Deterministic hidden/visible prompt seam for guided Stack connection tests. */
  stackPrompt?: FounderStackWizardPrompt;
}

const HELP = `Venture Harness CLI

Usage:
  vh auth login [provider]         Authenticate through a configured provider adapter
  vh auth status                  Show credential references and provider auth state
  vh auth test [provider]          Test access/scopes without exposing credential values
  vh auth revoke <provider>       Revoke through a configured provider adapter
    --ref cred://provider/name --backend environment|macos_keychain|onepassword|cli_session
    --kind <credential-kind> --scopes <comma-separated>
  vh stack create founder-default --file <connection.json>
                                  Persist one credential-free founder Stack connection
  vh stack connect founder-default
                                  Guided one-time connection of the default founder Stack
  vh stack doctor founder-default Inspect every founder Stack role without provider effects
  vh config show                  Show persistent founder settings
  vh config set ventures-root <absolute-path>
                                  Choose where independent ventures are materialized
  vh doctor                       Inspect local launch prerequisites
  vh idea sharpen --input <idea.md|-> --output <idea.md>
                                  Produce one bounded Launch Contract and Product Constitution
  vh create --brief <file>        Validate and persist one progressive-commitment brief
  vh plan [--brief <file>]        Compile a launch plan without side effects
  vh launch --dry-run             Show nodes, effects, approvals, cost, and manual work
  vh launch --apply --authorization <profile>
                                  Execute an authorized launch graph
  vh launch --idea <idea.md> --stack founder-default --production --apply --non-interactive
                                  Materialize and execute the complete founder launch in one command
  vh status [run-id]              Show one run or list known runs
  vh resume <run-id>              Resume the same persisted run
    --authorization <profile>     Explicitly renew an expired run envelope
  vh resume <run-id> --manual <node-id> --evidence <artifact> [--output <json-file>]
                                  Resolve one manual node with evidence, then resume
  vh resume <run-id> --grant <node-id> --effect <effect> --operation <operation-id> --evidence <artifact>
                                  Issue one exact one-shot checkpoint grant, then resume
  vh cancel <run-id>              Persist cancellation and run configured compensation
  vh explain [run-id] <node-id>   Explain a node from durable state
  vh data sync                    Ingest through configured read-only connectors
  vh learn daily|weekly|biweekly|monthly
                                  Run an evidence-based learning cadence
  vh upgrade [--release <local-root>] [--dry-run]
                                  Upgrade from a hash-verified local release

Options:
  --json                          Emit machine-readable JSON where supported
  -h, --help                      Show this help`;

function defaultIo(): CliIo {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("-")) {
      if (
        [
          "--brief",
          "--input",
          "--idea",
          "--stack",
          "--output",
          "--authorization",
          "--run-id",
          "--manual",
          "--approve",
          "--grant",
          "--effect",
          "--operation",
          "--evidence",
          "--output",
          "--note",
          "--reason",
          "--ref",
          "--backend",
          "--kind",
          "--scopes",
          "--file",
          "--release",
          "--role",
          "--credential-backend",
        ].includes(args[index])
      )
        index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function emit(io: CliIo, value: unknown, json: boolean): void {
  if (json || typeof value !== "string") io.stdout(JSON.stringify(value, null, 2) ?? "null");
  else io.stdout(value);
}

function terminalWorkflowExitCode(value: unknown): 0 | 1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const status = (value as { status?: unknown }).status;
  return status === "failed" || status === "cancelled" ? 1 : 0;
}

function founderLaunchExitCode(value: unknown, mode: "dry-run" | "apply"): 0 | 1 {
  if (mode === "dry-run" || !value || typeof value !== "object" || Array.isArray(value)) return 0;
  const status = (value as { status?: unknown }).status;
  return status === "blocked" || status === "failed" ? 1 : 0;
}

function authTestExitCode(value: unknown): 0 | 1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 1;
  return (value as { allPassed?: unknown }).allPassed === true ? 0 : 1;
}

function unsupported(io: CliIo, command: string, nextAction: string): CliResult {
  io.stderr(`${command} is not configured; no external action was taken.`);
  io.stderr(`Next: ${nextAction}`);
  return { exitCode: 2 };
}

function latestRun(store: WorkflowStore): string | undefined {
  const runs = store.listRuns();
  if (runs.length === 0) return undefined;
  return runs
    .map((runId) => store.load(runId))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1)?.runId;
}

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const io = options.io ?? defaultIo();
  const store = options.store ?? new FileWorkflowStore();
  const services = options.services ?? createDefaultCliServices({ store });
  const json = args.includes("--json");
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return { exitCode: 0 };
  }

  try {
    if (command === "idea") {
      const usage = "Usage: vh idea sharpen --input <rough-idea.md|-> --output <idea.md>";
      const values = positional(rest);
      const unknownFlag = rest.find(
        (value) =>
          value.startsWith("-") &&
          value !== "-" &&
          !["--input", "--output", "--json"].includes(value),
      );
      const input = flagValue(rest, "--input");
      const output = flagValue(rest, "--output");
      if (
        unknownFlag ||
        values.length !== 1 ||
        values[0] !== "sharpen" ||
        !input ||
        !output ||
        !output.toLowerCase().endsWith(".md")
      ) {
        io.stderr(usage);
        return { exitCode: 2 };
      }
      if (!services.ideaSharpen) {
        return unsupported(
          io,
          "vh idea sharpen",
          "install and authenticate the Codex CLI, then rerun the same command",
        );
      }
      emit(io, await services.ideaSharpen({ input, output, json }), json);
      return { exitCode: 0 };
    }

    if (command === "create") {
      const brief = flagValue(rest, "--brief");
      if (!brief) {
        io.stderr("vh create requires --brief <file>.");
        return { exitCode: 2 };
      }
      if (!services.create)
        return unsupported(io, "vh create", "register the progressive-commitment brief service");
      emit(io, await services.create({ brief, json }), json);
      return { exitCode: 0 };
    }

    if (command === "doctor") {
      const builtIn = {
        node: process.version,
        platform: process.platform,
        runStore: store instanceof FileWorkflowStore ? store.rootDir : "injected",
        knownRuns: store.listRuns().length,
        providerChecks: services.doctor ? "configured" : "not configured",
      };
      const result = services.doctor ? await services.doctor() : builtIn;
      emit(io, result, json);
      if (!services.doctor) {
        io.stderr(
          "Provider checks were not run. Next: register provider doctor checks, then rerun vh doctor.",
        );
      }
      return { exitCode: 0 };
    }

    if (command === "stack" && positional(rest)[0] === "connect") {
      // Refuse before anything else: an argument is already exposed by the time
      // we could validate it, so this must run ahead of any other parsing.
      try {
        assertNoSecretsInArgv(rest);
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return { exitCode: 2 };
      }
      const values = positional(rest);
      const unknownStackFlag = rest.find(
        (value) =>
          value.startsWith("-") && !["--role", "--credential-backend", "--json"].includes(value),
      );
      const missingStackFlagValue = ["--role", "--credential-backend"].find((flag) => {
        const value = flagValue(rest, flag);
        return rest.includes(flag) && (!value || value.startsWith("-"));
      });
      if (
        values.length !== 2 ||
        values[1] !== "founder-default" ||
        unknownStackFlag ||
        missingStackFlagValue
      ) {
        io.stderr(
          "Usage: vh stack connect founder-default [--role database.postgres|commerce.web|email.transactional|growth.google|search.bing|dns.records] [--credential-backend macos_keychain|onepassword]",
        );
        return { exitCode: 2 };
      }
      const sessions = [...(options.stackSessions ?? detectSessions())];
      const collected = [...collectedCliSessionRoles(sessions, "founder-default")];
      const prompt = options.stackPrompt ?? systemFounderStackWizardPrompt();
      const requestedRole = flagValue(rest, "--role") as GuidedFounderStackRole | undefined;
      const allowedRoles = new Set<GuidedFounderStackRole>([
        "database.postgres",
        "commerce.web",
        "email.transactional",
        "growth.google",
        "search.bing",
        "dns.records",
      ]);
      if (requestedRole && !allowedRoles.has(requestedRole)) {
        io.stderr(
          "--role must be database.postgres, commerce.web, email.transactional, growth.google, search.bing, or dns.records",
        );
        return { exitCode: 2 };
      }
      const requestedBackend = flagValue(rest, "--credential-backend");
      const backend =
        requestedBackend ?? (process.platform === "darwin" ? "macos_keychain" : "onepassword");
      if (backend !== "macos_keychain" && backend !== "onepassword") {
        io.stderr("--credential-backend must be macos_keychain or onepassword");
        return { exitCode: 2 };
      }
      const credentialWrites: NonNullable<
        Parameters<NonNullable<CliServices["stack"]>>[0]["credentialWrites"]
      >[number][] = [];
      let selectedOptionalRoles: Parameters<
        typeof createFounderStackConnectionDraft
      >[0]["selectedOptionalRoles"] = [
        "email.transactional",
        "growth.google",
        "search.bing",
        "dns.records",
      ];
      let launchDefaults: Parameters<typeof createFounderStackConnectionDraft>[0]["launchDefaults"];
      let writableCredentialBackend: Parameters<
        typeof createFounderStackConnectionDraft
      >[0]["writableCredentialBackend"] = { mode: "shared", backend };
      if (prompt.isTty && !json) {
        const guided = await collectFounderStackWizard({
          profileId: "founder-default",
          sessions,
          prompt,
          backend,
          ...(requestedRole ? { onlyRole: requestedRole } : {}),
          writer: {
            backendId: backend,
            async store(request) {
              credentialWrites.push(request);
            },
          },
        });
        collected.push(...guided.collected);
        selectedOptionalRoles = guided.selectedOptionalRoles;
        launchDefaults = guided.launchDefaults;
        writableCredentialBackend = guided.writableCredentialBackend;
      }
      const githubOwner = sessions.find(
        ({ provider, authenticated, account }) => provider === "github" && authenticated && account,
      )?.account;
      const connection = createFounderStackConnectionDraft({
        ownerOrganizationId: githubOwner ?? "founder",
        roles: founderStackConnectionDraftRoles(collected, sessions),
        inspectedCliSessions: safeCliSessionMetadata(sessions),
        selectedOptionalRoles,
        writableCredentialBackend,
        launchDefaults,
      });
      const updatedRoles = [...new Set(collected.map(({ role }) => role))];
      const venturesRoot = loadFounderConfig().venturesRoot ?? null;
      if (!services.stack) {
        return unsupported(
          io,
          "vh stack connect founder-default",
          "configure the founder Stack metadata store and credential broker",
        );
      }
      const diagnosed = await services.stack({
        action: "connect",
        profileId: "founder-default",
        connection,
        credentialWrites,
        updatedRoles,
        replaceOptionalRoles: prompt.isTty && !json && requestedRole === undefined,
        updateWritableCredentialBackend:
          prompt.isTty &&
          !json &&
          (requestedRole === undefined ||
            requestedRole === "database.postgres" ||
            requestedRole === "commerce.web" ||
            requestedRole === "growth.google"),
      });
      const doctor =
        diagnosed && typeof diagnosed === "object" && !Array.isArray(diagnosed)
          ? diagnosed
          : { status: "attention_required", launchReady: false, unresolvedActions: [] };
      const providerActions = Array.isArray(doctor.unresolvedActions)
        ? doctor.unresolvedActions
        : [];
      const launchReady = doctor.launchReady === true && venturesRoot !== null;
      emit(
        io,
        {
          command: "stack.connect",
          profileId: "founder-default",
          saved: true,
          ...doctor,
          venturesRoot,
          launchReady,
          unresolvedActions: [
            ...providerActions,
            ...(venturesRoot
              ? []
              : [
                  {
                    role: "workspace",
                    provider: "local",
                    why: "No ventures root is configured, so a launch has nowhere safe to materialize a venture.",
                    command: "vh config set ventures-root <absolute-path>",
                    blocksLaunch: true,
                  },
                ]),
          ],
        },
        json,
      );
      return { exitCode: launchReady ? 0 : 1 };
    }

    if (command === "stack") {
      const unknownFlag = rest.find(
        (value) => value.startsWith("-") && value !== "--file" && value !== "--json",
      );
      const fileIndexes = rest
        .map((value, index) => (value === "--file" ? index : -1))
        .filter((index) => index >= 0);
      if (
        unknownFlag ||
        fileIndexes.length > 1 ||
        (fileIndexes.length === 1 &&
          (!rest[fileIndexes[0] + 1] || rest[fileIndexes[0] + 1].startsWith("-")))
      ) {
        io.stderr(
          "Usage: vh stack create founder-default --file <connection.json> | vh stack doctor founder-default",
        );
        return { exitCode: 2 };
      }
      const values = positional(rest);
      const action = values[0];
      const profileId = values[1];
      if (
        (action !== "create" && action !== "doctor") ||
        profileId !== "founder-default" ||
        values.length !== 2
      ) {
        io.stderr(
          "Usage: vh stack create founder-default --file <connection.json> | vh stack doctor founder-default",
        );
        return { exitCode: 2 };
      }
      const file = flagValue(rest, "--file");
      if (action === "create" && !file) {
        io.stderr("vh stack create founder-default requires --file <connection.json>.");
        return { exitCode: 2 };
      }
      if (action === "doctor" && rest.includes("--file")) {
        io.stderr("vh stack doctor founder-default does not accept --file.");
        return { exitCode: 2 };
      }
      if (!services.stack) {
        return unsupported(
          io,
          `vh stack ${action} founder-default`,
          "configure the founder Stack metadata store and credential broker",
        );
      }
      emit(io, await services.stack({ action, profileId, ...(file ? { file } : {}) }), json);
      return { exitCode: 0 };
    }

    if (command === "config") {
      const values = positional(rest);
      const action = values[0];
      const usage = "Usage: vh config show | vh config set ventures-root <absolute-path>";
      if (action === "show" && values.length === 1) {
        const config = loadFounderConfig();
        emit(
          io,
          {
            command: "config.show",
            path: defaultFounderConfigPath(),
            venturesRoot: config.venturesRoot ?? null,
            ...(config.venturesRoot
              ? {}
              : { nextAction: "vh config set ventures-root <absolute-path>" }),
          },
          json,
        );
        return { exitCode: 0 };
      }
      if (action !== "set" || values.length !== 3) {
        io.stderr(usage);
        return { exitCode: 2 };
      }
      const [, key, value] = values as [string, string, string];
      if (!(FOUNDER_CONFIG_KEYS as readonly string[]).includes(key)) {
        io.stderr(
          `Unknown founder setting ${key}. Known settings: ${FOUNDER_CONFIG_KEYS.join(", ")}.`,
        );
        return { exitCode: 2 };
      }
      try {
        const venturesRoot = resolveVenturesRoot(value, { coreRoot: process.cwd() });
        const existing = loadFounderConfig();
        saveFounderConfig({ ...existing, venturesRoot });
        emit(io, { command: "config.set", key, venturesRoot }, json);
        return { exitCode: 0 };
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return { exitCode: 1 };
      }
    }

    if (command === "plan") {
      if (!services.plan)
        return unsupported(
          io,
          "vh plan",
          "register the launch planner and provider registry, then rerun vh plan",
        );
      emit(io, await services.plan({ brief: flagValue(rest, "--brief"), json }), json);
      return { exitCode: 0 };
    }

    if (command === "launch") {
      const dryRun = rest.includes("--dry-run");
      const apply = rest.includes("--apply");
      if (dryRun === apply) {
        io.stderr("Choose exactly one of --dry-run or --apply.");
        io.stderr("Next: run vh launch --dry-run before requesting an authorized apply.");
        return { exitCode: 2 };
      }
      const idea = flagValue(rest, "--idea");
      if (idea) {
        const stackProfile = flagValue(rest, "--stack");
        if (stackProfile !== "founder-default") {
          io.stderr("One-prompt launch requires --stack founder-default.");
          return { exitCode: 2 };
        }
        if (!rest.includes("--production") || !rest.includes("--non-interactive")) {
          io.stderr("One-prompt launch requires --production and --non-interactive.");
          return { exitCode: 2 };
        }
        if (rest.includes("--authorization")) {
          io.stderr(
            "One-prompt launch derives its graph authorization from the issued Launch Grant; do not pass --authorization.",
          );
          return { exitCode: 2 };
        }
        if (!services.founderLaunch) {
          return unsupported(
            io,
            "vh launch --idea",
            "configure the founder Stack and one-prompt launch service",
          );
        }
        const mode = dryRun ? "dry-run" : "apply";
        const result = await services.founderLaunch({
          mode,
          idea,
          stackProfile,
          production: true,
          nonInteractive: true,
          output: flagValue(rest, "--output"),
          json,
        });
        emit(io, result, json);
        return { exitCode: founderLaunchExitCode(result, mode) };
      }
      const authorization = flagValue(rest, "--authorization");
      if (apply && !authorization) {
        io.stderr("--apply requires --authorization <profile>; no external action was taken.");
        return { exitCode: 2 };
      }
      if (!services.launch)
        return unsupported(
          io,
          "vh launch",
          "register a launch compiler and capability adapters, then rerun the dry run",
        );
      const request: CliLaunchRequest = {
        mode: dryRun ? "dry-run" : "apply",
        authorization,
        runId: flagValue(rest, "--run-id"),
        json,
      };
      const result = await services.launch(request);
      emit(io, result, json);
      return { exitCode: terminalWorkflowExitCode(result) };
    }

    if (command === "status") {
      const runId = positional(rest)[0];
      if (!runId) {
        const runs = store.listRuns().map((id) => {
          const state = store.load(id);
          return {
            runId: id,
            graph: state.graph.id,
            status: state.status,
            updatedAt: state.updatedAt,
          };
        });
        emit(io, runs, true);
      } else {
        emit(io, store.load(runId), true);
      }
      return { exitCode: 0 };
    }

    if (command === "resume") {
      const runId = positional(rest)[0];
      if (!runId) {
        io.stderr("vh resume requires <run-id>.");
        return { exitCode: 2 };
      }
      if (!services.resume)
        return unsupported(
          io,
          "vh resume",
          `load the persisted graph definition for "${runId}", register its handlers, and rerun vh resume ${runId}`,
        );
      const manualNode = flagValue(rest, "--manual");
      const approvalNode = flagValue(rest, "--approve");
      const grantNode = flagValue(rest, "--grant");
      if ([manualNode, approvalNode, grantNode].filter(Boolean).length > 1) {
        io.stderr("Choose at most one of --manual, --approve, or --grant.");
        return { exitCode: 2 };
      }
      const resolutionNode = manualNode ?? approvalNode ?? grantNode;
      if (resolutionNode && !flagValue(rest, "--evidence")) {
        io.stderr("Resolving a checkpoint requires --evidence <repository-relative-artifact>.");
        return { exitCode: 2 };
      }
      const effectInput = flagValue(rest, "--effect");
      const operationId = flagValue(rest, "--operation");
      const effect = effectInput ? sideEffectClassSchema.safeParse(effectInput) : undefined;
      if (grantNode && (!effectInput || !effect?.success || !operationId)) {
        io.stderr("--grant requires a valid --effect <effect> and --operation <operation-id>.");
        return { exitCode: 2 };
      }
      if (!grantNode && (effectInput || operationId)) {
        io.stderr("--effect and --operation may only be used with --grant.");
        return { exitCode: 2 };
      }
      const result = await services.resume({
        runId,
        authorization: flagValue(rest, "--authorization"),
        nodeId: resolutionNode,
        resolutionKind: manualNode
          ? "manual"
          : approvalNode
            ? "approval"
            : grantNode
              ? "checkpoint_grant"
              : undefined,
        evidenceArtifact: flagValue(rest, "--evidence"),
        effect: effect?.success ? effect.data : undefined,
        operationId,
        outputFile: flagValue(rest, "--output"),
        note: flagValue(rest, "--note"),
      });
      emit(io, result, true);
      return { exitCode: terminalWorkflowExitCode(result) };
    }

    if (command === "cancel") {
      const runId = positional(rest)[0];
      if (!runId) {
        io.stderr("vh cancel requires <run-id>.");
        return { exitCode: 2 };
      }
      const reason = flagValue(rest, "--reason") ?? "cancelled from vh CLI";
      const state = services.cancel
        ? await services.cancel(runId, reason)
        : await new WorkflowExecutor({ store }).cancel(runId, reason);
      emit(io, { runId: state.runId, status: state.status, reason }, true);
      if (!services.cancel) {
        io.stderr(
          "Cancellation was persisted without provider compensation. Next: configure the launch runtime to run any declared compensation hooks.",
        );
      }
      return { exitCode: 0 };
    }

    if (command === "explain") {
      const values = positional(rest);
      const runId = values.length >= 2 ? values[0] : latestRun(store);
      const nodeId = values.length >= 2 ? values[1] : values[0];
      if (!runId || !nodeId) {
        io.stderr("vh explain requires <node-id> and either <run-id> or an existing latest run.");
        return { exitCode: 2 };
      }
      const state = store.load(runId);
      const node = state.nodes[nodeId];
      if (!node) {
        io.stderr(`Run "${runId}" has no node "${nodeId}".`);
        return { exitCode: 1 };
      }
      emit(
        io,
        {
          runId,
          nodeId,
          purpose: node.definition.purpose,
          capability: node.definition.capability,
          state: node.state,
          dependencies: node.definition.dependencies,
          transport: node.definition.transport,
          effect: node.definition.effect,
          risk: node.definition.risk,
          authorization: node.definition.authorization,
          attempts: node.attempts,
          completion: node.definition.completion,
          evidenceArtifact: node.evidenceArtifact ?? null,
          error: node.error ?? null,
        },
        true,
      );
      return { exitCode: 0 };
    }

    if (command === "auth") {
      try {
        assertNoSecretsInArgv(rest);
      } catch (error) {
        io.stderr(error instanceof Error ? error.message : String(error));
        return { exitCode: 2 };
      }
      const authValues = positional(rest);
      const [action, provider] = authValues as ["login" | "status" | "test" | "revoke", string?];
      const unknownAuthFlag = rest.find(
        (value) =>
          value.startsWith("-") &&
          !["--ref", "--backend", "--kind", "--scopes", "--json"].includes(value),
      );
      const missingAuthFlagValue = ["--ref", "--backend", "--kind", "--scopes"].find((flag) => {
        const value = flagValue(rest, flag);
        return rest.includes(flag) && (!value || value.startsWith("-"));
      });
      if (
        authValues.length > 2 ||
        unknownAuthFlag ||
        missingAuthFlagValue ||
        !(["login", "status", "test", "revoke"] as string[]).includes(action)
      ) {
        io.stderr("Usage: vh auth login [provider] | status | test [provider] | revoke <provider>");
        return { exitCode: 2 };
      }
      if (action === "revoke" && !provider) {
        io.stderr("vh auth revoke requires <provider>.");
        return { exitCode: 2 };
      }
      if (!services.auth)
        return unsupported(
          io,
          `vh auth ${action}`,
          "configure the credential broker/provider adapter; credential values must never enter Git",
        );
      const requestedBackend = flagValue(rest, "--backend");
      const backend =
        action === "login" && provider
          ? (requestedBackend ??
            (["github", "vercel", "eas"].includes(provider)
              ? "cli_session"
              : process.platform === "darwin"
                ? "macos_keychain"
                : "onepassword"))
          : requestedBackend;
      const prompt = options.stackPrompt ?? systemFounderStackWizardPrompt();
      const readValue =
        action === "login" &&
        provider !== undefined &&
        (backend === "macos_keychain" || backend === "onepassword") &&
        prompt.isTty &&
        !json
          ? async () => {
              const value = await prompt.readCredential(
                `${provider} credential (input hidden; never argv or output): `,
              );
              if (!value) {
                throw new Error(
                  `No credential value was entered for ${provider}; rerun the same auth login command.`,
                );
              }
              return value;
            }
          : undefined;
      const result = await services.auth({
        action,
        provider,
        ref: flagValue(rest, "--ref"),
        backend,
        kind:
          flagValue(rest, "--kind") ??
          (action === "login" && provider === "stripe"
            ? "restricted_api_key"
            : action === "login" && provider === "google"
              ? "oauth"
              : undefined),
        scopes: flagValue(rest, "--scopes")
          ?.split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
        ...(readValue ? { readValue } : {}),
      });
      emit(io, result, json);
      return { exitCode: action === "test" ? authTestExitCode(result) : 0 };
    }

    if (command === "data" && positional(rest)[0] === "sync") {
      if (!services.dataSync)
        return unsupported(
          io,
          "vh data sync",
          "configure at least one read-only data connector and its credential reference",
        );
      emit(io, await services.dataSync(), json);
      return { exitCode: 0 };
    }

    if (command === "learn") {
      const cadence = positional(rest)[0] as "daily" | "weekly" | "biweekly" | "monthly";
      if (!(["daily", "weekly", "biweekly", "monthly"] as string[]).includes(cadence)) {
        io.stderr("Usage: vh learn daily|weekly|biweekly|monthly");
        return { exitCode: 2 };
      }
      if (!services.learn)
        return unsupported(
          io,
          `vh learn ${cadence}`,
          "configure normalized data inputs and the learning-loop runner",
        );
      emit(io, await services.learn(cadence), json);
      return { exitCode: 0 };
    }

    if (command === "upgrade") {
      if (!services.upgrade)
        return unsupported(
          io,
          "vh upgrade",
          "configure the harness release source and migration registry, then run vh upgrade --dry-run",
        );
      if (rest.includes("--release") && !flagValue(rest, "--release")) {
        io.stderr("Usage: vh upgrade [--release <local-root>] [--dry-run]");
        return { exitCode: 2 };
      }
      const report = await services.upgrade({
        dryRun: rest.includes("--dry-run"),
        releasePath: flagValue(rest, "--release"),
      });
      emit(io, report, json);
      const status =
        typeof report === "object" && report !== null && "status" in report
          ? report.status
          : undefined;
      return { exitCode: status === "failed" || status === "blocked" ? 1 : 0 };
    }

    io.stderr(`Unknown command "${command}".`);
    io.stderr("Next: run vh --help to see supported commands.");
    return { exitCode: 2 };
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}
