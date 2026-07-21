/**
 * The shipped config files must satisfy their own schemas — the template
 * always starts green.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { configSchemas } from "@/lib/config/schemas";

describe("config contracts", () => {
  for (const [file, schema] of Object.entries(configSchemas)) {
    it(`${file} validates`, () => {
      const parsed = schema.safeParse(parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      expect(parsed.success).toBe(true);
    });
  }
});
