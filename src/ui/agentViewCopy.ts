/**
 * AgentView critical-path copy helpers — unit-testable without Obsidian.
 */

import { isIntentGateFailureEvent } from "../agent/toolIntentGate";

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

/** Mid-stream writeback kept a partial note; not an auth/settings block. */
export function chatWriteInterruptedTitle(): string {
  return "Write interrupted";
}

export function isPartialWritebackStopDetail(detail?: string | null): boolean {
  return /partial_write_no_safe_retry|cannot safely retry after partial note apply|interrupted after note content may have changed/i.test(
    detail ?? "",
  );
}

export function chatWriteInterruptedNextCopy(): string {
  return "Partial draft was kept in the note. Click Continue Latest Run to expand it to the word target (do not start a fresh append).";
}

/** Title for mission-graph / plan blockers (not a cloud provider outage). */
export function chatMissionGraphBlockerTitle(): string {
  return "Mission blocked";
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
  options: { skipped?: boolean } = {},
): string {
  const skipped = Boolean(options.skipped);
  const shortSummary = (message ?? (ok ? "ok" : skipped ? "skipped" : "failed"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const outcome = ok ? "ok" : skipped ? "skipped" : "failed";
  return `Used ${toolName}: ${outcome} — ${shortSummary}`;
}

/** Policy/intent gates are not model or vault failures; surface them as skips. */
export function isToolIntentGateFailure(event: {
  message?: string;
  error?: { message?: string } | null;
}): boolean {
  // Classifier lives in agent/toolIntentGate so the runner's loop ledger and
  // this timeline badge can never disagree about what counts as a gate skip.
  return isIntentGateFailureEvent(event);
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

/** Short workstream ping for Linear/GitHub/etc. receipt URLs (no Artifacts panel). */
export function receiptUrlWorkstreamLine(system: string, url: string): string {
  const label = system.trim() || "link";
  return `${label}: ${url}`;
}

export function missionReceiptWrittenChatLine(path: string): string {
  return `Mission receipt written to ${path}`;
}

export type TeamRoleStripPhase = "researcher" | "handoff" | "lead" | "idle";

/** Compact Chat strip for Lead + Researcher missions. */
export function teamRoleStripCopy(input: {
  phase: TeamRoleStripPhase;
  handoffReady?: boolean;
}): string {
  switch (input.phase) {
    case "researcher":
      return "Team: Researcher";
    case "handoff":
      return input.handoffReady === false
        ? "Team: Researcher > Handoff rejected"
        : "Team: Researcher > Handoff OK";
    case "lead":
      return "Team: Researcher > Handoff OK > Lead";
    case "idle":
    default:
      return "Team: idle";
  }
}

/** Infer team phase from status / workstream lines (Wave 0; Integrator may pass structured phases). */
export function inferTeamRolePhaseFromStatus(
  message: string,
): { phase: TeamRoleStripPhase; handoffReady?: boolean } | null {
  const text = message.trim();
  if (!text) return null;
  if (/handoff\s+rejected/i.test(text)) {
    return { phase: "handoff", handoffReady: false };
  }
  if (/handoff\s+accepted|handoff\s+ready|handoff\s+ok\b/i.test(text)) {
    return { phase: "handoff", handoffReady: true };
  }
  if (/\blead\b/i.test(text) && !/researcher/i.test(text)) {
    return { phase: "lead" };
  }
  if (/researcher\s+step|researcher\b/i.test(text)) {
    return { phase: "researcher" };
  }
  return null;
}

export function chatThinkingSectionLabel(): string {
  return "Thinking";
}

export function chatStatsSectionLabel(): string {
  return "Run stats";
}

export function chatStatsPlaceholderCopy(input: {
  stepLabel?: string;
  elapsedLabel?: string;
}): string {
  const step = input.stepLabel?.trim() || "step —";
  const elapsed = input.elapsedLabel?.trim() || "elapsed —";
  return `${step} · ${elapsed}`;
}
