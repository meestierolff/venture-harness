import type { AuthorizationProfileId } from "../authorization";
import { defineWorkflow, type WorkflowDefinition } from "../workflow";

type LaunchEnvironment = "local" | "test" | "preview" | "production";

const PREVIEW_PROVIDER_NODES = new Set(["github-repository", "vercel-project"]);
const PRODUCTION_JOURNEY_NODES = new Set(["verify-production", "verify-custom-domain"]);

function canonicalProfile(profile: string): AuthorizationProfileId {
  const canonical = profile.replaceAll("-", "_") as AuthorizationProfileId;
  if (
    ![
      "read_only",
      "build_local",
      "preview_launch",
      "standard_launch",
      "live_commerce_launch",
      "mobile_testflight",
      "autofix_low_risk",
    ].includes(canonical)
  ) {
    throw new Error(`Unknown authorization profile ${profile}.`);
  }
  return canonical;
}

function isMobile(definition: WorkflowDefinition): boolean {
  return definition.metadata?.appKind !== "web";
}

/**
 * Narrows a compiled launch graph before a run exists. A narrower envelope
 * never starts a full graph and then discovers production nodes halfway
 * through execution.
 */
export function scopeLaunchGraphForAuthorization(
  definition: WorkflowDefinition,
  requestedProfile: string,
): WorkflowDefinition {
  const profile = canonicalProfile(requestedProfile);
  if (profile === "read_only" || profile === "autofix_low_risk") {
    throw new Error(
      `${profile} cannot apply a launch. Use vh plan or vh launch --dry-run, or choose build-local, preview-launch, standard-launch, live-commerce-launch, or mobile-testflight.`,
    );
  }
  const mobile = isMobile(definition);
  if (mobile && profile !== "mobile_testflight" && profile !== "build_local") {
    throw new Error(
      `${profile} does not authorize the mobile rail. Use build-local for repository-only work or mobile-testflight for the compiled iOS/TestFlight graph.`,
    );
  }
  if (!mobile && profile === "mobile_testflight") {
    throw new Error(
      "mobile_testflight does not match a web-only rail. Use build-local, preview-launch, standard-launch, or live-commerce-launch.",
    );
  }

  const keep = (node: WorkflowDefinition["nodes"][number]): boolean => {
    if (profile === "build_local") {
      return (
        node.id === "launch-report" ||
        (node.kind !== "provider" &&
          node.kind !== "manual_action" &&
          node.id !== "verify-launch" &&
          !PRODUCTION_JOURNEY_NODES.has(node.id))
      );
    }
    if (profile === "preview_launch") {
      return (
        node.id === "launch-report" ||
        node.id === "verify-launch" ||
        ((node.kind === "code" || node.kind === "model") &&
          !PRODUCTION_JOURNEY_NODES.has(node.id)) ||
        PREVIEW_PROVIDER_NODES.has(node.id)
      );
    }
    return true;
  };

  const selected = definition.nodes.filter(keep);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const nodes = selected.map((node) => {
    const dependencies = node.dependencies.filter((dependency) => selectedIds.has(dependency));
    if (node.id === "launch-report") {
      return {
        ...node,
        dependencies:
          profile === "build_local"
            ? ["verify-local"]
            : profile === "preview_launch"
              ? ["verify-launch"]
              : dependencies,
      };
    }
    return { ...node, dependencies };
  });

  return defineWorkflow({
    ...definition,
    nodes,
    metadata: {
      ...(definition.metadata ?? {}),
      authorizationProfile: profile,
      launchScope:
        profile === "build_local" ? "local" : profile === "preview_launch" ? "preview" : "full",
    },
  });
}

function nodeEnvironment(nodeId: string): LaunchEnvironment {
  if (
    [
      "stripe-commerce",
      "stripe-callbacks",
      "stripe-domain-callbacks",
      "revenuecat-entitlements",
    ].includes(nodeId)
  ) {
    return "test";
  }
  if (
    [
      "dns-records",
      "apple-first-app-record",
      "eas-build",
      "eas-submit",
      "testflight-state",
      "initial-production-deploy",
      "analytics-production-redeploy",
      "email-production-redeploy",
      "production-deploy",
    ].includes(nodeId) ||
    (nodeId.startsWith("vercel-") && nodeId.endsWith("-environment"))
  ) {
    return "production";
  }
  return "preview";
}

export function requiredEnvironmentsForLaunch(definition: WorkflowDefinition): LaunchEnvironment[] {
  const environments = new Set<LaunchEnvironment>();
  for (const node of definition.nodes) {
    if (node.kind === "provider" || node.kind === "manual_action") {
      environments.add(nodeEnvironment(node.id));
    } else {
      environments.add("local");
    }
  }
  const order: LaunchEnvironment[] = ["local", "test", "preview", "production"];
  return order.filter((environment) => environments.has(environment));
}

/** Exact provider-operation capability ceiling declared by the scoped graph. */
export function requiredCapabilitiesForLaunch(definition: WorkflowDefinition): string[] {
  return [
    ...new Set(
      definition.nodes
        .filter((node) => node.authorization.required)
        .flatMap((node) => node.authorization.scopes),
    ),
  ].sort();
}
