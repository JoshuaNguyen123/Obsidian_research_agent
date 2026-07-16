import type { MissionEvidence } from "./missionLedger";
import { isBroadUnscopedVaultMutation } from "./missionScope";
import {
  evaluateResearchAcceptance,
  type ResearchPlan,
} from "./researchPlan";
import type { EvidenceConflict } from "./evidenceConflicts";
import {
  claimGroundingAcceptanceDelta,
  type ClaimLedger,
} from "./claimLedger";
import type { MissionIntent } from "../tools/types";
import {
  isExplicitVisibleFileRenameIntent,
  isTitleOnlyIntent,
  verifyVisibleRenameReceipt,
} from "./titleIntent";
import {
  WRITE_RECEIPT_MISSING,
  isCurrentNoteEditOrganizeIntent,
  isVaultWideOrganizeIntent,
  receiptsSatisfyWriteProof,
} from "./editOrganizeIntent";
import { receiptSatisfiesProof } from "./missionPlan";
import {
  requiresVaultEvidenceProof,
  requiresWebEvidenceProof,
} from "./evidenceIntent";

export {
  DAILY_USE_ACCEPTANCE_V1,
  evaluateDailyUseAcceptanceV1,
} from "./dailyUseAcceptance";
export type {
  DailyUseAcceptanceResultV1,
  DailyUseAcceptanceV1,
  DailyUseObservedAcceptanceV1,
  DailyUseScenarioId,
} from "./dailyUseAcceptance";

export type MissionAcceptanceStatus = "pass" | "fail" | "needs_more_work";

export interface MissionAcceptanceReceiptLike {
  toolName?: string;
  operation?: string;
  path?: string;
  toPath?: string;
  backupPath?: string;
  message?: string;
  bytesWritten?: number;
  bytesDeleted?: number;
  affectedCount?: number;
  resource?: {
    system?: string;
    resourceType?: string;
    id?: string;
  };
}

export interface MissionAcceptanceInput {
  prompt: string;
  missionIntent: MissionIntent;
  requiredTools: string[];
  successfulTools: string[];
  failedTools: string[];
  evidence: MissionEvidence[];
  receipts: MissionAcceptanceReceiptLike[];
  finalOutput?: string;
  operationGoals: Record<string, string>;
  researchPlan?: ResearchPlan | null;
  /** Optional evidence conflicts for deep/hybrid research acceptance. */
  conflicts?: EvidenceConflict[] | null;
}

export interface MissionAcceptanceResult {
  status: MissionAcceptanceStatus;
  confidence: number;
  missing: string[];
  reasons: string[];
  nextAction?: string;
}

