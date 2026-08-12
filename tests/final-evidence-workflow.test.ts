import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveProfileChecks,
  type QualityContract as RuntimeQualityContract,
} from "@/scripts/run-quality-profile";
import {
  FINAL_EVIDENCE_PORTABLE_PATHS,
  stageFinalEvidenceUpload,
} from "@/scripts/stage-final-evidence-upload.mjs";
import { validateFinalEvidenceLedger } from "@/scripts/lib/final-evidence-source.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface FinalEvidenceWorkflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: {
    "final-evidence"?: {
      env?: Record<string, string>;
      environment?: { name?: string };
      steps?: WorkflowStep[];
    };
  };
}

interface ProofCatalog {
  commandContracts: Record<string, { command: string; cwd: string; artifacts: readonly string[] }>;
  proofs: Array<{
    id: string;
    verification: Array<{ kind: string; allowedSkipIds?: string[] }>;
  }>;
}

interface QualityContract {
  profiles?: { release?: { checks?: string[] } };
  checks?: Record<string, { command?: string[] }>;
}

interface FounderAlphaCatalog {
  commandContracts: Record<string, { command: string; cwd: string }>;
  requirements: Array<{
    verification:
      | {
          kind: "github_readback";
          commandIds: [string];
          command: string;
          artifact: string;
        }
      | { kind: string };
  }>;
}

