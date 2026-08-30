import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { analyticsSchema, offerSchema } from "@/lib/config/schemas";
import { launchSchema } from "@/lib/config/launch-schema";
import { loopsSchema } from "@/lib/config/loop-schema";
import { mobileSchema } from "@/lib/config/mobile-schema";
import { policiesSchema } from "@/lib/config/policy-schema";
import { providersSchema } from "@/lib/config/provider-schema";
import { ventureSchema } from "@/lib/config/venture-schema";
import {
  compileVentureMaterialization,
  createLaunchGrant,
  materializeVenture,
  NodeMaterializationFileSystem,
  type LaunchGrantInput,
  type SeedId,
} from "@/lib/materialization";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WORKFLOW_SHA = "a".repeat(40);
const TSX_IMPORT = createRequire(import.meta.url).resolve("tsx");

function input(seedId: SeedId, overrides: Partial<LaunchGrantInput> = {}): LaunchGrantInput {
  return {
    ownerOrganizationId: "founder-company",
    ventureName: "Payout Rank",
    ventureSlug: "payout-rank",
    ideaDigest: "b".repeat(64),
    seed: { id: seedId, version: "0.2.0" },
    stackProfile: { id: "founder-default", version: "0.2.0" },
    repository: { owner: "founder-company", name: "payout-rank", visibility: "private" },
    providerAccounts: [
      {
        capability: "source.repository.create",
        provider: "github",
        externalAccountId: "github-founder-company",
        ownerOrganizationId: "founder-company",
        stackClass: "company",
        ownership: "company_owned",
      },
    ],
    autonomyProfile: "owner_preview",
    allowedExternalEffects: ["repository.create"],
    modelBudget: { maxTokens: 25_000, maxMinorUnits: 0, currency: "EUR" },
    externalResourceBudget: { maxResources: 1, maxMinorUnits: 0, currency: "EUR" },
    permissions: {
      productionDeployment: false,
      domainConfiguration: false,
      liveCommerceConfiguration: false,
    },
    createdAt: "2026-08-09T11:00:00.000Z",
    expiresAt: "2026-08-10T12:00:00.000Z",
    grantedBy: { actorId: "founder-user", actorType: "founder" },
    approvalRef: "approval:web-seed-fixture",
    revokedAt: null,
    ...overrides,
  };
}

function plan(seedId: SeedId, overrides: Partial<LaunchGrantInput> = {}) {
  return compileVentureMaterialization({
    grant: createLaunchGrant(input(seedId, overrides)),
    at: NOW,
    coreVersion: "0.2.0",
    workflowRefSha: WORKFLOW_SHA,
    workflowRepository: "venture-harness/venture-harness",
  });
}

function content(compiled: ReturnType<typeof plan>, path: string): string {
  const selected = compiled.files.find((candidate) => candidate.path === path);
  if (!selected) throw new Error(`missing materialized file ${path}`);
  return selected.content;
}

