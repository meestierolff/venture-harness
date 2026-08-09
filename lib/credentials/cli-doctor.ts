import type { CommandRunner } from "./types";
import { Redactor } from "./redaction";

export interface CliPrerequisite {
  id: string;
  binary: string;
  args: readonly string[];
  purpose: string;
}

export interface CliPrerequisiteResult {
  id: string;
  binary: string;
  purpose: string;
  status: "installed" | "missing" | "unavailable";
  version: string | null;
  nextAction: string | null;
}

export const CLI_PREREQUISITES: readonly CliPrerequisite[] = [
  { id: "github", binary: "gh", args: ["--version"], purpose: "GitHub provider operations" },
  {
    id: "vercel",
    binary: "vercel",
    args: ["--version"],
    purpose: "Vercel project and deployment operations",
  },
  {
    id: "stripe",
    binary: "stripe",
    args: ["version"],
    purpose: "Stripe authentication and local webhook checks",
  },
  {
    id: "neon",
    binary: "neonctl",
    args: ["--version"],
    purpose: "Neon control-plane operations",
  },
  {
    id: "postgres",
    binary: "psql",
    args: ["--version"],
    purpose: "Neon schema migration and read/write verification",
  },
  { id: "eas", binary: "eas", args: ["--version"], purpose: "Expo/EAS build and submit" },
  {
    id: "xcode",
    binary: "xcodebuild",
    args: ["-version"],
    purpose: "SwiftUI and local iOS validation",
  },
  {
    id: "codex",
    binary: "codex",
    args: ["--version"],
    purpose: "Optional noninteractive model/build host",
  },
] as const;

function compactVersion(value: string, redactor: Redactor): string | null {
  const line = redactor
    .redactText(value)
    .split(/\r?\n/)
    .find((item) => item.trim().length > 0);
  return line ? line.trim().slice(0, 200) : null;
}

export async function inspectCliPrerequisites(
  runner: CommandRunner,
  options: { prerequisites?: readonly CliPrerequisite[]; redactor?: Redactor } = {},
): Promise<CliPrerequisiteResult[]> {
  const redactor = options.redactor ?? new Redactor();
  return Promise.all(
    (options.prerequisites ?? CLI_PREREQUISITES).map(async (prerequisite) => {
      try {
        const result = await runner.run({
          command: prerequisite.binary,
          args: prerequisite.args,
        });
        if (result.exitCode === 0) {
          return {
            id: prerequisite.id,
            binary: prerequisite.binary,
            purpose: prerequisite.purpose,
            status: "installed" as const,
            version: compactVersion(result.stdout || result.stderr, redactor),
            nextAction: null,
          };
        }
        return {
          id: prerequisite.id,
          binary: prerequisite.binary,
          purpose: prerequisite.purpose,
          status: "unavailable" as const,
          version: null,
          nextAction: `${prerequisite.binary} exists but its version check exited ${result.exitCode}; repair or reinstall it.`,
        };
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        return {
          id: prerequisite.id,
          binary: prerequisite.binary,
          purpose: prerequisite.purpose,
          status: missing ? ("missing" as const) : ("unavailable" as const),
          version: null,
          nextAction: missing
            ? `Install ${prerequisite.binary} before using ${prerequisite.purpose}.`
            : `${prerequisite.binary} could not be inspected: ${redactor.redactText(
                error instanceof Error ? error.message : String(error),
              )}`,
        };
      }
    }),
  );
}
