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
import type { CredentialKind } from "../credentials";
import {
  FOUNDER_STACK_PLAN,
  credentialRefFor,
  type CollectedRole,
  type DetectedSession,
} from "./stack-connect";
import type { FounderStackConnectionDraftInput, FounderStackConnectionDraftRole } from "./stack";

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const SAFE_ACCOUNT_IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/u;

export interface ReadOnlyCliProbeRunner {
  run(command: string, args: readonly string[]): string | null;
}

const systemProbeRunner: ReadOnlyCliProbeRunner = {
  run(command, args) {
    try {
      return execFileSync(command, [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 20_000,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        env: {
          NODE_ENV: process.env.NODE_ENV ?? "production",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          NO_COLOR: "1",
        },
      }).trim();
    } catch {
      return null;
    }
  },
};

function tryCommand(
  runner: ReadOnlyCliProbeRunner,
  command: string,
  args: readonly string[],
): string | null {
  try {
    const output = runner.run(command, args);
    if (output === null || Buffer.byteLength(output, "utf8") > MAX_PROBE_OUTPUT_BYTES) return null;
    return output.trim();
  } catch {
    return null;
  }
}

function safeAccount(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && SAFE_ACCOUNT_IDENTIFIER.test(candidate) ? candidate : undefined;
}

function installed(runner: ReadOnlyCliProbeRunner, binary: string): boolean {
  return tryCommand(runner, binary, ["--version"]) !== null;
}

/**
 * Read back the GitHub CLI session.
 *
 * `gh api user` is used rather than `gh auth status` because it proves the
 * token actually works against the API. A stored token that no longer has
 * access would otherwise look like a healthy session.
 */
export function detectGitHubSession(
  runner: ReadOnlyCliProbeRunner = systemProbeRunner,
): DetectedSession {
  const cliInstalled = installed(runner, "gh");
  const login = safeAccount(tryCommand(runner, "gh", ["api", "user", "--jq", ".login"]));
  if (!login) {
    return {
      provider: "github",
      installed: cliInstalled,
      authenticated: false,
      detail: cliInstalled ? "GitHub CLI session needs login." : "GitHub CLI is not installed.",
    };
  }
  return { provider: "github", installed: true, authenticated: true, account: login };
}

export function detectVercelSession(
  runner: ReadOnlyCliProbeRunner = systemProbeRunner,
): DetectedSession {
  const cliInstalled = installed(runner, "vercel");
  const who = tryCommand(runner, "vercel", ["whoami"]);
  const account = safeAccount(who?.split("\n").at(-1));
  if (!account) {
    return {
      provider: "vercel",
      installed: cliInstalled,
      authenticated: false,
      detail: cliInstalled ? "Vercel CLI session needs login." : "Vercel CLI is not installed.",
    };
  }
  return { provider: "vercel", installed: true, authenticated: true, account };
}

interface StripeAccountResponse {
  readonly id?: unknown;
}

interface StripeBalanceResponse {
  readonly livemode?: unknown;
}

const STRIPE_ACCOUNT_PROBE_ARGS = ["get", "/v1/account"] as const;
const STRIPE_BALANCE_PROBE_ARGS = ["get", "/v1/balance"] as const;

function parseJsonRecord(value: string | null): Readonly<Record<string, unknown>> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Prove an official Stripe CLI session with two bounded GETs and retain only
 * account ID plus the fact that the response was from test mode. Arbitrary
 * account responses and CLI configuration are never returned or persisted.
 */
