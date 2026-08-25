import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPECTED_FINAL_EVIDENCE_ENVIRONMENT,
  EXPECTED_GITHUB_REPOSITORY,
  EXPECTED_REPOSITORY_DESCRIPTION,
  EXPECTED_REPOSITORY_TOPICS,
  EXPECTED_REQUIRED_STATUS_CHECKS,
  EXPECTED_SOURCE_BRANCH,
  evaluateGithubReadback,
  readDependabotSecurityUpdateState,
  verifyFinalGithubReadback,
} from "@/scripts/verify-final-github-readback.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const source = Object.freeze({
  repository: EXPECTED_GITHUB_REPOSITORY,
  branch: EXPECTED_SOURCE_BRANCH,
  sha: "a".repeat(40),
  tree: "b".repeat(40),
});

function fixture(boundSource = source) {
  return {
    source: boundSource,
    repository: {
      full_name: EXPECTED_GITHUB_REPOSITORY,
      description: EXPECTED_REPOSITORY_DESCRIPTION,
      homepage: null,
      has_issues: true,
      private: false,
      visibility: "public",
      default_branch: "main",
      license: { spdx_id: "MIT" },
      archived: false,
      disabled: false,
      security_and_analysis: {
        advanced_security: { status: "enabled" },
        secret_scanning: { status: "enabled" },
        secret_scanning_push_protection: { status: "enabled" },
      },
      topics: [...EXPECTED_REPOSITORY_TOPICS].reverse(),
    },
    pullRequest: {
      number: 9,
      state: "open",
      draft: true,
      merged_at: null,
      head: {
        ref: EXPECTED_SOURCE_BRANCH,
        sha: boundSource.sha,
        repo: { full_name: EXPECTED_GITHUB_REPOSITORY },
      },
      base: { ref: "main", repo: { full_name: EXPECTED_GITHUB_REPOSITORY } },
    },
    rulesets: [
      {
        id: 41,
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "required_linear_history" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 0,
              required_review_thread_resolution: true,
              require_code_owner_review: false,
              require_last_push_approval: false,
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              do_not_enforce_on_create: false,
              required_status_checks: EXPECTED_REQUIRED_STATUS_CHECKS.map(
                ({ context, integrationId }) => ({ context, integration_id: integrationId }),
              ).reverse(),
            },
          },
        ],
      },
    ],
    checkRuns: {
      check_runs: EXPECTED_REQUIRED_STATUS_CHECKS.map(({ context, integrationId }) => ({
        name: context,
        status: "completed",
        conclusion: "success",
        app: { id: integrationId },
      })),
    },
    vulnerabilityAlerts: true,
    automatedSecurityFixes: true,
    privateVulnerabilityReporting: { enabled: true },
    openDependabotAlerts: 0,
    openSecretScanningAlerts: 0,
    openCodeScanningAlerts: 0,
    finalEvidenceEnvironment: {
      name: EXPECTED_FINAL_EVIDENCE_ENVIRONMENT,
      protection_rules: [
        { type: "branch_policy" },
        {
          type: "required_reviewers",
          reviewers: [{ type: "User", reviewer: { login: "meestierolff" } }],
        },
      ],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    finalEvidenceDeploymentBranchPolicies: {
      total_count: 1,
      branch_policies: [{ name: EXPECTED_SOURCE_BRANCH, type: "branch" }],
    },
  };
}

