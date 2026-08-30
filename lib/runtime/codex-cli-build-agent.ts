import { resolve } from "node:path";
import type { Redactor } from "../credentials";
import {
  BuildAgentHostError,
  type BuildAgentHost,
  type BuildAgentHostInspection,
  type BuildAgentRequest,
  type BuildAgentResult,
} from "./build-agent-host";

export interface CodexCliBuildAgentHostOptions {
  rootDir: string;
  redactor?: Redactor;
  binary?: string;
  /** Reserved for a future audited driver; does not enable execution. */
  model?: string;
}

const OUTER_READ_ISOLATION_UNAVAILABLE =
  "Codex model execution is disabled: no audited outer read-isolation driver is available. A valid Launch Contract can still use the zero-model path; founder alpha cannot run rough-idea or product-build model calls.";

const CODEX_ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "PATH",
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "CI",
  "SystemRoot",
  "PATHEXT",
] as const;

const PRODUCT_COMMAND_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "CI",
  "SystemRoot",
  "PATHEXT",
] as const;

/**
 * Credential-free environment projection retained for a future audited
 * driver. Founder alpha never passes it to a model process.
 */
export function codexBuildAgentEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    NODE_ENV: source.NODE_ENV ?? "production",
    ...Object.fromEntries(
      CODEX_ENVIRONMENT_KEYS.flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
  };
}

/**
 * Environment for deterministic commands executed inside a generated child.
 * Provider credentials, the founder's Codex auth directory, and user package
 * configuration are deliberately excluded. HOME/XDG/npm configuration are
 * redirected into the child-owned private runtime directory.
 */
export function productCommandEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedHome: string,
): NodeJS.ProcessEnv {
  const home = resolve(isolatedHome);
  return {
    NODE_ENV: source.NODE_ENV ?? "production",
    ...Object.fromEntries(
      PRODUCT_COMMAND_ENVIRONMENT_KEYS.flatMap((key) =>
        source[key] === undefined ? [] : [[key, source[key]]],
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: resolve(home, ".config"),
    npm_config_userconfig: resolve(home, ".npmrc"),
    NPM_CONFIG_USERCONFIG: resolve(home, ".npmrc"),
  };
}

/**
 * Public founder-alpha host. It cannot accept a runner, attestation string, or
 * caller-created capability, so model execution is impossible until Core owns
 * and audits a non-forgeable platform driver.
 */
export class CodexCliBuildAgentHost implements BuildAgentHost {
  readonly id = "codex_cli";

  constructor(options: CodexCliBuildAgentHostOptions) {
    void resolve(options.rootDir);
    void options.redactor;
    void options.binary;
    void options.model;
  }

  inspect(): Promise<BuildAgentHostInspection> {
    return Promise.resolve({
      host: this.id,
      status: "unavailable",
      readIsolation: "unavailable",
      version: null,
      billingMode: "unknown",
      billingEvidence: null,
      nextAction: OUTER_READ_ISOLATION_UNAVAILABLE,
    });
  }

  async run(request: BuildAgentRequest): Promise<BuildAgentResult> {
    void request;
    throw new BuildAgentHostError("host_unavailable", OUTER_READ_ISOLATION_UNAVAILABLE);
  }
}
