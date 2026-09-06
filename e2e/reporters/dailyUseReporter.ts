import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import {
  classifyDailyUseFailure,
  extractScenarioId,
  type DailyUseFailureCategory,
  type DailyUseTaskFamily,
} from "../fixtures/dailyUseFailureClassification";
import {
  DAILY_USE_ACCEPTANCE_V1,
  type DailyUseObservedAcceptanceV1,
  type DailyUseScenarioId,
} from "../../src/agent/dailyUseAcceptance";
import {
  createDailyUseRunMetricsV1,
  type DailyUseRunMetricsV1,
} from "../../src/agent/dailyUseRunMetrics";
import {
  MISSION_SCORE_WEIGHTS,
  type MissionScorecardV1,
} from "../../src/agent/missionScorecard";
import {
  DAILY_USE_METRICS_ANNOTATION,
  DAILY_USE_OBSERVED_ANNOTATION,
  DAILY_USE_SCORECARD_ANNOTATION,
  DAILY_USE_TOOL_OUTCOMES_ANNOTATION,
  E2E_PROOF_CLASS_ANNOTATION,
  type E2EProofClassV1,
} from "../fixtures/dailyUseAcceptance";
// Type-only: erased at compile time, so the fold's runtime import FROM this
// module (classifyToolReceiptWork, TOOL_REFUSAL_MARKER_BUCKETS) never forms a
// cycle.
import type { ToolCallOutcomeCountsV1 } from "../fixtures/toolCallOutcomes";

export interface DailyUseRunRecord extends Pick<
  DailyUseRunMetricsV1,
  | "modelCalls"
  | "continuations"
  | "approvals"
  | "approvalBoundaryProofCount"
  | "artifactProofCount"
  | "cleanupProofCount"
  | "missingAcceptanceCriteria"
  | "acceptanceStatus"
  | "fingerprint"
> {
  version: 1;
  scenarioId: DailyUseScenarioId | null;
  taskFamily: DailyUseTaskFamily;
  project: string;
  file: string;
  title: string;
  status: string;
  durationMs: number;
  retry: number;
  failureCategory: DailyUseFailureCategory | null;
  observed: DailyUseObservedAcceptanceV1 | null;
  missionScorecard: MissionScorecardV1 | null;
  proofClass: E2EProofClassV1 | null;
  /** Explicit alias for the legacy `approvals` interaction counter. */
  interactiveApprovals: number;
  /**
   * The DU-acceptance tool-call counter — the quantity the record FINGERPRINT
   * was computed over, so its meaning is frozen: whatever the spec annotated
   * (some mission specs feed `missionEvidence.length`, an evidence count that
   * sees successes only). Null — never 0 — when the spec annotated nothing:
   * unlabelled targeted lanes can still exist, and the previous
   * `metrics?.toolCalls ?? 0` here manufactured the explicit observed=0 rows in
   * docs/eval/playwright-run-metrics.csv for lanes that certainly called tools.
   * The real per-call count lives in `toolCallsAttempted`; the two legitimately
   * disagree and must never be "fixed" into agreement.
   */
  toolCalls: number | null;
  /**
   * Full folded outcome counts from the shared collector seam, for provenance
   * (coverage, undetermined, atLeast bounds). Null when the test carried no
   * outcomes annotation.
   */
  toolCallOutcomes: ToolCallOutcomeCountsV1 | null;
  /**
   * ATTEMPTED tool calls for this record, or null when UNKNOWN. This is the
   * denominator the success rate always lacked: `toolCalls` above is fed
   * from `missionEvidence.length` / `usage.toolCalls`, and
   * `evidenceFromToolResult` (src/agent/missionEvidence.ts:43) yields
   * nothing for `!result.ok`, so failed calls never reached that counter and
   * the attempt itself went uncounted. A spec supplies this by folding the
   * mission event stream through e2e/fixtures/toolCallOutcomes.ts. Null —
   * never 0 — when no spec counted.
   */
  toolCallsAttempted: number | null;
  /**
   * Failed-tool-call count for this record, or null when UNKNOWN. The
   * counters the specs feed today (missionEvidence lengths, usage.toolCalls)
   * do not distinguish failed tool events — missionEvidence records
   * successful calls only — so this stays null unless the spec passed an
   * explicit `toolCallsFailed` counter through recordDailyUseAcceptance.
   * Unknown is never collapsed to zero.
   */
  toolCallsFailed: number | null;
  /**
   * "Tool called but did no work" count, or null when UNKNOWN. Covered
   * signal: a mutation receipt that EXPLICITLY reports zero delta
   * (bytesWritten/bytesDeleted/affectedCount all present-and-zero) — see
   * isVacuousToolReceipt. Not detectable from reporter-visible data (and
   * therefore never guessed): a success payload that is empty where the tool
   * contract promises content, and a mutation completing with no receipt at
   * all where receipts are mandatory. Those need product-side receipt
   * enrichment. Null unless the spec passed an explicit counter.
   */
  toolCallsVacuous: number | null;
  /**
   * Intentional no-ops (commitKind no_op/reconciled on enriched receipts):
   * correct idempotent behavior, counted SEPARATELY from vacuous so
   * eliminating unintended no-work successes never penalizes replays.
   * Null when unknown.
   */
  toolCallsIntentionalNoOp: number | null;
  /**
   * Calls that started and never produced a terminal event, or null when
   * UNKNOWN. Kept EXPLICIT rather than folded into either side: an interrupted
   * run genuinely does not know how those calls ended, and a consumer that
   * computes `succeeded = attempted - failed` would silently score every one of
   * them as a success. Invariant when all four are known:
   * succeeded + failed + undetermined === attempted.
   */
  toolCallsUndetermined: number | null;
  /**
   * Provider-reported prompt+completion tokens for the run, or null when the
   * lane did not annotate usage. Unknown ≠ zero, as everywhere in this file.
   */
  reportedTokens: number | null;
  /** Provider-reported cached prompt tokens, or null when never reported. */
  cachedPromptTokens: number | null;
  /** Mean per-step prompt-prefix reuse ratio (0..1), or null when unmeasured. */
  promptPrefixReuseAvg: number | null;
  /**
   * Refusal-marker sightings, keyed by the same six bucket names the proof
   * matrix's graph mining uses. Provenance is explicit in
   * `refusalBucketsSource`: "annotation" means the spec counted them from
   * traces it observed; "outcomes" means a COMPLETE fold from the shared
   * collector counted every refusal live (so its zeros are explicit);
   * "error_messages" means they were mined from this record's Playwright error
   * text (sightings, NOT per-event counts — a retried refusal that never
   * failed the test is invisible here); null means there was nothing to mine
   * (no annotation, no fold, no errors), which is unknown, not zero.
   */
  refusalBuckets: Record<string, number> | null;
  refusalBucketsSource: "annotation" | "outcomes" | "error_messages" | null;
}

