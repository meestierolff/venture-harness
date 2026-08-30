import { describe, expect, it } from "vitest";
import {
  collectFounderStackWizard,
  collectRoles,
  collectedCliSessionRoles,
  detectSessions,
  detectStripeSession,
  founderStackConnectionDraftRoles,
  safeCliSessionMetadata,
  type ReadOnlyCliProbeRunner,
} from "@/lib/founder-launch/stack-connect-shell";

class FixtureProbeRunner implements ReadOnlyCliProbeRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];

  constructor(private readonly outputs: Readonly<Record<string, string | null>>) {}

  run(command: string, args: readonly string[]): string | null {
    this.calls.push({ command, args: [...args] });
    return this.outputs[`${command} ${args.join(" ")}`] ?? null;
  }
}

describe("Founder Stack official CLI detection", () => {
  it("uses current default-JSON Stripe GETs and retains only safe test-mode metadata", () => {
    const runner = new FixtureProbeRunner({
      "gh --version": "gh version fixture",
      "gh api user --jq .login": "fixture-founder",
      "vercel --version": "vercel fixture",
      "vercel whoami": "fixture-team",
      "stripe --version": "stripe fixture",
      "stripe get /v1/account": JSON.stringify({
        id: "acct_fixture_test",
        business_profile: { name: "must-not-be-retained" },
        private_settings: { dashboard: "must-not-be-retained" },
      }),
      "stripe get /v1/balance": JSON.stringify({
        livemode: false,
        available: [{ currency: "eur", amount: 0 }],
      }),
    });

    const sessions = detectSessions(runner);
    expect(sessions).toEqual([
      expect.objectContaining({
        provider: "github",
        authenticated: true,
        account: "fixture-founder",
      }),
      expect.objectContaining({ provider: "vercel", authenticated: true, account: "fixture-team" }),
      {
        provider: "stripe",
        installed: true,
        authenticated: true,
        account: "acct_fixture_test",
        mode: "test",
      },
    ]);
    expect(JSON.stringify(sessions)).not.toContain("business_profile");
    expect(JSON.stringify(sessions)).not.toContain("private_settings");
    expect(JSON.stringify(sessions)).not.toContain("available");
    expect(JSON.stringify(sessions)).not.toContain("must-not-be-retained");
    expect(runner.calls).toEqual([
      { command: "gh", args: ["--version"] },
      { command: "gh", args: ["api", "user", "--jq", ".login"] },
      { command: "vercel", args: ["--version"] },
      { command: "vercel", args: ["whoami"] },
      { command: "stripe", args: ["--version"] },
      { command: "stripe", args: ["get", "/v1/account"] },
      { command: "stripe", args: ["get", "/v1/balance"] },
    ]);

    const metadata = safeCliSessionMetadata(sessions, "2026-08-12T10:00:00.000Z");
    expect(metadata.stripe).toEqual({
      installed: true,
      authenticated: true,
      accountId: "acct_fixture_test",
      mode: "test",
      verifiedAt: "2026-08-12T10:00:00.000Z",
    });
    expect(collectedCliSessionRoles(sessions, "founder-default").map(({ role }) => role)).toEqual([
      "source.repository",
      "hosting.web",
    ]);
    expect(
      founderStackConnectionDraftRoles(
        [
          ...collectedCliSessionRoles(sessions, "founder-default"),
          {
            role: "commerce.web",
            credentialRef: "cred://stripe/founder-default",
            identifiers: { accountId: "acct_fixture_test" },
          },
        ],
        sessions,
      ),
    ).toEqual([
      expect.objectContaining({ role: "source.repository", verifiedBy: "official_cli" }),
      expect.objectContaining({ role: "hosting.web", verifiedBy: "official_cli" }),
      expect.not.objectContaining({ role: "commerce.web", verifiedBy: "official_cli" }),
    ]);
  });

  it("never accepts live mode, arbitrary account output, or a missing Stripe CLI", () => {
    const live = new FixtureProbeRunner({
      "stripe --version": "stripe fixture",
      "stripe get /v1/account": JSON.stringify({ id: "acct_fixture_live" }),
      "stripe get /v1/balance": JSON.stringify({ livemode: true }),
    });
    expect(detectStripeSession(live)).toMatchObject({
      provider: "stripe",
      installed: true,
      authenticated: false,
    });

    const unsafe = new FixtureProbeRunner({
      "stripe --version": "stripe fixture",
      "stripe get /v1/account": JSON.stringify({ id: "acct fixture with spaces" }),
      "stripe get /v1/balance": JSON.stringify({ livemode: false }),
    });
    expect(detectStripeSession(unsafe).authenticated).toBe(false);
    expect(detectStripeSession(new FixtureProbeRunner({}))).toMatchObject({
      installed: false,
      authenticated: false,
    });
  });

  it("fails closed on malformed Stripe JSON and non-boolean test-mode evidence", () => {
    const cases = [
      {
        account: "not-json",
        balance: JSON.stringify({ livemode: false }),
      },
      {
        account: JSON.stringify([{ id: "acct_fixture_test" }]),
        balance: JSON.stringify({ livemode: false }),
      },
      {
        account: JSON.stringify({ id: "acct_fixture_test" }),
        balance: JSON.stringify({ livemode: "false" }),
      },
    ];

    for (const fixture of cases) {
      const runner = new FixtureProbeRunner({
        "stripe --version": "stripe fixture",
        "stripe get /v1/account": fixture.account,
        "stripe get /v1/balance": fixture.balance,
      });

      expect(detectStripeSession(runner)).toMatchObject({
        provider: "stripe",
        installed: true,
        authenticated: false,
      });
      expect(runner.calls).toEqual([
        { command: "stripe", args: ["--version"] },
        { command: "stripe", args: ["get", "/v1/account"] },
        { command: "stripe", args: ["get", "/v1/balance"] },
      ]);
    }
  });

  it("stores hidden values only in the credential writer and returns reference-only state", async () => {
    const fixtureValue = "fixture-private-value-never-output";
    const stored: Array<{ reference: string; value: string }> = [];
    const output: string[] = [];
    const result = await collectRoles({
      profileId: "founder-default",
      sessions: [],
      roles: ["source.repository", "commerce.web", "dns.records"],
      identifiers: {
        "commerce.web": { accountId: "acct_fixture_test" },
        "dns.records": {},
      },
      backend: "macos_keychain",
      io: { isTty: true, write: (line) => output.push(line) },
      writer: {
        backendId: "fixture-keychain",
        async store(request) {
          stored.push({ reference: request.reference, value: await request.readValue() });
        },
      },
      async readCredential() {
        return fixtureValue;
      },
    });

    expect(stored).toEqual([{ reference: "cred://stripe/founder-default", value: fixtureValue }]);
    expect(result).toEqual([
      {
        role: "commerce.web",
        credentialRef: "cred://stripe/founder-default",
        identifiers: { accountId: "acct_fixture_test" },
      },
      { role: "dns.records", identifiers: {} },
    ]);
    expect(JSON.stringify({ result, output })).not.toContain(fixtureValue);
  });

  it("guides required web roles, selects only opted-in extras, and never introduces RevenueCat", async () => {
    const visible = ["no", "yes", "no", "fixture-neon-org", "aws-eu-central-1", "123456789"];
    const hidden = ["fixture-neon-secret", "fixture-stripe-secret", "fixture-google-secret"];
    const output: string[] = [];
    const stored: Array<{ provider: string; reference: string; value: string }> = [];
    const result = await collectFounderStackWizard({
      profileId: "founder-default",
      sessions: [
        {
          provider: "stripe",
          installed: true,
          authenticated: true,
          account: "acct_fixture_test",
          mode: "test",
        },
      ],
      backend: "macos_keychain",
      prompt: {
        isTty: true,
        write: (line) => output.push(line),
        readVisible: async () => visible.shift() ?? "",
        readCredential: async () => hidden.shift() ?? "",
      },
      writer: {
        backendId: "macos_keychain",
        async store(request) {
          stored.push({
            provider: request.provider,
            reference: request.reference,
            value: await request.readValue(),
          });
        },
      },
    });

    expect(result.selectedOptionalRoles).toEqual(["growth.google", "dns.records"]);
    expect(result.collected.map(({ role }) => role)).toEqual([
      "database.postgres",
      "commerce.web",
      "growth.google",
    ]);
    expect(stored.map(({ provider }) => provider)).toEqual(["neon", "stripe", "google"]);
    expect(result.launchDefaults).toMatchObject({
      neonRegion: "aws-eu-central-1",
      googleAnalyticsAccountId: "123456789",
    });
    expect(JSON.stringify({ result, output })).not.toContain("fixture-neon-secret");
    expect(JSON.stringify(result)).not.toContain("revenuecat");
  });
});
