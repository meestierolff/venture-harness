import { describe, expect, it } from "vitest";
import { assignVariant } from "@/lib/experiments";

const variants = [
  { key: "control", weight: 0.5 },
  { key: "variant_b", weight: 0.5 },
];

describe("assignVariant", () => {
  it("is deterministic for the same visitor and experiment", () => {
    const first = assignVariant("visitor-1", "exp-000-x", variants);
    for (let i = 0; i < 1000; i++) {
      expect(assignVariant("visitor-1", "exp-000-x", variants)).toBe(first);
    }
  });

  it("assigns independently per experiment", () => {
    const results = new Set(
      Array.from({ length: 50 }, (_, i) => assignVariant("visitor-1", `exp-00${i}-x`, variants)),
    );
    expect(results.size).toBeGreaterThan(1); // same visitor, different experiments vary
  });

  it("approximates declared weights over many visitors", () => {
    const skewed = [
      { key: "a", weight: 0.8 },
      { key: "b", weight: 0.2 },
    ];
    let a = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      if (assignVariant(`v-${i}`, "exp-001-skew", skewed) === "a") a++;
    }
    expect(a / N).toBeGreaterThan(0.77);
    expect(a / N).toBeLessThan(0.83);
  });

  it("rejects weights that do not sum to 1", () => {
    expect(() =>
      assignVariant("v", "exp-002-bad", [
        { key: "a", weight: 0.5 },
        { key: "b", weight: 0.6 },
      ]),
    ).toThrow(/sum/);
  });

  it("rejects empty variant lists", () => {
    expect(() => assignVariant("v", "exp-003-empty", [])).toThrow(/no variants/);
  });
});
