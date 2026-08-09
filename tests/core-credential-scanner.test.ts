import { describe, expect, it } from "vitest";
import { assertCredentialFree, findCredentialMaterial } from "../packages/core/src/index";
import { looksLikeCredentialValue } from "../lib/config/contracts";

const credentialFixtures = [
  ["stripe webhook", ["whsec", "secondary_auditboundary123456"].join("_")],
  ["provider API key", ["sk", "projectfixtureboundary1234567890"].join("-")],
  ["Brevo API key", ["xkeysib", "fixture-audit-boundary-123456"].join("-")],
  ["Google API key", `AIza${"FixtureBoundary".repeat(3)}`],
  ["AWS access key", `AKIA${"A1B2C3D4E5F6G7H8"}`],
  ["AWS temporary access key", `ASIA${"A1B2C3D4E5F6G7H8"}`],
] as const;

describe("shared credential scanner", () => {
  it.each(credentialFixtures)(
    "rejects %s material independent of its field name",
    (_label, value) => {
      expect(findCredentialMaterial({ harmlessLabel: value })).toMatchObject({
        kind: "credential_pattern",
        path: "$.harmlessLabel",
      });
      expect(looksLikeCredentialValue(value)).toBe(true);
      expect(() => assertCredentialFree({ harmlessLabel: value }, "fixture boundary")).toThrow(
        /credential-like material/u,
      );
      try {
        assertCredentialFree({ harmlessLabel: value }, "fixture boundary");
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    },
  );

  it("accepts canonical credential references without treating them as values", () => {
    const reference = "cred://stripe/founder-default-webhook";
    expect(findCredentialMaterial(reference)).toBeNull();
    expect(looksLikeCredentialValue(reference)).toBe(false);
    expect(() => assertCredentialFree(reference, "credential reference")).not.toThrow();
  });
});
