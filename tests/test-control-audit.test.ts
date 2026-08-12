import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditTestControls } from "@/scripts/audit-test-controls.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("test-control audit", () => {
  it("includes Playwright-style spec files in forbidden-control scanning", () => {
    const root = mkdtempSync(join(tmpdir(), "vh-test-control-audit-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "tests/e2e"), { recursive: true });
    const skippedControl = ".skip";
    const truthLiteral = "tr" + "ue";
    writeFileSync(
      join(root, "tests/e2e/critical.spec.ts"),
      `test${skippedControl}("must run", () => { expect(${truthLiteral}).toBe(${truthLiteral}); });\n`,
      "utf8",
    );
    writeFileSync(
      join(root, "tests/unit.test.ts"),
      `test("runs", () => { expect(1).toBe(1); });\n`,
      "utf8",
    );

    expect(auditTestControls(root)).toMatchObject({
      status: "failed",
      files: 2,
      assertions: 2,
      forbiddenFindings: [
        {
          kind: "focused_or_skipped",
          path: "tests/e2e/critical.spec.ts",
          line: 1,
        },
        {
          kind: "weak_constant_assertion",
          path: "tests/e2e/critical.spec.ts",
          line: 1,
        },
      ],
    });
  });
});
