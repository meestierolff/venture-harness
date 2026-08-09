import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProductionRuntimeModule } from "../packages/cli-generator/src/runtime-module";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("explicit packaged runtime modules", () => {
  it("rejects path escape, symbolic links, TypeScript source, and fixture runtime composition", async () => {
    const root = temporaryRoot("vh-runtime-module-");
    const outside = temporaryRoot("vh-runtime-outside-");
    const outsideModule = join(outside, "outside.mjs");
    writeFileSync(
      outsideModule,
      "export const createVhRuntime = () => ({ executionMode: 'production' });\n",
    );
    symlinkSync(outsideModule, join(root, "linked.mjs"));
    writeFileSync(join(root, "runtime.ts"), "export const createVhRuntime = () => ({});\n");
    writeFileSync(
      join(root, "fixture.mjs"),
      "export const createVhRuntime = () => ({ executionMode: 'fixture', durability: {} });\n",
    );

    const load = (runtimeModule: string) =>
      loadProductionRuntimeModule({
        projectRoot: root,
        runtimeModule,
        stateDirectory: ".runtime",
      });
    await expect(load(outsideModule)).rejects.toThrow(/stay within the project root/);
    await expect(load("linked.mjs")).rejects.toThrow(/symbolic links/);
    await expect(load("runtime.ts")).rejects.toThrow(/compiled JavaScript/);
    await expect(load("fixture.mjs")).rejects.toThrow(/commandExecutionMode=production/);
  });
});
