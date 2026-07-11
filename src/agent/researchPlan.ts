import type { MissionEvidence, MissionTaskStatus } from "./missionLedger";
import type { RunPlan } from "./runPlan";
import type { MissionIntent } from "../tools/types";
import {
  evaluateEvidenceConflictAcceptance,
  type EvidenceConflict,
} from "./evidenceConflicts";
import {
  getEvidenceCitationIdentifiers,
  isFetchedWebEvidence,
  isVaultReadEvidence,
} from "./missionPlan";

export type ResearchMode = "none" | "deep_web" | "deep_vault" | "deep_hybrid";
export type ResearchEvidenceType = "web_source" | "vault_note" | "either";

export interface ResearchSourceRequirements {
  minFetchedSources: number;
  minDistinctDomains: number;
}

export interface ResearchCoverageRequirements {
  minVaultCoverageConfidence: "medium" | "high";
  expandWhenSampledOrTruncated: boolean;
}

export interface ResearchSubquestion {
  id: string;
  question: string;
  requiredEvidenceType: ResearchEvidenceType;
  minEvidence: number;
  status: "pending" | "in_progress" | "complete" | "blocked";
  evidenceIds: string[];
  unansweredReason?: string;
}

export interface ResearchNextAction {
  toolName:
    | "web_search"
    | "web_fetch"
    | "inspect_semantic_index"
    | "semantic_search_notes"
    | "read_markdown_files"
    | "read_file"
    | "synthesize";
  reason: string;
  subquestionId?: string;
  query?: string;
}

export interface ResearchPlan {
  version: 1;
  mode: ResearchMode;
  sourceRequirements: ResearchSourceRequirements;
  coverageRequirements: ResearchCoverageRequirements;
  subquestions: ResearchSubquestion[];
  evidenceIds: string[];
  status: "pending" | "in_progress" | "complete" | "blocked";
  nextAction?: ResearchNextAction;
}

export interface CreateResearchPlanInput {
  prompt: string;
  missionIntent: MissionIntent;
  runPlan: Pick<RunPlan, "route" | "slowPathReason">;
}

export interface ResearchAcceptanceFinding {
  missing: string[];
  reasons: string[];
  nextAction?: string;
}

export type ResearchEvidence = MissionEvidence & {
  subquestionId?: string;
  subquestionIds?: string[];
  sourceId?: string;
  passageId?: string;
  passageIds?: string[];
};

export function createResearchPlan({
  prompt,
  missionIntent,
  runPlan,
}: CreateResearchPlanInput): ResearchPlan | null {
  const mode = classifyResearchMode(prompt, missionIntent, runPlan);
  if (mode === "none") {
    return null;
  }

  const sourceRequirements: ResearchSourceRequirements = {
    minFetchedSources: mode === "deep_vault" ? 0 : 3,
    minDistinctDomains: mode === "deep_vault" ? 0 : 2,
  };
  const coverageRequirements: ResearchCoverageRequirements = {
    minVaultCoverageConfidence: mode === "deep_web" ? "medium" : "medium",
    expandWhenSampledOrTruncated: true,
  };
  const subquestions = createSubquestions(prompt, mode, sourceRequirements);
  if (subquestions[0]) {
    subquestions[0] = { ...subquestions[0], status: "in_progress" };
  }
  const plan: ResearchPlan = {
    version: 1,
    mode,
    sourceRequirements,
    coverageRequirements,
    subquestions,
    evidenceIds: [],
    status: "in_progress",
  };
  plan.nextAction = getNextResearchAction(plan);
  return plan;
}

export function getNextResearchAction(
  plan: ResearchPlan,
): ResearchNextAction | undefined {
  if (plan.mode === "none" || plan.status === "complete") {
    return undefined;
  }

  const next = plan.subquestions.find(
    (item) => item.status === "pending" || item.status === "in_progress",
  );
  if (!next) {
    return {
      toolName: "synthesize",
      reason: "All research plan items have evidence; synthesize with citations, limitations, and confidence.",
    };
  }

  if (next.requiredEvidenceType === "web_source") {
    return {
      toolName: plan.evidenceIds.some((id) => id.startsWith("web_search:"))
        ? "web_fetch"
        : "web_search",
      subquestionId: next.id,
      reason: `Gather fetched web evidence for: ${next.question}`,
      query: next.question,
    };
  }

  if (next.requiredEvidenceType === "vault_note") {
    return {
      toolName: plan.evidenceIds.some(
        (id) => id.startsWith("vault_search:") || id.startsWith("graph:"),
      )
        ? "read_file"
        : "semantic_search_notes",
      subquestionId: next.id,
      reason: `Retrieve local vault evidence for: ${next.question}`,
      query: next.question,
    };
  }

  return {
    toolName: plan.mode === "deep_vault" ? "semantic_search_notes" : "web_search",
    subquestionId: next.id,
    reason: `Gather evidence for: ${next.question}`,
    query: next.question,
  };
}

