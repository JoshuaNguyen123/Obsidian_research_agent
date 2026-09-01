import {
  classifyToolReceiptWork,
  TOOL_REFUSAL_MARKER_BUCKETS,
  type VacuousDetectableReceipt,
} from "../reporters/dailyUseReporter";

/**
 * Tool-call OUTCOME fold: the counting primitive that makes "tool-call
 * success" computable from a mission event stream.
 *
 * Why this exists. Every spec today derives its `toolCalls` counter from
 * `missionEvidence.length` or `usage.toolCalls`, and
 * `evidenceFromToolResult` (src/agent/missionEvidence.ts:43) returns null
 * for `!result.ok`. FAILED calls therefore produce no evidence at all: they
 * are invisible, and the attempt itself is never counted. The failure
 * signals do exist on the mission event stream — `tool_result` traces carry
 * `error`, `onToolDone` carries `ok:false`, and `tool_rejected` traces are
 * emitted for refusals — but nothing consumed them.
 *
 * Shape of the answer. This module is PURE and JSON-only: it holds no
 * Playwright, DOM, or plugin references, so the identical fold runs
 * page-side inside `page.evaluate`, Node-side in a reporter, or in a unit
 * test over a synthetic stream. A collector's only job is to normalize
 * events (`normalizeMissionToolEventV1`) and hand them over; every judgment
 * lives here, where it is testable.
 *
 * Honesty contract (the reason for the null vocabulary):
 * - A count that cannot be DETERMINED is `null`, never 0. An empty stream
 *   is indistinguishable from "nobody was listening", so it yields nulls.
 * - Callers that know their capture was lossy pass `coverage: "lossy"`;
 *   headline counts go null and lower bounds move to `atLeast`.
 * - Every field is emitted explicitly (never `undefined`), so `null`
 *   survives `JSON.stringify` distinctly from `0`.
 * - Receipt work classification is DELEGATED to the existing
 *   `classifyToolReceiptWork`, and failure buckets reuse the existing
 *   `TOOL_REFUSAL_MARKER_BUCKETS` vocabulary. There is deliberately no
 *   second classifier and no second bucket vocabulary in this file.
 */

/** Normalized, JSON-safe mission event. Collectors emit only these. */
export type ToolCallOutcomeEventV1 =
  | {
      kind: "tool_start";
      id: string;
      toolName: string | null;
    }
  | {
      kind: "tool_done";
      id: string;
      toolName: string | null;
      ok: boolean | null;
      errorCode: string | null;
    }
  | {
      kind: "tool_result";
      id: string;
      toolName: string | null;
      errorCode: string | null;
    }
  | {
      kind: "tool_rejected";
      id: string;
      toolName: string | null;
      errorCode: string | null;
    }
  | {
      kind: "receipt";
      /** Receipt identity when the product supplied one; enables de-dup. */
      id: string | null;
      toolName: string | null;
      receipt: VacuousDetectableReceipt;
    };

export type ToolCallOutcomeCoverageV1 = "complete" | "lossy";

