import { createHash } from "node:crypto";

export type CredentialRuleId =
  | "aws-access-key"
  | "private-key"
  | "github-token"
  | "api-secret-key"
  | "stripe-access-token"
  | "slack-token"
  | "database-url-with-credentials";

export interface CredentialFinding {
  path: string;
  rule: CredentialRuleId;
  line: number;
  sha256: string;
  fingerprint: string;
}

export interface ReleaseScanAllowlistEntry {
  path: string;
  rule: CredentialRuleId;
  line: number;
  sha256: string;
  reason: string;
}

export interface ReleaseScanAllowlist {
  schemaVersion: 1;
  entries: ReleaseScanAllowlistEntry[];
}

const RULES: readonly { id: CredentialRuleId; pattern: RegExp }[] = [
  { id: "aws-access-key", pattern: new RegExp("AKIA" + "[0-9A-Z]{16}", "g") },
  {
    id: "private-key",
    pattern: new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "g"),
  },
  { id: "github-token", pattern: new RegExp("gh" + "[pousr]_[A-Za-z0-9_]{20,}", "g") },
  { id: "api-secret-key", pattern: new RegExp("sk-" + "[A-Za-z0-9]{20,}", "g") },
  {
    id: "stripe-access-token",
    pattern: new RegExp("sk_" + "(?:live|test)_[A-Za-z0-9_]{12,}", "g"),
  },
  { id: "slack-token", pattern: new RegExp("xox" + "[baprs]-[A-Za-z0-9-]{10,}", "g") },
  {
    id: "database-url-with-credentials",
    pattern: /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/g,
  },
];

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function findingFingerprint(
  finding: Pick<CredentialFinding, "path" | "rule" | "line" | "sha256">,
): string {
  return `${finding.path}:${finding.rule}:${finding.line}:${finding.sha256}`;
}

export function scanCredentialText(path: string, text: string): CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index ?? 0).split("\n").length;
      const finding = {
        path,
        rule: rule.id,
        line,
        sha256: digest(match[0]),
      } as CredentialFinding;
      finding.fingerprint = findingFingerprint(finding);
      findings.push(finding);
    }
  }
  return findings;
}

export function validateReleaseScanAllowlist(value: unknown): ReleaseScanAllowlist {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release scan allowlist must be an object");
  }
  const candidate = value as { schemaVersion?: unknown; entries?: unknown };
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.entries)) {
    throw new Error("release scan allowlist must use schemaVersion 1 and an entries array");
  }
  const seen = new Set<string>();
  const entries = candidate.entries.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`release scan allowlist entry ${index} must be an object`);
    }
    const entry = raw as Partial<ReleaseScanAllowlistEntry>;
    if (
      typeof entry.path !== "string" ||
      entry.path.startsWith("/") ||
      entry.path.split("/").includes("..") ||
      !RULES.some((rule) => rule.id === entry.rule) ||
      !Number.isInteger(entry.line) ||
      (entry.line ?? 0) < 1 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 10
    ) {
      throw new Error(`release scan allowlist entry ${index} is invalid`);
    }
    const complete = entry as ReleaseScanAllowlistEntry;
    const fingerprint = findingFingerprint(complete);
    if (seen.has(fingerprint))
      throw new Error(`duplicate release scan allowlist entry ${fingerprint}`);
    seen.add(fingerprint);
    return complete;
  });
  return { schemaVersion: 1, entries };
}

export function evaluateCredentialFindings(
  findings: readonly CredentialFinding[],
  allowlist: ReleaseScanAllowlist,
): {
  allowed: CredentialFinding[];
  unexpected: CredentialFinding[];
  stale: ReleaseScanAllowlistEntry[];
} {
  const entries = new Map(
    allowlist.entries.map((entry) => [findingFingerprint(entry), entry] as const),
  );
  const used = new Set<string>();
  const allowed: CredentialFinding[] = [];
  const unexpected: CredentialFinding[] = [];
  for (const finding of findings) {
    if (entries.has(finding.fingerprint)) {
      used.add(finding.fingerprint);
      allowed.push(finding);
    } else {
      unexpected.push(finding);
    }
  }
  return {
    allowed,
    unexpected,
    stale: allowlist.entries.filter((entry) => !used.has(findingFingerprint(entry))),
  };
}
