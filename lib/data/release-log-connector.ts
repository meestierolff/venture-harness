import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DataNormalizationError, type DataConnector, type RawProviderDataset } from "./types";

const releaseLogRowSchema = z
  .object({
    release_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    released_at: z.string().datetime({ offset: true }),
    release_version: z.string().min(1).max(200),
    environment: z.enum(["local", "test", "preview", "production"]),
    status: z.enum(["succeeded", "failed", "rolled_back"]),
    change_kind: z.enum(["code", "config", "content", "metadata", "migration"]),
    journey_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .nullable(),
    incident_count: z.number().int().nonnegative().default(0),
  })
  .strict();

export type ReleaseLogRow = z.infer<typeof releaseLogRowSchema>;

export interface ReleaseLogConnectorOptions {
  rootDir: string;
  path?: string;
  sourceAccount?: string;
  timezone: string;
  windowHours?: number;
}

function inside(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
    return absolute;
  }
  throw new Error(`Release log path escapes the venture root: ${candidate}`);
}

function readRows(path: string): ReleaseLogRow[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new DataNormalizationError(
          `Release log line ${index + 1} is not valid JSON.`,
          "release_log",
        );
      }
      const result = releaseLogRowSchema.safeParse(value);
      if (!result.success) {
        throw new DataNormalizationError(
          `Release log line ${index + 1} contains prohibited or invalid fields: ${result.error.issues
            .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
            .join("; ")}`,
          "release_log",
        );
      }
      return result.data;
    });
}

export function createReleaseLogConnector(options: ReleaseLogConnectorOptions): DataConnector {
  const root = resolve(options.rootDir);
  const path = inside(root, options.path ?? "reports/releases/release-log.jsonl");
  const windowHours = options.windowHours ?? 24 * 30;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("Release-log windowHours must be a positive finite number.");
  }
  return {
    id: "local-release-log",
    source: "release_log",
    transport: "local",
    credentialRequired: false,
    rawExportsCommitted: false,
    async fetch(context): Promise<RawProviderDataset> {
      if (!existsSync(path)) {
        throw new Error(
          `Release log is missing at ${relative(root, path).split(sep).join("/")}; missing is not zero.`,
        );
      }
      const start = new Date(context.now.getTime() - windowHours * 3_600_000);
      const rows = readRows(path).filter((row) => {
        const releasedAt = Date.parse(row.released_at);
        return releasedAt >= start.getTime() && releasedAt < context.now.getTime();
      });
      return {
        source: "release_log",
        sourceAccount: options.sourceAccount ?? "venture-release-log",
        fetchedAt: context.now.toISOString(),
        reportingWindow: { start: start.toISOString(), end: context.now.toISOString() },
        timezone: options.timezone,
        dimensions: ["environment", "status", "change_kind", "journey_id", "release_version"],
        quality: "complete",
        limitations: [
          "Only strict categorical release metadata is normalized; commit messages and free-form release notes are excluded.",
          "Temporal overlap between a release and a metric change does not establish causation.",
        ],
        releaseVersion: rows.length === 1 ? rows[0].release_version : null,
        rows,
      };
    },
  };
}
