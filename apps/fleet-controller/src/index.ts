import { planOwnedFileUpgrade, type OwnedFileUpgrade } from "@venture-harness/upgrades";

export interface FleetCanaryPlan {
  release: string;
  canaryVentureId: string;
  batches: readonly (readonly string[])[];
  filePlans: ReturnType<typeof planOwnedFileUpgrade>[];
}

export function createFleetCanaryPlan(input: {
  release: string;
  ventures: readonly string[];
  files: readonly OwnedFileUpgrade[];
  batchSize: number;
}): FleetCanaryPlan {
  if (input.ventures.length < 1) throw new Error("at least one venture is required");
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1)
    throw new Error("batchSize must be positive");
  const [, ...remaining] = input.ventures;
  const batches: string[][] = [];
  for (let index = 0; index < remaining.length; index += input.batchSize) {
    batches.push(remaining.slice(index, index + input.batchSize));
  }
  return {
    release: input.release,
    canaryVentureId: input.ventures[0]!,
    batches,
    filePlans: input.files.map(planOwnedFileUpgrade),
  };
}