/**
 * Refusal-marker vocabulary shared with the proof matrix's BLOCKER_BUCKETS
 * (scripts/run-proof-matrix.mjs): the same seven bucket keys, so
 * summary-sourced and graph-mined rows in
 * docs/eval/playwright-run-metrics.csv stay comparable. Entries are regex
 * SOURCES so counting can always build a fresh global regex (no lastIndex
 * state).
 *
 * Two of these are HOST-caused refusals split out of `tool_not_allowed`,
 * whose meaning is the opposite -- "the model named a tool it was never
 * offered":
 *   frontier_narrowed_mid_response    the tool was on the menu the model
 *                                     answered, and AgentRunner rebuilt the
 *                                     menu after an earlier call in the SAME
 *                                     response;
 *   frontier_withheld_since_earlier_step
 *                                     the tool was offered in an EARLIER step
 *                                     of the run and withheld since (proof-gate
 *                                     containment, phase ceiling, graph
 *                                     advance), so the model was pursuing a
 *                                     name it had been taught.
 * Buckets stay disjoint: neither code carries a `tool_not_allowed` substring
 * nor each other's, and the rejection text they produce never uses that
 * phrase either.
 */
export const TOOL_REFUSAL_MARKER_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ["tool_not_allowed", "tool_not_allowed"],
  ["frontier_narrowed_mid_response", "frontier_narrowed_mid_response"],
  ["frontier_withheld_since_earlier_step", "frontier_withheld_since_earlier_step"],
  ["mission_graph_authority_blocked", "mission_graph_authority_blocked"],
  ["invalid_arguments", "invalid_argument"],
  ["execution_failed", "execution_failed"],
  ["authority_grant_invalid", "authority_grant_invalid"],
  ["tool_failure_terminal", "tool_failure_(?:terminal|repeated)"],
];

/** Marker SIGHTINGS in error text; only nonzero buckets are emitted. */
export function countRefusalMarkers(
  errorMessages: readonly string[],
): Record<string, number> {
  const text = errorMessages.join("\n");
  const buckets: Record<string, number> = {};
  for (const [key, source] of TOOL_REFUSAL_MARKER_BUCKETS) {
    const count = [...text.matchAll(new RegExp(source, "giu"))].length;
    if (count > 0) buckets[key] = count;
  }
  return buckets;
}

/**
 * Bucket provenance resolution, strongest source first: an annotation the spec
 * counted from live traces always wins; then a COMPLETE fold from the shared
 * collector, which saw every refusal on the event stream (its zeros are
 * explicit, unlike mined sightings); then markers mined from the record's
 * error text. With none of the three, the answer is null (unknown), never {}.
 */