export function evaluateMissionAcceptance(
  input: MissionAcceptanceInput,
): MissionAcceptanceResult {
  if (isBlockedBroadUnscopedMutation(input)) {
    if (input.finalOutput !== undefined && input.finalOutput.trim().length === 0) {
      return {
        status: "fail",
        confidence: 0.3,
        missing: ["final_output"],
        reasons: ["broad_unscoped_mutation_blocker_missing"],
        nextAction: "Ask the user for an explicit file, folder, or current-note scope.",
      };
    }
    return {
      status: "pass",
      confidence: 0.9,
      missing: [],
      reasons: ["broad_unscoped_mutation_requires_explicit_scope"],
    };
  }

  const missing = new Set<string>();
  const reasons: string[] = [];
  const requiredTools = new Set(input.requiredTools);
  const successfulTools = new Set(input.successfulTools);

  for (const toolName of requiredTools) {
    if (!successfulTools.has(toolName) && !hasReceiptForTool(input.receipts, toolName)) {
      missing.add(`tool:${toolName}`);
    }
  }

  // Vault-wide organize without targets must not fail solely on write_receipt.
  const vaultOrganizeClarify =
    isVaultWideOrganizeIntent(input.prompt) &&
    !isCurrentNoteEditOrganizeIntent(input.prompt);
  if (
    input.missionIntent.requireWriteCompletion &&
    !vaultOrganizeClarify &&
    !receiptsSatisfyWriteProof(input.receipts) &&
    !receiptsSatisfyMatchingNonVaultProof(input)
  ) {
    missing.add(WRITE_RECEIPT_MISSING);
  }

  for (const [goal, state] of Object.entries(input.operationGoals)) {
    if (state === "pending") {
      missing.add(`pending_goal:${goal}`);
    }
    if (state === "failed") {
      missing.add(`failed_goal:${goal}`);
    }
  }

  if (
    requiresWebEvidenceProof(input.prompt, input.missionIntent) &&
    !hasWebEvidence(input.evidence)
  ) {
    missing.add("web_evidence");
  }

  if (
    requiresVaultEvidenceProof(input.prompt, input.missionIntent) &&
    !hasVaultEvidence(input.evidence)
  ) {
    missing.add("vault_evidence");
  }

  if (requiresWordCountEvidence(input.prompt) && !successfulTools.has("count_words")) {
    missing.add("word_count");
  }

  if (
    (isExplicitVisibleFileRenameIntent(input.prompt) ||
      isTitleOnlyIntent(input.prompt)) &&
    !input.receipts.some(verifyVisibleRenameReceipt)
  ) {
    missing.add("visible_title_rename");
  }

  if (requiresHighlightReceipt(input.prompt) && !hasHighlightReceipt(input.receipts)) {
    missing.add("highlight_receipt");
  }

  if (input.failedTools.length > 0) {
    reasons.push(`failed_tools=${dedupe(input.failedTools).join(",")}`);
  }

  if (input.finalOutput !== undefined && input.finalOutput.trim().length === 0) {
    missing.add("final_output");
  }

  const researchAcceptance = evaluateResearchAcceptance({
    plan: input.researchPlan,
    evidence: input.evidence,
    finalOutput: input.finalOutput,
    conflicts: input.conflicts,
  });
  for (const item of researchAcceptance.missing) {
    missing.add(item);
  }
  reasons.push(...researchAcceptance.reasons);

  const missingList = [...missing];
  if (missingList.length === 0) {
    return {
      status: "pass",
      confidence: 0.92,
      missing: [],
      reasons: reasons.length > 0 ? reasons : ["required_evidence_and_receipts_present"],
    };
  }

  const hardFailure = missingList.some(
    (item) =>
      item === WRITE_RECEIPT_MISSING ||
      item.startsWith("failed_goal:") ||
      item === "final_output",
  );

  return {
    status: hardFailure ? "fail" : "needs_more_work",
    confidence: hardFailure ? 0.3 : 0.55,
    missing: missingList,
    reasons: [
      ...reasons,
      hardFailure
        ? "concrete_required_output_missing"
        : "required_evidence_or_tool_missing",
    ],
    nextAction: researchAcceptance.nextAction ?? getNextAction(missingList),
  };
}

/**
 * Non-vault proof remains domain-specific. A receipt can satisfy the global
 * concrete-output requirement only when its exact tool was both required and
 * successfully executed in this run. Artifact proof additionally requires an
 * explicit artifact-write scope. Workspace/Git mutation receipts satisfy the
 * compatibility write proof; Linear/GitHub actions remain external-only.
 */
function receiptsSatisfyMatchingNonVaultProof(
  input: MissionAcceptanceInput,
): boolean {
  const requiredTools = new Set(input.requiredTools);
  const successfulTools = new Set(input.successfulTools);
  return input.receipts.some(
    (receipt) => {
      const toolName = receipt.toolName?.trim() ?? "";
      if (
        !toolName ||
        !requiredTools.has(toolName) ||
        !successfulTools.has(toolName)
      ) {
        return false;
      }
      if (
        input.missionIntent.autonomyScope.write.artifacts === true &&
        receiptSatisfiesProof("artifact_receipt", receipt)
      ) {
        return true;
      }
      return receiptSatisfiesProof("external_action_receipt", receipt) ||
        receiptSatisfiesProof("write_receipt", receipt);
    },
  );
}

function isBlockedBroadUnscopedMutation(input: MissionAcceptanceInput): boolean {
  return (
    input.missionIntent.explicitMutation &&
    isBroadUnscopedVaultMutation(input.missionIntent.autonomyScope)
  );
}