export function detectStripeSession(
  runner: ReadOnlyCliProbeRunner = systemProbeRunner,
): DetectedSession {
  const cliInstalled = installed(runner, "stripe");
  if (!cliInstalled) {
    return {
      provider: "stripe",
      installed: false,
      authenticated: false,
      detail: "Stripe CLI is not installed; use the official install command before login.",
    };
  }
  // Stripe API commands emit JSON by default. The current official CLI rejects
  // the older `--format json` arguments before attempting either bounded read.
  const accountResponse = parseJsonRecord(
    tryCommand(runner, "stripe", STRIPE_ACCOUNT_PROBE_ARGS),
  ) as StripeAccountResponse | null;
  const balanceResponse = parseJsonRecord(
    tryCommand(runner, "stripe", STRIPE_BALANCE_PROBE_ARGS),
  ) as StripeBalanceResponse | null;
  const account = safeAccount(
    typeof accountResponse?.id === "string" ? accountResponse.id : undefined,
  );
  if (!account || balanceResponse?.livemode !== false) {
    return {
      provider: "stripe",
      installed: true,
      authenticated: false,
      detail: "Stripe CLI did not prove an authenticated test-mode session.",
    };
  }
  return {
    provider: "stripe",
    installed: true,
    authenticated: true,
    account,
    mode: "test",
  };
}

export function detectSessions(
  runner: ReadOnlyCliProbeRunner = systemProbeRunner,
): DetectedSession[] {
  return [detectGitHubSession(runner), detectVercelSession(runner), detectStripeSession(runner)];
}

/** Public account metadata only; never a token. */
export function discoverGitHubOwner(
  runner: ReadOnlyCliProbeRunner = systemProbeRunner,
): string | undefined {
  return safeAccount(tryCommand(runner, "gh", ["api", "user", "--jq", ".login"]));
}

export function discoverVercelScope(
  runner: ReadOnlyCliProbeRunner = systemProbeRunner,
): string | undefined {
  return safeAccount(tryCommand(runner, "vercel", ["whoami"])?.split("\n").at(-1));
}

export function collectedCliSessionRoles(
  sessions: readonly DetectedSession[],
  profileId: string,
): CollectedRole[] {
  const byProvider = new Map(sessions.map((session) => [session.provider, session]));
  const github = byProvider.get("github");
  const vercel = byProvider.get("vercel");
  return [
    ...(github?.authenticated && github.account
      ? [
          {
            role: "source.repository" as const,
            credentialRef: credentialRefFor("github", profileId),
            identifiers: { accountId: github.account, organizationId: github.account },
          },
        ]
      : []),
    ...(vercel?.authenticated && vercel.account
      ? [
          {
            role: "hosting.web" as const,
            credentialRef: credentialRefFor("vercel", profileId),
            identifiers: { accountId: vercel.account, teamId: vercel.account },
          },
        ]
      : []),
  ];
}

/**
 * Convert reference-only wizard answers to the strict Stack draft role shape.
 * Only account-matched GitHub/Vercel CLI sessions declare verification here;
 * API-key roles remain unverified until the bounded provider doctor proves them.
 */
export function founderStackConnectionDraftRoles(
  collected: readonly CollectedRole[],
  sessions: readonly DetectedSession[],
): FounderStackConnectionDraftRole[] {
  const sessionByProvider = new Map(
    sessions.map((session) => [session.provider, session] as const),
  );
  return collected.map((entry) => {
    const rolePlan = FOUNDER_STACK_PLAN.find(({ role }) => role === entry.role);
    const session = rolePlan ? sessionByProvider.get(rolePlan.provider) : undefined;
    const accountId = entry.identifiers.accountId?.trim();
    const cliVerified =
      rolePlan?.authStyle === "cli_session" &&
      session?.authenticated === true &&
      Boolean(session.account) &&
      session.account === accountId;
    return {
      role: entry.role,
      ...(entry.credentialRef ? { credentialRef: entry.credentialRef } : {}),
      ...(accountId ? { accountId } : {}),
      ...(entry.identifiers.teamId?.trim() ? { teamId: entry.identifiers.teamId.trim() } : {}),
      ...(entry.identifiers.organizationId?.trim()
        ? { organizationId: entry.identifiers.organizationId.trim() }
        : {}),
      scopes: [...(rolePlan?.scopes ?? [])],
      ...(cliVerified ? { verifiedBy: "official_cli" as const } : {}),
    };
  });
}

