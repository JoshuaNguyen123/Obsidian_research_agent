export interface ReliabilityGate {
  readonly id: "recovery" | "acceptable90" | "target95";
  readonly kind: "consecutive" | "fixed-attempts";
  readonly validAttemptsPerLane?: number;
  readonly minimumGreensPerLane?: number;
  readonly minimumGreensOverall?: number;
  readonly infrastructureLaunchRateMaxExclusive: number;
  readonly requireToolEventCoverage?: boolean;
  readonly rejectAnyProductFailure?: boolean;
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

export const RELIABILITY_GATES: Readonly<
  Record<"recovery" | "acceptable90" | "target95", ReliabilityGate>
>;

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
