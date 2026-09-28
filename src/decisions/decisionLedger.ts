import {
  normalizeDecisionCallRecordsV1,
  type DecisionCallRecordV1,
} from "./decisionRuntime";

/**
 * What a run record keeps about its decisions. Additive and optional: a run
 * written before the decision model existed has no `decisions` field and reads
 * exactly as it always did. Nothing here carries prompt, draft, passage, or
 * credential text beyond the bounded claim text a held finding must show.
 */
export interface DecisionLedgerV1 {
  version: 1;
  records: DecisionCallRecordV1[];
  /** The mission contract a continuation reuses instead of asking again. */
  missionContract?: PersistedMissionDecisionContractV1;
  /** Bounded shadow comparisons (routing and research), newest last. */
  shadowComparisons?: unknown[];
  /** Claim-support findings, coverage, repair allowance, held candidate. */
  claimSupport?: unknown;
}

export interface PersistedMissionDecisionContractV1 {
  version: 1;
  /** The routing prompt the assessment answered (after any evidence clause). */
  promptFingerprint: string;
  inputFingerprint: string;
  templateVersion: string;
  thresholdsVersion: string;
  mode: "shadow" | "enabled";
  /** The interpreted assessment, as JSON; re-validated on read. */
  assessment: unknown;
  evidenceContract: unknown | null;
}

const MAX_SHADOW_COMPARISONS = 8;

export function normalizeDecisionLedgerV1(value: unknown): DecisionLedgerV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const records = normalizeDecisionCallRecordsV1(value.records);
  const missionContract = normalizeContract(value.missionContract);
  const shadowComparisons = Array.isArray(value.shadowComparisons)
    ? value.shadowComparisons.filter(isRecord).slice(-MAX_SHADOW_COMPARISONS)
    : [];
  const claimSupport = isRecord(value.claimSupport) ? value.claimSupport : undefined;
  if (records.length === 0 && !missionContract && shadowComparisons.length === 0 && !claimSupport) {
    return undefined;
  }
  return {
    version: 1,
    records,
    ...(missionContract ? { missionContract } : {}),
    ...(shadowComparisons.length > 0 ? { shadowComparisons } : {}),
    ...(claimSupport ? { claimSupport } : {}),
  };
}

function normalizeContract(value: unknown): PersistedMissionDecisionContractV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    typeof value.promptFingerprint !== "string" ||
    typeof value.inputFingerprint !== "string" ||
    typeof value.templateVersion !== "string" ||
    typeof value.thresholdsVersion !== "string" ||
    (value.mode !== "shadow" && value.mode !== "enabled") ||
    !isRecord(value.assessment)
  ) {
    return undefined;
  }
  return {
    version: 1,
    promptFingerprint: value.promptFingerprint,
    inputFingerprint: value.inputFingerprint,
    templateVersion: value.templateVersion,
    thresholdsVersion: value.thresholdsVersion,
    mode: value.mode,
    assessment: value.assessment,
    evidenceContract: isRecord(value.evidenceContract) ? value.evidenceContract : null,
  };
}

export function appendShadowComparisonV1(
  ledger: DecisionLedgerV1,
  comparison: unknown,
): DecisionLedgerV1 {
  return {
    ...ledger,
    shadowComparisons: [...(ledger.shadowComparisons ?? []), comparison].slice(
      -MAX_SHADOW_COMPARISONS,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
