#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/cli-generator/src/bin.ts
import { resolve as resolve4 } from "node:path";

// packages/audit/dist/index.js
import { createHash } from "node:crypto";

// packages/core/dist/index.js
var CREDENTIAL_VALUE_PATTERNS = [
  /\bwhsec_[a-z0-9_-]{8,}/iu,
  /\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,}/iu,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/iu,
  /\bxox[baprs]-[a-z0-9-]{10,}/iu,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/iu,
  /[?&](?:access_token|api_key|token|secret)=[^&\s]{6,}/iu,
  /\b(?:(?:vh|credential)[_-])canary[_-][a-z0-9_-]{6,}/iu
];
function credentialFieldWords(field) {
  return field.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}
function secretBearingField(field) {
  const words = credentialFieldWords(field);
  if (["secret", "password", "token", "credential", "authorization"].some((word) => words.includes(word))) {
    return true;
  }
  const joined = words.join("");
  return ["apikey", "privatekey", "signingkey"].some((marker) => joined.includes(marker));
}
function findCredentialMaterial(value, options = {}) {
  const canaries = [...options.canaries ?? []].filter(Boolean);
  const referenceKeys = new Set(options.allowedCredentialReferenceKeys ?? []);
  const visited = /* @__PURE__ */ new WeakSet();
  const inspect = (candidate, path) => {
    if (typeof candidate === "string") {
      if (canaries.some((canary) => candidate.includes(canary))) {
        return { kind: "registered_canary", path };
      }
      if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(candidate))) {
        return { kind: "credential_pattern", path };
      }
      return null;
    }
    if (candidate === null || typeof candidate === "boolean")
      return null;
    if (typeof candidate === "number") {
      return Number.isFinite(candidate) ? null : { kind: "non_json_value", path };
    }
    if (typeof candidate !== "object")
      return { kind: "non_json_value", path };
    if (visited.has(candidate))
      return { kind: "non_json_value", path };
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const [index, entry] of candidate.entries()) {
        const finding = inspect(entry, `${path}[${index}]`);
        if (finding)
          return finding;
      }
      return null;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: "non_json_value", path };
    }
    for (const [field, entry] of Object.entries(candidate)) {
      const childPath = `${path}.${field}`;
      if (referenceKeys.has(field)) {
        if (typeof entry !== "string" || !/^cred:\/\/[A-Za-z0-9][A-Za-z0-9/_:.-]*$/u.test(entry)) {
          return { kind: "invalid_credential_reference", path: childPath };
        }
      } else if (secretBearingField(field)) {
        return { kind: "secret_bearing_field", path: childPath };
      }
      const finding = inspect(entry, childPath);
      if (finding)
        return finding;
    }
    return null;
  };
  return inspect(value, "$");
}
function assertNonEmpty(value, field) {
  const normalized = value.trim();
  if (!normalized)
    throw new Error(`${field} must not be empty`);
  return normalized;
}
function tenantKey(tenant) {
  const organizationId = assertNonEmpty(tenant.organizationId, "organizationId");
  const ventureId2 = assertNonEmpty(tenant.ventureId, "ventureId");
  if (organizationId !== tenant.organizationId) {
    throw new Error("organizationId must not contain leading or trailing whitespace");
  }
  if (ventureId2 !== tenant.ventureId) {
    throw new Error("ventureId must not contain leading or trailing whitespace");
  }
  const tenantIdPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
  if (!tenantIdPattern.test(organizationId)) {
    throw new Error("organizationId must be a canonical tenant identifier");
  }
  if (!tenantIdPattern.test(ventureId2)) {
    throw new Error("ventureId must be a canonical tenant identifier");
  }
  return `${organizationId}:${ventureId2}`;
}
function canonicalCommandId(value) {
  const commandId = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(commandId)) {
    throw new Error(`Invalid command id: ${value}`);
  }
  return commandId;
}
function sortJson(value) {
  if (Array.isArray(value))
    return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
function stableJson(value) {
  return JSON.stringify(sortJson(value));
}
function assertCredentialFree(value, path = "value", canaries = []) {
  const finding = findCredentialMaterial(value, { canaries });
  if (finding)
    throw new Error(`credential-like material is forbidden at ${path}${finding.path.slice(1)}`);
}

// packages/audit/dist/index.js
function digest(input, sequence, previousHash) {
  return createHash("sha256").update(stableJson({ ...input, sequence, previousHash })).digest("hex");
}
var InMemoryAuditChain = class {
  durability = "fixture_only";
  #records = /* @__PURE__ */ new Map();
  append(input) {
    const key = tenantKey(input.tenant);
    const records = this.#records.get(key) ?? [];
    if (input.idempotencyKey) {
      const existing = records.find(({ idempotencyKey }) => idempotencyKey === input.idempotencyKey);
      if (existing)
        return structuredClone(existing);
    }
    const sequence = records.length + 1;
    const previousHash = records.at(-1)?.hash ?? "0".repeat(64);
    const record = {
      ...structuredClone(input),
      sequence,
      previousHash,
      hash: digest(input, sequence, previousHash)
    };
    records.push(record);
    this.#records.set(key, records);
    return structuredClone(record);
  }
  read(tenant) {
    return (this.#records.get(tenantKey(tenant)) ?? []).map((record) => structuredClone(record));
  }
  verify(tenant) {
    let previousHash = "0".repeat(64);
    return this.read(tenant).every((record, index) => {
      const { sequence, hash, previousHash: recordedPrevious, ...input } = record;
      const valid = sequence === index + 1 && recordedPrevious === previousHash && hash === digest(input, sequence, previousHash);
      previousHash = hash;
      return valid;
    });
  }
};

// packages/billing/dist/index.js
function assertActiveSubscription(subscription) {
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    throw new Error(`subscription ${subscription.subscriptionId} is ${subscription.status}`);
  }
  return subscription;
}

// packages/command-bus/dist/index.js
import { createHash as createHash2, randomUUID } from "node:crypto";
function upperCamel(parts) {
  return parts.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join("");
}
function deriveCommandSurfaces(commandId, title) {
  const id = canonicalCommandId(commandId);
  const [namespace, method, ...rest] = id.split(".");
  if (!namespace || !method || rest.length)
    throw new Error(`Command ids must contain one namespace and method: ${id}`);
  const surfaces = {
    rest: {
      method: "POST",
      path: `/v1/commands/${id}`,
      operationId: `${namespace}${upperCamel([method])}`
    },
    cli: { tokens: [namespace, method] },
    mcp: { tool: `${namespace}_${method.replaceAll("-", "_")}` },
    sdk: { namespace, method },
    ui: { actionId: id, label: title }
  };
  return Object.freeze(surfaces);
}
function defineCommandContract(definition) {
  const id = canonicalCommandId(definition.id);
  if (!Number.isInteger(definition.version) || definition.version < 1)
    throw new Error("command version must be positive");
  return Object.freeze({
    ...definition,
    id,
    effect: definition.effect ?? "write",
    surfaces: deriveCommandSurfaces(id, definition.title)
  });
}
function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}
function nonEmpty(value, label) {
  const normalized = value.trim();
  if (!normalized)
    throw new Error(`${label} must not be empty`);
  return normalized;
}
var InMemoryIdempotencyStore = class {
  durability = "fixture_only";
  #entries = /* @__PURE__ */ new Map();
  #pendingTimeoutMs;
  constructor(options = {}) {
    this.#pendingTimeoutMs = options.pendingTimeoutMs ?? 5 * 6e4;
    if (!Number.isSafeInteger(this.#pendingTimeoutMs) || this.#pendingTimeoutMs < 1) {
      throw new Error("pendingTimeoutMs must be a positive safe integer");
    }
  }
  claim(key, input) {
    nonEmpty(key, "idempotency ledger key");
    nonEmpty(input.requestHash, "requestHash");
    nonEmpty(input.ownerToken, "ownerToken");
    const nowMs = timestamp(input.now, "claim now");
    const existing = this.#entries.get(key);
    if (!existing) {
      const pendingExpiresAt = new Date(nowMs + this.#pendingTimeoutMs).toISOString();
      this.#entries.set(key, {
        state: "pending",
        requestHash: input.requestHash,
        ownerToken: input.ownerToken,
        claimedAt: input.now,
        pendingExpiresAt
      });
      return {
        kind: "owner",
        ownerToken: input.ownerToken,
        claimedAt: input.now,
        pendingExpiresAt
      };
    }
    if (existing.requestHash !== input.requestHash) {
      return { kind: "conflict", existingRequestHash: existing.requestHash };
    }
    if (existing.state === "completed") {
      return {
        kind: "replay",
        record: {
          requestHash: existing.requestHash,
          output: structuredClone(existing.output),
          occurredAt: existing.occurredAt,
          actorId: existing.actorId,
          artifactsEmittedAt: existing.artifactsEmittedAt
        },
        completedAt: existing.completedAt
      };
    }
    if (existing.state === "ambiguous") {
      return {
        kind: "ambiguous",
        claimedAt: existing.claimedAt,
        ambiguousAt: existing.ambiguousAt
      };
    }
    if (nowMs >= timestamp(existing.pendingExpiresAt, "pending expiry")) {
      const ambiguous = {
        state: "ambiguous",
        requestHash: existing.requestHash,
        claimedAt: existing.claimedAt,
        ambiguousAt: input.now
      };
      this.#entries.set(key, ambiguous);
      return { kind: "ambiguous", claimedAt: ambiguous.claimedAt, ambiguousAt: input.now };
    }
    return {
      kind: "pending",
      claimedAt: existing.claimedAt,
      pendingExpiresAt: existing.pendingExpiresAt
    };
  }
  complete(key, value) {
    const existing = this.#entries.get(key);
    if (!existing)
      throw new Error("cannot complete an idempotency claim that does not exist");
    if (existing.requestHash !== value.requestHash) {
      throw new Error("cannot complete an idempotency claim bound to different input");
    }
    if (existing.state === "completed") {
      if (stableJson(existing.output) !== stableJson(value.output)) {
        throw new Error("completed idempotency output is immutable");
      }
      return;
    }
    if (existing.state === "ambiguous") {
      throw new Error("cannot complete an ambiguous idempotency claim");
    }
    if (existing.ownerToken !== value.ownerToken) {
      throw new Error("only the idempotency claim owner may complete it");
    }
    timestamp(value.completedAt, "completedAt");
    timestamp(value.occurredAt, "occurredAt");
    nonEmpty(value.actorId, "actorId");
    this.#entries.set(key, {
      state: "completed",
      requestHash: value.requestHash,
      output: structuredClone(value.output),
      completedAt: value.completedAt,
      occurredAt: value.occurredAt,
      actorId: value.actorId,
      artifactsEmittedAt: value.artifactsEmittedAt
    });
  }
  markAmbiguous(key, value) {
    const existing = this.#entries.get(key);
    if (!existing)
      throw new Error("cannot mark an idempotency claim that does not exist");
    if (existing.requestHash !== value.requestHash) {
      throw new Error("cannot mark an idempotency claim bound to different input");
    }
    if (existing.state === "completed" || existing.state === "ambiguous")
      return;
    if (existing.ownerToken !== value.ownerToken) {
      throw new Error("only the idempotency claim owner may mark it ambiguous");
    }
    timestamp(value.ambiguousAt, "ambiguousAt");
    this.#entries.set(key, {
      state: "ambiguous",
      requestHash: value.requestHash,
      claimedAt: existing.claimedAt,
      ambiguousAt: value.ambiguousAt
    });
  }
  markArtifactsEmitted(key, value) {
    timestamp(value.artifactsEmittedAt, "artifactsEmittedAt");
    const existing = this.#entries.get(key);
    if (!existing || existing.state !== "completed") {
      throw new Error("only a completed idempotency claim may finish its artifacts");
    }
    if (existing.requestHash !== value.requestHash) {
      throw new Error("cannot finish artifacts for an idempotency claim bound to different input");
    }
    if (existing.artifactsEmittedAt)
      return;
    this.#entries.set(key, { ...existing, artifactsEmittedAt: value.artifactsEmittedAt });
  }
  release(key, value) {
    const existing = this.#entries.get(key);
    if (!existing || existing.state !== "pending") {
      throw new Error("only a pending idempotency claim may be released");
    }
    if (existing.requestHash !== value.requestHash || existing.ownerToken !== value.ownerToken) {
      throw new Error("only the idempotency claim owner may release it");
    }
    this.#entries.delete(key);
  }
};
function commandRequestHash(contract, input) {
  const canonical = stableJson({
    commandId: contract.id,
    commandVersion: contract.version,
    input
  });
  return `sha256:${createHash2("sha256").update(canonical).digest("hex")}`;
}
var COMMAND_SECURITY_AUDIT_TENANT = Object.freeze({
  organizationId: "_venture_harness_security",
  ventureId: "command_bus"
});
var COMMAND_ERROR_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END|$)/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/giu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}/giu
];
function sanitizeCommandFailureMessage(value) {
  return COMMAND_ERROR_SECRET_PATTERNS.reduce((safe, pattern) => safe.replace(pattern, "[REDACTED]"), value);
}
var COMMAND_BUS_ERROR_CODES = /* @__PURE__ */ new Set([
  "command_unknown",
  "command_duplicate",
  "authorization_denied",
  "idempotency_conflict",
  "idempotency_pending",
  "idempotency_ambiguous",
  "idempotency_store_unsafe",
  "evidence_sink_unsafe",
  "invalid_input",
  "invalid_output",
  "handler_failed"
]);
function commandBusErrorLike(error) {
  if (error instanceof CommandBusError)
    return error;
  if (!error || typeof error !== "object")
    return null;
  const candidate = error;
  if (candidate.name !== "CommandBusError" || typeof candidate.code !== "string" || !COMMAND_BUS_ERROR_CODES.has(candidate.code) || typeof candidate.message !== "string") {
    return null;
  }
  return { code: candidate.code, message: candidate.message };
}
function commandFailureEnvelope(error) {
  const classified = commandBusErrorLike(error);
  if (classified) {
    return {
      error: "command_failed",
      code: classified.code,
      message: sanitizeCommandFailureMessage(classified.message)
    };
  }
  return {
    error: "command_failed",
    code: "internal_error",
    message: "Command execution failed without a classified result."
  };
}
var CommandBusError = class extends Error {
  code;
  constructor(message, code) {
    super(sanitizeCommandFailureMessage(message));
    this.code = code;
    this.name = "CommandBusError";
  }
};
var CommandDefinitiveNoEffectError = class extends Error {
  code;
  constructor(message, code = "handler_failed") {
    super(sanitizeCommandFailureMessage(message));
    this.code = code;
    this.name = "CommandDefinitiveNoEffectError";
  }
};
var CommandBus = class {
  #commands = /* @__PURE__ */ new Map();
  #hooks;
  #now;
  #executionMode;
  constructor(hooks, nowOrOptions = {}) {
    this.#hooks = { ...hooks, securityAudit: hooks.securityAudit ?? hooks.audit };
    this.#now = typeof nowOrOptions === "function" ? nowOrOptions : nowOrOptions.now ?? (() => /* @__PURE__ */ new Date());
    this.#executionMode = typeof nowOrOptions === "function" ? "production" : nowOrOptions.executionMode ?? "production";
  }
  register(contract, handler) {
    if (this.#commands.has(contract.id))
      throw new CommandBusError(`Command already registered: ${contract.id}`, "command_duplicate");
    this.#commands.set(contract.id, {
      contract,
      handler
    });
  }
  contracts() {
    return [...this.#commands.values()].map(({ contract }) => contract).sort((left, right) => left.id.localeCompare(right.id));
  }
  async execute(contract, input, options) {
    return await this.executeById(contract.id, input, options);
  }
  async executeById(commandId, input, options) {
    const registered = this.#commands.get(canonicalCommandId(commandId));
    if (!registered)
      throw new CommandBusError(`Unknown command: ${commandId}`, "command_unknown");
    const { contract, handler } = registered;
    if (this.#executionMode === "production" && contract.effect === "write") {
      if (this.#hooks.idempotency.durability !== "durable_atomic") {
        throw new CommandBusError(`Production command ${contract.id} requires a durable atomic idempotency store.`, "idempotency_store_unsafe");
      }
      const unsafeEvidence = [
        ["audit", this.#hooks.audit.durability],
        ["security audit", this.#hooks.securityAudit.durability],
        ["events", this.#hooks.events.durability],
        ["metering", this.#hooks.metering.durability]
      ].filter(([, durability]) => durability !== "durable_atomic").map(([name]) => name);
      if (unsafeEvidence.length > 0) {
        throw new CommandBusError(`Production command ${contract.id} requires durable atomic evidence sinks for: ${unsafeEvidence.join(", ")}.`, "evidence_sink_unsafe");
      }
    }
    const occurredAt = this.#now().toISOString();
    const details = {
      commandId: contract.id,
      commandVersion: contract.version,
      idempotencyKey: options.idempotencyKey
    };
    let tenantAuthorized = false;
    try {
      if (!options.idempotencyKey.trim())
        throw new Error("idempotencyKey must not be empty");
      await this.#hooks.identity(options.context);
      await this.#hooks.tenant(options.context);
      tenantAuthorized = true;
      await this.#hooks.audit.append({
        tenant: options.context.tenant,
        actorId: options.context.identity.actorId,
        action: contract.id,
        outcome: "requested",
        occurredAt,
        details
      });
      await this.#hooks.subscription(contract, options.context);
      await this.#hooks.entitlement(contract, options.context);
      await this.#hooks.grant(contract, options.context, new Date(occurredAt));
      await this.#hooks.scope(contract, options.context);
      let parsed;
      try {
        parsed = contract.input.parse(input);
      } catch (error) {
        throw new CommandBusError(error instanceof Error ? error.message : String(error), "invalid_input");
      }
      const requestHash = commandRequestHash(contract, parsed);
      const ledgerKey = `${tenantKey(options.context.tenant)}:${contract.id}:${options.idempotencyKey}`;
      const completionKey = `command-completion:${createHash2("sha256").update(ledgerKey).digest("hex")}`;
      const emitCompletionArtifacts = async (record) => {
        await this.#hooks.events.append({
          eventId: `${completionKey}:event`,
          tenant: options.context.tenant,
          type: "command.succeeded",
          occurredAt: record.occurredAt,
          payload: { commandId: contract.id, commandVersion: contract.version }
        });
        if (contract.meter)
          await this.#hooks.metering.record({
            idempotencyKey: `${completionKey}:meter`,
            tenant: options.context.tenant,
            commandId: contract.id,
            meter: contract.meter,
            quantity: 1,
            occurredAt: record.occurredAt
          });
        await this.#hooks.audit.append({
          idempotencyKey: `${completionKey}:audit`,
          tenant: options.context.tenant,
          actorId: record.actorId,
          action: contract.id,
          outcome: "succeeded",
          occurredAt: record.occurredAt,
          details
        });
        await this.#hooks.idempotency.markArtifactsEmitted(ledgerKey, {
          requestHash,
          artifactsEmittedAt: this.#now().toISOString()
        });
      };
      const ownerToken = randomUUID();
      const claim = await this.#hooks.idempotency.claim(ledgerKey, {
        requestHash,
        ownerToken,
        now: occurredAt
      });
      if (claim.kind === "conflict") {
        throw new CommandBusError(`Idempotency key "${options.idempotencyKey}" is already bound to a different ${contract.id} request.`, "idempotency_conflict");
      }
      if (claim.kind === "replay") {
        let replayed;
        try {
          replayed = contract.output.parse(claim.record.output);
        } catch (error) {
          throw new CommandBusError(error instanceof Error ? error.message : String(error), "invalid_output");
        }
        if (!claim.record.artifactsEmittedAt) {
          try {
            await emitCompletionArtifacts(claim.record);
          } catch (error) {
            throw new CommandBusError(`Command ${contract.id} completed, but its replay-safe artifacts remain pending: ${error instanceof Error ? error.message : String(error)}`, "idempotency_pending");
          }
        }
        return replayed;
      }
      if (claim.kind === "pending") {
        throw new CommandBusError(`Idempotency key "${options.idempotencyKey}" is already executing; retry after ${claim.pendingExpiresAt}.`, "idempotency_pending");
      }
      if (claim.kind === "ambiguous") {
        throw new CommandBusError(`Idempotency key "${options.idempotencyKey}" has an ambiguous outcome and requires reconciliation before retry.`, "idempotency_ambiguous");
      }
      let verified;
      const completionRecord = {
        requestHash,
        output: null,
        occurredAt,
        actorId: options.context.identity.actorId,
        artifactsEmittedAt: null
      };
      try {
        const output = await handler(parsed, { ...options, commandId: contract.id, occurredAt });
        verified = contract.output.parse(output);
        completionRecord.output = verified;
        await this.#hooks.idempotency.complete(ledgerKey, {
          ...completionRecord,
          ownerToken: claim.ownerToken,
          completedAt: this.#now().toISOString()
        });
      } catch (error) {
        if (contract.effect === "read" || error instanceof CommandDefinitiveNoEffectError) {
          await this.#hooks.idempotency.release(ledgerKey, {
            requestHash,
            ownerToken: claim.ownerToken
          });
          if (error instanceof CommandBusError)
            throw error;
          if (error instanceof CommandDefinitiveNoEffectError) {
            throw new CommandBusError(error.message, error.code);
          }
          throw new CommandBusError(error instanceof Error ? error.message : String(error), "handler_failed");
        }
        try {
          await this.#hooks.idempotency.markAmbiguous(ledgerKey, {
            requestHash,
            ownerToken: claim.ownerToken,
            ambiguousAt: this.#now().toISOString()
          });
        } catch {
        }
        if (error instanceof CommandBusError)
          throw error;
        throw new CommandBusError(`Idempotency key "${options.idempotencyKey}" has an ambiguous outcome and requires reconciliation before retry.`, "idempotency_ambiguous");
      }
      try {
        await emitCompletionArtifacts(completionRecord);
      } catch (error) {
        throw new CommandBusError(`Command ${contract.id} completed, but its replay-safe artifacts remain pending: ${error instanceof Error ? error.message : String(error)}`, "idempotency_pending");
      }
      return verified;
    } catch (error) {
      const errorCode = error instanceof CommandBusError ? error.code : "authorization_denied";
      const denialDetails = tenantAuthorized ? { ...details, errorCode } : {
        commandId: contract.id,
        commandVersion: contract.version,
        errorCode
      };
      await (tenantAuthorized ? this.#hooks.audit : this.#hooks.securityAudit).append({
        tenant: tenantAuthorized ? options.context.tenant : COMMAND_SECURITY_AUDIT_TENANT,
        actorId: options.context.identity.actorId,
        action: contract.id,
        outcome: error instanceof CommandBusError && (error.code === "invalid_input" || error.code === "invalid_output" || error.code.startsWith("idempotency_")) ? "failed" : "denied",
        occurredAt,
        details: denialDetails
      });
      if (error instanceof CommandBusError)
        throw error;
      throw new CommandBusError(error instanceof Error ? error.message : String(error), "authorization_denied");
    }
  }
};

