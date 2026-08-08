import { z } from "zod";

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "expected semantic version");

export const appKindSchema = z.enum(["web", "mobile_ios", "mobile_cross_platform", "hybrid"]);

export const launchModeSchema = z.enum([
  "validate_first",
  "thin_mvp",
  "product_first",
  "concierge_first",
]);

export const mobileStackSchema = z.enum(["none", "expo_react_native", "swiftui", "auto"]);

export const knownCapabilityIdSchema = z.enum([
  "public_website",
  "authenticated_product",
  "database",
  "file_storage",
  "transactional_email",
  "lifecycle_email",
  "stripe",
  "revenuecat",
  "ga4",
  "gsc",
  "bing_webmaster",
  "vercel_analytics",
  "web_seo_aeo_geo",
  "ios_aso",
  "feedback_intake",
  "scheduled_learning_loops",
  "app_store_connect",
  "eas",
]);

export const openCapabilityIdSchema = z
  .string()
  .regex(
    /^x\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'open capability IDs must be namespaced, for example "x.vendor.capability"',
  );

export const capabilityIdSchema = z.union([knownCapabilityIdSchema, openCapabilityIdSchema]);

export const providerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "expected a stable provider ID");

export const extensionsSchema = z.record(z.unknown()).default({});

function unique<T>(values: T[]): boolean {
  return new Set(values).size === values.length;
}

export function uniqueArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).refine(unique, "values must be unique");
}

const FORBIDDEN_CREDENTIAL_KEY =
  /^(access_token|refresh_token|id_token|api_key|secret|client_secret|private_key|password|credential_value)$/i;

const CREDENTIAL_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^sk_(?:live|test)_[A-Za-z0-9]{12,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /^postgres(?:ql)?:\/\/[^\s:/]+:[^\s@]+@/,
];

export function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function rejectCredentialMaterial(value: unknown, ctx: z.RefinementCtx): void {
  const visit = (candidate: unknown, path: (string | number)[]) => {
    if (typeof candidate === "string") {
      if (looksLikeCredentialValue(candidate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "credential values are forbidden; store only a credential_ref",
        });
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, entry] of Object.entries(candidate)) {
      const entryPath = [...path, key];
      if (FORBIDDEN_CREDENTIAL_KEY.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: entryPath,
          message: "credential value fields are forbidden; use credential_ref",
        });
      } else {
        visit(entry, entryPath);
      }
    }
  };
  visit(value, []);
}

export const credentialReferenceSchema = z
  .string()
  .min(3)
  .max(300)
  .regex(
    /^cred:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    "credential_ref must use a logical cred:// reference and contain no credential value",
  )
  .refine(
    (value) => !looksLikeCredentialValue(value),
    "credential_ref contains credential material",
  );

export const artifactReferenceSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "artifact references must be repository-relative without parent traversal",
  });

export type CapabilityId = z.infer<typeof capabilityIdSchema>;
