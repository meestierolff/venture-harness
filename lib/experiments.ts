/**
 * Deterministic experiment assignment. Pure function of
 * (visitorId, experimentId) — no state, no time, no randomness — so a lost
 * cookie re-derives the identical variant and scripts can verify the
 * distribution offline (scripts/verify-experiment-assignment.ts).
 */
export interface VariantWeight {
  key: string;
  weight: number;
}

/** FNV-1a 32-bit hash → uniform-ish [0, 1). */
function hashToUnit(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

export function assignVariant(
  visitorId: string,
  experimentId: string,
  variants: VariantWeight[],
): string {
  if (variants.length === 0) throw new Error("assignVariant: no variants declared");
  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  if (Math.abs(total - 1) > 0.001)
    throw new Error(`assignVariant: weights for ${experimentId} sum to ${total}, expected 1`);
  const unit = hashToUnit(`${visitorId}::${experimentId}`);
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (unit < cumulative) return variant.key;
  }
  return variants[variants.length - 1].key; // float edge: last variant
}
