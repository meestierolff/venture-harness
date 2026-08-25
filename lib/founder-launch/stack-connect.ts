/**
 * Guided one-time founder Stack connection.
 *
 * The planning here is deliberately pure: it turns detected CLI sessions and
 * collected answers into a credential-free Stack document plus the exact
 * unresolved actions. Prompting, credential storage and provider calls live in
 * the CLI shell, so the decision rules can be tested without a real account.
 *
 * A secret value never enters this module. Only `cred://` references do.
 */

export const FOUNDER_STACK_ROLES = [
  "source.repository",
  "hosting.web",
  "database.postgres",
  "commerce.web",
  "commerce.native",
  "email.transactional",
  "growth.google",
  "search.bing",
  "dns.records",
] as const;
export type FounderStackRole = (typeof FOUNDER_STACK_ROLES)[number];

export interface StackRolePlan {
  readonly role: FounderStackRole;
  readonly provider: string;
  /** How the founder proves identity for this role. */
  readonly authStyle: "cli_session" | "cli_session_with_api_key" | "api_key" | "manual";
  /** Roles outside the default web rail are optional in v0.2. */
  readonly required: boolean;
  readonly identifiers: readonly string[];
  readonly scopes: readonly string[];
}

/**
 * The v0.2 default rail. RevenueCat is present because the Stack schema models
 * it, but native commerce is not part of the default web launch, so it is not
 * required to complete a connection.
 */
export const FOUNDER_STACK_PLAN: readonly StackRolePlan[] = [
  {
    role: "source.repository",
    provider: "github",
    authStyle: "cli_session",
    required: true,
    identifiers: ["accountId", "organizationId"],
    scopes: ["repo", "workflow"],
  },
  {
    role: "hosting.web",
    provider: "vercel",
    authStyle: "cli_session",
    required: true,
    identifiers: ["accountId", "teamId"],
    scopes: [],
  },
  {
    role: "database.postgres",
    provider: "neon",
    authStyle: "api_key",
    required: true,
    identifiers: ["organizationId"],
    scopes: [],
  },
  {
    role: "commerce.web",
    provider: "stripe",
    authStyle: "cli_session_with_api_key",
    required: true,
    identifiers: ["accountId"],
    scopes: [],
  },
  {
    role: "email.transactional",
    provider: "brevo",
    authStyle: "api_key",
    required: false,
    identifiers: [],
    scopes: [],
  },
  {
    role: "growth.google",
    provider: "google",
    authStyle: "api_key",
    required: false,
    identifiers: ["accountId"],
    scopes: [],
  },
  {
    role: "search.bing",
    provider: "bing",
    authStyle: "api_key",
    required: false,
    identifiers: [],
    scopes: [],
  },
  {
    role: "commerce.native",
    provider: "revenuecat",
    authStyle: "api_key",
    required: false,
    identifiers: ["accountId", "organizationId"],
    scopes: [],
  },
  {
    role: "dns.records",
    provider: "dns",
    authStyle: "manual",
    required: false,
    identifiers: [],
    scopes: [],
  },
];

export interface DetectedSession {
  readonly provider: string;
  readonly installed?: boolean;
  readonly authenticated: boolean;
  /** Login or account handle read back from the CLI, never a token. */
  readonly account?: string;
  /** Stripe is accepted only when its official CLI proves test mode. */
  readonly mode?: "test";
  readonly detail?: string;
}

export interface CollectedRole {
  readonly role: FounderStackRole;
  /** Only a reference; the value lives in the credential backend. */
  readonly credentialRef?: string;
  readonly identifiers: Readonly<Record<string, string>>;
}

export interface UnresolvedAction {
  readonly role: FounderStackRole;
  readonly provider: string;
  readonly why: string;
  readonly command: string;
  readonly blocksLaunch: boolean;
}

export function credentialRefFor(provider: string, profileId: string): string {
  return `cred://${provider}/${profileId}`;
}

/** A `cred://` reference is public metadata; a value never is. */
export function assertReferenceOnly(value: string, label: string): void {
  if (!value.startsWith("cred://")) {
    throw new Error(
      `${label} must be a cred:// reference, never a credential value. ` +
        "Next: store the value in your credential backend and pass its reference.",
    );
  }
}

/**
 * A secret must never be readable from the process table, a shell history file,
 * or CI logs, so the wizard refuses any argument that looks like a value.
 */
export function assertNoSecretsInArgv(argv: readonly string[]): void {
  for (const argument of argv) {
    if (argument.startsWith("cred://")) continue;
    if (
      /^(?:sk|rk|pk)_(?:live|test)_/.test(argument) ||
      /^xkeysib-/.test(argument) ||
      /^gh[pousr]_/.test(argument) ||
      /^napi_/.test(argument) ||
      /^--(?:token|secret|api-key|password)=/.test(argument)
    ) {
      throw new Error(
        "Venture Harness never accepts a credential value as an argument, because arguments are visible to other processes and land in shell history. " +
          "Next: rerun the credential command without the value and paste it only at the hidden prompt.",
      );
    }
  }
}

export interface ConnectionPlanInput {
  readonly profileId: string;
  readonly ownerOrganizationId: string;
  readonly sessions: readonly DetectedSession[];
  readonly collected: readonly CollectedRole[];
  /** Optional roles selected for this Stack. RevenueCat is never selected implicitly. */
  readonly selectedOptionalRoles?: readonly FounderStackRole[];
}

