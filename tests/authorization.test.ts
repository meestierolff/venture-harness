import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  assertOperationAuthorized,
  consumeOneShotCheckpointGrant,
  issueOneShotCheckpointGrant,
  issueAuthorizationEnvelope,
} from "@/lib/authorization";
import { createDefaultPoliciesConfig } from "@/lib/config/policy-schema";
import { getProviderAdapter, type ProviderOperation } from "@/lib/providers";
import { providerPlanFixtures } from "./fixtures/provider/requests";

const policies = createDefaultPoliciesConfig();
const now = new Date("2026-08-04T12:00:00.000Z");

function operation(overrides: Partial<ProviderOperation> = {}): ProviderOperation {
  return {
    id: "github.repository.create",
    provider: "github",
    capability: "public_website",
    action: "repository.create",
    title: "Create a repository",
    transport: "cli",
    environment: "preview",
    riskClass: "medium",
    effectClass: "reversible_external",
    reversibility: "conditionally_reversible",
    idempotencyKey: "github:repository:create",
    dependsOn: [],
    command: { binary: "gh", args: ["repo", "create", "example"] },
    verification: { strategy: "read_back", description: "read repository metadata" },
    ...overrides,
  };
}

function authorizationCode(run: () => void): AuthorizationError["code"] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationError);
    return (error as AuthorizationError).code;
  }
  throw new Error("Expected authorization to fail");
}

