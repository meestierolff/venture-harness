import { FileWorkflowStore, WorkflowExecutor, type WorkflowStore } from "../workflow";
import { sideEffectClassSchema } from "../config/policy-schema";
import { createDefaultCliServices } from "./default-services";
import type { CliIo, CliLaunchRequest, CliResult, CliServices } from "./types";

export * from "./types";

export interface RunCliOptions {
  io?: CliIo;
  services?: CliServices;
  store?: WorkflowStore;
}

const HELP = `Venture Harness CLI

Usage:
  vh auth login [provider]         Authenticate through a configured provider adapter
  vh auth status                  Show credential references and provider auth state
  vh auth test [provider]          Test access/scopes without exposing credential values
  vh auth revoke <provider>       Revoke through a configured provider adapter
    --ref cred://provider/name --backend environment|macos_keychain|onepassword|cli_session
    --kind <credential-kind> --scopes <comma-separated>
  vh doctor                       Inspect local launch prerequisites
  vh create --brief <file>        Validate and persist one progressive-commitment brief
  vh plan [--brief <file>]        Compile a launch plan without side effects
  vh launch --dry-run             Show nodes, effects, approvals, cost, and manual work
  vh launch --apply --authorization <profile>
                                  Execute an authorized launch graph
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
          "--release",
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
      const [action, provider] = positional(rest) as [
        "login" | "status" | "test" | "revoke",
        string?,
      ];
      if (!(["login", "status", "test", "revoke"] as string[]).includes(action)) {
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
      emit(
        io,
        await services.auth({
          action,
          provider,
          ref: flagValue(rest, "--ref"),
          backend: flagValue(rest, "--backend"),
          kind: flagValue(rest, "--kind"),
          scopes: flagValue(rest, "--scopes")
            ?.split(",")
            .map((scope) => scope.trim())
            .filter(Boolean),
        }),
        json,
      );
      return { exitCode: 0 };
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
