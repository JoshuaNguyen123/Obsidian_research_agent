import type { MissionPlan, MissionPlanLike } from "./missionPlan";
import { flattenMissionPlanTasks } from "./missionPlan";
import type { ResearchPlan } from "./researchPlan";

const MUTATING_TOOL_PATTERN =
  /^(append|replace|edit|delete|move|rename|retitle|highlight|restore|create|fill|link_|install_|export_workspace)/;

/**
 * Runner-owned research phases for research-bearing missions.
 * Non-research write-only missions skip gather/analyze and start at write.
 */
export type ResearchRunPhase = "gather" | "analyze" | "write" | "verify";

/**
 * Optional claim/conflict inputs (A1/A2). When omitted, analyze advances as
 * soon as gather evidence targets are met so phase gates still work before
 * the claim ledger lands.
 */
export interface ClaimConflictState {
  openConflictCount?: number;
  unboundClaimCount?: number;
  claimsGrounded?: boolean | null;
  analyzeComplete?: boolean;
}

export interface DeriveResearchPhaseInput {
  researchPlan?: ResearchPlan | null;
  missionPlan?: MissionPlanLike | null;
  claimConflict?: ClaimConflictState | null;
  /** Observable write receipt / successful vault mutation proof. */
  writeReceiptPresent?: boolean;
  /** Observable canonical receipt for a Linear/GitHub action. */
  externalActionReceiptPresent?: boolean;
  /** Observable verify-complete (word-count / acceptance / readback). */
  verifyComplete?: boolean;
}

export interface ResearchPhaseDescriptor {
  phase: ResearchRunPhase;
  reason: string;
  researchBearing: boolean;
  writeToolsAllowed: boolean;
  /** Final acceptance only after verify-complete. */
  acceptanceAllowed: boolean;
  gatherComplete: boolean;
  analyzeComplete: boolean;
}

export interface ResearchPhaseTransition {
  from: ResearchRunPhase | null;
  to: ResearchRunPhase;
  reason: string;
}

/**
 * Downgrade a would-be pass when research phase has not reached
 * verify-complete (`acceptanceAllowed`). Gather/analyze stay blocked.
 * Write-phase and verify-phase candidate checks are allowed so proof-gated
 * writeback and chat-only synthesis after gather/analyze can accept.
 */
export function gateAcceptanceByResearchPhase<
  T extends { status: string; missing: string[]; reasons: string[]; nextAction?: string },
>(acceptance: T, phase: ResearchPhaseDescriptor | null | undefined): T {
  if (
    !phase?.researchBearing ||
    phase.acceptanceAllowed ||
    phase.phase === "write" ||
    phase.phase === "verify"
  ) {
    return acceptance;
  }
  if (acceptance.status !== "pass") {
    const missing = [...acceptance.missing];
    const phaseMissing = `research_phase_acceptance:${phase.phase}`;
    if (!missing.includes(phaseMissing)) {
      missing.push(phaseMissing);
    }
    return {
      ...acceptance,
      missing,
      reasons: [
        ...acceptance.reasons,
        `research_phase_${phase.phase}_blocks_acceptance`,
      ],
      nextAction:
        acceptance.nextAction ??
        `Continue research phase ${phase.phase} before final acceptance.`,
    };
  }
  return {
    ...acceptance,
    status: "needs_more_work",
    missing: [
      ...acceptance.missing,
      `research_phase_acceptance:${phase.phase}`,
    ],
    reasons: [
      ...acceptance.reasons,
      `research_phase_${phase.phase}_blocks_acceptance`,
    ],
    nextAction: `Continue research phase ${phase.phase} before final acceptance.`,
  };
}

export function isResearchBearingPlan(
  researchPlan: ResearchPlan | null | undefined,
): boolean {
  return Boolean(researchPlan && researchPlan.mode !== "none");
}

/**
 * Pure phase derivation from research plan + mission plan + optional
 * claim/conflict state and observable receipts.
 */
