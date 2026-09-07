import type { ReliabilityGate } from "./reliability-campaign.d.mts";

export const QUALIFICATION_POLICY_VERSION: "mission-success/v1";
/** The only capture state that can support a delivered verdict. */
export const QUALIFYING_EVIDENCE_COVERAGE: "complete";

export type QualificationOutcome =
  | "delivered"
  | "not_delivered"
  | "not_launched"
  | "measurement_invalid"
  | "unresolved";

export const QUALIFICATION_OUTCOMES: Readonly<{
  DELIVERED: "delivered";
  NOT_DELIVERED: "not_delivered";
  NOT_LAUNCHED: "not_launched";
  MEASUREMENT_INVALID: "measurement_invalid";
  UNRESOLVED: "unresolved";
}>;

export interface QualificationWorkflowCell {
  readonly id: string;
  readonly project: string;
  readonly scenarioId?: string | null;
}

export interface QualificationOccurrence {
  readonly occurrenceId: string;
  readonly workflow: string;
  readonly project: string;
  readonly scenarioId: string | null;
  readonly ordinal: number;
  readonly rotation: number;
  readonly sequence: number;
}

export interface QualificationCohort {
  readonly policyVersion: string;
  readonly gate: string;
  readonly seed: string;
  readonly cohortSize: number;
  readonly maximumFailures: number;
  readonly workflowMix: Record<string, number>;
  readonly occurrences: QualificationOccurrence[];
}

export interface QualificationDeclaration extends QualificationCohort {
  /** Stable id for this cohort under this build and model; every record names it. */
  readonly cohortId: string;
  readonly evidenceContractVersion: string;
  readonly model: string;
  readonly headSha: string;
  readonly artifactHashes: Record<string, string | null>;
  readonly deadlineSecondsPerOccurrence: number;
  readonly frozenAt: string;
  readonly confidenceLevel: number;
}

export interface QualificationRecord {
  readonly occurrenceId: string;
  readonly cohortId?: string | null;
  /** Self-reported deadline; a value other than the frozen one is drift. */
  readonly deadlineS?: number | null;
  readonly workflow?: string | null;
  readonly model?: string | null;
  readonly headSha?: string | null;
  readonly launched?: boolean;
  readonly green?: boolean | null;
  readonly failureClass?: string | null;
  readonly durationS?: number | null;
  readonly budgetStopped?: boolean;
  readonly safetyViolations?: readonly string[];
  readonly toolEvents?: {
    readonly source?: string | null;
    /** ToolCallOutcomeCountsV1.coverage; only "complete" can qualify. */
    readonly coverage?: "complete" | "lossy" | "unobserved" | null;
    readonly observed?: number | null;
    readonly failed?: number | null;
  } | null;
  readonly acceptance?: {
    readonly missionOutcome?: string | null;
    readonly acceptanceStatus?: string | null;
    readonly scorecardAcceptancePassed?: boolean | null;
    readonly scorecardTotal?: number | null;
    readonly artifactProofCount?: number | null;
    /** Path + content hash (or receipt readback identity) of the delivered artifact. */
    readonly artifactIdentity?: string | null;
  } | null;
}

export interface QualificationVerdict {
  readonly outcome: QualificationOutcome;
  readonly reasons: string[];
  readonly contradictions: string[];
}

export interface QualificationEvaluation {
  policyVersion: string;
  gate: string;
  seed: string | null;
  cohortId: string | null;
  evidenceContractVersion: string | null;
  /** Always reported, so 300 deliveries against 1 artifact is visible. */
  distinctArtifactIdentities: number;
  /** Identical bytes from the same workflow: expected of deterministic tasks. */
  repeatedArtifactIdentities: number;
  /** Identical bytes across different workflows: never honest; fails the cohort. */
  crossWorkflowArtifactIdentities: number;
  missingArtifactIdentities: number;
  readOnlyDeliveries: number;
  deliveredWithArtifactIdentity: number;
  model: string | null;
  headSha: string | null;
  artifactHashes: Record<string, string | null> | null;
  /** Conjunction of `failures.length === 0` AND `positiveProof`. */
  passed: boolean;
  /** Affirmative proof that the cohort was complete and actually delivered. */
  positiveProof: boolean;
  incomplete: boolean;
  failures: string[];
  /** Always the predeclared cohort size. It never shrinks to what was observed. */
  denominator: number;
  counts: {
    declared: number;
    terminalRecords: number;
    delivered: number;
    notDelivered: number;
    notLaunched: number;
    measurementInvalid: number;
    unresolved: number;
  };
  observedSuccessRate: number | null;
  lowerBound: number | null;
  confidenceLevel: number;
  confidenceMethod: string;
  contradictions: Array<{ occurrenceId: string | null; contradiction: string }>;
  safetyViolations: Array<{ occurrenceId: string; violation: string }>;
  unmeasuredSafety: string[];
  missingOccurrences: Array<string | undefined>;
  foreignRecords: string[];
  duplicateOccurrences: string[];
  perWorkflow: Array<{ workflow: string; declared: number; delivered: number; recorded: number }>;
  outcomes: Array<{
    occurrenceId: string | null;
    workflow: string | null;
    outcome: QualificationOutcome;
    reasons: string[];
  }>;
}

export function failureTail(trials: number, failures: number, p: number): number;
/** null — never 0 — when the inputs cannot support an estimate. */
export function lowerSuccessBound(
  trials: number,
  failures: number,
  alpha?: number,
): number | null;

export function formatOccurrenceId(seed: string, workflow: string, ordinal: number): string;

export function buildQualificationCohort(input: {
  gate: ReliabilityGate;
  cells: readonly QualificationWorkflowCell[];
  seed: string;
}): QualificationCohort;

export function freezeQualificationDeclaration(input: {
  cohort: QualificationCohort;
  model: string;
  headSha: string;
  artifactHashes: Record<string, string | null>;
  deadlineSecondsPerOccurrence: number;
  frozenAt?: string;
  evidenceContractVersion?: string;
}): QualificationDeclaration;

/** Recomputed by the evaluator; a mismatch means the declaration was edited. */
export function qualificationCohortId(
  declaration: Partial<QualificationDeclaration> | null | undefined,
): string;

export function classifyQualificationRecord(
  record: QualificationRecord | null | undefined,
  options?: { deadlineSecondsPerOccurrence?: number },
): QualificationVerdict;

export function evaluateQualificationCohort(input: {
  gate: ReliabilityGate;
  cells: readonly QualificationWorkflowCell[];
  declaration: QualificationDeclaration | null | undefined;
  records: readonly QualificationRecord[] | null | undefined;
}): QualificationEvaluation;

export function occurrenceHasTerminalRecord(
  manifest: { attempts?: readonly unknown[] } | null | undefined,
  occurrenceId: string,
  measuresProduct: (
    attempt: { green?: boolean; failureClass?: string | null } | null | undefined,
  ) => boolean,
): boolean;

/** Only `occurrences` is read, so a bare cohort is accepted alongside a declaration. */
export function deriveQualificationRecords(
  manifest: { attempts?: readonly unknown[]; model?: string; expectedHead?: string } | null | undefined,
  declaration: { occurrences?: readonly QualificationOccurrence[] } | null | undefined,
): { records: QualificationRecord[]; measurementRetries: Record<string, number> };
