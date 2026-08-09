import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultCredentialCatalogPath,
  loadCredentialCatalog,
  saveCredentialCatalog,
  upsertCredentialReference,
} from "@/lib/credentials";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential metadata catalog", () => {
  it("uses the XDG config directory for the default metadata mapping", () => {
    expect(
      defaultCredentialCatalogPath({
        homeDirectory: "/home/founder",
        xdgConfigHome: "/portable/config",
      }),
    ).toBe("/portable/config/venture-harness/credentials.json");
    expect(defaultCredentialCatalogPath({ homeDirectory: "/home/founder" })).toBe(
      "/home/founder/.config/venture-harness/credentials.json",
    );
  });

  it("persists only logical references and backend metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-credential-catalog-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const catalog = upsertCredentialReference(loadCredentialCatalog(path), {
      ref: "cred://github/default",
      provider: "github",
      kind: "api_key",
      backend: "environment",
      scopes: ["repo"],
      testedAt: "2026-08-04T10:00:00.000Z",
      testStatus: "passed",
      revokedAt: "2026-08-04T11:00:00.000Z",
    });
    saveCredentialCatalog(catalog, path);
    expect(loadCredentialCatalog(path)).toEqual(catalog);
    expect(readFileSync(path, "utf8")).not.toContain("ghp_");
  });

  it("rejects secret-shaped fields even in an untracked catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-credential-catalog-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    expect(() =>
      saveCredentialCatalog(
        {
          schemaVersion: 1,
          references: [
            {
              ref: "cred://github/default",
              provider: "github",
              kind: "api_key",
              backend: "environment",
              scopes: [],
              apiKey: "forbidden",
            } as never,
          ],
        },
        path,
      ),
    ).toThrow(/forbidden field/i);
  });

  it("rejects incomplete durable remote-test evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "vh-credential-catalog-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    expect(() =>
      saveCredentialCatalog(
        {
          schemaVersion: 1,
          references: [
            {
              ref: "cred://neon/incomplete-test",
              provider: "neon",
              kind: "api_key",
              backend: "environment",
              scopes: [],
              testedAt: "2026-08-04T10:00:00.000Z",
            },
          ],
        },
        path,
      ),
    ).toThrow(/testedAt and testStatus together/);
  });
});