export function safeCliSessionMetadata(
  sessions: readonly DetectedSession[],
  verifiedAt = new Date().toISOString(),
): {
  github: {
    installed: boolean;
    authenticated: boolean;
    accountId: string | null;
    mode: null;
    verifiedAt: string | null;
  } | null;
  vercel: {
    installed: boolean;
    authenticated: boolean;
    accountId: string | null;
    mode: null;
    verifiedAt: string | null;
  } | null;
  stripe: {
    installed: boolean;
    authenticated: boolean;
    accountId: string | null;
    mode: "test" | null;
    verifiedAt: string | null;
  } | null;
} {
  const byProvider = new Map(sessions.map((session) => [session.provider, session]));
  const common = (provider: "github" | "vercel" | "stripe") => {
    const session = byProvider.get(provider);
    if (!session) return null;
    return {
      installed: session.installed ?? session.authenticated,
      authenticated: session.authenticated,
      accountId: session.account ?? null,
      verifiedAt: session.authenticated ? verifiedAt : null,
    };
  };
  const github = common("github");
  const vercel = common("vercel");
  const stripe = common("stripe");
  return {
    github: github ? { ...github, mode: null } : null,
    vercel: vercel ? { ...vercel, mode: null } : null,
    stripe: stripe ? { ...stripe, mode: byProvider.get("stripe")?.mode ?? null } : null,
  };
}

export interface PromptIo {
  readonly write: (line: string) => void;
  readonly isTty: boolean;
}

export interface FounderStackWizardPrompt extends PromptIo {
  readonly readVisible: (question: string) => Promise<string>;
  readonly readCredential: (question: string) => Promise<string>;
}

/** Real terminal prompt; callers must not use it for `--json` output. */
export function systemFounderStackWizardPrompt(): FounderStackWizardPrompt {
  const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const prompt: FounderStackWizardPrompt = {
    isTty,
    write: (line) => process.stdout.write(line),
    async readVisible(question) {
      if (!isTty) throw new Error("Founder Stack answers require an interactive terminal");
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        return await new Promise<string>((resolve) => {
          rl.question(question, (answer) => resolve(answer.trim()));
        });
      } finally {
        rl.close();
      }
    },
    readCredential: (question) => readHidden(question, prompt),
  };
  return prompt;
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
  /** Invoke the hidden reader only inside the broker's immediate store boundary. */
  readonly store: (request: CredentialWriteRequest) => Promise<void>;
  readonly backendId: string;
}

export interface CredentialWriteRequest {
  readonly reference: string;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly backend: "macos_keychain" | "onepassword";
  readonly scopes: readonly string[];
  readonly accountId?: string;
  readonly readValue: () => Promise<string>;
}

export interface CollectOptions {
  readonly profileId: string;
  readonly io: PromptIo;
  readonly writer: CredentialWriter;
  readonly sessions: readonly DetectedSession[];
  /** Roles the founder chose to configure now. */
  readonly roles: readonly string[];
  readonly identifiers: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly backend: "macos_keychain" | "onepassword";
  /** Injectable only so fixture tests can prove values never reach output/state. */
  readonly readCredential?: (question: string, io: PromptIo) => Promise<string>;
}

/**
 * Collect credentials for the selected roles and return references only.
 *
 * Pure CLI-session roles never prompt. Stripe may use the official CLI as a
 * safe test-mode check, but REST operations still require a separately
 * brokered restricted test key collected through the hidden prompt.
 */
