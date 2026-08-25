import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FounderAlphaCatalog,
  type FounderAlphaLedger,
  renderFounderAlphaEvidence,
} from "@/scripts/lib/founder-alpha-evidence";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function hash(value: string): { sha256: string; bytes: number } {
  const bytes = Buffer.from(value, "utf8");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

function fixture(): {
  root: string;
  catalog: FounderAlphaCatalog;
  ledger: FounderAlphaLedger;
} {
  const root = mkdtempSync(join(tmpdir(), "founder-alpha-evidence-"));
  roots.push(root);
  writeFileSync(join(root, "evidence.txt"), "reviewed implementation\n", "utf8");
  const requirements: FounderAlphaCatalog["requirements"] = Array.from(
    { length: 30 },
    (_, index) => {
      const section = index + 5;
      const id = `FA-${String(section).padStart(2, "0")}`;
      if (section === 20 || section === 23) {
        return {
          id,
          section: String(section),
          priority: "P0" as const,
          title: `External ${section}`,
          implementable: false,
          evidence: ["evidence.txt"],
          verification: {
            kind: "external_blocker" as const,
            commandIds: ["local"],
            blocker: {
              code: `BLOCKED_${section}`,
              reason: "An external prerequisite is absent.",
              exactAction: "Complete the external prerequisite.",
              expectedEvidence: `external-${section}.json`,
              impact: "The external result cannot be claimed.",
              resumeCommand: "vh resume fixture",
            },
          },
        };
      }
      if (section === 22) {
        return {
          id,
          section: String(section),
          priority: "P0" as const,
          title: "Live provider evidence",
          implementable: false,
          evidence: ["evidence.txt"],
          verification: {
            kind: "live_profile" as const,
            commandIds: ["live"] as [string],
            artifact: "reports/audit/quality-live.json",
          },
        };
      }
      if ([27, 28, 33].includes(section)) {
        const proof =
          section === 27 ? "repositoryMetadata" : section === 28 ? "mainRuleset" : "pullRequest";
        return {
          id,
          section: String(section),
          priority: "P0" as const,
          title: `GitHub read-back ${section}`,
          implementable: true,
          evidence: ["evidence.txt"],
          verification: {
            kind: "github_readback" as const,
            commandIds: ["final-github-readback"] as [string],
            command:
              "node scripts/verify-final-github-readback.mjs --output reports/audit/github-readback.json",
            artifact: "reports/audit/github-readback.json",
            proof,
          },
        };
      }
      return {
        id,
        section: String(section),
        priority: "P1" as const,
        title: `Local ${section}`,
        implementable: true,
        evidence: ["evidence.txt"],
        verification: { kind: "commands" as const, commandIds: ["local"] },
      };
    },
  );
  const catalog: FounderAlphaCatalog = {
    schemaVersion: 1,
    scope: "Founder-alpha completion assignment sections 5-34",
    statusVocabulary: ["VERIFIED", "FAILED", "EXTERNAL_BLOCKER", "NOT_RUN"],
    commandContracts: {
      local: { command: "pnpm local-proof", cwd: "." },
      live: { command: "pnpm verify:live -- --report reports/audit/quality-live.json", cwd: "." },
      "final-github-readback": {
        command:
          "node scripts/verify-final-github-readback.mjs --output reports/audit/github-readback.json",
        cwd: ".",
      },
    },
    requirements,
  };
  const catalogPath = join(root, "reports/audit/founder-alpha-requirements.json");
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, "utf8");

  const localLog = "local pass\n";
  const localLogPath = "reports/audit/command-logs/a/local.attempt-1.log";
  const liveLog = "live incomplete\n";
  const liveLogPath = "reports/audit/command-logs/a/live.attempt-1.log";
  const liveReportPath = "reports/audit/quality-live.json";
  const liveReport = `${JSON.stringify({
    status: "INCOMPLETE",
    results: [
      {
        status: "SKIP",
        gap: {
          origin: "external",
          provider: "GitHub, Vercel, and Neon",
          account_scope: "Founder-owned accounts selected by founder-default.",
          missing: "A connected founder Stack and verified resources.",
          exact_command: "vh stack connect founder-default",
          expected_evidence: "Sanitized resource identifiers and provider read-back.",
          impact: "The live launch cannot be claimed.",
          vercel_url_availability: "Unavailable until Vercel returns a verified HTTPS URL.",
          resume_command: "vh resume fixture",
        },
      },
    ],
  })}\n`;
  for (const [path, value] of [
    [localLogPath, localLog],
    [liveLogPath, liveLog],
    [liveReportPath, liveReport],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value, "utf8");
  }
  const ledger: FounderAlphaLedger = {
    schemaVersion: 3,
    branch: "fixture",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    sourceClean: true,
    records: [
      {
        id: "local",
        attempt: 1,
        command: "pnpm local-proof",
        cwd: ".",
        status: "PASSED",
        exitCode: 0,
        evidencePath: localLogPath,
        evidenceSha256: hash(localLog).sha256,
        evidenceBytes: hash(localLog).bytes,
        integrityVersion: 1,
      },
      {
        id: "live",
        attempt: 1,
        command: "pnpm verify:live -- --report reports/audit/quality-live.json",
        cwd: ".",
        status: "FAILED",
        exitCode: 1,
        evidencePath: liveLogPath,
        evidenceSha256: hash(liveLog).sha256,
        evidenceBytes: hash(liveLog).bytes,
        integrityVersion: 1,
        artifacts: [
          {
            path: liveReportPath,
            ...hash(liveReport),
            generatedDuringCommand: true,
          },
        ],
      },
    ],
  };
  return { root, catalog, ledger };
}

