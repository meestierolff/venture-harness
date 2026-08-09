import type { DataFreshnessEntry, DataSourceId } from "../data";

export type LearningCadence = "daily" | "weekly" | "biweekly" | "monthly";
export type LearningAutonomy = "observe" | "report" | "propose" | "open_pr" | "autofix_low_risk";

export interface LearningMetric {
  id: string;
  value: number | null;
  sampleSize: number | null;
  source: DataSourceId;
  window: { start: string; end: string };
  limitation?: string;
  evidenceRefs?: string[];
}

export interface LearningActionCandidate {
  id: string;
  journey: string;
  kind: "verified_bug_fix" | "conceptual_hypothesis" | "metadata_repair" | "config_drift";
  title: string;
  rationale: string;
  evidenceRefs: string[];
  confidence: number;
  risk: "low" | "moderate" | "high";
  effectTypes: string[];
  protectsWinner: boolean;
}

export interface LearningLoopDefinition {
  id: string;
  cadence: LearningCadence;
  requiredSources: { source: DataSourceId; freshnessHours: number }[];
  primaryMetrics: string[];
  guardrailMetrics: string[];
  decisionRules: string[];
  maximumActions: number;
  maximumIterations: number;
  autonomy: LearningAutonomy;
  authorizedEffectTypes: string[];
  outputDestination: string;
  nextRunAt: string | null;
  stopCondition: string;
}

export interface LearningAction extends LearningActionCandidate {
  disposition: "observe" | "report" | "propose" | "open_pr" | "autofix_low_risk";
}

export interface LearningReport {
  loopId: string;
  cadence: LearningCadence;
  generatedAt: string;
  status: "complete" | "insufficient_evidence" | "stopped";
  freshness: DataFreshnessEntry[];
  metrics: LearningMetric[];
  protectedWinners: string[];
  actions: LearningAction[];
  rejectedActions: { id: string; reason: string }[];
  limitations: string[];
  nextRunAt: string | null;
  stopCondition: string;
}

export interface OperatingCadence {
  generatedAt: string;
  nextDailyReview: string | null;
  nextWeeklyReview: string | null;
  nextBiweeklyReview: string | null;
  nextMonthlyReview: string | null;
  missingDataSources: DataSourceId[];
  activeHypotheses: string[];
  activeExperiments: string[];
  activeBlockers: string[];
}
