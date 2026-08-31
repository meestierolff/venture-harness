import { describe, expect, it } from "vitest";
import {
  compileLaunchGraph,
  founderBriefSchema,
  requiredCapabilitiesForLaunch,
  requiredEnvironmentsForLaunch,
  scopeLaunchGraphForAuthorization,
} from "@/lib/launch";
import { parse } from "yaml";
import { readFileSync } from "node:fs";

function graph(fixture: string) {
  const brief = founderBriefSchema.parse(
    parse(readFileSync(`fixtures/${fixture}/brief.yaml`, "utf8")),
  );
  return compileLaunchGraph(brief);
}

describe("authorization-scoped launch graphs", () => {
  it("keeps build-local bounded to product work and a report", () => {
    const scoped = scopeLaunchGraphForAuthorization(graph("web-saas"), "build-local");
    expect(scoped.nodes.some(({ kind }) => kind === "provider" || kind === "manual_action")).toBe(
      false,
    );
    expect(scoped.nodes.find(({ id }) => id === "launch-report")?.dependencies).toEqual([
      "verify-local",
    ]);
    expect(scoped.nodes.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "verify-seed-typecheck",
        "verify-seed-build",
        "verify-seed-readonly",
        "verify-seed-tests",
      ]),
    );
    expect(requiredEnvironmentsForLaunch(scoped)).toEqual(["local"]);
  });

  it("keeps preview launch to local work, GitHub, and preview Vercel", () => {
    const scoped = scopeLaunchGraphForAuthorization(graph("web-saas"), "preview-launch");
    const providers = scoped.nodes
      .filter(({ kind }) => kind === "provider")
      .map(({ id }) => id)
      .sort();
    expect(providers).toEqual(["github-repository", "vercel-project"]);
    expect(scoped.nodes.some(({ id }) => id === "production-deploy")).toBe(false);
    expect(scoped.nodes.some(({ id }) => id === "verify-production")).toBe(false);
    expect(scoped.nodes.some(({ kind }) => kind === "manual_action")).toBe(false);
    expect(requiredEnvironmentsForLaunch(scoped)).toEqual(["local", "preview"]);
    expect(requiredCapabilitiesForLaunch(scoped)).toEqual(["deployment", "project", "repository"]);
    expect(requiredCapabilitiesForLaunch(scoped)).not.toContain("*");
  });

  it("preserves the full graph only for matching full-launch profiles", () => {
    const web = scopeLaunchGraphForAuthorization(graph("web-saas"), "standard-launch");
    expect(web.nodes.some(({ id }) => id === "production-deploy")).toBe(true);
    expect(requiredEnvironmentsForLaunch(web)).toEqual(["local", "test", "preview", "production"]);
    expect(() =>
      scopeLaunchGraphForAuthorization(graph("ios-subscription"), "standard-launch"),
    ).toThrow(/does not authorize the mobile rail/);
    expect(() => scopeLaunchGraphForAuthorization(graph("web-saas"), "mobile-testflight")).toThrow(
      /does not match a web-only rail/,
    );
  });
});