// packages/connections/dist/index.js
function selectCommandGrant(grants, commandId, requiredScopes, now = /* @__PURE__ */ new Date()) {
  const grant = grants.find((candidate) => !candidate.revokedAt && Date.parse(candidate.expiresAt) > now.getTime() && (candidate.commandIds.includes(commandId) || candidate.commandIds.includes("*")) && requiredScopes.every((scope) => candidate.scopes.includes(scope)));
  if (!grant)
    throw new Error(`no active grant authorizes ${commandId}`);
  return grant;
}

// packages/entitlements/dist/index.js
function assertEntitlements(actual, required) {
  const missing = required.filter((entitlement) => !actual.includes(entitlement));
  if (missing.length)
    throw new Error(`missing entitlements: ${missing.join(", ")}`);
  return actual;
}

// packages/events/dist/index.js
var InMemoryEventLog = class {
  durability = "fixture_only";
  #events = [];
  append(event) {
    if (this.#events.some(({ eventId }) => eventId === event.eventId))
      return;
    this.#events.push(structuredClone(event));
  }
  read(tenant) {
    const key = tenantKey(tenant);
    return this.#events.filter((event) => tenantKey(event.tenant) === key).map((event) => structuredClone(event));
  }
};

// packages/organizations/dist/index.js
function assertOrganizationMembership(identity, tenant, memberships) {
  const membership = memberships.find((candidate) => candidate.active && candidate.actorId === identity.actorId && candidate.organizationId === tenant.organizationId);
  if (!membership)
    throw new Error("identity is not an active member of the tenant organization");
  return membership;
}

// packages/policy/dist/index.js
function decideScopes(context2, requiredScopes) {
  const missing = requiredScopes.filter((scope) => !context2.scopes.includes(scope));
  return missing.length === 0 ? { allowed: true, reason: "all declared scopes are present" } : { allowed: false, reason: `missing actor scopes: ${missing.join(", ")}` };
}

// packages/telemetry/dist/index.js
var InMemoryMeteringSink = class {
  durability = "fixture_only";
  #records = [];
  record(input) {
    if (input.idempotencyKey && this.#records.some(({ idempotencyKey }) => idempotencyKey === input.idempotencyKey)) {
      return;
    }
    this.#records.push(structuredClone(input));
  }
  read(tenant) {
    const key = tenantKey(tenant);
    return this.#records.filter((record) => tenantKey(record.tenant) === key).map((record) => structuredClone(record));
  }
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result2) => {
  if (isValid(result2)) {
    return { success: true, data: result2.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result2 = this._parse(input);
    if (isAsync(result2)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result2;
  }
  _parseAsync(input) {
    const result2 = this._parse(input);
    return Promise.resolve(result2);
  }
  parse(data, params) {
    const result2 = this.safeParse(data, params);
    if (result2.success)
      return result2.data;
    throw result2.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result2 = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result2);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result2 = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result2) ? {
          value: result2.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result2) => isValid(result2) ? {
      value: result2.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result2 = await this.safeParseAsync(data, params);
    if (result2.success)
      return result2.data;
    throw result2.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result2 = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result2);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result2 = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result2 instanceof Promise) {
        return result2.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result2) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args2) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args2.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args2.precision}}`;
  } else if (args2.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args2.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args2) {
  return new RegExp(`^${timeRegexSource(args2)}$`);
}
function datetimeRegex(args2) {
  let regex = `${dateRegexSource}T${timeRegexSource(args2)}`;
  const opts = [];
  opts.push(args2.local ? `Z?` : `Z`);
  if (args2.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result3) => {
        return ParseStatus.mergeArray(status, result3);
      });
    }
    const result2 = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result2);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result2 of results) {
        if (result2.result.status === "valid") {
          return result2.result;
        }
      }
      for (const result2 of results) {
        if (result2.result.status === "dirty") {
          ctx.common.issues.push(...result2.ctx.common.issues);
          return result2.result;
        }
      }
      const unionErrors = results.map((result2) => new ZodError(result2.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result2 = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result2.status === "valid") {
          return result2;
        } else if (result2.status === "dirty" && !dirty) {
          dirty = { result: result2, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args2, error) {
      return makeIssue({
        data: args2,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args2) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args2, params).catch((e) => {
          error.addIssue(makeArgsIssue(args2, e));
          throw error;
        });
        const result2 = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result2, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result2, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args2) {
        const parsedArgs = me._def.args.safeParse(args2, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args2, parsedArgs.error)]);
        }
        const result2 = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result2, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result2, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args2, returns, params) {
    return new _ZodFunction({
      args: args2 ? args2 : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result2 = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result2.status === "aborted")
            return INVALID;
          if (result2.status === "dirty")
            return DIRTY(result2.value);
          if (status.value === "dirty")
            return DIRTY(result2.value);
          return result2;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result2 = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result2.status === "aborted")
          return INVALID;
        if (result2.status === "dirty")
          return DIRTY(result2.value);
        if (status.value === "dirty")
          return DIRTY(result2.value);
        return result2;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result2 = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result2);
        }
        if (result2 instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result2 = effect.transform(base.value, checkCtx);
        if (result2 instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result2 };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result2) => ({
            status: status.value,
            value: result2
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result2 = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result2)) {
      return result2.then((result3) => {
        return {
          status: "valid",
          value: result3.status === "valid" ? result3.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result2.status === "valid" ? result2.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result2 = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result2) ? result2.then((data) => freeze(data)) : freeze(result2);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// packages/config/dist/growth-contract.js
var providerIdSchema = external_exports.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, "expected a stable provider ID");
var extensionsSchema = external_exports.record(external_exports.unknown()).default({});
function uniqueArray(item) {
  return external_exports.array(item).refine((values) => new Set(values).size === values.length, {
    message: "values must be unique"
  });
}
var minorUnits = external_exports.number().int().nonnegative();
var ratio = external_exports.number().min(0).max(1);
var currencyCode = external_exports.string().regex(/^[A-Z]{3}$/, "expected an ISO 4217 currency code");
var GROWTH_CONTRACT_VERSION = 2;
var optimizationEventSchema = external_exports.enum([
  "install",
  "onboarding_complete",
  "paywall_view",
  "trial_start",
  "purchase",
  "subscription_active",
  "value"
]);
var goalSchema = external_exports.object({
  primary_event: optimizationEventSchema,
  secondary_events: uniqueArray(optimizationEventSchema).default([]),
  current_optimization_event: optimizationEventSchema,
  allowed_fallback_events: uniqueArray(optimizationEventSchema).default([])
}).strict();
var economicsSchema = external_exports.object({
  currency: currencyCode,
  subscription_price_minor: minorUnits,
  billing_period: external_exports.enum(["weekly", "monthly", "quarterly", "annual"]),
  store_fee_rate: ratio,
  tax_rate: ratio,
  refund_rate: ratio,
  variable_serving_cost_minor: minorUnits,
  creative_generation_cost_minor: minorUnits,
  expected_subscriber_lifetime_months: external_exports.number().positive(),
  target_cac_minor: minorUnits,
  hard_max_cac_minor: minorUnits,
  payback_target_days: external_exports.number().int().positive(),
  minimum_contribution_margin_minor: minorUnits,
  d7_retention_floor: ratio,
  d30_retention_floor: ratio,
  d90_retention_floor: ratio,
  refund_rate_ceiling: ratio
}).strict().refine((value) => value.hard_max_cac_minor >= value.target_cac_minor, {
  message: "hard_max_cac_minor must be at least target_cac_minor",
  path: ["hard_max_cac_minor"]
});
var organicSchema = external_exports.object({
  allowed_providers: uniqueArray(providerIdSchema),
  allowed_accounts: uniqueArray(external_exports.string().min(1)),
  max_accounts: external_exports.number().int().positive(),
  max_posts_per_account_per_day: external_exports.number().int().positive(),
  duplicate_content_policy: external_exports.enum(["forbid", "allow_across_accounts", "allow_with_variation"]),
  default_review_mode: external_exports.enum(["AUTOMATIC_WITHIN_POLICY", "REVIEW_BEFORE_PUBLISH", "PLATFORM_DRAFT"]).default("REVIEW_BEFORE_PUBLISH"),
  snapshot_cadence_minutes: uniqueArray(external_exports.number().int().positive()),
  ai_disclosure_required: external_exports.boolean().default(true)
}).strict();
var paidSchema = external_exports.object({
  allowed_networks: uniqueArray(external_exports.enum(["tiktok_paid", "meta_paid"])),
  allowed_accounts: uniqueArray(external_exports.string().min(1)),
  allowed_objectives: uniqueArray(external_exports.string().min(1)),
  allowed_events: uniqueArray(optimizationEventSchema),
  test_budget_minor: minorUnits,
  per_creative_cap_minor: minorUnits,
  daily_account_cap_minor: minorUnits,
  daily_venture_cap_minor: minorUnits,
  monthly_venture_cap_minor: minorUnits,
  daily_customer_cap_minor: minorUnits,
  monthly_customer_cap_minor: minorUnits,
  emergency_platform_cap_minor: minorUnits,
  approval_threshold_minor: minorUnits.default(0),
  auto_pause_allowed: external_exports.boolean().default(true),
  auto_scale_allowed: external_exports.literal(false).default(false),
  vbo_policy: external_exports.enum(["forbidden", "requires_value_ready", "allowed"]).default("forbidden"),
  stop_conditions: external_exports.object({
    max_spend_without_trial_minor: minorUnits,
    max_spend_without_purchase_minor: minorUnits,
    max_cac_breach_count: external_exports.number().int().nonnegative()
  }).strict()
}).strict().refine((value) => value.test_budget_minor >= value.per_creative_cap_minor, {
  message: "test_budget_minor must be at least per_creative_cap_minor",
  path: ["test_budget_minor"]
});
var complianceSchema = external_exports.object({
  rights_required: external_exports.boolean().default(true),
  ai_disclosure_required: external_exports.boolean().default(true),
  prohibited_claims: uniqueArray(external_exports.string().min(1)).default([]),
  allowed_geographies: uniqueArray(external_exports.string().min(2)),
  restricted_audiences: uniqueArray(external_exports.string().min(1)).default([]),
  restricted_categories: uniqueArray(external_exports.string().min(1)).default([]),
  provider_policy_state: external_exports.enum(["unknown", "clear", "warned", "restricted"]).default("unknown")
}).strict();
var growthContractSchema = external_exports.object({
  contract_version: external_exports.literal(GROWTH_CONTRACT_VERSION),
  venture_id: external_exports.string().min(1),
  goal: goalSchema,
  economics: economicsSchema,
  organic: organicSchema,
  paid: paidSchema,
  compliance: complianceSchema,
  extensions: extensionsSchema
}).strict();
function migrateGrowthContract(value) {
  const current = growthContractSchema.safeParse(value);
  if (current.success)
    return current.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw current.error;
  }
  const legacy = value;
  const legacyPaid = legacy.paid;
  if (legacy.contract_version !== 1 || !legacyPaid || typeof legacyPaid !== "object" || Array.isArray(legacyPaid)) {
    throw current.error;
  }
  const paidRecord = legacyPaid;
  const legacyBudget = paidRecord.per_creative_test_budget_minor;
  const paidWithoutLegacyBudget = { ...paidRecord };
  delete paidWithoutLegacyBudget.per_creative_test_budget_minor;
  return growthContractSchema.parse({
    ...legacy,
    contract_version: GROWTH_CONTRACT_VERSION,
    paid: {
      ...paidWithoutLegacyBudget,
      test_budget_minor: legacyBudget,
      per_creative_cap_minor: legacyBudget
    }
  });
}
function parseGrowthContract(value) {
  return migrateGrowthContract(value);
}

// packages/config/dist/index.js
function defineRuntimeSchema(schema) {
  return Object.freeze(schema);
}
function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}
function stringValue(record, field, options = {}) {
  const value = record[field];
  if (value === void 0 && options.optional)
    return void 0;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a string`);
  if (options.allowed && !options.allowed.includes(value)) {
    throw new Error(`${field} must be one of ${options.allowed.join(", ")}`);
  }
  return value;
}
function schemaObject(properties, required) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

// packages/agent-runtime/dist/contracts.js
var campaignInput = defineRuntimeSchema({
  name: "CampaignLaunchInput",
  jsonSchema: schemaObject({
    campaignId: { type: "string", minLength: 1 },
    channel: { type: "string", enum: ["organic", "paid"] },
    objective: { type: "string", minLength: 1 }
  }, ["campaignId", "channel", "objective"]),
  parse(value) {
    const input = objectValue(value, "CampaignLaunchInput");
    return {
      campaignId: stringValue(input, "campaignId"),
      channel: stringValue(input, "channel", { allowed: ["organic", "paid"] }),
      objective: stringValue(input, "objective")
    };
  }
});
var campaignOutput = defineRuntimeSchema({
  name: "CampaignLaunchOutput",
  jsonSchema: schemaObject({
    commandId: { const: "campaigns.launch" },
    ventureId: { type: "string" },
    campaignId: { type: "string" },
    channel: { type: "string", enum: ["organic", "paid"] },
    status: { const: "planned" }
  }, ["commandId", "ventureId", "campaignId", "channel", "status"]),
  parse(value) {
    const output = objectValue(value, "CampaignLaunchOutput");
    if (output.commandId !== "campaigns.launch" || output.status !== "planned")
      throw new Error("invalid campaign launch output");
    return {
      commandId: "campaigns.launch",
      ventureId: stringValue(output, "ventureId"),
      campaignId: stringValue(output, "campaignId"),
      channel: stringValue(output, "channel", { allowed: ["organic", "paid"] }),
      status: "planned"
    };
  }
});
var launchInput = defineRuntimeSchema({
  name: "LaunchExecuteInput",
  jsonSchema: schemaObject({
    launchId: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["preview", "production"] },
    dryRun: { type: "boolean" }
  }, ["launchId", "mode", "dryRun"]),
  parse(value) {
    const input = objectValue(value, "LaunchExecuteInput");
    if (typeof input.dryRun !== "boolean")
      throw new Error("dryRun must be a boolean");
    return {
      launchId: stringValue(input, "launchId"),
      mode: stringValue(input, "mode", { allowed: ["preview", "production"] }),
      dryRun: input.dryRun
    };
  }
});
var launchOutput = defineRuntimeSchema({
  name: "LaunchExecuteOutput",
  jsonSchema: schemaObject({
    commandId: { const: "launch.execute" },
    ventureId: { type: "string" },
    runId: { type: "string" },
    mode: { type: "string", enum: ["preview", "production"] },
    status: { const: "accepted" },
    dryRun: { type: "boolean" }
  }, ["commandId", "ventureId", "runId", "mode", "status", "dryRun"]),
  parse(value) {
    const output = objectValue(value, "LaunchExecuteOutput");
    if (output.commandId !== "launch.execute" || output.status !== "accepted" || typeof output.dryRun !== "boolean") {
      throw new Error("invalid launch execution output");
    }
    return {
      commandId: "launch.execute",
      ventureId: stringValue(output, "ventureId"),
      runId: stringValue(output, "runId"),
      mode: stringValue(output, "mode", { allowed: ["preview", "production"] }),
      status: "accepted",
      dryRun: output.dryRun
    };
  }
});
var campaignLaunchCommand = defineCommandContract({
  id: "campaigns.launch",
  version: 1,
  title: "Launch Campaign",
  description: "Plan one venture campaign through its declared channel.",
  input: campaignInput,
  output: campaignOutput,
  requirements: {
    activeSubscription: true,
    entitlements: ["campaigns.launch"],
    grant: true,
    scopes: ["campaigns:write"]
  },
  meter: "campaign_launches"
});
var launchExecuteCommand = defineCommandContract({
  id: "launch.execute",
  version: 1,
  title: "Execute Venture Launch",
  description: "Accept one authorized preview or production launch run.",
  input: launchInput,
  output: launchOutput,
  requirements: {
    activeSubscription: true,
    entitlements: ["launch.execute"],
    grant: true,
    scopes: ["launch:execute"]
  },
  meter: "launch_runs"
});

