export function assertEntitlements(
  actual: readonly string[],
  required: readonly string[],
): readonly string[] {
  const missing = required.filter((entitlement) => !actual.includes(entitlement));
  if (missing.length) throw new Error(`missing entitlements: ${missing.join(", ")}`);
  return actual;
}