export interface ToolCallOutcomeCountsV1 {
  version: 1;
  coverage: ToolCallOutcomeCoverageV1 | "unobserved";
  /**
   * Distinct logical calls the model attempted: every call key that produced
   * a start, a result, a done, or a standalone refusal. This is the
   * denominator the success rate was always missing.
   */
  attempted: number | null;
  /** Calls whose terminal event said ok. Includes vacuous ones — see below. */
  succeeded: number | null;
  /** Calls whose terminal event said not-ok, plus standalone refusals. */
  failed: number | null;
  /**
   * Calls that started and never produced a terminal event in this stream.
   * Kept EXPLICIT rather than folded into either side: an interrupted run
   * genuinely does not know how those calls ended.
   * Invariant: succeeded + failed + undetermined === attempted.
   */
  undetermined: number | null;
  /**
   * UNINTENDED no-work successes, from receipts via classifyToolReceiptWork
   * ("vacuous"). Receipt-derived, so this is NOT a subset partition of
   * `succeeded` — a call may emit zero or one receipts.
   */
  vacuous: number | null;
  /** commitKind no_op/reconciled: correct idempotent behavior, tracked apart. */
  intentionalNoOp: number | null;
  /** Receipts carrying no usable work signal (classified "unknown"). */
  receiptsUnknown: number | null;
  /**
   * `succeeded - vacuous`, clamped at 0: the user's success numerator, where
   * success means the tool DID WORK. Intentional no-ops stay inside, because
   * a correct idempotent replay is not a failure to do work.
   */
  succeededWithWork: number | null;
  /**
   * Failure counts keyed by the shared refusal vocabulary plus "other".
   * When coverage is complete every key is present, so an untouched bucket
   * is an EXPLICIT 0. Null when nothing was observed or capture was lossy.
   */
  failureBuckets: Record<string, number> | null;
  /**
   * Bounded, content-free identity for each failed logical call. This keeps a
   * green mission that recovered from a failed call diagnosable after the
   * native harness deletes its run-owned graph: no arguments, paths, output,
   * note text, or provider payloads are retained.
   *
   * Null means the capture was unobserved/lossy (unknown); an empty array is
   * an explicit complete observation with no failed calls.
   */
  failureDetails: ToolCallFailureDetailV1[] | null;
  /** True when the bounded detail list omitted additional failed calls. */
  failureDetailsTruncated: boolean | null;
  /**
   * Lower bounds recovered from a lossy capture. Diagnostic only: never
   * promote these into the headline counters, which are already null.
   */
  atLeast: { attempted: number; failed: number } | null;
  /** Events the fold actually consumed, after de-duplication. */
  observedEvents: number;
}

export interface ToolCallFailureDetailV1 {
  id: string;
  toolName: string | null;
  errorCode: string | null;
  bucket: string;
}

/** Keep summaries useful without allowing a pathological run to grow them. */
export const TOOL_CALL_FAILURE_DETAIL_CAP = 32;

/** Failure bucket for an error code that matches no known refusal marker. */
export const TOOL_CALL_FAILURE_BUCKET_OTHER = "other";

/**
 * Bucket keys this fold can emit: the six shared refusal markers plus
 * "other". The task vocabulary maps onto the repo's existing names —
 * authority_blocked is `mission_graph_authority_blocked` (with
 * `authority_grant_invalid` for grant-shaped refusals) — rather than
 * introducing a parallel set that would drift from the proof matrix.
 */
export const TOOL_CALL_FAILURE_BUCKET_KEYS: readonly string[] = [
  ...TOOL_REFUSAL_MARKER_BUCKETS.map(([key]) => key),
  TOOL_CALL_FAILURE_BUCKET_OTHER,
];

/**
 * Classify one failure's error code. Unmatched codes (including a missing
 * code) land in "other" as data rather than vanishing.
 */
export function classifyToolFailureBucketV1(
  errorCode: string | null | undefined,
): string {
  if (typeof errorCode !== "string" || errorCode.length === 0) {
    return TOOL_CALL_FAILURE_BUCKET_OTHER;
  }
  for (const [key, source] of TOOL_REFUSAL_MARKER_BUCKETS) {
    if (new RegExp(source, "iu").test(errorCode)) return key;
  }
  return TOOL_CALL_FAILURE_BUCKET_OTHER;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorCodeOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return asText((value as { code?: unknown }).code);
}

/**
 * Map one raw mission event onto the normalized union, or null when the
 * event says nothing about a tool call. Accepts the three native shapes:
 * `AgentTraceEvent` (kind tool_start/tool_result/tool_rejected) from
 * `onTrace`, `AgentToolRunEvent` from `onToolDone`, and `AgentRunReceipt`
 * from `onReceipt`. Receipts are projected down to delta/commit fields
 * only — no paths, no payload text — so a collector can carry them across
 * a page boundary without leaking vault content.
 */
