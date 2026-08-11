export interface LeadContinuationDecisionInput {
  stopReason: string;
  autoContinueRecommended?: boolean;
  autoContinueReason?: string;
  usedModelSteps: number;
  maxModelSteps: number;
  usedToolCalls: number;
  maxToolCalls: number;
  segmentIndex: number;
  maxSegments: number;
  aborted: boolean;
  /**
   * The completed segment reported research evidence saturation: retrieval
   * ran dry with nothing unresolved. Another segment cannot add material
   * evidence, so continuation is refused regardless of remaining caps.
   */
  evidenceSaturated?: boolean;
  currentProgressFingerprint?: string;
  previousProgressFingerprint?: string;
  currentAcceptanceMissing?: readonly string[];
  previousAcceptanceMissing?: readonly string[];
  availableRepairAction?: boolean;
}

export function createLeadProgressFingerprintV1(input: {
  finalOutput: string;
  receiptIds: readonly string[];
  stopDetail?: string | null;
}): string {
  const canonical = [
    input.finalOutput.replace(/\s+/gu, " ").trim(),
    [...new Set(input.receiptIds)].sort().join("|"),
    input.stopDetail?.trim() ?? "",
  ].join("\n--\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `progress:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface LeadCompletionShape {
  step: number;
  stopReason: string;
}

/**
 * A Lead segment started on an already-aborted deadline performs zero steps
 * and reports stopReason "budget" (or "user_stopped" if the abort reason text
 * escaped deadline classification). Adopting that completion would demote a
 * mission whose result was already applied and forwarded. Such an event is a
 * scheduling artifact, not an outcome, and must not replace the prior
 * terminal-success completion.
 */
export function isDemotingZeroStepLeadCompletion(
  previousSuccess: LeadCompletionShape | null,
  next: LeadCompletionShape,
): boolean {
  return (
    previousSuccess !== null &&
    (previousSuccess.stopReason === "write_completed" ||
      previousSuccess.stopReason === "final") &&
    next.step === 0 &&
    (next.stopReason === "budget" || next.stopReason === "user_stopped")
  );
}

/**
 * An orchestrated Lead owns a bounded proof-repair reserve after handoff.
 * Generic missions intentionally do not auto-continue acceptance failures, but
 * the Lead may spend its existing reserve to correct citations or final proof.
 * This decision never increases model, tool, segment, or wall-clock authority.
 */
export function shouldContinueResearchLead(
  input: LeadContinuationDecisionInput,
): boolean {
  if (
    input.stopReason !== "budget" ||
    input.usedModelSteps >= input.maxModelSteps ||
    input.usedToolCalls >= input.maxToolCalls ||
    input.segmentIndex + 1 >= input.maxSegments ||
    input.aborted ||
    input.evidenceSaturated === true ||
    input.availableRepairAction === false
  ) {
    return false;
  }
  const requested =
    input.autoContinueRecommended === true ||
    input.autoContinueReason === "acceptance_failed";
  if (!requested) {
    return false;
  }

  // The first continuation may repair a named acceptance gap. Every later
  // segment must prove it changed the artifact/evidence fingerprint or reduced
  // the concrete missing set; unchanged proof debt is a terminal blocker.
  if (
    input.previousProgressFingerprint === undefined &&
    input.previousAcceptanceMissing === undefined
  ) {
    return true;
  }
  if (
    input.currentProgressFingerprint !== undefined &&
    input.previousProgressFingerprint !== undefined &&
    input.currentProgressFingerprint !== input.previousProgressFingerprint
  ) {
    return true;
  }
  const currentMissing = new Set(input.currentAcceptanceMissing ?? []);
  const previousMissing = new Set(input.previousAcceptanceMissing ?? []);
  return (
    previousMissing.size > 0 &&
    currentMissing.size < previousMissing.size &&
    [...currentMissing].every((item) => previousMissing.has(item))
  );
}
