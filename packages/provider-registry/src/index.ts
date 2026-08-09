import type { ProviderCapabilityAdapter } from "@venture-harness/provider-sdk";

export interface StackProfile {
  profileId: string;
  providersByCapability: Readonly<Record<string, readonly string[]>>;
}

export class ProviderCapabilityRegistry {
  readonly #adapters = new Map<string, ProviderCapabilityAdapter>();

  register(adapter: ProviderCapabilityAdapter): void {
    if (this.#adapters.has(adapter.providerId))
      throw new Error(`provider already registered: ${adapter.providerId}`);
    this.#adapters.set(adapter.providerId, adapter);
  }

  resolve(capability: string, profile: StackProfile): ProviderCapabilityAdapter {
    const candidates = profile.providersByCapability[capability] ?? [];
    for (const providerId of candidates) {
      const adapter = this.#adapters.get(providerId);
      if (adapter?.capabilities.some(({ id }) => id === capability)) return adapter;
    }
    throw new Error(`no provider in ${profile.profileId} implements ${capability}`);
  }

  providers(): string[] {
    return [...this.#adapters.keys()].sort();
  }
}
