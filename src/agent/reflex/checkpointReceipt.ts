import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";
import { canonicalJson } from "../../../packages/headless-runtime/src/canonicalize";
import type {
  ReflexCheckpointKind,
  ReflexCheckpointReceiptV1,
  ReflexDecisionV2,
  ReflexReadinessSummaryV1,
  ReflexRecoveryOutcomeV1,
} from "./types";

const REDACTED_DIAGNOSTIC_CODE = "redacted";
const MAX_DIAGNOSTIC_CODES = 32;
const STABLE_ACTION_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const STABLE_DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const SHA256_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function buildReflexCheckpointReceiptV1(input: {
  runId: string;
  checkpoint: ReflexCheckpointKind;
  decision: ReflexDecisionV2;
  actionCount: number;
  evidenceCount: number;
  receiptCount: number;
  readinessSummary?: Partial<ReflexReadinessSummaryV1>;
  progressScore?: number;
  loopRiskScore?: number;
  completionMissing?: readonly string[];
  proofDebt?: readonly string[];
  recoveryOutcome?: ReflexRecoveryOutcomeV1;
  frontierFingerprint?: string | null;
  observedAt?: string;
}): ReflexCheckpointReceiptV1 {
  const core = {
    version: 1 as const,
    runId: input.runId,
    checkpoint: input.checkpoint,
    label: input.decision.label,
    confidence: normalizeScore(input.decision.confidence),
    confidenceBand: input.decision.confidenceBand,
    winningMargin: normalizeScore(input.decision.winningMargin),
    reasonCode: input.decision.reasonCode,
    applied: input.decision.applied,
    suggestedAction: normalizeStableAction(input.decision.suggestedAction),
    allowedAction: normalizeStableAction(input.decision.allowedAction),
    actionCount: normalizeCount(input.actionCount),
    evidenceCount: normalizeCount(input.evidenceCount),
    receiptCount: normalizeCount(input.receiptCount),
    readinessSummary: normalizeReadinessSummary(input.readinessSummary),
    progressScore: normalizeScore(input.progressScore),
    loopRiskScore: normalizeScore(input.loopRiskScore),
    completionMissing: normalizeDiagnosticCodes(input.completionMissing),
    proofDebt: normalizeDiagnosticCodes(input.proofDebt),
    recoveryOutcome: input.recoveryOutcome ?? "not_applicable",
    frontierFingerprint:
      typeof input.frontierFingerprint === "string" &&
      SHA256_FINGERPRINT_PATTERN.test(input.frontierFingerprint)
        ? input.frontierFingerprint
        : null,
  };
  return {
    ...core,
    observedAt: input.observedAt ?? new Date().toISOString(),
    fingerprint: `sha256:${portableSha256Text(canonicalJson(core))}`,
  };
}

function normalizeCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function normalizeScore(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value ?? 0)) * 1_000_000) / 1_000_000;
}

function normalizeStableAction(value: string | null | undefined): string | null {
  return typeof value === "string" && STABLE_ACTION_PATTERN.test(value)
    ? value
    : null;
}

function normalizeReadinessSummary(
  value: Partial<ReflexReadinessSummaryV1> | undefined,
): ReflexReadinessSummaryV1 {
  const ok = normalizeCount(value?.ok);
  const degraded = normalizeCount(value?.degraded);
  const blocked = normalizeCount(value?.blocked);
  const unknown = normalizeCount(value?.unknown);
  return {
    total: ok + degraded + blocked + unknown,
    ok,
    degraded,
    blocked,
    unknown,
  };
}

function normalizeDiagnosticCodes(values: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const candidate = value.trim();
    normalized.add(
      STABLE_DIAGNOSTIC_CODE_PATTERN.test(candidate)
        ? candidate
        : REDACTED_DIAGNOSTIC_CODE,
    );
    if (normalized.size >= MAX_DIAGNOSTIC_CODES) break;
  }
  return [...normalized].sort();
}
