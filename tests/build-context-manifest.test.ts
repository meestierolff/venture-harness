import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContextManifestSchema,
  createBuildContextManifest,
} from "@/lib/runtime/build-context-manifest";
import { founderBriefSchema } from "@/lib/launch";
import { launchDecisionFromContract } from "@/lib/founder-launch";
import { launchReceiptContract } from "./fixtures/launch-receipt-contract";
import { parse } from "yaml";

const webBrief = parse(readFileSync("fixtures/web-saas/brief.yaml", "utf8"));

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("build context manifest", () => {
  it("selects only compact contract, product, and capability context", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-context-"));
    roots.push(root);
    for (const directory of [
      "config",
      "docs/product",
      "app",
      "docs/plans/active",
      "skills/design-director/references",
      "skills",
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    const files: Record<string, string> = {
      "config/launch-contract.yaml": "schemaVersion: 1\n",
      "config/analytics.yaml": "schema_version: 1\n",
      "config/seo.yaml": "schema_version: 1\n",
      "config/offer.yaml": "schema_version: 1\n",
      "docs/product/PRODUCT_CONSTITUTION.md": "# Constitution\n",
      "docs/product/PRODUCT_TRUTH.md": "# Truth\n",
      "PROJECT.md": "# Project\n",
      "AGENTS.md": "# Agents\n",
      "package.json": "{}\n",
      "skills/design-director/SKILL.md": "# Design director\n",
      "skills/design-director/references/originality-audit.md": "# Originality\n",
      "app/page.tsx": "export default function Page() { return null; }\n",
      "docs/plans/active/old-plan.md": "should not load\n",
      "skills/winner-loop.md": "should not load\n",
    };
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);

    const manifest = createBuildContextManifest({
      rootDir: root,
      brief: founderBriefSchema.parse(webBrief),
      runId: "launch-context",
      nodeId: "prepare-repository",
    });

    expect(() => buildContextManifestSchema.parse(manifest)).not.toThrow();
    expect(manifest.selectedFiles.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "PROJECT.md",
        "app/page.tsx",
        "config/analytics.yaml",
        "config/launch-contract.yaml",
        "config/offer.yaml",
        "config/seo.yaml",
        "docs/product/PRODUCT_CONSTITUTION.md",
        "docs/product/PRODUCT_TRUTH.md",
        "skills/design-director/SKILL.md",
        "skills/design-director/references/originality-audit.md",
      ]),
    );
    expect(manifest.selectedFiles.map(({ path }) => path)).not.toEqual(
      expect.arrayContaining(["docs/plans/active/old-plan.md", "skills/winner-loop.md"]),
    );
    expect(manifest.excludedOptionalPacks).toEqual(
      expect.arrayContaining(["Winner Loop", "RevenueCat", "iOS and TestFlight"]),
    );
    expect(manifest.estimatedTotalTokens).toBeGreaterThan(0);
    expect(manifest.estimatedTotalTokens).toBeLessThanOrEqual(manifest.tokenCap);
    expect(manifest.selectionTruncated).toBe(false);
  });

  it("stays valid for a minimal seed without universal docs", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-context-empty-"));
    roots.push(root);
    const manifest = createBuildContextManifest({
      rootDir: root,
      brief: founderBriefSchema.parse(webBrief),
      runId: "launch-empty",
      nodeId: "review-product",
    });

    expect(manifest.selectedFiles).toEqual([]);
    expect(manifest.estimatedTotalTokens).toBe(0);
    expect(manifest.selectionTruncated).toBe(false);
  });

  it("fails closed when a reviewed Launch Contract task lacks canonical context", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-context-contract-missing-"));
    roots.push(root);
    const contract = launchReceiptContract();
    const decision = launchDecisionFromContract(contract);

    expect(() =>
      createBuildContextManifest({
        rootDir: root,
        brief: founderBriefSchema.parse(webBrief),
        runId: "launch-contract-missing",
        nodeId: "prepare-repository",
        capabilitiesRequired: decision.capabilities,
        paymentProvider: decision.payment.provider,
        requireCanonicalContract: true,
        agentNative: contract.agentNative,
      }),
    ).toThrow(/Required Launch Contract build context is missing/);
  });

  it("rejects a symlink in required canonical context instead of silently omitting it", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-context-contract-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "vh-context-contract-outside-"));
    roots.push(root, outside);
    for (const directory of ["config", "docs/product", "skills/design-director/references"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(outside, "contract.yaml"), "schemaVersion: 1\n");
    symlinkSync(join(outside, "contract.yaml"), join(root, "config/launch-contract.yaml"));
    for (const [path, content] of Object.entries({
      "docs/product/PRODUCT_CONSTITUTION.md": "# Constitution\n",
      "PROJECT.md": "# Project\n",
      "AGENTS.md": "# Agents\n",
      "skills/design-director/SKILL.md": "# Skill\n",
      "skills/design-director/references/originality-audit.md": "# Audit\n",
    })) {
      writeFileSync(join(root, path), content);
    }

    expect(() =>
      createBuildContextManifest({
        rootDir: root,
        brief: founderBriefSchema.parse(webBrief),
        runId: "launch-contract-symlink",
        nodeId: "prepare-repository",
        requireCanonicalContract: true,
      }),
    ).toThrow(/Required Launch Contract build context is missing/);
  });

  it("enforces the cumulative token cap without dropping required contract context", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-context-cap-"));
    roots.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app/a.ts"), "a".repeat(120));
    writeFileSync(join(root, "app/b.ts"), "b".repeat(120));

    const manifest = createBuildContextManifest({
      rootDir: root,
      brief: founderBriefSchema.parse(webBrief),
      runId: "launch-capped",
      nodeId: "prepare-repository",
      tokenCap: 30,
    });

    expect(manifest.estimatedTotalTokens).toBeLessThanOrEqual(30);
    expect(manifest.selectedFiles).toHaveLength(1);
    expect(manifest.selectionTruncated).toBe(true);
    expect(manifest.omittedFileCount).toBe(1);
  });
});
