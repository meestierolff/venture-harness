import { describe, expect, it } from "vitest";
import {
  adoptLegacyTenantPayload,
  assertAddressableTenantScope,
  createTrustedLegacyTenantAdoptionMapping,
  resolveLegacyTenantAdoptions,
  type TrustedLegacyTenantAdoptionMapping,
} from "@/lib/winner-loop";

const APPROVED_AT = "2026-08-09T12:00:00.000Z";

function mapping(
  mappings = [
    {
      legacyVentureId: "legacy-venture",
      organizationId: "org-adopted",
      ventureId: "venture-adopted",
    },
  ],
) {
  return createTrustedLegacyTenantAdoptionMapping({
    ownershipVerification: "verified_out_of_band",
    authorizationDisposition: "invalidate_and_require_reapproval",
    approvedBy: "migration-operator",
    approvedAt: APPROVED_AT,
    mappings,
  });
}

describe("trusted legacy tenant adoption contract", () => {
  it("requires a complete explicit source mapping", () => {
    expect(() =>
      resolveLegacyTenantAdoptions(["legacy-venture"], undefined, "test store"),
    ).toThrowError(expect.objectContaining({ code: "legacy_tenant_mapping_required" }) as never);
    expect(() =>
      resolveLegacyTenantAdoptions(
        ["legacy-one", "legacy-two"],
        mapping([
          {
            legacyVentureId: "legacy-one",
            organizationId: "org-one",
            ventureId: "venture-one",
          },
        ]),
        "test store",
      ),
    ).toThrowError(expect.objectContaining({ code: "legacy_tenant_mapping_incomplete" }) as never);
  });

  it("rejects forged contract versions and non-injective mappings", () => {
    const valid = mapping();
    expect(() =>
      resolveLegacyTenantAdoptions(
        ["legacy-venture"],
        { ...valid, contractVersion: 2 } as unknown as TrustedLegacyTenantAdoptionMapping,
        "test store",
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_legacy_tenant_mapping" }) as never);
    expect(() =>
      mapping([
        {
          legacyVentureId: "legacy-one",
          organizationId: "org-one",
          ventureId: "venture-one",
        },
        {
          legacyVentureId: "legacy-one",
          organizationId: "org-two",
          ventureId: "venture-two",
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "invalid_legacy_tenant_mapping" }) as never);
    expect(() =>
      mapping([
        {
          legacyVentureId: "legacy-one",
          organizationId: "org-target",
          ventureId: "venture-target",
        },
        {
          legacyVentureId: "legacy-two",
          organizationId: "org-target",
          ventureId: "venture-target",
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: "invalid_legacy_tenant_mapping" }) as never);
  });

  it.each(["2026-08-09", "2026-08-09T12:00:00Z", "not-a-date"])(
    "rejects a non-canonical approval timestamp (%s)",
    (approvedAt) => {
      expect(() =>
        createTrustedLegacyTenantAdoptionMapping({
          ownershipVerification: "verified_out_of_band",
          authorizationDisposition: "invalidate_and_require_reapproval",
          approvedBy: "migration-operator",
          approvedAt,
          mappings: [
            {
              legacyVentureId: "legacy-venture",
              organizationId: "org-adopted",
              ventureId: "venture-adopted",
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_legacy_tenant_mapping" }) as never);
    },
  );

  it.each([
    [" legacy-venture", "org-target", "venture-target", "operator"],
    ["legacy/venture", "org-target", "venture-target", "operator"],
    ["legacy\nventure", "org-target", "venture-target", "operator"],
    ["legacy-venture", "org:target", "venture-target", "operator"],
    ["legacy-venture", "org-target", "venture target", "operator"],
    ["legacy-venture", "org-target", "venture-target", "operator/admin"],
  ])(
    "rejects non-canonical durable ids (%s, %s, %s, %s)",
    (legacyVentureId, organizationId, ventureId, approvedBy) => {
      expect(() =>
        createTrustedLegacyTenantAdoptionMapping({
          ownershipVerification: "verified_out_of_band",
          authorizationDisposition: "invalidate_and_require_reapproval",
          approvedBy,
          approvedAt: APPROVED_AT,
          mappings: [{ legacyVentureId, organizationId, ventureId }],
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_legacy_tenant_mapping" }) as never);
    },
  );

  it.each([
    ["approver", { approvedBy: "whsec_approver_canary" }],
    [
      "legacy venture id",
      {
        mappings: [
          { legacyVentureId: "whsec_legacy_canary", organizationId: "org", ventureId: "venture" },
        ],
      },
    ],
    [
      "target organization id",
      {
        mappings: [
          {
            legacyVentureId: "legacy",
            organizationId: "whsec_organization_canary",
            ventureId: "venture",
          },
        ],
      },
    ],
    [
      "target venture id",
      {
        mappings: [
          { legacyVentureId: "legacy", organizationId: "org", ventureId: "whsec_venture_canary" },
        ],
      },
    ],
  ])("rejects and redacts credential-like %s material", (_label, override) => {
    const input = {
      ownershipVerification: "verified_out_of_band" as const,
      authorizationDisposition: "invalidate_and_require_reapproval" as const,
      approvedBy: "migration-operator",
      approvedAt: APPROVED_AT,
      mappings: [
        {
          legacyVentureId: "legacy-venture",
          organizationId: "org-adopted",
          ventureId: "venture-adopted",
        },
      ],
      ...override,
    };
    let failure: unknown;
    try {
      createTrustedLegacyTenantAdoptionMapping(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_legacy_tenant_mapping" });
    expect((failure as Error).message).toMatch(/credential-like material/i);
    expect((failure as Error).message).not.toContain("whsec_");
  });

  it("forbids sentinel access and rewrites embedded tenant identity", () => {
    expect(() =>
      assertAddressableTenantScope(
        { organizationId: "__legacy_unscoped__", ventureId: "legacy-venture" },
        "test store",
      ),
    ).toThrowError(expect.objectContaining({ code: "legacy_sentinel_scope_forbidden" }) as never);
    expect(
      adoptLegacyTenantPayload(
        {
          organization_id: "old-org",
          ventureId: "legacy-venture",
          nested: [{ organizationId: "old-org", venture_id: "legacy-venture" }],
        },
        { organizationId: "org-adopted", ventureId: "venture-adopted" },
      ),
    ).toEqual({
      organization_id: "org-adopted",
      organizationId: "org-adopted",
      ventureId: "venture-adopted",
      nested: [{ organizationId: "org-adopted", venture_id: "venture-adopted" }],
    });
  });
});
