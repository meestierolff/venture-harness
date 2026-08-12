import { z } from "zod";
import type { ProviderExecutionReport, ProviderId, ProviderVerificationReport } from "./types";

export const publicDnsRecordSchema = z
  .object({
    source_provider: z.enum(["vercel", "google", "brevo"]),
    type: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "CAA"]),
    name: z.string().min(1).max(253),
    value: z.string().min(1).max(4_096),
    ttl: z.number().int().min(60).max(86_400),
    priority: z.number().int().min(0).max(65_535).optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type PublicDnsRecord = z.infer<typeof publicDnsRecordSchema>;

export const publicProviderIdentifierSchema = z
  .object({
    type: z.enum([
      "property_id",
      "stream_id",
      "measurement_id",
      "product_id",
      "price_id",
      "build_id",
      "submission_id",
      "app_id",
      "apple_build_id",
      "testflight_group_id",
      "app_version",
      "build_number",
    ]),
    value: z.string().min(1).max(500),
  })
  .strict();

export type PublicProviderIdentifier = z.infer<typeof publicProviderIdentifierSchema>;

export const providerPublicOutputsSchema = z
  .object({
    dnsRecords: z.array(publicDnsRecordSchema).max(100).default([]),
    identifiers: z.array(publicProviderIdentifierSchema).max(100).default([]),
  })
  .strict();

export type ProviderPublicOutputs = z.infer<typeof providerPublicOutputsSchema>;

const providerOrder = { vercel: 0, google: 1, brevo: 2 } as const;

export function orderPublicDnsRecords(records: readonly PublicDnsRecord[]): PublicDnsRecord[] {
  const unique = new Map<string, PublicDnsRecord>();
  for (const candidate of records) {
    const record = publicDnsRecordSchema.parse(candidate);
    unique.set(
      [
        record.source_provider,
        record.type,
        record.name,
        record.value,
        record.ttl,
        record.priority ?? "",
      ].join("\u0000"),
      record,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      providerOrder[left.source_provider] - providerOrder[right.source_provider] ||
      left.type.localeCompare(right.type) ||
      left.name.localeCompare(right.name) ||
      left.value.localeCompare(right.value) ||
      left.ttl - right.ttl ||
      (left.priority ?? -1) - (right.priority ?? -1),
  );
}

function objects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => objects(item, depth + 1));
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap((item) => objects(item, depth + 1))];
}

function scalar(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (
    text.length === 0 ||
    text.length > 4_096 ||
    text.startsWith("cred://") ||
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    return undefined;
  }
  return text;
}

function dnsType(value: unknown): PublicDnsRecord["type"] | undefined {
  const parsed = z
    .enum(["A", "AAAA", "CNAME", "TXT", "MX", "CAA"])
    .safeParse(typeof value === "string" ? value.toUpperCase() : value);
  return parsed.success ? parsed.data : undefined;
}

function recordsFromBrevo(value: unknown): PublicDnsRecord[] {
  const records: PublicDnsRecord[] = [];
  for (const object of objects(value)) {
    const dns = object.dns_records;
    if (!dns || Array.isArray(dns) || typeof dns !== "object") continue;
    for (const candidate of Object.values(dns as Record<string, unknown>)) {
      if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") continue;
      const item = candidate as Record<string, unknown>;
      const type = dnsType(item.type);
      const value = scalar(item.value);
      const name = scalar(item.host_name) ?? "@";
      if (!type || !value) continue;
      records.push({
        source_provider: "brevo",
        type,
        name: name === "" ? "@" : name.replace(/\.$/, "") || "@",
        value,
        ttl: typeof item.ttl === "number" ? item.ttl : 3_600,
        ...(typeof item.priority === "number" ? { priority: item.priority } : {}),
        reason: "Authenticate the configured Brevo sending domain.",
      });
    }
  }
  return records;
}

function recordsFromGoogle(
  value: unknown,
  inputs: Readonly<Record<string, unknown>>,
): PublicDnsRecord[] {
  const records: PublicDnsRecord[] = [];
  for (const object of objects(value)) {
    const method = scalar(object.method);
    const token = scalar(object.token);
    if (method !== "DNS_TXT" || !token) continue;
    records.push({
      source_provider: "google",
      type: "TXT",
      name: "@",
      value: token,
      ttl: typeof inputs.dnsTtl === "number" ? inputs.dnsTtl : 3_600,
      reason: `Verify ${scalar(inputs.siteIdentifier) ?? "the configured domain"} with Google Site Verification.`,
    });
  }
  return records;
}

