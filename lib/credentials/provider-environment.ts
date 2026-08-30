const PROVIDER_RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "CI",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
] as const;

const ONE_PASSWORD_ENVIRONMENT_KEYS = [
  "OP_SERVICE_ACCOUNT_TOKEN",
  "OP_CONNECT_HOST",
  "OP_CONNECT_TOKEN",
] as const;

const PROVIDER_AUTH_ENVIRONMENT_BY_BINARY = {
  neonctl: ["NEON_API_KEY"],
  psql: ["PGDATABASE"],
  eas: ["EXPO_TOKEN"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export const PROVIDER_COMMAND_AUTH_ENVIRONMENT_NAMES = Object.freeze([
  ...new Set(Object.values(PROVIDER_AUTH_ENVIRONMENT_BY_BINARY).flat()),
]);

/**
 * Complete set of per-call fields used by provider transports and the
 * broker-backed aggregate Neon reader. The base environment includes none of
 * these fields.
 */
export const PROVIDER_COMMAND_INVOCATION_ENVIRONMENT_NAMES = Object.freeze([
  ...PROVIDER_COMMAND_AUTH_ENVIRONMENT_NAMES,
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGAPPNAME",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGCHANNELBINDING",
  "PGCONNECT_TIMEOUT",
]);

function copyDefined(
  source: Readonly<Record<string, string | undefined>>,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key] as string]])),
  );
}

/**
 * Constructs a provider CLI environment from a fixed allowlist. This is a
 * replacement environment: it never spreads or otherwise inherits the host
 * process environment.
 *
 * HOME/XDG locations remain available because official CLI sessions own their
 * refresh material. Provider tokens, proxy credentials, language-runtime
 * injection, package/Git configuration, and agent sockets are deliberately
 * absent. A command transport may add one separately validated brokered auth
 * variable for the duration of one invocation.
 */
export function providerCommandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return Object.assign(
    {
      NODE_ENV: source.NODE_ENV ?? "production",
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_NOSYSTEM: "1",
      NPM_CONFIG_GLOBALCONFIG: nullDevice,
      NPM_CONFIG_USERCONFIG: nullDevice,
      npm_config_globalconfig: nullDevice,
      npm_config_userconfig: nullDevice,
    },
    copyDefined(source, PROVIDER_RUNTIME_ENVIRONMENT_KEYS),
  ) as NodeJS.ProcessEnv;
}

/**
 * The 1Password CLI has its own credential-helper boundary. Only documented
 * 1Password authentication/session variables cross it; they never enter a
 * provider transport child.
 */
export function onePasswordCommandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const sessionKeys = Object.keys(source).filter((key) => /^OP_SESSION_[A-Za-z0-9_]+$/.test(key));
  return {
    ...providerCommandEnvironment(source),
    ...copyDefined(source, [...ONE_PASSWORD_ENVIRONMENT_KEYS, ...sessionKeys]),
  };
}

function executableName(binary: string): string {
  return (
    binary
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.toLowerCase()
      .replace(/\.(?:exe|cmd|bat)$/i, "") ?? ""
  );
}

/**
 * Validates the complete binary/environment pair before the credential broker
 * is consulted. Supporting a new provider variable therefore requires an
 * explicit reviewed code change instead of accepting arbitrary process knobs.
 */
export function isAllowedProviderAuthEnvironment(binary: string, name: string): boolean {
  const allowed =
    PROVIDER_AUTH_ENVIRONMENT_BY_BINARY[
      executableName(binary) as keyof typeof PROVIDER_AUTH_ENVIRONMENT_BY_BINARY
    ];
  return allowed?.includes(name as never) === true;
}
