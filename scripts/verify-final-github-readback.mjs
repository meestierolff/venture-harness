#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FINAL_EVIDENCE_LEDGER_PATH,
  assertFinalEvidenceSource,
  finalEvidenceOutputPaths,
  validateFinalEvidenceLedger,
} from "./lib/final-evidence-source.mjs";

export const FINAL_GITHUB_READBACK_PATH = "reports/audit/github-readback.json";
export const EXPECTED_GITHUB_REPOSITORY = "meestierolff/venture-harness";
export const EXPECTED_SOURCE_BRANCH = "sol/vh-v0.2-launch-dogfood";
export const EXPECTED_PULL_REQUEST_NUMBER = 9;
export const EXPECTED_FINAL_EVIDENCE_ENVIRONMENT = "founder-alpha-final-evidence";
export const EXPECTED_REPOSITORY_DESCRIPTION =
  "Open-source, agent-native startup factory: sharpen an idea, build an independent app and launch it in your own stack.";
export const EXPECTED_REPOSITORY_TOPICS = Object.freeze([
  "agentic-ai",
  "ai-agents",
  "app-launcher",
  "cli",
  "mcp",
  "neon",
  "nextjs",
  "open-source",
  "saas",
  "startup",
  "stripe",
  "vercel",
]);

export const EXPECTED_REQUIRED_STATUS_CHECKS = Object.freeze([
  Object.freeze({ context: "CodeQL", integrationId: 57_789 }),
  Object.freeze({ context: "analyze", integrationId: 15_368 }),
  Object.freeze({ context: "fast", integrationId: 15_368 }),
  Object.freeze({ context: "mvp", integrationId: 15_368 }),
  Object.freeze({ context: "package-and-public-surface", integrationId: 15_368 }),
  Object.freeze({ context: "release", integrationId: 15_368 }),
  Object.freeze({ context: "review", integrationId: 15_368 }),
  Object.freeze({ context: "secrets", integrationId: 15_368 }),
]);

const forbiddenRequiredContexts = Object.freeze([
  "final-evidence",
  "parity",
  "public-release",
  "verify",
  "workspace-distribution",
]);

function fail(message) {
  throw new Error(`final GitHub read-back failed: ${message}`);
}

function exactStrings(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.some((entry) => typeof entry !== "string") ||
    [...actual].sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    fail(`${label} does not match the reviewed value`);
  }
}

function statusCheckKey(check) {
  return `${check.context}\u0000${check.integrationId}`;
}

function normalizedStatusChecks(checks) {
  if (!Array.isArray(checks)) fail("main ruleset lacks required status checks");
  return checks
    .map((check) => {
      if (
        !check ||
        typeof check.context !== "string" ||
        !check.context ||
        !Number.isSafeInteger(check.integration_id)
      ) {
        fail("main ruleset contains a malformed required status check");
      }
      return Object.freeze({ context: check.context, integrationId: check.integration_id });
    })
    .sort((left, right) => statusCheckKey(left).localeCompare(statusCheckKey(right)));
}

function assertExactRequiredChecks(checks) {
  const normalized = normalizedStatusChecks(checks);
  const expected = [...EXPECTED_REQUIRED_STATUS_CHECKS].sort((left, right) =>
    statusCheckKey(left).localeCompare(statusCheckKey(right)),
  );
  if (
    normalized.length !== expected.length ||
    normalized.some((check, index) => statusCheckKey(check) !== statusCheckKey(expected[index]))
  ) {
    const forbidden = normalized
      .filter(({ context }) => forbiddenRequiredContexts.includes(context))
      .map(({ context }) => context);
    fail(
      forbidden.length > 0
        ? `main ruleset requires non-universal context(s): ${forbidden.join(", ")}`
        : "main ruleset required contexts or GitHub App integration IDs differ from the reviewed always-PR set",
    );
  }
  return normalized;
}

