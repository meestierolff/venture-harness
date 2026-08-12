import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateCredentialFindings,
  scanCredentialText,
  validateReleaseScanAllowlist,
  type ReleaseScanAllowlist,
} from "@/scripts/lib/release-security";
import { isPinnedActionRef, workflowActionRefs } from "@/scripts/public-release-check";
import { productionServerCommand } from "@/scripts/run-quality-profile";
import {
  claimEvidencePaths,
  forbiddenClaimPhrases,
  hasRequiredPublicStatusLabel,
  occurrenceIsNegated,
  parseClaimsRegister,
} from "@/scripts/validate-claims";
import {
  fetchWithValidatedRedirects,
  isNonPublicAddress,
  validateAuditUrl,
} from "@/scripts/verify-raw-html";

const ROOT = process.cwd();

describe("credential fixture allowlisting", () => {
  it("allows only an exact path, rule, line, and content fingerprint", () => {
    const credential = ["sk", "live", "syntheticcanary123456"].join("_");
    const finding = scanCredentialText("tests/example.test.ts", credential)[0];
    const allowlist: ReleaseScanAllowlist = {
      schemaVersion: 1,
      entries: [{ ...finding, reason: "Synthetic scanner contract canary." }],
    };
    expect(evaluateCredentialFindings([finding], allowlist)).toMatchObject({
      allowed: [finding],
      unexpected: [],
      stale: [],
    });

    const moved = scanCredentialText("tests/moved.test.ts", credential)[0];
    expect(evaluateCredentialFindings([moved], allowlist)).toMatchObject({
      allowed: [],
      unexpected: [moved],
      stale: allowlist.entries,
    });

    const shifted = scanCredentialText("tests/example.test.ts", `\n${credential}`)[0];
    expect(evaluateCredentialFindings([shifted], allowlist)).toMatchObject({
      allowed: [],
      unexpected: [shifted],
      stale: allowlist.entries,
    });
  });

  it("rejects broad or malformed release allowlists", () => {
    expect(() =>
      validateReleaseScanAllowlist({
        schemaVersion: 1,
        entries: [
          {
            path: "tests/",
            rule: "stripe-access-token",
            line: 0,
            sha256: "not-a-digest",
            reason: "broad fixture exemption",
          },
        ],
      }),
    ).toThrow(/invalid/);
  });

  it("keeps every repository canary fingerprint exact and current", () => {
    const allowlist = validateReleaseScanAllowlist(
      JSON.parse(readFileSync(join(ROOT, ".release-scan-allowlist.json"), "utf8")),
    );
    const findings = [...new Set(allowlist.entries.map((entry) => entry.path))].flatMap((path) =>
      scanCredentialText(path, readFileSync(join(ROOT, path), "utf8")),
    );
    expect(evaluateCredentialFindings(findings, allowlist)).toEqual({
      allowed: findings,
      unexpected: [],
      stale: [],
    });

    const config = readFileSync(join(ROOT, ".gitleaks.toml"), "utf8");
    expect(config).not.toMatch(/tests?\//);
    expect(config).not.toMatch(/fixtures?\//);
  });
});

describe("release supply-chain configuration", () => {
  it("pins every third-party workflow action to a full commit SHA", () => {
    const workflows = [
      "agent-parity.yml",
      "codeql.yml",
      "dependency-review.yml",
      "learning-cadence.yml",
      "public-release.yml",
      "quality.yml",
      "security.yml",
      "weekly-analysis.yml",
    ];
    for (const workflow of workflows) {
      const refs = workflowActionRefs(
        readFileSync(join(ROOT, ".github/workflows", workflow), "utf8"),
      );
      expect(refs.length, workflow).toBeGreaterThan(0);
      expect(refs.every(isPinnedActionRef), workflow).toBe(true);
    }
  });

  it("declares CodeQL, dependency review, Dependabot, history scanning, and audit", () => {
    expect(readFileSync(join(ROOT, ".github/workflows/codeql.yml"), "utf8")).toContain(
      "github/codeql-action/analyze@",
    );
    expect(readFileSync(join(ROOT, ".github/workflows/dependency-review.yml"), "utf8")).toContain(
      "actions/dependency-review-action@",
    );
    expect(readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8")).toContain(
      "package-ecosystem: github-actions",
    );
    const security = readFileSync(join(ROOT, ".github/workflows/security.yml"), "utf8");
    expect(security).toContain("gitleaks/gitleaks-action@");
    expect(security).toContain("fetch-depth: 0");
    expect(security).toContain("pnpm audit --prod --audit-level=high");

    const publicRelease = readFileSync(join(ROOT, ".github/workflows/public-release.yml"), "utf8");
    expect(publicRelease).toContain("fetch-depth: 0");
    expect(publicRelease).toContain("GITLEAKS_VERSION: 8.30.1");
    expect(publicRelease).toContain("GITLEAKS_ENABLE_COMMENTS: false");
    expect(publicRelease).toContain("pnpm seed:fetch agentic-web-saas");
    expect(publicRelease).toContain("pnpm audit --prod --audit-level=high");
    expect(publicRelease).toContain("pnpm verify:mvp");
    expect(publicRelease.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      publicRelease.indexOf("pnpm seed:fetch agentic-web-saas"),
    );
    expect(publicRelease.indexOf("pnpm seed:fetch agentic-web-saas")).toBeLessThan(
      publicRelease.indexOf("pnpm verify:release"),
    );
  });

  it("does not mask a failing critical browser journey with retries", () => {
    const playwright = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
    const runner = readFileSync(join(ROOT, "scripts/run-local-e2e.mjs"), "utf8");
    expect(playwright).toMatch(/retries:\s*0/u);
    expect(playwright).not.toMatch(/retries:\s*process\.env\.CI/u);
    expect(playwright).not.toMatch(/43127|3210/u);
    expect(runner).toContain("startOwnedProductionServer");
    expect(runner).toContain("await stopProductionServer(owned.server)");
    expect(readFileSync(join(ROOT, "scripts/lib/local-production-server.mjs"), "utf8")).toContain(
      "waitForOwnedHttpReady",
    );
    expect(runner).toContain('if (forwarded[0] === "--") forwarded.shift()');
  });

  it("ships the public community and security contracts", () => {
    for (const path of [
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "GOVERNANCE.md",
      "docs/security/THREAT_MODEL.md",
      "docs/security/PROVIDER_AUTH_BOUNDARIES.md",
      "docs/audits/PROVIDER_CAPABILITY_MATRIX.md",
      "docs/public/OPEN_SOURCE_READINESS.md",
    ]) {
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
    expect(readFileSync(join(ROOT, ".github/ISSUE_TEMPLATE/config.yml"), "utf8")).not.toContain(
      "github.com/OWNER/",
    );
  });

  it("labels local OAuth, webhook freshness, and provider SSRF controls without live overclaim", () => {
    const threatModel = readFileSync(join(ROOT, "docs/security/THREAT_MODEL.md"), "utf8");
    const boundaries = readFileSync(
      join(ROOT, "docs/security/PROVIDER_AUTH_BOUNDARIES.md"),
      "utf8",
    );
    expect(threatModel).toMatch(/OAuth callbacks — `IMPLEMENTED_LIVE_VERIFICATION_PENDING`/);
    expect(threatModel).toMatch(/Webhook freshness — `IMPLEMENTED_LIVE_VERIFICATION_PENDING`/);
    expect(threatModel).toMatch(
      /General outbound HTTP SSRF — `IMPLEMENTED_LIVE_VERIFICATION_PENDING`/,
    );
    expect(boundaries).toContain("OAuth authorization code callback — `VERIFIED_LOCAL_CONTRACT`");
    expect(boundaries).toContain("route-bound timestamp");
    expect(boundaries).toContain("Outbound provider HTTP — `VERIFIED_LOCAL_CONTRACT`");
  });
});

describe("raw HTML audit network boundary", () => {
  it("starts Next directly with an explicit loopback host and port", () => {
    expect(productionServerCommand(3210)).toEqual([
      "pnpm",
      "exec",
      "next",
      "start",
      "-H",
      "127.0.0.1",
      "-p",
      "3210",
    ]);
    expect(() => productionServerCommand(0)).toThrow(/Invalid production server port/);
  });

  it("rejects URL credentials, metadata, private DNS results, and mapped loopback", async () => {
    await expect(validateAuditUrl("file:///etc/passwd")).rejects.toThrow(/HTTP or HTTPS/);
    await expect(validateAuditUrl("https://user:pass@example.com")).rejects.toThrow(/credentials/);
    await expect(validateAuditUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /non-public/,
    );
    await expect(
      validateAuditUrl("http://localhost:3210", { resolveHost: async () => ["93.184.216.34"] }),
    ).rejects.toThrow(/non-public hostname/);
    await expect(
      validateAuditUrl("https://public.example", {
        resolveHost: async () => ["93.184.216.34", "10.0.0.8"],
      }),
    ).rejects.toThrow(/non-public/);
    expect(isNonPublicAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("permits explicit loopback only for the internal audit server", async () => {
    await expect(validateAuditUrl("http://127.0.0.1:3210")).rejects.toThrow(/non-public/);
    await expect(
      validateAuditUrl("http://127.0.0.1:3210", { allowLoopback: true }),
    ).resolves.toMatchObject({ hostname: "127.0.0.1", port: "3210" });
    await expect(
      validateAuditUrl("https://public.example", {
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).resolves.toMatchObject({ hostname: "public.example" });
  });

  it("revalidates redirects before making the redirected request", async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(
      fetchWithValidatedRedirects(
        "https://public.example",
        {},
        {
          fetchImpl,
          resolveHost: async () => ["93.184.216.34"],
        },
      ),
    ).rejects.toThrow(/non-public/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("public claim provenance", () => {
  it("parses all eight truth fields and resolves every registered evidence path", () => {
    const parsed = parseClaimsRegister(
      readFileSync(join(ROOT, "docs/product/PRODUCT_TRUTH.md"), "utf8"),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.claims.size).toBeGreaterThan(0);
    for (const claim of parsed.claims.values()) {
      const evidence = claimEvidencePaths(claim.evidence);
      expect(evidence.length, claim.id).toBeGreaterThan(0);
      expect(
        evidence.every((path) => existsSync(join(ROOT, path))),
        claim.id,
      ).toBe(true);
    }
  });

  it("requires visible non-live labels and recognizes strong forbidden wording", () => {
    expect(hasRequiredPublicStatusLabel("PROTOTYPE", "Locally tested prototype behavior")).toBe(
      true,
    );
    expect(hasRequiredPublicStatusLabel("PROTOTYPE", "Works for everyone in production")).toBe(
      false,
    );
    expect(hasRequiredPublicStatusLabel("PLANNED", "Available now")).toBe(false);
    expect(
      forbiddenClaimPhrases("“production-ready lead storage” or live provider verification claims"),
    ).toEqual(
      expect.arrayContaining(["production-ready lead storage", "live provider verification"]),
    );
    const disclaimer = "This is not live provider verification.";
    expect(occurrenceIsNegated(disclaimer, disclaimer.indexOf("live"))).toBe(true);
  });
});