function normalized(value: string): string {
  return value
    .replace(/\\\s*\n\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("founder alpha final-evidence workflow", () => {
  const workflowText = readFileSync(".github/workflows/final-evidence.yml", "utf8");
  const workflow = parse(workflowText) as FinalEvidenceWorkflow;
  const catalog = JSON.parse(readFileSync("reports/audit/requirement-proofs.json", "utf8")) as
    ProofCatalog | undefined;
  const founderCatalog = JSON.parse(
    readFileSync("reports/audit/founder-alpha-requirements.json", "utf8"),
  ) as FounderAlphaCatalog;
  const quality = parse(readFileSync("config/quality.yaml", "utf8")) as QualityContract;
  const steps = workflow.jobs?.["final-evidence"]?.steps ?? [];
  const runText = normalized(steps.flatMap((step) => step.run ?? []).join("\n"));

  it("documents the complete local founder-alpha gate on every release surface", () => {
    const localGate = "pnpm verify:mvp && pnpm verify:release";
    for (const path of [
      "README.md",
      "docs/plans/active/004-vh-v02-launch-dogfood.md",
      "docs/public/PUBLIC_RELEASE_CHECKLIST.md",
      ".github/workflows/final-evidence.yml",
    ]) {
      expect(readFileSync(path, "utf8"), path).toContain(localGate);
    }
  });

  it("runs every reviewed audit command exactly once with its declared artifacts", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(catalog?.commandContracts).toBeDefined();
    const founderContracts = Object.fromEntries(
      Object.entries(founderCatalog.commandContracts).map(([id, contract]) => [
        id,
        {
          ...contract,
          artifacts:
            id === "final-github-readback"
              ? ["reports/audit/github-readback.json"]
              : (catalog?.commandContracts[id]?.artifacts ?? []),
        },
      ]),
    );
    const contracts = { ...catalog!.commandContracts, ...founderContracts };
    expect(Object.keys(founderCatalog.commandContracts).sort()).toEqual(
      Object.keys(contracts).sort(),
    );
    for (const [id, contract] of Object.entries(founderCatalog.commandContracts)) {
      expect(contract).toEqual({ command: contracts[id]?.command, cwd: contracts[id]?.cwd });
    }
    const observedIds = [...runText.matchAll(/--id\s+([a-z0-9._-]+)/gu)].map((match) => match[1]);
    expect(observedIds.sort()).toEqual(Object.keys(contracts).sort());
    expect(new Set(observedIds).size).toBe(observedIds.length);

    for (const [id, contract] of Object.entries(contracts)) {
      expect(contract.cwd).toBe(".");
      expect(runText).toContain(`--id ${id}`);
      expect(runText).toContain(normalized(contract.command));
      for (const artifact of contract.artifacts) {
        expect(runText).toContain(`--artifact ${artifact}`);
      }
    }
  });

  it("asserts a passing release gate and portable evidence", () => {
    // The founder-alpha release gate proves code and fixtures. It must be a
    // plain passing step: a release profile that is required to exit non-zero
    // can never confirm that the alpha is code-complete.
    const release = steps.find((step) => step.name === "Release verification profile");
    expect(release).toBeDefined();
    expect(release?.run).toContain("--id final-verify-release");
    expect(release?.run).toContain("--artifact reports/audit/seed-closure.json");
    expect(release?.env).toEqual({
      VH_SEED_CLOSURE_REPORT: "reports/audit/seed-closure.json",
    });
    expect(release?.run).not.toContain("continue-on-error");
    expect(release?.run).not.toContain("-ne 1");

    const upload = steps.find((step) => step.name === "Upload portable final evidence");
    expect(upload?.if).toContain("steps.credential-scan.outcome == 'success'");
    expect(upload?.if).toContain("steps.render-evidence.outcome == 'success'");
    expect(upload?.if).toContain("steps.render-founder-alpha-evidence.outcome == 'success'");
    expect(upload?.if).toContain("steps.scan-portable-evidence.outcome == 'success'");
    expect(upload?.with?.path).toBe(
      "${{ runner.temp }}/founder-alpha-final-evidence-${{ github.run_id }}/",
    );
    expect(upload?.with?.["if-no-files-found"]).toBe("error");

    const treeScanIndex = steps.findIndex(
      (step) => step.name === "Current-tree and completed-evidence credential scan",
    );
    const winnerIndex = steps.findIndex((step) => step.name === "Winner Loop Fixture D");
    const renderIndex = steps.findIndex(
      (step) => step.name === "Render the evidence-backed completion matrix",
    );
    const stageIndex = steps.findIndex(
      (step) => step.name === "Stage the exact portable evidence payload",
    );
    const founderAlphaRenderIndex = steps.findIndex(
      (step) => step.name === "Render founder-alpha assignment evidence",
    );
    const portableScanIndex = steps.findIndex(
      (step) => step.name === "Scan the exact portable evidence payload",
    );
    const uploadIndex = steps.findIndex((step) => step.name === "Upload portable final evidence");
    expect(treeScanIndex).toBeGreaterThan(winnerIndex);
    expect(treeScanIndex).toBeLessThan(renderIndex);
    expect(founderAlphaRenderIndex).toBeGreaterThan(renderIndex);
    expect(founderAlphaRenderIndex).toBeLessThan(stageIndex);
    expect(stageIndex).toBeGreaterThan(renderIndex);
    expect(portableScanIndex).toBeGreaterThan(stageIndex);
    expect(uploadIndex).toBeGreaterThan(portableScanIndex);
    expect(steps[stageIndex]?.run).toContain("scripts/stage-final-evidence-upload.mjs");
    expect(steps[founderAlphaRenderIndex]?.run).toBe(
      "pnpm exec tsx scripts/render-founder-alpha-evidence.ts",
    );
    expect(steps[portableScanIndex]?.run).toContain('gitleaks dir "${PORTABLE_EVIDENCE_ROOT}"');
  });

  it("keeps the reviewed live SKIP allowlist equal to the real active capability profile", () => {
    const venture = parse(readFileSync("config/venture.yaml", "utf8")) as {
      venture: { capabilities: { active: string[]; open?: string[] } };
    };
    const capabilities = [
      ...venture.venture.capabilities.active,
      ...(venture.venture.capabilities.open ?? []),
    ];
    const liveChecks = resolveProfileChecks(
      quality as unknown as RuntimeQualityContract,
      "live",
      capabilities,
    );
    const selectedReadbacks = liveChecks.filter(
      (id) =>
        (quality as unknown as RuntimeQualityContract).checks[id]?.kind === "provider_readback",
    );
    const liveProof = catalog?.proofs.find(({ id }) => id === "QUAL-020");
    const verification = liveProof?.verification.find(
      ({ kind }) => kind === "expected_incomplete_quality_profile",
    );
    expect(selectedReadbacks).toEqual(["live_stack_readback"]);
    expect(verification?.allowedSkipIds).toEqual(selectedReadbacks);
  });

  it("stages only the source-bound portable allowlist into a fresh outside directory", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-final-evidence-stage-root-"));
    const outputParent = mkdtempSync(join(tmpdir(), "vh-final-evidence-stage-output-"));
    temporaryDirectories.push(root, outputParent);
    writeFileSync(join(root, "source.txt"), "reviewed source\n", "utf8");
    for (const args of [
      ["init", "-b", "fixture"],
      ["config", "user.email", "fixture@example.test"],
      ["config", "user.name", "Fixture"],
      ["add", "source.txt"],
      ["commit", "-m", "source"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    }
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const ledgerPath = join(root, "reports/audit/commands-run.json");
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 3,
        branch: "fixture",
        sourceSha,
        sourceTree,
        sourceClean: true,
        initializedAt: "2026-08-12T10:00:00.000Z",
        records: [],
      })}\n`,
      "utf8",
    );
    for (const path of FINAL_EVIDENCE_PORTABLE_PATHS) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `portable fixture for ${path}\n`, "utf8");
    }
    const output = join(outputParent, "payload");
    const staged = stageFinalEvidenceUpload({ rootDirectory: root, outputDirectory: output });
    expect(staged.sourceSha).toBe(sourceSha);
    expect(staged.paths).toEqual(
      ["reports/audit/commands-run.json", ...FINAL_EVIDENCE_PORTABLE_PATHS].sort(),
    );
    for (const path of staged.paths) expect(existsSync(join(output, path))).toBe(true);
    expect(existsSync(join(output, "source.txt"))).toBe(false);

    const unscoped = JSON.parse(readFileSync(ledgerPath, "utf8"));
    unscoped.records = [
      {
        id: "final-verify",
        attempt: 1,
        sourceBranch: "fixture",
        sourceSha,
        sourceTree,
        evidencePath: "reports/audit/command-logs/final-verify.attempt-1.log",
      },
    ];
    expect(() => validateFinalEvidenceLedger(unscoped)).toThrow(
      /log is not scoped to its immutable source revision/,
    );
  });

  it("binds every audited command and generated matrix to the dispatched clean source", () => {
    const job = workflow.jobs?.["final-evidence"];
    expect(job?.environment).toEqual({ name: "founder-alpha-final-evidence" });
    expect(job?.env).toMatchObject({
      VH_EVIDENCE_SOURCE_SHA: "${{ github.sha }}",
      VH_EVIDENCE_SOURCE_BRANCH: "${{ github.ref_name }}",
    });
    const initializeIndex = steps.findIndex(
      (step) => step.name === "Bind evidence to the clean checked-out source",
    );
    const firstAuditIndex = steps.findIndex((step) => step.name === "Frozen install");
    expect(initializeIndex).toBeGreaterThan(-1);
    expect(initializeIndex).toBeLessThan(firstAuditIndex);
    expect(steps[initializeIndex]?.run).toBe("node scripts/initialize-final-evidence.mjs");

    const renderer = steps.find(
      (step) => step.name === "Render the evidence-backed completion matrix",
    );
    expect(renderer?.run).toBe("pnpm exec tsx scripts/render-vh-v02-completion-matrix.ts");
  });

  it("reads repository, PR, successful checks, and the main ruleset back before rendering", () => {
    expect(workflow.permissions).toEqual({
      checks: "read",
      contents: "read",
      "pull-requests": "read",
      "security-events": "read",
    });
    const readbackIndex = steps.findIndex(
      (step) => step.name === "Source-bound GitHub repository, PR, checks, and ruleset read-back",
    );
    const treeScanIndex = steps.findIndex(
      (step) => step.name === "Current-tree and completed-evidence credential scan",
    );
    expect(readbackIndex).toBeGreaterThan(-1);
    expect(readbackIndex).toBeLessThan(treeScanIndex);
    expect(steps[readbackIndex]?.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      GITHUB_SECURITY_READ_TOKEN: "${{ secrets.VH_GITHUB_SECURITY_READ_TOKEN }}",
    });
    expect(normalized(steps[readbackIndex]?.run ?? "")).toContain(
      "--id final-github-readback --artifact reports/audit/github-readback.json -- node scripts/verify-final-github-readback.mjs --output reports/audit/github-readback.json",
    );
    expect(FINAL_EVIDENCE_PORTABLE_PATHS).toContain("reports/audit/github-readback.json");
  });

  it("attempts live read-back honestly and audits collision-free local raw HTML", () => {
    const live = steps.find((step) => step.name === "Live provider verification attempt");
    expect(live?.run).toContain("--id final-verify-live");
    expect(live?.run).toContain("--artifact reports/audit/quality-live.json");
    expect(live?.run).toContain("0:PASS|1:INCOMPLETE");
    expect(live?.run).not.toContain("continue-on-error");

    const rawHtml = steps.find((step) => step.name === "Raw HTML verification");
    expect(normalized(rawHtml?.run ?? "")).toContain(
      "--id final-raw-html -- pnpm verify:raw-html:local",
    );
    expect(rawHtml?.run).not.toMatch(/(?:3210|43127)/u);

    const rawHtmlContract = catalog?.commandContracts["final-raw-html"];
    expect(rawHtmlContract?.command).toBe("pnpm verify:raw-html:local");
  });

  it("prepares child dependencies and covers Golden Paths, packages, security, and history", () => {
    const preparationIndex = steps.findIndex(
      (step) => step.name === "Prepare child seed dependency closure",
    );
    const mvpIndex = steps.findIndex((step) => step.name === "MVP verification profile");
    expect(preparationIndex).toBeGreaterThan(-1);
    expect(preparationIndex).toBeLessThan(mvpIndex);
    expect(steps[preparationIndex]?.run).toBe("pnpm seed:fetch agentic-web-saas");

    expect(runText).toContain("pnpm verify:release");
    expect(runText).toContain("pnpm release:check");
    expect(runText).toContain("pnpm audit --prod --audit-level=high");
    expect(runText).toContain("gitleaks git . --config .gitleaks.toml --redact");
    expect(runText).toContain("gitleaks dir . --config .gitleaks.toml --redact");
    expect(runText).toContain("pnpm fixture:winner-loop");
    expect(quality.profiles?.release?.checks).toEqual(
      expect.arrayContaining([
        "public_release_safety",
        "workspace_pack_consumer",
        "synthetic_launch_golden_path",
        "seed_dependency_closure",
      ]),
    );
    expect(quality.checks?.synthetic_launch_golden_path?.command).toEqual([
      "pnpm",
      "fixture:venture-launch",
      "--",
      "--json",
    ]);
    expect(quality.checks?.workspace_pack_consumer?.command).toEqual(["pnpm", "test:workspace"]);
  });

  it("lets the staged profiles own the full suite and workspace build exactly once", () => {
    const mvpIndex = steps.findIndex((step) => step.name === "MVP verification profile");
    const releaseIndex = steps.findIndex((step) => step.name === "Release verification profile");
    expect(mvpIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(mvpIndex);

    expect(steps.some((step) => step.name === "Workspace build")).toBe(false);
    expect(steps.some((step) => step.name === "Complete unit and integration suite")).toBe(false);
    expect(steps.some((step) => step.name === "Packed clean-consumer verification")).toBe(false);
    expect(steps.some((step) => step.name === "Synthetic launch fixture")).toBe(false);
    expect(runText).not.toContain("--id final-workspace-build");
    expect(runText).not.toContain("--id final-unit-tests");
    expect(runText).not.toContain("--id final-workspace-pack-consumer");
    expect(runText).not.toContain("--id final-synthetic-launch");

    const compatibility = steps.find((step) => step.name === "Framework verification");
    expect(normalized(compatibility?.run ?? "")).toContain(
      'pnpm verify -- --delegate "pnpm test" --delegate "pnpm typecheck"',
    );
  });

  it("pins every third-party action to an immutable commit", () => {
    const actions = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/u);
    }
  });
});