function ruleByType(ruleset, type) {
  const matches = (ruleset.rules ?? []).filter((rule) => rule?.type === type);
  if (matches.length !== 1) fail(`main ruleset must contain exactly one ${type} rule`);
  return matches[0];
}

function assertMainRuleset(rulesets) {
  if (!Array.isArray(rulesets)) fail("GitHub ruleset response is malformed");
  const candidates = rulesets.filter((ruleset) => {
    const refName = ruleset?.conditions?.ref_name;
    return (
      ruleset?.target === "branch" &&
      ruleset?.enforcement === "active" &&
      Array.isArray(refName?.include) &&
      refName.include.length === 1 &&
      refName.include[0] === "refs/heads/main" &&
      Array.isArray(refName?.exclude) &&
      refName.exclude.length === 0
    );
  });
  if (candidates.length !== 1) {
    fail("expected exactly one active repository ruleset scoped only to refs/heads/main");
  }

  const ruleset = candidates[0];
  if (!Number.isSafeInteger(ruleset.id) || ruleset.id <= 0) fail("main ruleset ID is malformed");
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    fail("main ruleset must not contain bypass actors");
  }
  const allowedRuleTypes = [
    "deletion",
    "non_fast_forward",
    "pull_request",
    "required_linear_history",
    "required_status_checks",
  ];
  exactStrings(
    (ruleset.rules ?? []).map((rule) => rule?.type),
    allowedRuleTypes,
    "main ruleset protections",
  );
  ruleByType(ruleset, "deletion");
  ruleByType(ruleset, "non_fast_forward");
  ruleByType(ruleset, "required_linear_history");

  const pullRequest = ruleByType(ruleset, "pull_request");
  if (
    pullRequest.parameters?.required_approving_review_count !== 0 ||
    pullRequest.parameters?.required_review_thread_resolution !== true ||
    pullRequest.parameters?.require_code_owner_review !== false ||
    pullRequest.parameters?.require_last_push_approval !== false
  ) {
    fail(
      "main ruleset pull-request policy must require conversation resolution with zero approvals, no code-owner review, and no last-push approval",
    );
  }

  const required = ruleByType(ruleset, "required_status_checks");
  if (required.parameters?.strict_required_status_checks_policy !== true) {
    fail("main ruleset status checks must require the branch to be up to date");
  }
  if (required.parameters?.do_not_enforce_on_create === true) {
    fail("main ruleset may not disable status-check enforcement on branch creation");
  }
  const requiredStatusChecks = assertExactRequiredChecks(
    required.parameters?.required_status_checks,
  );

  for (const forbidden of ["merge_queue", "required_deployments", "required_signatures"]) {
    if ((ruleset.rules ?? []).some((rule) => rule?.type === forbidden)) {
      fail(`main ruleset must not require ${forbidden}`);
    }
  }

  return Object.freeze({
    id: ruleset.id,
    target: "branch",
    enforcement: "active",
    refInclude: Object.freeze(["refs/heads/main"]),
    refExclude: Object.freeze([]),
    bypassActorCount: 0,
    protections: Object.freeze({
      deletionRestricted: true,
      forcePushBlocked: true,
      pullRequestRequired: true,
      requiredApprovals: 0,
      conversationResolutionRequired: true,
      linearHistoryRequired: true,
      strictStatusChecksRequired: true,
    }),
    requiredStatusChecks: Object.freeze(requiredStatusChecks),
  });
}

function assertRepository(repository) {
  if (
    repository?.full_name !== EXPECTED_GITHUB_REPOSITORY ||
    repository?.description !== EXPECTED_REPOSITORY_DESCRIPTION ||
    ![null, ""].includes(repository?.homepage) ||
    repository?.has_issues !== true ||
    repository?.private !== false ||
    repository?.visibility !== "public" ||
    repository?.default_branch !== "main" ||
    repository?.license?.spdx_id !== "MIT" ||
    repository?.archived !== false ||
    repository?.disabled !== false
  ) {
    fail("repository metadata does not match the reviewed public founder-alpha identity");
  }
  exactStrings(repository.topics, EXPECTED_REPOSITORY_TOPICS, "repository topics");
  return Object.freeze({
    fullName: EXPECTED_GITHUB_REPOSITORY,
    description: EXPECTED_REPOSITORY_DESCRIPTION,
    homepage: "",
    issuesEnabled: true,
    visibility: "public",
    defaultBranch: "main",
    license: "MIT",
    topics: EXPECTED_REPOSITORY_TOPICS,
  });
}

