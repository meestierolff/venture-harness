import { describe, expect, it } from "vitest";
import {
  FOUNDER_STACK_PLAN,
  assertNoSecretsInArgv,
  assertReferenceOnly,
  blockingActions,
  credentialRefFor,
  planFounderStackConnection,
  type CollectedRole,
  type DetectedSession,
} from "@/lib/founder-launch/stack-connect";

const sessions: DetectedSession[] = [
  { provider: "github", authenticated: true, account: "founder" },
  { provider: "vercel", authenticated: true, account: "founder-team" },
];

function collected(overrides: Partial<Record<string, CollectedRole>> = {}): CollectedRole[] {
  const base: CollectedRole[] = [
    {
      role: "source.repository",
      credentialRef: credentialRefFor("github", "founder-default"),
      identifiers: { accountId: "founder", organizationId: "founder" },
    },
    {
      role: "hosting.web",
      credentialRef: credentialRefFor("vercel", "founder-default"),
      identifiers: { accountId: "acct", teamId: "team" },
    },
    {
      role: "database.postgres",
      credentialRef: credentialRefFor("neon", "founder-default"),
      identifiers: { accountId: "neon-acct", organizationId: "neon-org" },
    },
    {
      role: "commerce.web",
      credentialRef: credentialRefFor("stripe", "founder-default"),
      identifiers: { accountId: "stripe-acct" },
    },
  ];
  return base.map((entry) => (overrides[entry.role] as CollectedRole | undefined) ?? entry);
}

describe("founder stack connect planning", () => {
  it("refuses a credential value anywhere in argv", () => {
    // Arguments are visible in the process table and shell history, so a value
    // passed this way must be treated as already exposed.
    for (const argument of [
      "sk_test_SYNTHETICNOTAREALa",
      "sk_live_SYNTHETICNOTAREALb",
      "xkeysib-SYNTHETICNOTAREALc",
      "ghp_SYNTHETICNOTAREALd",
      "napi_SYNTHETICNOTAREALe",
      "--token=SYNTHETICNOTAREALf",
    ]) {
      expect(() => assertNoSecretsInArgv(["stack", "connect", argument])).toThrow(
        /never accepts a credential value as an argument/,
      );
    }
  });

  it("accepts references and ordinary arguments", () => {
    expect(() =>
      assertNoSecretsInArgv([
        "stack",
        "connect",
        "founder-default",
        "cred://stripe/founder-default",
      ]),
    ).not.toThrow();
    expect(() => assertReferenceOnly("cred://neon/founder-default", "x")).not.toThrow();
    expect(() => assertReferenceOnly("napi_realvalue", "database.postgres credentialRef")).toThrow(
      /must be a cred:\/\/ reference/,
    );
  });

  it("treats the default web rail roles as launch-blocking and the rest as optional", () => {
    const required = FOUNDER_STACK_PLAN.filter((entry) => entry.required).map(
      (entry) => entry.role,
    );
    expect(required).toEqual([
      "source.repository",
      "hosting.web",
      "database.postgres",
      "commerce.web",
    ]);
    // Native commerce is modelled but is not part of the default web launch.
    expect(FOUNDER_STACK_PLAN.find((entry) => entry.role === "commerce.native")?.required).toBe(
      false,
    );
  });

  it("reports launch-ready when every required role has a reference and identifiers", () => {
    const plan = planFounderStackConnection({
      profileId: "founder-default",
      ownerOrganizationId: "founder-org",
      sessions,
      collected: collected(),
    });
    expect(plan.launchReady).toBe(true);
    expect(plan.resolved).toEqual([
      "source.repository",
      "hosting.web",
      "database.postgres",
      "commerce.web",
    ]);
    // Optional roles are still reported, with an exact command and no block.
    expect(blockingActions(plan)).toEqual([]);
    expect(plan.unresolved.map((action) => action.role)).toContain("email.transactional");
    for (const action of plan.unresolved) {
      expect(action.command.length).toBeGreaterThan(5);
      expect(action.why.length).toBeGreaterThan(5);
    }
  });

  it("blocks the launch and names the login command when a CLI session is missing", () => {
    const plan = planFounderStackConnection({
      profileId: "founder-default",
      ownerOrganizationId: "founder-org",
      sessions: [{ provider: "vercel", authenticated: true }],
      collected: collected(),
    });
    expect(plan.launchReady).toBe(false);
    const github = blockingActions(plan).find((action) => action.provider === "github");
    expect(github?.command).toBe("gh auth login");
    expect(plan.resolved).not.toContain("source.repository");
  });

  it("blocks the launch when a required identifier is missing and names it exactly", () => {
    const plan = planFounderStackConnection({
      profileId: "founder-default",
      ownerOrganizationId: "founder-org",
      sessions,
      collected: collected({
        "database.postgres": {
          role: "database.postgres",
          credentialRef: credentialRefFor("neon", "founder-default"),
          identifiers: { accountId: "neon-acct", organizationId: "  " },
        },
      }),
    });
    expect(plan.launchReady).toBe(false);
    const neon = blockingActions(plan).find((action) => action.provider === "neon");
    expect(neon?.why).toContain("organizationId");
  });

  it("refuses a plan that records a credential value instead of a reference", () => {
    expect(() =>
      planFounderStackConnection({
        profileId: "founder-default",
        ownerOrganizationId: "founder-org",
        sessions,
        collected: collected({
          "commerce.web": {
            role: "commerce.web",
            credentialRef: "sk_test_SYNTHETICNOTAREALg",
            identifiers: { accountId: "stripe-acct" },
          },
        }),
      }),
    ).toThrow(/must be a cred:\/\/ reference/);
  });
});
