import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { findCredentialMaterial } from "../../packages/core/src/index";
import { founderBriefSchema, type FounderBrief } from "../launch";

export interface CompiledFounderIdea {
  brief: FounderBrief;
  sourceHash: string;
  sourceKind: "structured_brief" | "markdown_idea";
  assumptionsAdded: readonly string[];
  commercialTerms: {
    currency: string;
    monthlyPrice: number | null;
    annualPrice: number | null;
  };
}

const DEFAULT_ASSUMPTIONS = Object.freeze({
  audience: "The initial user is the narrow early-adopter group described by the founder.",
  problem: "The first release addresses the single highest-friction job described in the idea.",
  outcome: "The first release proves one useful outcome rather than a broad product suite.",
  journey: "The smallest journey is discover, start, complete the core outcome, and verify it.",
  signal: "The primary signal is one verified completion of the smallest core journey.",
});

function slug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return /^[a-z][a-z0-9-]+$/.test(normalized)
    ? normalized
    : `venture-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function textLine(source: string, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const match = source.match(new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*:\\s*(.+?)\\s*$`, "im"));
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function heading(source: string): string | undefined {
  return source.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
}

function booleanLine(source: string, labels: readonly string[], fallback: boolean): boolean {
  const raw = textLine(source, labels)?.toLowerCase();
  if (!raw) return fallback;
  if (["yes", "true", "required", "on"].includes(raw)) return true;
  if (["no", "false", "none", "off"].includes(raw)) return false;
  return fallback;
}

function moneyLine(source: string, labels: readonly string[]): number | null {
  const raw = textLine(source, labels);
  if (!raw) return null;
  const normalized = raw.replace(",", ".");
  const match = normalized.match(/(?:^|\s)(\d+(?:\.\d{1,2})?)(?:\s|$|\/)/u);
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(amount * 100)) {
    throw new Error(`${labels[0]} must be a positive amount with at most two decimal places`);
  }
  return amount;
}

function commercialTerms(
  source: string,
  brief: FounderBrief,
): CompiledFounderIdea["commercialTerms"] {
  const monthlyPrice = moneyLine(source, ["Monthly price", "Price per month"]);
  const annualPrice = moneyLine(source, ["Annual price", "Price per year"]);
  const generalPrice = moneyLine(source, ["Price"]);
  const generalInterval = textLine(source, ["Billing", "Billing interval"])?.toLowerCase();
  return Object.freeze({
    currency: brief.currency ?? "EUR",
    monthlyPrice:
      monthlyPrice ??
      (generalPrice !== null && generalInterval !== "annual" && generalInterval !== "yearly"
        ? generalPrice
        : null),
    annualPrice:
      annualPrice ??
      (generalPrice !== null && (generalInterval === "annual" || generalInterval === "yearly")
        ? generalPrice
        : null),
  });
}

function frontMatter(source: string): unknown | undefined {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  return match?.[1] ? parseYaml(match[1]) : undefined;
}

function structuredBrief(source: string): FounderBrief | undefined {
  const candidates = [
    frontMatter(source),
    (() => {
      try {
        return parseYaml(source);
      } catch {
        return undefined;
      }
    })(),
  ];
  for (const candidate of candidates) {
    const result = founderBriefSchema.safeParse(candidate);
    if (result.success) return result.data;
  }
  return undefined;
}

function assertSafeIdea(source: string): void {
  const credential = findCredentialMaterial(source);
  if (credential) {
    throw new Error(
      `Founder idea contains forbidden credential-like material (${credential.kind}); use cred:// references only`,
    );
  }
  if (
    /^\s*(?:[-*]\s*)?(?:[^:\n]{0,80}\b)?(?:api[ _-]?key|token|password|secret|credential|authorization(?:\s+header)?)\s*:/imu.test(
      source,
    )
  ) {
    throw new Error(
      "Founder idea contains a credential-labeled field; remove the value and use a cred:// reference outside the idea",
    );
  }
  if (source.trim().length < 12)
    throw new Error("Founder idea must contain at least 12 non-whitespace characters");
  if (source.length > 100_000)
    throw new Error("Founder idea exceeds the 100000-character launch limit");
}

