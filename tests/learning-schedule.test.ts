import { describe, expect, it } from "vitest";
import { nextCronOccurrence } from "@/lib/learning/schedule";

describe("learning schedule", () => {
  const after = new Date("2026-08-04T12:00:00.000Z");

  it("resolves the declared daily, weekly, monthly, and biweekly UTC cadences", () => {
    expect(nextCronOccurrence("15 5 * * *", after)).toBe("2026-08-05T05:15:00.000Z");
    expect(nextCronOccurrence("25 5 * * 1", after)).toBe("2026-08-10T05:25:00.000Z");
    expect(nextCronOccurrence("35 5 1 * *", after)).toBe("2026-09-01T05:35:00.000Z");
    expect(nextCronOccurrence("0 7 1,15 * *", after)).toBe("2026-08-15T07:00:00.000Z");
  });

  it("fails closed on unsupported or invalid syntax", () => {
    expect(() => nextCronOccurrence("*/5 * * * *", after)).toThrow("Unsupported minute");
    expect(() => nextCronOccurrence("0 25 * * *", after)).toThrow("outside 0-23");
    expect(() => nextCronOccurrence("0 6 * *", after)).toThrow("expected five fields");
  });
});
