/**
 * Stage-local durable-route prompt projection.
 *
 * Durable compound turns must not re-send the full mission history, routing
 * cards, or unrelated stage catalogs. Each model turn gets only:
 *   1. the current stage objective,
 *   2. compact unpaid evidence lines,
 *   3. the callable tool names for this turn.
 */

import type { ProjectLifecycleStageV1 } from "./projectLifecycle";

export const STAGE_PROMPT_MAX_EVIDENCE_CHARS = 1_200;
export const STAGE_PROMPT_MAX_EVIDENCE_LINES = 8;
export const STAGE_PROMPT_MAX_TOTAL_CHARS = 2_400;

const BULKY_CARD_MARKERS = [
  "HOST ROUTING CARD",
  "VERIFIED GIT PATH",
  "CODE SPEC BINDING",
  "CODE SPEC",
  "ADAPTIVE RESEARCH CLOSURE",
  "AUTHORITATIVE MISSIONGRAPH TOOL FRONTIER",
  "SET-LOOSE ALLOWED TOOLS",
] as const;

const STAGE_OBJECTIVES: Readonly<Record<ProjectLifecycleStageV1, string>> = {
  accepted_research:
    "Package accepted research on the initiating note and complete the one Linear research publication.",
  linear_hierarchy:
    "Establish or verify the Linear hierarchy needed for unpaid delivery proof.",
  code_execution:
    "Advance unpaid code proof: sandbox ready → workspace edit → validate/repair → verified commit.",
  private_github_publication:
    "Publish the verified workspace to the exact private GitHub repository / draft PR.",
  reconciliation_cleanup:
    "Trash only exact disposable Linear/GitHub targets and prove provider absence.",
};

export type StagePromptProjectionV1 = {
  version: 1;
  stage: string | null;
  setLoose: boolean;
  objective: string;
  evidenceLines: readonly string[];
  callableTools: readonly string[];
  budgetLine: string | null;
};

export function objectiveForLifecycleStage(
  stage: string | null | undefined,
): string {
  const key = String(stage ?? "").trim() as ProjectLifecycleStageV1;
  if (key && key in STAGE_OBJECTIVES) {
    return STAGE_OBJECTIVES[key];
  }
  if (String(stage ?? "").trim()) {
    return `Advance unpaid proof for lifecycle stage ${String(stage).trim()}.`;
  }
  return "Advance unpaid proof with the callable tools for this turn.";
}

/**
 * Keep only short evidence-shaped lines from host-observed binding text.
 * Drops bulky routing/git/spec cards that AgentRunner may concatenate.
 */
export function extractCompactStageEvidence(
  observedBinding: string | null | undefined,
  options: {
    maxChars?: number;
    maxLines?: number;
  } = {},
): string[] {
  const raw = String(observedBinding ?? "").trim();
  if (!raw) return [];
  const maxChars = options.maxChars ?? STAGE_PROMPT_MAX_EVIDENCE_CHARS;
  const maxLines = options.maxLines ?? STAGE_PROMPT_MAX_EVIDENCE_LINES;
  const sections = raw
    .split(/\n{2,}/u)
    .map((section) => section.trim())
    .filter(Boolean)
    .filter(
      (section) =>
        !BULKY_CARD_MARKERS.some((marker) =>
          section.toUpperCase().includes(marker),
        ),
    );
  const lines: string[] = [];
  let used = 0;
  for (const section of sections) {
    for (const line of section.split(/\n/u)) {
      const trimmed = line.replace(/\s+/gu, " ").trim();
      if (!trimmed || trimmed.length > 280) continue;
      if (!looksLikeStageEvidenceLine(trimmed)) continue;
      if (used + trimmed.length > maxChars) return lines;
      lines.push(trimmed);
      used += trimmed.length;
      if (lines.length >= maxLines) return lines;
    }
  }
  return lines;
}

function looksLikeStageEvidenceLine(line: string): boolean {
  return (
    /(?:evidence|readback|receipt|proof|paid|unpaid|sha256|issueId|repository|workspace|commit|draft.?pr|url=|path=|marker=)/iu.test(
      line,
    ) || /^(?:[-*]\s+|path=|id=|status=)/u.test(line)
  );
}

export function projectStagePrompt(input: {
  stage?: string | null;
  setLoose?: boolean;
  callableTools: readonly string[];
  observedBinding?: string | null;
  evidenceLines?: readonly string[];
  budgetLine?: string | null;
  objective?: string | null;
}): StagePromptProjectionV1 {
  const stage = input.stage?.trim() || null;
  const callableTools = [
    ...new Set(
      input.callableTools.map((name) => name.trim()).filter(Boolean),
    ),
  ];
  const evidenceLines =
    input.evidenceLines && input.evidenceLines.length > 0
      ? [...input.evidenceLines].slice(0, STAGE_PROMPT_MAX_EVIDENCE_LINES)
      : extractCompactStageEvidence(input.observedBinding);
  return {
    version: 1,
    stage,
    setLoose: input.setLoose === true,
    objective:
      input.objective?.trim() || objectiveForLifecycleStage(stage),
    evidenceLines,
    callableTools,
    budgetLine: input.budgetLine?.trim() || null,
  };
}

export function formatStagePromptProjection(
  projection: StagePromptProjectionV1,
): string {
  const tools =
    projection.callableTools.length > 0
      ? projection.callableTools.join(", ")
      : "none";
  const evidence =
    projection.evidenceLines.length > 0
      ? projection.evidenceLines.map((line) => `- ${line}`).join("\n")
      : "- (none beyond prior tool results already in this turn)";
  const lines = [
    projection.setLoose
      ? "STAGE PROMPT (set-loose; objective + evidence + callable tools only):"
      : "STAGE PROMPT (exact frontier; objective + evidence + callable tools only):",
    `stage=${projection.stage ?? "none"}`,
    `objective=${projection.objective}`,
    projection.budgetLine ? `budget=${projection.budgetLine}` : "",
    "evidence:",
    evidence,
    "callableTools:",
    tools,
    projection.setLoose
      ? "Soft tools may batch. Call at most one Bound stage mutation per turn. Prefer unpaid proof."
      : "Call one of the callable tool names now. Do not invent off-frontier tools.",
    "Use the provided JSON schema exactly.",
  ].filter(Boolean);
  const text = lines.join("\n");
  if (text.length <= STAGE_PROMPT_MAX_TOTAL_CHARS) return text;
  return `${text.slice(0, STAGE_PROMPT_MAX_TOTAL_CHARS - 1).trimEnd()}…`;
}