// packages/agent-runtime/dist/operational.js
import { createHash as createHash4, randomUUID as randomUUID2 } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

// packages/agent-runtime/dist/quality.js
var QUALITY_PROFILE_IDS = ["fast", "mvp", "release"];
var unconfiguredQualityProfileRunner = Object.freeze({
  async run(profile) {
    return {
      profile,
      status: "INCOMPLETE",
      exitCode: 1,
      summary: { PASS: 0, FAIL: 0, SKIP: 1, NOT_APPLICABLE: 0 },
      command: [],
      stdout: "",
      stderr: "No repository quality-profile runner is configured; no verification command ran.",
      reportPath: null
    };
  }
});

// packages/agent-runtime/dist/platform-operations.js
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
var SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/*-]{0,254}$/u;
var CREDENTIAL_REF = /^cred:\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
var SECRET_VALUE = /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|ghp|github_pat)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;
function exactObject(value, name, allowed) {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  }
  return record;
}
function safeId(record, field) {
  const value = stringValue(record, field);
  if (value !== value.trim() || !SAFE_ID.test(value)) {
    throw new Error(`${field} must be a canonical identifier of at most 255 characters`);
  }
  return value;
}
function optionalSafeId(record, field) {
  if (record[field] === void 0)
    return void 0;
  return safeId(record, field);
}
function credentialRef(record, optional = false) {
  const value = stringValue(record, "credentialRef", { optional });
  if (value === void 0)
    return void 0;
  if (!CREDENTIAL_REF.test(value)) {
    throw new Error("credentialRef must be a metadata-only cred:// reference");
  }
  return value;
}
function safeStringArray(value, field, pattern) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  const parsed = value.map((item) => item.trim());
  if (parsed.some((item) => !pattern.test(item))) {
    throw new Error(`${field} contains an invalid identifier`);
  }
  if (new Set(parsed).size !== parsed.length)
    throw new Error(`${field} must not contain duplicates`);
  return parsed;
}
function assertJsonSafe(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:password|secret|accessToken|refreshToken|apiKey|privateKey)$/iu.test(key)) {
        throw new Error(`secret-bearing output field ${path}.${key} is forbidden`);
      }
      assertJsonSafe(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`${path} must be JSON serializable`);
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new Error(`credential-like value is forbidden at ${path}`);
  }
}
var authLoginInput = defineRuntimeSchema({
  name: "AuthLoginInput",
  jsonSchema: schemaObject({
    providerId: { type: "string", minLength: 1, maxLength: 255 },
    credentialRef: { type: "string", pattern: "^cred://" },
    backend: { type: "string", minLength: 1, maxLength: 255 },
    kind: { type: "string", minLength: 1, maxLength: 255 },
    scopes: { type: "array", items: { type: "string" }, default: [] }
  }, ["providerId"]),
  parse(value) {
    const input = exactObject(value, "AuthLoginInput", [
      "providerId",
      "credentialRef",
      "backend",
      "kind",
      "scopes"
    ]);
    const parsed = {
      providerId: safeId(input, "providerId"),
      ...credentialRef(input, true) ? { credentialRef: credentialRef(input, true) } : {},
      ...optionalSafeId(input, "backend") ? { backend: optionalSafeId(input, "backend") } : {},
      ...optionalSafeId(input, "kind") ? { kind: optionalSafeId(input, "kind") } : {},
      scopes: input.scopes === void 0 ? [] : safeStringArray(input.scopes, "scopes", SAFE_SCOPE)
    };
    assertJsonSafe(parsed, "auth.login");
    return parsed;
  }
});
var authInspectInput = defineRuntimeSchema({
  name: "AuthInspectInput",
  jsonSchema: schemaObject({
    providerId: { type: "string", minLength: 1, maxLength: 255 },
    credentialRef: { type: "string", pattern: "^cred://" }
  }, []),
  parse(value) {
    const input = exactObject(value, "AuthInspectInput", ["providerId", "credentialRef"]);
    return {
      ...optionalSafeId(input, "providerId") ? { providerId: optionalSafeId(input, "providerId") } : {},
      ...credentialRef(input, true) ? { credentialRef: credentialRef(input, true) } : {}
    };
  }
});
var upgradeReleaseInput = defineRuntimeSchema({
  name: "UpgradeReleaseInput",
  jsonSchema: schemaObject({ releaseLocator: { type: "string", minLength: 1, maxLength: 4096 } }, [
    "releaseLocator"
  ]),
  parse(value) {
    const input = exactObject(value, "UpgradeReleaseInput", ["releaseLocator"]);
    const releaseLocator = stringValue(input, "releaseLocator").trim();
    if (releaseLocator.length > 4096 || releaseLocator.includes("\0")) {
      throw new Error("releaseLocator must be a local path of at most 4096 characters");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(releaseLocator)) {
      throw new Error("releaseLocator must be a trusted local filesystem path, not a URL");
    }
    assertJsonSafe(releaseLocator, "releaseLocator");
    return { releaseLocator };
  }
});
var emptyPlatformInput = defineRuntimeSchema({
  name: "EmptyPlatformInput",
  jsonSchema: schemaObject({}, []),
  parse(value) {
    exactObject(value, "EmptyPlatformInput", []);
    return {};
  }
});
var fleetStatusInput = defineRuntimeSchema({
  name: "FleetStatusInput",
  jsonSchema: schemaObject({ runId: { type: "string", minLength: 1, maxLength: 255 } }, []),
  parse(value) {
    const input = exactObject(value, "FleetStatusInput", ["runId"]);
    const runId2 = optionalSafeId(input, "runId");
    if (runId2)
      return { runId: runId2 };
    return {};
  }
});
var fleetOperationInput = defineRuntimeSchema({
  name: "FleetOperationInput",
  jsonSchema: schemaObject({
    runId: { type: "string", minLength: 1, maxLength: 255 },
    releaseId: { type: "string", minLength: 1, maxLength: 255 },
    ventureIds: { type: "array", items: { type: "string" }, minItems: 1 },
    batchSize: { type: "integer", minimum: 1 }
  }, ["runId", "releaseId", "ventureIds", "batchSize"]),
  parse(value) {
    const input = exactObject(value, "FleetOperationInput", [
      "runId",
      "releaseId",
      "ventureIds",
      "batchSize"
    ]);
    if (!Number.isSafeInteger(input.batchSize) || Number(input.batchSize) < 1) {
      throw new Error("batchSize must be a positive safe integer");
    }
    return {
      runId: safeId(input, "runId"),
      releaseId: safeId(input, "releaseId"),
      ventureIds: safeStringArray(input.ventureIds, "ventureIds", SAFE_ID),
      batchSize: Number(input.batchSize)
    };
  }
});
function outputSchema(commandId) {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject({
      commandId: { const: commandId },
      mode: { type: "string", enum: ["read_only", "local_write", "external_write"] },
      status: { type: "string", minLength: 1, maxLength: 255 },
      data: { type: "object" }
    }, ["commandId", "mode", "status", "data"]),
    parse(value) {
      const output = exactObject(value, `${commandId}Output`, [
        "commandId",
        "mode",
        "status",
        "data"
      ]);
      if (output.commandId !== commandId)
        throw new Error(`invalid ${commandId} output`);
      const mode = stringValue(output, "mode", {
        allowed: ["read_only", "local_write", "external_write"]
      });
      const data = objectValue(output.data, "data");
      assertJsonSafe(data, `${commandId}.data`);
      return { commandId, mode, status: safeId(output, "status"), data };
    }
  });
}
function platformCommand(definition) {
  return defineCommandContract({
    ...definition,
    version: 1,
    output: outputSchema(definition.id),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant: true,
      scopes: definition.scopes
    }
  });
}
var authLoginCommand = platformCommand({
  id: "auth.login",
  title: "Authenticate Provider",
  description: "Use an explicitly injected official login adapter and persist metadata-only credential references.",
  input: authLoginInput,
  effect: "write",
  scopes: ["auth.manage"],
  meter: "auth_mutations"
});
var authStatusCommand = platformCommand({
  id: "auth.status",
  title: "Inspect Authentication",
  description: "Inspect credential-reference state without exposing credential values.",
  input: authInspectInput,
  effect: "read",
  scopes: ["auth.read"]
});
var authTestCommand = platformCommand({
  id: "auth.test",
  title: "Test Authentication",
  description: "Run an injected official read check and persist sanitized test evidence.",
  input: authInspectInput,
  effect: "write",
  scopes: ["auth.test"],
  meter: "auth_tests"
});
var authRevokeCommand = platformCommand({
  id: "auth.revoke",
  title: "Revoke Authentication",
  description: "Disable a credential reference locally and invoke only an injected revoke adapter.",
  input: authInspectInput,
  effect: "write",
  scopes: ["auth.manage"],
  meter: "auth_mutations"
});
var upgradePlanCommand = platformCommand({
  id: "upgrade.plan",
  title: "Plan Harness Upgrade",
  description: "Plan a trusted local release without changing the project.",
  input: upgradeReleaseInput,
  effect: "read",
  scopes: ["upgrade.read"]
});
var upgradeDryRunCommand = platformCommand({
  id: "upgrade.dry-run",
  title: "Dry Run Harness Upgrade",
  description: "Validate a trusted local release and report its reversible local changes.",
  input: upgradeReleaseInput,
  effect: "read",
  scopes: ["upgrade.read"]
});
var upgradeApplyCommand = platformCommand({
  id: "upgrade.apply",
  title: "Apply Harness Upgrade",
  description: "Apply one trusted local release through the host upgrade transaction and checks.",
  input: upgradeReleaseInput,
  effect: "write",
  scopes: ["upgrade.apply"],
  meter: "upgrade_applies"
});
var upgradeStatusCommand = platformCommand({
  id: "upgrade.status",
  title: "Inspect Harness Version",
  description: "Inspect the current local harness lock without locating or applying a release.",
  input: emptyPlatformInput,
  effect: "read",
  scopes: ["upgrade.read"]
});
var fleetStatusCommand = platformCommand({
  id: "fleet.status",
  title: "Inspect Fleet Run",
  description: "Read a durable Fleet run or the sanitized configured target catalog.",
  input: fleetStatusInput,
  effect: "read",
  scopes: ["fleet.read"]
});
var fleetPlanCommand = platformCommand({
  id: "fleet.plan",
  title: "Plan Fleet Rollout",
  description: "Resolve an exact tenant-bound release and Fleet selection without running hooks.",
  input: fleetOperationInput,
  effect: "read",
  scopes: ["fleet.read"]
});
var fleetRolloutCommand = platformCommand({
  id: "fleet.rollout",
  title: "Roll Out Fleet Release",
  description: "Run the durable canary and batch Fleet controller through injected venture hooks.",
  input: fleetOperationInput,
  effect: "write",
  scopes: ["fleet.rollout"],
  meter: "fleet_rollouts"
});
var fleetResumeCommand = platformCommand({
  id: "fleet.resume",
  title: "Resume Fleet Rollout",
  description: "Resume one durable Fleet run without repeating completed phase effects.",
  input: fleetOperationInput,
  effect: "write",
  scopes: ["fleet.rollout"],
  meter: "fleet_rollouts"
});
var authCommandContracts = [
  authLoginCommand,
  authStatusCommand,
  authTestCommand,
  authRevokeCommand
];
var upgradeCommandContracts = [
  upgradePlanCommand,
  upgradeDryRunCommand,
  upgradeApplyCommand,
  upgradeStatusCommand
];
var fleetCommandContracts = [
  fleetStatusCommand,
  fleetPlanCommand,
  fleetRolloutCommand,
  fleetResumeCommand
];
var platformOperationCommandContracts = [
  ...authCommandContracts,
  ...upgradeCommandContracts,
  ...fleetCommandContracts
];
function unconfigured(domain, action) {
  return {
    status: "unconfigured",
    effect: "none",
    data: {
      diagnostic: {
        code: `${domain}_runtime_unconfigured`,
        message: `No trusted ${domain} runtime is configured for ${action}`,
        nextAction: `Load an explicit project-owned production runtime module with a ${domain} binding`
      }
    }
  };
}
var unconfiguredAuthCommandRuntime = Object.freeze({
  execute: (action) => unconfigured("auth", action)
});
var unconfiguredUpgradeCommandRuntime = Object.freeze({
  execute: (action) => unconfigured("upgrade", action)
});
var unconfiguredFleetCommandRuntime = Object.freeze({
  execute: (action) => unconfigured("fleet", action)
});
var FAILURE_STATUSES = /* @__PURE__ */ new Set(["unconfigured", "context_unavailable", "blocked", "failed"]);
function failureMessage(boundary, fallback) {
  const diagnostic = boundary.data.diagnostic;
  if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
    const record = diagnostic;
    const code = typeof record.code === "string" ? record.code : "platform_command_failed";
    const message = typeof record.message === "string" ? record.message : fallback;
    return `${code}: ${message}`;
  }
  return fallback;
}
function register(options) {
  options.bus.register(options.contract, async (input, context2) => {
    const boundary = await options.invoke(options.action, input, context2);
    assertJsonSafe(boundary.data, `${options.contract.id}.boundary`);
    if (FAILURE_STATUSES.has(boundary.status)) {
      const message = failureMessage(boundary, `${options.contract.id} did not complete successfully`);
      if (boundary.effect === "none") {
        throw new CommandDefinitiveNoEffectError(message, "handler_failed");
      }
      throw new Error(message);
    }
    return {
      commandId: options.contract.id,
      mode: options.mode,
      status: boundary.status,
      data: boundary.data
    };
  });
}
function registerPlatformOperationCommands(bus, runtimes = {}) {
  const auth = runtimes.auth ?? unconfiguredAuthCommandRuntime;
  const upgrade = runtimes.upgrade ?? unconfiguredUpgradeCommandRuntime;
  const fleet = runtimes.fleet ?? unconfiguredFleetCommandRuntime;
  register({
    bus,
    contract: authLoginCommand,
    action: "login",
    mode: "external_write",
    invoke: auth.execute.bind(auth)
  });
  register({
    bus,
    contract: authStatusCommand,
    action: "status",
    mode: "read_only",
    invoke: auth.execute.bind(auth)
  });
  register({
    bus,
    contract: authTestCommand,
    action: "test",
    mode: "local_write",
    invoke: auth.execute.bind(auth)
  });
  register({
    bus,
    contract: authRevokeCommand,
    action: "revoke",
    mode: "external_write",
    invoke: auth.execute.bind(auth)
  });
  register({
    bus,
    contract: upgradePlanCommand,
    action: "plan",
    mode: "read_only",
    invoke: upgrade.execute.bind(upgrade)
  });
  register({
    bus,
    contract: upgradeDryRunCommand,
    action: "dry_run",
    mode: "read_only",
    invoke: upgrade.execute.bind(upgrade)
  });
  register({
    bus,
    contract: upgradeApplyCommand,
    action: "apply",
    mode: "local_write",
    invoke: upgrade.execute.bind(upgrade)
  });
  register({
    bus,
    contract: upgradeStatusCommand,
    action: "status",
    mode: "read_only",
    invoke: upgrade.execute.bind(upgrade)
  });
  register({
    bus,
    contract: fleetStatusCommand,
    action: "status",
    mode: "read_only",
    invoke: fleet.execute.bind(fleet)
  });
  register({
    bus,
    contract: fleetPlanCommand,
    action: "plan",
    mode: "read_only",
    invoke: fleet.execute.bind(fleet)
  });
  register({
    bus,
    contract: fleetRolloutCommand,
    action: "rollout",
    mode: "external_write",
    invoke: fleet.execute.bind(fleet)
  });
  register({
    bus,
    contract: fleetResumeCommand,
    action: "resume",
    mode: "external_write",
    invoke: fleet.execute.bind(fleet)
  });
}

// packages/agent-runtime/dist/loop-operations.js
import { createHash as createHash3 } from "node:crypto";
var LEARNING_CADENCE_LOOP_IDS = Object.freeze({
  daily: "daily_early_signal",
  weekly: "weekly_growth",
  biweekly: "biweekly_product",
  monthly: "monthly_strategy"
});
function runId(input, handler) {
  const binding = stableJson({
    actorId: handler.context.identity.actorId,
    cadence: input.cadence,
    commandId: handler.commandId,
    idempotencyKey: handler.idempotencyKey,
    tenant: {
      organizationId: handler.context.tenant.organizationId,
      ventureId: handler.context.tenant.ventureId
    }
  });
  return `learn-${input.cadence}-${createHash3("sha256").update(binding).digest("hex").slice(0, 32)}`;
}
function sourceEvidenceRefs(run) {
  return [
    ...new Set(run.evaluations.flatMap(({ sources }) => sources.flatMap(({ evidenceRefs }) => evidenceRefs)))
  ].sort();
}
function learningOutput(cadence, run) {
  if (run.actions.some(({ action }) => action.effect !== "none")) {
    throw new Error("report/propose learning cadences cannot apply effects");
  }
  if (run.status === "running" || run.status === "waiting_for_reconciliation") {
    throw new Error("report/propose learning cadence did not reach a terminal result");
  }
  return {
    commandId: "learn.run",
    mode: "local_write",
    status: run.status,
    data: {
      cadence,
      loopId: run.loopId,
      runId: run.runId,
      trigger: run.trigger,
      stopReason: run.stopReason,
      completionSatisfied: run.evaluations.at(-1)?.completionSatisfied === true,
      iterationCount: run.evaluations.length,
      actions: run.actions,
      actionsApplied: 0,
      evidenceRefs: sourceEvidenceRefs(run),
      limitations: run.limitations,
      output: run.output,
      updatedAt: run.updatedAt,
      externalEffects: false
    }
  };
}
async function runLearningCadence(runtime, input, handler) {
  const loopId = LEARNING_CADENCE_LOOP_IDS[input.cadence];
  const run = await runtime.run({
    loopId,
    tenant: handler.context.tenant,
    runId: runId(input, handler)
  });
  if (run.loopId !== loopId)
    throw new Error("learning loop returned a different cadence");
  return learningOutput(input.cadence, run);
}

