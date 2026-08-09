import { DeclarativeProviderAdapter } from "./adapter";
import { providerDescriptors } from "./descriptors";
import {
  buildAppStoreConnectPlan,
  buildBingPlan,
  buildBrevoPlan,
  buildDnsPlan,
  buildEasPlan,
  buildGitHubPlan,
  buildGooglePlan,
  buildMijnDomeinPlan,
  buildNeonPlan,
  buildRevenueCatPlan,
  buildStripePlan,
  buildVercelPlan,
} from "./plans";
import type { ProviderAdapter, ProviderId } from "./types";

const adapters: Readonly<Record<ProviderId, ProviderAdapter>> = {
  github: new DeclarativeProviderAdapter(providerDescriptors.github, buildGitHubPlan),
  vercel: new DeclarativeProviderAdapter(providerDescriptors.vercel, buildVercelPlan),
  neon: new DeclarativeProviderAdapter(providerDescriptors.neon, buildNeonPlan),
  stripe: new DeclarativeProviderAdapter(providerDescriptors.stripe, buildStripePlan),
  revenuecat: new DeclarativeProviderAdapter(providerDescriptors.revenuecat, buildRevenueCatPlan),
  brevo: new DeclarativeProviderAdapter(providerDescriptors.brevo, buildBrevoPlan),
  google: new DeclarativeProviderAdapter(providerDescriptors.google, buildGooglePlan),
  bing: new DeclarativeProviderAdapter(providerDescriptors.bing, buildBingPlan),
  dns: new DeclarativeProviderAdapter(providerDescriptors.dns, buildDnsPlan),
  mijndomein: new DeclarativeProviderAdapter(providerDescriptors.mijndomein, buildMijnDomeinPlan),
  app_store_connect: new DeclarativeProviderAdapter(
    providerDescriptors.app_store_connect,
    buildAppStoreConnectPlan,
  ),
  eas: new DeclarativeProviderAdapter(providerDescriptors.eas, buildEasPlan),
};

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderAdapter>();

  constructor(initial: readonly ProviderAdapter[] = Object.values(adapters)) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    if (this.providers.has(adapter.descriptor.id)) {
      throw new Error(`Provider adapter already registered: ${adapter.descriptor.id}`);
    }
    this.providers.set(adapter.descriptor.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter {
    const adapter = this.providers.get(id);
    if (!adapter) throw new Error(`Provider adapter is not registered: ${id}`);
    return adapter;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }
}

export const providerRegistry = new ProviderRegistry();

export function getProviderAdapter(id: ProviderId): ProviderAdapter {
  return providerRegistry.get(id);
}
