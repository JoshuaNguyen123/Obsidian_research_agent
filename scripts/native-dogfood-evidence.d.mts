export const NATIVE_DOGFOOD_STAGES: readonly string[];
export interface NativeDogfoodEvidenceV1 {
  version: 1;
  stage: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  observedAt: string;
  exactHead: string;
  bundleProof: string;
  windowTitle: string;
  prompt: string;
  visibleOutcome: string;
  runId: string | null;
  runDetailsStatus: string | null;
  scorecard: unknown;
  receipts: string[];
  artifacts: string[];
  cleanupResults: string[];
  approvalBoundary: {
    status: "not_reached" | "paused" | "approved" | "not_required";
    action?: string;
  };
}
export function validateNativeDogfoodEvidence(value: unknown): NativeDogfoodEvidenceV1;
export function appendNativeDogfoodEvidence(
  filePath: string,
  value: unknown,
): NativeDogfoodEvidenceV1;
