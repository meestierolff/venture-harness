import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Status =
  | "VERIFIED_RUNTIME"
  | "VERIFIED_INTEGRATION"
  | "VERIFIED_FIXTURE"
  | "IMPLEMENTED_LIVE_VERIFICATION_PENDING"
  | "EXTERNAL_BLOCKER"
  | "NOT_APPLICABLE"
  | "DEFERRED_POST_ALPHA"
  | "PARTIAL"
  | "STUB"
  | "MISSING"
  | "INCORRECT"
  | "CONTRADICTED_BY_RUNTIME";

type Priority = "P0" | "P1" | "P2" | "P3";

interface Requirement {
  id: string;
  group: string;
  priority: Priority;
  requirement: string;
  status: Status;
  evidence: string[];
  gap: string;
}

const rows: Requirement[] = [];

function add(
  id: string,
  group: string,
  priority: Priority,
  requirement: string,
  status: Status,
  evidence: string[] = [],
  gap = "Independent runtime verification and/or implementation is still required.",
): void {
  rows.push({ id, group, priority, requirement, status, evidence, gap });
}

const corePartial = new Set([
  "config and schemas",
  "credential broker",
  "authorization and policy",
  "provider SDK",
  "provider registry",
  "graph runtime",
  "loop runtime",
  "CLI",
  "migrations",
  "telemetry",
  "public release checks",
]);

