import type { MissionAcceptanceResult } from "./missionAcceptance";
import type { MissionLedger } from "./missionLedger";
import {
  evidenceConflictsToProofDebtRows,
} from "./evidenceConflicts";
import {
  getNextMissionPlanActionCompat,
  type MissionPlanLike,
} from "./missionPlan";
import {
  getNextResearchAction,
  type ResearchPlan,
} from "./researchPlan";
import type { MissionRuntimeSnapshotV2 } from "./runStore";
import type { ClaimLedger } from "./claimLedger";

/**
 * Flexible snapshot for recomputing unpaid proof. Matches fields already present
 * on runtime snapshots, ledgers, and resume/continuation bundles. Claim-ledger
 * and conflict records are optional soft dependencies until those modules land.
 */
export interface ProofDebtClaimGap {
  claimId?: string;
  reason: string;
}

export interface ProofDebtConflict {
  id?: string;
  status?: string;
  summary: string;
}

export interface ProofDebtSnapshot {
  status?: string;
  missionPlan?: MissionPlanLike | null;
  researchPlan?: ResearchPlan | null;
  acceptance?: Pick<
    MissionAcceptanceResult,
    "status" | "missing" | "nextAction" | "reasons"
  > | {
    status?: string;
    missing?: string[];
    nextAction?: string;
    reasons?: string[];
  } | null;
  operationJournal?: Array<{
    state?: string;
    operationId?: string;
    toolName?: string;
  }>;
  blockers?: string[];
  blockerCategory?: string;
  pendingApprovals?: boolean;
  policyBlocked?: boolean;
  phase?: string;
  claimGaps?: ProofDebtClaimGap[];
  openConflicts?: ProofDebtConflict[];
  /** Ignored for next-action selection; debt always recomputes. */
  storedNextAction?: string;
}

export interface ProofDebtNextAction {
  kind: "tool" | "synthesize" | "blocked" | "none";
  toolName?: string;
  reason: string;
  summary: string;
}

export interface ProofDebt {
  missing: string[];
  openConflicts: ProofDebtConflict[];
  phase?: string;
  nextAction: ProofDebtNextAction;
  /** Blocks auto-continue and generic proof next-action selection. */
  blocked: boolean;
  /** Hard blockers that prevent explicit resume (WAL, approvals, policy). */
  resumeBlocked: boolean;
  empty: boolean;
}

const OPEN_CONFLICT_STATUSES = new Set(["open", "unresolved", ""]);

/**
 * Pure recomputation of unpaid proof and the next concrete action.
 * Never trusts a stored nextAction string alone.
 */