export function resolveRefusalBuckets(
  annotated: Record<string, number> | null,
  errorMessages: readonly string[],
  foldedBuckets: Record<string, number> | null = null,
): {
  buckets: Record<string, number> | null;
  source: "annotation" | "outcomes" | "error_messages" | null;
} {
  if (annotated) return { buckets: annotated, source: "annotation" };
  if (foldedBuckets) return { buckets: foldedBuckets, source: "outcomes" };
  if (errorMessages.some((message) => message.length > 0)) {
    return { buckets: countRefusalMarkers(errorMessages), source: "error_messages" };
  }
  return { buckets: null, source: null };
}

/**
 * Receipt shape subset shared with src/agent/missionEvidence's
 * MissionReceiptLike, plus the enriched fields the receipt-delta-integrity
 * wave adds (effects.changed, commitKind, readback.priorRevision).
 */
export interface VacuousDetectableReceipt {
  operation?: unknown;
  bytesWritten?: unknown;
  bytesDeleted?: unknown;
  affectedCount?: unknown;
  commitKind?: unknown;
  effects?: unknown;
  /**
   * What the action was FOR. Verification purposes (`validation_fast`,
   * `validation_targeted`, `validation_full`) produce a verdict, not a delta.
   * See classifyToolReceiptWork.
   */
  purpose?: unknown;
  /** Verification proof carried by the receipt itself. */
  readback?: unknown;
  /** Present on real receipts; carried so fixtures can mirror the real shape. */
  toolName?: unknown;
  /** Present on sandbox-backed receipts; 0 means the command really ran and passed. */
  exitCode?: unknown;
}

/**
 * Purposes whose entire work product is a VERDICT rather than a mutation.
 *
 * Measured on 2026-08-26: every compound run reported exactly 3 vacuous tool
 * calls, and all three were the validation tools — `code_validate_fast`,
 * `code_validate_targeted`, `code_validate_full`. Their receipts carry
 * `commitKind: "committed"`, `readback.status: "verified"`, `exitCode: 0`, real
 * stdout bytes and a real duration — the sandbox command genuinely ran and
 * passed — alongside `affectedCount: 0`, because validating a workspace
 * changes nothing. That is correct behaviour, and scoring it as an
 * empty-contract success was the instrument's error, not the product's.
 *
 * The distinction that matters: vacuous means "a tool that was supposed to
 * change something reported success without changing it". A tool that never
 * claimed to change anything cannot be vacuously unchanged.
 */
const VERDICT_ONLY_RECEIPT_PURPOSES = Object.freeze(
  new Set(["validation_fast", "validation_targeted", "validation_full"]),
);

/**
 * Receipt `operation` values whose work product is a verdict.
 *
 * The first version of this exemption keyed on `purpose`, which lives on the
 * nested sandboxReceipt and is NOT a field of the receipt these counters see.
 * The exemption was therefore inert, and three runs after it landed still
 * reported vacuous=3 -- caught only by re-reading the measured CSV rather than
 * assuming the fix worked. The receipts carry `operation: "validate"` and a
 * verified `readback`, both of which are present and semantically exact.
 */
const VERDICT_ONLY_RECEIPT_OPERATIONS = Object.freeze(new Set(["validate"]));

/** True when the receipt carries its own proof the action really ran. */
function receiptReadbackVerified(receipt: VacuousDetectableReceipt): boolean {
  const readback = receipt.readback;
  return (
    !!readback &&
    typeof readback === "object" &&
    (readback as { status?: unknown }).status === "verified"
  );
}

export type ToolReceiptWorkClass =
  | "worked"
  | "vacuous"
  | "intentional_no_op"
  | "unknown";

/**
 * Classify what a success receipt says about the WORK behind it. The user's
 * target is UNINTENDED no-work successes (the empty-contract bug family), so
 * intentional no-ops are their own class, never lumped with vacuous:
 *
 * 1. commitKind "no_op"/"reconciled" (enriched receipts): the tool decided
 *    doing nothing was correct — idempotent replays are correct behavior.
 * 2. effects.changed === false (enriched receipts): completion with an
 *    explicit no-observable-change attestation -> vacuous;
 *    effects.changed === true -> worked.
 * 3. Legacy fallback: a receipt carrying at least one delta field
 *    (bytesWritten/bytesDeleted/affectedCount) is vacuous only when EVERY
 *    present delta is exactly zero; any nonzero delta is work.
 * 4. No usable signal (read-style receipts report no deltas): "unknown",
 *    never guessed.
 *
 * Signals still invisible from reporter-visible data (product-side receipt
 * enrichment needed): an empty success payload where the tool contract
 * promises content, and a mutation completing with NO receipt at all where
 * receipts are mandatory.
 */