export function deriveResearchPhase(
  input: DeriveResearchPhaseInput = {},
): ResearchPhaseDescriptor {
  const researchBearing = isResearchBearingPlan(input.researchPlan);
  const writeReceiptPresent =
    input.writeReceiptPresent === true ||
    (input.externalActionReceiptPresent === true &&
      missionPlanRequiresExternalAction(input.missionPlan));
  const verifyComplete = input.verifyComplete === true;

  if (!researchBearing) {
    return deriveNonResearchPhase({
      writeReceiptPresent,
      verifyComplete,
      missionPlan: input.missionPlan,
    });
  }

  const gatherComplete = isGatherComplete(input.researchPlan!);
  const analyzeComplete = isAnalyzeComplete({
    gatherComplete,
    claimConflict: input.claimConflict,
  });

  if (!gatherComplete) {
    return descriptor({
      phase: "gather",
      reason: "Research source/subquestion evidence targets are not yet met.",
      researchBearing: true,
      gatherComplete: false,
      analyzeComplete: false,
      writeReceiptPresent: false,
      verifyComplete: false,
    });
  }

  if (!analyzeComplete) {
    return descriptor({
      phase: "analyze",
      reason: describeAnalyzeBlocker(input.claimConflict),
      researchBearing: true,
      gatherComplete: true,
      analyzeComplete: false,
      writeReceiptPresent: false,
      verifyComplete: false,
    });
  }

  if (!writeReceiptPresent) {
    const missionWriteReady = missionPlanAllowsWrite(input.missionPlan);
    return descriptor({
      phase: "write",
      reason: missionWriteReady
        ? "Gather and analyze complete; requested action tools are unlocked."
        : "Gather and analyze complete; waiting for a ready action task or receipt.",
      researchBearing: true,
      gatherComplete: true,
      analyzeComplete: true,
      writeReceiptPresent: false,
      verifyComplete: false,
    });
  }

  return descriptor({
    phase: "verify",
    reason: verifyComplete
      ? "Write receipt present and verification complete."
      : "Write receipt present; verification/acceptance still required.",
    researchBearing: true,
    gatherComplete: true,
    analyzeComplete: true,
    writeReceiptPresent: true,
    verifyComplete,
  });
}

export function areWriteToolsAllowedForPhase(
  phase: ResearchRunPhase,
  researchBearing: boolean,
): boolean {
  if (!researchBearing) {
    return phase === "write" || phase === "verify";
  }
  return phase === "write" || phase === "verify";
}

export function buildResearchPhaseTransition(
  previous: ResearchRunPhase | null | undefined,
  next: ResearchPhaseDescriptor,
): ResearchPhaseTransition | null {
  if (previous === next.phase) {
    return null;
  }
  return {
    from: previous ?? null,
    to: next.phase,
    reason: next.reason,
  };
}

function deriveNonResearchPhase({
  writeReceiptPresent,
  verifyComplete,
  missionPlan,
}: {
  writeReceiptPresent: boolean;
  verifyComplete: boolean;
  missionPlan?: MissionPlanLike | null;
}): ResearchPhaseDescriptor {
  if (writeReceiptPresent) {
    return descriptor({
      phase: "verify",
      reason: verifyComplete
        ? "Non-research write complete; verification finished."
        : "Non-research write receipt present; verification pending.",
      researchBearing: false,
      gatherComplete: true,
      analyzeComplete: true,
      writeReceiptPresent: true,
      verifyComplete,
    });
  }

  void missionPlan;
  return descriptor({
    phase: "write",
    reason:
      "Non-research write-only mission skips gather/analyze; write tools are allowed.",
    researchBearing: false,
    gatherComplete: true,
    analyzeComplete: true,
    writeReceiptPresent: false,
    verifyComplete: false,
  });
}