export function applyResearchEvidence(
  plan: ResearchPlan,
  evidence: ResearchEvidence[],
): ResearchPlan {
  if (plan.mode === "none") {
    return plan;
  }

  const evidenceIds = dedupe([
    ...plan.evidenceIds,
    ...evidence.map((item) => item.id),
  ]);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const nextSubquestions = plan.subquestions.map((item) => ({
    ...item,
    evidenceIds: dedupe(item.evidenceIds).filter((id) => {
      const candidate = evidenceById.get(id);
      return candidate && evidenceMatchesType(candidate, item.requiredEvidenceType);
    }),
  }));
  const assigned = new Map<string, Set<string>>();
  for (const item of nextSubquestions) {
    for (const evidenceId of item.evidenceIds) {
      const bindings = assigned.get(evidenceId) ?? new Set<string>();
      bindings.add(item.id);
      assigned.set(evidenceId, bindings);
    }
  }

  for (const candidate of evidence) {
    const explicitBindings = getExplicitSubquestionIds(candidate).filter((id) =>
      nextSubquestions.some((item) => item.id === id),
    );
    if (explicitBindings.length > 0) {
      for (const subquestionId of explicitBindings) {
        const item = nextSubquestions.find((entry) => entry.id === subquestionId);
        if (item && evidenceMatchesType(candidate, item.requiredEvidenceType)) {
          item.evidenceIds = dedupe([...item.evidenceIds, candidate.id]);
        }
      }
      continue;
    }
    if (assigned.has(candidate.id)) {
      continue;
    }
    const candidates = nextSubquestions
      .filter((item) => evidenceMatchesType(candidate, item.requiredEvidenceType))
      // minEvidence 0 (limitations/confidence coaching) must not absorb leftover
      // vault hits — that would force citation coverage on a section verified
      // from final-output language alone.
      .filter((item) => {
        const required = Math.max(0, item.minEvidence);
        return required > 0 && item.evidenceIds.length < required;
      })
      .map((item, index) => ({
        item,
        index,
        score: evidenceRelevanceScore(candidate, item),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const target = candidates[0]?.item;
    if (target) {
      target.evidenceIds = dedupe([...target.evidenceIds, candidate.id]);
      assigned.set(candidate.id, new Set([target.id]));
    }
  }

  const resolvedSubquestions = nextSubquestions.map((item) => {
    const itemEvidenceIds = item.evidenceIds;
    const required = Math.max(0, item.minEvidence);
    const hasEnough =
      required === 0 || itemEvidenceIds.length >= required;
    return {
      ...item,
      evidenceIds: itemEvidenceIds,
      status: hasEnough
        ? ("complete" as const)
        : itemEvidenceIds.length > 0
          ? ("in_progress" as const)
          : item.status === "blocked"
            ? ("blocked" as const)
            : item.status === "complete"
              ? ("complete" as const)
              : ("pending" as const),
    };
  });
  const complete = resolvedSubquestions.every(
    (item) => item.status === "complete" || item.status === "blocked",
  );
  const nextPlan: ResearchPlan = {
    ...plan,
    evidenceIds,
    subquestions: resolvedSubquestions,
    status: complete ? "complete" : "in_progress",
  };
  nextPlan.nextAction = getNextResearchAction(nextPlan);
  return nextPlan;
}

export function evaluateResearchAcceptance({
  plan,
  evidence,
  finalOutput,
  conflicts,
}: {
  plan: ResearchPlan | null | undefined;
  evidence: ResearchEvidence[];
  finalOutput?: string;
  /** Optional passage/claim conflicts; open conflicts block hybrid/deep acceptance. */
  conflicts?: EvidenceConflict[] | null;
}): ResearchAcceptanceFinding {
  if (!plan || plan.mode === "none") {
    return { missing: [], reasons: [] };
  }

  const missing = new Set<string>();
  const reasons: string[] = [];
  const evaluatedPlan = applyResearchEvidence(plan, evidence);
  const stats = getResearchEvidenceStats(evidence);

  if (stats.fetchedSourceCount < plan.sourceRequirements.minFetchedSources) {
    missing.add(
      `fetched_sources:${stats.fetchedSourceCount}/${plan.sourceRequirements.minFetchedSources}`,
    );
  }

  if (
    plan.sourceRequirements.minDistinctDomains > 0 &&
    stats.fetchedSourceCount >= plan.sourceRequirements.minFetchedSources &&
    stats.distinctDomainCount < plan.sourceRequirements.minDistinctDomains
  ) {
    missing.add(
      `distinct_domains:${stats.distinctDomainCount}/${plan.sourceRequirements.minDistinctDomains}`,
    );
  }

  const incomplete = evaluatedPlan.subquestions.filter(
    (item) => item.status !== "complete" && item.status !== "blocked",
  );
  if (incomplete.length > 0) {
    missing.add("research_plan_items");
    reasons.push(`incomplete_research_items=${incomplete.map((item) => item.id).join(",")}`);
  }

  for (const item of evaluatedPlan.subquestions.filter(
    (subquestion) => subquestion.status !== "blocked",
  )) {
    const actualEvidenceCount = item.evidenceIds
      .map((id) => evidence.find((candidate) => candidate.id === id))
      .filter(
        (candidate): candidate is ResearchEvidence =>
          Boolean(candidate) &&
          evidenceMatchesType(candidate as ResearchEvidence, item.requiredEvidenceType),
      ).length;
    if (actualEvidenceCount < Math.max(0, item.minEvidence)) {
      missing.add(
        `subquestion_evidence:${item.id}:${actualEvidenceCount}/${Math.max(0, item.minEvidence)}`,
      );
    }
  }

  if (finalOutput !== undefined) {
    const output = finalOutput.trim();
    if (plan.sourceRequirements.minFetchedSources > 0) {
      const citedFetchedUrls = stats.fetchedUrls.filter((url) => output.includes(url));
      if (
        citedFetchedUrls.length <
        Math.min(stats.fetchedUrls.length, plan.sourceRequirements.minFetchedSources)
      ) {
        missing.add("citation_url_coverage");
      }
    }

    if (!/\blimitations?\b|\bopen questions?\b|\bunanswered\b/i.test(output)) {
      missing.add("limitations_section");
    }

    if (!/\bconfidence\b/i.test(output)) {
      missing.add("confidence_section");
    }

    const uncitedSubquestions = evaluatedPlan.subquestions
      .filter((item) => item.status === "complete")
      .filter((item) => Math.max(0, item.minEvidence) > 0)
      .filter((item) => {
        const identifiers = item.evidenceIds.flatMap((id) => {
          const itemEvidence = evidence.find((candidate) => candidate.id === id);
          return itemEvidence ? getEvidenceCitationIdentifiers(itemEvidence) : [];
        });
        return identifiers.length > 0 && !identifiers.some((identifier) => output.includes(identifier));
      });
    if (uncitedSubquestions.length > 0) {
      missing.add(
        `subquestion_citation_coverage:${uncitedSubquestions.map((item) => item.id).join(",")}`,
      );
    }

    const blocked = evaluatedPlan.subquestions.filter((item) => item.status === "blocked");
    if (blocked.length > 0 && !/\bunanswered\b|\bopen questions?\b/i.test(output)) {
      missing.add("unanswered_questions");
    }
  }

  const conflictAcceptance = evaluateEvidenceConflictAcceptance({
    conflicts,
    finalOutput,
  });
  for (const item of conflictAcceptance.missing) {
    missing.add(item);
  }
  reasons.push(...conflictAcceptance.reasons);

  return {
    missing: [...missing],
    reasons: reasons.length > 0 ? reasons : missing.size > 0 ? ["research_acceptance_incomplete"] : [],
    nextAction: getResearchAcceptanceNextAction([...missing]),
  };
}

export function formatResearchPlanForPrompt(plan: ResearchPlan | null): string {
  if (!plan || plan.mode === "none") {
    return "";
  }

  return [
    "Deep Research v1 plan is active. Treat this as runner-owned required work.",
    `Mode: ${plan.mode}`,
    `Fetched web source requirement: ${plan.sourceRequirements.minFetchedSources}`,
    `Distinct domain requirement: ${plan.sourceRequirements.minDistinctDomains}`,
    `Vault coverage requirement: confidence ${plan.coverageRequirements.minVaultCoverageConfidence}; expand sampled/truncated retrieval: ${plan.coverageRequirements.expandWhenSampledOrTruncated}`,
    "Subquestions:",
    ...plan.subquestions.map(
      (item) =>
        `- ${item.id} [${item.status}] ${item.question} (needs ${item.minEvidence} ${item.requiredEvidenceType})`,
    ),
    plan.nextAction
      ? `Next action: ${plan.nextAction.toolName} - ${plan.nextAction.reason}`
      : "Next action: synthesize.",
    "Before final answer, include fetched URLs, limitations, and confidence.",
  ].join("\n");
}

export function normalizeResearchPlan(value: unknown): ResearchPlan | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }

  const mode = getResearchMode(value.mode);
  const status = getPlanStatus(value.status);
  if (!mode || !status) {
    return undefined;
  }

  const source = isRecord(value.sourceRequirements)
    ? value.sourceRequirements
    : {};
  const coverage = isRecord(value.coverageRequirements)
    ? value.coverageRequirements
    : {};
  const subquestions = Array.isArray(value.subquestions)
    ? value.subquestions.map(normalizeSubquestion).filter(isSubquestion)
    : [];
  const plan: ResearchPlan = {
    version: 1,
    mode,
    sourceRequirements: {
      minFetchedSources: getNumber(source.minFetchedSources) ?? 0,
      minDistinctDomains: getNumber(source.minDistinctDomains) ?? 0,
    },
    coverageRequirements: {
      minVaultCoverageConfidence:
        coverage.minVaultCoverageConfidence === "high" ? "high" : "medium",
      expandWhenSampledOrTruncated:
        typeof coverage.expandWhenSampledOrTruncated === "boolean"
          ? coverage.expandWhenSampledOrTruncated
          : true,
    },
    subquestions,
    evidenceIds: getStringArray(value.evidenceIds),
    status,
  };
  const nextAction = normalizeNextAction(value.nextAction);
  if (nextAction) {
    plan.nextAction = nextAction;
  }
  return plan;
}

export function researchPlanToTaskStatus(
  status: ResearchSubquestion["status"],
): MissionTaskStatus {
  if (status === "complete" || status === "blocked") {
    return status;
  }
  return status === "in_progress" ? "in_progress" : "pending";
}

function classifyResearchMode(
  prompt: string,
  missionIntent: MissionIntent,
  runPlan: Pick<RunPlan, "route" | "slowPathReason">,
): ResearchMode {
  if (missionIntent.explicitDelete || isSimpleWriteOnlyPrompt(prompt)) {
    return "none";
  }

  const web = hasDeepWebResearchIntent(prompt);
  const vault = hasDeepVaultResearchIntent(prompt);
  const deep = hasDeepResearchIntent(prompt) || hasInvestigativeIntent(prompt);

  if ((web || (deep && hasExplicitWebSignal(prompt))) && vault) {
    return "deep_hybrid";
  }
  if (vault && (deep || hasBroadVaultSynthesisIntent(prompt))) {
    return "deep_vault";
  }
  if (web || (deep && runPlan.slowPathReason === "needs_web_sources")) {
    return "deep_web";
  }
  return "none";
}

/**
 * Mission-specific research decomposition (S9 / A3).
 * Deterministic-only for v1: numbered lists, ? sentences, compare X vs Y,
 * pros/cons, risks, and explicit research-question sections.
 * TODO(utility-model): optional structured JSON assist when utilityModel is
 * configured and deterministic confidence is low — do not call the main chat
 * model solely to plan when deterministic parse succeeds.
 */
function createSubquestions(
  prompt: string,
  mode: ResearchMode,
  _sourceRequirements: ResearchSourceRequirements,
): ResearchSubquestion[] {
  const decomposed = decomposePromptIntoResearchQuestions(prompt);
  const questions =
    decomposed.length > 0
      ? decomposed
      : defaultResearchQuestions(prompt, mode);
  const withLimitations = ensureLimitationsConfidenceQuestion(questions, mode);
  const capped = capAndMergeSubquestionTexts(withLimitations, 2, 8);
  return capped.map((question, index) =>
    makeSubquestion(
      `rq-${index + 1}`,
      question,
      evidenceTypeForSubquestion(mode, index, capped.length),
      minEvidenceForSubquestion(mode, index, capped.length),
    ),
  );
}

/** Exported for unit tests and future utility-model assist fallback. */
export function decomposePromptIntoResearchQuestions(prompt: string): string[] {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return [];
  }

  const collected: string[] = [];
  collected.push(...extractNumberedOrBulletedItems(prompt));
  collected.push(...extractExplicitResearchQuestions(prompt));
  collected.push(...extractCompareItems(prompt));
  collected.push(...extractProsConsItems(prompt));
  collected.push(...extractRiskItems(prompt));
  collected.push(...extractQuestionSentences(prompt));

  return capAndMergeSubquestionTexts(
    collected.map(normalizeQuestionText).filter((item) => item.length >= 8),
    0,
    8,
  );
}