function enabled(value) {
  return value?.status === "enabled";
}

function assertRepositorySecurity({
  securityRepository,
  vulnerabilityAlerts,
  automatedSecurityFixes,
  privateVulnerabilityReporting,
  openDependabotAlerts,
  openSecretScanningAlerts,
  openCodeScanningAlerts,
}) {
  const security = securityRepository?.security_and_analysis;
  if (
    !enabled(security?.advanced_security) ||
    !enabled(security?.secret_scanning) ||
    !enabled(security?.secret_scanning_push_protection) ||
    vulnerabilityAlerts !== true ||
    automatedSecurityFixes !== true ||
    privateVulnerabilityReporting?.enabled !== true ||
    openDependabotAlerts !== 0 ||
    openSecretScanningAlerts !== 0 ||
    openCodeScanningAlerts !== 0
  ) {
    fail(
      "repository security read-back does not prove enabled Advanced Security, secret scanning, push protection, vulnerability alerts, Dependabot security updates, private vulnerability reporting, and zero open Dependabot/secret-scanning/code-scanning alerts",
    );
  }
  return Object.freeze({
    advancedSecurity: true,
    secretScanning: true,
    pushProtection: true,
    vulnerabilityAlerts: true,
    dependabotSecurityUpdates: true,
    privateVulnerabilityReporting: true,
    openDependabotAlerts: 0,
    openSecretScanningAlerts: 0,
    openCodeScanningAlerts: 0,
  });
}

function assertFinalEvidenceEnvironment(environment, deploymentBranchPolicies) {
  if (
    environment?.name !== EXPECTED_FINAL_EVIDENCE_ENVIRONMENT ||
    environment?.deployment_branch_policy?.protected_branches !== false ||
    environment?.deployment_branch_policy?.custom_branch_policies !== true
  ) {
    fail("final-evidence environment is absent or lacks an exact custom-branch policy");
  }
  const protectionRules = environment.protection_rules;
  if (!Array.isArray(protectionRules)) {
    fail("final-evidence environment protection rules are malformed");
  }
  exactStrings(
    protectionRules.map((rule) => rule?.type),
    ["branch_policy", "required_reviewers"],
    "final-evidence environment protections",
  );
  const reviewerRule = protectionRules.find((rule) => rule?.type === "required_reviewers");
  if (
    !Array.isArray(reviewerRule?.reviewers) ||
    reviewerRule.reviewers.length !== 1 ||
    reviewerRule.reviewers[0]?.type !== "User" ||
    reviewerRule.reviewers[0]?.reviewer?.login !== "meestierolff"
  ) {
    fail("final-evidence environment must require the reviewed maintainer");
  }
  const policies = deploymentBranchPolicies?.branch_policies;
  if (
    deploymentBranchPolicies?.total_count !== 1 ||
    !Array.isArray(policies) ||
    policies.length !== 1 ||
    policies[0]?.name !== EXPECTED_SOURCE_BRANCH ||
    policies[0]?.type !== "branch"
  ) {
    fail("final-evidence environment must allow only the reviewed founder-alpha branch");
  }
  return Object.freeze({
    name: EXPECTED_FINAL_EVIDENCE_ENVIRONMENT,
    requiredReviewer: "meestierolff",
    allowedBranch: EXPECTED_SOURCE_BRANCH,
  });
}

