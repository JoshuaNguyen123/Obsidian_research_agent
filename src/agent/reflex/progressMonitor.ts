import type { AgenticReflexInput, ProgressSignal } from "./types";

export function evaluateProgress(input: AgenticReflexInput): ProgressSignal {
  const repeated = countRepeatedRecentToolCalls(input);
  const progressScore = Math.min(
    1,
    input.evidence.length * 0.25 + input.receipts.length * 0.4,
  );
  const loopRiskScore = repeated >= 3
    ? 0.9
    : repeated >= 2
      ? 0.65
      : 0.1;

  return {
    progressScore: roundScore(progressScore),
    loopRiskScore,
    shouldReflect: loopRiskScore >= 0.65,
    shouldStop: loopRiskScore >= 0.85,
    correction:
      loopRiskScore >= 0.85
        ? "block"
        : loopRiskScore >= 0.65
          ? "reflect_once"
          : "none",
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
  const lastEvent = tools.at(-1);
  const last = lastEvent?.signature ?? lastEvent?.name ?? "";
  const state = lastEvent?.stateFingerprint ?? "legacy:no-state";
  let repeated = 0;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const event = tools[index];
    if (
      (event.signature ?? event.name ?? "") !== last ||
      (event.stateFingerprint ?? "legacy:no-state") !== state
    ) {
      break;
    }
    repeated += 1;
  }
  return repeated;
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
