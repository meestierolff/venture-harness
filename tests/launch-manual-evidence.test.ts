import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaunchManualBindings,
  createRepositoryInterruptEvidenceVerifier,
  launchManualOutputValidatorName,
} from "@/lib/launch";
import { FileWorkflowStore, WorkflowExecutor, defineWorkflow, workflowNode } from "@/lib/workflow";

const temporaryDirectories: string[] = [];
const output = {
  mode: "manual_dns" as const,
  records: [
    {
      source_provider: "vercel" as const,
      type: "CNAME" as const,
      name: "www.example.test",
      value: "cname.vercel-dns.com",
      ttl: 300,
      reason: "Attach the production web domain.",
    },
  ],
  preserved_existing_mail_records: true as const,
  preserved_nameservers: true as const,
  propagation_checks: [
    {
      resolver: "1.1.1.1",
      checked_at: "2026-08-04T12:00:00.000Z",
      status: "matched" as const,
    },
    {
      resolver: "8.8.8.8",
      checked_at: "2026-08-04T12:00:00.000Z",
      status: "matched" as const,
    },
  ],
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function harness() {
  const rootDir = mkdtempSync(join(tmpdir(), "vh-manual-evidence-"));
  temporaryDirectories.push(rootDir);
  const store = new FileWorkflowStore({ rootDir: join(rootDir, ".venture", "runs") });
  const manual = createLaunchManualBindings();
  const executor = new WorkflowExecutor({
    store,
    bindings: {
      ...manual,
      interruptEvidenceVerifier: createRepositoryInterruptEvidenceVerifier({ rootDir }),
    },
  });
  const definition = defineWorkflow({
    id: "manual-proof",
    name: "Manual proof",
    version: "1",
    nodes: [
      workflowNode("dns-records", {
        kind: "manual_action",
        transport: "manual",
        handler: undefined,
        effect: "external_reversible",
        output: { validator: launchManualOutputValidatorName("dns-records") },
        completion: {
          description: "DNS state is proven",
          validator: launchManualOutputValidatorName("dns-records"),
        },
        evidence: { required: true },
      }),
    ],
    maxParallel: 1,
    maxIterations: 4,
    budgets: {},
  });
  return { rootDir, store, executor, definition };
}

describe("manual launch evidence", () => {
  it("keeps the run waiting when an evidence path does not exist", async () => {
    const { store, executor, definition } = harness();
    await executor.start(definition, { runId: "manual-proof-run" });

    await expect(
      executor.completeManualAction("manual-proof-run", "dns-records", {
        approvedBy: "founder",
        output,
        evidenceArtifact: "reports/launch/manual-proof-run/manual/dns-records.json",
      }),
    ).rejects.toThrow(/does not exist/);

    expect(store.load("manual-proof-run").nodes["dns-records"].state).toBe(
      "waiting_for_manual_action",
    );
    expect(store.load("manual-proof-run").nodes["dns-records"].effectVerified).toBe(false);
  });

  it("refuses a symlinked manual evidence file", async () => {
    const { rootDir, store, executor, definition } = harness();
    await executor.start(definition, { runId: "manual-proof-run" });
    const artifact = "reports/launch/manual-proof-run/manual/dns-records.json";
    const path = join(rootDir, artifact);
    const target = join(rootDir, "manual-evidence-target.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(target, "{}\n");
    symlinkSync(target, path);

    await expect(
      executor.completeManualAction("manual-proof-run", "dns-records", {
        approvedBy: "founder",
        output,
        evidenceArtifact: artifact,
      }),
    ).rejects.toThrow(/regular non-symlink/);
    expect(store.load("manual-proof-run").nodes["dns-records"].state).toBe(
      "waiting_for_manual_action",
    );
  });

  it("validates typed output and matching repository evidence before recording the effect", async () => {
    const { rootDir, store, executor, definition } = harness();
    await executor.start(definition, { runId: "manual-proof-run" });
    const artifact = "reports/launch/manual-proof-run/manual/dns-records.json";
    const path = join(rootDir, artifact);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema_version: 1,
          kind: "manual_action_evidence",
          run_id: "manual-proof-run",
          node_id: "dns-records",
          status: "verified",
          approved_by: "founder",
          verified_at: "2026-08-04T12:00:00.000Z",
          output,
          verification: ["Matched the declared record through two public resolvers."],
          limitations: [],
        },
        null,
        2,
      )}\n`,
    );

    await executor.completeManualAction("manual-proof-run", "dns-records", {
      approvedBy: "founder",
      output,
      evidenceArtifact: artifact,
    });

    const state = store.load("manual-proof-run");
    expect(state.nodes["dns-records"]).toMatchObject({
      state: "succeeded",
      effectVerified: true,
      evidenceArtifact: artifact,
    });
    expect(state.verifiedEffects["dns-records"]).toMatchObject({ nodeId: "dns-records" });
  });
});