// packages/agent-runtime/dist/operational.js
function emptyState() {
  return { schemaVersion: 1, ideas: {}, ventures: {}, plans: {}, runs: {} };
}
function cloneState(state) {
  return structuredClone(state);
}
function assertRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}
function parseState(value) {
  const document = assertRecord(value, "operational state");
  if (document.schemaVersion !== 1)
    throw new Error("unsupported operational state schema");
  return {
    schemaVersion: 1,
    ideas: assertRecord(document.ideas, "ideas"),
    ventures: assertRecord(document.ventures, "ventures"),
    plans: assertRecord(document.plans, "plans"),
    runs: assertRecord(document.runs, "runs")
  };
}
var SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/i,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}/i,
  /"(?:password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)"\s*:/i
];
function assertNoSecrets(value) {
  const serialized = JSON.stringify(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error("credential-like material is forbidden in operational command state");
  }
}
var InMemoryOperationalStateStore = class {
  description = "memory";
  #state = emptyState();
  read() {
    return cloneState(this.#state);
  }
  write(state) {
    assertNoSecrets(state);
    this.#state = cloneState(state);
  }
};
var FileOperationalStateStore = class {
  rootDir;
  path;
  constructor(rootDir = resolve(process.cwd(), ".venture-harness")) {
    this.rootDir = resolve(rootDir);
    this.path = join(this.rootDir, "operational-state.json");
  }
  get description() {
    return this.path;
  }
  read() {
    if (!existsSync(this.path))
      return emptyState();
    return parseState(JSON.parse(readFileSync(this.path, "utf8")));
  }
  write(state) {
    assertNoSecrets(state);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(this.rootDir, `.operational-state-${randomUUID2()}.tmp`);
    const handle = openSync(temporary, "wx", 384);
    try {
      writeFileSync(handle, `${JSON.stringify(state, null, 2)}
`, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, this.path);
  }
};
function exactObject2(value, name, allowed) {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  return record;
}
function safeId2(record, field) {
  const value = stringValue(record, field);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value)) {
    throw new Error(`${field} must contain 2-64 letters, digits, dots, underscores, or hyphens`);
  }
  return value;
}
var emptyInput = defineRuntimeSchema({
  name: "EmptyOperationalInput",
  jsonSchema: schemaObject({}, []),
  parse(value) {
    exactObject2(value, "EmptyOperationalInput", []);
    return {};
  }
});
var ventureIdentityInput = defineRuntimeSchema({
  name: "VentureIdentityInput",
  jsonSchema: schemaObject({ ventureId: { type: "string", minLength: 2, maxLength: 64 } }, [
    "ventureId"
  ]),
  parse(value) {
    const input = exactObject2(value, "VentureIdentityInput", ["ventureId"]);
    return { ventureId: safeId2(input, "ventureId") };
  }
});
var runIdentityInput = defineRuntimeSchema({
  name: "RunIdentityInput",
  jsonSchema: schemaObject({ runId: { type: "string", minLength: 2, maxLength: 64 } }, ["runId"]),
  parse(value) {
    const input = exactObject2(value, "RunIdentityInput", ["runId"]);
    return { runId: safeId2(input, "runId") };
  }
});
var ideaCompileInput = defineRuntimeSchema({
  name: "IdeaCompileInput",
  jsonSchema: schemaObject({
    idea: { type: "string", minLength: 3, maxLength: 1e4 },
    ventureId: { type: "string", minLength: 2, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 120 }
  }, ["idea", "ventureId", "name"]),
  parse(value) {
    const input = exactObject2(value, "IdeaCompileInput", ["idea", "ventureId", "name"]);
    const parsed = {
      idea: stringValue(input, "idea").trim(),
      ventureId: safeId2(input, "ventureId"),
      name: stringValue(input, "name").trim()
    };
    if (parsed.idea.length > 1e4)
      throw new Error("idea must be at most 10000 characters");
    if (parsed.name.length > 120)
      throw new Error("name must be at most 120 characters");
    assertNoSecrets(parsed);
    return parsed;
  }
});
var ventureCreateInput = defineRuntimeSchema({
  name: "VentureCreateInput",
  jsonSchema: schemaObject({
    ventureId: { type: "string", minLength: 2, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 120 }
  }, ["ventureId", "name"]),
  parse(value) {
    const input = exactObject2(value, "VentureCreateInput", ["ventureId", "name"]);
    const name = stringValue(input, "name").trim();
    if (name.length > 120)
      throw new Error("name must be at most 120 characters");
    return { ventureId: safeId2(input, "ventureId"), name };
  }
});
var ventureLaunchInput = defineRuntimeSchema({
  name: "VentureLaunchInput",
  jsonSchema: schemaObject({
    ventureId: { type: "string", minLength: 2, maxLength: 64 },
    runId: { type: "string", minLength: 2, maxLength: 64 },
    dryRun: { const: true }
  }, ["ventureId", "runId", "dryRun"]),
  parse(value) {
    const input = exactObject2(value, "VentureLaunchInput", ["ventureId", "runId", "dryRun"]);
    if (input.dryRun !== true) {
      throw new Error("the packaged local runtime permits dryRun=true only; no provider effect ran");
    }
    return {
      ventureId: safeId2(input, "ventureId"),
      runId: safeId2(input, "runId"),
      dryRun: true
    };
  }
});
var learningRunInput = defineRuntimeSchema({
  name: "LearningRunInput",
  jsonSchema: schemaObject({ cadence: { type: "string", enum: ["daily", "weekly", "biweekly", "monthly"] } }, ["cadence"]),
  parse(value) {
    const input = exactObject2(value, "LearningRunInput", ["cadence"]);
    return {
      cadence: stringValue(input, "cadence", {
        allowed: ["daily", "weekly", "biweekly", "monthly"]
      })
    };
  }
});
var verifyRunInput = defineRuntimeSchema({
  name: "VerifyRunInput",
  jsonSchema: schemaObject({ profile: { type: "string", enum: [...QUALITY_PROFILE_IDS] } }, [
    "profile"
  ]),
  parse(value) {
    const input = exactObject2(value, "VerifyRunInput", ["profile"]);
    return {
      profile: stringValue(input, "profile", {
        allowed: QUALITY_PROFILE_IDS
      })
    };
  }
});
var growthInspectInput = defineRuntimeSchema({
  name: "GrowthInspectInput",
  jsonSchema: schemaObject({ path: { type: "string", minLength: 1, maxLength: 4096, default: "config/growth.yaml" } }, []),
  parse(value) {
    const input = exactObject2(value, "GrowthInspectInput", ["path"]);
    const path = (stringValue(input, "path", { optional: true }) ?? "config/growth.yaml").trim();
    if (path.length > 4096)
      throw new Error("path must be at most 4096 characters");
    if (!/\.ya?ml$/i.test(path))
      throw new Error("growth contract path must end in .yaml or .yml");
    assertNoSecrets({ path });
    return { path };
  }
});
function outputSchema2(commandId) {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject({
      commandId: { const: commandId },
      mode: { type: "string", enum: ["read_only", "local_write", "dry_run", "pending"] },
      status: { type: "string", minLength: 1 },
      data: { type: "object" }
    }, ["commandId", "mode", "status", "data"]),
    parse(value) {
      const output = exactObject2(value, `${commandId}Output`, [
        "commandId",
        "mode",
        "status",
        "data"
      ]);
      if (output.commandId !== commandId)
        throw new Error(`invalid ${commandId} output`);
      const mode = stringValue(output, "mode", {
        allowed: ["read_only", "local_write", "dry_run", "pending"]
      });
      const data = objectValue(output.data, "data");
      return {
        commandId,
        mode,
        status: stringValue(output, "status"),
        data
      };
    }
  });
}
function operationalCommand(definition) {
  return defineCommandContract({
    ...definition,
    effect: definition.effect ?? "read",
    version: 1,
    output: outputSchema2(definition.id),
    requirements: { activeSubscription: false, entitlements: [], grant: false, scopes: [] }
  });
}
var systemDoctorCommand = operationalCommand({
  id: "system.doctor",
  title: "Inspect Packaged Runtime",
  description: "Inspect local packaged-runtime readiness without contacting a provider.",
  input: emptyInput
});
var organizationListCommand = operationalCommand({
  id: "org.list",
  title: "List Organizations",
  description: "List the current local organization boundary.",
  input: emptyInput
});
var stackListCommand = operationalCommand({
  id: "stack.list",
  title: "List Stack Profiles",
  description: "List bundled provider-neutral stack profiles and their effect posture.",
  input: emptyInput
});
var packListCommand = operationalCommand({
  id: "pack.list",
  title: "List Packs",
  description: "List bundled command and runtime packs without installing anything.",
  input: emptyInput
});
var seedListCommand = operationalCommand({
  id: "seed.list",
  title: "List Venture Seeds",
  description: "List known venture seed rails without claiming that templates were materialized.",
  input: emptyInput
});
var grantListCommand = operationalCommand({
  id: "grant.list",
  title: "List Grants",
  description: "List sanitized grants visible in the current invocation context.",
  input: emptyInput
});
var providerListCommand = operationalCommand({
  id: "provider.list",
  title: "List Providers",
  description: "List provider capabilities as unconfigured; no authentication or network probe occurs.",
  input: emptyInput
});
var verifyRunCommand = operationalCommand({
  id: "verify.run",
  title: "Run Repository Quality Profile",
  description: "Execute the selected fast, MVP, or release quality profile and preserve failures and incomplete checks.",
  input: verifyRunInput
});
var dataSyncCommand = operationalCommand({
  id: "data.sync",
  title: "Inspect Data Sync",
  description: "Return an explicit skipped result when no read-only connector is configured.",
  input: emptyInput
});
var learningRunCommand = operationalCommand({
  id: "learn.run",
  title: "Inspect Learning Cadence",
  description: "Evaluate cadence readiness without inventing evidence or applying an action.",
  input: learningRunInput
});
var growthInspectCommand = operationalCommand({
  id: "growth.inspect",
  title: "Inspect Growth Contract",
  description: "Validate and summarize a local Growth Contract without persisting it or contacting a provider.",
  input: growthInspectInput
});
var ideaCompileCommand = operationalCommand({
  id: "idea.compile",
  title: "Compile Venture Idea",
  description: "Compile and persist one local founder idea with explicit assumptions.",
  input: ideaCompileInput,
  effect: "write"
});
var ventureCreateCommand = operationalCommand({
  id: "venture.create",
  title: "Create Local Venture",
  description: "Create a local venture from a previously compiled idea.",
  input: ventureCreateInput,
  effect: "write"
});
var venturePlanCommand = operationalCommand({
  id: "venture.plan",
  title: "Plan Local Venture",
  description: "Persist a provider-neutral, no-effect local venture plan.",
  input: ventureIdentityInput,
  effect: "write"
});
var ventureLaunchCommand = operationalCommand({
  id: "venture.launch",
  title: "Dry Launch Local Venture",
  description: "Persist a dry launch run; production/provider effects are not available.",
  input: ventureLaunchInput,
  effect: "write"
});
var ventureStatusCommand = operationalCommand({
  id: "venture.status",
  title: "Inspect Venture Status",
  description: "Read one locally persisted venture and its latest plan/run status.",
  input: ventureIdentityInput
});
var ventureResumeCommand = operationalCommand({
  id: "venture.resume",
  title: "Resume Local Dry Run",
  description: "Reload a persisted dry run without repeating or introducing an effect.",
  input: runIdentityInput
});
var runListCommand = operationalCommand({
  id: "run.list",
  title: "List Local Runs",
  description: "List locally persisted dry runs.",
  input: emptyInput
});
var runStatusCommand = operationalCommand({
  id: "run.status",
  title: "Inspect Local Run",
  description: "Read one locally persisted dry run.",
  input: runIdentityInput
});
var operationalCommandContracts = [
  systemDoctorCommand,
  organizationListCommand,
  stackListCommand,
  packListCommand,
  seedListCommand,
  grantListCommand,
  providerListCommand,
  ...platformOperationCommandContracts,
  verifyRunCommand,
  dataSyncCommand,
  learningRunCommand,
  growthInspectCommand,
  ideaCompileCommand,
  ventureCreateCommand,
  venturePlanCommand,
  ventureLaunchCommand,
  ventureStatusCommand,
  ventureResumeCommand,
  runListCommand,
  runStatusCommand
];
function result(commandId, mode, status, data) {
  return { commandId, mode, status, data };
}
function stateValues(records) {
  return Object.values(records).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}
function latestForVenture(records, organizationId, ventureId2) {
  return Object.values(records).filter((record) => record.organizationId === organizationId && record.ventureId === ventureId2).sort((left, right) => (left.updatedAt ?? left.createdAt).localeCompare(right.updatedAt ?? right.createdAt)).at(-1) ?? null;
}
function recordKey(organizationId, id) {
  return `${organizationId.length}:${organizationId}:${id}`;
}
var MAX_GROWTH_CONTRACT_BYTES = 1024 * 1024;
function growthContractVersion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return null;
  const version = value.contract_version;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}
function pathEscapesRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}
function assertGrowthPath(root, inputPath) {
  const candidate = resolve(root.declaredPath, inputPath);
  if (pathEscapesRoot(root.declaredPath, candidate)) {
    throw new Error("growth contract path must stay within the configured root");
  }
  const pathFromRoot = relative(root.declaredPath, candidate);
  let current = root.declaredPath;
  try {
    for (const component of pathFromRoot.split(sep).filter(Boolean)) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("growth contract path must not contain symbolic links");
      }
    }
    const details = lstatSync(candidate);
    if (!details.isFile())
      throw new Error("growth contract path must reference a regular file");
    const canonical = realpathSync(candidate);
    if (pathEscapesRoot(root.canonicalPath, canonical)) {
      throw new Error("growth contract path must stay within the configured root");
    }
    return { path: canonical, displayPath: relative(root.canonicalPath, canonical) };
  } catch (error) {
    if (error instanceof Error && (error.message.includes("symbolic links") || error.message.includes("regular file"))) {
      throw error;
    }
    throw new Error("growth contract file could not be read");
  }
}
function inspectGrowthContract(input, growthContractRoot) {
  const source = assertGrowthPath(growthContractRoot, input.path);
  let text;
  let handle;
  try {
    handle = openSync(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = fstatSync(handle);
    if (!details.isFile())
      throw new Error("growth contract path must reference a regular file");
    if (details.size > MAX_GROWTH_CONTRACT_BYTES) {
      throw new Error("growth contract exceeds the 1 MiB inspection limit");
    }
    text = readFileSync(handle, "utf8");
  } catch (error) {
    if (error instanceof Error && (error.message.includes("1 MiB inspection limit") || error.message.includes("regular file"))) {
      throw error;
    }
    throw new Error("growth contract file could not be read");
  } finally {
    if (handle !== void 0)
      closeSync(handle);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_GROWTH_CONTRACT_BYTES) {
    throw new Error("growth contract exceeds the 1 MiB inspection limit");
  }
  let document;
  try {
    document = parseYaml(text);
  } catch {
    throw new Error("growth contract YAML is invalid");
  }
  const originalSchemaVersion = growthContractVersion(document);
  let contract;
  try {
    contract = parseGrowthContract(document);
  } catch {
    throw new Error("growth contract failed schema validation");
  }
  return result("growth.inspect", "read_only", "valid", {
    source: {
      path: source.displayPath,
      format: "yaml",
      readOnly: true
    },
    schemaVersion: contract.contract_version,
    originalSchemaVersion,
    migrationApplied: originalSchemaVersion === 1 && contract.contract_version === GROWTH_CONTRACT_VERSION,
    venture: {
      ventureId: contract.venture_id,
      currency: contract.economics.currency,
      primaryEvent: contract.goal.primary_event,
      currentOptimizationEvent: contract.goal.current_optimization_event
    },
    budgets: {
      currency: contract.economics.currency,
      totalTestBudgetMinor: contract.paid.test_budget_minor,
      perCreativeCapMinor: contract.paid.per_creative_cap_minor
    },
    organic: {
      allowedProviders: contract.organic.allowed_providers,
      allowedAccountCount: contract.organic.allowed_accounts.length,
      maxAccounts: contract.organic.max_accounts,
      maxPostsPerAccountPerDay: contract.organic.max_posts_per_account_per_day,
      duplicateContentPolicy: contract.organic.duplicate_content_policy,
      defaultReviewMode: contract.organic.default_review_mode,
      snapshotCadenceMinutes: contract.organic.snapshot_cadence_minutes,
      aiDisclosureRequired: contract.organic.ai_disclosure_required
    },
    paid: {
      allowedNetworks: contract.paid.allowed_networks,
      allowedAccountCount: contract.paid.allowed_accounts.length,
      allowedObjectives: contract.paid.allowed_objectives,
      allowedEvents: contract.paid.allowed_events,
      dailyAccountCapMinor: contract.paid.daily_account_cap_minor,
      dailyVentureCapMinor: contract.paid.daily_venture_cap_minor,
      monthlyVentureCapMinor: contract.paid.monthly_venture_cap_minor,
      dailyCustomerCapMinor: contract.paid.daily_customer_cap_minor,
      monthlyCustomerCapMinor: contract.paid.monthly_customer_cap_minor,
      emergencyPlatformCapMinor: contract.paid.emergency_platform_cap_minor,
      approvalThresholdMinor: contract.paid.approval_threshold_minor,
      autoPauseAllowed: contract.paid.auto_pause_allowed,
      autoScaleAllowed: contract.paid.auto_scale_allowed,
      vboPolicy: contract.paid.vbo_policy,
      stopConditions: {
        maxSpendWithoutTrialMinor: contract.paid.stop_conditions.max_spend_without_trial_minor,
        maxSpendWithoutPurchaseMinor: contract.paid.stop_conditions.max_spend_without_purchase_minor,
        maxCacBreachCount: contract.paid.stop_conditions.max_cac_breach_count
      }
    },
    compliance: {
      rightsRequired: contract.compliance.rights_required,
      aiDisclosureRequired: contract.compliance.ai_disclosure_required,
      prohibitedClaims: contract.compliance.prohibited_claims,
      allowedGeographies: contract.compliance.allowed_geographies,
      restrictedAudiences: contract.compliance.restricted_audiences,
      restrictedCategories: contract.compliance.restricted_categories,
      providerPolicyState: contract.compliance.provider_policy_state
    },
    externalEffects: false
  });
}
function requireVenture(state, organizationId, ventureId2) {
  const venture = state.ventures[recordKey(organizationId, ventureId2)];
  if (!venture)
    throw new Error(`venture "${ventureId2}" is not locally created`);
  return venture;
}
function requireRun(state, organizationId, runId2) {
  const run = state.runs[recordKey(organizationId, runId2)];
  if (!run)
    throw new Error(`run "${runId2}" is not locally persisted`);
  return run;
}
function mutate(store, update) {
  const state = store.read();
  const output = update(state);
  store.write(state);
  return output;
}
function registerOperationalCommands(bus, options = {}) {
  const store = options.store ?? new InMemoryOperationalStateStore();
  const timestamp2 = () => (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString();
  const declaredGrowthContractRoot = resolve(options.growthContractRoot ?? process.cwd());
  const rootDetails = lstatSync(declaredGrowthContractRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error("growth contract root must be a regular directory, not a symbolic link");
  }
  const growthContractRoot = {
    declaredPath: declaredGrowthContractRoot,
    canonicalPath: realpathSync(declaredGrowthContractRoot)
  };
  bus.register(systemDoctorCommand, (_input, handler) => {
    const state = store.read();
    const organizationId = handler.context.tenant.organizationId;
    return result("system.doctor", "read_only", "ready_local", {
      runtime: "packaged",
      sourceFallback: false,
      stateStore: store.description,
      externalEffects: false,
      providersChecked: false,
      knownVentures: Object.values(state.ventures).filter((venture) => venture.organizationId === organizationId).length,
      knownRuns: Object.values(state.runs).filter((run) => run.organizationId === organizationId).length
    });
  });
  bus.register(organizationListCommand, (_input, handler) => result("org.list", "read_only", "available", {
    organizations: [{ organizationId: handler.context.tenant.organizationId, source: "context" }]
  }));
  bus.register(stackListCommand, () => result("stack.list", "read_only", "available", {
    stacks: options.stackCatalog ?? [
      {
        profileId: "local-safe",
        profileVersion: "0.2.0",
        label: "Local safe",
        verification: "unconfigured",
        implementationConfigured: false,
        credentialState: "unconfigured",
        liveVerification: "pending",
        providerEffectsConfigured: false,
        bindings: {}
      }
    ]
  }));
  bus.register(packListCommand, () => result("pack.list", "read_only", "available", {
    packs: [
      { id: "venture-operations", version: "0.2.0", state: "bundled" },
      { id: "agent-surfaces", version: "0.2.0", state: "bundled" }
    ]
  }));
  bus.register(seedListCommand, () => result("seed.list", "read_only", "catalog_only", {
    seeds: [
      { id: "web", rail: "web", action: "inspect_only" },
      { id: "ios", rail: "ios", action: "inspect_only" },
      { id: "hybrid", rail: "hybrid", action: "inspect_only" }
    ],
    materialized: false
  }));
  bus.register(grantListCommand, (_input, handler) => result("grant.list", "read_only", "available", {
    grants: handler.context.grants.map((grant) => ({
      grantId: grant.grantId,
      commandIds: [...grant.commandIds],
      scopes: [...grant.scopes],
      expiresAt: grant.expiresAt,
      state: grant.revokedAt ? "revoked" : "declared"
    })),
    productionEffectsAuthorized: false
  }));
  bus.register(providerListCommand, () => result("provider.list", "read_only", "unconfigured", {
    providers: [
      "app_store_connect",
      "bing",
      "brevo",
      "eas",
      "github",
      "google",
      "neon",
      "revenuecat",
      "stripe",
      "vercel"
    ].map((provider) => ({ provider, state: "unconfigured", networkChecked: false })),
    externalEffects: false
  }));
  bus.register(verifyRunCommand, async (input) => {
    const state = store.read();
    parseState(state);
    const profile = await (options.qualityProfileRunner ?? unconfiguredQualityProfileRunner).run(input.profile);
    return result("verify.run", "read_only", profile.status, {
      profile,
      releaseGate: input.profile === "release",
      stateSchemaVersion: state.schemaVersion,
      credentialMaterialPersisted: false
    });
  });
  bus.register(dataSyncCommand, () => result("data.sync", "read_only", "skipped", {
    reason: "no read-only connector is configured in the packaged local runtime",
    records: null,
    externalRequestMade: false
  }));
  bus.register(learningRunCommand, (input, handler) => {
    if (options.learningLoopRuntime) {
      return runLearningCadence(options.learningLoopRuntime, input, handler);
    }
    return result("learn.run", "pending", "insufficient_evidence", {
      cadence: input.cadence,
      actionsApplied: 0,
      externalEffects: false,
      providerRequestMade: false,
      reason: "no normalized provider evidence is configured",
      runtime: "unconfigured"
    });
  });
  bus.register(growthInspectCommand, (input) => inspectGrowthContract(input, growthContractRoot));
  bus.register(ideaCompileCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const compiled = mutate(store, (state) => {
      const sourceHash = `sha256:${createHash4("sha256").update(input.idea).digest("hex")}`;
      const key = recordKey(organizationId, input.ventureId);
      const existing = state.ideas[key];
      if (existing) {
        if (existing.sourceHash !== sourceHash || existing.name !== input.name) {
          throw new Error(`venture "${input.ventureId}" is bound to a different compiled idea`);
        }
        return existing;
      }
      const record = {
        ideaId: `idea-${sourceHash.slice("sha256:".length, "sha256:".length + 12)}`,
        organizationId,
        ventureId: input.ventureId,
        name: input.name,
        summary: input.idea,
        sourceHash,
        compiledAt: timestamp2(),
        assumptions: [
          "Provider credentials and production authorization are not inferred.",
          "The packaged runtime will plan and dry-run locally only."
        ]
      };
      state.ideas[key] = record;
      return record;
    });
    return result("idea.compile", "local_write", "compiled", { idea: compiled });
  });
  bus.register(ventureCreateCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const venture = mutate(store, (state) => {
      const key = recordKey(organizationId, input.ventureId);
      const idea = state.ideas[key];
      if (!idea)
        throw new Error(`compile idea "${input.ventureId}" before creating the venture`);
      if (idea.name !== input.name)
        throw new Error("venture name differs from the compiled idea");
      const existing = state.ventures[key];
      if (existing)
        return existing;
      const createdAt = timestamp2();
      const record = {
        organizationId,
        ventureId: input.ventureId,
        name: input.name,
        ideaId: idea.ideaId,
        status: "created",
        createdAt,
        updatedAt: createdAt
      };
      state.ventures[key] = record;
      return record;
    });
    return result("venture.create", "local_write", "created", { venture });
  });
  bus.register(venturePlanCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const plan = mutate(store, (state) => {
      const venture = requireVenture(state, organizationId, input.ventureId);
      const planId = `plan-${input.ventureId}`;
      const key = recordKey(organizationId, planId);
      const existing = state.plans[key];
      if (existing)
        return existing;
      const record = {
        planId,
        organizationId,
        ventureId: input.ventureId,
        status: "planned",
        createdAt: timestamp2(),
        externalEffects: 0,
        steps: [
          { id: "validate-input", effect: "none", state: "planned" },
          { id: "materialization-preview", effect: "local", state: "planned" },
          { id: "provider-readiness", effect: "read", state: "blocked_unconfigured" }
        ]
      };
      state.plans[key] = record;
      venture.status = "planned";
      venture.updatedAt = record.createdAt;
      return record;
    });
    return result("venture.plan", "local_write", "planned", { plan });
  });
  bus.register(ventureLaunchCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const run = mutate(store, (state) => {
      const venture = requireVenture(state, organizationId, input.ventureId);
      const plan = state.plans[recordKey(organizationId, `plan-${input.ventureId}`)];
      if (!plan)
        throw new Error(`plan venture "${input.ventureId}" before launching`);
      const key = recordKey(organizationId, input.runId);
      const existing = state.runs[key];
      if (existing) {
        if (existing.ventureId !== input.ventureId) {
          throw new Error(`run "${input.runId}" belongs to another venture`);
        }
        return existing;
      }
      const createdAt = timestamp2();
      const record = {
        runId: input.runId,
        organizationId,
        ventureId: input.ventureId,
        planId: plan.planId,
        status: "dry_run_complete",
        mode: "dry_run",
        createdAt,
        updatedAt: createdAt,
        externalEffects: 0,
        resumable: true
      };
      state.runs[key] = record;
      venture.status = "dry_run_complete";
      venture.updatedAt = createdAt;
      return record;
    });
    return result("venture.launch", "dry_run", "dry_run_complete", { run });
  });
  bus.register(ventureStatusCommand, (input, handler) => {
    const organizationId = handler.context.tenant.organizationId;
    const state = store.read();
    const venture = requireVenture(state, organizationId, input.ventureId);
    return result("venture.status", "read_only", venture.status, {
      venture,
      plan: latestForVenture(state.plans, organizationId, input.ventureId),
      run: latestForVenture(state.runs, organizationId, input.ventureId)
    });
  });
  bus.register(ventureResumeCommand, (input, handler) => {
    const state = store.read();
    const run = requireRun(state, handler.context.tenant.organizationId, input.runId);
    return result("venture.resume", "read_only", "no_pending_work", {
      run,
      repeatedEffects: 0,
      nextAction: "configure the full authorized runtime before any provider apply"
    });
  });
  bus.register(runListCommand, (_input, handler) => {
    const state = store.read();
    const runs = Object.fromEntries(Object.entries(state.runs).filter(([, run]) => run.organizationId === handler.context.tenant.organizationId));
    return result("run.list", "read_only", "available", { runs: stateValues(runs) });
  });
  bus.register(runStatusCommand, (input, handler) => {
    const state = store.read();
    return result("run.status", "read_only", "available", {
      run: requireRun(state, handler.context.tenant.organizationId, input.runId)
    });
  });
}

// packages/agent-runtime/dist/provider-operations.js
var WINNER_PROVIDER_COMMAND_IDS = [
  "creative_generation",
  "tiktok_content_posting",
  "tiktok_spark_ads",
  "aggregated_attribution",
  "revenuecat"
];
var WINNER_PROVIDER_COMMAND_FEATURES = [
  "creative.video.generate",
  "distribution.content.draft",
  "distribution.content.publish",
  "ads.organic_post.boost",
  "ads.campaign.pause",
  "attribution.campaign.read",
  "subscription.lifecycle.read"
];
var PROVIDER_COMMAND_ACTIONS = [
  "doctor",
  "plan",
  "dry_run",
  "apply",
  "status",
  "read_back",
  "reconcile"
];
var PROVIDER_ID_VALUES = [...WINNER_PROVIDER_COMMAND_IDS];
var FEATURE_VALUES = [...WINNER_PROVIDER_COMMAND_FEATURES];
var ACTION_VALUES = [...PROVIDER_COMMAND_ACTIONS];
var SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:~-]{0,254}$/u;
var SECRET_KEY = /(?:authorization|api[-_]?key|secret|password|credential|access[-_]?token|refresh[-_]?token|upload[-_]?url)/iu;
var SECRET_VALUE2 = /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;
var SECRET_QUERY_KEY = /(?:token|signature|secret|key|authorization)/iu;
function exactObject3(value, name, allowed) {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  }
  return record;
}
function identifier(record, field) {
  const value = stringValue(record, field);
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${field} must be a provider-safe identifier of at most 255 characters`);
  }
  return value;
}
function assertNoProviderSecrets(value, path = "value", allowRedacted = false) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProviderSecrets(entry, `${path}[${index}]`, allowRedacted));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const isReference = /(?:^|_)(?:ref|reference)$/iu.test(key);
      if (SECRET_KEY.test(key) && !isReference && !(allowRedacted && entry === "[REDACTED]")) {
        throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
      }
      assertNoProviderSecrets(entry, `${path}.${key}`, allowRedacted);
    }
    return;
  }
  if (typeof value !== "string")
    return;
  if (SECRET_VALUE2.test(value))
    throw new Error(`credential-like value is forbidden at ${path}`);
  try {
    const url = new URL(value);
    if ([...url.searchParams.keys()].some((key) => SECRET_QUERY_KEY.test(key))) {
      throw new Error(`signed or credential-bearing URL is forbidden at ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("signed or credential-bearing URL")) {
      throw error;
    }
  }
}
function parseSelection(value, name) {
  const input = exactObject3(value, name, [
    "organizationId",
    "providerId",
    "providerAccountId",
    "feature"
  ]);
  const parsed = {
    organizationId: identifier(input, "organizationId"),
    providerId: stringValue(input, "providerId", {
      allowed: PROVIDER_ID_VALUES
    }),
    providerAccountId: identifier(input, "providerAccountId"),
    feature: stringValue(input, "feature", {
      allowed: FEATURE_VALUES
    })
  };
  assertNoProviderSecrets(parsed);
  return parsed;
}
function parseOperation(value, name) {
  const input = exactObject3(value, name, [
    "organizationId",
    "providerId",
    "providerAccountId",
    "feature",
    "operationId",
    "providerIdempotencyKey",
    "payload"
  ]);
  const parsed = {
    organizationId: identifier(input, "organizationId"),
    providerId: stringValue(input, "providerId", {
      allowed: PROVIDER_ID_VALUES
    }),
    providerAccountId: identifier(input, "providerAccountId"),
    feature: stringValue(input, "feature", {
      allowed: FEATURE_VALUES
    }),
    operationId: identifier(input, "operationId"),
    providerIdempotencyKey: identifier(input, "providerIdempotencyKey"),
    payload: objectValue(input.payload, "payload")
  };
  assertNoProviderSecrets(parsed);
  return parsed;
}
var selectionInput = defineRuntimeSchema({
  name: "ProviderSelectionInput",
  jsonSchema: schemaObject({
    organizationId: { type: "string", minLength: 1, maxLength: 255 },
    providerId: { type: "string", enum: PROVIDER_ID_VALUES },
    providerAccountId: { type: "string", minLength: 1, maxLength: 255 },
    feature: { type: "string", enum: FEATURE_VALUES }
  }, ["organizationId", "providerId", "providerAccountId", "feature"]),
  parse(value) {
    return parseSelection(value, "ProviderSelectionInput");
  }
});
var operationInput = defineRuntimeSchema({
  name: "ProviderOperationInput",
  jsonSchema: schemaObject({
    organizationId: { type: "string", minLength: 1, maxLength: 255 },
    providerId: { type: "string", enum: PROVIDER_ID_VALUES },
    providerAccountId: { type: "string", minLength: 1, maxLength: 255 },
    feature: { type: "string", enum: FEATURE_VALUES },
    operationId: { type: "string", minLength: 1, maxLength: 255 },
    providerIdempotencyKey: { type: "string", minLength: 1, maxLength: 255 },
    payload: { type: "object" }
  }, [
    "organizationId",
    "providerId",
    "providerAccountId",
    "feature",
    "operationId",
    "providerIdempotencyKey",
    "payload"
  ]),
  parse(value) {
    return parseOperation(value, "ProviderOperationInput");
  }
});
function providerOutput(commandId) {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject({
      commandId: { const: commandId },
      action: { type: "string", enum: ACTION_VALUES },
      organizationId: { type: "string", minLength: 1, maxLength: 255 },
      providerId: { type: "string", enum: PROVIDER_ID_VALUES },
      feature: { type: "string", enum: FEATURE_VALUES },
      status: { type: "string", minLength: 1 },
      providerInvoked: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
      externalEffectOccurred: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
      liveVerified: { type: "boolean" },
      data: { type: "object" }
    }, [
      "commandId",
      "action",
      "organizationId",
      "providerId",
      "feature",
      "status",
      "providerInvoked",
      "externalEffectOccurred",
      "liveVerified",
      "data"
    ]),
    parse(value) {
      const output = exactObject3(value, `${commandId}Output`, [
        "commandId",
        "action",
        "organizationId",
        "providerId",
        "feature",
        "status",
        "providerInvoked",
        "externalEffectOccurred",
        "liveVerified",
        "data"
      ]);
      if (output.commandId !== commandId)
        throw new Error(`invalid ${commandId} output`);
      const providerInvoked = output.providerInvoked;
      const externalEffectOccurred = output.externalEffectOccurred;
      if (typeof providerInvoked !== "boolean" && providerInvoked !== "unknown") {
        throw new Error("providerInvoked must be boolean or unknown");
      }
      if (typeof externalEffectOccurred !== "boolean" && externalEffectOccurred !== "unknown") {
        throw new Error("externalEffectOccurred must be boolean or unknown");
      }
      if (typeof output.liveVerified !== "boolean") {
        throw new Error("liveVerified must be boolean");
      }
      const data = objectValue(output.data, "data");
      assertNoProviderSecrets(data, "data", true);
      return {
        commandId,
        action: stringValue(output, "action", { allowed: ACTION_VALUES }),
        organizationId: identifier(output, "organizationId"),
        providerId: stringValue(output, "providerId", {
          allowed: PROVIDER_ID_VALUES
        }),
        feature: stringValue(output, "feature", {
          allowed: FEATURE_VALUES
        }),
        status: stringValue(output, "status"),
        providerInvoked,
        externalEffectOccurred,
        liveVerified: output.liveVerified,
        data
      };
    }
  });
}
function providerCommand(definition) {
  const { grant, scopes, ...contract } = definition;
  return defineCommandContract({
    ...contract,
    version: 2,
    output: providerOutput(definition.id),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant,
      scopes
    }
  });
}
var providerDoctorCommand = providerCommand({
  id: "provider.doctor",
  title: "Inspect Provider Capability",
  description: "Inspect one exact Winner provider capability through an injected official transport; default is unconfigured and makes no request.",
  input: selectionInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "read"
});
var providerPlanCommand = providerCommand({
  id: "provider.plan",
  title: "Plan Provider Operation",
  description: "Build an immutable capability-specific provider plan without allowing external execution.",
  input: operationInput,
  grant: false,
  scopes: [],
  effect: "read"
});
var providerDryRunCommand = providerCommand({
  id: "provider.dry-run",
  title: "Dry Run Provider Operation",
  description: "Exercise provider plan validation without invoking a provider or creating an effect.",
  input: operationInput,
  grant: false,
  scopes: [],
  effect: "read"
});
var providerApplyCommand = providerCommand({
  id: "provider.apply",
  title: "Apply Authorized Provider Operation",
  description: "Apply once only through an injected official transport, exact grants, and durable atomic operation storage.",
  input: operationInput,
  grant: true,
  scopes: ["provider.apply"],
  effect: "write"
});
var providerStatusCommand = providerCommand({
  id: "provider.status",
  title: "Verify Provider Operation Status",
  description: "Read and verify provider operation status without replaying the original provider mutation.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write"
});
var providerReadBackCommand = providerCommand({
  id: "provider.read-back",
  title: "Read Back Provider Operation",
  description: "Read exact provider state back and validate capability-specific completion invariants.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write"
});
var providerReconcileCommand = providerCommand({
  id: "provider.reconcile",
  title: "Reconcile Provider Operation",
  description: "Reconcile an unresolved provider operation by immutable request hash without reapplying it.",
  input: operationInput,
  grant: true,
  scopes: ["provider.read"],
  effect: "write"
});
function unconfiguredResult(action, input) {
  return {
    status: "unconfigured",
    providerInvoked: false,
    externalEffectOccurred: false,
    liveVerified: false,
    data: {
      organizationId: input.organizationId,
      providerId: input.providerId,
      providerAccountId: input.providerAccountId,
      feature: input.feature,
      action,
      externalRequestMade: false,
      fixtureFallbackUsed: false,
      diagnostic: {
        code: "transport_missing",
        message: "No authorized Winner provider runtime is injected",
        nextAction: "Bind an official provider transport, broker reference, grants, and durable operation store"
      }
    }
  };
}
var unconfiguredProviderCommandRuntime = Object.freeze({
  execute: unconfiguredResult
});
function commandResult(commandId, action, input, boundary) {
  return {
    commandId,
    action,
    organizationId: input.organizationId,
    providerId: input.providerId,
    feature: input.feature,
    status: boundary.status,
    providerInvoked: boundary.providerInvoked,
    externalEffectOccurred: boundary.externalEffectOccurred,
    liveVerified: boundary.liveVerified,
    data: boundary.data
  };
}
function register2(bus, runtime, contract, action) {
  bus.register(contract, async (input, handler) => {
    let boundary;
    try {
      boundary = await runtime.execute(action, input, handler);
    } catch {
      throw new Error("The injected provider runtime failed without a verified outcome; reconcile before retry");
    }
    const direct = boundary.data.diagnostic;
    const nested = boundary.data.result && typeof boundary.data.result === "object" && !Array.isArray(boundary.data.result) ? boundary.data.result.diagnostic : void 0;
    const diagnostic = direct ?? nested;
    const failureStatuses = /* @__PURE__ */ new Set([
      "unconfigured",
      "tenant_mismatch",
      "unsupported_feature",
      "context_unavailable",
      "invalid_request",
      "dry_run_failed",
      "doctor_failed",
      "official_transport_required",
      "provider_outcome_unknown",
      "runtime_failed",
      "blocked",
      "failed",
      "idempotency_conflict"
    ]);
    if (failureStatuses.has(boundary.status) && diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
      const record = diagnostic;
      const code = typeof record.code === "string" ? record.code : "provider_command_failed";
      const message = typeof record.message === "string" ? record.message : "The provider command did not complete successfully";
      const failure = `${code}: ${message}`;
      if (boundary.externalEffectOccurred === false) {
        throw new CommandDefinitiveNoEffectError(failure, "handler_failed");
      }
      throw new Error(failure);
    }
    return commandResult(contract.id, action, input, boundary);
  });
}
function registerProviderOperationCommands(bus, runtime = unconfiguredProviderCommandRuntime) {
  register2(bus, runtime, providerDoctorCommand, "doctor");
  register2(bus, runtime, providerPlanCommand, "plan");
  register2(bus, runtime, providerDryRunCommand, "dry_run");
  register2(bus, runtime, providerApplyCommand, "apply");
  register2(bus, runtime, providerStatusCommand, "status");
  register2(bus, runtime, providerReadBackCommand, "read_back");
  register2(bus, runtime, providerReconcileCommand, "reconcile");
}

