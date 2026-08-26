import type { AgenticReflexInput, CompletionSignal } from "./types";
import { isBroadUnscopedVaultMutation } from "../missionScope";
import {
  WRITE_RECEIPT_MISSING,
  receiptsSatisfyWriteProof,
} from "../editOrganizeIntent";
import {
  isCompletedAcceptedResearchPublicationReceipt,
} from "../setLooseCompoundAutonomy";
import { stripWriteVerificationPhrasesV1 } from "../claimLedger";

export { WRITE_RECEIPT_MISSING, receiptsSatisfyWriteProof };

export function evaluateCompletion(input: AgenticReflexInput): CompletionSignal {
  if (isBlockedBroadUnscopedMutation(input)) {
    return {
      complete: true,
      confidence: 0.9,
      missing: [],
      reason: "broad_unscoped_mutation_requires_explicit_scope",
      mustContinue: false,
    };
  }

  const missing: string[] = [];
  // write_receipt: requireWriteCompletion missions must produce at least one
  // live write receipt (tool or streamed). Prefer write-tool recovery first.
  // forceChatOnly / chat_only missions must never demand write_receipt.
  if (
    input.missionIntent.mode !== "chat_only" &&
    input.missionIntent.requireWriteCompletion &&
    !receiptsSatisfyWriteProof(input.receipts) &&
    !input.receipts.some((receipt) =>
      isCompletedAcceptedResearchPublicationReceipt(receipt),
    )
  ) {
    missing.push(WRITE_RECEIPT_MISSING);
  }
  const forswearsResearch = missionForswearsResearchEvidence(input.prompt);
  if (
    !forswearsResearch &&
    requiresVaultEvidence(input.prompt) &&
    !hasVaultEvidence(input)
  ) {
    missing.push("vault_evidence");
  }
  if (
    !forswearsResearch &&
    requiresWebEvidence(input.prompt) &&
    !hasWebEvidence(input)
  ) {
    missing.push("web_evidence");
  }
  if (requiresWordCount(input.prompt) && !hasToolEvidence(input, "count_words")) {
    missing.push("word_count");
  }

  return {
    complete: missing.length === 0,
    confidence: missing.length === 0 ? 0.9 : 0.35,
    missing,
    reason:
      missing.length === 0
        ? "required_evidence_present"
        : "missing_required_evidence",
    mustContinue: missing.length > 0 && hasAllowedRecoveryTool(input, missing),
    recommendedNextTool: getRecommendedNextTool(input, missing),
    blocker:
      missing.length > 0 && !hasAllowedRecoveryTool(input, missing)
        ? "required_evidence_tool_unavailable"
        : undefined,
  };
}

export function requiresVaultEvidence(prompt: string): boolean {
  return /\b(vault|my notes|across notes|related notes|semantic search|what do my notes say|search my notes)\b/i.test(
    prompt,
  );
}

/**
 * A mission that explicitly FORSWEARS research must not have research
 * evidence demanded back onto it by the lexical triggers here: the
 * forswearing sentence itself contains the trigger words — "This task needs
 * no web, memory, or vault research" matches \bweb\b AND \bvault\b, and an
 * ordered write contract's "verify that write" matches \bverify\b. The
 * negation-blind reading turned every step of an evidence-complete resumed
 * segment into a completion correction and then terminal-failed an
 * acceptance-passing run (proof-matrix interrupted-continuation, 2026-08-26
 * 02:16Z). Same lesson as the negation-aware quote trigger.
 */
export function missionForswearsResearchEvidence(prompt: string): boolean {
  return /\b(?:needs?|requires?|uses?)\s+no\s+(?:web|internet|online|research)\b|\bno\s+(?:web|memory|vault)\b[^.!?\n]{0,60}\bresearch\b|\bwithout\s+(?:any\s+)?(?:web\s+|internet\s+|online\s+)?research\b|\bdo(?:es)?\s+not\s+(?:need|require|use)\s+(?:any\s+)?(?:the\s+)?(?:web|internet|research)\b/i.test(
    prompt,
  );
}

function isBlockedBroadUnscopedMutation(input: AgenticReflexInput): boolean {
  return (
    input.missionIntent.explicitMutation &&
    isBroadUnscopedVaultMutation(input.missionIntent.autonomyScope)
  );
}

export function requiresWebEvidence(prompt: string): boolean {
  // Shared with shouldRequireClaimGrounding: "verify that write" is durable
  // write proof, not a demand for web sources.
  return /\b(web|online|sources?|citations?|latest|current\s+(?:events?|information|data|news)|verify|fact[-\s]?check)\b/i.test(
    stripWriteVerificationPhrasesV1(prompt),
  );
}

export function requiresWordCount(prompt: string): boolean {
  return /\b(word\s*count|count\s+(?:the\s+)?words?|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(
    prompt,
  );
}

function hasVaultEvidence(input: AgenticReflexInput): boolean {
  return input.evidence.some((item) =>
    item.kind === "vault_note" || item.kind === "tool_result",
  );
}

function hasWebEvidence(input: AgenticReflexInput): boolean {
  return input.evidence.some((item) => item.kind === "web_source");
}

function hasToolEvidence(input: AgenticReflexInput, toolName: string): boolean {
  return input.recentActions.some(
    (event) => event.kind === "tool" && event.name === toolName && event.ok,
  );
}

function hasAllowedRecoveryTool(
  input: AgenticReflexInput,
  missing: string[],
): boolean {
  return getRecommendedNextTool(input, missing) !== undefined;
}

function getRecommendedNextTool(
  input: AgenticReflexInput,
  missing: string[],
): string | undefined {
  // Prefer write tools when write_receipt is missing so edit/organize missions
  // recover into a vault mutation instead of looping on read-only evidence.
  if (missing.includes(WRITE_RECEIPT_MISSING)) {
    const writeTool = getRecommendedWriteTool(input);
    if (writeTool) {
      return writeTool;
    }
  }

  if (missing.includes("web_evidence")) {
    return input.allowedToolNames.has("web_fetch")
      ? "web_fetch"
      : input.allowedToolNames.has("web_search")
        ? "web_search"
        : undefined;
  }

  if (missing.includes("vault_evidence")) {
    for (const toolName of [
      "semantic_search_notes",
      "search_markdown_files",
      "inspect_vault_context",
      "read_markdown_files",
      "read_file",
    ]) {
      if (input.allowedToolNames.has(toolName)) {
        return toolName;
      }
    }
  }

  if (missing.includes("word_count") && input.allowedToolNames.has("count_words")) {
    return "count_words";
  }

  return undefined;
}

function getRecommendedWriteTool(input: AgenticReflexInput): string | undefined {
  for (const toolName of [
    "replace_current_file",
    "append_to_current_file",
    "edit_current_section",
    "create_file",
    "append_file",
    "replace_file",
    "create_design_canvas",
    "create_svg_design",
    "create_design_package",
  ]) {
    if (input.allowedToolNames.has(toolName)) {
      return toolName;
    }
  }
  return undefined;
}
