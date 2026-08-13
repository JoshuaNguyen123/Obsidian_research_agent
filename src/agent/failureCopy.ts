/**
 * User-visible failure copy: what happened, why, and what to do next.
 * Keep messages terminal-friendly (plain text, no redesign).
 */

export interface FailureCopy {
  what: string;
  why: string;
  next: string;
}

export function formatFailureCopy(copy: FailureCopy): string {
  return `What: ${copy.what} Why: ${copy.why} Next: ${copy.next}`;
}

/** Single-line progress for Chat/status (no state-machine jargon). */
export function formatRecoveryProgressLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

/**
 * Plain progress while validation/repair is in flight.
 * Example: "Validation failed; I'm fixing two files."
 */
export function validationRepairProgressCopy(input: {
  failedFileCount?: number;
  files?: readonly string[];
  detail?: string;
} = {}): string {
  const named = (input.files ?? [])
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, 3);
  const count =
    typeof input.failedFileCount === "number" &&
    Number.isFinite(input.failedFileCount) &&
    input.failedFileCount > 0
      ? Math.floor(input.failedFileCount)
      : named.length;
  if (count <= 0) {
    return formatRecoveryProgressLine(
      input.detail?.trim() ||
        "Validation failed; I'm repairing the workspace and will retry.",
    );
  }
  if (named.length === 1 && count === 1) {
    return formatRecoveryProgressLine(
      `Validation failed; I'm fixing ${named[0]}.`,
    );
  }
  if (named.length > 0 && named.length === count) {
    return formatRecoveryProgressLine(
      `Validation failed; I'm fixing ${named.join(", ")}.`,
    );
  }
  const countLabel =
    count === 1
      ? "one file"
      : count === 2
        ? "two files"
        : count === 3
          ? "three files"
          : `${count} files`;
  return formatRecoveryProgressLine(
    `Validation failed; I'm fixing ${countLabel}.`,
  );
}

export function schemaRetryProgressCopy(attempt: number, maxAttempts: number): string {
  return formatRecoveryProgressLine(
    `The model call looked malformed; retrying automatically (${Math.max(1, attempt)}/${Math.max(1, maxAttempts)}).`,
  );
}

export function modelRetryProgressCopy(attempt: number, maxAttempts: number): string {
  return formatRecoveryProgressLine(
    `The model hiccuped; retrying automatically (${Math.max(1, attempt)}/${Math.max(1, maxAttempts)}).`,
  );
}

export function toolFallbackProgressCopy(
  fromTool?: string,
  toTool?: string,
): string {
  if (fromTool?.trim() && toTool?.trim()) {
    return formatRecoveryProgressLine(
      `${fromTool.trim()} stalled; trying ${toTool.trim()} instead.`,
    );
  }
  if (toTool?.trim()) {
    return formatRecoveryProgressLine(
      `Trying ${toTool.trim()} to keep the mission moving.`,
    );
  }
  return formatRecoveryProgressLine(
    "Trying a safer alternate tool to keep the mission moving.",
  );
}

/** Credential / provider blocks that need settings then Continue. */
export function credentialBlockFailureCopy(detail?: string): FailureCopy {
  return {
    what: "I can't reach the model provider yet.",
    why:
      detail?.trim() ||
      "Credentials are missing or were rejected by the provider.",
    next: "Add or refresh the API key in settings, then click Continue.",
  };
}

/** Approval/external pauses that expose one Continue path after the user acts. */
export function approvalBlockContinueCopy(
  toolName: string,
  decision: "denied" | "expired" | "aborted" | "needed" | string = "needed",
): FailureCopy {
  if (decision === "needed") {
    return {
      what: `I need your approval before ${toolName}.`,
      why: "This action is gated so it does not run without an explicit go-ahead.",
      next: "Approve or Deny in Chat, then click Continue if the run is still waiting.",
    };
  }
  if (decision === "expired") {
    return {
      what: `Approval timed out for ${toolName}.`,
      why: "The approval card expired before a decision was recorded.",
      next: "Click Continue and approve promptly when the card appears again.",
    };
  }
  if (decision === "aborted") {
    return {
      what: `Approval was interrupted for ${toolName}.`,
      why: "The run stopped while waiting for Approve or Deny.",
      next: "Click Continue when you are ready to decide on that gated action.",
    };
  }
  return {
    what: `Approval was denied for ${toolName}.`,
    why: "You denied the gated tool, so it was not executed.",
    next: "Click Continue to resume with a different approach, or Approve next time if that tool is required.",
  };
}

