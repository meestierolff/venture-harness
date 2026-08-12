#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli, type CliIo, type CliResult, type CliServices } from "../lib/cli";
import {
  createDefaultCliServices,
  type DefaultCliServicesOptions,
} from "../lib/cli/default-services";
import { FileWorkflowStore } from "../lib/workflow";
import { runGeneratedCli, type GeneratedCliShellIo } from "../packages/cli-generator/src/bin";

declare const __VH_CORE_BUILD_COMMIT__: string | undefined;
declare const __VH_CORE_PACKAGE_VERSION__: string | undefined;

const IMMUTABLE_GIT_SHA = /^[a-f0-9]{40}$/u;

export interface FounderCoreBuildProvenance {
  readonly packageName: "venture-harness";
  readonly packageVersion: string;
  readonly workflowRefSha: string;
}

/**
 * Provenance embedded by the release build. This deliberately has no runtime
 * Git fallback: an installed CLI must never mistake its caller's repository
 * for the reviewed Venture Harness Core source revision.
 */
export function founderCoreBuildProvenance(): FounderCoreBuildProvenance {
  const workflowRefSha =
    typeof __VH_CORE_BUILD_COMMIT__ === "string" ? __VH_CORE_BUILD_COMMIT__ : undefined;
  const packageVersion =
    typeof __VH_CORE_PACKAGE_VERSION__ === "string" ? __VH_CORE_PACKAGE_VERSION__ : undefined;
  if (!workflowRefSha || !IMMUTABLE_GIT_SHA.test(workflowRefSha) || !packageVersion) {
    throw new Error(
      "The vh executable is missing immutable Venture Harness Core build provenance. Rebuild it with pnpm workspace:build before packing or installing it.",
    );
  }
  return Object.freeze({
    packageName: "venture-harness",
    packageVersion,
    workflowRefSha,
  });
}

export const FOUNDER_CORE_DOMAINS = new Set([
  "auth",
  "create",
  "data",
  "doctor",
  "idea",
  "launch",
  "learn",
  "plan",
  "resume",
  "stack",
  "status",
  "upgrade",
]);

export interface VhShellIo extends CliIo, GeneratedCliShellIo {}

export type FounderCliRunner = (
  args: readonly string[],
  options: { io: VhShellIo },
) => Promise<CliResult>;

export type AdvancedCliRunner = (
  args: readonly string[],
  options: { io: VhShellIo },
) => Promise<number>;

export type FounderCliServicesFactory = (options: DefaultCliServicesOptions) => CliServices;

export interface RunVhShellOptions {
  io?: VhShellIo;
  founderRunner?: FounderCliRunner;
  /** Test seam for the default founder runner; production uses the canonical services. */
  founderServicesFactory?: FounderCliServicesFactory;
  advancedRunner?: AdvancedCliRunner;
}

const defaultIo: VhShellIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

const defaultFounderServicesFactory: FounderCliServicesFactory = (options) =>
  createDefaultCliServices(options);

function runDefaultFounderCli(
  args: readonly string[],
  options: {
    io: VhShellIo;
    servicesFactory?: FounderCliServicesFactory;
  },
): Promise<CliResult> {
  const store = new FileWorkflowStore();
  const services = (options.servicesFactory ?? defaultFounderServicesFactory)({
    store,
    founderWorkflowRefSha: founderCoreBuildProvenance().workflowRefSha,
  });
  return runCli([...args], { io: options.io, services, store });
}

const defaultAdvancedRunner: AdvancedCliRunner = (args, options) =>
  runGeneratedCli(args, { io: options.io });

function routesToFounderCli(command: string | undefined): boolean {
  return (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    FOUNDER_CORE_DOMAINS.has(command)
  );
}

/**
 * Compose the public founder lifecycle and the generated advanced command bus.
 * Domain routing is the only policy here: each runner remains the sole owner of
 * parsing, authorization, persistence, provider effects, and output semantics.
 */
export async function runVhShell(
  inputArgs: readonly string[],
  options: RunVhShellOptions = {},
): Promise<number> {
  const args = [...inputArgs];
  if (args[0] === "--") args.shift();
  const io = options.io ?? defaultIo;

  if (routesToFounderCli(args[0])) {
    const result = options.founderRunner
      ? await options.founderRunner(args, { io })
      : await runDefaultFounderCli(args, {
          io,
          servicesFactory: options.founderServicesFactory,
        });
    return result.exitCode;
  }
  return (options.advancedRunner ?? defaultAdvancedRunner)(args, { io });
}

function isDirectRootCliEntry(): boolean {
  if (!process.argv[1]) return false;
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  try {
    return realpathSync(resolve(process.argv[1])) === modulePath;
  } catch {
    return resolve(process.argv[1]) === modulePath;
  }
}

if (isDirectRootCliEntry()) {
  void runVhShell(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