function defaultResearchQuestions(prompt: string, mode: ResearchMode): string[] {
  const topic = summarizePromptTopic(prompt);
  if (mode === "deep_vault") {
    return [
      `Map the relevant vault scope for: ${topic}`,
      `Retrieve the strongest matching local notes about ${topic}.`,
    ];
  }
  if (mode === "deep_hybrid") {
    return [
      `Gather external source evidence for: ${topic}`,
      `Retrieve relevant local vault context about ${topic} and compare it to external evidence.`,
    ];
  }
  return [
    `Find fetched source evidence for: ${topic}`,
    `Compare evidence across distinct sources and domains on ${topic}.`,
  ];
}

function ensureLimitationsConfidenceQuestion(
  questions: string[],
  mode: ResearchMode,
): string[] {
  const hasLimitations = questions.some((item) =>
    /\blimitations?\b|\bconfidence\b|\bcontradict|\bopen questions?\b/i.test(item),
  );
  if (hasLimitations) {
    return questions;
  }
  if (mode === "deep_hybrid") {
    return [
      ...questions,
      "Resolve contradictions between sources and state limitations and confidence.",
    ];
  }
  if (mode === "deep_vault") {
    return [
      ...questions,
      "Identify limitations, sampled areas, and confidence from local evidence.",
    ];
  }
  return [
    ...questions,
    "Synthesize findings with limitations and confidence.",
  ];
}