export function classifyToolReceiptWork(
  receipt: VacuousDetectableReceipt | null | undefined,
): ToolReceiptWorkClass {
  if (!receipt || typeof receipt !== "object") return "unknown";
  if (receipt.commitKind === "no_op" || receipt.commitKind === "reconciled") {
    return "intentional_no_op";
  }
  // A verdict-only action (validation) did its work when its command ran and
  // passed; it has no delta to show because it was never asked to change
  // anything. Settled BEFORE the delta rules below, which would otherwise read
  // `affectedCount: 0` as an empty contract. `exitCode === 0` is required, so a
  // validation that did NOT actually run cannot claim this exemption — and a
  // FAILING validation is a failure, not a success receipt, so it never
  // reaches here.
  if (
    (typeof receipt.purpose === "string" &&
      VERDICT_ONLY_RECEIPT_PURPOSES.has(receipt.purpose) &&
      receipt.exitCode === 0) ||
    (typeof receipt.operation === "string" &&
      VERDICT_ONLY_RECEIPT_OPERATIONS.has(receipt.operation) &&
      receiptReadbackVerified(receipt))
  ) {
    return "worked";
  }
  const effects = receipt.effects;
  if (
    effects &&
    typeof effects === "object" &&
    typeof (effects as { changed?: unknown }).changed === "boolean"
  ) {
    return (effects as { changed: boolean }).changed ? "worked" : "vacuous";
  }
  const deltas = [receipt.bytesWritten, receipt.bytesDeleted, receipt.affectedCount]
    .filter((value) => value !== undefined && value !== null);
  if (deltas.length === 0) return "unknown";
  return deltas.every((value) => value === 0) ? "vacuous" : "worked";
}

/** True only for UNINTENDED no-work successes (see classifyToolReceiptWork). */
export function isVacuousToolReceipt(
  receipt: VacuousDetectableReceipt | null | undefined,
): boolean {
  return classifyToolReceiptWork(receipt) === "vacuous";
}

/** Count of vacuous successes among a run's receipts (see classifyToolReceiptWork). */
export function countVacuousToolReceipts(
  receipts: readonly (VacuousDetectableReceipt | null | undefined)[],
): number {
  return receipts.filter((receipt) => isVacuousToolReceipt(receipt)).length;
}

/** Count of intentional no-ops — correct behavior, tracked separately. */
export function countIntentionalNoOpReceipts(
  receipts: readonly (VacuousDetectableReceipt | null | undefined)[],
): number {
  return receipts.filter(
    (receipt) => classifyToolReceiptWork(receipt) === "intentional_no_op",
  ).length;
}

/**
 * Aggregate nullable counters without collapsing unknown into zero: null
 * only when EVERY input is null; otherwise the sum of the known values (an
 * explicit lower bound — per-record nulls remain visible in the records).
 */
export function sumNullableCounters(
  values: readonly (number | null)[],
): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

export interface DailyUseAtomicObservationRecord {
  status: string;
  retry: number;
  acceptanceStatus: DailyUseRunMetricsV1["acceptanceStatus"];
  missingAcceptanceCriteria: string[];
  observed: DailyUseObservedAcceptanceV1 | null;
  missionScorecard?: MissionScorecardV1 | null;
}

