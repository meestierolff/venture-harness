import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DuplicateWorkflowRunError, WorkflowRunNotFoundError } from "./errors";
import { sanitizeJson } from "./redaction";
import type { WorkflowEvent, WorkflowRunState, WorkflowWorkspaceContext } from "./types";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkflowStore {
  create(state: WorkflowRunState): void;
  load(runId: string): WorkflowRunState;
  save(state: WorkflowRunState): void;
  appendEvent(event: WorkflowEvent): void;
  checkpoint?(state: WorkflowRunState, event: WorkflowEvent): void;
  readEvents(runId: string): WorkflowEvent[];
  exists(runId: string): boolean;
  listRuns(): string[];
  createWorkspace?(context: WorkflowWorkspaceContext): string;
}

export interface WorkflowEventStreamOptions {
  afterSequence?: number;
  follow?: boolean;
  pollIntervalMs?: number;
  stopWhenRunFinishes?: boolean;
  signal?: AbortSignal;
}

export interface FileWorkflowStoreOptions {
  rootDir?: string;
  secrets?: string[];
}

export class FileWorkflowStore implements WorkflowStore {
  readonly rootDir: string;
  private readonly secrets: string[];
  private readonly lastSequences = new Map<string, number>();

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
    this.lastSequences.set(state.runId, 0);
  }

  load(runId: string): WorkflowRunState {
    this.assertRunId(runId);
    const path = this.statePath(runId);
    if (!existsSync(path)) throw new WorkflowRunNotFoundError(runId);
    const state = JSON.parse(readFileSync(path, "utf8")) as WorkflowRunState;
    if (state.pendingEvent) {
      const pending = state.pendingEvent;
      const existing = this.readEvents(runId).find(({ sequence }) => sequence === pending.sequence);
      if (!existing) this.appendEvent(pending);
      else if (JSON.stringify(existing) !== JSON.stringify(sanitizeJson(pending, this.secrets))) {
        throw new Error(
          `Workflow event ${pending.sequence} for run "${runId}" conflicts with its durable checkpoint.`,
        );
      }
      delete state.pendingEvent;
    }
    return state;
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
    const expectedSequence = this.lastSequence(event.runId) + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Workflow event sequence for run "${event.runId}" must be ${expectedSequence}, received ${event.sequence}.`,
      );
    }
    const sanitized = sanitizeJson(event, this.secrets);
    const descriptor = openSync(path, "a", 0o600);
    try {
      appendFileSync(descriptor, `${JSON.stringify(sanitized)}\n`, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.lastSequences.set(event.runId, event.sequence);
  }

  checkpoint(state: WorkflowRunState, event: WorkflowEvent): void {
    state.pendingEvent = event;
    this.writeState(state);
    const lastSequence = this.lastSequence(state.runId);
    if (lastSequence < event.sequence) this.appendEvent(event);
    else if (lastSequence === event.sequence) {
      const existing = this.readEvents(state.runId).at(-1);
      if (JSON.stringify(existing) !== JSON.stringify(sanitizeJson(event, this.secrets))) {
        throw new Error(
          `Workflow event ${event.sequence} for run "${state.runId}" conflicts with its durable checkpoint.`,
        );
      }
    } else {
      throw new Error(
        `Workflow event ${event.sequence} for run "${state.runId}" is behind persisted sequence ${lastSequence}.`,
      );
    }
    delete state.pendingEvent;
  }

  readEvents(runId: string): WorkflowEvent[] {
    this.assertRunId(runId);
    const path = this.eventsPath(runId);
    if (!existsSync(path)) throw new WorkflowRunNotFoundError(runId);
    const events = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkflowEvent);
    for (const [index, event] of events.entries()) {
      if (event.runId !== runId || event.sequence !== index + 1) {
        throw new Error(`Workflow event log for run "${runId}" is corrupt at line ${index + 1}.`);
      }
    }
    this.lastSequences.set(runId, events.at(-1)?.sequence ?? 0);
    return events;
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

  createWorkspace(context: WorkflowWorkspaceContext): string {
    this.assertRunId(context.runId);
    const directory = join(
      this.runDir(context.runId),
      "workspaces",
      context.node.id,
      `attempt-${context.attempt}`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async *streamEvents(
    runId: string,
    options: WorkflowEventStreamOptions = {},
  ): AsyncGenerator<WorkflowEvent> {
    this.assertRunId(runId);
    let cursor = options.afterSequence ?? 0;
    const follow = options.follow ?? true;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error("afterSequence must be a non-negative integer.");
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error("pollIntervalMs must be a positive integer.");
    }

    while (!options.signal?.aborted) {
      const unseen = this.readEvents(runId).filter((event) => event.sequence > cursor);
      for (const event of unseen) {
        cursor = event.sequence;
        yield event;
      }
      if (!follow) return;
      if (options.stopWhenRunFinishes) {
        const status = this.load(runId).status;
        if (["succeeded", "failed", "cancelled", "superseded"].includes(status)) return;
      }
      await new Promise<void>((resolvePromise) => {
        const finish = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", finish);
          resolvePromise();
        };
        const timer = setTimeout(finish, pollIntervalMs);
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    }
  }

  private writeState(state: WorkflowRunState): void {
    const path = this.statePath(state.runId);
    const temporary = join(
      this.runDir(state.runId),
      `.state.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const sanitized = sanitizeJson(state, this.secrets);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(sanitized, null, 2)}\n`, {
        encoding: "utf8",
      });
      fsyncSync(descriptor);
    } catch (error) {
      closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    closeSync(descriptor);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(this.runDir(state.runId), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }

  private lastSequence(runId: string): number {
    const known = this.lastSequences.get(runId);
    if (known !== undefined) return known;
    return this.readEvents(runId).at(-1)?.sequence ?? 0;
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
