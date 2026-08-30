/**
 * Consent state machine — strict mode by default (config/analytics.yaml).
 * Storage is injectable for tests; the browser uses localStorage.
 */
export type ConsentState = "unset" | "accepted" | "declined";

export interface ConsentStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const CONSENT_STORAGE_KEY = "vh-consent";
export const CONSENT_CHANGE_EVENT = "vh-consent-change";

export function consentStateFromStoredValue(value: string | null): ConsentState {
  return value === "accepted" || value === "declined" ? value : "unset";
}

function browserStorage(): ConsentStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
    };
  } catch {
    return null; // storage blocked → treat as unset, never as accepted
  }
}

export function getConsent(storage: ConsentStorage | null = browserStorage()): ConsentState {
  if (!storage) return "unset";
  try {
    return consentStateFromStoredValue(storage.get(CONSENT_STORAGE_KEY));
  } catch {
    return "unset";
  }
}

/**
 * Transition consent. Returns the {from, to} pair so callers can record
 * the consent_changed / consent_withdrawn events (first-party only).
 */
export function setConsent(
  to: Exclude<ConsentState, "unset">,
  storage: ConsentStorage | null = browserStorage(),
): { from: ConsentState; to: ConsentState; withdrawal: boolean } {
  const from = getConsent(storage);
  try {
    storage?.set(CONSENT_STORAGE_KEY, to);
  } catch {
    // Explicit consent can update this tab, but blocked persistence must not
    // turn into an implicit stored grant. A reload therefore returns unset.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGE_EVENT, { detail: { from, to } }));
  }
  return { from, to, withdrawal: from === "accepted" && to === "declined" };
}

export function hasAnalyticsConsent(storage: ConsentStorage | null = browserStorage()): boolean {
  return getConsent(storage) === "accepted";
}