// packages/agent-runtime/dist/stack-operations.js
var STACK_COMMAND_ACTIONS = [
  "doctor",
  "plan",
  "dry_run",
  "apply",
  "read_back",
  "reconcile"
];
var ENVIRONMENTS = [
  "local",
  "preview",
  "sandbox",
  "production",
  "testflight"
];
var SAFE_ID2 = /^[a-zA-Z0-9][a-zA-Z0-9._:~-]{0,254}$/u;
var SAFE_ROLE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;
var SECRET_KEY2 = /(?:authorization|api[-_]?key|secret|password|credential|access[-_]?token|refresh[-_]?token)/iu;
var SECRET_VALUE3 = /(?:\bbearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk|pk|atk)_(?:live|test)?_?[a-z0-9_-]{8,})/iu;
function exactObject4(value, name, allowed) {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  }
  return record;
}
function safeId3(record, field) {
  const value = stringValue(record, field);
  if (!SAFE_ID2.test(value)) {
    throw new Error(`${field} must be a safe identifier of at most 255 characters`);
  }
  return value;
}
function assertNoSecrets2(value, path = "value", allowReferences = false) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets2(entry, `${path}[${index}]`, allowReferences));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const reference = allowReferences && /(?:ref|reference)s?$/iu.test(key);
      if (SECRET_KEY2.test(key) && !reference) {
        throw new Error(`secret-bearing field ${path}.${key} is forbidden`);
      }
      assertNoSecrets2(entry, `${path}.${key}`, allowReferences);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE3.test(value)) {
    throw new Error(`credential-like value is forbidden at ${path}`);
  }
}
function parseSelection2(value, name) {
  const input = exactObject4(value, name, [
    "profileId",
    "profileVersion",
    "role",
    "providerId",
    "capability",
    "environment"
  ]);
  const role = stringValue(input, "role");
  if (!SAFE_ROLE.test(role))
    throw new Error("role must be a namespaced capability role");
  const parsed = {
    profileId: safeId3(input, "profileId"),
    profileVersion: safeId3(input, "profileVersion"),
    role,
    providerId: safeId3(input, "providerId"),
    capability: safeId3(input, "capability"),
    environment: stringValue(input, "environment", {
      allowed: ENVIRONMENTS
    })
  };
  assertNoSecrets2(parsed);
  return parsed;
}
function parseOperation2(value, name) {
  const input = exactObject4(value, name, [
    "profileId",
    "profileVersion",
    "role",
    "providerId",
    "capability",
    "environment",
    "operationId",
    "payload"
  ]);
  const selection = parseSelection2(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "operationId" && key !== "payload")), name);
  const parsed = {
    ...selection,
    operationId: safeId3(input, "operationId"),
    payload: objectValue(input.payload, "payload")
  };
  assertNoSecrets2(parsed, name, true);
  return parsed;
}
var selectionInput2 = defineRuntimeSchema({
  name: "StackSelectionInput",
  jsonSchema: schemaObject({
    profileId: { type: "string", minLength: 1, maxLength: 255 },
    profileVersion: { type: "string", minLength: 1, maxLength: 255 },
    role: { type: "string", minLength: 3, maxLength: 255 },
    providerId: { type: "string", minLength: 1, maxLength: 255 },
    capability: { type: "string", minLength: 1, maxLength: 255 },
    environment: { type: "string", enum: [...ENVIRONMENTS] }
  }, ["profileId", "profileVersion", "role", "providerId", "capability", "environment"]),
  parse(value) {
    return parseSelection2(value, "StackSelectionInput");
  }
});
var operationInput2 = defineRuntimeSchema({
  name: "StackOperationInput",
  jsonSchema: schemaObject({
    ...selectionInput2.jsonSchema.properties,
    operationId: { type: "string", minLength: 1, maxLength: 255 },
    payload: { type: "object" }
  }, [
    "profileId",
    "profileVersion",
    "role",
    "providerId",
    "capability",
    "environment",
    "operationId",
    "payload"
  ]),
  parse(value) {
    return parseOperation2(value, "StackOperationInput");
  }
});
function outputSchema3(commandId) {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject({
      commandId: { const: commandId },
      action: { type: "string", enum: [...STACK_COMMAND_ACTIONS] },
      profileId: { type: "string" },
      profileVersion: { type: "string" },
      role: { type: "string" },
      providerId: { type: "string" },
      capability: { type: "string" },
      status: { type: "string" },
      providerInvoked: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
      externalEffectOccurred: { anyOf: [{ type: "boolean" }, { const: "unknown" }] },
      liveVerified: { type: "boolean" },
      data: { type: "object" }
    }, [
      "commandId",
      "action",
      "profileId",
      "profileVersion",
      "role",
      "providerId",
      "capability",
      "status",
      "providerInvoked",
      "externalEffectOccurred",
      "liveVerified",
      "data"
    ]),
    parse(value) {
      const output = exactObject4(value, `${commandId}Output`, [
        "commandId",
        "action",
        "profileId",
        "profileVersion",
        "role",
        "providerId",
        "capability",
        "status",
        "providerInvoked",
        "externalEffectOccurred",
        "liveVerified",
        "data"
      ]);
      if (output.commandId !== commandId)
        throw new Error(`invalid ${commandId} output`);
      const providerInvoked = output.providerInvoked;
      const externalEffectOccurred = output.externalEffectOccurred;
      if (typeof providerInvoked !== "boolean" && providerInvoked !== "unknown") {
        throw new Error("providerInvoked must be boolean or unknown");
      }
      if (typeof externalEffectOccurred !== "boolean" && externalEffectOccurred !== "unknown") {
        throw new Error("externalEffectOccurred must be boolean or unknown");
      }
      if (typeof output.liveVerified !== "boolean")
        throw new Error("liveVerified must be boolean");
      const data = objectValue(output.data, "data");
      assertNoSecrets2(data, "data", true);
      return {
        commandId,
        action: stringValue(output, "action", {
          allowed: STACK_COMMAND_ACTIONS
        }),
        profileId: stringValue(output, "profileId"),
        profileVersion: stringValue(output, "profileVersion"),
        role: stringValue(output, "role"),
        providerId: stringValue(output, "providerId"),
        capability: stringValue(output, "capability"),
        status: stringValue(output, "status"),
        providerInvoked,
        externalEffectOccurred,
        liveVerified: output.liveVerified,
        data
      };
    }
  });
}
function stackCommand(definition) {
  const { grant, scopes, ...contract } = definition;
  return defineCommandContract({
    ...contract,
    version: 1,
    output: outputSchema3(definition.id),
    requirements: { activeSubscription: false, entitlements: [], grant, scopes }
  });
}
var stackDoctorCommand = stackCommand({
  id: "stack.doctor",
  title: "Inspect Stack Capability",
  description: "Inspect the exact provider adapter selected by an attested Stack Profile.",
  input: selectionInput2,
  grant: true,
  scopes: ["provider.read"],
  effect: "read"
});
var stackPlanCommand = stackCommand({
  id: "stack.plan",
  title: "Plan Stack Capability",
  description: "Build a no-effect provider plan through an exact versioned Stack Profile binding.",
  input: operationInput2,
  grant: false,
  scopes: [],
  effect: "read"
});
var stackDryRunCommand = stackCommand({
  id: "stack.dry-run",
  title: "Dry Run Stack Capability",
  description: "Exercise a selected adapter plan locally without executing a provider effect.",
  input: operationInput2,
  grant: false,
  scopes: [],
  effect: "read"
});
var stackApplyCommand = stackCommand({
  id: "stack.apply",
  title: "Apply Stack Capability",
  description: "Apply an authorized profile-bound provider plan with durable command and provider idempotency.",
  input: operationInput2,
  grant: true,
  scopes: ["provider.apply"],
  effect: "write"
});
var stackReadBackCommand = stackCommand({
  id: "stack.read-back",
  title: "Read Back Stack Capability",
  description: "Read back the exact stored profile-bound operation without repeating its effect.",
  input: operationInput2,
  grant: true,
  scopes: ["provider.read"],
  effect: "write"
});
var stackReconcileCommand = stackCommand({
  id: "stack.reconcile",
  title: "Reconcile Stack Capability",
  description: "Reconcile a previously attempted profile-bound operation through its durable provider ledger.",
  input: operationInput2,
  grant: true,
  scopes: ["provider.read"],
  effect: "write"
});
var unconfiguredCatalog = Object.freeze([
  Object.freeze({
    profileId: "local-safe",
    profileVersion: "0.2.0",
    label: "Local safe",
    verification: "unconfigured",
    implementationConfigured: false,
    credentialState: "unconfigured",
    liveVerification: "pending",
    providerEffectsConfigured: false,
    bindings: {}
  })
]);
var unconfiguredStackCommandRuntime = Object.freeze({
  catalog: unconfiguredCatalog,
  execute(action, input) {
    return {
      status: "unconfigured",
      providerInvoked: false,
      externalEffectOccurred: false,
      liveVerified: false,
      data: {
        action,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        role: input.role,
        providerId: input.providerId,
        capability: input.capability,
        externalRequestMade: false,
        fixtureFallbackUsed: false,
        diagnostic: {
          code: "stack_runtime_unconfigured",
          message: "No authorized Stack Profile provider runtime is injected",
          nextAction: "Inject the repository provider bridge with exact grants and durable idempotency stores"
        }
      }
    };
  }
});
function commandResult2(commandId, action, input, boundary) {
  return {
    commandId,
    action,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    role: input.role,
    providerId: input.providerId,
    capability: input.capability,
    status: boundary.status,
    providerInvoked: boundary.providerInvoked,
    externalEffectOccurred: boundary.externalEffectOccurred,
    liveVerified: boundary.liveVerified,
    data: boundary.data
  };
}
function register3(bus, runtime, contract, action) {
  bus.register(contract, async (input, handler) => {
    let boundary;
    try {
      boundary = await runtime.execute(action, input, handler);
    } catch {
      throw new Error("The Stack Profile runtime failed without a verified outcome; reconcile before retry");
    }
    const direct = boundary.data.diagnostic;
    const nested = boundary.data.result && typeof boundary.data.result === "object" && !Array.isArray(boundary.data.result) ? boundary.data.result.diagnostic : void 0;
    const diagnostic = direct ?? nested;
    const failureStatuses = /* @__PURE__ */ new Set([
      "unconfigured",
      "runtime_failed",
      "context_unavailable",
      "blocked",
      "failed",
      "idempotency_conflict"
    ]);
    if (failureStatuses.has(boundary.status) && diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
      const record = diagnostic;
      const code = typeof record.code === "string" ? record.code : "stack_command_failed";
      const message = typeof record.message === "string" ? record.message : "The Stack Profile command did not complete successfully";
      const failure = `${code}: ${message}`;
      if (boundary.externalEffectOccurred === false) {
        throw new CommandDefinitiveNoEffectError(failure, "handler_failed");
      }
      throw new Error(failure);
    }
    return commandResult2(contract.id, action, input, boundary);
  });
}
function registerStackOperationCommands(bus, runtime = unconfiguredStackCommandRuntime) {
  register3(bus, runtime, stackDoctorCommand, "doctor");
  register3(bus, runtime, stackPlanCommand, "plan");
  register3(bus, runtime, stackDryRunCommand, "dry_run");
  register3(bus, runtime, stackApplyCommand, "apply");
  register3(bus, runtime, stackReadBackCommand, "read_back");
  register3(bus, runtime, stackReconcileCommand, "reconcile");
}

