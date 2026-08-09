export interface ThresholdEvaluation {
  metric: string;
  value: number | null;
  threshold: number;
  outcome: "pass" | "fail" | "insufficient_evidence";
}

export function evaluateMinimum(
  metric: string,
  value: number | null,
  threshold: number,
): ThresholdEvaluation {
  if (!Number.isFinite(threshold)) throw new Error("threshold must be finite");
  return {
    metric,
    value,
    threshold,
    outcome: value === null ? "insufficient_evidence" : value >= threshold ? "pass" : "fail",
  };
}
