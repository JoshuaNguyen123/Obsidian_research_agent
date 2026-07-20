/**
 * AgentView critical-path copy helpers — unit-testable without Obsidian.
 */

export function clearChatConfirmCopy(): string {
  return "Click Confirm clear to clear chat history only. Notes, memory, backups, receipts, and settings are unchanged.";
}

export function clearChatDoneCopy(): string {
  return "Chat memory cleared. Vault notes were not modified.";
}

export function chatApprovalAttentionTitle(toolName: string): string {
  return `Approval needed: ${toolName}`;
}

export function chatProviderBlockerTitle(): string {
  return "Cloud model blocked";
}

/** Inline Chat gate when model connection is unverified before Run Mission. */
export function chatModelConnectionGateTitle(): string {
  return "Model connection required";
}

export function chatModelConnectionGateNext(): string {
  return "Open settings, add the provider API key if needed, then Test connection before Run Mission.";
}

export function toolStepChatLine(
  toolName: string,
  ok: boolean,
  message?: string,
): string {
  const shortSummary = (message ?? (ok ? "ok" : "failed"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `Used ${toolName}: ${ok ? "ok" : "failed"} — ${shortSummary}`;
}

/**
 * When structured MissionGraph routing falls back to the host planner, surface
 * a short Chat/Run Details line so operators see why.
 */
export function missionGraphPlannerFallbackCopy(
  fallbackReason: string | null | undefined,
): string | null {
  const reason = fallbackReason?.trim();
  if (!reason) return null;
  return `Mission graph used host fallback (${reason}). Structured model routing did not author the plan.`;
}

/** Resume copy: completed writes are not replayed. */
export function continueLatestRunSafeCopy(input: {
  runId: string;
  nextAction?: string;
  completedWriteCount?: number;
}): string {
  const writes = input.completedWriteCount ?? 0;
  const next = input.nextAction?.trim();
  const writeNote =
    writes > 0
      ? ` Completed write(s) (${writes}) will not be replayed.`
      : " Already-applied note writes will not be replayed.";
  return next
    ? `Safe resume for ${input.runId}: ${next}.${writeNote}`
    : `Safe resume for ${input.runId}.${writeNote}`;
}

/** Demo starter for the compound research → Linear → code → GitHub lifecycle. */
export function endToEndStarterMissionPrompt(): string {
  return (
    "I want to create the game of checkers in Python end to end following the full workflow: " +
    "research into Obsidian, turn findings into Linear tasks, implement and test the code, " +
    "publish a verified draft pull request to GitHub, and document results back into Obsidian."
  );
}

export function endToEndStarterMissionLabel(): string {
  return "End-to-end checkers workflow";
}

export function compoundLifecycleReadinessTitle(): string {
  return "End-to-end workflow setup required";
}

export function compoundLifecycleReadinessChatLine(
  blockerSummaries: string[],
): string {
  const detail =
    blockerSummaries.length > 0
      ? blockerSummaries.slice(0, 3).join("; ")
      : "Required integrations are not ready.";
  return `End-to-end mission blocked: ${detail}`;
}

export function noteStreamingActiveChatLine(): string {
  return "Streaming into the active note…";
}

export function artifactLinkChatLine(system: string, url: string): string {
  const label = system.trim() || "artifact";
  return `Artifact (${label}): ${url}`;
}

export function missionReceiptWrittenChatLine(path: string): string {
  return `Mission receipt written to ${path}`;
}