function markdownBrief(source: string): { brief: FounderBrief; assumptionsAdded: string[] } {
  const title =
    textLine(source, ["Name", "Product", "Venture"]) ?? heading(source) ?? "Founder Venture";
  const explicitAudience = textLine(source, ["Audience", "User", "Initial user", "ICP"]);
  const explicitProblem = textLine(source, ["Problem", "Job", "Problem or job"]);
  const explicitOutcome = textLine(source, ["Outcome", "Core outcome", "Intended outcome"]);
  const explicitJourney = textLine(source, ["Journey", "Core journey", "Smallest journey"]);
  const explicitSignal = textLine(source, ["Success", "Success signal", "Primary signal"]);
  const assumptionsAdded: string[] = [];
  const assume = (value: string | undefined, fallback: string, label: string) => {
    if (value) return value;
    assumptionsAdded.push(`${label}: ${fallback}`);
    return fallback;
  };
  const commerce = (
    textLine(source, ["Commerce", "Monetization", "Revenue model"]) ?? "subscription"
  ).toLowerCase();
  const appKindRaw = (textLine(source, ["Rail", "App", "App kind"]) ?? "web").toLowerCase();
  const appKind = appKindRaw.includes("hybrid")
    ? "hybrid"
    : appKindRaw.includes("ios") || appKindRaw.includes("mobile")
      ? "ios"
      : "web";
  const monetizationModel =
    commerce.includes("none") || commerce.includes("free")
      ? "none"
      : commerce.includes("one")
        ? "one_time"
        : commerce.includes("usage")
          ? "usage_based"
          : commerce.includes("service")
            ? "services"
            : "subscription";
  const domain = textLine(source, ["Domain"]);
  const repositoryVisibility = (
    textLine(source, ["Repository visibility", "Visibility"]) ?? "private"
  ).toLowerCase();
  const brief = founderBriefSchema.parse({
    id: slug(textLine(source, ["Slug", "Id"]) ?? title),
    name: title.slice(0, 100),
    specific_user_or_audience: assume(
      explicitAudience,
      DEFAULT_ASSUMPTIONS.audience,
      "Audience assumption",
    ),
    problem_or_job: assume(explicitProblem, DEFAULT_ASSUMPTIONS.problem, "Problem assumption"),
    intended_outcome: assume(explicitOutcome, DEFAULT_ASSUMPTIONS.outcome, "Outcome assumption"),
    smallest_core_journey: assume(
      explicitJourney,
      DEFAULT_ASSUMPTIONS.journey,
      "Journey assumption",
    ),
    primary_success_signal: slug(
      assume(explicitSignal, DEFAULT_ASSUMPTIONS.signal, "Signal assumption"),
    ).replaceAll("-", "_"),
    material_constraints: [
      "Do not fabricate provider, customer, demand, or verification state",
      "Keep credentials outside the generated repository",
    ],
    known_truths: [
      "The founder supplied this idea as the input for the initial launch compilation.",
      ...(explicitAudience ? ["The initial audience was explicitly supplied."] : []),
      ...(explicitProblem ? ["The initial problem or job was explicitly supplied."] : []),
      ...(explicitOutcome ? ["The intended outcome was explicitly supplied."] : []),
      ...(explicitJourney ? ["The smallest core journey was explicitly supplied."] : []),
      ...(explicitSignal ? ["The primary success signal was explicitly supplied."] : []),
    ],
    assumptions: assumptionsAdded,
    app_kind: appKind,
    requested_mobile_stack: appKind === "web" ? "none" : "auto",
    business_model: "b2b",
    monetization_model: monetizationModel,
    native_digital_goods: appKind !== "web" && commerce.includes("native"),
    target_market: textLine(source, ["Market", "Target market"]) ?? null,
    domain: domain ?? null,
    locale: textLine(source, ["Locale"]) ?? "en-US",
    currency: (textLine(source, ["Currency"]) ?? "EUR").toUpperCase(),
    timezone: textLine(source, ["Timezone"]) ?? "Europe/Amsterdam",
    repository_visibility: repositoryVisibility === "public" ? "public" : "private",
    bundle_identifier: null,
    app_scheme: null,
    factors: {
      smallest_useful_build_cost: "low",
      smallest_useful_build_time: "low",
      reversibility: "high",
      regulatory_or_safety_risk: "low",
      real_usage_required: "high",
      marketplace_cold_start: "low",
      operational_burden: "moderate",
      founder_evidence: "low",
      concierge_delivery_fit: "low",
      app_store_required: appKind === "web" ? "low" : "high",
      deep_native_requirements: "low",
      on_device_requirements: "low",
    },
    needs: {
      authenticated_product: booleanLine(source, ["Auth", "Authentication"], true),
      database: booleanLine(source, ["Database"], true),
      file_storage: booleanLine(source, ["File storage"], false),
      transactional_email: booleanLine(source, ["Email", "Transactional email"], true),
      lifecycle_email: booleanLine(source, ["Lifecycle email"], false),
      feedback: booleanLine(source, ["Feedback"], true),
      analytics: booleanLine(source, ["Analytics"], true),
      search_discovery: booleanLine(source, ["Search", "SEO", "Discovery"], true),
      scheduled_learning: booleanLine(source, ["Learning", "Scheduled learning"], true),
    },
    preferred_dns_provider:
      (textLine(source, ["DNS", "DNS provider"]) ?? "manual").toLowerCase() === "mijndomein"
        ? "mijndomein"
        : "manual",
    ...(booleanLine(source, ["Synthetic", "Fixture"], false) ? { synthetic: true as const } : {}),
    deceptive_request: false,
    unsafe_non_defaultable_choice: null,
    indispensable_missing_credential: null,
  });
  return { brief, assumptionsAdded };
}

export function compileFounderIdea(source: string): CompiledFounderIdea {
  assertSafeIdea(source);
  const hash = createHash("sha256").update(source).digest("hex");
  const structured = structuredBrief(source);
  if (structured) {
    return Object.freeze({
      brief: structured,
      sourceHash: hash,
      sourceKind: "structured_brief",
      assumptionsAdded: Object.freeze([]),
      commercialTerms: commercialTerms(source, structured),
    });
  }
  const compiled = markdownBrief(source);
  return Object.freeze({
    brief: compiled.brief,
    sourceHash: hash,
    sourceKind: "markdown_idea",
    assumptionsAdded: Object.freeze([...compiled.assumptionsAdded]),
    commercialTerms: commercialTerms(source, compiled.brief),
  });
}
