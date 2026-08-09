import type { SubscriptionSnapshot } from "@venture-harness/core";

export function assertActiveSubscription(subscription: SubscriptionSnapshot): SubscriptionSnapshot {
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    throw new Error(`subscription ${subscription.subscriptionId} is ${subscription.status}`);
  }
  return subscription;
}

export function subscriptionAllowsMetering(subscription: SubscriptionSnapshot): boolean {
  return subscription.status === "active" || subscription.status === "trialing";
}