describe("final GitHub read-back", () => {
  it("accepts only the reviewed repository, draft PR head, main ruleset, and successful checks", () => {
    const report = evaluateGithubReadback(fixture());
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "VERIFIED",
      source,
      proofs: {
        repositoryMetadata: true,
        pullRequest: true,
        mainRuleset: true,
        requiredChecks: true,
        repositorySecurity: true,
        protectedFinalEvidenceEnvironment: true,
      },
      repository: {
        homepage: "",
        issuesEnabled: true,
        visibility: "public",
        defaultBranch: "main",
        license: "MIT",
      },
      repositorySecurity: {
        advancedSecurity: true,
        secretScanning: true,
        pushProtection: true,
        vulnerabilityAlerts: true,
        dependabotSecurityUpdates: true,
        privateVulnerabilityReporting: true,
      },
      pullRequest: {
        number: 9,
        state: "open",
        draft: true,
        headBranch: EXPECTED_SOURCE_BRANCH,
        headSha: source.sha,
        baseBranch: "main",
      },
      mainRuleset: {
        id: 41,
        bypassActorCount: 0,
        protections: {
          deletionRestricted: true,
          forcePushBlocked: true,
          pullRequestRequired: true,
          requiredApprovals: 0,
          conversationResolutionRequired: true,
          linearHistoryRequired: true,
          strictStatusChecksRequired: true,
        },
      },
      finalEvidenceEnvironment: {
        name: EXPECTED_FINAL_EVIDENCE_ENVIRONMENT,
        requiredReviewer: "meestierolff",
        allowedBranch: EXPECTED_SOURCE_BRANCH,
      },
    });
    expect(report.checkRuns).toHaveLength(EXPECTED_REQUIRED_STATUS_CHECKS.length);
    expect(report.mainRuleset.requiredStatusChecks).toEqual(
      [...EXPECTED_REQUIRED_STATUS_CHECKS].sort((left, right) =>
        `${left.context}\u0000${left.integrationId}`.localeCompare(
          `${right.context}\u0000${right.integrationId}`,
        ),
      ),
    );
  });

  it("rejects repository and PR source mismatches", () => {
    const metadata = fixture();
    metadata.repository.description = "Generic automation framework";
    expect(() => evaluateGithubReadback(metadata)).toThrow(/repository metadata/u);

    const pullRequest = fixture();
    pullRequest.pullRequest.head.sha = "c".repeat(40);
    expect(() => evaluateGithubReadback(pullRequest)).toThrow(/draft PR #9/u);
  });

  it("rejects every disabled repository security control", () => {
    for (const setting of [
      "advanced_security",
      "secret_scanning",
      "secret_scanning_push_protection",
    ] as const) {
      const evidence = fixture();
      evidence.repository.security_and_analysis[setting].status = "disabled";
      expect(() => evaluateGithubReadback(evidence)).toThrow(/security read-back/u);
    }
    for (const override of [
      { vulnerabilityAlerts: undefined },
      { vulnerabilityAlerts: false },
      { automatedSecurityFixes: undefined },
      { automatedSecurityFixes: false },
      { privateVulnerabilityReporting: undefined },
      { privateVulnerabilityReporting: { enabled: false } },
      { openDependabotAlerts: 1 },
      { openSecretScanningAlerts: 1 },
      { openCodeScanningAlerts: 1 },
    ]) {
      expect(() => evaluateGithubReadback({ ...fixture(), ...override })).toThrow(
        /security read-back/u,
      );
    }
  });

  it("rejects an unprotected or broadly scoped final-evidence environment", () => {
    const noReviewer = fixture();
    noReviewer.finalEvidenceEnvironment.protection_rules = [{ type: "branch_policy" }];
    expect(() => evaluateGithubReadback(noReviewer)).toThrow(/environment protections/u);

    const broadBranch = fixture();
    broadBranch.finalEvidenceDeploymentBranchPolicies.branch_policies[0]!.name = "*";
    expect(() => evaluateGithubReadback(broadBranch)).toThrow(/only the reviewed/u);
  });

  it("accepts only enabled, unpaused Dependabot security updates", async () => {
    const env = { GITHUB_API_URL: "https://api.github.com" };
    const path = "/repos/meestierolff/venture-harness/automated-security-fixes";
    const response = (value: unknown, status = 200) =>
      vi.fn(async () =>
        status === 404
          ? new Response(null, { status })
          : new Response(JSON.stringify(value), {
              status,
              headers: { "content-type": "application/json" },
            }),
      );
    await expect(
      readDependabotSecurityUpdateState(
        response({ enabled: true, paused: false }),
        env,
        path,
        "fixture-token",
      ),
    ).resolves.toBe(true);
    for (const value of [
      { enabled: false, paused: false },
      { enabled: true, paused: true },
    ]) {
      await expect(
        readDependabotSecurityUpdateState(response(value), env, path, "fixture-token"),
      ).resolves.toBe(false);
    }
    await expect(
      readDependabotSecurityUpdateState(response(null, 404), env, path, "fixture-token"),
    ).resolves.toBe(false);
    await expect(
      readDependabotSecurityUpdateState(
        vi.fn(async () => new Response("not-json", { status: 200 })),
        env,
        path,
        "fixture-token",
      ),
    ).rejects.toThrow(/malformed JSON/u);
  });

  it("rejects missing protections, wrong integration IDs, and non-universal contexts", () => {
    const protection = fixture();
    protection.rulesets[0]!.rules = protection.rulesets[0]!.rules.filter(
      ({ type }) => type !== "non_fast_forward",
    );
    expect(() => evaluateGithubReadback(protection)).toThrow(/main ruleset protections/u);

    const integration = fixture();
    const checksRule = integration.rulesets[0]!.rules.find(
      ({ type }) => type === "required_status_checks",
    )!;
    const integrationChecks = checksRule.parameters?.required_status_checks as
      Array<{ context: string; integration_id: number }> | undefined;
    const codeqlCheck = integrationChecks?.find(({ context }) => context === "CodeQL");
    if (!codeqlCheck) throw new Error("fixture lacks the CodeQL required check");
    codeqlCheck.integration_id = 15_368;
    expect(() => evaluateGithubReadback(integration)).toThrow(/integration IDs/u);

    const pathFiltered = fixture();
    const pathFilteredRule = pathFiltered.rulesets[0]!.rules.find(
      ({ type }) => type === "required_status_checks",
    )!;
    const pathFilteredChecks = pathFilteredRule.parameters?.required_status_checks as
      Array<{ context: string; integration_id: number }> | undefined;
    if (!pathFilteredChecks) throw new Error("fixture lacks required status checks");
    pathFilteredChecks.push({
      context: "parity",
      integration_id: 15_368,
    });
    expect(() => evaluateGithubReadback(pathFiltered)).toThrow(/non-universal context/u);
  });

  it("rejects skipped, neutral, failed, absent, and duplicate expected check runs", () => {
    for (const conclusion of ["skipped", "neutral", "failure"] as const) {
      const evidence = fixture();
      evidence.checkRuns.check_runs[0]!.conclusion = conclusion;
      expect(() => evaluateGithubReadback(evidence)).toThrow(/completed success/u);
    }

    const absent = fixture();
    absent.checkRuns.check_runs.shift();
    expect(() => evaluateGithubReadback(absent)).toThrow(/exactly one latest/u);

    const duplicate = fixture();
    duplicate.checkRuns.check_runs.push({ ...duplicate.checkRuns.check_runs[0]! });
    expect(() => evaluateGithubReadback(duplicate)).toThrow(/exactly one latest/u);
  });

  it("uses only read-only API calls and writes a sanitized source-bound artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "vh-final-github-readback-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "source.txt"), "reviewed source\n", "utf8");
    for (const args of [
      ["init", "-b", EXPECTED_SOURCE_BRANCH],
      ["config", "user.email", "fixture@example.test"],
      ["config", "user.name", "Fixture"],
      ["add", "source.txt"],
      ["commit", "-m", "source"],
    ]) {
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    }
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const boundSource = {
      repository: EXPECTED_GITHUB_REPOSITORY,
      branch: EXPECTED_SOURCE_BRANCH,
      sha,
      tree,
    } as const;
    const evidence = fixture(boundSource);
    const ledgerPath = join(root, "reports/audit/commands-run.json");
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 3,
        branch: EXPECTED_SOURCE_BRANCH,
        sourceSha: sha,
        sourceTree: tree,
        sourceClean: true,
        initializedAt: "2026-08-12T12:00:00.000Z",
        records: [],
      })}\n`,
      "utf8",
    );

    const requests: Array<{ url: string; method: string; securityRead: boolean }> = [];
    const securityToken = "fixture-admin-read-session";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({
        url,
        method: init?.method ?? "GET",
        securityRead: authorization === `Bearer ${securityToken}`,
      });
      let value: unknown;
      if (url.endsWith("/repos/meestierolff/venture-harness")) value = evidence.repository;
      else if (url.endsWith("/pulls/9")) value = evidence.pullRequest;
      else if (url.endsWith("/rulesets?per_page=100")) value = [{ id: 41 }];
      else if (url.endsWith("/rulesets/41")) value = evidence.rulesets[0];
      else if (url.includes(`/commits/${sha}/check-runs?`)) value = evidence.checkRuns;
      else if (url.endsWith("/vulnerability-alerts")) return new Response(null, { status: 204 });
      else if (url.endsWith("/automated-security-fixes")) {
        return new Response(JSON.stringify({ enabled: true, paused: false }), { status: 200 });
      } else if (url.endsWith("/private-vulnerability-reporting")) value = { enabled: true };
      else if (
        url.endsWith(
          `/environments/${EXPECTED_FINAL_EVIDENCE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
        )
      ) {
        value = evidence.finalEvidenceDeploymentBranchPolicies;
      } else if (url.endsWith(`/environments/${EXPECTED_FINAL_EVIDENCE_ENVIRONMENT}`)) {
        value = evidence.finalEvidenceEnvironment;
      } else if (
        /\/(?:dependabot|secret-scanning|code-scanning)\/alerts\?state=open&per_page=100$/u.test(
          url,
        )
      ) {
        value = [];
      } else return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const token = "fixture-provider-session";
    const report = await verifyFinalGithubReadback({
      rootDirectory: root,
      env: {
        NODE_ENV: "test",
        GITHUB_TOKEN: token,
        GITHUB_SECURITY_READ_TOKEN: securityToken,
        GITHUB_REPOSITORY: EXPECTED_GITHUB_REPOSITORY,
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_SHA: sha,
        GITHUB_REF_NAME: EXPECTED_SOURCE_BRANCH,
      },
      fetchImpl,
      generatedAt: "2026-08-12T13:00:00.000Z",
    });

    expect(report.status).toBe("VERIFIED");
    expect(requests).toHaveLength(14);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.map(({ url }) => url)).toEqual(
      expect.arrayContaining([
        "https://api.github.com/repos/meestierolff/venture-harness",
        "https://api.github.com/repos/meestierolff/venture-harness/pulls/9",
        "https://api.github.com/repos/meestierolff/venture-harness/rulesets?per_page=100",
        `https://api.github.com/repos/meestierolff/venture-harness/commits/${sha}/check-runs?filter=latest&per_page=100`,
        "https://api.github.com/repos/meestierolff/venture-harness/rulesets/41",
        "https://api.github.com/repos/meestierolff/venture-harness/vulnerability-alerts",
        "https://api.github.com/repos/meestierolff/venture-harness/automated-security-fixes",
        "https://api.github.com/repos/meestierolff/venture-harness/private-vulnerability-reporting",
        "https://api.github.com/repos/meestierolff/venture-harness/dependabot/alerts?state=open&per_page=100",
        "https://api.github.com/repos/meestierolff/venture-harness/secret-scanning/alerts?state=open&per_page=100",
        "https://api.github.com/repos/meestierolff/venture-harness/code-scanning/alerts?state=open&per_page=100",
        `https://api.github.com/repos/meestierolff/venture-harness/environments/${EXPECTED_FINAL_EVIDENCE_ENVIRONMENT}`,
        `https://api.github.com/repos/meestierolff/venture-harness/environments/${EXPECTED_FINAL_EVIDENCE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
      ]),
    );
    expect(
      requests
        .filter(({ url }) =>
          /vulnerability-alerts|automated-security-fixes|private-vulnerability-reporting|dependabot\/alerts|secret-scanning\/alerts|code-scanning\/alerts|\/environments\//u.test(
            url,
          ),
        )
        .every(({ securityRead }) => securityRead),
    ).toBe(true);
    const artifact = readFileSync(join(root, "reports/audit/github-readback.json"), "utf8");
    expect(artifact).not.toContain(token);
    expect(artifact).not.toContain(securityToken);
    expect(JSON.parse(artifact)).toMatchObject({
      status: "VERIFIED",
      generatedAt: "2026-08-12T13:00:00.000Z",
      source: boundSource,
    });
  });
});