export async function collectRoles(options: CollectOptions): Promise<CollectedRole[]> {
  const collected: CollectedRole[] = [];
  const sessionByProvider = new Map(
    options.sessions.map((session) => [session.provider, session] as const),
  );
  for (const plan of FOUNDER_STACK_PLAN) {
    if (!options.roles.includes(plan.role)) continue;
    if (plan.authStyle === "cli_session" && !sessionByProvider.get(plan.provider)?.authenticated) {
      continue;
    }
    const credentialRef = credentialRefFor(plan.provider, options.profileId);
    if (plan.authStyle === "api_key" || plan.authStyle === "cli_session_with_api_key") {
      try {
        await options.writer.store({
          reference: credentialRef,
          provider: plan.provider,
          kind:
            plan.provider === "stripe"
              ? "restricted_api_key"
              : plan.provider === "google"
                ? "oauth"
                : "api_key",
          backend: options.backend,
          scopes: plan.scopes,
          ...(options.identifiers[plan.role]?.accountId
            ? { accountId: options.identifiers[plan.role].accountId }
            : {}),
          readValue: async () => {
            const value = await (options.readCredential ?? readHidden)(
              `${plan.provider} credential for ${plan.role} (input hidden): `,
              options.io,
            );
            if (!value) {
              throw new Error(
                `No value was entered for ${plan.role}. Next: rerun vh stack connect founder-default and paste the ${plan.provider} credential.`,
              );
            }
            return value;
          },
        });
      } catch {
        throw new Error(
          `Could not store the credential for ${plan.role}. Next: check the configured credential backend and retry.`,
        );
      }
      const backendLabel = /^[A-Za-z0-9_.-]{1,64}$/u.test(options.writer.backendId)
        ? options.writer.backendId
        : "credential-backend";
      options.io.write(
        `stored ${credentialRef} in ${backendLabel}; Venture Harness keeps only this reference\n`,
      );
    }
    collected.push({
      role: plan.role,
      ...(plan.authStyle === "manual" ? {} : { credentialRef }),
      identifiers: options.identifiers[plan.role] ?? {},
    });
  }
  return collected;
}

const GUIDED_OPTIONAL_ROLES = ["email.transactional", "growth.google", "search.bing"] as const;

export type GuidedFounderStackRole =
  "database.postgres" | "commerce.web" | (typeof GUIDED_OPTIONAL_ROLES)[number] | "dns.records";

export interface FounderStackWizardResult {
  readonly collected: readonly CollectedRole[];
  readonly selectedOptionalRoles: FounderStackConnectionDraftInput["selectedOptionalRoles"];
  readonly writableCredentialBackend: FounderStackConnectionDraftInput["writableCredentialBackend"];
  readonly launchDefaults: FounderStackConnectionDraftInput["launchDefaults"];
}

async function requiredAnswer(
  prompt: FounderStackWizardPrompt,
  question: string,
  label: string,
): Promise<string> {
  const value = (await prompt.readVisible(question)).trim();
  if (!value) throw new Error(`${label} is required; rerun the same Stack connection command.`);
  return value;
}

async function selectedNow(
  prompt: FounderStackWizardPrompt,
  role: (typeof GUIDED_OPTIONAL_ROLES)[number],
): Promise<boolean> {
  const provider = FOUNDER_STACK_PLAN.find((entry) => entry.role === role)?.provider ?? role;
  const answer = (await prompt.readVisible(`Configure optional ${provider} now? [y/N]: `))
    .trim()
    .toLowerCase();
  if (!answer) return false;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  throw new Error(`Answer yes or no for optional ${provider}, then rerun Stack connection.`);
}

/**
 * Collect safe role metadata/defaults and stream secret reads straight into a
 * writable broker. RevenueCat is deliberately not a guided web-rail role.
 */