function attachGithubReadback(
  root: string,
  ledger: FounderAlphaLedger,
  overrides: Record<string, unknown> = {},
): void {
  const log = "GitHub read-back passed\n";
  const logPath = "reports/audit/command-logs/a/final-github-readback.attempt-1.log";
  const artifactPath = "reports/audit/github-readback.json";
  const report = `${JSON.stringify({
    schemaVersion: 1,
    status: "VERIFIED",
    source: {
      repository: "meestierolff/venture-harness",
      branch: ledger.branch,
      sha: ledger.sourceSha,
      tree: ledger.sourceTree,
    },
    proofs: {
      repositoryMetadata: true,
      mainRuleset: true,
      pullRequest: true,
      requiredChecks: true,
    },
    ...overrides,
  })}\n`;
  for (const [path, value] of [
    [logPath, log],
    [artifactPath, report],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value, "utf8");
  }
  ledger.records.push({
    id: "final-github-readback",
    attempt: 1,
    command:
      "node scripts/verify-final-github-readback.mjs --output reports/audit/github-readback.json",
    cwd: ".",
    status: "PASSED",
    exitCode: 0,
    evidencePath: logPath,
    evidenceSha256: hash(log).sha256,
    evidenceBytes: hash(log).bytes,
    integrityVersion: 1,
    artifacts: [
      {
        path: artifactPath,
        ...hash(report),
        generatedDuringCommand: true,
      },
    ],
  });
}

