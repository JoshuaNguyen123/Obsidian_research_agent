import type { MissionEvidence } from "./missionLedger";
import type { MissionIntent } from "../tools/types";

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
  const missing = new Set<string>();
  const reasons: string[] = [];
  const requiredTools = new Set(input.requiredTools);
  const successfulTools = new Set(input.successfulTools);

  for (const toolName of requiredTools) {
    if (!successfulTools.has(toolName) && !hasReceiptForTool(input.receipts, toolName)) {
      missing.add(`tool:${toolName}`);
    }
  }

  if (input.missionIntent.requireWriteCompletion && input.receipts.length === 0) {
    missing.add("write_receipt");
  }

  for (const [goal, state] of Object.entries(input.operationGoals)) {
    if (state === "pending") {
      missing.add(`pending_goal:${goal}`);
    }
    if (state === "failed") {
      missing.add(`failed_goal:${goal}`);
    }
  }

  if (requiresWebEvidence(input.prompt) && !hasWebEvidence(input.evidence)) {
    missing.add("web_evidence");
  }

  if (requiresVaultEvidence(input.prompt) && !hasVaultEvidence(input.evidence)) {
    missing.add("vault_evidence");
  }

  if (requiresWordCountEvidence(input.prompt) && !successfulTools.has("count_words")) {
    missing.add("word_count");
  }

  if (input.failedTools.length > 0) {
    reasons.push(`failed_tools=${dedupe(input.failedTools).join(",")}`);
  }

  if (input.finalOutput !== undefined && input.finalOutput.trim().length === 0) {
    missing.add("final_output");
  }

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
      item === "write_receipt" ||
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
    nextAction: getNextAction(missingList),
  };
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
    result.missing.includes("write_receipt") ||
    result.missing.some((item) => item.startsWith("pending_goal:"))
      ? "Use the required write or mutation tool and produce a receipt."
      : "",
    "Request tools only. If no required tool is available, answer with a concise blocker.",
  ].filter(Boolean).join(" ");
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

function requiresWebEvidence(prompt: string): boolean {
  return /\b(web|online|sources?|citations?|latest|current\s+(?:events?|information|data|news)|verify|fact[-\s]?check)\b/i.test(prompt);
}

function requiresVaultEvidence(prompt: string): boolean {
  return /\b(vault|my notes|across notes|other folders|related notes|semantic search|what do my notes say|search my notes)\b/i.test(prompt);
}

function requiresWordCountEvidence(prompt: string): boolean {
  return /\b(word\s*count|count\s+(?:the\s+)?words?|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(prompt);
}

function getNextAction(missing: string[]): string {
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
