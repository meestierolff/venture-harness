import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createDefaultCliServices } from "@/lib/cli/default-services";
import { loopsSchema } from "@/lib/config/loop-schema";
import { FileWorkflowStore } from "@/lib/workflow";

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface LearningWorkflow {
  on: { schedule: { cron: string }[] };
  jobs: { report: { steps: WorkflowStep[] } };
}

const workflowText = readFileSync(".github/workflows/learning-cadence.yml", "utf8");
const workflow = parse(workflowText) as LearningWorkflow;
const loopConfig = loopsSchema.parse(parse(readFileSync("config/loops.yaml", "utf8")));
const enabledFixture = loopsSchema.parse(
  parse(readFileSync("tests/fixtures/learning-cadence-enabled.yaml", "utf8")),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function step(id: string): WorkflowStep {
  const result = workflow.jobs.report.steps.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing learning workflow step ${id}`);
  return result;
}

function namedStep(name: string): WorkflowStep {
  const result = workflow.jobs.report.steps.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing learning workflow step ${name}`);
  return result;
}

describe("scheduled learning workflow", () => {
  it("keeps disabled cadences neutral with explicit skip artifacts", () => {
    const scheduledCadences = new Set(["daily", "weekly", "biweekly", "monthly"]);
    const scheduledLoops = Object.values(loopConfig.loops).filter((loop) =>
      scheduledCadences.has(loop.cadence),
    );
    expect(scheduledLoops).toHaveLength(4);
    expect(scheduledLoops.every((loop) => loop.enabled === false)).toBe(true);

    const workflowCrons = workflow.on.schedule.map(({ cron }) => cron).sort();
    expect(workflowCrons).toEqual(scheduledLoops.map((loop) => loop.trigger.expression).sort());
    const disabled = step("disabled");
    expect(disabled.if).toBe("steps.cadence.outputs.enabled != 'true'");
    expect(disabled.run).toContain('kind: "learning_schedule_skip"');
    expect(disabled.run).toContain("dataSyncAttempted: false");
    expect(disabled.run).toContain("learningReportGenerated: false");
    expect(disabled.run).toContain("schedule-skip.json");
    expect(disabled.run).toContain("schedule-skip.md");

    const guard = namedStep("Enforce truthful scheduled outcome");
    expect(guard.run).toContain('if [ "$CADENCE_ENABLED" != "true" ]');
    expect(guard.run).toContain("explicit skip artifacts were uploaded and the run is neutral");
  });

  it("syncs first and fails an enabled cadence honestly when connectors are unconfigured", async () => {
    const fixtureLoop = Object.values(enabledFixture.loops)[0];
    expect(fixtureLoop).toMatchObject({
      cadence: "daily",
      enabled: true,
      output_destination: "reports/learning/daily",
    });

    const syncStep = step("sync");
    const learnStep = step("learn");
    expect(syncStep.if).toBe("steps.cadence.outputs.enabled == 'true'");
    expect(learnStep.if).toContain("steps.cadence.outputs.enabled == 'true'");
    expect(workflowText.indexOf("Sync direct provider data first")).toBeLessThan(
      workflowText.indexOf("Persist typed bounded learning report"),
    );
    expect(syncStep.run).toContain("pnpm --silent vh -- data sync --json");
    expect(learnStep.run).toContain('pnpm --silent vh -- learn "$CADENCE" --json');
    expect(workflowText).not.toContain("--fixture");

    const root = mkdtempSync(join(tmpdir(), "vh-scheduled-learning-"));
    temporaryDirectories.push(root);
    const services = createDefaultCliServices({
      rootDir: root,
      store: new FileWorkflowStore({ rootDir: join(root, ".venture/runs") }),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });
    const sync = (await services.dataSync!()) as { status: string; nextAction: string };
    expect(sync.status).toBe("not_configured");
    expect(sync.nextAction).toContain("Configure an official read-only");

    const report = (await services.learn!("daily")) as {
      status: string;
      limitations: string[];
      artifacts: { latestJson: string; latestMarkdown: string };
    };
    expect(report.status).toBe("insufficient_evidence");
    expect(report.limitations.join(" ")).toContain("unavailable");
    expect(report.artifacts.latestJson).toBe(fixtureLoop.output_destination + "/latest.json");
    expect(existsSync(join(root, report.artifacts.latestJson))).toBe(true);
    expect(existsSync(join(root, report.artifacts.latestMarkdown))).toBe(true);

    const guard = namedStep("Enforce truthful scheduled outcome");
    expect(guard.run).toContain('if [ "$SYNC_READY" != "true" ]');
    expect(guard.run).toContain('if [ "$report_status" != "complete" ]');
    expect(guard.run).toContain('exit "$failed"');
    const upload = namedStep("Upload typed report artifact");
    expect(upload.if).toContain("always()");
    expect(upload.with?.path).toBe("${{ steps.cadence.outputs.destination }}/");
  });
});
