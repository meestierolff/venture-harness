import { createHash } from "node:crypto";
import { looksLikeCredentialValue } from "../config/contracts";
import {
  DataNormalizationError,
  type NormalizedDataset,
  type NormalizedRow,
  type NormalizedScalar,
  type RawProviderDataset,
} from "./types";

const FORBIDDEN_KEYS =
  /^(email|name|first_name|last_name|phone|address|message|search_query|query_text|form_value|password|token|idea|payload|body|free_text|user_content|(?:user|customer|contact|recipient|sender)_(?:email|name|phone|address)|(?:message|email|form|request|response|user)_(?:body|payload|content|text))$/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rejectPrivateValue(
  value: unknown,
  key: string,
  source: RawProviderDataset["source"],
): void {
  if (typeof value === "string") {
    if (EMAIL_VALUE.test(value) || looksLikeCredentialValue(value)) {
      throw new DataNormalizationError(
        `Source ${source} returned prohibited private or credential-shaped data in "${key}".`,
        source,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPrivateValue(entry, `${key}[${index}]`, source));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(nestedKey)) {
      throw new DataNormalizationError(
        `Source ${source} returned prohibited private field "${key}.${nestedKey}"; classify/de-identify it before sync.`,
        source,
      );
    }
    rejectPrivateValue(nestedValue, `${key}.${nestedKey}`, source);
  }
}

function scalar(
  value: unknown,
  key: string,
  source: RawProviderDataset["source"],
): NormalizedScalar {
  rejectPrivateValue(value, key, source);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${key} contains a non-finite number`);
    }
    return value;
  }
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function normalizeRow(
  row: Record<string, unknown>,
  source: RawProviderDataset["source"],
): NormalizedRow {
  const normalized: NormalizedRow = {};
  for (const [key, value] of Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new DataNormalizationError(
        `Source ${source} returned prohibited private field "${key}"; classify/de-identify it before sync.`,
        source,
      );
    }
    normalized[key] = scalar(value, key, source);
  }
  return normalized;
}

function assertTimestamp(value: string, label: string, source: RawProviderDataset["source"]): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new DataNormalizationError(`${label} is not a valid timestamp: ${value}`, source);
  }
}

export function normalizeDataset(raw: RawProviderDataset): NormalizedDataset {
  if (!raw.sourceAccount.trim()) {
    throw new DataNormalizationError("source account/property/site is required", raw.source);
  }
  if (EMAIL_VALUE.test(raw.sourceAccount) || looksLikeCredentialValue(raw.sourceAccount)) {
    throw new DataNormalizationError(
      "source account must be a non-personal identifier and contain no credential material",
      raw.source,
    );
  }
  assertTimestamp(raw.fetchedAt, "fetchedAt", raw.source);
  assertTimestamp(raw.reportingWindow.start, "reportingWindow.start", raw.source);
  assertTimestamp(raw.reportingWindow.end, "reportingWindow.end", raw.source);
  if (Date.parse(raw.reportingWindow.end) < Date.parse(raw.reportingWindow.start)) {
    throw new DataNormalizationError("reporting window end precedes start", raw.source);
  }
  if (!raw.timezone.trim()) throw new DataNormalizationError("timezone is required", raw.source);
  for (const dimension of raw.dimensions) {
    if (FORBIDDEN_KEYS.test(dimension)) {
      throw new DataNormalizationError(
        `Source ${raw.source} declared prohibited private dimension "${dimension}".`,
        raw.source,
      );
    }
  }
  for (const limitation of raw.limitations ?? []) {
    if (EMAIL_VALUE.test(limitation) || looksLikeCredentialValue(limitation)) {
      throw new DataNormalizationError(
        `Source ${raw.source} limitation contains prohibited private or credential-shaped data.`,
        raw.source,
      );
    }
  }
  const rows = raw.rows.map((row) => normalizeRow(row, raw.source));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        source: raw.source,
        account: raw.sourceAccount,
        window: raw.reportingWindow,
        dimensions: [...raw.dimensions].sort(),
        rows,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    id: `${raw.source}-${fingerprint}`,
    provenance: {
      source: raw.source,
      sourceAccount: raw.sourceAccount,
      fetchedAt: raw.fetchedAt,
      reportingWindow: raw.reportingWindow,
      timezone: raw.timezone,
      dimensions: [...new Set(raw.dimensions)].sort(),
      quality: raw.quality ?? "complete",
      limitations: [...new Set(raw.limitations ?? [])].sort(),
      releaseVersion: raw.releaseVersion ?? null,
    },
    rows,
  };
}