function assertPullRequest(pullRequest, source) {
  if (
    pullRequest?.number !== EXPECTED_PULL_REQUEST_NUMBER ||
    pullRequest?.state !== "open" ||
    pullRequest?.draft !== true ||
    pullRequest?.merged_at !== null ||
    pullRequest?.head?.ref !== EXPECTED_SOURCE_BRANCH ||
    pullRequest?.head?.sha !== source.sha ||
    pullRequest?.head?.repo?.full_name !== EXPECTED_GITHUB_REPOSITORY ||
    pullRequest?.base?.ref !== "main" ||
    pullRequest?.base?.repo?.full_name !== EXPECTED_GITHUB_REPOSITORY
  ) {
    fail("draft PR #9 is not open on the exact reviewed source branch, SHA, and main base");
  }
  return Object.freeze({
    number: EXPECTED_PULL_REQUEST_NUMBER,
    state: "open",
    draft: true,
    headBranch: EXPECTED_SOURCE_BRANCH,
    headSha: source.sha,
    baseBranch: "main",
  });
}

function assertSuccessfulChecks(checkRuns, sourceSha) {
  if (!checkRuns || !Array.isArray(checkRuns.check_runs)) {
    fail("PR-head check-run response is malformed");
  }
  const verified = EXPECTED_REQUIRED_STATUS_CHECKS.map((expected) => {
    const matches = checkRuns.check_runs.filter(
      (check) => check?.name === expected.context && check?.app?.id === expected.integrationId,
    );
    if (matches.length !== 1) {
      fail(
        `PR head ${sourceSha} must have exactly one latest ${expected.context} check from GitHub App ${expected.integrationId}`,
      );
    }
    const check = matches[0];
    if (check.status !== "completed" || check.conclusion !== "success") {
      fail(
        `PR head ${sourceSha} check ${expected.context} is not a completed success (skipped and neutral are not accepted)`,
      );
    }
    return Object.freeze({
      context: expected.context,
      integrationId: expected.integrationId,
      status: "completed",
      conclusion: "success",
    });
  });
  return Object.freeze(verified);
}

export function evaluateGithubReadback({
  repository,
  pullRequest,
  rulesets,
  checkRuns,
  securityRepository = repository,
  vulnerabilityAlerts,
  automatedSecurityFixes,
  privateVulnerabilityReporting,
  openDependabotAlerts,
  openSecretScanningAlerts,
  openCodeScanningAlerts,
  finalEvidenceEnvironment,
  finalEvidenceDeploymentBranchPolicies,
  source,
}) {
  if (
    source?.repository !== EXPECTED_GITHUB_REPOSITORY ||
    source?.branch !== EXPECTED_SOURCE_BRANCH ||
    !/^[a-f0-9]{40}$/u.test(source?.sha ?? "") ||
    !/^[a-f0-9]{40}$/u.test(source?.tree ?? "")
  ) {
    fail("source binding is malformed or names a different repository/branch");
  }
  const checkedRepository = assertRepository(repository);
  const checkedSecurity = assertRepositorySecurity({
    securityRepository,
    vulnerabilityAlerts,
    automatedSecurityFixes,
    privateVulnerabilityReporting,
    openDependabotAlerts,
    openSecretScanningAlerts,
    openCodeScanningAlerts,
  });
  const checkedPullRequest = assertPullRequest(pullRequest, source);
  const checkedRuleset = assertMainRuleset(rulesets);
  const checkedRuns = assertSuccessfulChecks(checkRuns, source.sha);
  const checkedEnvironment = assertFinalEvidenceEnvironment(
    finalEvidenceEnvironment,
    finalEvidenceDeploymentBranchPolicies,
  );
  return Object.freeze({
    schemaVersion: 1,
    status: "VERIFIED",
    source: Object.freeze({ ...source }),
    proofs: Object.freeze({
      repositoryMetadata: true,
      pullRequest: true,
      mainRuleset: true,
      requiredChecks: true,
      repositorySecurity: true,
      protectedFinalEvidenceEnvironment: true,
    }),
    repository: checkedRepository,
    repositorySecurity: checkedSecurity,
    pullRequest: checkedPullRequest,
    mainRuleset: checkedRuleset,
    checkRuns: checkedRuns,
    finalEvidenceEnvironment: checkedEnvironment,
  });
}

