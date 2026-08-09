import type { JsonValue } from "./types";

export class WorkflowValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid workflow:\n- ${issues.join("\n- ")}`);
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export class WorkflowExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: JsonValue } = {},
  ) {
    super(message);
    this.name = "WorkflowExecutionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class DuplicateWorkflowRunError extends Error {
  constructor(runId: string) {
    super(`Workflow run "${runId}" already exists; use resume instead of starting it again.`);
    this.name = "DuplicateWorkflowRunError";
  }
}

export class WorkflowRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Workflow run "${runId}" was not found.`);
    this.name = "WorkflowRunNotFoundError";
  }
}
