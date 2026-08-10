/**
 * IO shell for `vh stack connect founder-default`.
 *
 * Detection, hidden prompting and credential storage live here so that
 * stack-connect.ts stays a pure, testable planner. Every function in this file
 * either reads public account metadata or writes a secret straight into a
 * credential backend; no secret is returned to a caller, logged, or persisted
 * into Venture Harness state.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  FOUNDER_STACK_PLAN,
  credentialRefFor,
  type CollectedRole,
  type DetectedSession,
} from "./stack-connect";

function tryCommand(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read back the GitHub CLI session.
 *
 * `gh api user` is used rather than `gh auth status` because it proves the
 * token actually works against the API. A stored token that no longer has
 * access would otherwise look like a healthy session.
 */
export function detectGitHubSession(): DetectedSession {
  const login = tryCommand("gh", ["api", "user", "--jq", ".login"]);
  if (!login) {
    return {
      provider: "github",
      authenticated: false,
      detail: "No usable GitHub CLI session.",
    };
  }
  return { provider: "github", authenticated: true, account: login };
}

export function detectVercelSession(): DetectedSession {
  const who = tryCommand("vercel", ["whoami"]);
  if (!who) {
    return {
      provider: "vercel",
      authenticated: false,
      detail: "No usable Vercel CLI session.",
    };
  }
  return { provider: "vercel", authenticated: true, account: who.split("\n").at(-1)?.trim() };
}

export function detectSessions(): DetectedSession[] {
  return [detectGitHubSession(), detectVercelSession()];
}

/** Public account metadata only; never a token. */
export function discoverGitHubOwner(): string | undefined {
  return tryCommand("gh", ["api", "user", "--jq", ".login"]) ?? undefined;
}

export function discoverVercelScope(): string | undefined {
  return tryCommand("vercel", ["whoami"])?.split("\n").at(-1)?.trim();
}

export interface PromptIo {
  readonly write: (line: string) => void;
  readonly isTty: boolean;
}

/**
 * Read one line without echoing it.
 *
 * The value is never placed in argv, an environment variable, or a file, so it
 * cannot be recovered from the process table or shell history.
 */
export async function readHidden(question: string, io: PromptIo): Promise<string> {
  if (!io.isTty) {
    throw new Error(
      "A credential value can only be collected from an interactive terminal. " +
        "Next: run vh stack connect founder-default in a terminal, or store the value yourself and record only its cred:// reference.",
    );
  }
  io.write(question);
  const input = process.stdin;
  const rl = createInterface({ input, output: process.stdout, terminal: true });
  const previouslyRaw = input.isRaw ?? false;
  // Mute the echo without muting the newline handling readline needs.
  const originalWrite = (
    rl as unknown as { _writeToOutput?: (text: string) => void }
  )._writeToOutput?.bind(rl);
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
    if (text.includes("\n")) originalWrite?.("\n");
  };
  try {
    return await new Promise<string>((resolve) => {
      rl.question("", (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
    if (input.isTTY && !previouslyRaw) input.setRawMode?.(false);
  }
}

export interface CredentialWriter {
  /** Store a value under a reference and return nothing. */
  readonly store: (reference: string, value: string) => Promise<void>;
  readonly backendId: string;
}

export interface CollectOptions {
  readonly profileId: string;
  readonly io: PromptIo;
  readonly writer: CredentialWriter;
  readonly sessions: readonly DetectedSession[];
  /** Roles the founder chose to configure now. */
  readonly roles: readonly string[];
  readonly identifiers: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Collect credentials for the selected roles and return references only.
 *
 * CLI-session roles never prompt: their credential is the session itself, so a
 * reference is recorded and the value stays with the provider's own CLI.
 */
export async function collectRoles(options: CollectOptions): Promise<CollectedRole[]> {
  const collected: CollectedRole[] = [];
  for (const plan of FOUNDER_STACK_PLAN) {
    if (!options.roles.includes(plan.role)) continue;
    const credentialRef = credentialRefFor(plan.provider, options.profileId);
    if (plan.authStyle === "api_key") {
      const value = await readHidden(
        `${plan.provider} API key for ${plan.role} (input hidden): `,
        options.io,
      );
      if (!value) {
        throw new Error(
          `No value was entered for ${plan.role}. Next: rerun vh stack connect founder-default and paste the ${plan.provider} credential.`,
        );
      }
      await options.writer.store(credentialRef, value);
      options.io.write(
        `stored ${credentialRef} in ${options.writer.backendId}; Venture Harness keeps only this reference\n`,
      );
    }
    collected.push({
      role: plan.role,
      credentialRef,
      identifiers: options.identifiers[plan.role] ?? {},
    });
  }
  return collected;
}