export function computeProofDebt(snapshot: ProofDebtSnapshot): ProofDebt {
  const missing: string[] = [];
  const openConflicts = collectOpenConflicts(snapshot.openConflicts);
  const walReconcile = (snapshot.operationJournal ?? []).filter(
    (entry) => entry.state === "reconcile_required",
  );
  const acceptanceMissing = dedupe(
    (snapshot.acceptance?.missing ?? []).map((item) => item.trim()).filter(Boolean),
  );
  const acceptancePassed = snapshot.acceptance?.status === "pass";

  for (const item of acceptanceMissing) {
    pushUnique(missing, item);
  }

  const missionAction = snapshot.missionPlan
    ? getNextMissionPlanActionCompat(snapshot.missionPlan)
    : undefined;
  if (missionAction && missionAction.kind !== "final") {
    if (missionAction.kind === "blocker") {
      pushUnique(missing, `mission_plan_blocker:${missionAction.taskId ?? "active"}`);
    } else if (missionAction.toolName) {
      pushUnique(missing, `mission_plan:${missionAction.toolName}`);
    } else {
      pushUnique(missing, "mission_plan_incomplete");
    }
  } else if (
    snapshot.missionPlan &&
    snapshot.missionPlan.status !== "complete" &&
    snapshot.missionPlan.status !== "blocked"
  ) {
    pushUnique(missing, "mission_plan_incomplete");
  }

  const researchAction = snapshot.researchPlan
    ? getNextResearchAction(snapshot.researchPlan)
    : undefined;
  if (snapshot.researchPlan && snapshot.researchPlan.status !== "complete") {
    const incomplete = snapshot.researchPlan.subquestions.filter(
      (item) => item.status !== "complete" && item.status !== "blocked",
    );
    for (const item of incomplete) {
      pushUnique(missing, `research_plan:${item.id}`);
    }
    if (incomplete.length === 0 && researchAction) {
      pushUnique(missing, "research_plan_synthesize");
    }
  }

  for (const gap of snapshot.claimGaps ?? []) {
    pushUnique(
      missing,
      gap.claimId ? `claim_grounding:${gap.claimId}` : `claim_grounding:${gap.reason}`,
    );
  }

  for (const conflict of openConflicts) {
    pushUnique(missing, conflict.id ? `conflict:${conflict.id}` : "open_conflict");
  }

  for (const entry of walReconcile) {
    pushUnique(
      missing,
      `wal_reconcile:${entry.operationId ?? entry.toolName ?? "unknown"}`,
    );
  }

  const resumeBlocked =
    Boolean(snapshot.pendingApprovals) ||
    Boolean(snapshot.policyBlocked) ||
    walReconcile.length > 0;
  const blocked =
    resumeBlocked ||
    Boolean(snapshot.blockerCategory) ||
    (snapshot.blockers?.length ?? 0) > 0 ||
    snapshot.missionPlan?.status === "blocked" ||
    snapshot.researchPlan?.status === "blocked" ||
    missionAction?.kind === "blocker";

  const unfinishedAcceptance =
    snapshot.acceptance?.status === "needs_more_work" ||
    snapshot.acceptance?.status === "fail";
  const activeOrResumableStatus = isActiveOrResumableStatus(snapshot.status);

  // Acceptance pass means unpaid proof is cleared for auto-continue, even if a
  // stale plan string remains. WAL/approval/policy blockers still win.
  // Open evidence conflicts never count as empty proof debt.
  // Active/budget/running ledgers and unfinished acceptance must not look
  // "empty" just because structured missing[] has not been populated yet —
  // otherwise auto-continue and the resume banner refuse productive work.
  const empty =
    !blocked &&
    openConflicts.length === 0 &&
    (acceptancePassed ||
      (snapshot.status === "complete" && !unfinishedAcceptance) ||
      (missing.length === 0 &&
        !unfinishedAcceptance &&
        !activeOrResumableStatus));

  const nextAction = blocked
    ? buildBlockedNextAction(snapshot, walReconcile, missionAction?.summary)
    : empty
      ? {
          kind: "none" as const,
          reason: "No unpaid proof debt remains.",
          summary: "Proof debt empty; do not auto-continue.",
        }
      : selectNextAction({
          missionAction,
          researchAction,
          acceptanceMissing,
          claimGaps: snapshot.claimGaps ?? [],
          openConflicts,
          acceptanceNextAction: snapshot.acceptance?.nextAction,
        });

  return {
    missing: empty && acceptancePassed ? [] : missing,
    openConflicts: empty ? [] : openConflicts,
    phase: snapshot.phase,
    nextAction,
    blocked,
    resumeBlocked,
    empty,
  };
}

