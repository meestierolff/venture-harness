/**
 * Wrapper for public capability claims. Every claim on a public surface
 * carries the id of its row in docs/product/PRODUCT_TRUTH.md;
 * scripts/validate-claims.ts fails the gate on unknown ids and on claims
 * whose status forbids public display.
 */
import type { ReactNode } from "react";

export function TruthClaim({ id, children }: { id: string; children: ReactNode }) {
  return <span data-claim={id}>{children}</span>;
}