function isGatherComplete(plan: ResearchPlan): boolean {
  if (plan.status === "complete") {
    return true;
  }
  if (plan.status === "blocked") {
    // Blocked gather still must not unlock writes; stay in gather until
    // recovery clears the blocker or evidence arrives.
    return false;
  }

  const subquestionsDone = plan.subquestions.every(
    (item) => item.status === "complete" || item.status === "blocked",
  );
  if (!subquestionsDone) {
    return false;
  }

  // Source minima are observable via evidence ids already bound on the plan.
  // When minFetchedSources > 0, require at least that many web_fetch-style ids
  // (or any evidence ids if the plan already marked subquestions complete).
  if (plan.sourceRequirements.minFetchedSources > 0) {
    const fetchedLike = plan.evidenceIds.filter(
      (id) =>
        id.startsWith("web_fetch:") ||
        id.startsWith("source:") ||
        id.startsWith("web_source:"),
    ).length;
    // Subquestions complete implies applyResearchEvidence already counted
    // enough typed evidence; treat that as gather-complete even when the
    // evidence id prefix set is heterogeneous.
    if (plan.subquestions.every((item) => item.status === "complete")) {
      return true;
    }
    if (fetchedLike < plan.sourceRequirements.minFetchedSources) {
      return false;
    }
  }

  return plan.nextAction?.toolName === "synthesize" || subquestionsDone;
}

function isAnalyzeComplete({
  gatherComplete,
  claimConflict,
}: {
  gatherComplete: boolean;
  claimConflict?: ClaimConflictState | null;
}): boolean {
  if (!gatherComplete) {
    return false;
  }
  if (!claimConflict) {
    // No claim ledger yet: analyze is vacuously complete once gather is done.
    return true;
  }
  if (claimConflict.analyzeComplete === true) {
    return true;
  }
  if ((claimConflict.openConflictCount ?? 0) > 0) {
    return false;
  }
  if ((claimConflict.unboundClaimCount ?? 0) > 0) {
    return false;
  }
  if (claimConflict.claimsGrounded === false) {
    return false;
  }
  // Explicit claimConflict object with no blockers → analyze complete.
  return true;
}

function describeAnalyzeBlocker(
  claimConflict: ClaimConflictState | null | undefined,
): string {
  if (!claimConflict) {
    return "Gather complete; analyze ready.";
  }
  if ((claimConflict.openConflictCount ?? 0) > 0) {
    return `Analyze blocked: ${claimConflict.openConflictCount} open evidence conflict(s).`;
  }
  if ((claimConflict.unboundClaimCount ?? 0) > 0) {
    return `Analyze blocked: ${claimConflict.unboundClaimCount} unbound claim(s).`;
  }
  if (claimConflict.claimsGrounded === false) {
    return "Analyze blocked: claims are not yet grounded to passages.";
  }
  return "Gather complete; finishing claim/conflict analysis.";
}

function missionPlanAllowsWrite(
  missionPlan: MissionPlanLike | null | undefined,
): boolean {
  if (!missionPlan) {
    return true;
  }
  const tasks = flattenMissionPlanTasks(missionPlan as MissionPlan);
  return tasks.some(
    (task) =>
      task.status !== "complete" &&
      task.status !== "blocked" &&
      (task.completionContract.requiredProof.includes("write_receipt") ||
        task.completionContract.requiredProof.includes(
          "external_action_receipt",
        ) ||
        task.allowedTools.some((tool) =>
          /^(?:linear|github)_(?!read_|get_|list_|search_|find_|inspect_)/u.test(
            tool,
          ),
        ) ||
        task.allowedTools.some((tool) => MUTATING_TOOL_PATTERN.test(tool))),
  );
}

function missionPlanRequiresExternalAction(
  missionPlan: MissionPlanLike | null | undefined,
): boolean {
  if (!missionPlan) {
    return false;
  }
  return flattenMissionPlanTasks(missionPlan as MissionPlan).some((task) =>
    task.completionContract.requiredProof.includes("external_action_receipt"),
  );
}

function descriptor(input: {
  phase: ResearchRunPhase;
  reason: string;
  researchBearing: boolean;
  gatherComplete: boolean;
  analyzeComplete: boolean;
  writeReceiptPresent: boolean;
  verifyComplete: boolean;
}): ResearchPhaseDescriptor {
  const writeToolsAllowed = areWriteToolsAllowedForPhase(
    input.phase,
    input.researchBearing,
  );
  return {
    phase: input.phase,
    reason: input.reason,
    researchBearing: input.researchBearing,
    writeToolsAllowed,
    acceptanceAllowed: input.verifyComplete === true,
    gatherComplete: input.gatherComplete,
    analyzeComplete: input.analyzeComplete,
  };
}
