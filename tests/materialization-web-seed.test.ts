import { readFileSync } from "node:fs";
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
  type LaunchGrantInput,
  type SeedId,
} from "@/lib/materialization";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const WORKFLOW_SHA = "a".repeat(40);

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
          }>;
        };
      };
    };

    expect(caller.jobs.verify.uses).toBe(
      `meestierolff/venture-harness/.github/workflows/venture-verify.yml@${WORKFLOW_SHA}`,
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
      "pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts --prod=false",
    );
    expect(steps.find(({ name }) => name === "Verify child fast profile")?.run).toBe(
      "pnpm verify:fast",
    );
  });

  it("materializes an independently installable and buildable Next.js repository shape", () => {
    const compiled = plan("agentic-web-saas");
    const packageJson = JSON.parse(content(compiled, "package.json")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      dev: "next dev",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      test: "node --test tests/*.test.mjs",
      "test:e2e:readonly": "playwright test tests/e2e/post-deploy-readonly.spec.ts",
      verify: "pnpm typecheck && pnpm test && pnpm build",
      "verify:fast": "pnpm typecheck && pnpm test",
      "verify:mvp": "pnpm verify:fast && pnpm build && pnpm test:e2e:readonly",
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
        "scripts/github-publish-source.ts",
        "tests/seed-contract.test.mjs",
        "tests/e2e/post-deploy-readonly.spec.ts",
        "migrations/sql/001_core_evidence.up.sql",
        "migrations/sql/001_core_evidence.down.sql",
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
    expect(content(compiled, "migrations/sql/001_core_evidence.up.sql")).toContain(
      "values ('001_core_evidence')",
    );
    expect(content(compiled, "migrations/sql/001_core_evidence.up.sql")).toContain(
      "create table if not exists analytics_sync_runs",
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
  });

  it("materializes the exact child-local publisher and read-only journey contracts", () => {
    const compiled = plan("agentic-web-saas");
    const publisher = compiled.files.find(
      ({ path }) => path === "scripts/github-publish-source.ts",
    );
    const journey = compiled.files.find(
      ({ path }) => path === "tests/e2e/post-deploy-readonly.spec.ts",
    );

    expect(publisher?.ownership).toBe("core_owned");
    expect(publisher?.content).toContain(
      "Expected apply or verify; no provider operation was attempted",
    );
    expect(publisher?.content).toContain("refusing to overwrite it");
    expect(publisher?.content).toContain('"--object-format=sha1"');
    expect(publisher?.content).toContain('const BOOTSTRAP_PATH = ".venture-harness-bootstrap"');
    expect(publisher?.content).toContain("parents: [parentCommitOid]");
    expect(publisher?.content).toContain('method: "PATCH"');
    expect(publisher?.content).not.toContain("../lib/");
    expect(journey?.ownership).toBe("venture_owned");
    expect(journey?.content).toContain('method === "GET" || method === "HEAD"');
    expect(journey?.content).toContain('name: "Review launch status"');
    expect(journey?.content).toContain('link[rel="canonical"]');
    expect(journey?.content).toContain('request.get("/robots.txt"');
    expect(journey?.content).toContain('request.get("/sitemap.xml"');
    expect(journey?.content).toContain("EXPECTED_PUBLIC_ORIGIN");
    expect(journey?.content).not.toMatch(/\.(?:post|put|patch|delete)\s*\(/i);
    const site = compiled.files.find(({ path }) => path === "src/config/site.ts");
    expect(site?.content).toContain("VERCEL_PROJECT_PRODUCTION_URL");
    expect(site?.content).toContain('process.env.VERCEL_ENV === "production"');
    expect(site?.content).toContain('process.env.VERCEL === "1"');
  });

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
