import { existsSync, lstatSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AnyCommandContract,
  CommandBus,
  CommandInvocationOptions,
} from "@venture-harness/command-bus";
import type { JsonValue } from "@venture-harness/core";

export interface LoadedProductionVentureRuntime {
  bus: CommandBus;
  contracts: readonly AnyCommandContract[];
  executionMode: "production";
  durability: {
    commandIdempotency: "durable_atomic";
    audit: "durable_atomic";
    securityAudit: "durable_atomic";
    events: "durable_atomic";
    metering: "durable_atomic";
  };
  execute(commandId: string, input: unknown, options: CommandInvocationOptions): Promise<JsonValue>;
}

export interface VhRuntimeFactoryInput {
  readonly schemaVersion: 1;
  readonly projectRoot: string;
  readonly stateDirectory: string;
}

export type VhRuntimeFactory = (
  input: VhRuntimeFactoryInput,
) => Promise<LoadedProductionVentureRuntime> | LoadedProductionVentureRuntime;

function canonicalRoot(root: string): string {
  const declared = resolve(root);
  const details = lstatSync(declared);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("runtime project root must be a regular directory, not a symbolic link");
  }
  return realpathSync(declared);
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function assertNoSymlinkComponents(root: string, target: string, allowMissingLeaf: boolean): void {
  if (!inside(root, target)) throw new Error("runtime path must stay within the project root");
  const child = relative(root, target);
  let cursor = root;
  for (const [index, segment] of child.split(sep).filter(Boolean).entries()) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) {
      if (allowMissingLeaf) return;
      throw new Error("runtime module does not exist");
    }
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error("runtime path must not contain symbolic links");
    }
    if (index < child.split(sep).filter(Boolean).length - 1 && !lstatSync(cursor).isDirectory()) {
      throw new Error("runtime path parent must be a directory");
    }
  }
}

function projectOwnedFile(root: string, path: string): string {
  const target = resolve(root, path);
  assertNoSymlinkComponents(root, target, false);
  const child = relative(root, target);
  const first = child.split(sep)[0];
  if (["node_modules", ".git", ".pnpm"].includes(first ?? "")) {
    throw new Error("runtime module must be a project-owned file outside dependency metadata");
  }
  if (![".js", ".mjs", ".cjs"].includes(extname(target))) {
    throw new Error("runtime module must be compiled JavaScript (.js, .mjs, or .cjs)");
  }
  const details = lstatSync(target);
  if (!details.isFile()) throw new Error("runtime module must be a regular file");
  const canonical = realpathSync(target);
  if (!inside(root, canonical)) throw new Error("runtime module resolves outside the project root");
  return canonical;
}

function projectOwnedStateDirectory(root: string, path: string): string {
  const target = resolve(root, path);
  assertNoSymlinkComponents(root, target, true);
  return target;
}

function assertProductionRuntime(value: unknown): asserts value is LoadedProductionVentureRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("createVhRuntime must return a VentureRuntime object");
  }
  const runtime = value as Partial<LoadedProductionVentureRuntime>;
  if (runtime.executionMode !== "production") {
    throw new Error("explicit runtime module must compose commandExecutionMode=production");
  }
  const durability = runtime.durability;
  const required = ["commandIdempotency", "audit", "securityAudit", "events", "metering"] as const;
  if (!durability || required.some((field) => durability[field] !== "durable_atomic")) {
    throw new Error(
      "explicit production runtime requires durable atomic command and evidence stores",
    );
  }
  if (
    !runtime.bus ||
    typeof runtime.bus.contracts !== "function" ||
    !Array.isArray(runtime.contracts) ||
    typeof runtime.execute !== "function"
  ) {
    throw new Error("createVhRuntime returned an invalid command runtime shape");
  }
}

/**
 * Load exactly one explicitly named, project-owned compiled module. There is
 * intentionally no discovery, source import, tsx fallback, or serialized
 * function/credential configuration.
 */
export async function loadProductionRuntimeModule(options: {
  projectRoot: string;
  runtimeModule: string;
  stateDirectory: string;
}): Promise<LoadedProductionVentureRuntime> {
  const root = canonicalRoot(options.projectRoot);
  const modulePath = projectOwnedFile(root, options.runtimeModule);
  const stateDirectory = projectOwnedStateDirectory(root, options.stateDirectory);
  const loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  if (typeof loaded.createVhRuntime !== "function") {
    throw new Error("runtime module must export a createVhRuntime factory");
  }
  const factory = loaded.createVhRuntime as VhRuntimeFactory;
  const runtime = await factory(
    Object.freeze({ schemaVersion: 1, projectRoot: root, stateDirectory }),
  );
  assertProductionRuntime(runtime);
  return runtime;
}
