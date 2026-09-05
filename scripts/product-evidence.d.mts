/** A run row as the pass-rate arithmetic sees it: outcome text + class. */
export interface ProductEvidenceRow {
  outcome?: string;
  failureClass?: string | null;
  [key: string]: unknown;
}
export interface RunRowSummary {
  rows: number;
  scored: number;
  green: number;
  red: number;
  infrastructure: number;
  unresolved: number;
  semanticsVersion: number;
  /** null — never 0 — when no row carried product evidence. */
  passRate: number | null;
}
export const NO_FAILURE_CLASS: "none";
export const EVIDENCE_SEMANTICS_VERSION: number;
export const UNRESOLVED_FAILURE_CLASS: string;
export function isUnresolvedFailureClass(value: unknown): boolean;
export function optionalCount(value: unknown): number | null;
export function summarizeToolCounts(rows: Array<{ toolEvents: number | null; toolFailed: number | null }>): { observed: number; failed: number; coveredRows: number; totalRows: number };
export const ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS: "environment_not_configured";
export const INFRASTRUCTURE_FAILURE_CLASS_PREFIXES: readonly string[];
export const INFRASTRUCTURE_FAILURE_CLASS_PATTERN: RegExp;
export const GREEN_OUTCOME_PATTERN: RegExp;
export function isInfrastructureFailureClass(
  failureClass: string | null | undefined,
): boolean;
export function measuresProduct(
  subject: { green?: boolean; failureClass?: string | null } | null | undefined,
): boolean;
export function normalizeFailureClass(value: string | null | undefined): string;
export function toRunRow(
  record: Record<string, string | undefined> | null | undefined,
): { outcome: string; failureClass: string };
export function runRowRecordedNoFailure(row: ProductEvidenceRow | null | undefined): boolean;
export function runRowIsGreen(row: ProductEvidenceRow | null | undefined): boolean;
export function runRowMeasuresProduct(row: ProductEvidenceRow | null | undefined): boolean;
export function runRowIsInfrastructure(row: ProductEvidenceRow | null | undefined): boolean;
export function partitionRunRows<T extends ProductEvidenceRow>(
  rows: readonly T[] | null | undefined,
): { scored: T[]; infrastructure: T[]; unresolved: T[] };
export function summarizeRunRows(
  rows: readonly ProductEvidenceRow[] | null | undefined,
): RunRowSummary;
export function formatRate(part: number, whole: number): string;
export function describeExcludedInfrastructure(count: number, total: number): string;
export function parseCsv(text: string): string[][];
export function csvRecords(text: string): Array<Record<string, string | undefined>>;
export function pythonProductEvidenceSource(): string[];
