import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import {
  DAILY_USE_ACCEPTANCE_V1,
  evaluateDailyUseAcceptanceV1,
  type DailyUseObservedAcceptanceV1,
  type DailyUseScenarioId,
} from "./dailyUseAcceptance";

export interface DailyUseRunMetricsV1 {
  version: 1;
  scenarioId: DailyUseScenarioId;
  releaseSha: string | null;
  modelCalls: number;
  toolCalls: number;
  continuations: number;
  approvals: number;
  artifactProofCount: number;
  cleanupProofCount: number;
  missingAcceptanceCriteria: string[];
  acceptanceStatus: "pass" | "needs_more_work";
  observedAt: string;
  fingerprint: string;
}

export function createDailyUseRunMetricsV1(input: {
  scenarioId: DailyUseScenarioId;
  releaseSha?: string | null;
  observed: DailyUseObservedAcceptanceV1;
  modelCalls?: number;
  toolCalls?: number;
  continuations?: number;
  approvals?: number;
  observedAt: string;
}): DailyUseRunMetricsV1 {
  const observedAt = canonicalTimestamp(input.observedAt);
  const acceptance = evaluateDailyUseAcceptanceV1(
    DAILY_USE_ACCEPTANCE_V1[input.scenarioId],
    normalizeObserved(input.observed),
  );
  const unsigned: Omit<DailyUseRunMetricsV1, "fingerprint"> = {
    version: 1,
    scenarioId: input.scenarioId,
    releaseSha: releaseSha(input.releaseSha),
    modelCalls: counter(input.modelCalls),
    toolCalls: counter(input.toolCalls),
    continuations: counter(input.continuations),
    approvals: counter(input.approvals),
    artifactProofCount: new Set(input.observed.artifacts).size,
    cleanupProofCount: new Set(input.observed.cleanup).size,
    missingAcceptanceCriteria: [...acceptance.missing].sort(),
    acceptanceStatus: acceptance.status,
    observedAt,
  };
  return {
    ...unsigned,
    fingerprint: fingerprintDailyUseRunMetricsV1(unsigned),
  };
}

export function fingerprintDailyUseRunMetricsV1(
  input:
    | DailyUseRunMetricsV1
    | Omit<DailyUseRunMetricsV1, "fingerprint">,
): string {
  const {
    fingerprint: _fingerprint,
    observedAt: _observedAt,
    ...stable
  } = input as DailyUseRunMetricsV1;
  return `sha256:${portableSha256Text(canonicalJson(stable))}`;
}

function normalizeObserved(
  value: DailyUseObservedAcceptanceV1,
): DailyUseObservedAcceptanceV1 {
  return {
    artifacts: unique(value.artifacts),
    proofs: unique(value.proofs),
    approvals: unique(value.approvals),
    bindings: unique(value.bindings),
    cleanup: unique(value.cleanup),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value))]
    .sort();
}

function counter(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : 0;
}

function releaseSha(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new TypeError("Daily-use release SHA must be an exact 40-character Git SHA.");
  }
  return normalized;
}

function canonicalTimestamp(value: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError("Daily-use observedAt must be a canonical ISO timestamp.");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Daily-use metrics contain an invalid number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new TypeError("Daily-use metrics contain an unsupported value.");
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