(
  [
    ["CORE-001", "pnpm workspace"],
    ["CORE-002", "package boundaries"],
    ["CORE-003", "config and schemas"],
    ["CORE-004", "command bus"],
    ["CORE-005", "event log"],
    ["CORE-006", "audit hash chain"],
    ["CORE-007", "asset vault"],
    ["CORE-008", "credential broker"],
    ["CORE-009", "authorization and policy"],
    ["CORE-010", "organizations"],
    ["CORE-011", "subscriptions and entitlements"],
    ["CORE-012", "provider connections"],
    ["CORE-013", "provider SDK"],
    ["CORE-014", "provider registry"],
    ["CORE-015", "graph runtime"],
    ["CORE-016", "loop runtime"],
    ["CORE-017", "CLI"],
    ["CORE-018", "API"],
    ["CORE-019", "MCP"],
    ["CORE-020", "SDK"],
    ["CORE-021", "pack runtime"],
    ["CORE-022", "seed runtime"],
    ["CORE-023", "migrations"],
    ["CORE-024", "telemetry"],
    ["CORE-025", "shared UI"],
    ["CORE-026", "control-plane app boundary"],
    ["CORE-027", "API/worker/docs/Fleet Controller app boundaries"],
    ["CORE-028", "package exports, packing, and clean-consumer install"],
    ["CORE-029", "public release checks"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "A. Core",
    ["CORE-006", "CORE-008", "CORE-009"].includes(id) ? "P0" : id === "CORE-029" ? "P2" : "P1",
    requirement,
    corePartial.has(requirement) ? "PARTIAL" : "MISSING",
    requirement === "pnpm workspace" ? ["package.json", "pnpm-lock.yaml"] : [],
    requirement === "pnpm workspace"
      ? "No pnpm-workspace.yaml or workspace package manifests existed at recovered HEAD."
      : undefined,
  ),
);

const venturePartial = new Set([
  "idea compiler",
  "harness.lock",
  "Venture Manifest",
  "CompanyStack provisioning",
  "source push",
  "preview verification",
  "production deployment planning",
  "live/fixture verification",
]);

(
  [
    ["VENTURE-001", "idea compiler"],
    ["VENTURE-002", "Stack Profile resolution"],
    ["VENTURE-003", "Launch Grant"],
    ["VENTURE-004", "no external resource before Launch Grant"],
    ["VENTURE-005", "local isolated workspace"],
    ["VENTURE-006", "GitHub repository creation"],
    ["VENTURE-007", "seed materialization"],
    ["VENTURE-008", "harness.lock"],
    ["VENTURE-009", "Venture Manifest"],
    ["VENTURE-010", "unique design"],
    ["VENTURE-011", "unique application"],
    ["VENTURE-012", "ServiceBlueprint"],
    ["VENTURE-013", "Connector Manifest"],
    ["VENTURE-014", "unique Agent Surface"],
    ["VENTURE-015", "CompanyStack provisioning"],
    ["VENTURE-016", "source push"],
    ["VENTURE-017", "preview verification"],
    ["VENTURE-018", "production deployment planning"],
    ["VENTURE-019", "live/fixture verification"],
    ["VENTURE-020", "three versioned seed rails"],
    ["VENTURE-021", "v0.1-to-v0.2 materialization fixture"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "B. Venture creation",
    id === "VENTURE-003" || id === "VENTURE-004" ? "P0" : "P1",
    requirement,
    venturePartial.has(requirement) ? "PARTIAL" : "MISSING",
  ),
);

(
  [
    ["RECUR-001", "customer users"],
    ["RECUR-002", "customer organizations and memberships"],
    ["RECUR-003", "venture subscriptions"],
    ["RECUR-004", "entitlements"],
    ["RECUR-005", "Connection Hub"],
    ["RECUR-006", "Customer Service Grants"],
    ["RECUR-007", "Provider Connections"],
    ["RECUR-008", "Agent Grants"],
    ["RECUR-009", "customer agent API/CLI/MCP/SDK"],
    ["RECUR-010", "usage metering"],
    ["RECUR-011", "revocation"],
    ["RECUR-012", "offboarding"],
    ["RECUR-013", "customer resource ownership"],
    ["RECUR-014", "CompanyStack/CustomerStack/AgentAccessStack separation"],
    [
      "RECUR-015",
      "cross-tenant isolation at HTTP/command/service/repository/persistence/webhook layers",
    ],
    ["RECUR-016", "tenant credential resolution and refresh"],
    ["RECUR-017", "cross-venture asset/run/cohort isolation"],
    ["RECUR-018", "subscription and entitlement negative controls"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "C. Recursive customer service",
    ["RECUR-011", "RECUR-014", "RECUR-015", "RECUR-016", "RECUR-017"].includes(id) ? "P0" : "P1",
    requirement,
    "MISSING",
  ),
);

const portabilityPartial = new Set([
  "founder default Stack Profile",
  "capability resolution",
  "provider-specific auth",
  "provider state and ownership metadata",
  "read-back verification",
  "unknown-outcome reconciliation",
  "provider status matrix",
  "failure injection and idempotent retry",
]);

(
  [
    ["PORT-001", "founder default Stack Profile"],
    ["PORT-002", "at least one alternative Stack Profile with real adapters"],
    ["PORT-003", "capability resolution"],
    ["PORT-004", "provider-specific auth"],
    ["PORT-005", "provider state and ownership metadata"],
    ["PORT-006", "read-back verification"],
    ["PORT-007", "unknown-outcome reconciliation"],
    ["PORT-008", "provider status matrix"],
    ["PORT-009", "failure injection and idempotent retry"],
    ["PORT-010", "no duplicate external writes"],
    ["PORT-011", "revoked delegated access preserves resources"],
    ["PORT-012", "provider doctor/dry-run/diagnostics without credentials"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "D. Provider portability",
    ["PORT-007", "PORT-010", "PORT-011"].includes(id) ? "P0" : "P2",
    requirement,
    portabilityPartial.has(requirement) ? "PARTIAL" : "MISSING",
  ),
);

const fleetPartial = new Set(["managed files", "migrations", "vh upgrade", "pause and rollback"]);

(
  [
    ["FLEET-001", "versioned Core packages"],
    ["FLEET-002", "Core release manifests"],
    ["FLEET-003", "affected-capability calculation"],
    ["FLEET-004", "managed files"],
    ["FLEET-005", "three ownership classes and three-way merge"],
    ["FLEET-006", "reusable workflows pinned to immutable refs"],
    ["FLEET-007", "migrations"],
    ["FLEET-008", "vh upgrade"],
    ["FLEET-009", "upgrade branch"],
    ["FLEET-010", "canary"],
    ["FLEET-011", "batches"],
    ["FLEET-012", "preview verification"],
    ["FLEET-013", "automatic merge policy"],
    ["FLEET-014", "production verification"],
    ["FLEET-015", "pause and rollback"],
    ["FLEET-016", "two-independent-venture upgrade fixture"],
    ["FLEET-017", "canary failure stops rollout"],
    ["FLEET-018", "Fleet Controller outage independence"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "E. Fleet evolution",
    ["FLEET-005", "FLEET-017"].includes(id) ? "P0" : "P1",
    requirement,
    fleetPartial.has(requirement) ? "PARTIAL" : "MISSING",
  ),
);

const winnerPartial = new Set([
  "Growth Contract",
  "creative identity",
  "content fingerprint",
  "delivery variants and lineage",
  "organic metric definitions and snapshots",
  "account and format baselines",
  "winner evaluator",
  "PaidTestProposal",
  "human approval and immutable Spend Grant",
  "budget ledger",
  "readiness ladder",
  "no auto-scale",
  "attribution ledger",
  "RevenueCat event ingestion",
  "D0/D7/D30 cohorts",
  "fatigue state",
  "DistributionPR linkage",
  "Fixture D",
]);

(
  [
    ["WL-001", "Growth Contract"],
    ["WL-002", "creative experiment matrix"],
    ["WL-003", "creative identity"],
    ["WL-004", "content fingerprint"],
    ["WL-005", "delivery variants and lineage"],
    ["WL-006", "creative manifests"],
    ["WL-007", "rights and paid-use enforcement"],
    ["WL-008", "render jobs"],
    ["WL-009", "organic publishing modes and review default"],
    ["WL-010", "organic account caps and duplicate policy"],
    ["WL-011", "organic metric definitions and snapshots"],
    ["WL-012", "account and format baselines"],
    ["WL-013", "winner evaluator"],
    ["WL-014", "PaidTestProposal"],
    ["WL-015", "human approval and immutable Spend Grant"],
    ["WL-016", "budget ledger"],
    ["WL-017", "distributed concurrency safety"],
    ["WL-018", "settlement, reconciliation, incident, freeze, kill switch"],
    ["WL-019", "Spark Ad adapter and fixture"],
    ["WL-020", "readiness ladder"],
    ["WL-021", "no auto-scale"],
    ["WL-022", "VBO fails closed before evidence and eligibility"],
    ["WL-023", "attribution ledger"],
    ["WL-024", "RevenueCat event ingestion"],
    ["WL-025", "D0/D7/D30 cohorts"],
    ["WL-026", "D90 configuration without mature-proof claim"],
    ["WL-027", "fatigue state"],
    ["WL-028", "Winner Loop analytics event pack"],
    ["WL-029", "creative provider adapter"],
    ["WL-030", "organic provider adapter"],
    ["WL-031", "paid provider adapter"],
    ["WL-032", "attribution provider adapter"],
    ["WL-033", "RevenueCat provider adapter"],
    ["WL-034", "DistributionPR linkage"],
    ["WL-035", "Fixture D"],
    [
      "WL-036",
      "Fixture D traverses command bus, graph, provider SDK, persistence, assets, audit, budget, and attribution",
    ],
    ["WL-037", "full creative trace artifact"],
    ["WL-038", "Winner Loop pack install/uninstall/idempotency"],
    ["WL-039", "Winner Loop migration stream"],
    ["WL-040", "TikTok proof does not imply Meta proof"],
    ["WL-041", "auto-pause"],
    ["WL-042", "missing metrics never become zero"],
    ["WL-043", "incompatible metric definitions never combine"],
    ["WL-044", "exact proposal/grant mismatch negative controls"],
    ["WL-045", "provider actual overspend recorded honestly"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "F. Winner Loop",
    [
      "WL-007",
      "WL-015",
      "WL-016",
      "WL-017",
      "WL-018",
      "WL-021",
      "WL-022",
      "WL-041",
      "WL-045",
    ].includes(id)
      ? "P0"
      : ["WL-028", "WL-029", "WL-030", "WL-031", "WL-032", "WL-033", "WL-039"].includes(id)
        ? "P2"
        : "P1",
    requirement,
    winnerPartial.has(requirement) ? "PARTIAL" : "MISSING",
  ),
);

(
  [
    ["SEC-001", "canary-secret non-disclosure across logs/events/reports/CLI/errors/model context"],
    ["SEC-002", "webhook signature verification and routing isolation"],
    ["SEC-003", "OAuth state, PKCE, redirect allowlist, and callback validation"],
    ["SEC-004", "SSRF protection"],
    ["SEC-005", "upload size/MIME/path traversal protection"],
    ["SEC-006", "command injection protection"],
    ["SEC-007", "Gitleaks or equivalent current-tree/history/package scan"],
    ["SEC-008", "CodeQL or justified local equivalent"],
    ["SEC-009", "dependency review and Dependabot"],
    ["SEC-010", "audit integrity"],
    ["SEC-011", "public repository contains no real private provider/customer/fleet data"],
    ["SEC-012", "branch/push protection guidance"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(
    id,
    "G. Security and open source",
    [
      "SEC-001",
      "SEC-002",
      "SEC-003",
      "SEC-004",
      "SEC-005",
      "SEC-006",
      "SEC-010",
      "SEC-011",
    ].includes(id)
      ? "P0"
      : "P2",
    requirement,
    "MISSING",
  ),
);

(
  [
    ["QUAL-001", "frozen install"],
    ["QUAL-002", "workspace/package build and export validation"],
    ["QUAL-003", "packed CLI invocation"],
    ["QUAL-004", "MCP startup/tool invocation"],
    ["QUAL-005", "SDK clean-consumer install"],
    ["QUAL-006", "golden path A one-prompt launch"],
    ["QUAL-007", "golden path B recursive SaaS"],
    ["QUAL-008", "golden path C Winner Loop Fixture D"],
    ["QUAL-009", "golden path D fleet upgrade"],
    ["QUAL-010", "negative controls artifact"],
    ["QUAL-011", "vh verify fast"],
    ["QUAL-012", "vh verify mvp"],
    ["QUAL-013", "vh verify release"],
    ["QUAL-014", "pnpm verify compatibility gate"],
    ["QUAL-015", "raw HTML/e2e/accessibility/responsive verification"],
    ["QUAL-016", "commands-run evidence with exits/skips"],
    ["QUAL-017", "Opus claims verification"],
    ["QUAL-018", "stubs and dead-code audit"],
    ["QUAL-019", "product-truth and public-claim alignment"],
  ] satisfies Array<[string, string]>
).forEach(([id, requirement]) =>
  add(id, "H. Verification and evidence", id === "QUAL-019" ? "P0" : "P2", requirement, "MISSING"),
);

const auditedOverrides: Record<string, { status: Status; evidence?: string[]; gap: string }> = {
  "CORE-005": {
    status: "PARTIAL",
    evidence: ["lib/workflow/store.ts"],
    gap: "Workflow JSONL events exist, but there is no general append-only domain event log.",
  },
  "CORE-028": {
    status: "CONTRADICTED_BY_RUNTIME",
    evidence: ["package.json", "bin/vh.mjs"],
    gap: "The recovered package included 555 monorepo entries and the clean-consumer vh binary failed because tsx was only a devDependency.",
  },
  "VENTURE-006": {
    status: "PARTIAL",
    evidence: ["lib/providers/github-source-publication.ts"],
    gap: "Source-publication primitives exist, but no Launch-Grant-bound child repository materializer consumes them.",
  },
  "VENTURE-009": {
    status: "MISSING",
    evidence: ["lib/cli/default-services.ts"],
    gap: ".venture/project.json is a router snapshot, not the required Venture Manifest.",
  },
  "PORT-007": {
    status: "INCORRECT",
    evidence: ["lib/providers/adapter.ts"],
    gap: "A crash after provider write but before success-ledger persistence can blindly repeat the effect.",
  },
  "PORT-012": {
    status: "PARTIAL",
    evidence: ["lib/providers/adapter.ts", "lib/cli/default-provider-runtime.ts"],
    gap: "Doctor and dry-run paths exist, but the complete lifecycle and Winner Loop providers are absent.",
  },
  "FLEET-002": {
    status: "PARTIAL",
    evidence: ["lib/upgrade/local-release.ts"],
    gap: "A local release manifest exists, but there are no versioned Core package release manifests.",
  },
  "FLEET-005": {
    status: "INCORRECT",
    evidence: ["lib/config/harness-lock.ts", "lib/upgrade/engine.ts"],
    gap: "Ownership is harness/project/generated and diverged managed files only conflict; merge-managed three-way behavior is absent.",
  },
  "WL-017": {
    status: "INCORRECT",
    evidence: ["lib/winner-loop/spend-store.ts", "tests/winner-loop-spend-safety.test.ts"],
    gap: "Recovered runtime leaked a reservation across ventures on idempotency-key reuse, and the concurrency test was sequential rather than simultaneous.",
  },
  "WL-022": {
    status: "INCORRECT",
    evidence: ["lib/winner-loop/readiness.ts"],
    gap: "Recovered runtime returned vboAllowed=true at NO_SIGNAL when policy was allowed.",
  },
  "WL-025": {
    status: "INCORRECT",
    evidence: ["lib/winner-loop/subscriptions.ts", "reports/audit/winner-loop-creative-trace.json"],
    gap: "D0 was implemented as a zero-width interval and omitted a same-day purchase from the committed trace.",
  },
  "WL-035": {
    status: "CONTRADICTED_BY_RUNTIME",
    evidence: ["lib/winner-loop/fixture-d.ts"],
    gap: "The fixture directly composes in-memory helpers and bypasses command, graph, provider, asset, audit, and persistence boundaries.",
  },
  "QUAL-003": {
    status: "CONTRADICTED_BY_RUNTIME",
    evidence: ["bin/vh.mjs", "package.json"],
    gap: "The packed binary exits ERR_MODULE_NOT_FOUND for tsx in a clean consumer.",
  },
};

for (const row of rows) {
  const override = auditedOverrides[row.id];
  if (!override) continue;
  row.status = override.status;
  row.evidence = override.evidence ?? row.evidence;
  row.gap = override.gap;
}

const allowedStatuses: Status[] = [
  "VERIFIED_RUNTIME",
  "VERIFIED_INTEGRATION",
  "VERIFIED_FIXTURE",
  "IMPLEMENTED_LIVE_VERIFICATION_PENDING",
  "EXTERNAL_BLOCKER",
  "NOT_APPLICABLE",
  "DEFERRED_POST_ALPHA",
  "PARTIAL",
  "STUB",
  "MISSING",
  "INCORRECT",
  "CONTRADICTED_BY_RUNTIME",
];

const counts = Object.fromEntries(
  allowedStatuses.map((status) => [status, rows.filter((row) => row.status === status).length]),
);
const priorities = Object.fromEntries(
  ["P0", "P1", "P2", "P3"].map((priority) => [
    priority,
    rows.filter((row) => row.priority === priority).length,
  ]),
);

const artifact = {
  schemaVersion: 1,
  phase: "INITIAL_AUDIT",
  generatedAt: "2026-08-09",
  branch: "sol/vh-core-v0.2-winner-loop",
  startingSha: "1ba4a22f08f356a510e0611b9081f5d16eaa2823",
  backupRef: "refs/heads/backup/opus-vh-core-v0.2-1ba4a22",
  originMain: "de69705a5b1b4404771c66cf169a6cbcf885fb3a",
  allowedStatuses,
  counts,
  priorities,
  requirements: rows,
};

const jsonPath = resolve("reports/audit/vh-v0.2-codex-requirement-matrix.json");
const markdownPath = resolve("docs/plans/active/VH_V02_CODEX_COMPLETION_MATRIX.md");
mkdirSync(dirname(jsonPath), { recursive: true });
mkdirSync(dirname(markdownPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

const lines = [
  "# Venture Harness v0.2 Codex completion matrix",
  "",
  "- Phase: `INITIAL_AUDIT`",
  "- Branch: `sol/vh-core-v0.2-winner-loop`",
  "- Starting SHA: `1ba4a22f08f356a510e0611b9081f5d16eaa2823`",
  "- Backup reference: `backup/opus-vh-core-v0.2-1ba4a22`",
  "- Machine-readable source: `reports/audit/vh-v0.2-codex-requirement-matrix.json`",
  "",
  "This is a conservative pre-repair baseline. Existing code is `PARTIAL` until its production boundary is independently exercised; absent architecture is `MISSING`. No implementable P0, P1, or P2 row may remain non-terminal at completion.",
  "",
  "## Initial counts",
  "",
  "| Status | Count |",
  "| --- | ---: |",
  ...allowedStatuses.map((status) => `| ${status} | ${counts[status]} |`),
  "",
  "| Priority | Count |",
  "| --- | ---: |",
  ...Object.entries(priorities).map(([priority, count]) => `| ${priority} | ${count} |`),
  "",
];

for (const group of [...new Set(rows.map((row) => row.group))]) {
  lines.push(
    `## ${group}`,
    "",
    "| ID | Priority | Requirement | Status | Evidence / gap |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const row of rows.filter((candidate) => candidate.group === group)) {
    const evidence = row.evidence.length > 0 ? `${row.evidence.join("; ")} — ${row.gap}` : row.gap;
    lines.push(
      `| ${row.id} | ${row.priority} | ${row.requirement} | ${row.status} | ${evidence.replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");
}

writeFileSync(markdownPath, `${lines.join("\n")}\n`, "utf8");
console.log(`OK rendered ${rows.length} requirements (${JSON.stringify(counts)})`);
