import type {
  ActionScore,
  AgenticReflexInput,
  CandidateAgentAction,
  ReflexDecision,
} from "./types";

export function scoreCandidateActions(
  input: AgenticReflexInput,
  intent: ReflexDecision,
): ActionScore[] {
  return buildCandidateActions(input.allowedToolNames)
    .map((action) => ({
      action,
      score: scoreByIntentAndState(action, intent, input),
      reason: explainActionScore(action, intent),
    }))
    .sort((left, right) => right.score - left.score);
}

export function buildCandidateActions(
  allowedToolNames: Set<string>,
): CandidateAgentAction[] {
  const actions: CandidateAgentAction[] = [];

  if (allowedToolNames.has("read_current_file")) {
    actions.push({
      kind: "read_current_note",
      toolName: "read_current_file",
      risk: "read",
      rationale: "Current-note evidence may be required.",
    });
  }
  if (allowedToolNames.has("semantic_search_notes")) {
    actions.push({
      kind: "semantic_search",
      toolName: "semantic_search_notes",
      risk: "read",
      rationale: "Conceptual vault evidence.",
    });
  }
  if (allowedToolNames.has("search_markdown_files")) {
    actions.push({
      kind: "search_vault",
      toolName: "search_markdown_files",
      risk: "read",
      rationale: "Lexical vault evidence.",
    });
  }
  if (allowedToolNames.has("web_search")) {
    actions.push({
      kind: "web_search",
      toolName: "web_search",
      risk: "external",
      rationale: "External source discovery.",
    });
  }
  if (allowedToolNames.has("web_fetch")) {
    actions.push({
      kind: "web_fetch",
      toolName: "web_fetch",
      risk: "external",
      rationale: "Fetch selected source content.",
    });
  }
  if (allowedToolNames.has("count_words")) {
    actions.push({
      kind: "count_words",
      toolName: "count_words",
      risk: "read",
      rationale: "Word-count verification.",
    });
  }
  if (
    allowedToolNames.has("create_design_canvas") ||
    allowedToolNames.has("create_svg_design") ||
    allowedToolNames.has("create_design_package")
  ) {
    actions.push({
      kind: "create_artifact",
      toolName: allowedToolNames.has("create_design_package")
        ? "create_design_package"
        : allowedToolNames.has("create_svg_design")
          ? "create_svg_design"
          : "create_design_canvas",
      risk: "write",
      rationale: "Create requested design artifact.",
    });
  }
  if (allowedToolNames.has("append_to_current_file")) {
    actions.push({
      kind: "write_current_note",
      toolName: "append_to_current_file",
      risk: "write",
      rationale: "Write required current-note output.",
    });
  }

  actions.push({
    kind: "answer",
    risk: "none",
    rationale: "Synthesize if evidence and receipts are sufficient.",
  });
  actions.push({
    kind: "stop_with_blocker",
    risk: "none",
    rationale: "Stop when required evidence or authority is unavailable.",
  });
  return actions;
}

function scoreByIntentAndState(
  action: CandidateAgentAction,
  intent: ReflexDecision,
  input: AgenticReflexInput,
): number {
  let score = 0.25;
  if (
    intent.label === "semantic_vault_search" &&
    action.kind === "semantic_search"
  ) {
    score += 0.55;
  }
  if (intent.label === "vault_search" && action.kind === "search_vault") {
    score += 0.5;
  }
  if (intent.label === "web_research" && action.kind === "web_search") {
    score += 0.55;
  }
  if (intent.label === "word_count" && action.kind === "count_words") {
    score += 0.55;
  }
  if (intent.label === "design_artifact" && action.kind === "create_artifact") {
    score += 0.55;
  }
  if (input.evidence.length > 0 && action.kind === "answer") {
    score += 0.3;
  }
  if (input.missionIntent.requireWriteCompletion && action.kind === "write_current_note") {
    score += 0.35;
  }
  if (input.evidence.length === 0 && action.kind === "answer") {
    score -= 0.2;
  }
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}

function explainActionScore(
  action: CandidateAgentAction,
  intent: ReflexDecision,
): string {
  if (intent.label !== "unknown" && action.rationale) {
    return `${action.rationale} Intent=${intent.label}.`;
  }
  return action.rationale;
}