export function externalStateBlockFailureCopy(detail?: string): FailureCopy {
  return {
    what: "I'm paused on external state.",
    why:
      detail?.trim() ||
      "A Linear, GitHub, or workspace check is not ready to proceed yet.",
    next: "Fix the external blocker if needed, then click Continue.",
  };
}

export function recoveryExhaustedFailureCopy(attemptsUsed?: number): FailureCopy {
  const count =
    typeof attemptsUsed === "number" && Number.isFinite(attemptsUsed)
      ? Math.max(0, Math.floor(attemptsUsed))
      : undefined;
  return {
    what: "I couldn't recover from this step automatically.",
    why:
      count !== undefined
        ? `I already tried ${count} alternate path(s) for the active task.`
        : "Automatic recovery hit its bounded retry limit for this task.",
    next: "Inspect Run Details if you want detail, then click Continue.",
  };
}

export function noAlternateToolFailureCopy(failedAction?: string): FailureCopy {
  return {
    what: "I don't have a safe alternate tool for this step.",
    why: failedAction?.trim()
      ? `${failedAction.trim()} failed and no allowed fallback is available.`
      : "The remaining tool set cannot replace the failed or stalled action.",
    next: "Broaden allowed tools or adjust the mission, then click Continue.",
  };
}

/**
 * Map a user-visible stop/blocker into conversational What/Why/Next with a
 * single Continue-oriented next step (credentials / approval / external).
 */
export function conversationalBlockerCopy(input: {
  kind?:
    | "credential"
    | "approval"
    | "external"
    | "orchestration"
    | "validation"
    | "provider"
    | "generic";
  what?: string;
  why?: string;
  toolName?: string;
  approvalDecision?: string;
  failedFileCount?: number;
}): FailureCopy {
  const kind = input.kind ?? "generic";
  if (kind === "credential") {
    return credentialBlockFailureCopy(input.why);
  }
  if (kind === "approval") {
    return approvalBlockContinueCopy(
      input.toolName?.trim() || "the gated tool",
      input.approvalDecision ?? "needed",
    );
  }
  if (kind === "external") {
    return externalStateBlockFailureCopy(input.why);
  }
  if (kind === "orchestration") {
    return {
      what: input.what?.trim() || "The mission's internal plan could not advance.",
      why:
        input.why?.trim() ||
        "A required internal prerequisite was missing or repeatedly deferred.",
      next:
        "No external action is required. Retry the mission; if it repeats, report the run ID from Run Details.",
    };
  }
  if (kind === "validation") {
    const progress = validationRepairProgressCopy({
      failedFileCount: input.failedFileCount,
      detail: input.why,
    });
    return {
      what: progress,
      why: input.why?.trim() || "Sandbox validation reported failures.",
      next: "I'll keep repairing automatically when it's safe; otherwise click Continue.",
    };
  }
  if (kind === "provider") {
    return cloudProviderBlockerFromError({ message: input.why });
  }
  return {
    what: input.what?.trim() || "The mission paused.",
    why: input.why?.trim() || "A required step could not finish yet.",
    next: "Click Continue to resume from the saved ledger.",
  };
}

/**
 * Rewrite recovery/status jargon into a plain Chat system line when recognized.
 * Unknown messages pass through unchanged.
 */
