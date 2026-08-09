import { describe, expect, it } from "vitest";
import {
  StackProfileError,
  founderDefaultStackProfile,
  genericDnsStackProfile,
  planStackCapabilityDryRun,
  providerStackProfiles,
  resolveStackCapability,
  stackCapabilityContracts,
  validateStackProfile,
  type ProviderStackProfile,
  type StackProfileErrorCode,
} from "@/lib/providers";

function profileWithBindings(bindings: Record<string, unknown>): ProviderStackProfile {
  return {
    ...founderDefaultStackProfile,
    bindings,
  } as unknown as ProviderStackProfile;
}

function expectProfileError(action: () => unknown, code: StackProfileErrorCode): void {
  try {
    action();
    throw new Error("Expected StackProfileError");
  } catch (error) {
    expect(error).toBeInstanceOf(StackProfileError);
    expect((error as StackProfileError).code).toBe(code);
  }
}

const dnsDryRunRequest = {
  environment: "production" as const,
  inputs: {
    zone: "example.test",
    recordType: "TXT",
    recordName: "_verify",
    recordValue: "fixture-verification-value",
    ttl: 300,
  },
};

describe("provider Stack Profiles", () => {
  it("validates the typed founder-default profile against registered adapters", () => {
    expect(validateStackProfile(founderDefaultStackProfile)).toBe(founderDefaultStackProfile);
    expect(Object.keys(founderDefaultStackProfile.bindings).sort()).toEqual(
      Object.keys(stackCapabilityContracts).sort(),
    );
    expect(founderDefaultStackProfile).toMatchObject({
      profileId: "founder-default",
      version: "0.2.0",
      verification: "local_contract_only",
      bindings: {
        "source.repository.create": { providerId: "github", capability: "repository" },
        "hosting.web.deploy": { providerId: "vercel", capability: "deployment" },
        "database.postgres.provision": { providerId: "neon", capability: "project" },
        "commerce.web_subscription": { providerId: "stripe", capability: "product" },
        "commerce.native_subscription": {
          providerId: "revenuecat",
          capability: "entitlement",
        },
        "email.transactional": { providerId: "brevo", capability: "template" },
        "dns.record": { providerId: "mijndomein", capability: "record" },
      },
    });
  });

  it("ships a complete genuine alternative that selects the generic DNS adapter", () => {
    expect(providerStackProfiles).toHaveLength(2);
    expect(validateStackProfile(genericDnsStackProfile)).toBe(genericDnsStackProfile);
    expect(resolveStackCapability(founderDefaultStackProfile, "dns.record").providerId).toBe(
      "mijndomein",
    );
    expect(resolveStackCapability(genericDnsStackProfile, "dns.record")).toMatchObject({
      profileId: "founder-default-generic-dns",
      role: "dns.record",
      providerId: "dns",
      capability: "record",
    });

    for (const role of Object.keys(stackCapabilityContracts) as Array<
      keyof typeof stackCapabilityContracts
    >) {
      if (role === "dns.record") continue;
      expect(genericDnsStackProfile.bindings[role]).toEqual(
        founderDefaultStackProfile.bindings[role],
      );
    }
  });

  it("resolves the same profile and role deterministically", () => {
    const first = resolveStackCapability(genericDnsStackProfile, "dns.record");
    const second = resolveStackCapability(genericDnsStackProfile, "dns.record");

    expect(second).toEqual(first);
    expect(second.adapter).toBe(first.adapter);
    expect(second.adapter.descriptor.id).toBe("dns");
    expect(second.adapter.descriptor.capabilities).toContain("record");
  });

  it("builds type-complete dry-run plans through both selected real adapters", () => {
    const founder = planStackCapabilityDryRun(
      founderDefaultStackProfile,
      "dns.record",
      dnsDryRunRequest,
    );
    const alternative = planStackCapabilityDryRun(
      genericDnsStackProfile,
      "dns.record",
      dnsDryRunRequest,
    );

    expect(founder.plan).toMatchObject({
      provider: "mijndomein",
      environment: "production",
      dryRun: true,
      operations: [
        {
          provider: "mijndomein",
          capability: "record",
          transport: "manual",
          manual: {
            system: "MijnDomein control panel",
            requiredFields: dnsDryRunRequest.inputs,
          },
        },
      ],
    });
    expect(alternative.plan).toMatchObject({
      provider: "dns",
      environment: "production",
      dryRun: true,
      operations: [
        {
          provider: "dns",
          capability: "record",
          transport: "manual",
          manual: {
            system: "DNS control panel",
            requiredFields: dnsDryRunRequest.inputs,
          },
        },
      ],
    });
    expect(alternative.plan.operations[0]).toMatchObject({
      id: expect.stringMatching(/^dns\./),
      idempotencyKey: expect.stringMatching(/^dns:production:/),
      verification: { strategy: "manual" },
    });

    const replay = planStackCapabilityDryRun(
      genericDnsStackProfile,
      "dns.record",
      dnsDryRunRequest,
    );
    expect(replay.plan.id).toBe(alternative.plan.id);
    expect(replay.plan.operations).toEqual(alternative.plan.operations);
  });

  it("fails closed for missing and unknown profile roles", () => {
    const missingDns = Object.fromEntries(
      Object.entries(founderDefaultStackProfile.bindings).filter(([role]) => role !== "dns.record"),
    );
    expectProfileError(() => validateStackProfile(profileWithBindings(missingDns)), "missing_role");
    expectProfileError(
      () =>
        validateStackProfile(
          profileWithBindings({
            ...founderDefaultStackProfile.bindings,
            "unknown.capability": founderDefaultStackProfile.bindings["dns.record"],
          }),
        ),
      "unknown_role",
    );
  });

  it("rejects unknown providers and providers that do not implement the role capability", () => {
    expectProfileError(
      () =>
        validateStackProfile(
          profileWithBindings({
            ...founderDefaultStackProfile.bindings,
            "dns.record": {
              ...founderDefaultStackProfile.bindings["dns.record"],
              providerId: "unregistered_dns",
            },
          }),
        ),
      "provider_not_registered",
    );
    expectProfileError(
      () =>
        validateStackProfile(
          profileWithBindings({
            ...founderDefaultStackProfile.bindings,
            "dns.record": {
              ...founderDefaultStackProfile.bindings["dns.record"],
              providerId: "github",
            },
          }),
        ),
      "capability_not_implemented",
    );
  });

  it("rejects a concrete capability that does not match its provider-neutral role", () => {
    expectProfileError(
      () =>
        validateStackProfile(
          profileWithBindings({
            ...founderDefaultStackProfile.bindings,
            "dns.record": {
              providerId: "mijndomein",
              capability: "domain_attachment",
              rationale: "Invalid fixture",
            },
          }),
        ),
      "role_capability_mismatch",
    );
  });
});