describe("ordinary web venture seed", () => {
  it("pins the generated caller to the checked-in reusable child verification workflow", () => {
    const compiled = plan("agentic-web-saas");
    const caller = parse(content(compiled, ".github/workflows/venture-core.yml")) as {
      jobs: { verify: { uses: string } };
    };
    const reusable = parse(readFileSync(".github/workflows/venture-verify.yml", "utf8")) as {
      on: { workflow_call?: unknown };
      permissions: { contents: string };
      jobs: {
        verify: {
          steps: Array<{
            name?: string;
            uses?: string;
            run?: string;
            with?: Record<string, string | number>;
            env?: Record<string, string>;
          }>;
        };
      };
    };

    // The generated venture calls the Core checkout it was launched from, so no
    // one author's repository is baked into other people's products.
    expect(caller.jobs.verify.uses).toBe(
      `venture-harness/venture-harness/.github/workflows/venture-verify.yml@${WORKFLOW_SHA}`,
    );
    expect(reusable.on).toHaveProperty("workflow_call");
    expect(reusable.permissions).toEqual({ contents: "read" });
    const steps = reusable.jobs.verify.steps;
    const actions = steps.flatMap(({ uses }) => (uses ? [uses] : []));
    expect(actions).toEqual([
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ]);
    expect(actions.every((action) => /@[a-f0-9]{40}$/u.test(action))).toBe(true);
    // The child's package.json `packageManager` is the single pnpm version
    // source. Declaring a second version here makes pnpm/action-setup refuse
    // to install at all, which is what broke every CI job on this repository.
    expect(steps.find(({ uses }) => uses?.startsWith("pnpm/action-setup@"))?.with).toBeUndefined();
    expect(steps.find(({ name }) => name === "Install exact child dependencies")?.run).toBe(
      "pnpm install --frozen-lockfile --ignore-workspace",
    );
    expect(steps.find(({ name }) => name === "Install Chromium for the primary journey")?.run).toBe(
      "pnpm exec playwright install --with-deps chromium",
    );
    const mvp = steps.find(({ name }) => name === "Verify child production-shaped MVP");
    expect(mvp?.run).toBe("pnpm verify:mvp");
    expect(mvp?.env).toEqual({
      NEXT_PUBLIC_SITE_URL: "https://child-ci.example.invalid",
      NEXT_PUBLIC_INDEXING_ENABLED: "true",
      VERCEL: "1",
      VERCEL_ENV: "production",
    });
  });

  it("materializes an independently installable and buildable Next.js repository shape", () => {
    const compiled = plan("agentic-web-saas");
    const packageJson = JSON.parse(content(compiled, "package.json")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      pnpm: { onlyBuiltDependencies: string[] };
    };

    expect(packageJson.scripts).toMatchObject({
      dev: "next dev",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      test: "node --test tests/*.test.mjs",
      "test:e2e:readonly":
        "tsx scripts/run-local-browser-check.ts tests/e2e/post-deploy-readonly.spec.ts",
      "test:e2e:primary-journey":
        "tsx scripts/run-local-browser-check.ts tests/e2e/primary-journey.spec.ts",
      verify: "pnpm typecheck && pnpm test && pnpm build",
      "verify:fast": "pnpm typecheck && pnpm test",
      "verify:mvp":
        "pnpm verify:fast && pnpm build && pnpm test:e2e:readonly && pnpm test:e2e:primary-journey",
    });
    expect(packageJson.dependencies).toEqual({
      next: "15.5.21",
      react: "19.2.7",
      "react-dom": "19.2.7",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@playwright/test": "1.62.1",
      "@types/node": "22.20.1",
      "@types/react": "19.2.17",
      "@types/react-dom": "19.2.3",
      tsx: "4.23.1",
      typescript: "5.9.3",
    });
    expect(JSON.stringify(packageJson)).not.toContain("workspace:");
    expect(packageJson.pnpm).toEqual({ onlyBuiltDependencies: [] });
    const executionPolicy = JSON.parse(
      content(compiled, "config/package-execution-policy.json"),
    ) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      pnpm: { onlyBuiltDependencies: string[] };
      lockfileSha256: string;
    };
    expect(executionPolicy).toMatchObject({
      scripts: packageJson.scripts,
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      pnpm: { onlyBuiltDependencies: [] },
      lockfileSha256: createHash("sha256")
        .update(content(compiled, "pnpm-lock.yaml"))
        .digest("hex"),
    });
    expect(
      compiled.files.find(({ path }) => path === "config/package-execution-policy.json")?.ownership,
    ).toBe("core_owned");
    expect(Object.keys(packageJson.dependencies)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^@venture-harness\//)]),
    );

    expect(compiled.files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "app/layout.tsx",
        "app/page.tsx",
        "app/status/page.tsx",
        "app/api/health/route.ts",
        "app/robots.ts",
        "app/sitemap.ts",
        "next.config.mjs",
        "next-env.d.ts",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "playwright.config.ts",
        "scripts/run-local-browser-check.ts",
        "scripts/github-publish-source.ts",
        "PROJECT.md",
        "AGENTS.md",
        "docs/product/PRODUCT_CONSTITUTION.md",
        "docs/product/idea.md",
        "skills/design-director/SKILL.md",
        "skills/design-director/references/originality-audit.md",
        "skills/seo-aeo-engine/SKILL.md",
        "skills/seo-aeo-engine/references/technical-discovery.md",
        "config/seo.yaml",
        "tests/seed-contract.test.mjs",
        "tests/e2e/post-deploy-readonly.spec.ts",
      ]),
    );
    const dependencyLock = parse(content(compiled, "pnpm-lock.yaml")) as {
      lockfileVersion: string;
      importers: Record<
        string,
        {
          dependencies: Record<string, { specifier: string }>;
          devDependencies: Record<string, { specifier: string }>;
        }
      >;
    };
    expect(dependencyLock.lockfileVersion).toBe("9.0");
    expect(
      Object.fromEntries(
        Object.entries(dependencyLock.importers["."]!.dependencies).map(([name, dependency]) => [
          name,
          dependency.specifier,
        ]),
      ),
    ).toEqual(packageJson.dependencies);
    expect(
      Object.fromEntries(
        Object.entries(dependencyLock.importers["."]!.devDependencies).map(([name, dependency]) => [
          name,
          dependency.specifier,
        ]),
      ),
    ).toEqual(packageJson.devDependencies);
    expect(content(compiled, "pnpm-lock.yaml")).not.toContain("workspace:");
    expect(compiled.files.find(({ path }) => path === "pnpm-lock.yaml")?.ownership).toBe(
      "merge_managed",
    );
    expect(compiled.files.map(({ path }) => path)).not.toEqual(
      expect.arrayContaining([
        "migrations/sql/001_core_evidence.up.sql",
        "migrations/sql/001_core_evidence.down.sql",
      ]),
    );
  });

  it("keeps the ordinary app free of recursive service and full Agent Surface defaults", () => {
    const compiled = plan("agentic-web-saas");
    const paths = new Set(compiled.files.map(({ path }) => path));

    expect(compiled.seed.serviceRuntime).toBe("none");
    expect(compiled.manifest).not.toHaveProperty("serviceBlueprints");
    expect(compiled.manifest).not.toHaveProperty("agentSurface");
    expect(paths.has("runtime/bootstrap.ts")).toBe(false);
    expect(paths.has("service-blueprints/primary.json")).toBe(false);
    expect(compiled.seed.generatorVersions).toEqual({ ui: "0.2.0" });
    expect(compiled.seed.runtimePackages).toEqual({
      next: "15.5.21",
      react: "19.2.7",
      "react-dom": "19.2.7",
    });
    expect(JSON.parse(readFileSync("seeds/agentic-web-saas/seed.json", "utf8")).runtime).toEqual([
      "next",
      "react",
    ]);
  });

  it("provides bounded product context and an originality skill without inventing a contract", () => {
    const compiled = plan("agentic-web-saas");

    expect(content(compiled, "PROJECT.md")).toContain("config/launch-contract.yaml");
    expect(content(compiled, "PROJECT.md")).toContain("One primary journey");
    expect(content(compiled, "AGENTS.md")).toContain("skills/design-director/SKILL.md");
    expect(content(compiled, "docs/product/PRODUCT_CONSTITUTION.md")).toContain(
      "every capability, provider connection, customer outcome, metric, and commercial result is UNKNOWN",
    );
    expect(content(compiled, "docs/product/idea.md")).toContain(
      "This seed placeholder makes no product or market claim",
    );
    expect(compiled.files.some(({ path }) => path === "config/launch-contract.yaml")).toBe(false);

    const designSkill = content(compiled, "skills/design-director/SKILL.md");
    const audit = content(compiled, "skills/design-director/references/originality-audit.md");
    expect(designSkill).toContain("Launch Contract and Product Constitution");
    expect(designSkill).toContain("Product and design files are venture-owned");
    expect(audit).toContain("generic purple AI gradient");
    expect(audit).toContain("static marketing page");
    expect(audit).toContain("visible focus");
    expect(compiled.files.find(({ path }) => path === "PROJECT.md")?.ownership).toBe(
      "venture_owned",
    );
    expect(
      compiled.files.find(({ path }) => path === "docs/product/PRODUCT_CONSTITUTION.md")?.ownership,
    ).toBe("venture_owned");
    expect(
      compiled.files.find(({ path }) => path === "skills/design-director/SKILL.md")?.ownership,
    ).toBe("core_owned");
  });

  it("materializes the exact child-local publisher and read-only journey contracts", () => {
    const compiled = plan("agentic-web-saas");
    const publisher = compiled.files.find(
      ({ path }) => path === "scripts/github-publish-source.ts",
    );
    const journey = compiled.files.find(
      ({ path }) => path === "tests/e2e/post-deploy-readonly.spec.ts",
    );
    const playwright = compiled.files.find(({ path }) => path === "playwright.config.ts");
    const localRunner = compiled.files.find(
      ({ path }) => path === "scripts/run-local-browser-check.ts",
    );
    const healthRoute = compiled.files.find(({ path }) => path === "app/api/health/route.ts");

    expect(publisher?.ownership).toBe("core_owned");
    expect(publisher?.content).toContain(
      "Expected apply or verify; no provider operation was attempted",
    );
    expect(publisher?.content).toContain("refusing to overwrite it");
    expect(publisher?.content).toContain('"--object-format=sha1"');
    expect(publisher?.content).toContain('const BOOTSTRAP_PATH = ".venture-harness-bootstrap"');
    expect(publisher?.content).toContain("parents: [parentCommitOid]");
    expect(publisher?.content).toContain('method: "PATCH"');
    expect(publisher?.content).toContain("ensureWorkingRepository");
    expect(publisher?.content).toContain("class ChildGitPathLock");
    expect(publisher?.content).toContain("constants.O_EXCL | NO_FOLLOW");
    expect(publisher?.content).toContain("assertPrivateRegularSourceTree(sourceRoot)");
    expect(publisher?.content).toContain("metadata.nlink !== 1");
    expect(publisher?.content).not.toContain('"120000"');
    expect(publisher?.content).toContain("renameDirectory");
    expect(publisher?.content).toContain("directory identity changed during rename");
    expect(publisher?.content).toContain(
      'gh",\n            [\n              "repo",\n              "clone"',
    );
    expect(publisher?.content).toContain("Child Git working tree is not clean");
    expect(publisher?.content).toContain("force: false");
    expect(publisher?.content).toContain("RUNTIME_ENVIRONMENT_KEYS");
    expect(publisher?.content).toContain("GIT_ENVIRONMENT_OVERRIDES");
    expect(publisher?.content).toContain("commandEnvironment(command, options.env ?? {})");
    expect(publisher?.content).not.toContain("env: { ...process.env");
    expect(publisher?.content).toContain("assertCredentialFreeBuffer");
    expect(publisher?.content).toContain("credential-store path");
    expect(publisher?.content).toContain("sourceTreeOid(entries)");
    expect(publisher?.content).toContain("ambiguous path");
    expect(publisher?.content).not.toContain("../lib/");
    expect(journey?.ownership).toBe("core_owned");
    expect(playwright?.content).toContain("retries: 0");
    expect(playwright?.content).not.toContain("process.env.CI ? 1 : 0");
    expect(playwright?.content).not.toContain("43127");
    expect(localRunner?.ownership).toBe("core_owned");
    expect(localRunner?.content).toContain('reservation.listen(0, "127.0.0.1")');
    expect(localRunner?.content).toContain("VH_LOCAL_SERVER_NONCE");
    expect(localRunner?.content).toContain("localServerNonce === serverNonce");
    expect(healthRoute?.content).toContain("...(localServerNonce ? { localServerNonce } : {})");
    expect(healthRoute?.content).not.toContain("localServerNonce: null");
    expect(localRunner?.content).toContain("EADDRINUSE");
    expect(localRunner?.content).toContain(
      "Owned local production listener remained after teardown",
    );
    expect(localRunner?.content).toContain("await stopServer(server)");
    expect(localRunner?.content.indexOf('const exited = once(server, "exit")')).toBeLessThan(
      localRunner?.content.indexOf('server.kill("SIGTERM")') ?? -1,
    );
    expect(journey?.content).toContain('method === "GET" || method === "HEAD"');
    expect(journey?.content).toContain("VH_PRIMARY_JOURNEY_OBSERVER_RESULT");
    expect(journey?.content).toContain("venture_harness_primary_journey_v1");
    expect(journey?.content).not.toContain('name: "Review launch status"');
    expect(journey?.content).toContain('link[rel="canonical"]');
    expect(journey?.content).toContain('request.get("/robots.txt"');
    expect(journey?.content).toContain('request.get("/sitemap.xml"');
    expect(journey?.content).toContain('script[type="application/ld+json"]');
    expect(journey?.content).toContain("Unverified rating/review structured data is forbidden");
    expect(journey?.content).toContain("EXPECTED_PUBLIC_ORIGIN");
    expect(journey?.content).not.toMatch(/\.(?:post|put|patch|delete)\s*\(/i);
    const site = compiled.files.find(({ path }) => path === "src/config/site.ts");
    expect(site?.content).toContain("VERCEL_PROJECT_PRODUCTION_URL");
    expect(site?.content).toContain('process.env.VERCEL_ENV === "production"');
    expect(site?.content).toContain('process.env.VERCEL === "1"');
    expect(site?.content).toContain('process.env.NEXT_PUBLIC_INDEXING_ENABLED === "true"');
  });

  it("preflights every exact materialized source buffer before allowing a GitHub call", async () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "vh-materialized-publisher-"));
    const childRoot = resolve(fixtureRoot, "child");
    const fixtureHome = resolve(fixtureRoot, "home");
    const fakeBin = resolve(fixtureRoot, "bin");
    const fakeGh = resolve(fakeBin, "gh");
    const fakeGhLog = resolve(fixtureRoot, "gh-calls.jsonl");
    const canaryPath = resolve(childRoot, "credential-canary.txt");
    const repository = "founder-company/payout-rank";
    try {
      mkdirSync(childRoot, { recursive: true });
      mkdirSync(fixtureHome, { recursive: true });
      mkdirSync(dirname(fakeGh), { recursive: true });
      const compiled = plan("agentic-web-saas");
      const materialized = await materializeVenture(
        compiled,
        new NodeMaterializationFileSystem(childRoot),
        NOW,
      );
      expect(materialized.status).toBe("materialized");

      writeFileSync(
        fakeGh,
        [
          "#!/usr/bin/env node",
          'const { appendFileSync } = require("node:fs");',
          `appendFileSync(${JSON.stringify(fakeGhLog)}, JSON.stringify({`,
          "  args: process.argv.slice(2),",
          "  leakedHostField: process.env.VH_UNREVIEWED_ENV ?? null,",
          "  leakedProviderToken: process.env.GH_TOKEN ?? null,",
          "  gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL ?? null,",
          '}) + "\\n", "utf8");',
          'process.stderr.write("fixture gh stops after recording one call\\n");',
          "process.exit(73);",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(fakeGh, 0o755);

      const unreviewedEnvironmentName = ["VH", "UNREVIEWED", "ENV"].join("_");
      const providerTokenEnvironmentName = ["GH", "TOKEN"].join("_");
      const executePublisher = () =>
        spawnSync(
          process.execPath,
          [
            "--import",
            TSX_IMPORT,
            "scripts/github-publish-source.ts",
            "apply",
            "--repository",
            repository,
            "--visibility",
            "private",
          ],
          {
            cwd: childRoot,
            env: {
              NODE_ENV: "test",
              PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
              HOME: fixtureHome,
              TMPDIR: process.env.TMPDIR ?? tmpdir(),
              LANG: process.env.LANG ?? "C",
              CI: "1",
              [providerTokenEnvironmentName]: [
                "host",
                "only",
                "token",
                "must",
                "not",
                "reach",
                "gh",
              ].join("-"),
              [unreviewedEnvironmentName]: [
                "host",
                "only",
                "field",
                "must",
                "not",
                "reach",
                "gh",
              ].join("-"),
            },
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
          },
        );

      const canaries = [
        ["OpenAI project key", ["sk", "-proj-", "A".repeat(24)].join("")],
        ["fine-grained GitHub token", ["github", "_pat_", "B".repeat(24)].join("")],
        ["Brevo key", ["xkey", "sib-", "C".repeat(24)].join("")],
        ["Stripe webhook secret", ["wh", "sec_", "D".repeat(24)].join("")],
        ["JWT", ["eyJ", "E".repeat(12), ".", "F".repeat(12), ".", "G".repeat(12)].join("")],
        ["bearer token", "Authorization: Bearer " + "H".repeat(24)],
        ["query token", "https://example.invalid/callback?access_token=" + "I".repeat(24)],
        ["labeled generic secret", ["API", "KEY=generic", "secret", "value", "123456"].join("-")],
      ] as const;

      for (const [label, raw] of canaries) {
        writeFileSync(canaryPath, raw, "utf8");
        const result = executePublisher();
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        expect(result.error, label + "\n" + output).toBeUndefined();
        expect(result.status, label + "\n" + output).toBe(1);
        expect(result.stdout, label).toBe("");
        expect(result.stderr, label).toContain("credential-like content");
        expect(result.stderr, label).not.toContain(raw);
        expect(existsSync(fakeGhLog), label).toBe(false);
      }
      unlinkSync(canaryPath);

      const opaqueNpmToken = ["//registry.npmjs.org/:_authToken=npm", "_", "J".repeat(36)].join("");
      writeFileSync(resolve(childRoot, ".npmrc"), opaqueNpmToken, "utf8");
      const credentialStoreResult = executePublisher();
      expect(credentialStoreResult.status).toBe(1);
      expect(credentialStoreResult.stderr).toContain("credential-store path");
      expect(credentialStoreResult.stderr).not.toContain(opaqueNpmToken);
      expect(existsSync(fakeGhLog)).toBe(false);
      unlinkSync(resolve(childRoot, ".npmrc"));

      writeFileSync(
        resolve(childRoot, ".env.example"),
        [
          "DATABASE_URL=REPLACE_WITH_DATABASE_URL",
          "GITHUB_TOKEN_REF=cred://github/source-publication",
          "API_KEY=YOUR_API_KEY",
          "password: [REDACTED]",
          "",
        ].join("\n"),
        "utf8",
      );
      const reviewedPlaceholderResult = executePublisher();
      expect(reviewedPlaceholderResult.status).toBe(1);
      expect(reviewedPlaceholderResult.stderr).toContain("Read GitHub repository failed");
      const calls = readFileSync(fakeGhLog, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              leakedHostField: string | null;
              leakedProviderToken: string | null;
              gitConfigGlobal: string | null;
            },
        );
      expect(calls).toEqual([
        {
          args: ["api", `repos/${repository}`],
          leakedHostField: null,
          leakedProviderToken: null,
          gitConfigGlobal: process.platform === "win32" ? "NUL" : "/dev/null",
        },
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("ships schema-valid launch configs with strict analytics and no credential material", () => {
    const compiled = plan("agentic-web-saas");
    const schemaByPath = {
      "config/venture.yaml": ventureSchema,
      "config/launch.yaml": launchSchema,
      "config/mobile.yaml": mobileSchema,
      "config/analytics.yaml": analyticsSchema,
      "config/loops.yaml": loopsSchema,
      "config/providers.yaml": providersSchema,
      "config/policies.yaml": policiesSchema,
      "config/offer.yaml": offerSchema,
    } as const;

    for (const [path, schema] of Object.entries(schemaByPath)) {
      expect(() => schema.parse(parse(content(compiled, path)))).not.toThrow();
    }

    const providers = providersSchema.parse(parse(content(compiled, "config/providers.yaml")));
    expect(
      Object.values(providers.providers).every(
        (provider) =>
          provider.state === "unconfigured" &&
          provider.credential_ref === null &&
          provider.account_id === null &&
          provider.team_id === null,
      ),
    ).toBe(true);
    const analytics = analyticsSchema.parse(parse(content(compiled, "config/analytics.yaml")));
    expect(analytics.consent.default_mode).toBe("strict");
    expect(analytics.collection).toMatchObject({
      send_form_values_to_analytics: false,
      send_search_text_to_third_parties: false,
      send_email_to_analytics: false,
      session_replay: false,
    });
    expect(analytics.prohibited_properties).toEqual(
      expect.arrayContaining(["email", "name", "message", "search_text", "form_value"]),
    );
    expect(Object.values(analytics.events).flatMap(({ props }) => props)).not.toEqual(
      expect.arrayContaining(["email", "name", "message", "search_text", "form_value"]),
    );
    expect(analytics.providers).toEqual({});
    expect(analytics.events).toEqual({});
    expect(
      (analytics as typeof analytics & { event_packs: { active: string[] } }).event_packs.active,
    ).toEqual([]);
    const venture = ventureSchema.parse(parse(content(compiled, "config/venture.yaml")));
    expect(venture.validation).toMatchObject({
      minimum_days: null,
      target_days: null,
      maximum_days: null,
      primary_conversion: null,
      build_threshold: null,
      stop_threshold: null,
    });
    expect(venture.venture.capabilities.active).toEqual(["public_website"]);
    expect(content(compiled, "config/loops.yaml")).not.toMatch(/enabled:\s+true/u);
    expect(offerSchema.parse(parse(content(compiled, "config/offer.yaml")))).toMatchObject({
      pricing: {
        monthly_price: null,
        annual_price: null,
        one_time_price: null,
        implementation_fee: null,
      },
      economics: { payback_target_days: null },
    });
    expect(content(compiled, ".gitignore")).toContain(".venture/\nreports/\n");
    expect(compiled.lock.managed_files.some(({ path }) => path.startsWith(".venture/"))).toBe(
      false,
    );

    const tracked = compiled.files.map(({ content: value }) => value).join("\n");
    expect(tracked).not.toContain("github-founder-company");
    expect(tracked).not.toContain("founder-user");
    expect(tracked).not.toContain("cred://");
    expect(JSON.parse(content(compiled, "config/connectors.json"))).toEqual({
      schemaVersion: 1,
      ventureId: compiled.manifest.ventureId,
      providers: [
        {
          capability: "source.repository.create",
          provider: "github",
          ownership: "company_owned",
          accountSelection: "runtime_connection_required",
        },
      ],
    });
  });

  it("keeps venture identity and design deterministic while preserving ownership classes", () => {
    const first = plan("agentic-web-saas");
    const replay = plan("agentic-web-saas");
    const second = plan("agentic-web-saas", {
      ventureName: "Signal Foundry",
      ventureSlug: "signal-foundry",
      ideaDigest: "c".repeat(64),
      repository: { owner: "founder-company", name: "signal-foundry", visibility: "public" },
    });

    expect(first.planDigest).toBe(replay.planDigest);
    expect(content(first, "src/design/theme.css")).toBe(content(replay, "src/design/theme.css"));
    expect(content(first, "src/design/theme.css")).not.toBe(
      content(second, "src/design/theme.css"),
    );
    expect(
      ventureSchema.parse(parse(content(second, "config/venture.yaml"))).venture
        .repository_visibility,
    ).toBe("public");
    expect(new Set(first.files.map(({ ownership }) => ownership))).toEqual(
      new Set(["core_owned", "merge_managed", "venture_owned"]),
    );
  });

  it("retains the recursive runtime, ServiceBlueprint, and Agent Surface for hybrid services", () => {
    const compiled = plan("hybrid-agentic-service");

    expect(compiled.seed.serviceRuntime).toBe("recursive");
    expect(compiled.manifest.serviceBlueprints).toEqual(["payout-rank.primary"]);
    expect(compiled.manifest.agentSurface).toMatchObject({
      cli: "payout-rank",
      mcpPrefix: "payout_rank",
      sdkPackage: "@payout-rank/sdk",
      restPrefix: "/v1",
    });
    expect(content(compiled, "runtime/bootstrap.ts")).toContain(
      "recursiveReconcileCommands: [PRIMARY_SERVICE_RECONCILE_COMMAND]",
    );
    expect(JSON.parse(content(compiled, "service-blueprints/primary.json"))).toMatchObject({
      id: "payout-rank.primary",
      commandId: "payout-rank.execute",
    });
  });
});
