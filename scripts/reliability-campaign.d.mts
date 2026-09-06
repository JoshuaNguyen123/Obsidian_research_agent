export type ReliabilityGateId =
  | "recovery"
  | "acceptable90"
  | "target95"
  | "qualification99"
  | "qualification999";

export interface ReliabilityGate {
  readonly id: ReliabilityGateId;
  readonly kind: "consecutive" | "fixed-attempts" | "predeclared-cohort";
  readonly validAttemptsPerLane?: number;
  readonly minimumGreensPerLane?: number;
  readonly minimumGreensOverall?: number;
  readonly infrastructureLaunchRateMaxExclusive: number;
  readonly requireToolEventCoverage?: boolean;
  readonly rejectAnyProductFailure?: boolean;
  /** predeclared-cohort only. */
  readonly policyVersion?: string;
  readonly cohortSize?: number;
  readonly maximumFailures?: number;
  readonly workflows?: number;
  readonly occurrencesPerWorkflow?: number;
  readonly confidenceLevel?: number;
  readonly requiredLowerBound?: number;
  readonly requiredObservedSuccessRate?: number;
  readonly requireArtifactProof?: boolean;
}

export interface ReliabilityAttempt {
  readonly cell: string;
  readonly green: boolean;
  readonly failureClass: string;
  readonly toolEvents?: {
    readonly source: string;
    readonly observed: number | null;
    readonly failed: number | null;
  };
}

export const RELIABILITY_GATES: Readonly<Record<ReliabilityGateId, ReliabilityGate>>;

export function resolveReliabilityGate(value?: string): ReliabilityGate;
export function isValidApplicationAttempt(attempt: ReliabilityAttempt): boolean;
export function evaluateReliabilityCampaign(input: {
  gate: ReliabilityGate;
  cells: ReadonlyArray<{ readonly id: string }>;
  attempts: ReadonlyArray<ReliabilityAttempt>;
}): {
  gate: string;
  passed: boolean;
  failures: string[];
  lanes: Array<{
    cell: string;
    validAttempts: number;
    greens: number;
    rate: number | null;
  }>;
  launches: number;
  infrastructureFailures: number;
  infrastructureRate: number;
  validAttempts: number;
  greens: number;
  observedSuccessRate: number | null;
  observedPerfectCampaign: boolean;
};
