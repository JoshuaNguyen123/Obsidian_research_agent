import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";
import { canonicalJson } from "../../../packages/headless-runtime/src/canonicalize";
import type {
  ReflexCheckpointKind,
  ReflexCheckpointReceiptV1,
  ReflexDecisionV2,
} from "./types";

export function buildReflexCheckpointReceiptV1(input: {
  runId: string;
  checkpoint: ReflexCheckpointKind;
  decision: ReflexDecisionV2;
  actionCount: number;
  evidenceCount: number;
  receiptCount: number;
  frontierFingerprint?: string | null;
  observedAt?: string;
}): ReflexCheckpointReceiptV1 {
  const core = {
    version: 1 as const,
    runId: input.runId,
    checkpoint: input.checkpoint,
    label: input.decision.label,
    confidenceBand: input.decision.confidenceBand,
    reasonCode: input.decision.reasonCode,
    applied: input.decision.applied,
    actionCount: Math.max(0, Math.trunc(input.actionCount)),
    evidenceCount: Math.max(0, Math.trunc(input.evidenceCount)),
    receiptCount: Math.max(0, Math.trunc(input.receiptCount)),
    frontierFingerprint: input.frontierFingerprint ?? null,
  };
  return {
    ...core,
    observedAt: input.observedAt ?? new Date().toISOString(),
    fingerprint: `sha256:${portableSha256Text(canonicalJson(core))}`,
  };
}
