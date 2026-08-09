import { createHash } from "node:crypto";
import { WorkflowValidationError } from "./errors";
import type { JsonValue, WorkflowDefinition, WorkflowNodeDefinition } from "./types";

const ID = /^[a-z0-9][a-z0-9._-]*$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function workflowFingerprint(definition: WorkflowDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(definition)))
    .digest("hex");
}

export function topologicalOrder(definition: WorkflowDefinition): string[] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of definition.nodes) {
    inDegree.set(node.id, node.dependencies.length);
    for (const dependency of node.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(node.id);
      dependents.set(dependency, list);
    }
  }

  const ready = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return order;
}

export function validateWorkflow(definition: WorkflowDefinition): void {
  const issues: string[] = [];
  if (!ID.test(definition.id))
    issues.push(`graph id "${definition.id}" must be lowercase kebab-safe`);
  if (!definition.name.trim()) issues.push("graph name is required");
  if (!definition.version.trim()) issues.push("graph version is required");
  if (!Number.isInteger(definition.maxParallel) || definition.maxParallel < 1)
    issues.push("maxParallel must be a positive integer");
  if (!Number.isInteger(definition.maxIterations) || definition.maxIterations < 1)
    issues.push("maxIterations must be a positive integer");
  if (definition.nodes.length === 0) issues.push("at least one node is required");

  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const node of definition.nodes) {
    validateNode(node, issues);
    if (ids.has(node.id)) issues.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (node.effect !== "none" && node.effect !== "read") {
      if (idempotencyKeys.has(node.idempotencyKey))
        issues.push(`duplicate side-effect idempotency key "${node.idempotencyKey}"`);
      idempotencyKeys.add(node.idempotencyKey);
      if (node.cache.mode !== "none")
        issues.push(`node "${node.id}" cannot cache a side effect; use verifiedEffects instead`);
    }
  }

  for (const node of definition.nodes) {
    const dependencySet = new Set<string>();
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency))
        issues.push(`node "${node.id}" depends on missing node "${dependency}"`);
      if (dependency === node.id) issues.push(`node "${node.id}" cannot depend on itself`);
      if (dependencySet.has(dependency))
        issues.push(`node "${node.id}" repeats dependency "${dependency}"`);
      dependencySet.add(dependency);
    }
  }

  if (issues.length === 0) {
    const order = topologicalOrder(definition);
    if (order.length !== definition.nodes.length) {
      const ordered = new Set(order);
      const cyclic = definition.nodes
        .map((node) => node.id)
        .filter((id) => !ordered.has(id))
        .sort();
      issues.push(`graph contains a cycle involving: ${cyclic.join(", ")}`);
    }
  }

  for (const [category, amount] of Object.entries(definition.budgets)) {
    if (!category.trim()) issues.push("budget categories cannot be empty");
    if (!Number.isFinite(amount) || amount < 0)
      issues.push(`budget "${category}" must be a non-negative finite number`);
  }

  if (issues.length > 0) throw new WorkflowValidationError(issues);
}