export interface ConnectionPlan {
  readonly resolved: readonly FounderStackRole[];
  readonly unresolved: readonly UnresolvedAction[];
  /** True when every role the default web rail needs is present. */
  readonly launchReady: boolean;
}

const CLI_LOGIN_COMMAND: Readonly<Record<string, string>> = {
  github: "gh auth login",
  vercel: "vercel login",
  stripe: "stripe login",
};

const API_KEY_HINT: Readonly<Record<string, string>> = {
  neon: "Create a Neon API key at https://console.neon.tech/app/settings/api-keys",
  brevo: "Create a Brevo API key at https://app.brevo.com/settings/keys/api",
  google: "Create a Google service credential with Analytics and Search Console access",
  bing: "Create a Bing Webmaster API key at https://www.bing.com/webmasters/apikeys",
  revenuecat: "Create a RevenueCat secret API key in project settings",
};

export const DEFAULT_SELECTED_FOUNDER_STACK_OPTIONAL_ROLES = [
  "email.transactional",
  "growth.google",
  "search.bing",
  "dns.records",
] as const satisfies readonly FounderStackRole[];

function roleSelected(
  plan: StackRolePlan,
  input: ConnectionPlanInput,
  collectedByRole: ReadonlyMap<FounderStackRole, CollectedRole>,
): boolean {
  if (plan.required) return true;
  if (collectedByRole.has(plan.role)) return true;
  const selected = input.selectedOptionalRoles ?? DEFAULT_SELECTED_FOUNDER_STACK_OPTIONAL_ROLES;
  return selected.includes(plan.role);
}

function unresolvedCommand(plan: StackRolePlan): string {
  if (plan.authStyle === "cli_session" || plan.authStyle === "cli_session_with_api_key") {
    return CLI_LOGIN_COMMAND[plan.provider] ?? `${plan.provider} login`;
  }
  if (plan.authStyle === "manual") {
    return "vh stack connect founder-default --role dns.records";
  }
  return `vh stack connect founder-default --role ${plan.role}  # ${API_KEY_HINT[plan.provider] ?? "store the provider credential at the hidden prompt"}`;
}

/**
 * Decide what is connected and what still needs a founder action.
 *
 * A role counts as resolved only when it has a credential reference and every
 * identifier the provider needs. A CLI-session role additionally needs an
 * authenticated session: a stored reference to a session that is logged out is
 * readiness, not access.
 */
export function planFounderStackConnection(input: ConnectionPlanInput): ConnectionPlan {
  const sessionByProvider = new Map(input.sessions.map((session) => [session.provider, session]));
  const collectedByRole = new Map(input.collected.map((entry) => [entry.role, entry]));
  const resolved: FounderStackRole[] = [];
  const unresolved: UnresolvedAction[] = [];

  for (const plan of FOUNDER_STACK_PLAN) {
    if (!roleSelected(plan, input, collectedByRole)) continue;
    const collected = collectedByRole.get(plan.role);
    const session = sessionByProvider.get(plan.provider);

    const hasUsableCliSession = Boolean(
      session?.authenticated && (plan.provider !== "stripe" || session.mode === "test"),
    );
    const requiresCliSession = plan.authStyle === "cli_session";
    const hybridHasNoFallback = plan.authStyle === "cli_session_with_api_key" && !collected;

    if ((requiresCliSession || hybridHasNoFallback) && !hasUsableCliSession) {
      unresolved.push({
        role: plan.role,
        provider: plan.provider,
        why:
          plan.provider === "stripe"
            ? "No authenticated Stripe CLI session proved test mode."
            : `No authenticated ${plan.provider} CLI session was found.`,
        command: unresolvedCommand(plan),
        blocksLaunch: plan.required,
      });
      continue;
    }

    if (!collected) {
      unresolved.push({
        role: plan.role,
        provider: plan.provider,
        why: `No credential reference is recorded for ${plan.role}.`,
        command:
          plan.authStyle === "cli_session_with_api_key"
            ? "vh stack connect founder-default --role commerce.web"
            : unresolvedCommand(plan),
        blocksLaunch: plan.required,
      });
      continue;
    }

    if (plan.authStyle !== "manual") {
      if (!collected.credentialRef) {
        unresolved.push({
          role: plan.role,
          provider: plan.provider,
          why: `No credential reference is recorded for ${plan.role}.`,
          command: unresolvedCommand(plan),
          blocksLaunch: plan.required,
        });
        continue;
      }
      assertReferenceOnly(collected.credentialRef, `${plan.role} credentialRef`);
    }
    const missing = plan.identifiers.filter((name) => !collected.identifiers[name]?.trim());
    if (missing.length > 0) {
      unresolved.push({
        role: plan.role,
        provider: plan.provider,
        why: `${plan.role} is missing ${missing.join(" and ")}.`,
        command: `vh stack connect founder-default --role ${plan.role}`,
        blocksLaunch: plan.required,
      });
      continue;
    }
    resolved.push(plan.role);
  }

  return {
    resolved,
    unresolved,
    launchReady: unresolved.every((action) => !action.blocksLaunch),
  };
}

/** Roles whose absence stops a founder web launch, in plan order. */
export function blockingActions(plan: ConnectionPlan): readonly UnresolvedAction[] {
  return plan.unresolved.filter((action) => action.blocksLaunch);
}
