import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { JsonObject, TenantRef } from "@venture-harness/core";
import { tenantKey } from "@venture-harness/core";

export interface WorkflowCheckpoint {
  runId: string;
  tenant: TenantRef;
  sequence: number;
  state: JsonObject;
}

export interface WorkflowBackend {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  load(tenant: TenantRef, runId: string): Promise<WorkflowCheckpoint | null>;
}

export class LocalWorkflowBackend implements WorkflowBackend {
  readonly #root: string;
  constructor(root: string) {
    this.#root = resolve(root);
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    const path = this.path(checkpoint.tenant, checkpoint.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  async load(tenant: TenantRef, runId: string): Promise<WorkflowCheckpoint | null> {
    try {
      return JSON.parse(await readFile(this.path(tenant, runId), "utf8")) as WorkflowCheckpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private path(tenant: TenantRef, runId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("invalid run id");
    return join(this.#root, tenantKey(tenant).replaceAll(":", "_"), `${runId}.json`);
  }
}