function validateNode(node: WorkflowNodeDefinition, issues: string[]): void {
  const prefix = `node "${node.id}"`;
  if (!ID.test(node.id)) issues.push(`${prefix} id must be lowercase kebab-safe`);
  if (!node.purpose.trim()) issues.push(`${prefix} purpose is required`);
  if (!node.capability.trim()) issues.push(`${prefix} capability is required`);
  if (!node.idempotencyKey.trim()) issues.push(`${prefix} idempotencyKey is required`);
  if (!node.concurrencyGroup.trim()) issues.push(`${prefix} concurrencyGroup is required`);
  if (!node.budgetCategory.trim()) issues.push(`${prefix} budgetCategory is required`);
  if (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1)
    issues.push(`${prefix} timeoutMs must be a positive integer`);
  if (!Number.isInteger(node.retry.maxAttempts) || node.retry.maxAttempts < 1)
    issues.push(`${prefix} retry.maxAttempts must be a positive integer`);
  if (
    !Number.isFinite(node.retry.backoff.initialMs) ||
    !Number.isFinite(node.retry.backoff.maxMs) ||
    node.retry.backoff.initialMs < 0 ||
    node.retry.backoff.maxMs < 0
  )
    issues.push(`${prefix} retry backoff values must be non-negative and finite`);
  if (node.retry.backoff.maxMs < node.retry.backoff.initialMs)
    issues.push(`${prefix} retry.backoff.maxMs cannot be below initialMs`);
  if (!Number.isFinite(node.retry.backoff.multiplier) || node.retry.backoff.multiplier < 1)
    issues.push(`${prefix} retry.backoff.multiplier must be finite and at least 1`);
  if (!Number.isFinite(node.cost.amount) || node.cost.amount < 0)
    issues.push(`${prefix} cost.amount must be a non-negative finite number`);
  if (!node.cost.unit.trim()) issues.push(`${prefix} cost.unit is required`);
  if (node.condition.kind === "handler" && !node.condition.handler)
    issues.push(`${prefix} handler condition requires condition.handler`);
  if (node.kind === "human_approval" && node.transport !== "human_approval")
    issues.push(`${prefix} human_approval nodes must use human_approval transport`);
  if (node.kind === "manual_action" && node.transport !== "manual")
    issues.push(`${prefix} manual_action nodes must use manual transport`);
  if (node.effect === "external_irreversible" && !node.authorization.required)
    issues.push(`${prefix} external irreversible effects require authorization`);
  if (node.reconciliation) {
    if (!node.reconciliation.handler.trim())
      issues.push(`${prefix} reconciliation.handler is required`);
    if (
      !Number.isInteger(node.reconciliation.pollIntervalMs) ||
      node.reconciliation.pollIntervalMs < 0
    ) {
      issues.push(`${prefix} reconciliation.pollIntervalMs must be a non-negative integer`);
    }
    if (
      !Number.isInteger(node.reconciliation.maxPollAttempts) ||
      node.reconciliation.maxPollAttempts < 1
    ) {
      issues.push(`${prefix} reconciliation.maxPollAttempts must be a positive integer`);
    }
  }
  if (node.loop && (!Number.isInteger(node.loop.maxIterations) || node.loop.maxIterations < 1)) {
    issues.push(`${prefix} loop.maxIterations must be a positive integer`);
  }
  if (node.loop && node.effect !== "none" && node.effect !== "read") {
    issues.push(
      `${prefix} effectful loops require separate DAG nodes with unique idempotency keys per effect`,
    );
  }
}

export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  validateWorkflow(definition);
  return definition;
}

export function workflowNode(
  id: string,
  overrides: Partial<WorkflowNodeDefinition> = {},
): WorkflowNodeDefinition {
  const base: WorkflowNodeDefinition = {
    id,
    purpose: id,
    kind: "code",
    capability: "workflow.test",
    dependencies: [],
    condition: { kind: "dependencies_succeeded" },
    input: {},
    output: {},
    transport: "code",
    handler: id,
    model: { tier: "none" },
    effect: "none",
    risk: "low",
    authorization: { required: false, scopes: [] },
    idempotencyKey: id,
    timeoutMs: 30_000,
    retry: {
      maxAttempts: 1,
      retryableCodes: [],
      backoff: { strategy: "none", initialMs: 0, maxMs: 0, multiplier: 1 },
    },
    concurrencyGroup: id,
    cost: { amount: 0, unit: "credits" },
    budgetCategory: "default",
    cache: { mode: "none" },
    isolation: "none",
    compensation: null,
    evidence: { required: false },
    completion: { description: `${id} completed` },
  };
  return { ...base, ...overrides };
}

export function asJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object") return { value };
  return value as Record<string, JsonValue>;
}
