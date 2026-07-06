import type { AgenticReflexInput, ProgressSignal } from "./types";

export function evaluateProgress(input: AgenticReflexInput): ProgressSignal {
  const repeated = countRepeatedRecentToolCalls(input);
  const noEvidence = input.evidence.length === 0 && input.receipts.length === 0;
  const progressScore = Math.min(
    1,
    input.evidence.length * 0.25 + input.receipts.length * 0.4,
  );
  const loopRiskScore = repeated >= 3 && noEvidence
    ? 0.9
    : repeated >= 2 && noEvidence
      ? 0.65
      : 0.1;

  return {
    progressScore: roundScore(progressScore),
    loopRiskScore,
    shouldReflect: loopRiskScore >= 0.65,
    shouldStop: loopRiskScore >= 0.85,
    reason:
      loopRiskScore >= 0.85
        ? "repeated_tool_calls_without_new_evidence"
        : "progress_ok",
  };
}

function countRepeatedRecentToolCalls(input: AgenticReflexInput): number {
  const tools = input.recentActions
    .filter((event) => event.kind === "tool")
    .slice(-4);
  if (tools.length < 2) {
    return 0;
  }
  const last = tools.at(-1)?.signature ?? tools.at(-1)?.name ?? "";
  return tools.filter((event) => (event.signature ?? event.name ?? "") === last)
    .length;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
