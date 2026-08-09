import type { JsonObject, JsonValue } from "@venture-harness/core";

export const QUALITY_PROFILE_IDS = ["fast", "mvp", "release"] as const;
export type QualityProfileId = (typeof QUALITY_PROFILE_IDS)[number];
export type QualityProfileStatus = "PASS" | "FAIL" | "INCOMPLETE";

export interface QualityProfileRunResult extends JsonObject {
  profile: QualityProfileId;
  status: QualityProfileStatus;
  exitCode: number;
  summary: JsonObject;
  command: JsonValue;
  stdout: string;
  stderr: string;
  reportPath: string | null;
}

export interface QualityProfileRunner {
  run(profile: QualityProfileId): Promise<QualityProfileRunResult>;
}

export const unconfiguredQualityProfileRunner: QualityProfileRunner = Object.freeze({
  async run(profile: QualityProfileId): Promise<QualityProfileRunResult> {
    return {
      profile,
      status: "INCOMPLETE",
      exitCode: 1,
      summary: { PASS: 0, FAIL: 0, SKIP: 1, NOT_APPLICABLE: 0 },
      command: [],
      stdout: "",
      stderr: "No repository quality-profile runner is configured; no verification command ran.",
      reportPath: null,
    };
  },
});
