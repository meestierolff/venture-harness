export type RetryClass =
  | "retryable_rate_limit"
  | "retryable_outage"
  | "retryable_network"
  | "terminal_auth"
  | "terminal_validation"
  | "terminal_conflict"
  | "terminal_unknown";

export interface RetryDecision {
  retryable: boolean;
  classification: RetryClass;
  suggestedDelayMs?: number;
}

const OUTAGE_CODES = new Set([408, 425, 500, 502, 503, 504]);

export function classifyProviderFailure(input: {
  statusCode?: number;
  retryAfter?: string;
  networkError?: boolean;
}): RetryDecision {
  if (input.networkError) {
    return { retryable: true, classification: "retryable_network" };
  }
  if (input.statusCode === 429) {
    const seconds = Number(input.retryAfter);
    return {
      retryable: true,
      classification: "retryable_rate_limit",
      suggestedDelayMs: Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined,
    };
  }
  if (input.statusCode !== undefined && OUTAGE_CODES.has(input.statusCode)) {
    return { retryable: true, classification: "retryable_outage" };
  }
  if (input.statusCode === 401 || input.statusCode === 403) {
    return { retryable: false, classification: "terminal_auth" };
  }
  if (
    input.statusCode === 400 ||
    input.statusCode === 404 ||
    input.statusCode === 405 ||
    input.statusCode === 422
  ) {
    return { retryable: false, classification: "terminal_validation" };
  }
  if (input.statusCode === 409) {
    return { retryable: false, classification: "terminal_conflict" };
  }
  return { retryable: false, classification: "terminal_unknown" };
}
