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

export function providerAuthFailureCopy(detail?: string): FailureCopy {
  return {
    what: "Model provider authentication failed.",
    why:
      detail?.trim() ||
      "The configured provider is missing a required API key or rejected credentials.",
    next: "Add or refresh the provider API key in plugin settings, then retry the mission.",
  };
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
  return {
    what: "Model retries were exhausted.",
    why:
      detail?.trim() ||
      "Transient provider errors kept failing after the bounded retry budget.",
    next: "Wait briefly, verify provider health and timeout settings, then retry or continue the saved ledger.",
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
  if (decision === "expired") {
    return {
      what: `Approval expired for ${toolName}.`,
      why: "The approval card timed out before Approve or Deny was chosen.",
      next: "Re-run the mission and approve promptly when the card appears, or deny to skip that tool.",
    };
  }
  if (decision === "aborted") {
    return {
      what: `Approval aborted for ${toolName}.`,
      why: "The run stopped while waiting for an approval decision.",
      next: "Start the mission again when ready to approve or deny the gated tool.",
    };
  }
  return {
    what: `Approval denied for ${toolName}.`,
    why: "You denied the gated tool, so it was not executed.",
    next: "Re-run and choose Approve if that tool is required, or continue with a different approach.",
  };
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
  return {
    what: `Research phase gate blocked a write during ${phaseLabel}.`,
    why:
      detail?.trim() ||
      "Write tools stay blocked until gather and analyze proof targets are met.",
    next: "Finish required search/fetch/read proof first, then retry the write once the phase unlocks.",
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
        .map((item) => /phase[_:]?([a-z_]+)/i.exec(item)?.[1])
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
  if (category === "missing_api_key" || category === "auth") {
    return formatFailureCopy(providerAuthFailureCopy(message));
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return formatFailureCopy(modelTimeoutFailureCopy(message));
  }
  if (
    category === "network" ||
    category === "rate_limit" ||
    /retry|transient|rate limit|temporarily/i.test(message)
  ) {
    return formatFailureCopy(modelRetryExhaustedFailureCopy(message));
  }
  return message;
}
