export interface BenchmarkOptions {
  models: string[];
  cellIds: string[];
  attemptsPerCell: number;
  dryRun: boolean;
  help: boolean;
}

export interface BenchmarkAcceptance {
  acceptanceStatus?: string;
  scorecardAcceptancePassed?: boolean | null;
  scorecardTotal?: number | null;
}

export const DEFAULT_BENCHMARK_CELL_IDS: readonly string[];
export const DEFAULT_BENCHMARK_MODELS: readonly string[];
export const BENCHMARK_EVIDENCE_MISSING_FAILURE_CLASS: string;
export const BENCHMARK_PROOF_POLICY_SCORECARD: "scorecard";
export const BENCHMARK_PROOF_POLICY_CONTRACT: "contract";

export function assertBenchmarkExactCleanHead(
  expectedHead: string,
  readGit?: (args: string[]) => string,
  stage?: string,
): void;
export function parseBenchmarkOptions(argv?: string[]): BenchmarkOptions;
export function resolveBenchmarkProofPolicy(project: string): "scorecard" | "contract";
export function hasFreshPassingProjectSummary(
  summary: unknown,
  summaryFresh: boolean,
  project: string,
): boolean;
export function createBenchmarkPlan(options: BenchmarkOptions): Array<{
  model: string;
  cell: {
    id: string;
    project: string;
    grep: string | null;
    requiredGreens: number;
    maxAttempts: number;
  };
  attempt: number;
}>;
export function hasAcceptedBenchmarkEvidence(input: {
  exitCode: number;
  summaryFresh: boolean;
  acceptance: BenchmarkAcceptance;
  proofPolicy?: "scorecard" | "contract";
  contractEvidencePassed?: boolean;
}): boolean;
export function describeMissingBenchmarkEvidence(input: {
  summaryFresh: boolean;
  acceptance: BenchmarkAcceptance;
  proofPolicy?: "scorecard" | "contract";
  contractEvidencePassed?: boolean;
}): string;
export function runModelTierBenchmark(argv?: string[]): {
  planned: number;
  launched: number;
  recorded: number;
  help: boolean;
};