describe("founder-alpha assignment evidence", () => {
  it("covers sections 5-34 and refuses code-ready while implementable external work is not run", () => {
    const { root, catalog, ledger } = fixture();
    const report = renderFounderAlphaEvidence({
      root,
      catalog,
      ledger,
      generatedAt: "2026-08-12T12:00:00.000Z",
    });
    expect(new Set(report.requirements.map(({ section }) => Number(section)))).toEqual(
      new Set(Array.from({ length: 30 }, (_, index) => index + 5)),
    );
    expect(report.requirements.find(({ id }) => id === "FA-20")?.status).toBe("EXTERNAL_BLOCKER");
    expect(report.requirements.find(({ id }) => id === "FA-22")?.status).toBe("EXTERNAL_BLOCKER");
    expect(report.requirements.find(({ id }) => id === "FA-28")?.status).toBe("NOT_RUN");
    expect(report.allImplementablePrioritiesProven).toBe(false);
    expect(report.unprovenImplementableIds).toEqual(["FA-27", "FA-28", "FA-33"]);
    expect(report.reportStatus).toBe("INCOMPLETE");
    expect(report.classification).toBeNull();
  });

  it("allows code-ready/dogfood-blocked only when every implementable row is proven", () => {
    const { root, catalog, ledger } = fixture();
    attachGithubReadback(root, ledger);
    const report = renderFounderAlphaEvidence({ root, catalog, ledger });
    expect(report.allImplementablePrioritiesProven).toBe(true);
    expect(report.unprovenImplementableIds).toEqual([]);
    expect(report.requirements.find(({ id }) => id === "FA-27")?.status).toBe("VERIFIED");
    expect(report.requirements.find(({ id }) => id === "FA-28")?.status).toBe("VERIFIED");
    expect(report.requirements.find(({ id }) => id === "FA-33")?.status).toBe("VERIFIED");
    expect(report.classification).toBe("FOUNDER ALPHA CODE-READY, DOGFOOD BLOCKED");
  });

  it("fails closed on missing commands and modified live evidence", () => {
    const { root, catalog, ledger } = fixture();
    ledger.records = ledger.records.filter(({ id }) => id !== "local");
    const report = renderFounderAlphaEvidence({ root, catalog, ledger });
    expect(report.requirements.find(({ id }) => id === "FA-05")?.status).toBe("NOT_RUN");
    expect(report.reportStatus).toBe("INCOMPLETE");
    expect(report.classification).toBeNull();

    const second = fixture();
    writeFileSync(join(second.root, "reports/audit/quality-live.json"), "{}\n", "utf8");
    expect(() =>
      renderFounderAlphaEvidence({
        root: second.root,
        catalog: second.catalog,
        ledger: second.ledger,
      }),
    ).toThrow(/live report does not match its integrity metadata/u);

    const incomplete = fixture();
    const incompletePath = "reports/audit/quality-live.json";
    const incompleteReport = `${JSON.stringify({
      status: "INCOMPLETE",
      results: [
        {
          status: "SKIP",
          gap: {
            provider: "Vercel",
            missing: "A verified deployment.",
            exact_command: "vh stack connect founder-default",
            expected_evidence: "A provider-confirmed deployment URL.",
          },
        },
      ],
    })}\n`;
    writeFileSync(join(incomplete.root, incompletePath), incompleteReport, "utf8");
    const liveArtifact = incomplete.ledger.records
      .find(({ id }) => id === "live")
      ?.artifacts?.find(({ path }) => path === incompletePath);
    if (!liveArtifact) throw new Error("fixture lacks live artifact");
    Object.assign(liveArtifact, hash(incompleteReport));
    expect(
      renderFounderAlphaEvidence(incomplete).requirements.find(({ id }) => id === "FA-22")?.status,
    ).toBe("FAILED");
  });

  it("rejects a passed ledger record whose command or cwd differs from the reviewed contract", () => {
    for (const mutate of [
      (record: FounderAlphaLedger["records"][number]) => {
        record.command = "true";
      },
      (record: FounderAlphaLedger["records"][number]) => {
        record.cwd = "tests";
      },
    ]) {
      const evidence = fixture();
      const local = evidence.ledger.records.find(({ id }) => id === "local");
      if (!local) throw new Error("fixture lacks local command");
      mutate(local);
      const report = renderFounderAlphaEvidence(evidence);
      expect(report.requirements.find(({ id }) => id === "FA-05")?.status).toBe("FAILED");
      expect(report.classification).toBeNull();
    }
  });

  it("rejects a truncated audit log as completion evidence", () => {
    const evidence = fixture();
    const local = evidence.ledger.records.find(({ id }) => id === "local");
    if (!local) throw new Error("fixture lacks local command");
    local.outputTruncated = true;
    expect(() => renderFounderAlphaEvidence(evidence)).toThrow(/truncated/u);
  });

  it("fails closed on a source-mismatched or modified GitHub read-back", () => {
    const mismatched = fixture();
    attachGithubReadback(mismatched.root, mismatched.ledger, {
      source: {
        repository: "meestierolff/venture-harness",
        branch: mismatched.ledger.branch,
        sha: "c".repeat(40),
        tree: mismatched.ledger.sourceTree,
      },
    });
    const mismatchReport = renderFounderAlphaEvidence(mismatched);
    expect(mismatchReport.requirements.find(({ id }) => id === "FA-27")?.status).toBe("FAILED");
    expect(mismatchReport.unprovenImplementableIds).toEqual(["FA-27", "FA-28", "FA-33"]);

    const modified = fixture();
    attachGithubReadback(modified.root, modified.ledger);
    writeFileSync(join(modified.root, "reports/audit/github-readback.json"), "{}\n", "utf8");
    expect(() => renderFounderAlphaEvidence(modified)).toThrow(
      /GitHub read-back does not match its integrity metadata/u,
    );
  });
});
