import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface FinalEvidenceWorkflow {
  on?: Record<string, unknown>;
  jobs?: {
    "final-evidence"?: {
      steps?: WorkflowStep[];
    };
  };
}

interface ProofCatalog {
  commandContracts: Record<string, { command: string; cwd: string; artifacts: readonly string[] }>;
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
  const steps = workflow.jobs?.["final-evidence"]?.steps ?? [];
  const runText = normalized(steps.flatMap((step) => step.run ?? []).join("\n"));

  it("runs every reviewed audit command exactly once with its declared artifacts", () => {
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(catalog?.commandContracts).toBeDefined();
    const contracts = catalog!.commandContracts;
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
    expect(release?.run).not.toContain("continue-on-error");
    expect(release?.run).not.toContain("-ne 1");

    const upload = steps.find((step) => step.name === "Upload portable final evidence");
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path).toContain("reports/audit/commands-run.json");
    expect(upload?.with?.path).toContain("reports/audit/command-logs/");
  });

  it("pins every third-party action to an immutable commit", () => {
    const actions = steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/^[^@\s]+@[a-f0-9]{40}$/u);
    }
  });
});
