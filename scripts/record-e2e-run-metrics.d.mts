export interface ExclusiveRunMetricInput {
  startedAt: number;
  endedAt: number;
  projects: string[];
  model: string;
  head: string;
  dirty: boolean;
  exitCode: number;
  summary: unknown;
  summaryFresh: boolean;
  logText?: string;
}

export function buildExclusiveRunMetricRow(
  input: ExclusiveRunMetricInput,
): Array<string | number | boolean>;

export function selectedProjectExecuted(
  report: unknown,
  selectedProjects: string[],
): boolean;

export function recordExclusiveRunMetricsIfExecuted(input: {
  repoRoot: string;
  reportPath: string;
  summaryPath: string;
  reportMtimeBefore: number | null;
  summaryMtimeBefore: number | null;
  projects: string[];
  model: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  metricsOwner?: string;
}):
  | { recorded: false; reason: string }
  | { recorded: true; row: Array<string | number | boolean> };