export function normalizeMissionToolEventV1(
  raw: unknown,
  source: "trace" | "tool_done" | "receipt",
): ToolCallOutcomeEventV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;

  if (source === "tool_done") {
    const id = asText(event.id);
    if (!id) return null;
    return {
      kind: "tool_done",
      id,
      toolName: asText(event.name) ?? asText(event.toolName),
      ok: typeof event.ok === "boolean" ? event.ok : null,
      errorCode: errorCodeOf(event.error),
    };
  }

  if (source === "receipt") {
    const receipt = event as VacuousDetectableReceipt & Record<string, unknown>;
    const effects =
      receipt.effects && typeof receipt.effects === "object"
        ? {
            changed: (receipt.effects as { changed?: unknown }).changed,
          }
        : undefined;
    const purpose =
      receipt.purpose === "validation_fast" ||
      receipt.purpose === "validation_targeted" ||
      receipt.purpose === "validation_full"
        ? receipt.purpose
        : undefined;
    const readback =
      receipt.readback &&
      typeof receipt.readback === "object" &&
      (receipt.readback as { status?: unknown }).status === "verified"
        ? { status: "verified" }
        : undefined;
    const exitCode = Number.isSafeInteger(receipt.exitCode)
      ? receipt.exitCode
      : undefined;
    return {
      kind: "receipt",
      id: asText(event.id),
      toolName: asText(event.toolName),
      receipt: {
        operation: receipt.operation,
        bytesWritten: receipt.bytesWritten,
        bytesDeleted: receipt.bytesDeleted,
        affectedCount: receipt.affectedCount,
        commitKind: receipt.commitKind,
        purpose,
        readback,
        exitCode,
        ...(effects ? { effects } : {}),
      },
    };
  }

  const kind = asText(event.kind);
  const id = asText(event.id);
  if (!id) return null;
  const toolName = asText(event.toolName);
  if (kind === "tool_start") return { kind: "tool_start", id, toolName };
  if (kind === "tool_result") {
    return {
      kind: "tool_result",
      id,
      toolName,
      errorCode: errorCodeOf(event.error),
    };
  }
  if (kind === "tool_rejected") {
    return {
      kind: "tool_rejected",
      id,
      toolName,
      errorCode: errorCodeOf(event.error),
    };
  }
  return null;
}

/**
 * Trace ids extend the call's base id with a phase suffix
 * (`${step}:${index}:${name}` gains `:start` / `:result`), so both phases
 * fold onto one logical call.
 */
const TRACE_PHASE_SUFFIXES = [":start", ":result"] as const;

function baseCallKey(id: string): string {
  for (const suffix of TRACE_PHASE_SUFFIXES) {
    if (id.endsWith(suffix)) return id.slice(0, -suffix.length);
  }
  return id;
}

interface CallAccumulator {
  id: string;
  toolName: string | null;
  started: boolean;
  terminalOk: boolean;
  terminalFailed: boolean;
  failureCodes: (string | null)[];
}

function emptyCall(id: string): CallAccumulator {
  return {
    id,
    toolName: null,
    started: false,
    terminalOk: false,
    terminalFailed: false,
    failureCodes: [],
  };
}

/** All-null counts: the honest answer when nothing was observed. */
export function unknownToolCallOutcomeCountsV1(
  coverage: ToolCallOutcomeCountsV1["coverage"] = "unobserved",
): ToolCallOutcomeCountsV1 {
  return {
    version: 1,
    coverage,
    attempted: null,
    succeeded: null,
    failed: null,
    undetermined: null,
    vacuous: null,
    intentionalNoOp: null,
    receiptsUnknown: null,
    succeededWithWork: null,
    failureBuckets: null,
    failureDetails: null,
    failureDetailsTruncated: null,
    atLeast: null,
    observedEvents: 0,
  };
}

/**
 * Fold a mission event stream into outcome counts.
 *
 * Order-independent: rejection ids are resolved against the full set of
 * known call keys only AFTER every event has been read, so shuffling the
 * stream cannot change the result. Idempotent: events are de-duplicated by
 * (kind, id), so a replayed buffer merged with the live tail counts once.
 */
