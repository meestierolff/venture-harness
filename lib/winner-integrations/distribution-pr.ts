import type {
  LearningConfidence,
  ProductSurface,
  WinnerLoopLearning,
} from "../winner-loop/learnings";

export type { WinnerLoopLearning } from "../winner-loop/learnings";

export interface DistributionPrFileChange {
  readonly path: string;
  readonly operation: "add" | "modify" | "delete";
  readonly before: string;
  readonly after: string;
}

export interface DistributionPrEvidence {
  readonly learningId: string;
  readonly creativeIds: readonly string[];
  readonly creativeFamilyId: string | null;
  readonly cohortWindows: readonly {
    readonly label: string;
    readonly reportingWindowStart: string;
    readonly reportingWindowEnd: string;
    readonly mature: boolean;
  }[];
  readonly attributionClass: WinnerLoopLearning["attributionClass"];
  readonly creativeLevelCertainty: boolean;
  readonly providerKind: string;
  readonly observation: string;
}

export interface DistributionPrProposal {
  readonly proposalId: string;
  readonly organizationId: string;
  readonly ventureId: string;
  readonly source: "winner_loop";
  readonly state: "fixture_proposal_only";
  readonly fixtureOnly: true;
  readonly repositoryMutated: false;
  readonly pullRequestOpened: false;
  readonly publicationAllowed: false;
  readonly evidence: DistributionPrEvidence;
  readonly targetSurface: ProductSurface;
  readonly hypothesis: {
    readonly statement: string;
    readonly confidence: LearningConfidence;
    readonly causalStatus: "not_established";
  };
  readonly implementation: string;
  readonly diff: {
    readonly summary: string;
    readonly files: readonly DistributionPrFileChange[];
  };
  readonly preview: {
    readonly kind: "fixture_description";
    readonly description: string;
    readonly url: null;
  };
  readonly measurement: {
    readonly plan: string;
    readonly creativeIds: readonly string[];
    readonly cohortWindows: readonly string[];
    readonly causalInterpretationAllowed: false;
  };
  readonly rollback: string;
  readonly limitations: readonly string[];
  readonly createdAt: string;
}

export interface CreateFixtureDistributionPrInput {
  readonly proposalId: string;
  readonly learning: WinnerLoopLearning;
  readonly hypothesis?: string;
  readonly implementation: string;
  readonly diffSummary: string;
  readonly files: readonly DistributionPrFileChange[];
  readonly previewDescription: string;
  readonly createdAt: string;
}

export interface DistributionPrScope {
  readonly organizationId: string;
  readonly ventureId: string;
}

export class DistributionPrError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "tenant_scope_mismatch"
      | "unsafe_path"
      | "unsafe_content"
      | "causal_overclaim",
    message: string,
  ) {
    super(message);
    this.name = "DistributionPrError";
  }
}

const CAUSAL_OVERCLAIM =
  /\b(?:caused?|proves?|proven|guarantees?|drove|drives|resulted\s+in|because\s+of)\b/iu;
const PRIVATE_OR_SECRET =
  /(cred:\/\/|bearer\s+[a-z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|pk)_(?:live|test)_[a-z0-9]+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/iu;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9_.:/-]*$/iu;

function assertSafeText(value: string, field: string): void {
  if (!value.trim() || value.length > 2_000) {
    throw new DistributionPrError("invalid_input", `${field} must contain 1–2000 characters`);
  }
  if (PRIVATE_OR_SECRET.test(value)) {
    throw new DistributionPrError(
      "unsafe_content",
      `${field} contains a credential-like or personal value`,
    );
  }
}

function assertSafeIdentifier(value: string, field: string): void {
  if (
    !value ||
    value.length > 256 ||
    !SAFE_IDENTIFIER.test(value) ||
    PRIVATE_OR_SECRET.test(value)
  ) {
    throw new DistributionPrError(
      "unsafe_content",
      `${field} must be a non-personal, non-secret identifier`,
    );
  }
}

function assertNonCausalClaim(value: string, field: string): void {
  if (CAUSAL_OVERCLAIM.test(value)) {
    throw new DistributionPrError(
      "causal_overclaim",
      `${field} must describe an association or test, not a causal conclusion`,
    );
  }
}

function assertSafeFile(change: DistributionPrFileChange): void {
  if (
    !change.path ||
    change.path.startsWith("/") ||
    change.path.includes("\\") ||
    change.path.split("/").includes("..") ||
    /(^|\/)\.env(?:\.|$)/iu.test(change.path) ||
    /(?:credential|secret|private[-_]?key)/iu.test(change.path)
  ) {
    throw new DistributionPrError(
      "unsafe_path",
      `DistributionPR fixture path ${change.path || "<missing>"} is not a safe repository-relative path`,
    );
  }
  assertSafeText(change.before || "fixture-empty-before", `${change.path} before summary`);
  assertSafeText(change.after || "fixture-empty-after", `${change.path} after summary`);
  assertNonCausalClaim(change.after || "fixture-empty-after", `${change.path} after summary`);
}

/**
 * Produce data for a possible pull request without touching a repository,
 * publishing a preview, or claiming that an observed association was causal.
 */
