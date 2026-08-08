import { z } from "zod";
import { artifactReferenceSchema, rejectCredentialMaterial } from "../config/contracts";
import { sideEffectClassSchema } from "../config/policy-schema";

export type AuthorizationSideEffect = z.infer<typeof sideEffectClassSchema>;

export const authorizationCheckpointEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("authorization_checkpoint_grant"),
    run_id: z.string().min(1).max(128),
    node_id: z.string().min(1).max(128),
    effect: sideEffectClassSchema,
    operation_id: z.string().min(1).max(500),
    status: z.literal("approved"),
    approved_by: z.string().min(1).max(300),
    approved_at: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(2_000),
    limitations: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  })
  .strict()
  .superRefine(rejectCredentialMaterial);

export type AuthorizationCheckpointEvidence = z.infer<typeof authorizationCheckpointEvidenceSchema>;

export const oneShotCheckpointGrantSchema = z
  .object({
    grantId: z.string().regex(/^checkpoint-[a-f0-9]{16,64}$/),
    runId: z.string().min(1).max(128),
    nodeId: z.string().min(1).max(128),
    effect: sideEffectClassSchema,
    operationId: z.string().min(1).max(500),
    approvedBy: z.string().min(1).max(300),
    approvedAt: z.string().datetime({ offset: true }),
    evidenceArtifact: artifactReferenceSchema,
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    consumedAt: z.string().datetime({ offset: true }).nullable(),
    consumedAttempt: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "checkpoint grant expiry must be after issue time",
      });
    }
    if ((grant.consumedAt === null) !== (grant.consumedAttempt === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consumedAt"],
        message: "checkpoint grant consumption timestamp and attempt must be set together",
      });
    }
  });

export type OneShotCheckpointGrant = z.infer<typeof oneShotCheckpointGrantSchema>;

export interface AuthorizationCheckpointScope {
  runId: string;
  nodeId: string;
  effect: AuthorizationSideEffect;
  operationId: string;
}

export class CheckpointGrantError extends Error {
  constructor(
    message: string,
    readonly code:
      | "checkpoint_grant_invalid"
      | "checkpoint_grant_scope_mismatch"
      | "checkpoint_grant_expired"
      | "checkpoint_grant_consumed",
  ) {
    super(message);
    this.name = "CheckpointGrantError";
  }
}

export function checkpointGrantKey(scope: AuthorizationCheckpointScope): string {
  return `${scope.runId}\u0000${scope.nodeId}\u0000${scope.effect}\u0000${scope.operationId}`;
}

export function issueOneShotCheckpointGrant(input: {
  grantId: string;
  scope: AuthorizationCheckpointScope;
  approvedBy: string;
  approvedAt: string;
  evidenceArtifact: string;
  issuedAt: string;
  expiresAt: string;
}): OneShotCheckpointGrant {
  const grant = oneShotCheckpointGrantSchema.parse({
    grantId: input.grantId,
    runId: input.scope.runId,
    nodeId: input.scope.nodeId,
    effect: input.scope.effect,
    operationId: input.scope.operationId,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    evidenceArtifact: input.evidenceArtifact,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    consumedAt: null,
    consumedAttempt: null,
  });
  if (Date.parse(grant.approvedAt) > Date.parse(grant.issuedAt)) {
    throw new CheckpointGrantError(
      `Checkpoint approval ${grant.approvedAt} is later than issue time ${grant.issuedAt}.`,
      "checkpoint_grant_invalid",
    );
  }
  return grant;
}

function assertScope(grant: OneShotCheckpointGrant, scope: AuthorizationCheckpointScope): void {
  if (
    grant.runId !== scope.runId ||
    grant.nodeId !== scope.nodeId ||
    grant.effect !== scope.effect ||
    grant.operationId !== scope.operationId
  ) {
    throw new CheckpointGrantError(
      `Checkpoint grant ${grant.grantId} does not match run ${scope.runId}, node ${scope.nodeId}, effect ${scope.effect}, and operation ${scope.operationId}.`,
      "checkpoint_grant_scope_mismatch",
    );
  }
}

export function consumeOneShotCheckpointGrant(
  grantInput: OneShotCheckpointGrant,
  input: { scope: AuthorizationCheckpointScope; attempt: number; now: string },
): OneShotCheckpointGrant {
  const grant = oneShotCheckpointGrantSchema.parse(grantInput);
  assertScope(grant, input.scope);
  if (grant.consumedAt !== null) {
    throw new CheckpointGrantError(
      `Checkpoint grant ${grant.grantId} was already consumed at ${grant.consumedAt}.`,
      "checkpoint_grant_consumed",
    );
  }
  if (Date.parse(grant.expiresAt) <= Date.parse(input.now)) {
    throw new CheckpointGrantError(
      `Checkpoint grant ${grant.grantId} expired at ${grant.expiresAt}.`,
      "checkpoint_grant_expired",
    );
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new CheckpointGrantError(
      `Checkpoint grant ${grant.grantId} needs a positive workflow attempt.`,
      "checkpoint_grant_invalid",
    );
  }
  return oneShotCheckpointGrantSchema.parse({
    ...grant,
    consumedAt: input.now,
    consumedAttempt: input.attempt,
  });
}

export function assertConsumedCheckpointGrant(
  grantInput: OneShotCheckpointGrant,
  input: { scope: AuthorizationCheckpointScope; now: string },
): void {
  const grant = oneShotCheckpointGrantSchema.parse(grantInput);
  assertScope(grant, input.scope);
  if (grant.consumedAt === null || grant.consumedAttempt === null) {
    throw new CheckpointGrantError(
      `Checkpoint grant ${grant.grantId} was not atomically consumed before provider execution.`,
      "checkpoint_grant_invalid",
    );
  }
  if (
    Date.parse(grant.consumedAt) < Date.parse(grant.issuedAt) ||
    Date.parse(grant.consumedAt) >= Date.parse(grant.expiresAt) ||
    Date.parse(grant.consumedAt) > Date.parse(input.now) ||
    Date.parse(grant.expiresAt) <= Date.parse(input.now)
  ) {
    throw new CheckpointGrantError(
      `Checkpoint grant ${grant.grantId} has an invalid consumption timestamp.`,
      "checkpoint_grant_invalid",
    );
  }
}
