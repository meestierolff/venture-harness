import type { JsonValue } from "./types";

const SECRET_KEY =
  /(^|[_-])(cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)($|[_-])/i;
const REFERENCE_KEY = /(^|[_-])(credential|secret|token|api[_-]?key)[_-]?(ref|reference)$/i;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT = /\b(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi;

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(BEARER, "Bearer [REDACTED]").replace(ASSIGNMENT, "$1=[REDACTED]");
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function sanitizeJson(value: unknown, secrets: readonly string[] = []): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, secrets),
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, secrets));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const isReference =
        REFERENCE_KEY.test(key) || /(credential|secret|token|apiKey)Ref$/i.test(key);
      out[key] = SECRET_KEY.test(key) && !isReference ? "[REDACTED]" : sanitizeJson(item, secrets);
    }
    return out;
  }
  return redactString(String(value), secrets);
}
