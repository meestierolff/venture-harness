import type { PackInstallationState, PackManifest } from "./types";

function pack(
  id: PackManifest["id"],
  input: Partial<Omit<PackManifest, "id" | "version" | "coreCompatibility" | "uninstall">>,
): PackManifest {
  return Object.freeze({
    id,
    version: "0.2.0",
    coreCompatibility: "^0.2.0",
    capabilities: Object.freeze(input.capabilities ?? []),
    serviceBlueprints: Object.freeze(input.serviceBlueprints ?? []),
    commands: Object.freeze(input.commands ?? []),
    events: Object.freeze(input.events ?? []),
    migrations: Object.freeze(input.migrations ?? []),
    providers: Object.freeze(input.providers ?? []),
    evaluations: Object.freeze(input.evaluations ?? []),
    loops: Object.freeze(input.loops ?? []),
    uiContributions: Object.freeze(input.uiContributions ?? []),
    uninstall: id === "winner-loop" ? "preserve_evidence" : "reversible_if_unused",
  });
}

export const PACKS: Readonly<Record<PackManifest["id"], PackManifest>> = Object.freeze({
  "validate-first": pack("validate-first", {
    capabilities: ["experiments.manage", "analytics.events.write"],
    serviceBlueprints: ["validation.run"],
    commands: ["validation.plan", "validation.evaluate"],
    events: ["validation.hypothesis.created", "validation.decision.recorded"],
    migrations: ["pack-validate-first-001"],
    evaluations: ["validation-thresholds"],
    loops: ["early-signals"],
    uiContributions: ["validation-dashboard"],
  }),
  "ship-to-users": pack("ship-to-users", {
    capabilities: ["hosting.web.deploy", "source.repository.write"],
    serviceBlueprints: ["launch.execute"],
    commands: ["launch.execute"],
    events: ["launch.verified"],
    migrations: ["pack-ship-to-users-001"],
    providers: ["github", "vercel", "neon"],
    evaluations: ["primary-journey"],
    loops: ["launch-verification"],
    uiContributions: ["launch-status"],
  }),
  "distribution-pr": pack("distribution-pr", {
    capabilities: ["distribution.content.publish", "distribution.content.metrics.read"],
    serviceBlueprints: ["distribution.campaign"],
    commands: ["campaigns.launch", "learnings.ingest"],
    events: ["distribution.learning.received"],
    migrations: ["pack-distribution-pr-001"],
    providers: ["postiz", "zernio"],
    evaluations: ["distribution-evidence"],
    loops: ["weekly-distribution"],
    uiContributions: ["campaign-evidence"],
  }),
  "winner-loop": pack("winner-loop", {
    capabilities: [
      "distribution.content.publish",
      "distribution.content.metrics.read",
      "ads.organic_post.boost",
      "ads.insights.read",
      "subscription.lifecycle.read",
    ],
    serviceBlueprints: ["winner-loop.evaluate", "winner-loop.paid-test"],
    commands: ["winner-loop.publish", "winner-loop.evaluate", "winner-loop.propose-paid-test"],
    events: [
      "winner-loop.creative.published",
      "winner-loop.metrics.observed",
      "winner-loop.recommendation.created",
    ],
    migrations: ["pack-winner-loop-001"],
    providers: ["tiktok", "revenuecat", "attribution"],
    evaluations: ["baseline-adjusted-winner", "optimization-readiness"],
    loops: ["winner-metric-snapshots", "creative-fatigue"],
    uiContributions: ["creative-lineage", "spend-approval"],
  }),
  "web-saas": pack("web-saas", {
    capabilities: ["commerce.web_subscription", "email.transactional"],
    serviceBlueprints: ["subscription.web"],
    commands: ["subscriptions.manage"],
    events: ["subscription.changed"],
    migrations: ["pack-web-saas-001"],
    providers: ["stripe", "brevo"],
    loops: ["subscription-reconciliation"],
    uiContributions: ["billing-portal"],
  }),
  "ios-subscription": pack("ios-subscription", {
    capabilities: ["commerce.native_subscription", "subscription.lifecycle.read"],
    serviceBlueprints: ["subscription.ios"],
    commands: ["entitlements.refresh"],
    events: ["subscription.lifecycle.received"],
    migrations: ["pack-ios-subscription-001"],
    providers: ["revenuecat", "app-store-connect"],
    evaluations: ["subscriber-cohorts"],
    loops: ["subscription-reconciliation"],
    uiContributions: ["entitlement-status"],
  }),
});

export function emptyPackInstallationState(): PackInstallationState {
  return Object.freeze({
    installed: Object.freeze({}),
    capabilities: Object.freeze([]),
    serviceBlueprints: Object.freeze([]),
    commands: Object.freeze([]),
    events: Object.freeze([]),
    migrations: Object.freeze([]),
    providers: Object.freeze([]),
    evaluations: Object.freeze([]),
    loops: Object.freeze([]),
    uiContributions: Object.freeze([]),
  });
}

function union(left: readonly string[], right: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...left, ...right])].sort());
}

export function installPack(
  state: PackInstallationState,
  manifest: PackManifest,
  coreVersion: string,
): { status: "installed" | "already_installed"; state: PackInstallationState } {
  if (!manifest.coreCompatibility.startsWith(`^${coreVersion.split(".")[0]}.`)) {
    throw new Error(`${manifest.id}@${manifest.version} is incompatible with Core ${coreVersion}`);
  }
  const installedVersion = state.installed[manifest.id];
  if (installedVersion) {
    if (installedVersion !== manifest.version) {
      throw new Error(
        `${manifest.id} is installed at ${installedVersion}; use an explicit pack upgrade`,
      );
    }
    return { status: "already_installed", state };
  }
  return {
    status: "installed",
    state: Object.freeze({
      installed: Object.freeze({ ...state.installed, [manifest.id]: manifest.version }),
      capabilities: union(state.capabilities, manifest.capabilities),
      serviceBlueprints: union(state.serviceBlueprints, manifest.serviceBlueprints),
      commands: union(state.commands, manifest.commands),
      events: union(state.events, manifest.events),
      migrations: union(state.migrations, manifest.migrations),
      providers: union(state.providers, manifest.providers),
      evaluations: union(state.evaluations, manifest.evaluations),
      loops: union(state.loops, manifest.loops),
      uiContributions: union(state.uiContributions, manifest.uiContributions),
    }),
  };
}

export function uninstallPack(_state: PackInstallationState, manifest: PackManifest): never {
  throw new Error(
    manifest.uninstall === "preserve_evidence"
      ? `${manifest.id} evidence must be preserved; archive through a migration before uninstall`
      : `${manifest.id} uninstall requires a dependency-aware migration plan`,
  );
}