export function conversationalStatusLine(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return text;

  const validationFiles =
    /validation (?:failed|completed red)|passing[_ ]fast|code_validate/i.test(
      text,
    );
  const fileCountMatch = /(\d+)\s+files?/i.exec(text);
  if (validationFiles && fileCountMatch) {
    return validationRepairProgressCopy({
      failedFileCount: Number(fileCountMatch[1]),
      detail: text,
    });
  }
  if (validationFiles && /repair|fixing|patch/i.test(text)) {
    return validationRepairProgressCopy({ detail: text });
  }

  const recoveryPlanned = /recovery planned:\s*(.+)$/i.exec(text);
  if (recoveryPlanned?.[1]) {
    return formatRecoveryProgressLine(recoveryPlanned[1]);
  }
  if (/mission plan appears stalled/i.test(text)) {
    return "That step stalled; I'm choosing a different next action.";
  }
  if (/recovery attempts exhausted/i.test(text)) {
    return formatFailureCopy(recoveryExhaustedFailureCopy());
  }
  const retryMatch = /^retry\s+([^:]+):\s*(.+)$/i.exec(text);
  if (retryMatch) {
    return formatRecoveryProgressLine(
      `Retrying ${retryMatch[1]!.trim()} (${retryMatch[2]!.trim()}).`,
    );
  }
  const replanMatch = /^replan around\s+([^:]+):\s*(.+)$/i.exec(text);
  if (replanMatch) {
    return formatRecoveryProgressLine(
      `Replanning around ${replanMatch[1]!.trim()} (${replanMatch[2]!.trim()}).`,
    );
  }
  return text;
}

export function providerAuthFailureCopy(detail?: string): FailureCopy {
  return credentialBlockFailureCopy(
    detail?.trim() ||
      "The configured provider is missing a required API key or rejected credentials.",
  );
}

export function modelTimeoutFailureCopy(detail?: string): FailureCopy {
  return {
    what: "The model request timed out.",
    why:
      detail?.trim() ||
      "The provider did not respond before the configured request timeout.",
    next: "Increase request timeout in settings, check the provider, then retry or continue the saved ledger.",
  };
}

export function modelRetryExhaustedFailureCopy(detail?: string): FailureCopy {
  const why =
    detail?.trim() ||
    "Transient provider errors kept failing after the bounded retry budget.";
  if (/partial_write_no_safe_retry|cannot safely retry after partial note apply/i.test(why)) {
    return {
      what: "Streaming writeback stopped after partial note apply.",
      why,
      next: "Partial draft was kept. Continue Latest Run to expand it in place to the word target — do not start a fresh append.",
    };
  }
  return {
    what: "Model retries were exhausted.",
    why,
    next: "Wait briefly, verify provider health and timeout settings, then retry or continue the saved ledger.",
  };
}

export function modelRateLimitFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Cloud model rate limit reached.",
    why:
      detail?.trim() ||
      "The provider returned HTTP 429 or exhausted the request budget for this API key.",
    next: "Wait for the Retry-After window, then Continue Latest Run or retry the mission. Switch model if the limit persists.",
  };
}

export function modelMissingApiKeyFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Cloud API key is missing.",
    why:
      detail?.trim() ||
      "The configured cloud endpoint requires a BYOK API key before chat or tool calls.",
    next: "Open settings, add the provider API key, Test connection, then click Continue.",
  };
}

/** Structured Chat blocker payload for provider failures. */
export function cloudProviderBlockerFromError(error: {
  category?: string;
  message?: string;
}): FailureCopy {
  const message = error.message?.trim() || "Unknown model error.";
  const category = error.category ?? "";
  if (category === "missing_api_key") {
    return modelMissingApiKeyFailureCopy(message);
  }
  if (category === "auth") {
    return providerAuthFailureCopy(message);
  }
  if (category === "rate_limit" || category === "provider_budget_exhausted") {
    return modelRateLimitFailureCopy(message);
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return modelTimeoutFailureCopy(message);
  }
  if (category === "network" || /retry|transient|temporarily/i.test(message)) {
    return modelRetryExhaustedFailureCopy(message);
  }
  return {
    what: "Cloud model request failed.",
    why: message,
    next: "Open Run Details for the error, fix settings if needed, then send the next message or Continue Latest Run.",
  };
}