function evidenceTypeForSubquestion(
  mode: ResearchMode,
  index: number,
  total: number,
): ResearchEvidenceType {
  if (mode === "deep_vault") {
    return "vault_note";
  }
  if (mode === "deep_hybrid") {
    if (index === total - 1) {
      return "either";
    }
    return index % 2 === 0 ? "web_source" : "vault_note";
  }
  return "web_source";
}

function minEvidenceForSubquestion(
  mode: ResearchMode,
  index: number,
  total: number,
): number {
  void mode;
  void index;
  void total;
  // Keep deep_vault subquestion minima at 1 so a typical expand+read path
  // (two semantic searches + one content read) can complete gather including
  // the limitations/confidence subquestion.
  return 1;
}

function extractNumberedOrBulletedItems(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const items: string[] = [];
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:\(?\d+[.)]|\d+\s*[-:)]|[-*•])\s+(.+?)\s*$/,
    );
    if (match?.[1]) {
      items.push(match[1]);
    }
  }
  // Also catch inline "1) ... 2) ..." sequences on one line.
  const inline = [
    ...prompt.matchAll(
      /(?:^|[;\s])(?:\(?\d+[.)]|\d+\s*[-:)])\s*([^;?\n]{8,}?(?:\?|(?=[\s;]*(?:\(?\d+[.)]|\d+\s*[-:)]))|$))/g,
    ),
  ]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  return [...items, ...inline];
}