export function formatMissionAcceptanceCorrection(
  result: MissionAcceptanceResult,
  availableToolNames: string[],
): string {
  return [
    `Mission acceptance is incomplete: ${result.missing.join(", ")}.`,
    `Available tools: ${availableToolNames.join(", ") || "none"}.`,
    result.missing.includes("web_evidence")
      ? "Use web_search and web_fetch before answering."
      : "",
    result.missing.includes("vault_evidence")
      ? "Use vault, semantic, or markdown read tools before answering."
      : "",
    result.missing.includes("word_count") ? "Use count_words before answering." : "",
    result.missing.some((item) => item.startsWith("fetched_sources"))
      ? "Deep research requires fetching additional source pages before answering."
      : "",
    result.missing.some((item) => item.startsWith("distinct_domains"))
      ? "Deep research requires fetched sources from more distinct domains when available."
      : "",
    result.missing.includes("research_plan_items")
      ? "Complete the next incomplete research plan item before answering."
      : "",
    result.missing.includes("citation_url_coverage")
      ? "Revise the final answer so fetched source URLs are visible."
      : "",
    result.missing.includes("limitations_section") ||
    result.missing.includes("confidence_section")
      ? "Include limitations and confidence in the final answer."
      : "",
    result.missing.some((item) => item.startsWith("open_evidence_conflicts"))
      ? "Resolve open evidence conflicts or acknowledge them as limitations before accepting."
      : "",
    result.missing.some((item) => item.startsWith("conflict_limitation"))
      ? "State acknowledged evidence conflicts as explicit limitations in the final answer."
      : "",
    result.missing.some(
      (item) =>
        item.includes("claim_grounding") || item.startsWith("verifier:claim_grounding"),
    )
      ? "Ground each material claim with a persisted passage citation before accepting."
      : "",
    result.missing.includes(WRITE_RECEIPT_MISSING) ||
    result.missing.includes("visible_title_rename") ||
    result.missing.includes("highlight_receipt") ||
    result.missing.some((item) => item.startsWith("pending_goal:"))
      ? "Use the required write or mutation tool and produce a receipt."
      : "",
    "Request tools only. If no required tool is available, answer with a concise blocker.",
  ].filter(Boolean).join(" ");
}

/**
 * Merge claim-ledger findings into mission acceptance for S5 staged writeback /
 * final acceptance wiring. Skipped or passing ledgers leave acceptance unchanged.
 */
export function mergeClaimGroundingIntoAcceptance(
  acceptance: MissionAcceptanceResult,
  ledger: ClaimLedger,
): MissionAcceptanceResult {
  const delta = claimGroundingAcceptanceDelta(ledger);
  if (delta.missing.length === 0) {
    return acceptance;
  }
  return {
    ...acceptance,
    status: acceptance.status === "fail" ? "fail" : "needs_more_work",
    confidence: Math.min(acceptance.confidence, 0.45),
    missing: [...new Set([...acceptance.missing, ...delta.missing])],
    reasons: [...new Set([...acceptance.reasons, ...delta.reasons])],
    nextAction: delta.nextAction ?? acceptance.nextAction,
  };
}

function hasReceiptForTool(
  receipts: MissionAcceptanceReceiptLike[],
  toolName: string,
): boolean {
  return receipts.some((receipt) => receipt.toolName === toolName);
}

function hasWebEvidence(evidence: MissionEvidence[]): boolean {
  return evidence.some((item) => item.kind === "web_source" || Boolean(item.url));
}

function hasVaultEvidence(evidence: MissionEvidence[]): boolean {
  return evidence.some(
    (item) =>
      item.kind === "vault_note" ||
      (item.kind === "tool_result" && Boolean(item.path)),
  );
}

function requiresWordCountEvidence(prompt: string): boolean {
  return /\b(word\s*count|count\s+(?:the\s+)?words?|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(prompt);
}

function requiresHighlightReceipt(prompt: string): boolean {
  return /\b(find|search|locate|show)\b[\s\S]{0,120}\b(highlight|mark)\b|\b(highlight|mark)\b[\s\S]{0,120}\b(word|phrase|text|where|current\s+(?:note|file|page))\b/i.test(
    prompt,
  );
}

function hasHighlightReceipt(receipts: MissionAcceptanceReceiptLike[]): boolean {
  return receipts.some(
    (receipt) =>
      receipt.toolName === "highlight_current_file_phrase" &&
      receipt.operation === "highlight" &&
      (receipt.affectedCount ?? 0) > 0,
  );
}

function getNextAction(missing: string[]): string {
  if (missing.includes("visible_title_rename")) {
    return "Rename the visible current note title and produce a receipt.";
  }
  if (missing.includes("highlight_receipt")) {
    return "Highlight the requested phrase in the current note and produce a receipt.";
  }
  if (missing.includes("web_evidence")) return "Gather web source evidence.";
  if (missing.includes("vault_evidence")) return "Gather vault note evidence.";
  if (missing.includes("word_count")) return "Run word-count verification.";
  if (missing.some((item) => item.includes("write") || item.includes("goal"))) {
    return "Complete the required write or mutation with a receipt.";
  }
  return "Resolve missing mission acceptance items.";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