function recordsFromVercel(value: unknown): PublicDnsRecord[] {
  const records: PublicDnsRecord[] = [];
  for (const object of objects(value)) {
    for (const key of ["verification", "dnsRecords", "dns_records"] as const) {
      const candidates = object[key];
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") continue;
        const item = candidate as Record<string, unknown>;
        const type = dnsType(item.type);
        const name = scalar(item.domain) ?? scalar(item.name) ?? scalar(item.host);
        const value = scalar(item.value) ?? scalar(item.target);
        if (!type || !name || !value) continue;
        records.push({
          source_provider: "vercel",
          type,
          name,
          value,
          ttl: typeof item.ttl === "number" ? item.ttl : 300,
          ...(typeof item.priority === "number" ? { priority: item.priority } : {}),
          reason: scalar(item.reason) ?? "Attach and verify the configured Vercel domain.",
        });
      }
    }
  }
  return records;
}

function identifier(
  identifiers: Map<string, PublicProviderIdentifier>,
  type: PublicProviderIdentifier["type"],
  value: unknown,
  transform: (text: string) => string = (text) => text,
): void {
  const safe = scalar(value);
  if (!safe || safe.length > 500) return;
  const parsed = publicProviderIdentifierSchema.safeParse({ type, value: transform(safe) });
  if (parsed.success) identifiers.set(`${type}\u0000${parsed.data.value}`, parsed.data);
}

export function collectProviderPublicOutputs(input: {
  provider: ProviderId;
  requestInputs: Readonly<Record<string, unknown>>;
  report: ProviderExecutionReport;
  verification: ProviderVerificationReport;
}): ProviderPublicOutputs {
  const successful = input.report.operations.filter(({ result }) => result.status === "succeeded");
  const raw = [
    ...successful.map(({ result }) => result.output),
    ...input.verification.checks.map(({ evidence }) => evidence),
  ];
  const dnsRecords =
    input.provider === "brevo"
      ? raw.flatMap(recordsFromBrevo)
      : input.provider === "google"
        ? raw.flatMap((value) => recordsFromGoogle(value, input.requestInputs))
        : input.provider === "vercel"
          ? raw.flatMap(recordsFromVercel)
          : [];
  const identifiers = new Map<string, PublicProviderIdentifier>();
  for (const operation of successful) {
    for (const object of objects(operation.result.output)) {
      if (operation.operation.capability === "analytics_property") {
        const name = scalar(object.name);
        if (name?.startsWith("properties/")) {
          identifier(identifiers, "property_id", name, (value) =>
            value.slice("properties/".length),
          );
        }
      }
      if (operation.operation.capability === "analytics_web_stream") {
        const name = scalar(object.name);
        if (name?.includes("/dataStreams/")) {
          identifier(identifiers, "stream_id", name, (value) => value.split("/").at(-1)!);
        }
        identifier(identifiers, "measurement_id", object.measurementId);
      }
      if (operation.operation.capability === "product") {
        identifier(identifiers, "product_id", object.id);
      }
      if (operation.operation.capability === "price") {
        identifier(identifiers, "price_id", object.id);
      }
      if (operation.operation.capability === "ios_build") {
        identifier(identifiers, "build_id", object.id);
        identifier(identifiers, "app_version", object.appVersion);
        identifier(identifiers, "build_number", object.appBuildVersion ?? object.buildNumber);
      }
      if (operation.operation.capability === "ios_submit") {
        identifier(identifiers, "submission_id", object.id);
      }
      if (operation.operation.capability === "build_processing") {
        identifier(identifiers, "apple_build_id", object.id);
      }
      if (operation.operation.capability === "testflight_group") {
        identifier(identifiers, "testflight_group_id", object.id);
      }
    }
  }
  return providerPublicOutputsSchema.parse({
    dnsRecords: orderPublicDnsRecords(dnsRecords),
    identifiers: [...identifiers.values()].sort(
      (left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
    ),
  });
}

export function publicIdentifier(
  output: unknown,
  type: PublicProviderIdentifier["type"],
): string | undefined {
  if (!output || Array.isArray(output) || typeof output !== "object") return undefined;
  const parsed = providerPublicOutputsSchema.safeParse(
    (output as Record<string, unknown>).publicOutputs,
  );
  if (!parsed.success) return undefined;
  const values = parsed.data.identifiers
    .filter((item) => item.type === type)
    .map(({ value }) => value);
  return new Set(values).size === 1 ? values[0] : undefined;
}
