import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRepositoryCheckpointEvidenceVerifier,
  loadRepositoryCheckpointEvidence,
} from "@/lib/runtime";
import { workflowNode } from "@/lib/workflow";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("repository checkpoint evidence", () => {
  it("refuses a symlinked checkpoint evidence file", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "vh-checkpoint-evidence-"));
    temporaryDirectories.push(rootDir);
    const runId = "checkpoint-evidence-run";
    const evidenceArtifact = `reports/launch/${runId}/checkpoints/delete-repository.json`;
    const path = join(rootDir, evidenceArtifact);
    const target = join(rootDir, "checkpoint-evidence-target.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(target, "{}\n");
    symlinkSync(target, path);

    expect(() => loadRepositoryCheckpointEvidence({ rootDir, evidenceArtifact, runId })).toThrow(
      /regular non-symlink/,
    );
  });

  it("loads typed in-root evidence and verifies every grant scope field", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "vh-checkpoint-evidence-"));
    temporaryDirectories.push(rootDir);
    const runId = "checkpoint-evidence-run";
    const evidenceArtifact = `reports/launch/${runId}/checkpoints/delete-repository.json`;
    const path = join(rootDir, evidenceArtifact);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schema_version: 1,
          kind: "authorization_checkpoint_grant",
          run_id: runId,
          node_id: "dangerous-provider",
          effect: "external_delete",
          operation_id: "github.repository.delete.fixture",
          status: "approved",
          approved_by: "founder-operator",
          approved_at: "2026-08-04T12:00:00.000Z",
          reason: "Delete only the named synthetic fixture after read-back.",
          limitations: ["No other repository or external effect is approved."],
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    expect(loadRepositoryCheckpointEvidence({ rootDir, evidenceArtifact, runId })).toMatchObject({
      run_id: runId,
      node_id: "dangerous-provider",
      effect: "external_delete",
      operation_id: "github.repository.delete.fixture",
    });

    const verifier = createRepositoryCheckpointEvidenceVerifier({ rootDir });
    const context = {
      runId,
      node: workflowNode("dangerous-provider"),
      effect: "external_delete" as const,
      operationId: "github.repository.delete.fixture",
      evidenceArtifact,
      approvedBy: "founder-operator",
      approvedAt: "2026-08-04T12:00:00.000Z",
    };
    expect(await verifier(context)).toEqual({ ok: true });
    expect(
      await verifier({ ...context, operationId: "github.repository.delete.other" }),
    ).toMatchObject({ ok: false });
  });
});