export function createFixtureDistributionPrProposal(
  scope: DistributionPrScope,
  input: CreateFixtureDistributionPrInput,
): DistributionPrProposal {
  if (
    typeof scope.organizationId !== "string" ||
    !scope.organizationId.trim() ||
    typeof scope.ventureId !== "string" ||
    !scope.ventureId.trim() ||
    !input.proposalId.trim() ||
    typeof input.learning.organizationId !== "string" ||
    !input.learning.organizationId.trim() ||
    typeof input.learning.ventureId !== "string" ||
    !input.learning.ventureId.trim()
  ) {
    throw new DistributionPrError(
      "invalid_input",
      "proposalId and caller/learning tenant scope are required",
    );
  }
  if (
    scope.organizationId !== input.learning.organizationId ||
    scope.ventureId !== input.learning.ventureId
  ) {
    throw new DistributionPrError(
      "tenant_scope_mismatch",
      "caller scope does not own this Winner Loop learning",
    );
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new DistributionPrError("invalid_input", "createdAt must be an ISO-compatible timestamp");
  }
  if (input.files.length === 0) {
    throw new DistributionPrError("invalid_input", "At least one fixture file change is required");
  }
  const hypothesis = input.hypothesis?.trim() || input.learning.hypothesis.trim();
  assertSafeText(hypothesis, "hypothesis");
  assertNonCausalClaim(hypothesis, "hypothesis");
  assertSafeText(input.implementation, "implementation");
  assertNonCausalClaim(input.implementation, "implementation");
  assertSafeText(input.diffSummary, "diff summary");
  assertNonCausalClaim(input.diffSummary, "diff summary");
  assertSafeText(input.previewDescription, "preview description");
  assertNonCausalClaim(input.previewDescription, "preview description");
  assertSafeIdentifier(input.learning.learningId, "learningId");
  assertSafeIdentifier(input.learning.organizationId, "organizationId");
  assertSafeIdentifier(input.learning.ventureId, "ventureId");
  assertSafeIdentifier(input.learning.providerContext.provider, "provider kind");
  for (const creativeId of input.learning.creativeIds) {
    assertSafeIdentifier(creativeId, "creativeId");
  }
  if (input.learning.creativeFamilyId) {
    assertSafeIdentifier(input.learning.creativeFamilyId, "creativeFamilyId");
  }
  assertSafeText(input.learning.observation, "learning observation");
  assertNonCausalClaim(input.learning.observation, "learning observation");
  assertSafeText(input.learning.measurementPlan, "learning measurement plan");
  assertSafeText(input.learning.rollback, "learning rollback");
  for (const limitation of input.learning.limitations) {
    assertSafeText(limitation, "learning limitation");
  }
  for (const cohort of input.learning.cohorts) {
    if (
      cohort.organizationId !== input.learning.organizationId ||
      cohort.ventureId !== input.learning.ventureId
    ) {
      throw new DistributionPrError(
        "tenant_scope_mismatch",
        `Cohort ${cohort.window.label} does not belong to this Winner Loop learning`,
      );
    }
    assertSafeIdentifier(cohort.window.label, "cohort window label");
    if (
      !Number.isFinite(Date.parse(cohort.reportingWindowStart)) ||
      !Number.isFinite(Date.parse(cohort.reportingWindowEnd))
    ) {
      throw new DistributionPrError(
        "invalid_input",
        `Cohort ${cohort.window.label} has an invalid reporting window`,
      );
    }
  }
  for (const change of input.files) assertSafeFile(change);

  const cohortWindows = input.learning.cohorts.map((cohort) =>
    Object.freeze({
      label: cohort.window.label,
      reportingWindowStart: cohort.reportingWindowStart,
      reportingWindowEnd: cohort.reportingWindowEnd,
      mature: !cohort.limitations.some((limitation) =>
        limitation.toLowerCase().includes("not mature"),
      ),
    }),
  );
  const limitations = new Set(input.learning.limitations);
  limitations.add(
    "Observed associations do not establish that the creative or proposed change caused the outcome.",
  );
  limitations.add(
    "Fixture-only proposal: no repository was changed, no preview was deployed, and no pull request was opened.",
  );

  return Object.freeze({
    proposalId: input.proposalId,
    organizationId: input.learning.organizationId,
    ventureId: input.learning.ventureId,
    source: "winner_loop",
    state: "fixture_proposal_only",
    fixtureOnly: true,
    repositoryMutated: false,
    pullRequestOpened: false,
    publicationAllowed: false,
    evidence: Object.freeze({
      learningId: input.learning.learningId,
      creativeIds: Object.freeze([...input.learning.creativeIds]),
      creativeFamilyId: input.learning.creativeFamilyId,
      cohortWindows: Object.freeze(cohortWindows),
      attributionClass: input.learning.attributionClass,
      creativeLevelCertainty: input.learning.creativeLevelCertainty,
      providerKind: input.learning.providerContext.provider,
      observation: input.learning.observation,
    }),
    targetSurface: input.learning.recommendedSurface,
    hypothesis: Object.freeze({
      statement: hypothesis,
      confidence: input.learning.confidence,
      causalStatus: "not_established",
    }),
    implementation: input.implementation,
    diff: Object.freeze({
      summary: input.diffSummary,
      files: Object.freeze(input.files.map((change) => Object.freeze({ ...change }))),
    }),
    preview: Object.freeze({
      kind: "fixture_description",
      description: input.previewDescription,
      url: null,
    }),
    measurement: Object.freeze({
      plan: input.learning.measurementPlan,
      creativeIds: Object.freeze([...input.learning.creativeIds]),
      cohortWindows: Object.freeze(cohortWindows.map(({ label }) => label)),
      causalInterpretationAllowed: false,
    }),
    rollback: input.learning.rollback,
    limitations: Object.freeze([...limitations]),
    createdAt: input.createdAt,
  });
}
