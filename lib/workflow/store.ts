import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DuplicateWorkflowRunError, WorkflowRunNotFoundError } from "./errors";
import { sanitizeJson } from "./redaction";
import type { WorkflowEvent, WorkflowRunState } from "./types";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkflowStore {
  create(state: WorkflowRunState): void;
  load(runId: string): WorkflowRunState;
  save(state: WorkflowRunState): void;
  appendEvent(event: WorkflowEvent): void;
  readEvents(runId: string): WorkflowEvent[];
  exists(runId: string): boolean;
  listRuns(): string[];
}

export interface FileWorkflowStoreOptions {
  rootDir?: string;
  secrets?: string[];
}

export class FileWorkflowStore implements WorkflowStore {
  readonly rootDir: string;
  private readonly secrets: string[];

  constructor(options: FileWorkflowStoreOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? ".venture/runs");
    this.secrets = options.secrets ?? [];
  }

  create(state: WorkflowRunState): void {
    this.assertRunId(state.runId);
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(this.runDir(state.runId), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DuplicateWorkflowRunError(state.runId);
      }
      throw error;
    }
    this.writeState(state);
    writeFileSync(this.eventsPath(state.runId), "", { encoding: "utf8", mode: 0o600 });
  }

  load(runId: string): WorkflowRunState {
    this.assertRunId(runId);
    const path = this.statePath(runId);
    if (!existsSync(path)) throw new WorkflowRunNotFoundError(runId);
    return JSON.parse(readFileSync(path, "utf8")) as WorkflowRunState;
  }

  save(state: WorkflowRunState): void {
    this.assertRunId(state.runId);
    if (!existsSync(this.runDir(state.runId))) throw new WorkflowRunNotFoundError(state.runId);
    this.writeState(state);
  }

  appendEvent(event: WorkflowEvent): void {
    this.assertRunId(event.runId);
    const path = this.eventsPath(event.runId);
    if (!existsSync(path)) throw new WorkflowRunNotFoundError(event.runId);
    const sanitized = sanitizeJson(event, this.secrets);
    appendFileSync(path, `${JSON.stringify(sanitized)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  readEvents(runId: string): WorkflowEvent[] {
    this.assertRunId(runId);
    const path = this.eventsPath(runId);
    if (!existsSync(path)) throw new WorkflowRunNotFoundError(runId);
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkflowEvent);
  }

  exists(runId: string): boolean {
    this.assertRunId(runId);
    return existsSync(this.statePath(runId));
  }

  listRuns(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
      .map((entry) => entry.name)
      .filter((runId) => existsSync(this.statePath(runId)))
      .sort();
  }

  private writeState(state: WorkflowRunState): void {
    const path = this.statePath(state.runId);
    const temporary = join(
      this.runDir(state.runId),
      `.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const sanitized = sanitizeJson(state, this.secrets);
    writeFileSync(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID.test(runId)) {
      throw new Error(
        `Invalid workflow run id "${runId}"; use 1-128 letters, numbers, dots, underscores, or hyphens.`,
      );
    }
  }

  private runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  private statePath(runId: string): string {
    return join(this.runDir(runId), "state.json");
  }

  private eventsPath(runId: string): string {
    return join(this.runDir(runId), "events.jsonl");
  }
}