// packages/agent-runtime/dist/recursive.js
var SAFE_ID3 = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,254}$/u;
function exactObject5(value, name, allowed) {
  const record = objectValue(value, name);
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${name} has unsupported field(s): ${unexpected.join(", ")}`);
  }
  return record;
}
function identifier2(record, field) {
  const value = stringValue(record, field);
  try {
    assertCredentialFree(value, field);
  } catch {
    throw new Error(`credential material is forbidden in ${field}`);
  }
  if (value !== value.trim() || !SAFE_ID3.test(value)) {
    throw new Error(`${field} must be a canonical identifier of at most 255 characters`);
  }
  return value;
}
function assertJsonSafe2(value, path) {
  try {
    assertCredentialFree(value, path);
  } catch {
    throw new Error(`credential or non-JSON material is forbidden in ${path}`);
  }
}
var INPUT_FIELDS = [
  "customerOrganizationId",
  "subscriptionId",
  "entitlementId",
  "serviceGrantId",
  "providerConnectionId",
  "capability",
  "authorizationEnvelopeId",
  "runId",
  "nodeId",
  "correlationId",
  "causationId",
  "usageUnits",
  "payload"
];
var RECONCILE_INPUT_FIELDS = INPUT_FIELDS.filter((field) => field !== "authorizationEnvelopeId");
var recursiveInput = defineRuntimeSchema({
  name: "RecursiveServiceCommandInput",
  jsonSchema: schemaObject({
    customerOrganizationId: { type: "string", minLength: 1, maxLength: 255 },
    subscriptionId: { type: "string", minLength: 1, maxLength: 255 },
    entitlementId: { type: "string", minLength: 1, maxLength: 255 },
    serviceGrantId: { type: "string", minLength: 1, maxLength: 255 },
    providerConnectionId: { type: "string", minLength: 1, maxLength: 255 },
    capability: { type: "string", minLength: 1, maxLength: 255 },
    authorizationEnvelopeId: { type: "string", minLength: 1, maxLength: 255 },
    runId: { type: "string", minLength: 1, maxLength: 255 },
    nodeId: { type: "string", minLength: 1, maxLength: 255 },
    correlationId: { type: "string", minLength: 1, maxLength: 255 },
    causationId: { type: "string", minLength: 1, maxLength: 255 },
    usageUnits: { type: "integer", minimum: 1 },
    payload: { type: "object" }
  }, [...INPUT_FIELDS]),
  parse(value) {
    const input = exactObject5(value, "RecursiveServiceCommandInput", INPUT_FIELDS);
    if (!Number.isSafeInteger(input.usageUnits) || Number(input.usageUnits) < 1) {
      throw new Error("usageUnits must be a positive safe integer");
    }
    const payload = objectValue(input.payload, "payload");
    assertJsonSafe2(payload, "payload");
    return {
      customerOrganizationId: identifier2(input, "customerOrganizationId"),
      subscriptionId: identifier2(input, "subscriptionId"),
      entitlementId: identifier2(input, "entitlementId"),
      serviceGrantId: identifier2(input, "serviceGrantId"),
      providerConnectionId: identifier2(input, "providerConnectionId"),
      capability: identifier2(input, "capability"),
      authorizationEnvelopeId: identifier2(input, "authorizationEnvelopeId"),
      runId: identifier2(input, "runId"),
      nodeId: identifier2(input, "nodeId"),
      correlationId: identifier2(input, "correlationId"),
      causationId: identifier2(input, "causationId"),
      usageUnits: Number(input.usageUnits),
      payload
    };
  }
});
var recursiveReconcileInput = defineRuntimeSchema({
  name: "RecursiveServiceReconcileInput",
  jsonSchema: schemaObject({
    customerOrganizationId: { type: "string", minLength: 1, maxLength: 255 },
    subscriptionId: { type: "string", minLength: 1, maxLength: 255 },
    entitlementId: { type: "string", minLength: 1, maxLength: 255 },
    serviceGrantId: { type: "string", minLength: 1, maxLength: 255 },
    providerConnectionId: { type: "string", minLength: 1, maxLength: 255 },
    capability: { type: "string", minLength: 1, maxLength: 255 },
    reconciliationAuthorizationEnvelopeId: {
      type: "string",
      minLength: 1,
      maxLength: 255
    },
    runId: { type: "string", minLength: 1, maxLength: 255 },
    nodeId: { type: "string", minLength: 1, maxLength: 255 },
    correlationId: { type: "string", minLength: 1, maxLength: 255 },
    causationId: { type: "string", minLength: 1, maxLength: 255 },
    usageUnits: { type: "integer", minimum: 1 },
    payload: { type: "object" },
    operationIdempotencyKey: { type: "string", minLength: 1, maxLength: 255 }
  }, [...RECONCILE_INPUT_FIELDS, "reconciliationAuthorizationEnvelopeId", "operationIdempotencyKey"]),
  parse(value) {
    const input = exactObject5(value, "RecursiveServiceReconcileInput", [
      ...RECONCILE_INPUT_FIELDS,
      "reconciliationAuthorizationEnvelopeId",
      "operationIdempotencyKey"
    ]);
    const base = recursiveInput.parse(Object.fromEntries(INPUT_FIELDS.map((field) => [
      field,
      field === "authorizationEnvelopeId" ? input.reconciliationAuthorizationEnvelopeId : input[field]
    ])));
    const { authorizationEnvelopeId: _authorizationEnvelopeId, ...immutable } = base;
    void _authorizationEnvelopeId;
    return {
      ...immutable,
      reconciliationAuthorizationEnvelopeId: identifier2(input, "reconciliationAuthorizationEnvelopeId"),
      operationIdempotencyKey: identifier2(input, "operationIdempotencyKey")
    };
  }
});
function recursiveOutput(commandId) {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject({
      commandId: { const: commandId },
      operatorId: { type: "string" },
      ventureId: { type: "string" },
      customerOrganizationId: { type: "string" },
      status: { const: "completed" },
      data: { type: "object" }
    }, ["commandId", "operatorId", "ventureId", "customerOrganizationId", "status", "data"]),
    parse(value) {
      const output = exactObject5(value, `${commandId}Output`, [
        "commandId",
        "operatorId",
        "ventureId",
        "customerOrganizationId",
        "status",
        "data"
      ]);
      if (output.commandId !== commandId || output.status !== "completed") {
        throw new Error(`invalid ${commandId} output`);
      }
      const data = objectValue(output.data, "data");
      assertJsonSafe2(data, "data");
      return {
        commandId,
        operatorId: identifier2(output, "operatorId"),
        ventureId: identifier2(output, "ventureId"),
        customerOrganizationId: identifier2(output, "customerOrganizationId"),
        status: "completed",
        data
      };
    }
  });
}
function recursiveReconcileOutput(commandId, executionCommandId) {
  return defineRuntimeSchema({
    name: `${commandId}Output`,
    jsonSchema: schemaObject({
      commandId: { const: commandId },
      executionCommandId: { const: executionCommandId },
      operatorId: { type: "string" },
      ventureId: { type: "string" },
      customerOrganizationId: { type: "string" },
      providerOperationId: { type: "string" },
      status: { type: "string", enum: ["completed", "released", "manual_required"] },
      data: { type: "object" }
    }, [
      "commandId",
      "executionCommandId",
      "operatorId",
      "ventureId",
      "customerOrganizationId",
      "providerOperationId",
      "status",
      "data"
    ]),
    parse(value) {
      const output = exactObject5(value, `${commandId}Output`, [
        "commandId",
        "executionCommandId",
        "operatorId",
        "ventureId",
        "customerOrganizationId",
        "providerOperationId",
        "status",
        "data"
      ]);
      if (output.commandId !== commandId || output.executionCommandId !== executionCommandId || output.status !== "completed" && output.status !== "released" && output.status !== "manual_required") {
        throw new Error(`invalid ${commandId} output`);
      }
      const data = objectValue(output.data, "data");
      assertJsonSafe2(data, "data");
      return {
        commandId,
        executionCommandId,
        operatorId: identifier2(output, "operatorId"),
        ventureId: identifier2(output, "ventureId"),
        customerOrganizationId: identifier2(output, "customerOrganizationId"),
        providerOperationId: identifier2(output, "providerOperationId"),
        status: output.status,
        data
      };
    }
  });
}
function defineRecursiveServiceCommand(definition) {
  return defineCommandContract({
    id: definition.id,
    version: 1,
    title: definition.title,
    description: definition.description,
    input: recursiveInput,
    output: recursiveOutput(definition.id),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant: true,
      scopes: definition.requiredCommandScopes ?? ["service.execute"]
    },
    effect: "write",
    meter: definition.meter ?? "service_executions"
  });
}
function defineRecursiveServiceReconcileCommand(definition) {
  const contract = defineCommandContract({
    id: definition.id,
    version: 1,
    title: definition.title,
    description: definition.description,
    input: recursiveReconcileInput,
    output: recursiveReconcileOutput(definition.id, definition.executionCommandId),
    requirements: {
      activeSubscription: false,
      entitlements: [],
      grant: true,
      scopes: definition.requiredCommandScopes ?? ["service.reconcile"]
    },
    effect: "write",
    meter: definition.meter ?? "service_reconciliations"
  });
  return Object.freeze({ contract, executionCommandId: definition.executionCommandId });
}
var recursiveServiceExecuteCommand = defineRecursiveServiceCommand({
  id: "service.execute",
  title: "Execute Customer Service",
  description: "Execute one customer-scoped Service Blueprint through subscription, entitlement, Service Grant, Agent Grant, provider-connection, and authorization checks."
});
var recursiveServiceReconcileCommand = defineRecursiveServiceReconcileCommand({
  id: "service.reconcile",
  executionCommandId: recursiveServiceExecuteCommand.id,
  title: "Reconcile Customer Service",
  description: "Read back one durable provider operation and settle its exact result or confirmed no-effect usage without repeating the provider operation."
});
var recursiveCommandContracts = [recursiveServiceExecuteCommand];
var recursiveReconcileCommandRegistrations = [recursiveServiceReconcileCommand];
function registerRecursiveCommands(bus, runtime, contracts = recursiveCommandContracts) {
  for (const contract of contracts) {
    bus.register(contract, (input, context2) => runtime.execute(input, context2));
  }
}
function registerRecursiveReconcileCommands(bus, runtime, registrations = recursiveReconcileCommandRegistrations) {
  for (const { contract, executionCommandId } of registrations) {
    bus.register(contract, (input, context2) => runtime.reconcile(input, context2, executionCommandId));
  }
}

// packages/agent-runtime/dist/index.js
function commandRequirements(contract) {
  return contract.requirements;
}
function createVentureRuntime(options) {
  const executionMode = options.commandExecutionMode ?? "production";
  if (executionMode === "production") {
    const required = [
      ["command idempotency", options.commandIdempotencyStore?.durability],
      ["audit", options.audit?.durability],
      ["event", options.events?.durability],
      ["metering", options.metering?.durability]
    ];
    const unsafe = required.filter(([, durability]) => durability !== "durable_atomic").map(([name]) => name);
    if (unsafe.length > 0) {
      throw new Error(`Production venture runtime requires injected durable atomic stores for: ${unsafe.join(", ")}`);
    }
    if (options.securityAudit !== void 0 && options.securityAudit.durability !== "durable_atomic") {
      throw new Error("Production venture runtime security audit sink must be durable atomic");
    }
  }
  const audit = options.audit ?? new InMemoryAuditChain();
  const securityAudit = options.securityAudit ?? audit;
  const events = options.events ?? new InMemoryEventLog();
  const metering = options.metering ?? new InMemoryMeteringSink();
  const idempotency = options.commandIdempotencyStore ?? new InMemoryIdempotencyStore();
  const bus = new CommandBus({
    identity(context2) {
      assertNonEmpty(context2.identity.actorId, "actorId");
    },
    tenant(context2) {
      tenantKey(context2.tenant);
      assertOrganizationMembership(context2.identity, context2.tenant, options.memberships);
    },
    subscription(contract, context2) {
      if (commandRequirements(contract).activeSubscription)
        assertActiveSubscription(context2.subscription);
    },
    entitlement(contract, context2) {
      assertEntitlements(context2.entitlements, commandRequirements(contract).entitlements);
    },
    grant(contract, context2, now) {
      if (commandRequirements(contract).grant) {
        selectCommandGrant(context2.grants, contract.id, commandRequirements(contract).scopes, now);
      }
    },
    scope(contract, context2) {
      const decision = decideScopes(context2, commandRequirements(contract).scopes);
      if (!decision.allowed)
        throw new Error(decision.reason);
    },
    idempotency,
    audit,
    securityAudit,
    metering,
    events
  }, { now: options.now, executionMode });
  bus.register(campaignLaunchCommand, (input, context2) => ({
    commandId: "campaigns.launch",
    ventureId: context2.context.tenant.ventureId,
    campaignId: input.campaignId,
    channel: input.channel,
    status: "planned"
  }));
  bus.register(launchExecuteCommand, (input, context2) => ({
    commandId: "launch.execute",
    ventureId: context2.context.tenant.ventureId,
    runId: `run-${context2.context.tenant.ventureId}-${input.launchId}`.replace(/[^a-zA-Z0-9._-]/g, "-"),
    mode: input.mode,
    status: "accepted",
    dryRun: input.dryRun
  }));
  const stackRuntime = options.stackCommandRuntime ?? unconfiguredStackCommandRuntime;
  registerOperationalCommands(bus, {
    store: options.operationalStore,
    growthContractRoot: options.growthContractRoot,
    stackCatalog: stackRuntime.catalog,
    qualityProfileRunner: options.qualityProfileRunner,
    learningLoopRuntime: options.learningLoopRuntime,
    now: options.now
  });
  registerPlatformOperationCommands(bus, {
    auth: options.authCommandRuntime,
    upgrade: options.upgradeCommandRuntime,
    fleet: options.fleetCommandRuntime
  });
  registerProviderOperationCommands(bus, options.providerCommandRuntime);
  registerStackOperationCommands(bus, stackRuntime);
  if (options.recursiveCommandRuntime) {
    registerRecursiveCommands(bus, options.recursiveCommandRuntime, options.recursiveCommands ?? recursiveCommandContracts);
    registerRecursiveReconcileCommands(bus, options.recursiveCommandRuntime, options.recursiveReconcileCommands ?? (options.recursiveCommands ? [] : recursiveReconcileCommandRegistrations));
  } else if (options.recursiveCommands || options.recursiveReconcileCommands) {
    throw new Error("recursive commands require an injected recursive command runtime");
  }
  return {
    bus,
    contracts: bus.contracts(),
    executionMode,
    durability: {
      commandIdempotency: idempotency.durability,
      audit: audit.durability ?? "fixture_only",
      securityAudit: securityAudit.durability ?? "fixture_only",
      events: events.durability ?? "fixture_only",
      metering: metering.durability ?? "fixture_only"
    },
    execute: (commandId, input, invocation2) => bus.executeById(commandId, input, invocation2)
  };
}

// packages/cli-generator/src/operational.ts
import { createHash as createHash5 } from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
var EMPTY_INPUT_COMMANDS = /* @__PURE__ */ new Set([
  "system.doctor",
  "org.list",
  "stack.list",
  "pack.list",
  "seed.list",
  "grant.list",
  "provider.list",
  "upgrade.status",
  "data.sync",
  "run.list"
]);
var SECRET_PATTERNS2 = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END|$)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/gi,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]+/gi
];
function redact(value) {
  return SECRET_PATTERNS2.reduce((safe, pattern) => safe.replace(pattern, "[REDACTED]"), value);
}
function flag(args2, name) {
  const index = args2.indexOf(name);
  return index >= 0 ? args2[index + 1] : void 0;
}
function positionals(args2) {
  const valuedFlags = /* @__PURE__ */ new Set([
    "--brief",
    "--cadence",
    "--context",
    "--file",
    "--idempotency-key",
    "--idea",
    "--input",
    "--name",
    "--org-id",
    "--path",
    "--run-id",
    "--runtime-module",
    "--state-dir",
    "--project-root",
    "--provider",
    "--ref",
    "--backend",
    "--kind",
    "--scopes",
    "--release",
    "--release-id",
    "--venture-ids",
    "--batch-size",
    "--venture-id"
  ]);
  const values = [];
  for (let index = 0; index < args2.length; index += 1) {
    const value = args2[index];
    if (value.startsWith("-")) {
      if (valuedFlags.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}
function slug(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
  return normalized.length >= 2 ? normalized : "local-venture";
}
function resolveCommand(args2, contracts) {
  const values = positionals(args2);
  const [first, second] = values;
  if (!first) return null;
  if (second) {
    const exact = contracts.find(
      ({ surfaces }) => surfaces.cli.tokens[0] === first && surfaces.cli.tokens[1] === second
    );
    if (exact) {
      return { commandId: exact.id, tokens: exact.surfaces.cli.tokens, bootstrap: false };
    }
  }
  if (first === "doctor")
    return { commandId: "system.doctor", tokens: ["system", "doctor"], bootstrap: false };
  if (first === "create")
    return {
      commandId: "venture.create",
      tokens: ["venture", "create"],
      bootstrap: Boolean(flag(args2, "--brief") || flag(args2, "--idea"))
    };
  if (first === "plan")
    return { commandId: "venture.plan", tokens: ["venture", "plan"], bootstrap: false };
  if (first === "launch")
    return { commandId: "venture.launch", tokens: ["venture", "launch"], bootstrap: false };
  if (first === "resume")
    return { commandId: "venture.resume", tokens: ["venture", "resume"], bootstrap: false };
  if (first === "status") {
    if (flag(args2, "--venture-id"))
      return { commandId: "venture.status", tokens: ["venture", "status"], bootstrap: false };
    if (second || flag(args2, "--run-id"))
      return { commandId: "run.status", tokens: ["run", "status"], bootstrap: false };
    return { commandId: "run.list", tokens: ["run", "list"], bootstrap: false };
  }
  if (first === "learn" && second !== "run")
    return { commandId: "learn.run", tokens: ["learn", "run"], bootstrap: false };
  if (first === "verify" && second !== "run")
    return { commandId: "verify.run", tokens: ["verify", "run"], bootstrap: false };
  if (["org", "stack", "pack", "seed", "grant", "provider", "run"].includes(first) && !second) {
    const action = first === "run" ? "list" : "list";
    return { commandId: `${first}.${action}`, tokens: [first, action], bootstrap: false };
  }
  if (!second) return null;
  return { commandId: `${first}.${second}`, tokens: [first, second], bootstrap: false };
}
function parseJsonObject(raw, field) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must contain a JSON object`);
  }
  return value;
}
function ventureId(args2, values) {
  return flag(args2, "--venture-id") ?? values[2] ?? "local-venture";
}
function inputFor(commandId, args2) {
  const rawInput = flag(args2, "--input");
  if (rawInput) return parseJsonObject(rawInput, "--input");
  if (EMPTY_INPUT_COMMANDS.has(commandId)) return {};
  const values = positionals(args2);
  if (commandId === "idea.compile") {
    const brief = flag(args2, "--brief");
    const idea = flag(args2, "--idea") ?? (brief ? readFileSync2(brief, "utf8") : values[2]);
    if (!idea) throw new Error("idea compile requires --idea <text> or --brief <file>");
    const name = flag(args2, "--name") ?? "Local Venture";
    return { idea, ventureId: flag(args2, "--venture-id") ?? slug(name), name };
  }
  if (commandId === "venture.create") {
    const id = ventureId(args2, values);
    return { ventureId: id, name: flag(args2, "--name") ?? "Local Venture" };
  }
  if (commandId === "venture.plan" || commandId === "venture.status") {
    return { ventureId: ventureId(args2, values) };
  }
  if (commandId === "venture.launch") {
    if (args2.includes("--apply")) {
      throw new Error("provider apply is unavailable in the packaged local runtime; no effect ran");
    }
    if (!args2.includes("--dry-run")) throw new Error("venture launch requires --dry-run");
    const id = ventureId(args2, values);
    return { ventureId: id, runId: flag(args2, "--run-id") ?? `run-${id}`, dryRun: true };
  }
  if (commandId === "venture.resume" || commandId === "run.status") {
    const runId2 = flag(args2, "--run-id") ?? values[2] ?? values[1];
    if (!runId2) throw new Error(`${commandId} requires a run id`);
    return { runId: runId2 };
  }
  if (commandId === "learn.run") {
    const cadence = flag(args2, "--cadence") ?? (values[1] === "run" ? values[2] : values[1]);
    if (!cadence) throw new Error("learn requires daily, weekly, biweekly, or monthly");
    return { cadence };
  }
  if (commandId === "growth.inspect") {
    return { path: flag(args2, "--file") ?? flag(args2, "--path") ?? "config/growth.yaml" };
  }
  if (commandId === "verify.run") {
    const profile = values[1] === "run" ? values[2] : values[1];
    if (!profile) throw new Error("verify requires fast, mvp, or release");
    return { profile };
  }
  if (commandId.startsWith("auth.")) {
    const providerId = flag(args2, "--provider") ?? values[2];
    const credentialRef2 = flag(args2, "--ref");
    if (commandId === "auth.login") {
      if (!providerId) throw new Error("auth login requires a provider identifier");
      return {
        providerId,
        ...credentialRef2 ? { credentialRef: credentialRef2 } : {},
        ...flag(args2, "--backend") ? { backend: flag(args2, "--backend") } : {},
        ...flag(args2, "--kind") ? { kind: flag(args2, "--kind") } : {},
        scopes: (flag(args2, "--scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean)
      };
    }
    return {
      ...providerId ? { providerId } : {},
      ...credentialRef2 ? { credentialRef: credentialRef2 } : {}
    };
  }
  if (commandId === "upgrade.plan" || commandId === "upgrade.dry-run" || commandId === "upgrade.apply") {
    const releaseLocator = flag(args2, "--release") ?? values[2];
    if (!releaseLocator) {
      throw new Error(`${commandId} requires --release <trusted-local-release-root>`);
    }
    return { releaseLocator };
  }
  if (commandId === "fleet.plan" || commandId === "fleet.rollout" || commandId === "fleet.resume") {
    const runId2 = flag(args2, "--run-id");
    const releaseId = flag(args2, "--release-id");
    const ventureIds = (flag(args2, "--venture-ids") ?? flag(args2, "--venture-id") ?? "").split(",").map((venture) => venture.trim()).filter(Boolean);
    const batchSize = Number(flag(args2, "--batch-size") ?? "1");
    if (!runId2 || !releaseId || ventureIds.length === 0) {
      throw new Error(
        `${commandId} requires --run-id, --release-id, and --venture-ids <comma-separated>`
      );
    }
    return { runId: runId2, releaseId, ventureIds, batchSize };
  }
  if (commandId === "fleet.status") {
    const runId2 = flag(args2, "--run-id") ?? values[2];
    return runId2 ? { runId: runId2 } : {};
  }
  return {};
}
function invocation(commandId, input, args2, options) {
  const supplied = flag(args2, "--idempotency-key");
  const digest2 = createHash5("sha256").update(stableJson({ commandId, input })).digest("hex").slice(0, 24);
  return { context: options.context, idempotencyKey: supplied ?? `vh-local-${digest2}` };
}
function rendered(value, json) {
  if (json) return JSON.stringify(value, null, 2);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
  const heading = typeof value.commandId === "string" ? value.commandId : "command";
  const status = typeof value.status === "string" ? value.status : "completed";
  const mode = typeof value.mode === "string" ? ` (${value.mode})` : "";
  return `${heading}: ${status}${mode}`;
}
var OPERATIONAL_CLI_HELP = `Packaged Venture Harness operational CLI

Local and read-only commands:
  vh doctor --json
  vh idea compile --idea <text> --venture-id <id> --name <name> --json
  vh create --venture-id <id> --name <name> --json
  vh venture plan --venture-id <id> --json
  vh venture launch --dry-run --venture-id <id> [--run-id <id>] --json
  vh venture status --venture-id <id> --json
  vh run list | status <run-id>
  vh resume <run-id> --json
  vh org|stack|pack|seed|grant|provider [list]
  vh data sync
  vh learn daily|weekly|biweekly|monthly
  vh growth inspect [--file <growth.yaml>] --json
  vh auth login|status|test|revoke [provider] [--ref <cred://...>]
  vh upgrade plan|dry-run|apply --release <trusted-local-root>
  vh upgrade status
  vh fleet status [--run-id <id>]
  vh fleet plan|rollout|resume --run-id <id> --release-id <id>
      --venture-ids <id,...> [--batch-size <positive-integer>]
  vh verify fast|mvp|release

Every packaged command is noninteractive. The default runtime remains local and
unconfigured for provider effects. A production provider/Stack command requires
--runtime-module <compiled-project-module>, exact --context, and an idempotency
key; publishing, sending, spend, upgrade, and fleet effects remain separately
authorization-gated.`;
async function invokeOperationalCli(bus, args2, options) {
  const json = args2.includes("--json");
  try {
    const resolved = resolveCommand(args2, bus.contracts());
    if (!resolved) throw new Error(`unknown packaged command; run vh --help`);
    const contract = bus.contracts().find((candidate) => candidate.id === resolved.commandId);
    if (!contract) {
      const domain = resolved.tokens[0];
      const next = domain === "auth" ? "choose vh auth login|status|test|revoke" : domain === "upgrade" ? "choose vh upgrade plan|dry-run|apply|status" : domain === "fleet" ? "choose vh fleet status|plan|rollout|resume" : "run vh --help";
      throw new Error(`unknown packaged command: ${resolved.commandId}; ${next}`);
    }
    if (resolved.bootstrap) {
      const ideaInput = inputFor("idea.compile", args2);
      const compiled = await bus.executeById(
        "idea.compile",
        ideaInput,
        invocation("idea.compile", ideaInput, args2, options)
      );
      const createInput = {
        ventureId: ideaInput.ventureId,
        name: ideaInput.name
      };
      const created = await bus.executeById(
        "venture.create",
        createInput,
        invocation("venture.create", createInput, args2, options)
      );
      return {
        exitCode: 0,
        stdout: rendered({ commandId: "venture.bootstrap", compiled, created }, json),
        stderr: ""
      };
    }
    const input = inputFor(resolved.commandId, args2);
    const output = await bus.executeById(
      resolved.commandId,
      input,
      invocation(resolved.commandId, input, args2, options)
    );
    const verifyPassed = resolved.commandId !== "verify.run" || typeof output === "object" && output !== null && !Array.isArray(output) && output.status === "PASS";
    return { exitCode: verifyPassed ? 0 : 1, stdout: rendered(output, json), stderr: "" };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    const failure = error instanceof CommandBusError ? commandFailureEnvelope(error) : {
      error: "operational_command_failed",
      code: "invalid_invocation",
      message
    };
    return {
      exitCode: 1,
      stdout: "",
      stderr: json ? JSON.stringify(failure) : message
    };
  }
}

// packages/cli-generator/src/quality-runner.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync as existsSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync3, realpathSync as realpathSync2 } from "node:fs";
import { basename, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
var SECRET_PATTERNS3 = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END|$)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}/gi,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}/gi
];
function redact2(value) {
  let redacted = SECRET_PATTERNS3.reduce(
    (candidate, pattern) => candidate.replace(pattern, "[REDACTED]"),
    value
  );
  for (const [name, secret] of Object.entries(process.env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)/iu.test(name)) continue;
    if (secret && secret.length >= 8) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
function canonicalRoot(root) {
  const declared = resolve2(root);
  const details = lstatSync2(declared);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("quality runner root must be a regular directory, not a symbolic link");
  }
  return realpathSync2(declared);
}
function inside(root, target) {
  const child = relative2(root, target);
  return child === "" || child !== ".." && !child.startsWith(`..${sep2}`);
}
function assertNoSymlinkPath(root, target) {
  if (!inside(root, target)) throw new Error("quality report path escapes the configured root");
  const child = relative2(root, target);
  let cursor = root;
  for (const segment of child.split(sep2).filter(Boolean)) {
    cursor = join2(cursor, segment);
    if (!existsSync2(cursor)) break;
    if (lstatSync2(cursor).isSymbolicLink()) {
      throw new Error("quality report path must not contain symbolic links");
    }
  }
}
function reportPath(root, profile) {
  const directory = join2(root, ".venture", "reports", "quality");
  assertNoSymlinkPath(root, directory);
  mkdirSync2(directory, { recursive: true, mode: 448 });
  const canonicalDirectory = realpathSync2(directory);
  if (!inside(root, canonicalDirectory)) throw new Error("quality report directory escapes root");
  return join2(canonicalDirectory, `vh-${profile}-${process.pid}-${randomUUID3()}.json`);
}
function assertCommand(command) {
  if (command.length === 0 || command.some((value) => typeof value !== "string" || !value)) {
    throw new Error("quality profile command must be a non-empty argv array");
  }
  const tokens = command.map((value) => value.toLowerCase());
  const executable = basename(tokens[0]);
  if (executable === "vh" && tokens[1] === "verify" || tokens.some((token, index) => token === "vh" && tokens[index + 1] === "verify")) {
    throw new Error("quality profile command must not recurse into vh verify");
  }
}
function materializeCommand(template, profile, targetReport) {
  const command = template.map(
    (value) => value.replaceAll("{profile}", profile).replaceAll("{report}", targetReport)
  );
  assertCommand(command);
  return command;
}
function capture(limit) {
  let text = "";
  let truncated = false;
  return {
    append(chunk) {
      if (truncated) return;
      const value = chunk.toString();
      const remaining = limit - Buffer.byteLength(text);
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const bytes = Buffer.from(value);
      text += bytes.subarray(0, remaining).toString();
      if (bytes.byteLength > remaining) truncated = true;
    },
    value() {
      return redact2(`${text}${truncated ? "\n[OUTPUT TRUNCATED]" : ""}`);
    }
  };
}
function count(summary, field) {
  const value = summary[field];
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
function readReport(path, profile) {
  if (!existsSync2(path)) return null;
  const raw = JSON.parse(readFileSync3(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("quality runner report must be a JSON object");
  }
  const report = raw;
  if (report.profile !== profile) throw new Error("quality runner report profile mismatch");
  if (!report.summary || typeof report.summary !== "object" || Array.isArray(report.summary)) {
    throw new Error("quality runner report summary is missing");
  }
  const summaryRecord = report.summary;
  const summary = {
    PASS: count(summaryRecord, "PASS"),
    FAIL: count(summaryRecord, "FAIL"),
    SKIP: count(summaryRecord, "SKIP"),
    NOT_APPLICABLE: count(summaryRecord, "NOT_APPLICABLE")
  };
  const reportedStatus = report.status;
  if (!["PASS", "FAIL", "INCOMPLETE"].includes(reportedStatus)) {
    throw new Error("quality runner report status is invalid");
  }
  return { status: reportedStatus, summary };
}
function finalStatus(exitCode, report) {
  if (exitCode !== 0 || report?.status === "FAIL" || Number(report?.summary.FAIL ?? 0) > 0) {
    return "FAIL";
  }
  if (!report || report.status === "INCOMPLETE" || Number(report.summary.SKIP ?? 0) > 0) {
    return "INCOMPLETE";
  }
  return "PASS";
}
function createProcessQualityProfileRunner(options) {
  const root = canonicalRoot(options.root);
  const outputLimit = options.outputLimitBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 30 * 6e4;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1024) {
    throw new Error("quality output limit must be at least 1024 bytes");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("quality timeout must be a positive safe integer");
  }
  for (const command of Object.values(options.commands)) assertCommand(command);
  return Object.freeze({
    async run(profile) {
      const targetReport = reportPath(root, profile);
      const command = materializeCommand(options.commands[profile], profile, targetReport);
      const stdout = capture(outputLimit);
      const stderr = capture(outputLimit);
      let timedOut = false;
      const exitCode = await new Promise((resolveExit, reject) => {
        const child = spawn(command[0], command.slice(1), {
          cwd: root,
          env: process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", (chunk) => stdout.append(chunk));
        child.stderr.on("data", (chunk) => stderr.append(chunk));
        child.once("error", reject);
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolveExit(code ?? 1);
        });
      }).catch((error) => {
        stderr.append(error instanceof Error ? error.message : String(error));
        return 1;
      });
      let report = null;
      try {
        report = readReport(targetReport, profile);
      } catch (error) {
        stderr.append(error instanceof Error ? error.message : String(error));
      }
      const status = timedOut ? "FAIL" : finalStatus(exitCode, report);
      return {
        profile,
        status,
        exitCode: status === "PASS" ? 0 : 1,
        summary: report?.summary ?? { PASS: 0, FAIL: status === "FAIL" ? 1 : 0, SKIP: 0 },
        command: command.map((value) => redact2(value)),
        stdout: stdout.value(),
        stderr: `${stderr.value()}${timedOut ? "\nquality profile timed out" : ""}`.trim(),
        reportPath: relative2(root, targetReport)
      };
    }
  });
}
function createRepositoryQualityProfileRunner(root) {
  const canonical = canonicalRoot(root);
  const runnerPath = join2(canonical, "scripts", "run-quality-profile.ts");
  const configured = existsSync2(runnerPath) && !lstatSync2(runnerPath).isSymbolicLink() && lstatSync2(runnerPath).isFile() && inside(canonical, realpathSync2(runnerPath));
  if (!configured) {
    return Object.freeze({
      async run(profile) {
        return {
          profile,
          status: "INCOMPLETE",
          exitCode: 1,
          summary: { PASS: 0, FAIL: 0, SKIP: 1, NOT_APPLICABLE: 0 },
          command: [],
          stdout: "",
          stderr: "The project has no trusted scripts/run-quality-profile.ts runner.",
          reportPath: null
        };
      }
    });
  }
  const command = [
    "pnpm",
    "exec",
    "tsx",
    "scripts/run-quality-profile.ts",
    "{profile}",
    "--report",
    "{report}"
  ];
  return createProcessQualityProfileRunner({
    root: canonical,
    commands: { fast: command, mvp: command, release: command }
  });
}

// packages/cli-generator/src/runtime-module.ts
import { existsSync as existsSync3, lstatSync as lstatSync3, realpathSync as realpathSync3 } from "node:fs";
import { extname, join as join3, relative as relative3, resolve as resolve3, sep as sep3 } from "node:path";
import { pathToFileURL } from "node:url";
function canonicalRoot2(root) {
  const declared = resolve3(root);
  const details = lstatSync3(declared);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("runtime project root must be a regular directory, not a symbolic link");
  }
  return realpathSync3(declared);
}
function inside2(root, target) {
  const child = relative3(root, target);
  return child === "" || child !== ".." && !child.startsWith(`..${sep3}`);
}
function assertNoSymlinkComponents(root, target, allowMissingLeaf) {
  if (!inside2(root, target)) throw new Error("runtime path must stay within the project root");
  const child = relative3(root, target);
  let cursor = root;
  for (const [index, segment] of child.split(sep3).filter(Boolean).entries()) {
    cursor = join3(cursor, segment);
    if (!existsSync3(cursor)) {
      if (allowMissingLeaf) return;
      throw new Error("runtime module does not exist");
    }
    if (lstatSync3(cursor).isSymbolicLink()) {
      throw new Error("runtime path must not contain symbolic links");
    }
    if (index < child.split(sep3).filter(Boolean).length - 1 && !lstatSync3(cursor).isDirectory()) {
      throw new Error("runtime path parent must be a directory");
    }
  }
}
function projectOwnedFile(root, path) {
  const target = resolve3(root, path);
  assertNoSymlinkComponents(root, target, false);
  const child = relative3(root, target);
  const first = child.split(sep3)[0];
  if (["node_modules", ".git", ".pnpm"].includes(first ?? "")) {
    throw new Error("runtime module must be a project-owned file outside dependency metadata");
  }
  if (![".js", ".mjs", ".cjs"].includes(extname(target))) {
    throw new Error("runtime module must be compiled JavaScript (.js, .mjs, or .cjs)");
  }
  const details = lstatSync3(target);
  if (!details.isFile()) throw new Error("runtime module must be a regular file");
  const canonical = realpathSync3(target);
  if (!inside2(root, canonical)) throw new Error("runtime module resolves outside the project root");
  return canonical;
}
function projectOwnedStateDirectory(root, path) {
  const target = resolve3(root, path);
  assertNoSymlinkComponents(root, target, true);
  return target;
}
function assertProductionRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("createVhRuntime must return a VentureRuntime object");
  }
  const runtime = value;
  if (runtime.executionMode !== "production") {
    throw new Error("explicit runtime module must compose commandExecutionMode=production");
  }
  const durability = runtime.durability;
  const required = ["commandIdempotency", "audit", "securityAudit", "events", "metering"];
  if (!durability || required.some((field) => durability[field] !== "durable_atomic")) {
    throw new Error(
      "explicit production runtime requires durable atomic command and evidence stores"
    );
  }
  if (!runtime.bus || typeof runtime.bus.contracts !== "function" || !Array.isArray(runtime.contracts) || typeof runtime.execute !== "function") {
    throw new Error("createVhRuntime returned an invalid command runtime shape");
  }
}
async function loadProductionRuntimeModule(options) {
  const root = canonicalRoot2(options.projectRoot);
  const modulePath = projectOwnedFile(root, options.runtimeModule);
  const stateDirectory = projectOwnedStateDirectory(root, options.stateDirectory);
  const loaded = await import(pathToFileURL(modulePath).href);
  if (typeof loaded.createVhRuntime !== "function") {
    throw new Error("runtime module must export a createVhRuntime factory");
  }
  const factory = loaded.createVhRuntime;
  const runtime = await factory(
    Object.freeze({ schemaVersion: 1, projectRoot: root, stateDirectory })
  );
  assertProductionRuntime(runtime);
  return runtime;
}