export default class DailyUseReporter implements Reporter {
  private readonly records: DailyUseRunRecord[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "unknown";
    const relativeFile = path
      .relative(process.cwd(), test.location.file)
      .replace(/\\/gu, "/");
    const errorMessages = result.errors.map((error) => error.message ?? "");
    const classification = classifyDailyUseFailure({
      title: test.title,
      file: relativeFile,
      project,
      errorMessages,
    });
    const scenarioId = classification.scenarioId ?? extractScenarioId(test.title);
    // Every test in every project is recorded. The previous filter kept only
    // DU-0X-titled tests, projects named *daily-use*, and failures — so a
    // passing `desktop-checkers-delivery-real-live` produced no summary file
    // at all. That silently disabled the scorecard gate and made the CI job
    // wired to `--lanes=desktop` fail on a passing run.
    const typedScenarioId = isDailyUseScenarioId(scenarioId)
      ? scenarioId
      : null;
    const observed = typedScenarioId
      ? parseObservedAnnotation(test)
      : null;
    const annotatedMetrics = typedScenarioId
      ? parseMetricsAnnotation(test, typedScenarioId)
      : null;
    const missionScorecard = typedScenarioId
      ? parseScorecardAnnotation(test)
      : null;
    const proofClass = parseProofClassAnnotation(test);
    // The evaluator is invoked for every DU-labelled test. Missing annotations
    // remain explicit proof debt rather than being converted into a pass.
    const metrics = typedScenarioId
      ? createDailyUseRunMetricsV1({
          scenarioId: typedScenarioId,
          releaseSha: exactReleaseSha(),
          observed: observed ?? emptyObserved(),
          modelCalls: annotatedMetrics?.modelCalls,
          toolCalls: annotatedMetrics?.toolCalls,
          continuations: annotatedMetrics?.continuations,
          approvals: annotatedMetrics?.approvals,
          observedAt: new Date().toISOString(),
        })
      : null;
    // Parsed UNCONDITIONALLY, unlike the metrics annotation: an unlabelled
    // targeted lane can still exist, and gating this the same way would
    // silently drop its only real tool-call counters.
    const outcomes = parseToolCallOutcomesAnnotation(test);
    // Only a COMPLETE fold speaks. A lossy or unobserved one is unknown, and
    // unknown must never be read as a number.
    const foldedComplete = outcomes?.coverage === "complete" ? outcomes : null;
    const refusal = resolveRefusalBuckets(
      annotatedMetrics?.refusalBuckets ?? null,
      errorMessages,
      foldedComplete?.failureBuckets ?? null,
    );
    const toolCallCounters = resolveToolCallCounters(annotatedMetrics, foldedComplete);
    this.records.push({
      version: 1,
      scenarioId: typedScenarioId,
      taskFamily: classification.taskFamily,
      project,
      file: relativeFile,
      title: test.title,
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
      failureCategory: result.status === "passed" ? null : classification.category,
      observed,
      missionScorecard,
      proofClass,
      ...toolCallCounters,
      toolCallOutcomes: outcomes,
      refusalBuckets: refusal.buckets,
      refusalBucketsSource: refusal.source,
      modelCalls: metrics?.modelCalls ?? 0,
      reportedTokens: annotatedMetrics?.reportedTokens ?? null,
      cachedPromptTokens: annotatedMetrics?.cachedPromptTokens ?? null,
      promptPrefixReuseAvg: annotatedMetrics?.promptPrefixReuseAvg ?? null,
      // Null — never 0 — when the spec annotated nothing. `metrics` is null for
      // every record without a typed DailyUseScenarioId, so the old `?? 0`
      // printed explicit observed=0 CSV rows for lanes that certainly called
      // tools. The fingerprinted quantity is unchanged; only its unknown
      // representation is.
      toolCalls: annotatedMetrics ? metrics?.toolCalls ?? null : null,
      continuations: metrics?.continuations ?? 0,
      approvals: metrics?.approvals ?? 0,
      interactiveApprovals: metrics?.approvals ?? 0,
      approvalBoundaryProofCount:
        metrics?.approvalBoundaryProofCount ?? 0,
      artifactProofCount: metrics?.artifactProofCount ?? 0,
      cleanupProofCount: metrics?.cleanupProofCount ?? 0,
      missingAcceptanceCriteria: metrics?.missingAcceptanceCriteria ?? [],
      acceptanceStatus: metrics?.acceptanceStatus ?? "needs_more_work",
      fingerprint:
        metrics?.fingerprint ?? `sha256:${"0".repeat(64)}`,
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    // Playwright --list and an accidental zero-test selection must not erase a
    // valid exact-SHA daily-use summary from the most recent real run.
    const outputDirectory = path.resolve(process.cwd(), "test-results");
    const payload = {
      version: 1,
      status: result.status,
      generatedAt: new Date().toISOString(),
      summaries: summarizeRecords(this.records),
      records: this.records,
    };
    await writeDailyUseSummaryIfAny(
      path.join(outputDirectory, "daily-use-run-summary.json"),
      this.records.length,
      payload,
    );
  }
}

export async function writeDailyUseSummaryIfAny(
  outputPath: string,
  recordCount: number,
  payload: unknown,
): Promise<boolean> {
  if (!shouldWriteDailyUseSummary(recordCount)) return false;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}

/** Exported for tests: the group rollup where unknown must stay unknown. */
export function summarizeRecords(records: readonly DailyUseRunRecord[]) {
  const groups = new Map<string, DailyUseRunRecord[]>();
  for (const record of records) {
    const key = `${record.scenarioId ?? "unlabeled"}:${record.taskFamily}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => {
      const durations = group.map((record) => record.durationMs).sort((a, b) => a - b);
      const scenarioId = group[0]?.scenarioId;
      const atomicRecord = selectAtomicDailyUseObservation(group);
      const observed = atomicRecord?.observed ?? emptyObserved();
      const metrics = scenarioId
        ? createDailyUseRunMetricsV1({
            scenarioId,
            releaseSha: exactReleaseSha(),
            observed,
            modelCalls: sum(group, "modelCalls"),
            // undefined (not 0) when no record in the group knew its count:
            // createDailyUseRunMetricsV1's schema is fixed in src/ and has no
            // null vocabulary, and passing an invented 0 would fingerprint a
            // number nobody measured.
            toolCalls:
              sumNullableCounters(group.map((record) => record.toolCalls)) ??
              undefined,
            continuations: sum(group, "continuations"),
            approvals: sum(group, "approvals"),
            observedAt: new Date().toISOString(),
          })
        : null;
      const atomicPass = Boolean(
        atomicRecord?.status === "passed" &&
        atomicRecord.acceptanceStatus === "pass" &&
        metrics?.acceptanceStatus === "pass",
      );
      const missingAcceptanceCriteria = atomicPass
        ? metrics?.missingAcceptanceCriteria ?? []
        : metrics?.missingAcceptanceCriteria.length
          ? metrics.missingAcceptanceCriteria
          : ["test_result:passed"];
      return {
        key,
        // Keep the typed identity explicit in the serialized rollup. The
        // proof matrix must select one exact scenario; parsing `key` would
        // couple it to a display/grouping string and silently breaks when the
        // reporter shape changes.
        scenarioId: scenarioId ?? null,
        taskFamily: group[0]?.taskFamily ?? "unknown",
        runs: group.length,
        passed: group.filter((record) => record.status === "passed").length,
        retries: group.reduce((total, record) => total + record.retry, 0),
        medianDurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        modelCalls: metrics?.modelCalls ?? 0,
        // Nullable on purpose: null means no record in the group knew the
        // count (unknown ≠ zero); a number is the sum of the records that
        // did know — an explicit lower bound.
        toolCalls: sumNullableCounters(
          group.map((record) => record.toolCalls),
        ),
        toolCallsAttempted: sumNullableCounters(
          group.map((record) => record.toolCallsAttempted),
        ),
        toolCallsFailed: sumNullableCounters(
          group.map((record) => record.toolCallsFailed),
        ),
        toolCallsVacuous: sumNullableCounters(
          group.map((record) => record.toolCallsVacuous),
        ),
        toolCallsIntentionalNoOp: sumNullableCounters(
          group.map((record) => record.toolCallsIntentionalNoOp),
        ),
        toolCallsUndetermined: sumNullableCounters(
          group.map((record) => record.toolCallsUndetermined),
        ),
        reportedTokens: sumNullableCounters(
          group.map((record) => record.reportedTokens),
        ),
        cachedPromptTokens: sumNullableCounters(
          group.map((record) => record.cachedPromptTokens),
        ),
        promptPrefixReuseAvg: averageNullableRatios(
          group.map((record) => record.promptPrefixReuseAvg),
        ),
        continuations: metrics?.continuations ?? 0,
        approvals: metrics?.approvals ?? 0,
        interactiveApprovals: metrics?.approvals ?? 0,
        approvalBoundaryProofCount:
          metrics?.approvalBoundaryProofCount ?? 0,
        artifactProofCount: metrics?.artifactProofCount ?? 0,
        cleanupProofCount: metrics?.cleanupProofCount ?? 0,
        acceptanceStatus: atomicPass ? "pass" : "needs_more_work",
        acceptanceRetry: atomicRecord?.retry ?? null,
        missingAcceptanceCriteria,
        missionScorecard: atomicRecord?.missionScorecard ?? null,
      };
    });
}

export function shouldWriteDailyUseSummary(recordCount: number): boolean {
  return Number.isSafeInteger(recordCount) && recordCount > 0;
}

function parseObservedAnnotation(
  test: TestCase,
): DailyUseObservedAcceptanceV1 | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === DAILY_USE_OBSERVED_ANNOTATION)
    ?.description;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      artifacts: stringArray(value.artifacts),
      proofs: stringArray(value.proofs),
      approvals: stringArray(value.approvals),
      bindings: stringArray(value.bindings),
      cleanup: stringArray(value.cleanup),
    };
  } catch {
    return null;
  }
}

function parseMetricsAnnotation(
  test: TestCase,
  scenarioId: DailyUseScenarioId,
): (Pick<
  DailyUseRunMetricsV1,
  "modelCalls" | "toolCalls" | "continuations" | "approvals"
> & {
  toolCallsAttempted: number | null;
  toolCallsFailed: number | null;
  toolCallsVacuous: number | null;
  toolCallsIntentionalNoOp: number | null;
  toolCallsUndetermined: number | null;
  refusalBuckets: Record<string, number> | null;
  reportedTokens: number | null;
  cachedPromptTokens: number | null;
  promptPrefixReuseAvg: number | null;
}) | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === DAILY_USE_METRICS_ANNOTATION)
    ?.description;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.scenarioId !== scenarioId) return null;
    const usageRecord =
      value.providerUsage && typeof value.providerUsage === "object"
        ? (value.providerUsage as Record<string, unknown>)
        : null;
    return {
      modelCalls: safeCounter(value.modelCalls),
      toolCalls: safeCounter(value.toolCalls),
      continuations: safeCounter(value.continuations),
      approvals: safeCounter(value.approvals),
      // Absent or malformed stays null (unknown), never zero.
      toolCallsAttempted: nullableCounter(value.toolCallsAttempted),
      toolCallsFailed: nullableCounter(value.toolCallsFailed),
      toolCallsVacuous: nullableCounter(value.toolCallsVacuous),
      toolCallsIntentionalNoOp: nullableCounter(value.toolCallsIntentionalNoOp),
      toolCallsUndetermined: nullableCounter(value.toolCallsUndetermined),
      refusalBuckets: counterRecord(value.refusalBuckets),
      reportedTokens: nullableCounter(usageRecord?.reportedTokens),
      cachedPromptTokens: nullableCounter(usageRecord?.cachedPromptTokens),
      promptPrefixReuseAvg: nullableRatio(value.promptPrefixReuseAvg),
    };
  } catch {
    return null;
  }
}

type ToolCallCounterFields = Pick<
  DailyUseRunRecord,
  | "toolCallsAttempted"
  | "toolCallsFailed"
  | "toolCallsVacuous"
  | "toolCallsIntentionalNoOp"
  | "toolCallsUndetermined"
>;

/**
 * Choose ONE source for the whole counter set, never a mix.
 *
 * A spec's explicit annotation wins whenever it carries any tool-call counter:
 * it knows its own scoping (DU-06 folds per lifecycle phase, the harness-wide
 * fold spans the session), and blending one source's `attempted` with another's
 * `failed` would produce a ratio neither source ever measured. Otherwise a
 * COMPLETE harness-wide fold speaks. With neither, every field stays null.
 */
export function resolveToolCallCounters(
  annotated: {
    toolCallsAttempted: number | null;
    toolCallsFailed: number | null;
    toolCallsVacuous: number | null;
    toolCallsIntentionalNoOp: number | null;
    toolCallsUndetermined: number | null;
  } | null | undefined,
  folded: ToolCallOutcomeCountsV1 | null,
): ToolCallCounterFields {
  const annotatedAny =
    annotated &&
    [
      annotated.toolCallsAttempted,
      annotated.toolCallsFailed,
      annotated.toolCallsVacuous,
      annotated.toolCallsIntentionalNoOp,
      annotated.toolCallsUndetermined,
    ].some((value) => value !== null);
  if (annotatedAny) {
    return {
      toolCallsAttempted: annotated!.toolCallsAttempted,
      toolCallsFailed: annotated!.toolCallsFailed,
      toolCallsVacuous: annotated!.toolCallsVacuous,
      toolCallsIntentionalNoOp: annotated!.toolCallsIntentionalNoOp,
      toolCallsUndetermined: annotated!.toolCallsUndetermined,
    };
  }
  if (folded) {
    return {
      toolCallsAttempted: folded.attempted,
      toolCallsFailed: folded.failed,
      toolCallsVacuous: folded.vacuous,
      toolCallsIntentionalNoOp: folded.intentionalNoOp,
      toolCallsUndetermined: folded.undetermined,
    };
  }
  return {
    toolCallsAttempted: null,
    toolCallsFailed: null,
    toolCallsVacuous: null,
    toolCallsIntentionalNoOp: null,
    toolCallsUndetermined: null,
  };
}

/** A non-negative safe integer, else null — unknown is never coerced to 0. */
/** A 0..1 ratio, or null when absent or malformed (unknown, never zero). */
export function nullableRatio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/** Mean of the known ratios; null when no record knew one. */
export function averageNullableRatios(
  values: readonly (number | null)[],
): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  return known.reduce((total, value) => total + value, 0) / known.length;
}

export function nullableCounter(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function counterRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const parsed = nullableCounter(count);
    if (parsed !== null && parsed > 0) record[key] = parsed;
  }
  return record;
}

/**
 * Bucket parse that KEEPS explicit zeros. A complete fold watched the whole
 * event stream, so "this bucket saw nothing" is knowledge, not absence — the
 * sightings-based `counterRecord` above drops zeros precisely because a
 * mined-from-error-text zero is not knowledge.
 */
function explicitCounterRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const parsed = nullableCounter(count);
    if (parsed !== null) record[key] = parsed;
  }
  return record;
}

/**
 * Parse the shared collector's folded counts. Deliberately NOT gated on a
 * typed scenarioId (see the record-builder comment): four of the five real-AI
 * proof lanes have none. Every counter is re-validated through
 * `nullableCounter`, so a malformed annotation degrades to unknown — never to
 * zero — and a coverage value the fold does not define is rejected outright.
 */
function parseToolCallOutcomesAnnotation(
  test: TestCase,
): ToolCallOutcomeCountsV1 | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === DAILY_USE_TOOL_OUTCOMES_ANNOTATION)
    ?.description;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ToolCallOutcomeCountsV1;
    if (
      value?.version !== 1 ||
      !["complete", "lossy", "unobserved"].includes(value.coverage)
    ) {
      return null;
    }
    return {
      ...value,
      attempted: nullableCounter(value.attempted),
      succeeded: nullableCounter(value.succeeded),
      failed: nullableCounter(value.failed),
      undetermined: nullableCounter(value.undetermined),
      vacuous: nullableCounter(value.vacuous),
      intentionalNoOp: nullableCounter(value.intentionalNoOp),
      receiptsUnknown: nullableCounter(value.receiptsUnknown),
      succeededWithWork: nullableCounter(value.succeededWithWork),
      failureBuckets: explicitCounterRecord(value.failureBuckets),
      // Additive in the evidence contract, and re-validated like every other
      // counter so a malformed annotation degrades to unknown, not to zero.
      // An older annotation that predates these fields is `undefined` here and
      // must read as unknown, which is exactly what nullableCounter gives.
      servedFromCache: nullableCounter(value.servedFromCache),
      transportExecuted: nullableCounter(value.transportExecuted),
      observedEvents: nullableCounter(value.observedEvents) ?? 0,
    };
  } catch {
    return null;
  }
}

function parseScorecardAnnotation(test: TestCase): MissionScorecardV1 | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === DAILY_USE_SCORECARD_ANNOTATION)
    ?.description;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as MissionScorecardV1;
    if (
      value?.version !== 1 ||
      typeof value.acceptancePassed !== "boolean" ||
      !unitInterval(value.total) ||
      !Array.isArray(value.dimensions) ||
      value.dimensions.length !== Object.keys(MISSION_SCORE_WEIGHTS).length
    ) {
      return null;
    }
    const seen = new Set<string>();
    for (const dimension of value.dimensions) {
      if (
        !(dimension.id in MISSION_SCORE_WEIGHTS) ||
        seen.has(dimension.id) ||
        !unitInterval(dimension.score) ||
        dimension.weight !== MISSION_SCORE_WEIGHTS[dimension.id] ||
        typeof dimension.detail !== "string"
      ) {
        return null;
      }
      seen.add(dimension.id);
    }
    return value;
  } catch {
    return null;
  }
}

function parseProofClassAnnotation(test: TestCase): E2EProofClassV1 | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === E2E_PROOF_CLASS_ANNOTATION)
    ?.description;
  return raw === "mission" || raw === "contract" ? raw : null;
}

/**
 * Summary acceptance is atomic: retries may contribute aggregate counters,
 * but their proof tokens are never unioned into a synthetic passing run.
 */
export function selectAtomicDailyUseObservation<T extends DailyUseAtomicObservationRecord>(
  records: readonly T[],
): T | null {
  return records.reduce<T | null>((best, candidate) => {
    if (!best) return candidate;
    const candidatePass =
      candidate.status === "passed" && candidate.acceptanceStatus === "pass";
    const bestPass = best.status === "passed" && best.acceptanceStatus === "pass";
    if (candidatePass !== bestPass) return candidatePass ? candidate : best;
    if (
      candidate.missingAcceptanceCriteria.length !==
      best.missingAcceptanceCriteria.length
    ) {
      return candidate.missingAcceptanceCriteria.length <
          best.missingAcceptanceCriteria.length
        ? candidate
        : best;
    }
    const candidateProofCount = countObservedTokens(candidate.observed);
    const bestProofCount = countObservedTokens(best.observed);
    if (candidateProofCount !== bestProofCount) {
      return candidateProofCount > bestProofCount ? candidate : best;
    }
    return candidate.retry >= best.retry ? candidate : best;
  }, null);
}

function countObservedTokens(
  observed: DailyUseObservedAcceptanceV1 | null,
): number {
  if (!observed) return 0;
  return Object.values(observed).reduce(
    (total, values) => total + values.length,
    0,
  );
}

function emptyObserved(): DailyUseObservedAcceptanceV1 {
  return { artifacts: [], proofs: [], approvals: [], bindings: [], cleanup: [] };
}

function isDailyUseScenarioId(value: string | null): value is DailyUseScenarioId {
  return Boolean(value && value in DAILY_USE_ACCEPTANCE_V1);
}

function exactReleaseSha(): string | null {
  const value = process.env.E2E_RELEASE_COMMIT_SHA?.trim().toLowerCase();
  return value && /^[0-9a-f]{40}$/u.test(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === "string" && item.length > 0))].sort()
    : [];
}

function safeCounter(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : 0;
}

function unitInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function sum(
  records: readonly DailyUseRunRecord[],
  // toolCalls is deliberately absent: it is nullable now and must go through
  // sumNullableCounters so unknown never coerces to zero.
  key: "modelCalls" | "continuations" | "approvals",
): number {
  return records.reduce((total, record) => total + record[key], 0);
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}
