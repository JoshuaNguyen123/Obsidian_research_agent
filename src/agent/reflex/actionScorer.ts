import type {
  ActionScore,
  AgenticReflexInput,
  CandidateAgentAction,
  ReflexDecision,
} from "./types";
import {
  classifyToolTargetKind,
  MAX_OUTCOME_PENALTY,
  outcomePenaltyForAction,
} from "../outcomeMemory";

export function scoreCandidateActions(
  input: AgenticReflexInput,
  intent: ReflexDecision,
): ActionScore[] {
  return buildCandidateActions(input.allowedToolNames)
    .map((action) => {
      const baseScore = scoreByIntentAndState(action, intent, input);
      const rawOutcomePenalty =
        action.toolName && input.toolOutcomeMemory
          ? outcomePenaltyForAction(
              input.toolOutcomeMemory,
              action.toolName,
              classifyToolTargetKind(action.toolName),
            )
          : 0;
      const outcomePenalty = round3(
        Math.min(1, Math.max(0, rawOutcomePenalty / MAX_OUTCOME_PENALTY)),
      );
      return {
        action,
        baseScore,
        outcomePenalty,
        score: round3(Math.max(0, Math.min(1, baseScore - outcomePenalty))),
        reason: explainActionScore(action, intent, outcomePenalty),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        actionSortKey(left.action).localeCompare(actionSortKey(right.action)),
    );
}

export function buildCandidateActions(
  allowedToolNames: Set<string>,
): CandidateAgentAction[] {
  const actions: CandidateAgentAction[] = [];
  const representedToolNames = new Set<string>();
  const add = (action: CandidateAgentAction): void => {
    if (action.toolName) {
      if (representedToolNames.has(action.toolName)) return;
      representedToolNames.add(action.toolName);
    }
    actions.push(action);
  };

  if (allowedToolNames.has("read_current_file")) {
    add({
      kind: "read_current_note",
      toolName: "read_current_file",
      risk: "read",
      rationale: "Current-note evidence may be required.",
    });
  }
  if (allowedToolNames.has("semantic_search_notes")) {
    add({
      kind: "semantic_search",
      toolName: "semantic_search_notes",
      risk: "read",
      rationale: "Conceptual vault evidence.",
    });
  }
  if (allowedToolNames.has("search_markdown_files")) {
    add({
      kind: "search_vault",
      toolName: "search_markdown_files",
      risk: "read",
      rationale: "Lexical vault evidence.",
    });
  }
  if (allowedToolNames.has("web_search")) {
    add({
      kind: "web_search",
      toolName: "web_search",
      risk: "external",
      rationale: "External source discovery.",
    });
  }
  if (allowedToolNames.has("web_fetch")) {
    add({
      kind: "web_fetch",
      toolName: "web_fetch",
      risk: "external",
      rationale: "Fetch selected source content.",
    });
  }
  if (allowedToolNames.has("count_words")) {
    add({
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
    add({
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
    add({
      kind: "write_current_note",
      toolName: "append_to_current_file",
      risk: "write",
      rationale: "Write required current-note output.",
    });
  }

  // The specialized candidates above carry richer intent bonuses, but every
  // remaining allowed tool still needs a score so learned failures can change
  // its rank. This is preference only: all authority continues to live in the
  // scoped registry and prepared-action gates.
  for (const toolName of [...allowedToolNames].sort()) {
    if (representedToolNames.has(toolName)) continue;
    add({
      kind: "use_tool",
      toolName,
      risk: inferDiagnosticRisk(toolName),
      rationale: "Allowed tool available for the current mission.",
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
  outcomePenalty: number,
): string {
  const history =
    outcomePenalty > 0
      ? ` Learned outcome penalty=${outcomePenalty.toFixed(3)}.`
      : "";
  if (intent.label !== "unknown" && action.rationale) {
    return `${action.rationale} Intent=${intent.label}.${history}`;
  }
  return `${action.rationale}${history}`;
}

function inferDiagnosticRisk(
  toolName: string,
): CandidateAgentAction["risk"] {
  const targetKind = classifyToolTargetKind(toolName);
  if (targetKind === "web_resource" || targetKind === "external_service") {
    return "external";
  }
  if (/(?:delete|trash|replace)/iu.test(toolName)) {
    return "destructive";
  }
  if (/(?:append|write|create|edit|move|rename|commit|publish)/iu.test(toolName)) {
    return "write";
  }
  return "read";
}

function actionSortKey(action: CandidateAgentAction): string {
  return action.toolName ?? action.kind;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