export function policyBlockFailureCopy(
  toolName: string,
  reason?: string,
): FailureCopy {
  return {
    what: `Policy blocked tool ${toolName}.`,
    why: reason?.trim() || "The active safety policy does not allow this action.",
    next: "Adjust the mission scope or settings so the action is allowed, or choose a safer tool path.",
  };
}

export function approvalDeniedFailureCopy(
  toolName: string,
  decision: "denied" | "expired" | "aborted" | string,
): FailureCopy {
  return approvalBlockContinueCopy(toolName, decision);
}

/**
 * Concrete repair steps for WAL reconcile_required. Pure helper for UI/status
 * and tests; keep wording imperative and vault-safe (inspect before rewrite).
 */
export function listReconcileActions(detail?: {
  path?: string;
  backupPath?: string;
  operationId?: string;
}): string[] {
  const path = detail?.path?.trim();
  const backupPath = detail?.backupPath?.trim();
  const operationId = detail?.operationId?.trim();
  return [
    path
      ? `Inspect note ${path} and the Agent Runs ledger for this write.`
      : "Inspect the target note and the Agent Runs ledger for this write.",
    backupPath
      ? `Compare the note with backup ${backupPath} before rewriting.`
      : "Compare the note with any .agent-backups copy before rewriting.",
    operationId
      ? `Clear reconcile_required for operation ${operationId} only after vault state matches the intended receipt.`
      : "Clear reconcile_required only after vault state matches the intended receipt.",
    "Do not retry the same write until reconciliation is resolved.",
  ];
}

export function walReconcileFailureCopy(detail?: string): FailureCopy {
  const actions = listReconcileActions();
  return {
    what: "Vault write needs reconciliation (WAL reconcile_required).",
    why:
      detail?.trim() ||
      "A mutation may have applied, but durable receipt/commit state is incomplete or ambiguous.",
    next: actions[0]!.replace(/\.$/, "") + ", then clear reconcile_required before retrying the write.",
  };
}

export function writeReceiptMissingFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Required write receipt is missing.",
    why:
      detail?.trim() ||
      "Acceptance expected a vault write receipt before the mission could complete.",
    next: "Append or replace the required note content so a write receipt is recorded, then continue from the saved ledger.",
  };
}

export function leaseWaitFailureCopy(retryAt?: string): FailureCopy {
  return {
    what: "Overnight mission is waiting on a live lease.",
    why: retryAt
      ? `Another owner still holds the durable lease until ${retryAt}.`
      : "Another owner still holds the durable mission lease.",
    next: "Leave Obsidian open; resume after the lease window, or use Resume Latest Overnight Research once the wait ends.",
  };
}

export function overnightBackoffFailureCopy(
  reason?: string,
  retryAt?: string,
): FailureCopy {
  return {
    what: "Overnight mission is backing off before the next segment.",
    why:
      reason?.trim() ||
      "A transient failure triggered bounded backoff instead of immediate retry.",
    next: retryAt
      ? `Keep Obsidian open; the runtime will retry around ${retryAt}, or resume manually after that time.`
      : "Keep Obsidian open for the automatic retry, or resume manually after the backoff window.",
  };
}

export function webFetchFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Web fetch failed.",
    why:
      detail?.trim() ||
      "The provider could not retrieve the requested page, or the response was invalid.",
    next: "Retry with a different URL, check provider/web settings, or continue from the saved ledger with another source.",
  };
}

export function blockedDomainFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Web fetch blocked an unsafe or private domain.",
    why:
      detail?.trim() ||
      "Local, private-network, credentialed, or non-HTTP(S) URLs are not allowed.",
    next: "Use a public https URL, or rely on vault/local notes instead of fetching that host.",
  };
}

export function keepAwakeFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Keep-awake request failed.",
    why:
      detail?.trim() ||
      "The desktop keep-awake API was unavailable or rejected the request.",
    next: "Leave Obsidian open and the machine awake manually; overnight is not a background daemon and will pause if the OS sleeps or Obsidian closes.",
  };
}