// packages/cli-generator/src/index.ts
function flag2(args2, name) {
  const index = args2.indexOf(name);
  return index >= 0 ? args2[index + 1] : void 0;
}
function renderCliSuccess(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return String(value);
  const record = value;
  const heading = typeof record.commandId === "string" ? record.commandId : "command";
  const status = typeof record.status === "string" ? record.status : "completed";
  const mode = typeof record.mode === "string" ? ` (${record.mode})` : "";
  return `${heading}: ${status}${mode}`;
}
function generateCliHelp(bus) {
  return [
    "Venture Harness generated command surfaces",
    "",
    ...bus.contracts().map(
      (contract) => `  vh ${contract.surfaces.cli.tokens.join(" ")} --input <json> --context <json> --idempotency-key <key>
      ${contract.description}`
    )
  ].join("\n");
}
function createCliSurface(bus) {
  return {
    help: generateCliHelp(bus),
    async invoke(args2, options) {
      const contract = bus.contracts().find(
        (candidate) => candidate.surfaces.cli.tokens[0] === args2[0] && candidate.surfaces.cli.tokens[1] === args2[1]
      );
      if (!contract) return { exitCode: 2, stdout: "", stderr: "unknown generated command" };
      try {
        const rawInput = flag2(args2, "--input");
        const rawContext = flag2(args2, "--context");
        const context2 = options?.context ?? (rawContext ? JSON.parse(rawContext) : void 0);
        const idempotencyKey = options?.idempotencyKey ?? flag2(args2, "--idempotency-key");
        if (!rawInput || !context2 || !idempotencyKey)
          throw new Error("--input, --context, and --idempotency-key are required");
        const output = await bus.executeById(contract.id, JSON.parse(rawInput), {
          context: context2,
          idempotencyKey
        });
        return { exitCode: 0, stdout: JSON.stringify(output), stderr: "" };
      } catch (error) {
        const failure = commandFailureEnvelope(error);
        const json = args2.includes("--json");
        return {
          exitCode: 1,
          stdout: "",
          stderr: json ? JSON.stringify(failure) : failure.message,
          failure
        };
      }
    }
  };
}

// packages/cli-generator/src/bin.ts
var args = process.argv.slice(2);
if (args[0] === "--") args.shift();
function flag3(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : void 0;
}
function context(requireExplicit) {
  const raw = flag3("--context");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("--context must be valid JSON");
    }
  }
  if (requireExplicit) {
    throw new Error("--context is required with an explicit production runtime module");
  }
  const organizationId = flag3("--org-id") ?? "local-org";
  const ventureId2 = flag3("--venture-id") ?? "local-venture";
  return {
    identity: { actorId: "local-operator", kind: "user" },
    tenant: { organizationId, ventureId: ventureId2 },
    subscription: { subscriptionId: "local-none", status: "none", plan: "local" },
    entitlements: [],
    scopes: [],
    grants: []
  };
}
async function main() {
  if (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    const localContext = context(false);
    const localRuntime = createVentureRuntime({
      commandExecutionMode: "fixture",
      memberships: [
        {
          organizationId: localContext.tenant.organizationId,
          actorId: localContext.identity.actorId,
          role: "operator",
          active: true
        }
      ],
      growthContractRoot: process.cwd()
    });
    console.log(
      `${OPERATIONAL_CLI_HELP}

Typed Agent Surface form:
${createCliSurface(localRuntime.bus).help}`
    );
    return;
  }
  const runtimeModule = flag3("--runtime-module");
  const projectRoot = resolve4(flag3("--project-root") ?? process.cwd());
  const stateDirectoryFlag = flag3("--state-dir") ?? ".venture-harness";
  const invocationContext = context(Boolean(runtimeModule));
  if (runtimeModule && !flag3("--idempotency-key")) {
    throw new Error("--idempotency-key is required with an explicit production runtime module");
  }
  const stateDirectory = resolve4(projectRoot, stateDirectoryFlag);
  const runtime = runtimeModule ? await loadProductionRuntimeModule({
    projectRoot,
    runtimeModule,
    stateDirectory: stateDirectoryFlag
  }) : createVentureRuntime(
    (() => {
      const options = {
        commandExecutionMode: "fixture",
        memberships: [
          {
            organizationId: invocationContext.tenant.organizationId,
            actorId: invocationContext.identity.actorId,
            role: "operator",
            active: true
          }
        ],
        growthContractRoot: projectRoot,
        operationalStore: new FileOperationalStateStore(stateDirectory),
        qualityProfileRunner: createRepositoryQualityProfileRunner(projectRoot)
      };
      return options;
    })()
  );
  const cli = createCliSurface(runtime.bus);
  if (args[0] === "commands") {
    console.log(
      JSON.stringify(
        runtime.contracts.map((contract) => ({
          id: contract.id,
          description: contract.description,
          surfaces: contract.surfaces,
          packagedMode: ["auth.", "upgrade.", "fleet."].some(
            (prefix) => contract.id.startsWith(prefix)
          ) ? "authorized_host_operation" : operationalCommandContracts.some(({ id }) => id === contract.id) ? "local_or_read_only" : "authorized_business_command"
        })),
        null,
        2
      )
    );
    return;
  }
  const exact = runtime.contracts.find(
    (contract) => contract.surfaces.cli.tokens[0] === args[0] && contract.surfaces.cli.tokens[1] === args[1]
  );
  const operational = exact ? operationalCommandContracts.some(({ id }) => id === exact.id) : true;
  const invocation2 = {
    context: invocationContext,
    idempotencyKey: flag3("--idempotency-key") ?? "vh-generated-command"
  };
  const result2 = operational ? await invokeOperationalCli(runtime.bus, args, invocation2) : await cli.invoke(args, invocation2);
  if (!operational && result2.exitCode === 0 && result2.stdout && !args.includes("--json")) {
    try {
      result2.stdout = renderCliSuccess(JSON.parse(result2.stdout));
    } catch {
      result2.exitCode = 1;
      result2.stderr = "command runtime returned invalid JSON";
    }
  }
  if (result2.stdout) console.log(result2.stdout);
  if (result2.stderr) console.error(result2.stderr);
  process.exitCode = result2.exitCode;
}
void main().catch((error) => {
  const json = args.includes("--json");
  const message = error instanceof Error ? error.message : "packaged CLI failed";
  if (json) console.error(JSON.stringify({ error: "cli_initialization_failed", message }));
  else console.error(message);
  process.exitCode = 1;
});
