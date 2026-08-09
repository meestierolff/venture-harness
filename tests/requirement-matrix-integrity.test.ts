import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateAndApplyRequirementProofs,
  type CommandArtifactEvidence,
  type CommandEvidenceRecord,
  type RequirementBaseline,
  type RequirementProofCatalog,
} from "../scripts/lib/requirement-proofs";

const temporaryDirectories: string[] = [];
let currentFixtureRoot: string | undefined;

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
  currentFixtureRoot = undefined;
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vh-requirement-proof-"));
  temporaryDirectories.push(root);
  currentFixtureRoot = root;
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "reports", "audit", "command-logs"), { recursive: true });
  writeFileSync(join(root, "tests", "control.test.ts"), "// deterministic control\n", "utf8");
  writeFileSync(
    join(root, "reports", "audit", "command-logs", "unit.log"),
    "legacy log path used only as disclosed implementation evidence\n",
    "utf8",
  );
  return root;
}

function digest(value: Buffer | string): { sha256: string; bytes: number } {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.byteLength,
  };
}

const baseline: RequirementBaseline = {
  id: "CORE-999",
  group: "A. Core",
  priority: "P1",
  requirement: "proof integrity control",
  status: "MISSING",
  evidence: [],
  gap: "No proof has been supplied.",
};

function catalog(): RequirementProofCatalog {
  return {
    schemaVersion: 2,
    branch: "fixture",
    evidenceCeiling: "LOCAL_RUNTIME_AND_SYNTHETIC_FIXTURES",
    commandContracts: {
      unit: {
        command: "pnpm test",
        cwd: ".",
        artifacts: [],
      },
    },
    proofs: [
      {
        id: baseline.id,
        priority: baseline.priority,
        requirement: baseline.requirement,
        status: "VERIFIED_RUNTIME",
        evidenceCeiling: "LOCAL_RUNTIME",
        evidence: ["tests/control.test.ts"],
        result: "The seeded missing requirement passed its explicit negative control.",
        verification: [{ kind: "test", path: "tests/control.test.ts", commandId: "unit" }],
        reviewedAt: "2026-08-09",
        reviewedBy: "codex-independent-audit",
      },
    ],
  };
}

function command(
  status: "PASSED" | "FAILED",
  exitCode: number,
  attempt = 1,
  options: {
    id?: string;
    command?: string;
    evidencePath?: string;
    artifacts?: CommandArtifactEvidence[];
    startedAt?: string;
    endedAt?: string;
  } = {},
): CommandEvidenceRecord {
  if (!currentFixtureRoot) throw new Error("fixture root must be created before command evidence");
  const id = options.id ?? "unit";
  const evidencePath =
    options.evidencePath ?? `reports/audit/command-logs/${id}.attempt-${attempt}.log`;
  const log = "1 test passed\n";
  const absoluteLogPath = join(currentFixtureRoot, evidencePath);
  mkdirSync(dirname(absoluteLogPath), { recursive: true });
  writeFileSync(absoluteLogPath, log, "utf8");
  const logDigest = digest(log);
  const startedAt = options.startedAt ?? "2026-08-09T10:00:00.000Z";
  const endedAt = options.endedAt ?? "2026-08-09T10:00:02.000Z";
  return {
    id,
    attempt,
    command: options.command ?? "pnpm test",
    cwd: ".",
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    status,
    exitCode,
    skipped: false,
    evidencePath,
    integrityVersion: 1,
    evidenceSha256: logDigest.sha256,
    evidenceBytes: logDigest.bytes,
    artifacts: options.artifacts ?? [],
  };
}

function artifactEvidence(root: string, path: string): CommandArtifactEvidence {
  const value = readFileSync(join(root, path));
  return { path, ...digest(value), generatedDuringCommand: true };
}