function apiPath(baseUrl, path) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    base.hostname !== "api.github.com" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    fail("GITHUB_API_URL must be the credential-free https://api.github.com endpoint");
  }
  return new URL(path, `${base.origin}/`).toString();
}

async function githubJson(fetchImpl, env, path, token = env.GITHUB_TOKEN) {
  const response = await fetchImpl(apiPath(env.GITHUB_API_URL, path), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response?.ok) fail(`GitHub API ${path.split("?")[0]} returned HTTP ${response?.status}`);
  try {
    return await response.json();
  } catch {
    fail(`GitHub API ${path.split("?")[0]} returned malformed JSON`);
  }
}

async function githubEnabledEndpoint(
  fetchImpl,
  env,
  path,
  token = env.GITHUB_TOKEN,
  enabledStatus = 204,
) {
  const response = await fetchImpl(apiPath(env.GITHUB_API_URL, path), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response?.status === enabledStatus) return true;
  if (response?.status === 404) return false;
  fail(`GitHub API ${path} returned HTTP ${response?.status}`);
}

async function githubOpenAlertCount(fetchImpl, env, path, token) {
  const alerts = await githubJson(fetchImpl, env, path, token);
  if (!Array.isArray(alerts)) fail(`GitHub API ${path.split("?")[0]} returned malformed alerts`);
  return alerts.length;
}

