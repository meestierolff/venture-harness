#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileOperationalStateStore,
  createVentureRuntime,
  operationalCommandContracts,
} from "@venture-harness/agent-runtime";
import type { CommandExecutionContext } from "@venture-harness/core";
import {
  OPERATIONAL_CLI_HELP,
  createCliSurface,
  invokeOperationalCli,
  renderCliSuccess,
} from "./index.js";
import { createRepositoryQualityProfileRunner } from "./quality-runner.js";
import { loadProductionRuntimeModule } from "./runtime-module.js";

export interface GeneratedCliShellIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface RunGeneratedCliOptions {
  io?: GeneratedCliShellIo;
  cwd?: string;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function context(args: readonly string[], requireExplicit: boolean): CommandExecutionContext {
  const raw = flag(args, "--context");
  if (raw) {
    try {
      return JSON.parse(raw) as CommandExecutionContext;
    } catch {
      throw new Error("--context must be valid JSON");
    }
  }
  if (requireExplicit) {
    throw new Error("--context is required with an explicit production runtime module");
  }
  const organizationId = flag(args, "--org-id") ?? "local-org";
  const ventureId = flag(args, "--venture-id") ?? "local-venture";
  return {
    identity: { actorId: "local-operator", kind: "user" },
    tenant: { organizationId, ventureId },
    subscription: { subscriptionId: "local-none", status: "none", plan: "local" },
    entitlements: [],
    scopes: [],
    grants: [],
  };
}

/**
 * Run the generated command-bus shell without owning process startup.
 *
 * The root executable composes this advanced surface with the founder CLI. Keeping
 * this runner injectable prevents either shell from duplicating the other's
 * business logic while preserving the cli-generator package's own executable.
 */
export async function runGeneratedCli(
  inputArgs: readonly string[],
  options: RunGeneratedCliOptions = {},
): Promise<number> {
  const args = [...inputArgs];
  if (args[0] === "--") args.shift();
  const io = options.io ?? { stdout: console.log, stderr: console.error };

  try {
    if (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
      const localContext = context(args, false);
      const localRuntime = createVentureRuntime({
        commandExecutionMode: "fixture",
        memberships: [
          {
            organizationId: localContext.tenant.organizationId,
            actorId: localContext.identity.actorId,
            role: "operator",
            active: true,
          },
        ],
        growthContractRoot: options.cwd ?? process.cwd(),
      });
      io.stdout(
        `${OPERATIONAL_CLI_HELP}\n\nTyped Agent Surface form:\n${createCliSurface(localRuntime.bus).help}`,
      );
      return 0;
    }
    const runtimeModule = flag(args, "--runtime-module");
    const projectRoot = resolve(options.cwd ?? process.cwd(), flag(args, "--project-root") ?? ".");
    const stateDirectoryFlag = flag(args, "--state-dir") ?? ".venture-harness";
    const invocationContext = context(args, Boolean(runtimeModule));
    if (runtimeModule && !flag(args, "--idempotency-key")) {
      throw new Error("--idempotency-key is required with an explicit production runtime module");
    }
    const stateDirectory = resolve(projectRoot, stateDirectoryFlag);
    const runtime = runtimeModule
      ? await loadProductionRuntimeModule({
          projectRoot,
          runtimeModule,
          stateDirectory: stateDirectoryFlag,
        })
      : createVentureRuntime(
          (() => {
            const runtimeOptions = {
              commandExecutionMode: "fixture" as const,
              memberships: [
                {
                  organizationId: invocationContext.tenant.organizationId,
                  actorId: invocationContext.identity.actorId,
                  role: "operator" as const,
                  active: true,
                },
              ],
              growthContractRoot: projectRoot,
              operationalStore: new FileOperationalStateStore(stateDirectory),
              qualityProfileRunner: createRepositoryQualityProfileRunner(projectRoot),
            };
            return runtimeOptions;
          })(),
        );
    const cli = createCliSurface(runtime.bus);
    if (args[0] === "commands") {
      io.stdout(
        JSON.stringify(
          runtime.contracts.map((contract) => ({
            id: contract.id,
            description: contract.description,
            surfaces: contract.surfaces,
            packagedMode: ["auth.", "upgrade.", "fleet."].some((prefix) =>
              contract.id.startsWith(prefix),
            )
              ? "authorized_host_operation"
              : operationalCommandContracts.some(({ id }) => id === contract.id)
                ? "local_or_read_only"
                : "authorized_business_command",
          })),
          null,
          2,
        ),
      );
      return 0;
    }

    const exact = runtime.contracts.find(
      (contract) =>
        contract.surfaces.cli.tokens[0] === args[0] && contract.surfaces.cli.tokens[1] === args[1],
    );
    const operational = exact
      ? operationalCommandContracts.some(({ id }) => id === exact.id)
      : true;
    const invocation = {
      context: invocationContext,
      idempotencyKey: flag(args, "--idempotency-key") ?? "vh-generated-command",
    };
    const result = operational
      ? await invokeOperationalCli(runtime.bus, args, invocation)
      : await cli.invoke(args, invocation);
    if (!operational && result.exitCode === 0 && result.stdout && !args.includes("--json")) {
      try {
        result.stdout = renderCliSuccess(JSON.parse(result.stdout));
      } catch {
        result.exitCode = 1;
        result.stderr = "command runtime returned invalid JSON";
      }
    }
    if (result.stdout) io.stdout(result.stdout);
    if (result.stderr) io.stderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    const json = args.includes("--json");
    const message = error instanceof Error ? error.message : "packaged CLI failed";
    if (json) io.stderr(JSON.stringify({ error: "cli_initialization_failed", message }));
    else io.stderr(message);
    return 1;
  }
}

function isDirectGeneratedCliEntry(): boolean {
  if (!process.argv[1]) return false;
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  if (!modulePath.replaceAll("\\", "/").includes("/cli-generator/")) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === modulePath;
  } catch {
    return resolve(process.argv[1]) === modulePath;
  }
}

if (isDirectGeneratedCliEntry()) {
  void runGeneratedCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
