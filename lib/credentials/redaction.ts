const SENSITIVE_KEYS = new Set([
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "connection_string",
  "connection_uri",
  "credential",
  "credentials",
  "jwt",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "token",
  "value",
]);

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.has(lower)) return true;
  const compact = lower.replace(/[-_]/g, "");
  return [
    "accesstoken",
    "apikey",
    "authorization",
    "authorizationheader",
    "clientsecret",
    "connectionstring",
    "connectionuri",
    "credential",
    "credentialvalue",
    "idtoken",
    "password",
    "privatekey",
    "refreshtoken",
    "sharedsecret",
    "signingsecret",
    "subscriptionprivatekey",
  ].includes(compact);
}

export class Redactor {
  private readonly knownSecrets = new Set<string>();

  addSecret(secret: string): void {
    if (secret.length > 0) {
      this.knownSecrets.add(secret);
    }
  }

  redactText(input: string): string {
    let output = input;

    for (const secret of [...this.knownSecrets].sort((left, right) => right.length - left.length)) {
      output = output.split(secret).join(REDACTED);
    }

    output = output.replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    );
    output = output.replace(
      /\bauthorization\b\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s,;&]+/gi,
      `Authorization=${REDACTED}`,
    );
    output = output.replace(
      /\b(api[-_]?key|password|private[-_]?key|refresh[-_]?token|secret|token)\b\s*[:=]\s*([^\s,;&]+)/gi,
      (_match, key: string) => `${key}=${REDACTED}`,
    );
    output = output.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^@\s/]+)(@)/gi, `$1${REDACTED}$3`);

    return output;
  }

  redact<T>(input: T): T {
    return this.redactValue(input, new WeakSet()) as T;
  }

  private redactValue(input: unknown, seen: WeakSet<object>): unknown {
    if (typeof input === "string") {
      return this.redactText(input);
    }
    if (input === null || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      return "[CIRCULAR]";
    }
    seen.add(input);

    if (Array.isArray(input)) {
      return input.map((value) => this.redactValue(value, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = isSensitiveKey(key) ? REDACTED : this.redactValue(value, seen);
    }
    return result;
  }
}

export function redactUnknown(input: unknown, secrets: readonly string[] = []): unknown {
  const redactor = new Redactor();
  for (const secret of secrets) {
    redactor.addSecret(secret);
  }
  return redactor.redact(input);
}