export function foldToolCallOutcomesV1(
  events: Iterable<ToolCallOutcomeEventV1>,
  options: { coverage?: ToolCallOutcomeCoverageV1 } = {},
): ToolCallOutcomeCountsV1 {
  const coverage = options.coverage ?? "complete";
  const seen = new Set<string>();
  const calls = new Map<string, CallAccumulator>();
  const rejections: {
    id: string;
    toolName: string | null;
    errorCode: string | null;
  }[] = [];
  const receipts: VacuousDetectableReceipt[] = [];
  const seenReceiptIds = new Set<string>();
  let observedEvents = 0;

  const callFor = (key: string): CallAccumulator => {
    const existing = calls.get(key);
    if (existing) return existing;
    const created = emptyCall(key);
    calls.set(key, created);
    return created;
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.kind === "receipt") {
      // Receipts without an id cannot be de-duplicated, so an id-less
      // receipt is counted once per sighting. Collectors that replay a
      // buffer must therefore prefer receipts that carry `id`.
      if (event.id) {
        if (seenReceiptIds.has(event.id)) continue;
        seenReceiptIds.add(event.id);
      }
      observedEvents += 1;
      receipts.push(event.receipt);
      continue;
    }
    const dedupeKey = `${event.kind}:${event.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    observedEvents += 1;

    if (event.kind === "tool_rejected") {
      rejections.push({
        id: event.id,
        toolName: event.toolName,
        errorCode: event.errorCode,
      });
      continue;
    }
    const call = callFor(baseCallKey(event.id));
    if (event.kind === "tool_start") {
      call.toolName ??= event.toolName;
      call.started = true;
      continue;
    }
    if (event.kind === "tool_done") {
      call.toolName ??= event.toolName;
      if (event.ok === false) {
        call.terminalFailed = true;
        call.failureCodes.push(event.errorCode);
      } else if (event.ok === true) {
        call.terminalOk = true;
      }
      // ok:null is a done event that refuses to say — it proves the call
      // ended but not how, so it stays undetermined rather than guessed.
      continue;
    }
    // tool_result
    call.toolName ??= event.toolName;
    if (event.errorCode) {
      call.terminalFailed = true;
      call.failureCodes.push(event.errorCode);
    } else {
      call.terminalOk = true;
    }
  }

  // Rejection attribution runs after the full stream is known, which is what
  // makes the fold order-independent. A refusal id may either equal a call
  // key or extend one with a suffix (e.g. ":graph-rejected"); when it does,
  // it is the SAME logical call reported on a second stream and must not be
  // counted twice.
  for (const rejection of rejections) {
    const owner = resolveRejectionOwner(rejection.id, calls);
    const call = owner ? calls.get(owner)! : callFor(rejection.id);
    call.toolName ??= rejection.toolName;
    call.terminalFailed = true;
    call.terminalOk = false;
    call.failureCodes.push(rejection.errorCode);
  }

  let succeeded = 0;
  let failed = 0;
  let undetermined = 0;
  const failureBuckets: Record<string, number> = Object.fromEntries(
    TOOL_CALL_FAILURE_BUCKET_KEYS.map((key) => [key, 0]),
  );
  const allFailureDetails: ToolCallFailureDetailV1[] = [];
  for (const call of calls.values()) {
    if (call.terminalFailed) {
      failed += 1;
      // One call is one failure, whatever how many streams reported it; the
      // bucket comes from the first code that named a reason.
      const code = call.failureCodes.find((value) => value !== null) ?? null;
      const bucket = classifyToolFailureBucketV1(code);
      failureBuckets[bucket] += 1;
      allFailureDetails.push({
        id: call.id,
        toolName: call.toolName,
        errorCode: code,
        bucket,
      });
    } else if (call.terminalOk) {
      succeeded += 1;
    } else {
      undetermined += 1;
    }
  }
  const attempted = calls.size;

  let vacuous = 0;
  let intentionalNoOp = 0;
  let receiptsUnknown = 0;
  for (const receipt of receipts) {
    const verdict = classifyToolReceiptWork(receipt);
    if (verdict === "vacuous") vacuous += 1;
    else if (verdict === "intentional_no_op") intentionalNoOp += 1;
    else if (verdict === "unknown") receiptsUnknown += 1;
  }

  if (observedEvents === 0) {
    return unknownToolCallOutcomeCountsV1("unobserved");
  }
  if (coverage === "lossy") {
    return {
      ...unknownToolCallOutcomeCountsV1("lossy"),
      atLeast: { attempted, failed },
      observedEvents,
    };
  }
  // Event order must not affect either counts or diagnostics. Sort before the
  // bound is applied so even an over-cap stream retains the same calls.
  const failureDetails = allFailureDetails
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, TOOL_CALL_FAILURE_DETAIL_CAP);
  return {
    version: 1,
    coverage: "complete",
    attempted,
    succeeded,
    failed,
    undetermined,
    vacuous,
    intentionalNoOp,
    receiptsUnknown,
    succeededWithWork: Math.max(0, succeeded - vacuous),
    failureBuckets,
    failureDetails,
    failureDetailsTruncated: allFailureDetails.length > failureDetails.length,
    atLeast: null,
    observedEvents,
  };
}

function resolveRejectionOwner(
  id: string,
  calls: ReadonlyMap<string, CallAccumulator>,
): string | null {
  if (calls.has(id)) return id;
  const base = baseCallKey(id);
  if (calls.has(base)) return base;
  // Strip trailing ":"-segments (":graph-rejected", ":authority:denied", …)
  // until a known call key appears. Bounded by the id's own segment count.
  let candidate = base;
  for (let index = candidate.lastIndexOf(":"); index > 0; ) {
    candidate = candidate.slice(0, index);
    if (calls.has(candidate)) return candidate;
    index = candidate.lastIndexOf(":");
  }
  return null;
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Combine two folds (e.g. one segment per plugin restart). Coverage is the
 * WEAKER of the two: one lossy segment makes the whole answer lossy, which
 * is the only combination that cannot overcount.
 */
export function mergeToolCallOutcomeCountsV1(
  left: ToolCallOutcomeCountsV1,
  right: ToolCallOutcomeCountsV1,
): ToolCallOutcomeCountsV1 {
  if (left.observedEvents === 0) return right;
  if (right.observedEvents === 0) return left;
  const observedEvents = left.observedEvents + right.observedEvents;
  const atLeastAttempted =
    (left.atLeast?.attempted ?? left.attempted ?? 0) +
    (right.atLeast?.attempted ?? right.attempted ?? 0);
  const atLeastFailed =
    (left.atLeast?.failed ?? left.failed ?? 0) +
    (right.atLeast?.failed ?? right.failed ?? 0);
  if (left.coverage !== "complete" || right.coverage !== "complete") {
    return {
      ...unknownToolCallOutcomeCountsV1("lossy"),
      atLeast: { attempted: atLeastAttempted, failed: atLeastFailed },
      observedEvents,
    };
  }
  const buckets: Record<string, number> = {};
  for (const key of TOOL_CALL_FAILURE_BUCKET_KEYS) {
    buckets[key] =
      (left.failureBuckets?.[key] ?? 0) + (right.failureBuckets?.[key] ?? 0);
  }
  const succeeded = addNullable(left.succeeded, right.succeeded);
  const vacuous = addNullable(left.vacuous, right.vacuous);
  const mergedFailureDetails = [
    ...(left.failureDetails ?? []),
    ...(right.failureDetails ?? []),
  ];
  const failureDetails = mergedFailureDetails.slice(
    0,
    TOOL_CALL_FAILURE_DETAIL_CAP,
  );
  return {
    version: 1,
    coverage: "complete",
    attempted: addNullable(left.attempted, right.attempted),
    succeeded,
    failed: addNullable(left.failed, right.failed),
    undetermined: addNullable(left.undetermined, right.undetermined),
    vacuous,
    intentionalNoOp: addNullable(left.intentionalNoOp, right.intentionalNoOp),
    receiptsUnknown: addNullable(left.receiptsUnknown, right.receiptsUnknown),
    succeededWithWork:
      succeeded === null ? null : Math.max(0, succeeded - (vacuous ?? 0)),
    failureBuckets: buckets,
    failureDetails,
    failureDetailsTruncated:
      left.failureDetailsTruncated === true ||
      right.failureDetailsTruncated === true ||
      mergedFailureDetails.length > failureDetails.length,
    atLeast: null,
    observedEvents,
  };
}

/**
 * Project a fold onto the counters `recordDailyUseAcceptance` already
 * accepts, so a spec can hand honest numbers to the run-summary record
 * without the reporter learning a new shape. Unknown stays null.
 */
export function toolCallOutcomeAcceptanceCountersV1(
  counts: ToolCallOutcomeCountsV1,
): {
  toolCallsAttempted: number | null;
  toolCallsFailed: number | null;
  toolCallsVacuous: number | null;
  toolCallsIntentionalNoOp: number | null;
  refusalBuckets: Record<string, number> | null;
} {
  return {
    toolCallsAttempted: counts.attempted,
    toolCallsFailed: counts.failed,
    toolCallsVacuous: counts.vacuous,
    toolCallsIntentionalNoOp: counts.intentionalNoOp,
    refusalBuckets: counts.failureBuckets,
  };
}
