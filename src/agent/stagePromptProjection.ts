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
/**
 * Host-authoritative binding lines ("EXACT GRAPH-BOUND WORKSPACE READ: …")
 * are single joined lines around 600 chars. The 280-char evidence filter
 * silently deleted every one of them, so the model was told to call a
 * path-bound tool without ever being shown the path. They get their own cap.
 */
export const STAGE_PROMPT_MAX_EXACT_LINE_CHARS = 700;
const EXACT_HOST_BINDING_LINE = /^EXACT [A-Z][A-Z -]*:/u;
/** Single load-bearing lines worth salvaging from excluded bulky cards. */
const BULKY_CARD_SALVAGE_LINE = /^(?:preferredNext=|route=|currentStage=)/u;

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
    "Implement the accepted Linear work in the bound workspace and preserve exact changed-file receipts.",
  code_validation:
    "Run fast, targeted, and full validation; repair only from verified diagnostics, then create the verified commit.",
  private_github_publication:
    "Ask whether the exact GitHub repository is public or private, then publish the verified workspace as a draft PR.",
  reflection:
    "Write the host-grounded project Results report with phase outcomes, validation, commit/PR links, limitations, and verified code examples.",
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
  resolvedRepositoryVisibility: "public" | "private" | null = null,
): string {
  const key = String(stage ?? "").trim() as ProjectLifecycleStageV1;
  // The generic publication objective says "Ask whether public or private"
  // even when the mission prompt already made the choice; a model obeying it
  // went looking for an ask tool that was not callable instead of calling
  // github_create_repository. The visibility here is resolved by the same
  // resolveExplicitRepositoryVisibilityChoiceV1 the executor gate reads, so
  // the objective and the gate cannot disagree.
  if (
    key === "private_github_publication" &&
    resolvedRepositoryVisibility !== null
  ) {
    return `The user already chose a ${resolvedRepositoryVisibility} repository. Call github_create_repository with visibility="${resolvedRepositoryVisibility}" and the bound profileKey, then publish the verified workspace as a draft PR.`;
  }
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
  const allSections = raw
    .split(/\n{2,}/u)
    .map((section) => section.trim())
    .filter(Boolean);
  const isBulky = (section: string) =>
    BULKY_CARD_MARKERS.some((marker) =>
      section.toUpperCase().includes(marker),
    );
  const lines: string[] = [];
  let used = 0;
  const push = (trimmed: string): boolean => {
    if (used + trimmed.length > maxChars) return false;
    lines.push(trimmed);
    used += trimmed.length;
    return lines.length < maxLines;
  };
  // Host-authoritative EXACT bindings first: they carry the exact path, hash,
  // or id the frontier tool must be called with, and losing them to the
  // generic 280-char filter left the model guessing values the host knew.
  for (const section of allSections) {
    if (isBulky(section)) continue;
    for (const line of section.split(/\n/u)) {
      const trimmed = line.replace(/\s+/gu, " ").trim();
      if (!trimmed || !EXACT_HOST_BINDING_LINE.test(trimmed)) continue;
      if (trimmed.length > STAGE_PROMPT_MAX_EXACT_LINE_CHARS) continue;
      if (!push(trimmed)) return lines;
    }
  }
  // Excluded bulky cards may still hold one load-bearing routing line.
  for (const section of allSections) {
    if (!isBulky(section)) continue;
    for (const line of section.split(/\n/u)) {
      const trimmed = line.replace(/\s+/gu, " ").trim();
      if (!trimmed || trimmed.length > 280) continue;
      if (!BULKY_CARD_SALVAGE_LINE.test(trimmed)) continue;
      if (!push(trimmed)) return lines;
    }
  }
  for (const section of allSections) {
    if (isBulky(section)) continue;
    for (const line of section.split(/\n/u)) {
      const trimmed = line.replace(/\s+/gu, " ").trim();
      if (!trimmed || trimmed.length > 280) continue;
      if (EXACT_HOST_BINDING_LINE.test(trimmed)) continue;
      if (!looksLikeStageEvidenceLine(trimmed)) continue;
      if (!push(trimmed)) return lines;
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
  resolvedRepositoryVisibility?: "public" | "private" | null;
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
      input.objective?.trim() ||
      objectiveForLifecycleStage(
        stage,
        input.resolvedRepositoryVisibility ?? null,
      ),
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
  // The tool list is the one part of this prompt the model cannot recover
  // from anywhere else, and it is consumed name-by-name. The old formatter
  // rendered it near the end and then blind-sliced the whole block at the
  // total cap, so a long objective plus full evidence chopped the list
  // mid-name — observed as "callableTools: code_sandbox_status" while eight
  // schemas were live. Build the skeleton first; evidence gets only the
  // remaining budget and is dropped whole-line, never mid-line.
  const buildSkeleton = (objective: string): string[] =>
    [
      projection.setLoose
        ? "STAGE PROMPT (set-loose; objective + evidence + callable tools only):"
        : "STAGE PROMPT (exact frontier; objective + evidence + callable tools only):",
      `stage=${projection.stage ?? "none"}`,
      `objective=${objective}`,
      projection.budgetLine ? `budget=${projection.budgetLine}` : "",
      "callableTools:",
      tools,
      projection.setLoose
        ? "Soft tools may batch. Call at most one Bound stage mutation per turn. Prefer unpaid proof."
        : "Call one of the callable tool names now. Do not invent off-frontier tools.",
      "Use the provided JSON schema exactly.",
    ].filter(Boolean);
  let objective = projection.objective;
  let skeleton = buildSkeleton(objective);
  let skeletonLength = skeleton.join("\n").length;
  const overflow = skeletonLength - STAGE_PROMPT_MAX_TOTAL_CHARS;
  if (overflow > 0 && objective.length > 24) {
    objective = `${objective
      .slice(0, Math.max(24, objective.length - overflow - 1))
      .trimEnd()}…`;
    skeleton = buildSkeleton(objective);
    skeletonLength = skeleton.join("\n").length;
  }
  const evidenceHeaderCost = "\nevidence:".length;
  const evidenceLines: string[] = [];
  let evidenceUsed = 0;
  for (const line of projection.evidenceLines) {
    const rendered = `- ${line}`;
    const cost = rendered.length + 1;
    if (
      skeletonLength + evidenceHeaderCost + evidenceUsed + cost >
      STAGE_PROMPT_MAX_TOTAL_CHARS
    ) {
      break;
    }
    evidenceLines.push(rendered);
    evidenceUsed += cost;
  }
  const evidence =
    evidenceLines.length > 0
      ? evidenceLines
      : ["- (none beyond prior tool results already in this turn)"];
  // Evidence renders between the budget line and the tool list so the
  // closing instructions still directly precede the model's tool choice.
  const toolsIndex = skeleton.indexOf("callableTools:");
  const lines = [
    ...skeleton.slice(0, toolsIndex),
    "evidence:",
    ...evidence,
    ...skeleton.slice(toolsIndex),
  ];
  return lines.join("\n");
}