export function formatProofDebtForPrompt(debt: ProofDebt): string {
  const next =
    debt.nextAction.toolName != null
      ? `${debt.nextAction.toolName} — ${debt.nextAction.reason}`
      : debt.nextAction.summary;
  return [
    "Proof debt (recomputed from durable state; do not trust prior next-action text alone).",
    `Empty: ${debt.empty ? "yes" : "no"}`,
    `Blocked: ${debt.blocked ? "yes" : "no"}`,
    debt.phase ? `Phase: ${debt.phase}` : null,
    `Missing: ${debt.missing.join(", ") || "none"}`,
    `Open conflicts: ${
      debt.openConflicts.map((item) => item.summary).join("; ") || "none"
    }`,
    `Next action: ${next}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function proofDebtSnapshotFromLedger(
  ledger: MissionLedger,
  extras: Partial<ProofDebtSnapshot> = {},
): ProofDebtSnapshot {
  return {
    status: ledger.status,
    missionPlan: ledger.missionPlan,
    researchPlan: ledger.researchPlan,
    acceptance: ledger.acceptance,
    blockers: ledger.blockers,
    blockerCategory: ledger.blockerCategory,
    storedNextAction: ledger.nextActions[0] ?? ledger.acceptance?.nextAction,
    openConflicts: evidenceConflictsToProofDebtRows(ledger.evidenceConflicts),
    claimGaps: claimGapsFromClaimLedger(ledger.claimLedger),
    ...extras,
  };
}

export function proofDebtSnapshotFromRuntime(
  snapshot: MissionRuntimeSnapshotV2,
  extras: Partial<ProofDebtSnapshot> = {},
): ProofDebtSnapshot {
  return {
    status: snapshot.status,
    missionPlan: snapshot.missionPlan,
    researchPlan: snapshot.researchPlan,
    acceptance: snapshot.acceptance,
    operationJournal: snapshot.operationJournal,
    storedNextAction: snapshot.acceptance?.nextAction,
    openConflicts: evidenceConflictsToProofDebtRows(snapshot.evidenceConflicts),
    claimGaps: claimGapsFromClaimLedger(snapshot.claimLedger),
    ...extras,
  };
}

function claimGapsFromClaimLedger(
  ledger: ClaimLedger | null | undefined,
): ProofDebtClaimGap[] {
  if (!ledger || ledger.status === "pass" || ledger.status === "skipped") {
    return [];
  }
  return ledger.missing.map((reason) => {
    const claimId =
      /^claim_grounding:(?:ungrounded|missing_quote|quote_mismatch|quote_passage|fabricated_passage_id):(.+)$/.exec(
        reason,
      )?.[1];
    return {
      ...(claimId ? { claimId } : {}),
      reason,
    };
  });
}

function collectOpenConflicts(
  conflicts: ProofDebtConflict[] | undefined,
): ProofDebtConflict[] {
  return (conflicts ?? []).filter((item) => {
    const status = (item.status ?? "open").toLowerCase();
    return OPEN_CONFLICT_STATUSES.has(status) || status === "open";
  });
}

function buildBlockedNextAction(
  snapshot: ProofDebtSnapshot,
  walReconcile: Array<{ operationId?: string; toolName?: string }>,
  missionBlocker?: string,
): ProofDebtNextAction {
  if (walReconcile.length > 0) {
    const first = walReconcile[0]!;
    return {
      kind: "blocked",
      reason: `WAL reconcile required for ${first.operationId ?? first.toolName ?? "operation"}.`,
      summary:
        `Resolve vault transaction reconciliation for ${first.toolName ?? "the pending operation"} before continuing.`,
    };
  }
  if (snapshot.pendingApprovals) {
    return {
      kind: "blocked",
      reason: "An approval is pending.",
      summary: "Wait for user approval before auto-continuing.",
    };
  }
  if (snapshot.policyBlocked) {
    return {
      kind: "blocked",
      reason: "Policy blocked further tool use.",
      summary: "Resolve the policy blocker before continuing.",
    };
  }
  if (missionBlocker) {
    return {
      kind: "blocked",
      reason: missionBlocker,
      summary: missionBlocker,
    };
  }
  if (snapshot.blockerCategory || (snapshot.blockers?.length ?? 0) > 0) {
    return {
      kind: "blocked",
      reason: snapshot.blockers?.[0] ?? `Blocked: ${snapshot.blockerCategory}`,
      summary: snapshot.blockers?.[0] ?? `Blocked: ${snapshot.blockerCategory}`,
    };
  }
  return {
    kind: "blocked",
    reason: "Proof debt is blocked.",
    summary: "Resolve blockers before auto-continuing.",
  };
}

function selectNextAction({
  missionAction,
  researchAction,
  acceptanceMissing,
  claimGaps,
  openConflicts,
  acceptanceNextAction,
}: {
  missionAction?: ReturnType<typeof getNextMissionPlanActionCompat>;
  researchAction?: ReturnType<typeof getNextResearchAction>;
  acceptanceMissing: string[];
  claimGaps: ProofDebtClaimGap[];
  openConflicts: ProofDebtConflict[];
  acceptanceNextAction?: string;
}): ProofDebtNextAction {
  // Prefer concrete tool actions from live plans over narrative acceptance text.
  if (
    missionAction &&
    missionAction.kind !== "final" &&
    missionAction.kind !== "blocker" &&
    missionAction.toolName
  ) {
    return {
      kind: "tool",
      toolName: missionAction.toolName,
      reason: missionAction.summary,
      summary: missionAction.summary,
    };
  }
  if (missionAction?.kind === "final") {
    return {
      kind: "synthesize",
      reason: missionAction.summary,
      summary: missionAction.summary,
    };
  }

  if (researchAction) {
    if (researchAction.toolName === "synthesize") {
      return {
        kind: "synthesize",
        reason: researchAction.reason,
        summary: researchAction.reason,
      };
    }
    return {
      kind: "tool",
      toolName: researchAction.toolName,
      reason: researchAction.reason,
      summary: researchAction.reason,
    };
  }

  const fromMissing = nextActionFromAcceptanceMissing(acceptanceMissing);
  if (fromMissing) {
    return fromMissing;
  }

  if (claimGaps[0]) {
    return {
      kind: "tool",
      toolName: "web_fetch",
      reason: claimGaps[0].reason,
      summary: `Ground claim: ${claimGaps[0].reason}`,
    };
  }

  if (openConflicts[0]) {
    return {
      kind: "synthesize",
      reason: openConflicts[0].summary,
      summary: `Resolve conflict: ${openConflicts[0].summary}`,
    };
  }

  if (acceptanceNextAction?.trim()) {
    // Narrative only as last resort; toolName stays unset so callers recompute.
    return {
      kind: "synthesize",
      reason: acceptanceNextAction.trim(),
      summary: acceptanceNextAction.trim(),
    };
  }

  return {
    kind: "synthesize",
    reason: "Unpaid proof remains; continue gathering or verifying evidence.",
    summary: "Continue unpaid proof work.",
  };
}

function nextActionFromAcceptanceMissing(
  missing: string[],
): ProofDebtNextAction | undefined {
  if (missing.some((item) => /^tool:web_fetch$/i.test(item) || item === "fetched_sources")) {
    return {
      kind: "tool",
      toolName: "web_fetch",
      reason: "Fetch a selected web source to pay proof debt.",
      summary: "Fetch a selected web source to pay proof debt.",
    };
  }
  if (
    missing.includes("web_evidence") ||
    missing.some((item) => /^tool:web_search$/i.test(item)) ||
    missing.some((item) => item.startsWith("fetched_sources")) ||
    missing.some((item) => item.startsWith("distinct_domains"))
  ) {
    // Prefer fetch when search already happened in the missing list narrative,
    // otherwise search. Unit contract: missing fetch → web_fetch.
    if (
      missing.some((item) => /fetch/i.test(item)) ||
      missing.some((item) => item.startsWith("fetched_sources"))
    ) {
      return {
        kind: "tool",
        toolName: "web_fetch",
        reason: "Fetch web sources required by acceptance.",
        summary: "Fetch web sources required by acceptance.",
      };
    }
    return {
      kind: "tool",
      toolName: "web_search",
      reason: "Gather web evidence required by acceptance.",
      summary: "Gather web evidence required by acceptance.",
    };
  }
  if (
    missing.includes("vault_evidence") ||
    missing.includes("research_plan_items")
  ) {
    return {
      kind: "tool",
      toolName: "read_file",
      reason: "Read vault evidence required by acceptance.",
      summary: "Read vault evidence required by acceptance.",
    };
  }
  if (missing.includes("word_count")) {
    return {
      kind: "tool",
      toolName: "count_words",
      reason: "Verify word count.",
      summary: "Verify word count.",
    };
  }
  if (missing.includes("write_receipt") || missing.some((item) => item.startsWith("pending_goal:"))) {
    return {
      kind: "tool",
      toolName: "append_to_current_file",
      reason: "Complete the required write and capture a receipt.",
      summary: "Complete the required write and capture a receipt.",
    };
  }
  return undefined;
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

const ACTIVE_OR_RESUMABLE_STATUSES = new Set([
  "running",
  "paused",
  "blocked",
  "budget",
  "needs_more_work",
  "interrupted",
  "error",
]);

function isActiveOrResumableStatus(status: string | undefined): boolean {
  return ACTIVE_OR_RESUMABLE_STATUSES.has((status ?? "").trim().toLowerCase());
}