export function claimGroundingFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Claim grounding blocked acceptance.",
    why:
      detail?.trim() ||
      "One or more material claims lack a bound passage citation or quote span.",
    next: "Fetch or re-read sources, cite passage ids in the draft, then continue from the saved ledger.",
  };
}

export function openConflictFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Open evidence conflicts block completion.",
    why:
      detail?.trim() ||
      "Conflicting passages remain open instead of resolved or acknowledged as a limitation.",
    next: "Resolve the conflict in the draft, or acknowledge it as a limitation with a visible note, then continue.",
  };
}

export function phaseGateFailureCopy(
  phase?: string,
  detail?: string,
): FailureCopy {
  const phaseLabel = phase?.trim() || "gather/analyze";
  const analyzePhase = phaseLabel.toLowerCase() === "analyze";
  return {
    what: `Research phase gate blocked a write during ${phaseLabel}.`,
    why:
      detail?.trim() ||
      "Write tools stay blocked until gather and analyze proof targets are met.",
    next: analyzePhase
      ? "Return the complete cited synthesis as the final answer without a tool call, including explicit limitations for unresolved conflicts; the host will verify it before one write."
      : "Finish required search/fetch/read proof first, then retry the write once the phase unlocks.",
  };
}

export function semanticCoverageSecondPassCopy(detail?: string): FailureCopy {
  return {
    what: "Vault retrieval coverage forced a second pass.",
    why:
      detail?.trim() ||
      "Semantic/vault results were sampled, truncated, fallback-only, or low-confidence.",
    next: "Expand retrieval (deeper semantic search and targeted note reads) before synthesizing the final answer.",
  };
}

/** Map a web_fetch tool error message to blocked-domain vs generic fetch copy. */
export function formatWebFetchToolFailureCopy(message?: string): string {
  const detail = message?.trim() || undefined;
  if (
    detail &&
    /local or private|private network|credentials are not allowed|blocked domain|unsafe host|only supports HTTP/i.test(
      detail,
    )
  ) {
    return formatFailureCopy(blockedDomainFailureCopy(detail));
  }
  return formatFailureCopy(webFetchFailureCopy(detail));
}

/** Prefer claim/conflict/phase copy when acceptance missing items match those gates. */
export function formatAcceptanceFailureCopy(missing: string[]): string {
  const items = missing.map((item) => item.trim()).filter(Boolean);
  const detail = items.length > 0 ? items.join(", ") : undefined;
  if (items.some((item) => item.includes("claim_grounding"))) {
    return formatFailureCopy(claimGroundingFailureCopy(detail));
  }
  if (
    items.some(
      (item) =>
        item.includes("open_evidence_conflicts") ||
        item.startsWith("conflict:") ||
        item.includes("conflict_limitation"),
    )
  ) {
    return formatFailureCopy(openConflictFailureCopy(detail));
  }
  if (
    items.some(
      (item) =>
        item.includes("research_phase") ||
        item.includes("phase_gate") ||
        item.includes("write_tools_blocked"),
    )
  ) {
    const phase =
      items
        .map(
          (item) =>
            /(?:research_)?phase(?:_(?:gate|acceptance))?[:_]+(gather|analyze|write|verify)\b/iu.exec(
              item,
            )?.[1],
        )
        .find(Boolean) ?? undefined;
    return formatFailureCopy(phaseGateFailureCopy(phase, detail));
  }
  return detail
    ? `Mission acceptance missing: ${detail}.`
    : "Mission acceptance checks are incomplete.";
}

export function formatModelFailureCopy(error: {
  category?: string;
  message?: string;
}): string {
  const message = error.message?.trim() || "Unknown model error.";
  const category = error.category ?? "";
  // Structured What/Why/Next only for known cloud provider failure classes.
  if (
    category === "missing_api_key" ||
    category === "auth" ||
    category === "rate_limit" ||
    category === "provider_budget_exhausted" ||
    category === "network" ||
    /timeout|timed out|aborted|rate limit|retry|transient|temporarily/i.test(
      message,
    )
  ) {
    return formatFailureCopy(cloudProviderBlockerFromError(error));
  }
  return message;
}
