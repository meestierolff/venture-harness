/**
 * The shipped config files must satisfy their own schemas — the template
 * always starts green.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  authorizationEnvelopeSchema,
  configSchemas,
  harnessLockSchema,
  loadHarnessLock,
  providersSchema,
  qualitySchema,
} from "@/lib/config/schemas";
import { createDefaultProvidersConfig } from "@/lib/config/provider-schema";

describe("config contracts", () => {
  for (const [file, schema] of Object.entries(configSchemas)) {
    it(`${file} validates`, () => {
      const parsed = schema.safeParse(parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      expect(parsed.success).toBe(true);
    });
  }

  it("harness.lock validates", () => {
    expect(loadHarnessLock("harness.lock")).toMatchObject({
      harness_version: "0.2.0",
      config_contract_version: 2,
    });
    expect(harnessLockSchema.safeParse(parse(readFileSync("harness.lock", "utf8"))).success).toBe(
      true,
    );
  });

  it("accepts namespaced extensions but rejects unknown provider fields", () => {
    const config = createDefaultProvidersConfig();
    config.extensions = { "x.example": { enabled: true } };
    expect(providersSchema.safeParse(config).success).toBe(true);
    expect(
      providersSchema.safeParse({
        ...config,
        unexpected_root_field: true,
      }).success,
    ).toBe(false);
  });

  it("rejects credential values even when hidden in extensions", () => {
    const config = createDefaultProvidersConfig();
    config.providers.github.credential_ref = "cred://github/default";
    config.providers.github.extensions = {
      nested: { access_token: "ghp_" + "123456789012345678901234567890" },
    };
    const parsed = providersSchema.safeParse(config);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /credential value/.test(issue.message))).toBe(
        true,
      );
    }
  });

  it("rejects unknown quality fields and unresolved check references", () => {
    const config = parse(readFileSync("config/quality.yaml", "utf8")) as Record<string, unknown>;
    expect(qualitySchema.safeParse({ ...config, typo_checkz: {} }).success).toBe(false);
    expect(
      qualitySchema.safeParse({
        ...config,
        profiles: {
          ...(config.profiles as Record<string, unknown>),
          fast: {
            ...((config.profiles as Record<string, Record<string, unknown>>).fast ?? {}),
            checks: ["not_a_declared_check"],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("validates bounded authorization envelopes", () => {
    const base = {
      run_id: "run-001-test",
      profile: "standard_launch",
      allowed_capabilities: ["public_website"],
      allowed_side_effect_classes: ["production_deploy"],
      providers: ["vercel"],
      environments: ["production"],
      issued_at: "2026-08-04T10:00:00.000Z",
      expires_at: "2026-08-04T12:00:00.000Z",
      max_estimated_spend: { amount: 0, currency: "EUR" },
      max_email_recipients: 0,
      production_deploy_allowed: true,
      live_products_and_prices_allowed: false,
      actual_charges_allowed: false,
      transactional_test_email_allowed: false,
      dns_additions_allowed: false,
      nameserver_changes_allowed: false,
      app_store_submission_allowed: false,
      explicitly_forbidden_actions: ["customer_charge"],
      approval_ref: "founder-prompt-001",
      extensions: {},
    };
    expect(authorizationEnvelopeSchema.safeParse(base).success).toBe(true);
    expect(
      authorizationEnvelopeSchema.safeParse({
        ...base,
        expires_at: "2026-08-04T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
