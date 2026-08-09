import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import type { SpecialistRepairStateV2 } from "./types";

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;

export type SpecialistRepairDecisionReasonV2 =
  | "authorized"
  | "repair_cycle_exhausted"
  | "revised_approach_not_materially_different"
  | "invalid_progress_fingerprint";

export interface SpecialistRepairDecisionV2 {
  authorized: boolean;
  reason: SpecialistRepairDecisionReasonV2;
  state: SpecialistRepairStateV2;
}

export function createSpecialistRepairStateV2(): SpecialistRepairStateV2 {
  return { schemaVersion: 2, cyclesUsed: 0, status: "idle" };
}

/**
 * Authorize at most one peer repair, and only when it changes strategy rather
 * than replaying the failed call sequence with different prose.
 */
export function authorizeSpecialistRepairV2(input: {
  state?: SpecialistRepairStateV2;
  failedProgressFingerprint: string;
  previousApproach: string;
  revisedApproach: string;
}): SpecialistRepairDecisionV2 {
  const state = input.state ?? createSpecialistRepairStateV2();
  if (!FINGERPRINT.test(input.failedProgressFingerprint)) {
    return {
      authorized: false,
      reason: "invalid_progress_fingerprint",
      state: { ...state, status: "exhausted" },
    };
  }
  if (state.cyclesUsed >= 1) {
    return {
      authorized: false,
      reason: "repair_cycle_exhausted",
      state: { ...state, status: "exhausted" },
    };
  }
  if (!approachesMateriallyDiffer(input.previousApproach, input.revisedApproach)) {
    return {
      authorized: false,
      reason: "revised_approach_not_materially_different",
      state: { ...state, status: "exhausted" },
    };
  }
  return {
    authorized: true,
    reason: "authorized",
    state: {
      schemaVersion: 2,
      cyclesUsed: 1,
      status: "authorized",
      failedProgressFingerprint: input.failedProgressFingerprint,
      priorApproachFingerprint: approachFingerprint(input.previousApproach),
      revisedApproachFingerprint: approachFingerprint(input.revisedApproach),
    },
  };
}

export function approachesMateriallyDiffer(
  previousApproach: string,
  revisedApproach: string,
): boolean {
  const previous = approachTokens(previousApproach);
  const revised = approachTokens(revisedApproach);
  if (previous.length < 2 || revised.length < 2) return false;
  if (previous.join(" ") === revised.join(" ")) return false;
  const previousSet = new Set(previous);
  const revisedSet = new Set(revised);
  let intersection = 0;
  for (const token of previousSet) {
    if (revisedSet.has(token)) intersection += 1;
  }
  const union = new Set([...previousSet, ...revisedSet]).size;
  return union > 0 && intersection / union < 0.75;
}

function approachFingerprint(value: string): string {
  return `sha256:${portableSha256Text(approachTokens(value).join(" "))}`;
}

function approachTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 2);
}