describe("completion-matrix proof integrity", () => {
  it("does not terminalize a seeded MISSING row without an explicit proof", () => {
    const root = fixtureRoot();
    const result = validateAndApplyRequirementProofs({
      root,
      baselines: [baseline],
      catalog: { ...catalog(), proofs: [] },
      commands: [command("PASSED", 0)],
      requireComplete: false,
    });
    expect(result[0]).toMatchObject({ status: "MISSING", gap: "No proof has been supplied." });
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: { ...catalog(), proofs: [] },
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/lack validated proofs/u);
  });

  it("rejects a terminal proof whose latest command failed", () => {
    const root = fixtureRoot();
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [command("FAILED", 1, 2), command("PASSED", 0, 1)],
      }),
    ).toThrow(/non-passing command unit/u);
  });

  it("applies only a request-bound, evidence-backed, passing proof", () => {
    const root = fixtureRoot();
    const result = validateAndApplyRequirementProofs({
      root,
      baselines: [baseline],
      catalog: catalog(),
      commands: [command("PASSED", 0)],
    });
    expect(result[0]).toEqual({
      ...baseline,
      status: "VERIFIED_RUNTIME",
      evidence: ["tests/control.test.ts"],
      gap: "The seeded missing requirement passed its explicit negative control.",
    });
  });

  it("validates repository-relative command evidence after moving the checkout root", () => {
    const originalRoot = fixtureRoot();
    const portableRecord = command("PASSED", 0);
    const portableLog = readFileSync(join(originalRoot, portableRecord.evidencePath));
    const movedRoot = fixtureRoot();
    writeFileSync(join(movedRoot, portableRecord.evidencePath), portableLog);

    expect(portableRecord.cwd).toBe(".");
    expect(
      validateAndApplyRequirementProofs({
        root: movedRoot,
        baselines: [baseline],
        catalog: catalog(),
        commands: [portableRecord],
      })[0]?.status,
    ).toBe("VERIFIED_RUNTIME");
  });

  it("rejects legacy, fake, tampered, and exact-command-mismatched command evidence", () => {
    const root = fixtureRoot();
    const valid = command("PASSED", 0);
    const legacy: CommandEvidenceRecord = { ...valid };
    delete legacy.integrityVersion;
    delete legacy.evidenceSha256;
    delete legacy.evidenceBytes;
    delete legacy.artifacts;
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [legacy],
      }),
    ).toThrow(/legacy evidence without integrity metadata/u);

    const fakePackageEvidence = command("PASSED", 0, 1, { evidencePath: "package.json" });
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [fakePackageEvidence],
      }),
    ).toThrow(/dedicated audit log/u);

    const wrongCommand = command("PASSED", 0, 1, { command: "pnpm lint" });
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [wrongCommand],
      }),
    ).toThrow(/exact-command mismatch/u);

    const wrongCwd = command("PASSED", 0);
    wrongCwd.cwd = "different-checkout";
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [wrongCwd],
      }),
    ).toThrow(/cwd mismatch/u);

    const tampered = command("PASSED", 0);
    writeFileSync(join(root, tampered.evidencePath), "tampered after execution\n", "utf8");
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [tampered],
      }),
    ).toThrow(/audit log hash or length does not match/u);
  });

  it("binds artifact assertions to declared hashes across copied checkouts and rejects mutation", () => {
    const root = fixtureRoot();
    const artifactPath = "reports/audit/result.json";
    writeFileSync(join(root, artifactPath), '{"result":"verified"}\n', "utf8");
    const artifactCatalog = catalog();
    artifactCatalog.commandContracts.unit!.artifacts = [artifactPath];
    artifactCatalog.proofs[0] = {
      ...artifactCatalog.proofs[0]!,
      evidence: ["tests/control.test.ts", artifactPath],
      verification: [
        { kind: "test", path: "tests/control.test.ts", commandId: "unit" },
        {
          kind: "artifact",
          path: artifactPath,
          jsonPath: "result",
          expected: "verified",
          commandId: "unit",
        },
      ],
    };
    const intervalStart = new Date(Date.now() - 1_000).toISOString();
    const intervalEnd = new Date(Date.now() + 1_000).toISOString();
    const record = command("PASSED", 0, 1, {
      artifacts: [artifactEvidence(root, artifactPath)],
      startedAt: intervalStart,
      endedAt: intervalEnd,
    });
    expect(
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: artifactCatalog,
        commands: [record],
      })[0]?.status,
    ).toBe("VERIFIED_RUNTIME");

    const copiedRoot = fixtureRoot();
    writeFileSync(join(copiedRoot, artifactPath), readFileSync(join(root, artifactPath)));
    writeFileSync(
      join(copiedRoot, record.evidencePath),
      readFileSync(join(root, record.evidencePath)),
    );
    expect(
      validateAndApplyRequirementProofs({
        root: copiedRoot,
        baselines: [baseline],
        catalog: artifactCatalog,
        commands: [record],
      })[0]?.status,
    ).toBe("VERIFIED_RUNTIME");

    writeFileSync(join(root, artifactPath), '{"result":"tampered"}\n', "utf8");
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: artifactCatalog,
        commands: [record],
      }),
    ).toThrow(/artifact hash or length changed after execution/u);
  });

  it("accepts only the canonical release exit 1 with the exact named external SKIPs", () => {
    const root = fixtureRoot();
    const reportPath = "reports/audit/quality-release.json";
    const releaseBaseline: RequirementBaseline = {
      id: "QUAL-013",
      group: "H. Quality",
      priority: "P2",
      requirement: "vh verify release",
      status: "MISSING",
      evidence: [],
      gap: "Release proof is absent.",
    };
    const releaseCatalog: RequirementProofCatalog = {
      schemaVersion: 2,
      branch: "fixture",
      evidenceCeiling: "LOCAL_RUNTIME_AND_SYNTHETIC_FIXTURES",
      commandContracts: {
        "final-verify-release": {
          command: "pnpm verify:release -- --report reports/audit/quality-release.json",
          cwd: ".",
          artifacts: [reportPath],
        },
      },
      proofs: [
        {
          id: "QUAL-013",
          priority: "P2",
          requirement: "vh verify release",
          status: "EXTERNAL_BLOCKER",
          evidenceCeiling: "EXTERNAL_BLOCKER",
          evidence: [reportPath],
          result: "All deterministic checks pass; two named external evidence checks skip.",
          verification: [
            {
              kind: "expected_incomplete_quality_profile",
              path: reportPath,
              commandId: "final-verify-release",
              profile: "release",
              expectedStatus: "INCOMPLETE",
              allowedSkipIds: ["analytics_readiness", "live_analytics_readback"],
            },
          ],
          reviewedAt: "2026-08-09",
          reviewedBy: "codex-independent-audit",
        },
      ],
    };
    const completeGap = {
      why: "Authorized live analytics data is unavailable.",
      missing: "A verified property and fresh provider data.",
      exact_command: "pnpm vh data sync",
      expected_evidence: "A sanitized provider read-back with source and freshness.",
    };
    const releaseStartedAt = new Date(Date.now() - 1_000).toISOString();
    const releaseGeneratedAt = new Date().toISOString();
    const releaseEndedAt = new Date(Date.now() + 1_000).toISOString();
    const writeReport = (
      results: Array<{
        id: string;
        status: "PASS" | "FAIL" | "SKIP" | "NOT_APPLICABLE";
        gap: typeof completeGap | null;
      }>,
    ): void => {
      const summary = { PASS: 0, FAIL: 0, SKIP: 0, NOT_APPLICABLE: 0 };
      for (const result of results) summary[result.status]++;
      writeFileSync(
        join(root, reportPath),
        `${JSON.stringify({
          profile: "release",
          generated_at: releaseGeneratedAt,
          results,
          summary,
          passed: false,
          executed_checks_passed: summary.FAIL === 0,
          status: summary.FAIL > 0 ? "FAIL" : "INCOMPLETE",
        })}\n`,
        "utf8",
      );
    };
    const expectedResults = [
      { id: "unit_integration", status: "PASS" as const, gap: null },
      { id: "analytics_readiness", status: "SKIP" as const, gap: completeGap },
      { id: "live_analytics_readback", status: "SKIP" as const, gap: completeGap },
    ];
    const releaseCommand = (): CommandEvidenceRecord =>
      command("FAILED", 1, 1, {
        id: "final-verify-release",
        command: "pnpm verify:release -- --report reports/audit/quality-release.json",
        artifacts: [artifactEvidence(root, reportPath)],
        startedAt: releaseStartedAt,
        endedAt: releaseEndedAt,
      });

    writeReport(expectedResults);
    expect(
      validateAndApplyRequirementProofs({
        root,
        baselines: [releaseBaseline],
        catalog: releaseCatalog,
        commands: [releaseCommand()],
      })[0]?.status,
    ).toBe("EXTERNAL_BLOCKER");

    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [releaseBaseline],
        catalog: releaseCatalog,
        commands: [{ ...releaseCommand(), exitCode: 2 }],
      }),
    ).toThrow(/requires FAILED exit 1/u);

    writeReport([
      ...expectedResults,
      { id: "unreviewed_provider_skip", status: "SKIP", gap: completeGap },
    ]);
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [releaseBaseline],
        catalog: releaseCatalog,
        commands: [releaseCommand()],
      }),
    ).toThrow(/SKIPs do not exactly match/u);

    const widenedCatalog = structuredClone(releaseCatalog);
    const widenedVerification = widenedCatalog.proofs[0]!.verification[0]!;
    if (widenedVerification.kind !== "expected_incomplete_quality_profile") {
      throw new Error("fixture expected an incomplete quality-profile verification");
    }
    widenedVerification.allowedSkipIds.push("unreviewed_provider_skip");
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [releaseBaseline],
        catalog: widenedCatalog,
        commands: [releaseCommand()],
      }),
    ).toThrow(/allowlist differs from the reviewed external gaps/u);

    writeReport([
      expectedResults[0]!,
      { id: "analytics_readiness", status: "SKIP", gap: null },
      expectedResults[2]!,
    ]);
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [releaseBaseline],
        catalog: releaseCatalog,
        commands: [releaseCommand()],
      }),
    ).toThrow(/lacks the four required gap fields/u);
  });

  it("appends integrity records to a legacy ledger without rewriting its history", () => {
    const root = fixtureRoot();
    const legacyRecord = {
      id: "runner-integrity",
      command: "pnpm test",
      status: "PASSED",
      exitCode: 0,
      skipped: false,
      evidencePath: "reports/audit/command-logs/legacy-check.log",
    };
    writeFileSync(
      join(root, "reports", "audit", "commands-run.json"),
      `${JSON.stringify({ schemaVersion: 1, branch: "fixture", records: [legacyRecord] })}\n`,
      "utf8",
    );
    const runner = join(process.cwd(), "scripts", "run-audit-command.mjs");
    const credentialChunks = [
      ["wh", "sec_fixture_abcdefghijklmnop"],
      ["xkey", "sib-abcdefghijklmnop"],
      ["AK", "IAABCDEFGHIJKLMNOP"],
      ["AI", `za${"FixtureBoundary".repeat(3)}`],
      ["sk_", "test_abcdefghijklmnop"],
      ["sk", "-abcdefghijklmnopqrstuvwxyz"],
      ["github_", "pat_abcdefghijklmnopqrstuvwx"],
      ["xox", "b-abcdefghijklmnop"],
      ["Bear", "er abcdefghijklmnop"],
      ["eyJabcdefghij", ".eyJabcdefghij.abcdefghij"],
      ["postgresql://fixture:", "supersecret@example.test/db"],
      ["https://example.test?api_", "key=querysecretvalue"],
      ["credential_", "canary_fixturevalue"],
      ["-----BEGIN ", "PRIVATE KEY-----fixture-material\n-----END PRIVATE KEY-----"],
    ] as const;
    const rawCredentials = credentialChunks.map(([first, second]) => `${first}${second}`);
    const environmentSecret = ["environment", "-secret-canary-123456"].join("");
    const childScript = [
      'const fs=require("node:fs")',
      'fs.writeFileSync("reports/audit/result.json","{\\"ok\\":true}\\n")',
      `const credentials=${JSON.stringify(credentialChunks)}`,
      "const wait=()=>new Promise((resolve)=>setTimeout(resolve,2))",
      '(async()=>{for(const [first,second] of credentials){process.stdout.write(first);await wait();process.stdout.write(second+"\\n");await wait()}process.stderr.write(credentials[0].join("")+"\\n");const secret=process.env.VH_AUDIT_TEST_SECRET;process.stderr.write(secret.slice(0,5));await wait();process.stderr.write(secret.slice(5)+"\\n")})()',
    ].join(";");
    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--id",
        "runner-integrity",
        "--artifact",
        "reports/audit/result.json",
        "--",
        process.execPath,
        "-e",
        childScript,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, VH_AUDIT_TEST_SECRET: environmentSecret },
      },
    );
    expect(result.status).toBe(0);
    const liveOutput = `${result.stdout}${result.stderr}`;
    for (const marker of [
      "[REDACTED_WEBHOOK_SECRET]",
      "[REDACTED_BREVO_KEY]",
      "[REDACTED_AWS_ACCESS_KEY]",
      "[REDACTED_GOOGLE_API_KEY]",
      "[REDACTED_PROVIDER_KEY]",
      "[REDACTED_API_SECRET_KEY]",
      "[REDACTED_GITHUB_TOKEN]",
      "[REDACTED_SLACK_TOKEN]",
      "[REDACTED_BEARER_TOKEN]",
      "[REDACTED_JWT]",
      "postgresql://[REDACTED]@",
      "[REDACTED_QUERY_CREDENTIAL]",
      "[REDACTED_CREDENTIAL_CANARY]",
      "[REDACTED_PRIVATE_KEY]",
      "[REDACTED_ENV_SECRET]",
    ]) {
      expect(liveOutput).toContain(marker);
    }
    for (const rawCredential of [...rawCredentials, environmentSecret]) {
      expect(liveOutput).not.toContain(rawCredential);
    }
    const ledger = JSON.parse(
      readFileSync(join(root, "reports", "audit", "commands-run.json"), "utf8"),
    ) as { schemaVersion: number; records: CommandEvidenceRecord[] };
    expect(ledger.schemaVersion).toBe(2);
    expect(ledger.records[0]).toEqual(legacyRecord);
    const appended = ledger.records[1]!;
    expect(appended).toMatchObject({
      id: "runner-integrity",
      attempt: 2,
      integrityVersion: 1,
      cwd: ".",
      status: "PASSED",
      exitCode: 0,
      artifacts: [{ path: "reports/audit/result.json" }],
    });
    const log = readFileSync(join(root, appended.evidencePath));
    expect(digest(log)).toEqual({
      sha256: appended.evidenceSha256,
      bytes: appended.evidenceBytes,
    });
    const logText = log.toString("utf8");
    expect(logText).toContain("[REDACTED_ENV_SECRET]");
    for (const rawCredential of [...rawCredentials, environmentSecret]) {
      expect(logText).not.toContain(rawCredential);
    }
    expect(appended.artifacts?.[0]).toEqual(artifactEvidence(root, "reports/audit/result.json"));
  });

  it("canonicalizes an in-repository runner cwd and rejects an outside cwd before execution", () => {
    const root = fixtureRoot();
    const runner = join(process.cwd(), "scripts", "run-audit-command.mjs");
    mkdirSync(join(root, "nested"));
    const inside = spawnSync(
      process.execPath,
      [
        runner,
        "--id",
        "nested-cwd",
        "--cwd",
        "./nested/../nested",
        "--",
        process.execPath,
        "-e",
        'console.log("inside")',
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(inside.status).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(root, "reports", "audit", "commands-run.json"), "utf8"),
    ) as { records: CommandEvidenceRecord[] };
    expect(ledger.records[0]?.cwd).toBe("nested");

    const staleArtifactPath = "reports/audit/stale-result.json";
    writeFileSync(join(root, staleArtifactPath), '{"stale":true}\n', "utf8");
    const stale = spawnSync(
      process.execPath,
      [
        runner,
        "--id",
        "stale-artifact",
        "--artifact",
        staleArtifactPath,
        "--",
        process.execPath,
        "-e",
        'console.log("did not refresh artifact")',
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/artifact was not generated or refreshed during command/u);
    const staleLedger = JSON.parse(
      readFileSync(join(root, "reports", "audit", "commands-run.json"), "utf8"),
    ) as { records: CommandEvidenceRecord[] };
    expect(staleLedger.records).toHaveLength(2);
    expect(staleLedger.records[1]).toMatchObject({
      id: "stale-artifact",
      status: "FAILED",
      exitCode: 1,
      artifacts: [],
    });

    const outside = fixtureRoot();
    const rejected = spawnSync(
      process.execPath,
      [
        runner,
        "--id",
        "outside-cwd",
        "--cwd",
        outside,
        "--",
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync("ran.txt","yes")',
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/cwd must resolve inside the repository/u);
    expect(existsSync(join(outside, "ran.txt"))).toBe(false);
    const unchangedLedger = JSON.parse(
      readFileSync(join(root, "reports", "audit", "commands-run.json"), "utf8"),
    ) as { records: CommandEvidenceRecord[] };
    expect(unchangedLedger.records).toHaveLength(2);

    const credentialArgument = ["wh", "sec_argument_abcdefghijklmnop"].join("");
    const forbidden = spawnSync(
      process.execPath,
      [
        runner,
        "--id",
        "forbidden-credential",
        "--",
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync("credential-command-ran.txt","yes")',
        credentialArgument,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(forbidden.status).toBe(1);
    expect(forbidden.stderr).toMatch(/credential-shaped argument/u);
    expect(forbidden.stderr).not.toContain(credentialArgument);
    expect(existsSync(join(root, "credential-command-ran.txt"))).toBe(false);
    const stillUnchangedLedger = JSON.parse(
      readFileSync(join(root, "reports", "audit", "commands-run.json"), "utf8"),
    ) as { records: CommandEvidenceRecord[] };
    expect(stillUnchangedLedger.records).toHaveLength(2);
  });

  it("rejects a status that exceeds its declared evidence ceiling", () => {
    const root = fixtureRoot();
    const invalid = catalog();
    invalid.proofs[0] = {
      ...invalid.proofs[0]!,
      status: "VERIFIED_INTEGRATION",
      evidenceCeiling: "LOCAL_RUNTIME",
    };
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: invalid,
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/status does not match its evidence ceiling/u);
  });

  it("rejects a catalog bound to another branch", () => {
    const root = fixtureRoot();
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [command("PASSED", 0)],
        expectedBranch: "not-the-fixture-branch",
      }),
    ).toThrow(/catalog branch mismatch/u);
  });

  it("rejects test verification that is not disclosed as row evidence", () => {
    const root = fixtureRoot();
    const invalid = catalog();
    invalid.proofs[0] = {
      ...invalid.proofs[0]!,
      evidence: ["reports/audit/command-logs/unit.log"],
    };
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: invalid,
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/verification path is absent/u);
  });

  it("rejects duplicate baselines and duplicate command attempts", () => {
    const root = fixtureRoot();
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline, baseline],
        catalog: catalog(),
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/duplicate requirement baselines/u);
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [command("PASSED", 0, 1), command("PASSED", 0, 1)],
      }),
    ).toThrow(/duplicate command attempt/u);
  });

  it("rejects nonexistent evidence and a skipped command", () => {
    const root = fixtureRoot();
    const missingEvidence = catalog();
    missingEvidence.proofs[0] = {
      ...missingEvidence.proofs[0]!,
      evidence: ["tests/missing.test.ts"],
      verification: [{ kind: "test", path: "tests/missing.test.ts", commandId: "unit" }],
    };
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: missingEvidence,
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/does not exist/u);

    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: catalog(),
        commands: [{ ...command("PASSED", 0), skipped: true }],
      }),
    ).toThrow(/non-passing command/u);
  });

  it("rejects a generic doctor-only live handoff and preserves an explicit nonterminal gap", () => {
    const root = fixtureRoot();
    const live = catalog();
    live.proofs[0] = {
      ...live.proofs[0]!,
      status: "IMPLEMENTED_LIVE_VERIFICATION_PENDING",
      evidenceCeiling: "IMPLEMENTATION_ONLY",
      liveVerification: {
        attempted: false,
        reason: "No live repository effect was authorized.",
        command: "pnpm vh doctor",
        evidenceRequired:
          "Repository identifier, provider state, company ownership, and timestamped read-back.",
      },
    };
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: live,
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/generic doctor-only/u);

    const incomplete = catalog();
    incomplete.proofs[0] = {
      ...incomplete.proofs[0]!,
      status: "PARTIAL",
      evidenceCeiling: "NONTERMINAL_LOCAL_IMPLEMENTATION",
      blockingGap: {
        reason: "No executable provider path exists.",
        missingExecutablePath: "The official transport and command are absent.",
        nextAction: "Implement the transport, command, and read-back.",
      },
    };
    expect(
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: incomplete,
        commands: [command("PASSED", 0)],
      })[0]?.status,
    ).toBe("PARTIAL");
  });

  it("requires canonical provider handoffs to be capability-specific and fully invokable", () => {
    const root = fixtureRoot();
    const generic = catalog();
    generic.proofs[0] = {
      ...generic.proofs[0]!,
      status: "IMPLEMENTED_LIVE_VERIFICATION_PENDING",
      evidenceCeiling: "IMPLEMENTATION_ONLY",
      liveVerification: {
        attempted: false,
        reason: "No authorized provider effect was attempted.",
        command: "vh provider apply && vh provider read-back",
        evidenceRequired:
          "Provider object identifier, final state, account ownership, and sanitized read-back.",
      },
    };
    expect(() =>
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: generic,
        commands: [command("PASSED", 0)],
      }),
    ).toThrow(/omits --input/u);

    const exact = catalog();
    exact.proofs[0] = {
      ...exact.proofs[0]!,
      status: "IMPLEMENTED_LIVE_VERIFICATION_PENDING",
      evidenceCeiling: "IMPLEMENTATION_ONLY",
      liveVerification: {
        attempted: false,
        reason: "No authorized provider effect was attempted.",
        command:
          'vh provider apply --input "$VH_CREATIVE_VIDEO_GENERATE_OPERATION_JSON" --context "$VH_AUTHORIZED_PROVIDER_CONTEXT_JSON" --idempotency-key "$VH_CREATIVE_APPLY_KEY" && vh provider read-back --input "$VH_CREATIVE_VIDEO_GENERATE_OPERATION_JSON" --context "$VH_AUTHORIZED_PROVIDER_CONTEXT_JSON" --idempotency-key "$VH_CREATIVE_READBACK_KEY"',
        evidenceRequired:
          "Provider object identifier, final state, account ownership, and sanitized read-back.",
      },
    };
    expect(
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: exact,
        commands: [command("PASSED", 0)],
      })[0]?.status,
    ).toBe("IMPLEMENTED_LIVE_VERIFICATION_PENDING");

    exact.proofs[0] = {
      ...exact.proofs[0]!,
      liveVerification: {
        attempted: false,
        reason: "No authorized DNS effect was attempted.",
        command:
          'vh stack apply --input "$VH_FOUNDER_DEFAULT_GENERIC_DNS_RECORD_OPERATION_JSON" --context "$VH_AUTHORIZED_PROVIDER_CONTEXT_JSON" --idempotency-key "$VH_DNS_APPLY_KEY" && vh stack read-back --input "$VH_FOUNDER_DEFAULT_GENERIC_DNS_RECORD_OPERATION_JSON" --context "$VH_AUTHORIZED_PROVIDER_CONTEXT_JSON" --idempotency-key "$VH_DNS_READBACK_KEY"',
        evidenceRequired:
          "DNS record object identifier, authoritative state, zone ownership, and sanitized read-back.",
      },
    };
    expect(
      validateAndApplyRequirementProofs({
        root,
        baselines: [baseline],
        catalog: exact,
        commands: [command("PASSED", 0)],
      })[0]?.status,
    ).toBe("IMPLEMENTED_LIVE_VERIFICATION_PENDING");
  });

  it("validates reviewed snapshot reports as test inputs rather than generated command artifacts", () => {
    const repositoryRoot = process.cwd();
    const readAudit = (name: string): unknown =>
      JSON.parse(readFileSync(join(repositoryRoot, "reports", "audit", name), "utf8")) as unknown;

    expect(readAudit("fleet-upgrade-success.json")).toMatchObject({
      status: "VERIFIED_FIXTURE",
      rollout: {
        ventures: 2,
        canaryCompletedFirst: true,
        batchSize: 1,
        finalStatus: "completed",
      },
      verified: {
        previewVerified: true,
        productionFixtureVerified: true,
        exactProductionHealthVersionReadBack: true,
        organizationAndVentureScopedIdentity: true,
        completedPhaseReconciledWithoutReapply: true,
        independentVentureHealthAfterControllerClose: true,
      },
      liveEffects: false,
    });
    expect(readAudit("fleet-canary-failure.json")).toMatchObject({
      status: "VERIFIED_FIXTURE",
      rollout: {
        batchHooksInvoked: 0,
        priorCoreVersionRestored: true,
      },
      safety: {
        rolloutContinuedAfterFailure: false,
        automaticHighRiskMerge: false,
      },
      liveEffects: false,
    });
    const goldenPaths = readAudit("golden-paths.json") as {
      summary: Record<string, number>;
      paths: Array<{ id: string; status: string }>;
    };
    expect(goldenPaths).toMatchObject({
      summary: { paths: 4, verifiedFixture: 4, liveProviderEffects: 0, customerEffects: 0 },
    });
    expect(goldenPaths.paths).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "B", status: "VERIFIED_FIXTURE" })]),
    );
    expect(readAudit("negative-controls.json")).toMatchObject({
      summary: { requiredControls: 20, verifiedControls: 20, unverifiedControls: 0 },
    });
    expect(readAudit("opus-claims-verification.json")).toMatchObject({ schemaVersion: 1 });
    expect(readAudit("stubs-and-dead-code.json")).toMatchObject({
      verdict: "NO_UNRESOLVED_IMPLEMENTABLE_P0_P1_P2_STUB_OR_DEAD_PACKAGE_FOUND",
    });
  });

  it("keeps the reviewed catalog row-complete and the renderer free of status ID lists", () => {
    const repositoryRoot = process.cwd();
    const reviewed = JSON.parse(
      readFileSync(join(repositoryRoot, "reports", "audit", "requirement-proofs.json"), "utf8"),
    ) as RequirementProofCatalog;
    const matrix = JSON.parse(
      readFileSync(
        join(repositoryRoot, "reports", "audit", "vh-v0.2-codex-requirement-matrix.json"),
        "utf8",
      ),
    ) as { requirements: RequirementBaseline[] };
    expect(reviewed.schemaVersion).toBe(2);
    expect(reviewed.proofs).toHaveLength(174);
    expect(new Set(reviewed.proofs.map(({ id }) => id)).size).toBe(174);
    expect(
      reviewed.proofs.map(({ id, priority, requirement }) => ({ id, priority, requirement })),
    ).toEqual(
      matrix.requirements.map(({ id, priority, requirement }) => ({ id, priority, requirement })),
    );
    expect(
      reviewed.proofs.every(
        ({ evidence, result, verification }) =>
          evidence.length > 0 && result.trim().length > 0 && verification.length > 0,
      ),
    ).toBe(true);

    const renderer = readFileSync(
      join(repositoryRoot, "scripts", "render-vh-v02-completion-matrix.ts"),
      "utf8",
    );
    expect(renderer).not.toMatch(
      /liveVerificationPending|fixtureVerified|integrationVerified|function terminalStatus/u,
    );
    expect(renderer).toContain("validateAndApplyRequirementProofs");

    const verificationCommandIds = [
      ...new Set(
        reviewed.proofs.flatMap((proof) =>
          proof.verification.map((verification) => verification.commandId),
        ),
      ),
    ].sort();
    expect(Object.keys(reviewed.commandContracts).sort()).toEqual(verificationCommandIds);
    expect(
      [
        ...new Set(Object.values(reviewed.commandContracts).flatMap(({ artifacts }) => artifacts)),
      ].sort(),
    ).toEqual([
      "reports/audit/quality-release.json",
      "reports/audit/winner-loop-creative-trace.json",
    ]);
    for (const proof of reviewed.proofs) {
      for (const verification of proof.verification) {
        const contract = reviewed.commandContracts[verification.commandId];
        expect(contract?.command.trim()).not.toBe("");
        expect(contract?.cwd).toBe(".");
        expect(new Set(contract?.artifacts).size).toBe(contract?.artifacts.length);
        if (
          verification.kind === "artifact" ||
          verification.kind === "expected_incomplete_quality_profile"
        ) {
          expect(contract?.artifacts).toContain(verification.path);
        }
      }
    }

    const releaseProof = reviewed.proofs.find(({ id }) => id === "QUAL-013");
    expect(releaseProof).toMatchObject({
      status: "EXTERNAL_BLOCKER",
      evidenceCeiling: "EXTERNAL_BLOCKER",
      verification: expect.arrayContaining([
        {
          kind: "expected_incomplete_quality_profile",
          path: "reports/audit/quality-release.json",
          commandId: "final-verify-release",
          profile: "release",
          expectedStatus: "INCOMPLETE",
          allowedSkipIds: ["analytics_readiness", "live_analytics_readback"],
        },
      ]),
    });
    expect(releaseProof?.evidence).toContain("reports/audit/quality-release.json");
    expect(reviewed.commandContracts["final-verify-release"]).toEqual({
      command: "pnpm verify:release -- --report reports/audit/quality-release.json",
      cwd: ".",
      artifacts: ["reports/audit/quality-release.json"],
    });
  });
});
