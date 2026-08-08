import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { MigrationFileSystem } from "./types";

function insideRoot(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return absolute;
  }
  throw new Error(`migration path escapes repository root: ${path}`);
}

export function createNodeMigrationFileSystem(root = process.cwd()): MigrationFileSystem {
  let sequence = 0;
  return {
    async readText(path) {
      try {
        return await readFile(insideRoot(root, path), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async writeAtomic(path, content) {
      const destination = insideRoot(root, path);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.vh-next-${process.pid}-${sequence++}`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
    async remove(path) {
      await rm(insideRoot(root, path), { force: true });
    },
  };
}
