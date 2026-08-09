export type UpgradeOwnership = "core-owned" | "merge-managed" | "venture-owned";

export interface OwnedFileUpgrade {
  path: string;
  ownership: UpgradeOwnership;
  base: string | null;
  current: string | null;
  next: string;
}

export interface OwnedFileUpgradePlan extends OwnedFileUpgrade {
  action: "create" | "update" | "preserve" | "merge" | "unchanged" | "conflict";
  result: string | null;
}

function mergeLines(base: string, current: string, next: string): string | null {
  const bases = base.split("\n");
  const currents = current.split("\n");
  const nexts = next.split("\n");
  const length = Math.max(bases.length, currents.length, nexts.length);
  const merged: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const before = bases[index];
    const local = currents[index];
    const incoming = nexts[index];
    if (local === incoming) merged.push(local ?? "");
    else if (local === before) merged.push(incoming ?? "");
    else if (incoming === before) merged.push(local ?? "");
    else return null;
  }
  return merged.join("\n");
}

export function planOwnedFileUpgrade(input: OwnedFileUpgrade): OwnedFileUpgradePlan {
  if (input.ownership === "venture-owned")
    return { ...input, action: "preserve", result: input.current };
  if (input.current === input.next) return { ...input, action: "unchanged", result: input.current };
  if (input.current === null) return { ...input, action: "create", result: input.next };
  if (input.current === input.base) return { ...input, action: "update", result: input.next };
  if (input.ownership === "core-owned" || input.base === null)
    return { ...input, action: "conflict", result: null };
  const merged = mergeLines(input.base, input.current, input.next);
  return merged === null
    ? { ...input, action: "conflict", result: null }
    : { ...input, action: "merge", result: merged };
}
