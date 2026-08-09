import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  authorizationCheckpointEvidenceSchema,
  type AuthorizationCheckpointEvidence,
} from "../authorization";
import { artifactReferenceSchema } from "../config/contracts";
import { Redactor } from "../credentials";
import type { WorkflowCheckpointEvidenceVerifier } from "../workflow";

export interface RepositoryCheckpointEvidenceOptions {
  rootDir: string;
  evidenceArtifact: string;
  runId: string;
  redactor?: Redactor;
  maxBytes?: number;
}

function inside(rootDir: string, artifact: string): string {
  const root = realpathSync(rootDir);
  const target = resolve(root, artifact);
  const lexicalRelative = relative(root, target);
  if (
    lexicalRelative === "" ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`) ||
    lexicalRelative.startsWith(sep)
  ) {
    throw new Error(`Checkpoint evidence escapes the venture root: ${artifact}`);
  }
  const realTarget = realpathSync(target);
  const realRelative = relative(root, realTarget);
  if (
    realRelative === "" ||
    realRelative === ".." ||
    realRelative.startsWith(`..${sep}`) ||
    realRelative.startsWith(sep)
  ) {
    throw new Error(`Checkpoint evidence resolves outside the venture root: ${artifact}`);
  }
  return target;
}

export function loadRepositoryCheckpointEvidence(
  options: RepositoryCheckpointEvidenceOptions,
): AuthorizationCheckpointEvidence {
  const reference = artifactReferenceSchema.parse(options.evidenceArtifact);
  const prefix = `reports/launch/${options.runId}/checkpoints/`;
  if (!reference.startsWith(prefix) || !reference.endsWith(".json")) {
    throw new Error(`Checkpoint evidence must be a JSON file under ${prefix}.`);
  }
  const lexicalTarget = resolve(options.rootDir, reference);
  if (!existsSync(lexicalTarget)) {
    throw new Error(`Checkpoint evidence file does not exist: ${reference}.`);
  }
  const target = inside(options.rootDir, reference);
  const stat = lstatSync(target);
  const maxBytes = options.maxBytes ?? 1_000_000;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Checkpoint evidence must be a regular non-symlink file: ${reference}.`);
  }
  if (stat.size === 0 || stat.size > maxBytes) {
    throw new Error(
      `Checkpoint evidence size must be between 1 and ${maxBytes} bytes: ${reference}.`,
    );
  }
  const raw = readFileSync(target, "utf8");
  const redactor = options.redactor ?? new Redactor();
  if (redactor.redactText(raw) !== raw) {
    throw new Error("Checkpoint evidence contains registered credential material.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Checkpoint evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return authorizationCheckpointEvidenceSchema.parse(decoded);
}

export function createRepositoryCheckpointEvidenceVerifier(options: {
  rootDir: string;
  redactor?: Redactor;
  maxBytes?: number;
}): WorkflowCheckpointEvidenceVerifier {
  return (context) => {
    let artifact: AuthorizationCheckpointEvidence;
    try {
      artifact = loadRepositoryCheckpointEvidence({
        ...options,
        evidenceArtifact: context.evidenceArtifact,
        runId: context.runId,
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (
      artifact.run_id !== context.runId ||
      artifact.node_id !== context.node.id ||
      artifact.effect !== context.effect ||
      artifact.operation_id !== context.operationId ||
      artifact.approved_by !== context.approvedBy ||
      artifact.approved_at !== context.approvedAt
    ) {
      return {
        ok: false,
        message:
          "Checkpoint evidence run, node, effect, operation, approver, or approval time does not match the requested grant.",
      };
    }
    return { ok: true };
  };
}