describe("session authorization", () => {
  it("normalizes the documented profile name and issues a bounded run envelope", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-synthetic-web",
      profile: "standard-launch",
      providers: ["github"],
      environments: ["preview"],
      capabilities: ["repository", "public_website", "deployment", "repository"],
      policies,
      approvalRef: "cli:--authorization=standard-launch",
      now,
      ttlMs: 10_000,
    });
    expect(envelope.profile).toBe("standard_launch");
    expect(envelope.allowed_capabilities).toEqual(["deployment", "public_website", "repository"]);
    expect(envelope.expires_at).toBe("2026-08-04T12:00:10.000Z");
    expect(() => assertOperationAuthorized(envelope, operation(), policies, now)).not.toThrow();
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({ action: "repository.create_from_source" }),
        policies,
        now,
      ),
    ).not.toThrow();
  });

  it("rejects providers and effects outside the envelope", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-synthetic-web",
      profile: "preview_launch",
      providers: ["github"],
      environments: ["preview"],
      policies,
      approvalRef: "test",
      now,
    });
    expect(() =>
      assertOperationAuthorized(envelope, operation({ provider: "stripe" }), policies, now),
    ).toThrow(AuthorizationError);
    const productionEnvelope = issueAuthorizationEnvelope({
      runId: "launch-synthetic-web",
      profile: "standard_launch",
      providers: ["github"],
      environments: ["test", "production"],
      policies,
      approvalRef: "test",
      now,
    });
    expect(() =>
      assertOperationAuthorized(
        productionEnvelope,
        operation({
          action: "payment_intent.charge",
          effectClass: "financial",
          environment: "production",
        }),
        policies,
        now,
      ),
    ).toThrow(/distinct human checkpoint/);
  });

  it("expires envelopes instead of treating a CLI flag as permanent consent", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-synthetic-web",
      profile: "standard_launch",
      providers: ["github"],
      environments: ["preview"],
      policies,
      approvalRef: "test",
      now,
      ttlMs: 1,
    });
    expect(() =>
      assertOperationAuthorized(envelope, operation(), policies, new Date(now.getTime() + 2)),
    ).toThrow(/expired/);
  });

  it("allows critical TestFlight build work but keeps publication behind a distinct checkpoint", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-synthetic-ios",
      profile: "mobile-testflight",
      providers: ["eas", "app_store_connect", "revenuecat"],
      environments: ["test", "production"],
      policies,
      approvalRef: "test:mobile-testflight",
      now,
    });
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({
          provider: "eas",
          capability: "ios_build",
          action: "ios.build",
          environment: "testflight",
          riskClass: "critical",
        }),
        policies,
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({
          provider: "eas",
          capability: "production_deploy",
          action: "deployment.production",
          environment: "production",
          riskClass: "critical",
        }),
        policies,
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({
          provider: "revenuecat",
          capability: "app",
          action: "app.create",
          environment: "sandbox",
          effectClass: "financial",
          riskClass: "critical",
        }),
        policies,
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({
          provider: "app_store_connect",
          capability: "app_store_publication",
          action: "app_store.release",
          environment: "testflight",
          riskClass: "critical",
        }),
        policies,
        now,
      ),
    ).toThrow(/distinct human checkpoint/);
  });

  it("enforces effect-specific booleans even when the side-effect list contains the action", () => {
    const standard = issueAuthorizationEnvelope({
      runId: "launch-boolean-standard",
      profile: "standard-launch",
      providers: ["vercel", "brevo", "dns"],
      environments: ["preview", "production"],
      policies,
      approvalRef: "test:boolean-standard",
      now,
    });
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          { ...standard, production_deploy_allowed: false },
          operation({
            provider: "vercel",
            capability: "deployment",
            action: "deployment.production",
            environment: "production",
            riskClass: "high",
          }),
          policies,
          now,
        ),
      ),
    ).toBe("permission_flag_required");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          { ...standard, transactional_test_email_allowed: false },
          operation({
            provider: "brevo",
            capability: "transactional_email",
            action: "transactional_email.send",
            effectClass: "communication",
            emailRecipientCount: 1,
          }),
          policies,
          now,
        ),
      ),
    ).toBe("permission_flag_required");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          { ...standard, dns_additions_allowed: false },
          operation({
            provider: "dns",
            capability: "record",
            action: "dns_record.change_manual",
            effectClass: "manual",
            transport: "manual",
          }),
          policies,
          now,
        ),
      ),
    ).toBe("permission_flag_required");

    const commerce = issueAuthorizationEnvelope({
      runId: "launch-boolean-commerce",
      profile: "live-commerce-launch",
      providers: ["stripe"],
      environments: ["production"],
      policies,
      approvalRef: "test:boolean-commerce",
      now,
    });
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          { ...commerce, live_products_and_prices_allowed: false },
          operation({
            provider: "stripe",
            capability: "price",
            action: "price.create",
            environment: "production",
            effectClass: "financial",
            riskClass: "high",
          }),
          policies,
          now,
        ),
      ),
    ).toBe("permission_flag_required");
  });

  it("enforces declared spend amount and currency against the run ceiling", () => {
    const issued = issueAuthorizationEnvelope({
      runId: "launch-spend-ceiling",
      profile: "standard-launch",
      providers: ["github"],
      environments: ["preview"],
      policies,
      approvalRef: "test:spend",
      now,
    });
    const envelope = {
      ...issued,
      max_estimated_spend: { amount: 10, currency: "EUR" },
    };
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({ estimatedCost: { amount: 10, currency: "EUR" } }),
        policies,
        now,
      ),
    ).not.toThrow();
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({ estimatedCost: { amount: 11, currency: "EUR" } }),
          policies,
          now,
        ),
      ),
    ).toBe("spend_limit_exceeded");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({ estimatedCost: { amount: 1, currency: "USD" } }),
          policies,
          now,
        ),
      ),
    ).toBe("spend_currency_mismatch");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({ estimatedCost: { amount: 1, currency: "eur" } }),
          policies,
          now,
        ),
      ),
    ).toBe("spend_estimate_invalid");
  });

  it("rejects unknown-cost external writes unless the envelope explicitly permits them", () => {
    const issued = issueAuthorizationEnvelope({
      runId: "launch-unknown-cost",
      profile: "standard-launch",
      providers: ["github"],
      environments: ["preview"],
      policies,
      approvalRef: "test:unknown-cost",
      now,
    });
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          { ...issued, unknown_external_costs_allowed: false },
          operation(),
          policies,
          now,
        ),
      ),
    ).toBe("spend_estimate_required");
    expect(() =>
      assertOperationAuthorized(
        { ...issued, unknown_external_costs_allowed: true },
        operation(),
        policies,
        now,
      ),
    ).not.toThrow();
  });

  it("requires an exact recipient count and enforces its ceiling", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-email-ceiling",
      profile: "standard-launch",
      providers: ["brevo"],
      environments: ["preview"],
      policies,
      approvalRef: "test:email",
      now,
    });
    const email = {
      provider: "brevo" as const,
      capability: "transactional_email",
      action: "transactional_email.send",
      effectClass: "communication" as const,
    };
    expect(
      authorizationCode(() => assertOperationAuthorized(envelope, operation(email), policies, now)),
    ).toBe("recipient_count_required");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({ ...email, emailRecipientCount: 2 }),
          policies,
          now,
        ),
      ),
    ).toBe("recipient_limit_exceeded");
    expect(() =>
      assertOperationAuthorized(
        envelope,
        operation({ ...email, emailRecipientCount: 1 }),
        policies,
        now,
      ),
    ).not.toThrow();
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({
            ...email,
            action: "sender.create",
            emailRecipientCount: 1,
          }),
          policies,
          now,
        ),
      ),
    ).toBe("operation_effect_mismatch");
  });

  it("rejects action/effect mismatches and unknown irreversible actions", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-effect-contract",
      profile: "live-commerce-launch",
      providers: ["github", "stripe"],
      environments: ["preview", "production"],
      policies,
      approvalRef: "test:effect-contract",
      now,
    });
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({ action: "repository.create", effectClass: "read" }),
          policies,
          now,
        ),
      ),
    ).toBe("operation_effect_mismatch");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({
            provider: "stripe",
            capability: "price",
            action: "price.create",
            environment: "production",
            effectClass: "reversible_external",
          }),
          policies,
          now,
        ),
      ),
    ).toBe("operation_effect_mismatch");
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(
          envelope,
          operation({ action: "opaque.commit", effectClass: "irreversible_external" }),
          policies,
          now,
        ),
      ),
    ).toBe("operation_effect_unknown");
  });

  it("classifies secret metadata and TestFlight submission without treating them as deletion", () => {
    const standard = issueAuthorizationEnvelope({
      runId: "launch-secret-metadata",
      profile: "standard-launch",
      providers: ["github"],
      environments: ["preview"],
      policies,
      approvalRef: "test:secret-metadata",
      now,
    });
    expect(() =>
      assertOperationAuthorized(
        standard,
        operation({
          capability: "actions_secret",
          action: "actions_secret.set",
          effectClass: "reversible_external",
          riskClass: "high",
        }),
        policies,
        now,
      ),
    ).not.toThrow();

    const mobile = issueAuthorizationEnvelope({
      runId: "launch-ios-submission",
      profile: "mobile-testflight",
      providers: ["eas"],
      environments: ["production"],
      policies,
      approvalRef: "test:ios-submission",
      now,
    });
    expect(() =>
      assertOperationAuthorized(
        mobile,
        operation({
          provider: "eas",
          capability: "ios_submit",
          action: "ios.submit",
          environment: "testflight",
          riskClass: "critical",
          effectClass: "irreversible_external",
        }),
        policies,
        now,
      ),
    ).not.toThrow();
  });

  it("keeps delete, destructive data, nameserver, charge, bulk-send, and publication actions distinct", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-distinct-effects",
      profile: "live-commerce-launch",
      providers: ["github", "neon", "dns", "stripe", "brevo", "app_store_connect"],
      environments: ["production"],
      policies,
      approvalRef: "test:distinct-effects",
      now,
    });
    const distinctOperations: Partial<ProviderOperation>[] = [
      { action: "repository.delete", effectClass: "irreversible_external" },
      {
        provider: "neon",
        action: "schema.drop",
        effectClass: "irreversible_external",
      },
      {
        provider: "dns",
        action: "nameserver.replace_manual",
        effectClass: "manual",
        transport: "manual",
      },
      {
        provider: "stripe",
        action: "payment_intent.charge",
        effectClass: "financial",
      },
      {
        provider: "brevo",
        action: "campaign.send",
        effectClass: "communication",
        emailRecipientCount: 10,
      },
      {
        provider: "app_store_connect",
        action: "app_store.release",
        effectClass: "irreversible_external",
      },
    ];
    for (const candidate of distinctOperations) {
      expect(
        authorizationCode(() =>
          assertOperationAuthorized(
            envelope,
            operation({ ...candidate, environment: "production", riskClass: "critical" }),
            policies,
            now,
          ),
        ),
      ).toBe("distinct_checkpoint_required");
    }
  });

  it("accepts only an exact, consumed, one-shot grant for a distinct effect", () => {
    const envelope = issueAuthorizationEnvelope({
      runId: "launch-delete-checkpoint",
      profile: "live-commerce-launch",
      providers: ["github"],
      environments: ["production"],
      policies,
      approvalRef: "test:delete-checkpoint",
      now,
    });
    const destructiveOperation = operation({
      id: "github.repository.delete.fixture",
      action: "repository.delete",
      environment: "production",
      riskClass: "critical",
      effectClass: "irreversible_external",
      reversibility: "irreversible",
    });
    const issued = issueOneShotCheckpointGrant({
      grantId: "checkpoint-0123456789abcdef",
      scope: {
        runId: envelope.run_id,
        nodeId: "delete-repository",
        effect: "external_delete",
        operationId: destructiveOperation.id,
      },
      approvedBy: "founder@example.test",
      approvedAt: now.toISOString(),
      evidenceArtifact:
        "reports/launch/launch-delete-checkpoint/checkpoints/delete-repository.json",
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    expect(
      authorizationCode(() =>
        assertOperationAuthorized(envelope, destructiveOperation, policies, now, {
          nodeId: "delete-repository",
          checkpointGrant: issued,
        }),
      ),
    ).toBe("checkpoint_grant_invalid");

    const consumed = consumeOneShotCheckpointGrant(issued, {
      scope: {
        runId: envelope.run_id,
        nodeId: "delete-repository",
        effect: "external_delete",
        operationId: destructiveOperation.id,
      },
      attempt: 1,
      now: now.toISOString(),
    });
    expect(() =>
      assertOperationAuthorized(envelope, destructiveOperation, policies, now, {
        nodeId: "delete-repository",
        checkpointGrant: consumed,
      }),
    ).not.toThrow();
    expect(
      authorizationCode(() =>
        assertOperationAuthorized(envelope, destructiveOperation, policies, now, {
          nodeId: "different-node",
          checkpointGrant: consumed,
        }),
      ),
    ).toBe("checkpoint_grant_invalid");
  });

  it("classifies every documented provider-plan operation under its bounded launch profile", () => {
    for (const [provider, request] of Object.entries(providerPlanFixtures)) {
      const profile = ["app_store_connect", "eas"].includes(provider)
        ? "mobile-testflight"
        : "live-commerce-launch";
      const envelope = issueAuthorizationEnvelope({
        runId: `launch-plan-${provider.replaceAll("_", "-")}`,
        profile,
        providers: [provider],
        environments: ["local", "test", "preview", "production"],
        policies,
        approvalRef: `test:plan:${provider}`,
        now,
      });
      const plan = getProviderAdapter(provider as keyof typeof providerPlanFixtures).plan(request);
      for (const plannedOperation of plan.operations) {
        expect(() =>
          assertOperationAuthorized(envelope, plannedOperation, policies, now),
        ).not.toThrow();
      }
    }
  });

  it("authorizes the normal non-commerce web vertical slice under standard-launch", () => {
    for (const provider of [
      "github",
      "vercel",
      "neon",
      "brevo",
      "google",
      "bing",
      "dns",
    ] as const) {
      const envelope = issueAuthorizationEnvelope({
        runId: `launch-standard-${provider}`,
        profile: "standard-launch",
        providers: [provider],
        environments: ["local", "test", "preview", "production"],
        policies,
        approvalRef: `test:standard:${provider}`,
        now,
      });
      const plan = getProviderAdapter(provider).plan(providerPlanFixtures[provider]);
      for (const plannedOperation of plan.operations) {
        expect(() =>
          assertOperationAuthorized(envelope, plannedOperation, policies, now),
        ).not.toThrow();
      }
    }
  });

  it("allows Stripe sandbox setup when live commerce and charges are explicitly disabled", () => {
    const issued = issueAuthorizationEnvelope({
      runId: "launch-stripe-test-only",
      profile: "live-commerce-launch",
      providers: ["stripe"],
      environments: ["test"],
      policies,
      approvalRef: "test:stripe-test-only",
      now,
    });
    const envelope = {
      ...issued,
      live_products_and_prices_allowed: false,
      actual_charges_allowed: false,
    };
    const plan = getProviderAdapter("stripe").plan(providerPlanFixtures.stripe);

    expect(plan.operations.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "product.create",
        "price.create",
        "webhook_endpoint.create",
        "billing_portal.configuration.create",
      ]),
    );
    for (const plannedOperation of plan.operations) {
      expect(plannedOperation.environment).toBe("sandbox");
      expect(() =>
        assertOperationAuthorized(envelope, plannedOperation, policies, now),
      ).not.toThrow();
    }
  });
});
