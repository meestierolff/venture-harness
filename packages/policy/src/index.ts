import type { CommandExecutionContext } from "@venture-harness/core";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export function decideScopes(
  context: CommandExecutionContext,
  requiredScopes: readonly string[],
): PolicyDecision {
  const missing = requiredScopes.filter((scope) => !context.scopes.includes(scope));
  return missing.length === 0
    ? { allowed: true, reason: "all declared scopes are present" }
    : { allowed: false, reason: `missing actor scopes: ${missing.join(", ")}` };
}