export async function collectFounderStackWizard(options: {
  readonly profileId: string;
  readonly sessions: readonly DetectedSession[];
  readonly prompt: FounderStackWizardPrompt;
  readonly writer: CredentialWriter;
  readonly backend: "macos_keychain" | "onepassword";
  readonly onlyRole?: GuidedFounderStackRole;
}): Promise<FounderStackWizardResult> {
  if (!options.prompt.isTty) {
    throw new Error("Founder Stack credential collection requires an interactive terminal");
  }
  const configure = new Set<GuidedFounderStackRole>();
  if (options.onlyRole) configure.add(options.onlyRole);
  else {
    configure.add("database.postgres");
    configure.add("commerce.web");
    for (const role of GUIDED_OPTIONAL_ROLES) {
      if (await selectedNow(options.prompt, role)) configure.add(role);
    }
  }

  const identifiers: Record<string, Record<string, string>> = {};
  let launchDefaults: NonNullable<FounderStackConnectionDraftInput["launchDefaults"]> = {};
  if (configure.has("database.postgres")) {
    const organizationId = await requiredAnswer(
      options.prompt,
      "Neon organization ID: ",
      "Neon organization ID",
    );
    identifiers["database.postgres"] = { organizationId };
    launchDefaults = {
      ...launchDefaults,
      neonRegion: await requiredAnswer(
        options.prompt,
        "Neon region ID (review data location first): ",
        "Neon region ID",
      ),
    };
  }
  if (configure.has("commerce.web")) {
    const stripeAccount = options.sessions.find(
      ({ provider, authenticated, mode, account }) =>
        provider === "stripe" && authenticated && mode === "test" && account,
    )?.account;
    identifiers["commerce.web"] = {
      accountId:
        stripeAccount ??
        (await requiredAnswer(
          options.prompt,
          "Stripe test account ID (acct_…): ",
          "Stripe account ID",
        )),
    };
  }
  if (configure.has("email.transactional")) {
    identifiers["email.transactional"] = {};
    launchDefaults = {
      ...launchDefaults,
      brevo: {
        senderName: await requiredAnswer(
          options.prompt,
          "Brevo sender name: ",
          "Brevo sender name",
        ),
        senderEmail: await requiredAnswer(
          options.prompt,
          "Brevo verified sender email: ",
          "Brevo sender email",
        ),
        templateName: await requiredAnswer(
          options.prompt,
          "Brevo template name: ",
          "Brevo template name",
        ),
        templateSubject: await requiredAnswer(
          options.prompt,
          "Brevo template subject: ",
          "Brevo template subject",
        ),
        templateHtml: await requiredAnswer(
          options.prompt,
          "Brevo template HTML (one line): ",
          "Brevo template HTML",
        ),
      },
    };
  }
  if (configure.has("growth.google")) {
    const analyticsAccountId = await requiredAnswer(
      options.prompt,
      "Google Analytics account ID (digits only): ",
      "Google Analytics account ID",
    );
    identifiers["growth.google"] = { accountId: analyticsAccountId };
    launchDefaults = { ...launchDefaults, googleAnalyticsAccountId: analyticsAccountId };
  }
  if (configure.has("search.bing")) {
    identifiers["search.bing"] = {};
    launchDefaults = { ...launchDefaults, bingAuthMode: "api_key" };
  }
  if (configure.has("dns.records")) {
    const adapter = await requiredAnswer(
      options.prompt,
      "DNS adapter (manual_generic or mijndomein_manual): ",
      "DNS adapter",
    );
    if (adapter !== "manual_generic" && adapter !== "mijndomein_manual") {
      throw new Error("DNS adapter must be manual_generic or mijndomein_manual.");
    }
    const registrarAccountId = await requiredAnswer(
      options.prompt,
      "DNS registrar/zone owner ID: ",
      "DNS registrar/zone owner ID",
    );
    identifiers["dns.records"] = { organizationId: registrarAccountId };
    launchDefaults = { ...launchDefaults, dns: { adapter, registrarAccountId } };
  }

  const collected = await collectRoles({
    profileId: options.profileId,
    io: options.prompt,
    writer: options.writer,
    sessions: options.sessions,
    roles: [...configure],
    identifiers,
    backend: options.backend,
    readCredential: (question) => options.prompt.readCredential(question),
  });
  const selectedOptionalRoles = options.onlyRole
    ? ([options.onlyRole].filter(
        (role) =>
          GUIDED_OPTIONAL_ROLES.includes(role as (typeof GUIDED_OPTIONAL_ROLES)[number]) ||
          role === "dns.records",
      ) as FounderStackConnectionDraftInput["selectedOptionalRoles"])
    : ([
        ...GUIDED_OPTIONAL_ROLES.filter((role) => configure.has(role)),
        // DNS remains an explicit manual follow-up on the default web path; it
        // is never silently treated as configured.
        "dns.records",
      ] satisfies FounderStackConnectionDraftInput["selectedOptionalRoles"]);
  return {
    collected,
    selectedOptionalRoles,
    writableCredentialBackend: { mode: "shared", backend: options.backend },
    launchDefaults,
  };
}