function extractExplicitResearchQuestions(prompt: string): string[] {
  const section = prompt.match(
    /(?:research\s+questions?|questions?\s+to\s+(?:answer|investigate)|investigate(?:\s+the\s+following)?)\s*[:\-]\s*([\s\S]+)/i,
  );
  if (!section?.[1]) {
    return [];
  }
  return section[1]
    .split(/(?:\r?\n|;|\|(?=\s)|(?<=\?)\s+)/)
    .map((item) => item.replace(/^\s*(?:\(?\d+[.)]|\d+\s*[-:)]|[-*•])\s*/, "").trim())
    .filter((item) => item.length >= 8);
}

function extractQuestionSentences(prompt: string): string[] {
  return [...prompt.matchAll(/([^.!?\n]{8,}?\?)/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function extractCompareItems(prompt: string): string[] {
  const items: string[] = [];
  const compareVs = [
    ...prompt.matchAll(
      /\bcompare\s+([^?.\n,]{2,80}?)\s+(?:vs\.?|versus|against|with|and)\s+([^?.\n,]{2,80})/gi,
    ),
  ];
  for (const match of compareVs) {
    const left = match[1]?.trim();
    const right = match[2]?.trim().replace(/\s+and\s+list\b.*$/i, "").trim();
    if (left && right) {
      items.push(`Compare ${left} vs ${right}`);
    }
  }
  const versus = [
    ...prompt.matchAll(
      /\b([A-Za-z][\w\s/-]{1,40}?)\s+(?:vs\.?|versus)\s+([A-Za-z][\w\s/-]{1,40})/g,
    ),
  ];
  for (const match of versus) {
    const left = match[1]?.trim();
    const right = match[2]?.trim();
    if (
      left &&
      right &&
      !/^(compare|and|the|list|with)$/i.test(left) &&
      !items.some((item) => item.toLowerCase().includes(left.toLowerCase()))
    ) {
      items.push(`Compare ${left} vs ${right}`);
    }
  }
  return items;
}

function extractProsConsItems(prompt: string): string[] {
  if (!/\bpros?\s*(?:\/|&|and)?\s*cons?\b|\badvantages?\s+and\s+disadvantages?\b/i.test(prompt)) {
    return [];
  }
  const topic = summarizePromptTopic(
    prompt
      .replace(/\bpros?\s*(?:\/|&|and)?\s*cons?\b/gi, " ")
      .replace(/\badvantages?\s+and\s+disadvantages?\b/gi, " "),
  );
  return [
    `What are the pros of ${topic}?`,
    `What are the cons of ${topic}?`,
  ];
}

function extractRiskItems(prompt: string): string[] {
  if (!/\b(risks?|downsides?|hazards?|failure\s+modes?)\b/i.test(prompt)) {
    return [];
  }
  if (/\blist\s+(?:the\s+)?risks?\b|\band\s+(?:list\s+)?risks?\b|\brisks?\s*\?/i.test(prompt)) {
    return ["What are the key risks?"];
  }
  return ["Identify key risks and downsides."];
}

function normalizeQuestionText(value: string): string {
  return value
    .replace(/^[\s"'([{]+/, "")
    .replace(/[\s"'}\])]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capAndMergeSubquestionTexts(
  questions: string[],
  minCount: number,
  maxCount: number,
): string[] {
  const merged: string[] = [];
  for (const raw of questions) {
    const question = normalizeQuestionText(raw);
    if (!question) {
      continue;
    }
    const lower = question.toLowerCase();
    const duplicateIndex = merged.findIndex((existing) => {
      const existingLower = existing.toLowerCase();
      return (
        existingLower === lower ||
        existingLower.includes(lower) ||
        lower.includes(existingLower)
      );
    });
    if (duplicateIndex >= 0) {
      const existing = merged[duplicateIndex];
      // Prefer a focused compare/risk atom over a longer combined sentence.
      if (
        question.length > existing.length &&
        !(/\band\b/i.test(question) && !/\band\b/i.test(existing))
      ) {
        merged[duplicateIndex] = question;
      }
      continue;
    }
    const wordCount = question.split(/\s+/).length;
    if (wordCount <= 3 || question.length < 12) {
      if (merged.length === 0) {
        merged.push(question);
      } else {
        const last = merged[merged.length - 1];
        if (!last.toLowerCase().includes(lower)) {
          merged[merged.length - 1] = `${last.replace(/\?$/, "")}; ${question}`;
        }
      }
      continue;
    }
    merged.push(question);
  }

  while (merged.length > maxCount) {
    const last = merged.pop();
    if (!last) {
      break;
    }
    const prior = merged[merged.length - 1];
    merged[merged.length - 1] = `${prior.replace(/\?$/, "")}; ${last}`;
  }

  if (minCount > 0 && merged.length > 0 && merged.length < minCount) {
    // Caller supplies defaults when empty; here only pad when partially filled.
    return merged;
  }
  return merged.slice(0, maxCount);
}

function summarizePromptTopic(prompt: string): string {
  const cleaned = prompt
    .replace(/\b(deep\s+research|long\s+research|in[-\s]?depth|deep\s+dive|thorough|comprehensive|multi[-\s]?source)\b/gi, " ")
    .replace(/\b(please|research|investigate|analyze|analyse|write|draft|summarize|summarise)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || prompt).slice(0, 160);
}

function makeSubquestion(
  id: string,
  question: string,
  requiredEvidenceType: ResearchEvidenceType,
  minEvidence: number,
): ResearchSubquestion {
  // Limitations/confidence coaching is verified from final-output sections, not
  // from an extra vault/web evidence item.
  const limitationsOnly =
    /\blimitations?\b|\bconfidence\b/i.test(question) &&
    !/\b(find|retrieve|gather|map|compare|fetch|search)\b/i.test(question);
  return {
    id,
    question,
    requiredEvidenceType,
    minEvidence: limitationsOnly ? 0 : minEvidence,
    status: limitationsOnly ? "complete" : "pending",
    evidenceIds: [],
  };
}

function evidenceMatchesType(
  evidence: MissionEvidence,
  type: ResearchEvidenceType,
): boolean {
  if (type === "either") {
    return isFetchedWebEvidence(evidence) || isVaultResearchEvidence(evidence);
  }
  if (type === "web_source") {
    return isFetchedWebEvidence(evidence);
  }
  return isVaultResearchEvidence(evidence);
}

/**
 * Deep-vault gather accepts semantic/search hits as well as content reads.
 * Mission-plan vault_evidence proof still requires isVaultReadEvidence
 * (vault:/vault_batch: only) so search alone cannot skip a content read.
 */
function isVaultResearchEvidence(evidence: MissionEvidence): boolean {
  if (isVaultReadEvidence(evidence)) {
    return true;
  }
  return (
    evidence.kind === "vault_note" && evidence.id.startsWith("vault_search:")
  );
}

function getExplicitSubquestionIds(evidence: ResearchEvidence): string[] {
  const record = evidence as ResearchEvidence & Record<string, unknown>;
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const idMatches = [
    ...evidence.id.matchAll(/(?:subquestion:|\[)(rq-[a-z0-9-]+)\]?/gi),
  ].map((match) => match[1]);
  return dedupe([
    evidence.subquestionId ?? "",
    ...getStringArray(evidence.subquestionIds),
    getString(metadata.subquestionId) ?? "",
    ...getStringArray(metadata.subquestionIds),
    ...idMatches,
  ]).filter(Boolean);
}

function evidenceRelevanceScore(
  evidence: ResearchEvidence,
  subquestion: ResearchSubquestion,
): number {
  const questionTerms = getRelevanceTerms(subquestion.question);
  if (questionTerms.length === 0) {
    return 0;
  }
  const evidenceText = [
    evidence.title,
    evidence.summary,
    evidence.path,
    evidence.url,
  ].filter(Boolean).join(" ").toLowerCase();
  return questionTerms.filter((term) => evidenceText.includes(term)).length;
}

function getRelevanceTerms(value: string): string[] {
  const stopWords = new Set([
    "across",
    "compare",
    "confidence",
    "domains",
    "evidence",
    "external",
    "findings",
    "gather",
    "limitations",
    "local",
    "notes",
    "research",
    "resolve",
    "source",
    "sources",
    "synthesize",
    "vault",
  ]);
  return dedupe(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])
    .filter((term) => !stopWords.has(term))
    .slice(0, 12);
}

function getResearchEvidenceStats(evidence: ResearchEvidence[]) {
  const fetchedUrls = dedupe(
    evidence
      .filter(isFetchedWebEvidence)
      .map((item) => item.url)
      .filter((url): url is string => Boolean(url)),
  );
  const domains = dedupe(
    fetchedUrls
      .map(getUrlDomain)
      .filter((domain): domain is string => Boolean(domain)),
  );
  return {
    fetchedUrls,
    fetchedSourceCount: fetchedUrls.length,
    distinctDomainCount: domains.length,
  };
}

function getResearchAcceptanceNextAction(missing: string[]): string | undefined {
  if (missing.some((item) => item.startsWith("fetched_sources"))) {
    return "Fetch additional web sources before synthesizing.";
  }
  if (missing.some((item) => item.startsWith("distinct_domains"))) {
    return "Fetch sources from additional distinct domains.";
  }
  if (missing.some((item) => item.startsWith("open_evidence_conflicts"))) {
    return "Resolve or acknowledge open evidence conflicts with an explicit limitation note.";
  }
  if (missing.some((item) => item.startsWith("conflict_limitation"))) {
    return "State acknowledged evidence conflicts as limitations in the final answer.";
  }
  if (missing.includes("research_plan_items")) {
    return "Complete the next incomplete research plan item.";
  }
  if (
    missing.some(
      (item) =>
        item.startsWith("subquestion_evidence") ||
        item.startsWith("subquestion_citation_coverage"),
    )
  ) {
    return "Gather and cite evidence bound to each incomplete research subquestion.";
  }
  if (missing.includes("citation_url_coverage")) {
    return "Revise the answer to include fetched source URLs.";
  }
  if (missing.includes("limitations_section") || missing.includes("confidence_section")) {
    return "Revise the answer with limitations and confidence.";
  }
  return undefined;
}

function hasDeepResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|long\s+research|in[-\s]?depth|deep\s+dive|thorough|comprehensive|multi[-\s]?source|compare\s+sources?|evidence\s+ledger|long[-\s]?running)\b/i.test(prompt);
}

function hasInvestigativeIntent(prompt: string): boolean {
  return /\b(investigate|verify|fact[-\s]?check|strategy|strategic|compare|tradeoffs?|current\s+(?:state|status|research|information|events?|news)|latest|recent)\b/i.test(prompt);
}

function hasDeepWebResearchIntent(prompt: string): boolean {
  return (
    hasDeepResearchIntent(prompt) ||
    /\b(multi[-\s]?source|compare\s+sources?|investigate|verify|fact[-\s]?check|strategy|strategic)\b/i.test(prompt) ||
    /\b(latest|recent|current|up[-\s]?to[-\s]?date)\b[\s\S]{0,80}\b(events?|news|information|data|research|reports?|studies?|sources?|facts?|market|law|policy|version|status)\b/i.test(prompt)
  ) && !hasDeepVaultResearchIntent(prompt);
}

function hasExplicitWebSignal(prompt: string): boolean {
  return /\b(web|online|internet|sources?|citations?|cited|cite|reference\s+list|bibliography|latest|recent|current|news|up[-\s]?to[-\s]?date|verify|fact[-\s]?check)\b/i.test(prompt);
}

function hasDeepVaultResearchIntent(prompt: string): boolean {
  return /\b(vault|my\s+notes?|across\s+notes?|other\s+folders?|semantic\s+search|local\s+notes?|all\s+notes?|large\s+vault)\b/i.test(prompt);
}

function hasBroadVaultSynthesisIntent(prompt: string): boolean {
  return hasDeepVaultResearchIntent(prompt) &&
    /\b(all\s+(?:of\s+)?(?:my\s+)?notes?|entire\s+vault|large\s+vault|across\s+(?:my\s+)?notes?|broad\s+vault|vault-wide|100|1000|10,?000|many\s+notes?)\b/i.test(prompt) &&
    /\b(synthesi[sz]e|summari[sz]e|themes?|patterns?|retrieve|search|find|surface|compare|coverage)\b/i.test(prompt);
}

function isSimpleWriteOnlyPrompt(prompt: string): boolean {
  return /\b(write|draft|compose|generate)\b[\s\S]{0,120}\b\d{1,5}\s+words?\b/i.test(prompt) &&
    !/\b(sources?|citations?|web|latest|current|vault|my\s+notes?|verify|fact[-\s]?check)\b/i.test(prompt);
}

function normalizeSubquestion(value: unknown): ResearchSubquestion | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const question = getString(value.question);
  const requiredEvidenceType = getEvidenceType(value.requiredEvidenceType);
  const status = getSubquestionStatus(value.status);
  if (!id || !question || !requiredEvidenceType || !status) {
    return null;
  }
  return {
    id,
    question,
    requiredEvidenceType,
    minEvidence: getNumber(value.minEvidence) ?? 1,
    status,
    evidenceIds: getStringArray(value.evidenceIds),
    unansweredReason: getString(value.unansweredReason),
  };
}

function normalizeNextAction(value: unknown): ResearchNextAction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const toolName = getString(value.toolName);
  const reason = getString(value.reason);
  if (!toolName || !reason || !isResearchActionTool(toolName)) {
    return undefined;
  }
  return {
    toolName,
    reason,
    subquestionId: getString(value.subquestionId),
    query: getString(value.query),
  };
}

function isResearchActionTool(toolName: string): toolName is ResearchNextAction["toolName"] {
  return [
    "web_search",
    "web_fetch",
    "inspect_semantic_index",
    "semantic_search_notes",
    "read_markdown_files",
    "read_file",
    "synthesize",
  ].includes(toolName);
}

function isSubquestion(value: ResearchSubquestion | null): value is ResearchSubquestion {
  return value !== null;
}

function getResearchMode(value: unknown): ResearchMode | null {
  return value === "none" ||
    value === "deep_web" ||
    value === "deep_vault" ||
    value === "deep_hybrid"
    ? value
    : null;
}

function getPlanStatus(value: unknown): ResearchPlan["status"] | null {
  return value === "pending" ||
    value === "in_progress" ||
    value === "complete" ||
    value === "blocked"
    ? value
    : null;
}

function getSubquestionStatus(value: unknown): ResearchSubquestion["status"] | null {
  return value === "pending" ||
    value === "in_progress" ||
    value === "complete" ||
    value === "blocked"
    ? value
    : null;
}

function getEvidenceType(value: unknown): ResearchEvidenceType | null {
  return value === "web_source" || value === "vault_note" || value === "either"
    ? value
    : null;
}

function getUrlDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