export async function readDependabotSecurityUpdateState(fetchImpl, env, path, token) {
  const response = await fetchImpl(apiPath(env.GITHUB_API_URL, path), {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response?.status === 404) return false;
  if (!response?.ok) fail(`GitHub API ${path} returned HTTP ${response?.status}`);
  let state;
  try {
    state = await response.json();
  } catch {
    fail(`GitHub API ${path} returned malformed JSON`);
  }
  if (typeof state?.enabled !== "boolean" || typeof state?.paused !== "boolean") {
    fail(`GitHub API ${path} returned malformed Dependabot security-update state`);
  }
  return state.enabled === true && state.paused === false;
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function verifyFinalGithubReadback({
  rootDirectory = process.cwd(),
  outputPath = FINAL_GITHUB_READBACK_PATH,
  env = process.env,
  fetchImpl = globalThis.fetch,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (
    env.GITHUB_TOKEN?.trim() === "" ||
    typeof env.GITHUB_TOKEN !== "string" ||
    env.GITHUB_SECURITY_READ_TOKEN?.trim() === "" ||
    typeof env.GITHUB_SECURITY_READ_TOKEN !== "string" ||
    env.GITHUB_REPOSITORY !== EXPECTED_GITHUB_REPOSITORY ||
    typeof env.GITHUB_API_URL !== "string" ||
    typeof fetchImpl !== "function"
  ) {
    fail(
      "GITHUB_TOKEN, GITHUB_SECURITY_READ_TOKEN, exact GITHUB_REPOSITORY, GITHUB_API_URL, and fetch are required",
    );
  }
  if (outputPath !== FINAL_GITHUB_READBACK_PATH) {
    fail(`output must be ${FINAL_GITHUB_READBACK_PATH}`);
  }
  if (!Number.isFinite(Date.parse(generatedAt))) fail("generated-at timestamp is malformed");

  const root = realpathSync(rootDirectory);
  const ledger = JSON.parse(readFileSync(resolve(root, FINAL_EVIDENCE_LEDGER_PATH), "utf8"));
  validateFinalEvidenceLedger(ledger);
  if (
    ledger.branch !== EXPECTED_SOURCE_BRANCH ||
    env.GITHUB_SHA !== ledger.sourceSha ||
    env.GITHUB_REF_NAME !== ledger.branch
  ) {
    fail("workflow source environment does not match the initialized final-evidence source");
  }
  const allowedPaths = finalEvidenceOutputPaths(ledger, [outputPath]);
  assertFinalEvidenceSource({ root, expected: ledger, allowedPaths });

  const encodedRepository = EXPECTED_GITHUB_REPOSITORY.split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const [
    repository,
    securityRepository,
    pullRequest,
    summaries,
    checkRuns,
    vulnerabilityAlerts,
    automatedSecurityFixes,
    privateVulnerabilityReporting,
    openDependabotAlerts,
    openSecretScanningAlerts,
    openCodeScanningAlerts,
    finalEvidenceEnvironment,
    finalEvidenceDeploymentBranchPolicies,
  ] = await Promise.all([
    githubJson(fetchImpl, env, `/repos/${encodedRepository}`),
    githubJson(fetchImpl, env, `/repos/${encodedRepository}`, env.GITHUB_SECURITY_READ_TOKEN),
    githubJson(fetchImpl, env, `/repos/${encodedRepository}/pulls/${EXPECTED_PULL_REQUEST_NUMBER}`),
    githubJson(fetchImpl, env, `/repos/${encodedRepository}/rulesets?per_page=100`),
    githubJson(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/commits/${ledger.sourceSha}/check-runs?filter=latest&per_page=100`,
    ),
    githubEnabledEndpoint(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/vulnerability-alerts`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    readDependabotSecurityUpdateState(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/automated-security-fixes`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    githubJson(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/private-vulnerability-reporting`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    githubOpenAlertCount(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/dependabot/alerts?state=open&per_page=100`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    githubOpenAlertCount(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/secret-scanning/alerts?state=open&per_page=100`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    githubOpenAlertCount(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/code-scanning/alerts?state=open&per_page=100`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    githubJson(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/environments/${EXPECTED_FINAL_EVIDENCE_ENVIRONMENT}`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
    githubJson(
      fetchImpl,
      env,
      `/repos/${encodedRepository}/environments/${EXPECTED_FINAL_EVIDENCE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
      env.GITHUB_SECURITY_READ_TOKEN,
    ),
  ]);
  if (!Array.isArray(summaries) || summaries.length === 0) fail("repository has no rulesets");
  const details = await Promise.all(
    summaries.map((summary) => {
      if (!Number.isSafeInteger(summary?.id) || summary.id <= 0) {
        fail("GitHub ruleset list contains a malformed ID");
      }
      return githubJson(fetchImpl, env, `/repos/${encodedRepository}/rulesets/${summary.id}`);
    }),
  );

  const report = evaluateGithubReadback({
    repository,
    securityRepository,
    pullRequest,
    rulesets: details,
    checkRuns,
    vulnerabilityAlerts,
    automatedSecurityFixes,
    privateVulnerabilityReporting,
    openDependabotAlerts,
    openSecretScanningAlerts,
    openCodeScanningAlerts,
    finalEvidenceEnvironment,
    finalEvidenceDeploymentBranchPolicies,
    source: {
      repository: EXPECTED_GITHUB_REPOSITORY,
      branch: ledger.branch,
      sha: ledger.sourceSha,
      tree: ledger.sourceTree,
    },
  });
  const output = { ...report, generatedAt };
  const trackedVentureState = execFileSync("git", ["ls-files", "--", ".venture"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (trackedVentureState) fail("tracked .venture runtime state is present");
  const absoluteOutput = resolve(root, outputPath);
  atomicWrite(absoluteOutput, output);
  assertFinalEvidenceSource({ root, expected: ledger, allowedPaths });
  return output;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || outputIndex !== args.length - 2 || !args[outputIndex + 1]) {
    console.error(
      "usage: node scripts/verify-final-github-readback.mjs --output reports/audit/github-readback.json",
    );
    process.exit(1);
  }
  try {
    const report = await verifyFinalGithubReadback({ outputPath: args[outputIndex + 1] });
    console.log(
      `OK final GitHub read-back: ${report.source.branch}@${report.source.sha} (repository metadata, PR #9, main ruleset, and ${report.checkRuns.length} checks verified)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
