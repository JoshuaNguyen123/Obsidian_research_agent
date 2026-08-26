import type { Page, TestInfo } from "@playwright/test";
import { test } from "@playwright/test";

import {
  classifyToolReceiptWork,
  TOOL_REFUSAL_MARKER_BUCKETS,
  type VacuousDetectableReceipt,
} from "../reporters/dailyUseReporter";
import { DAILY_USE_TOOL_CENSUS_ANNOTATION } from "./dailyUseAcceptance";

/**
 * Tool-call census: the per-lane instrumentation that makes "tool-call
 * success" computable instead of blank. The page side is a dumb collector —
 * it counts mission events and projects receipts, and never judges them; all
 * classification happens in Node through the reporter's existing helpers
 * (classifyToolReceiptWork and the shared refusal-bucket vocabulary), so the
 * census can never drift from the summary pipeline's definitions.
 *
 * Honesty contract (the reason this file exists): a count the census cannot
 * PROVE complete is reported as null — unknown, never zero. Every failure
 * mode (never armed, renderer died at harvest, armed mid-run after replay
 * loss, receipt projection overflow) degrades to UNKNOWN, so a wiring bug
 * costs a row of missing data, not a row of fabricated data.
 */

export const TOOL_CALL_CENSUS_SLOT = "__agenticToolCallCensusV1";

/** Page-side receipt projection: delta/commit fields only — no paths, no text. */
export interface CensusReceiptProjectionV1 extends VacuousDetectableReceipt {
  toolName?: unknown;
}

export interface ToolCallCensusSegmentV1 {
  /** Monotonic arm generation; bumped on every (re-)arm. */
  index: number;
  /** droppedEventCount reported by getMissionRunSnapshot() at arm time. */
  armDroppedEventCount: number | null;
  /**
   * True when a mission was already running at arm time. Replay covers the
   * buffered prefix, so the segment is complete UNLESS the buffer had already
   * dropped events by then — the one combination that loses history.
   */
  armedWhileRunning: boolean;
  /** onToolDone events, deduped by event id within the segment. */
  doneIds: string[];
  doneFailedIds: string[];
  /** tool_start / tool_rejected trace ids, deduped within the segment. */
  startIds: string[];
  rejectedIds: string[];
  /** error.code sightings as [eventId, code] pairs (done + rejected streams). */
  errorCodePairs: [string, string][];
  receipts: CensusReceiptProjectionV1[];
  receiptsOverflowed: boolean;
}

export interface ToolCallCensusRawV1 {
  version: 1;
  segments: ToolCallCensusSegmentV1[];
}

export type ToolCallCensusCoverage =
  | "complete"
  | "lossy"
  | "unarmed"
  | "harvest_failed";

export interface ToolCallCensusSummaryV1 {
  version: 1;
  coverage: ToolCallCensusCoverage;
  /** Model-visible attempted calls: onToolDone events + standalone refusals. */
  observed: number | null;
  /** Calls that entered execution (tool_start traces). */
  executed: number | null;
  /** Refusals that never became an onToolDone (standalone tool_rejected). */
  refused: number | null;
  /** onToolDone ok:false plus standalone refusals. */
  failed: number | null;
  /** observed - failed - vacuous, clamped at 0. The user's success numerator. */
  succeeded: number | null;
  /** Successes whose receipt proves no work happened (unintended). */
  vacuous: number | null;
  /** commitKind no_op/reconciled receipts: correct idempotent behavior. */
  intentionalNoOp: number | null;
  /** Receipts carrying no usable work signal (classified "unknown"). */
  receiptsUnknown: number | null;
  /**
   * Refusal counts keyed by the proof matrix's six bucket names. When the
   * census observed the run, an untouched bucket is an EXPLICIT 0 — unlike
   * mined sightings, absence here really means "none seen". Null when
   * coverage is not complete.
   */
  buckets: Record<string, number> | null;
  /**
   * error.code values matching no bucket, capped at
   * MAX_UNBUCKETED_CODES distinct codes. New refusal shapes land here as
   * data instead of vanishing; the overflow count keeps the cap honest.
   */
  unbucketedCodes: Record<string, number>;
  unbucketedCodeOverflow: number;
  /**
   * Diagnostic lower bounds from lossy/partial segments. NEVER fed to the
   * CSV or the reporter counters — the headline counts above are already
   * null whenever these are the only knowledge available.
   */
  atLeast: {
    observed: number;
    failed: number;
  } | null;
  segments: number;
}

const MAX_UNBUCKETED_CODES = 32;
/** Page-side receipt projection cap; far above any lane's real mutation count. */
const RECEIPTS_CAP = 512;

const NATIVE_CORE_PLUGIN_ID = "agentic-researcher";

/**
 * The page the census is currently armed on, for the afterEach fallback: a
 * test that times out never reaches harness.close(), so the afterEach hook
 * harvests directly from the still-open page instead of losing the run.
 */
let activeCensusPage: Page | null = null;
/** Harvested-but-not-yet-recorded summary, set by harvestToolCallCensus. */
let lastHarvestedCensus: ToolCallCensusSummaryV1 | null = null;

/**
 * Install (or re-install) the page-side collector. Idempotent: re-arming
 * unsubscribes the previous generation and starts a new segment whose
 * replayed events are deduped by id, so calling it after restartCorePlugin
 * recovers the buffered prefix without double-counting.
 */
export async function armToolCallCensus(page: Page): Promise<void> {
  activeCensusPage = page;
  await page.evaluate(
    ({ pluginId, slotKey, receiptsCap }) => {
      const host = window as typeof window & Record<string, any>;
      const plugin = (window as typeof window & { app?: any }).app?.plugins
        ?.plugins?.[pluginId];
      if (!plugin?.subscribeMissionEvents) {
        throw new Error(
          "The native mission trace subscription is unavailable; the tool-call census cannot arm.",
        );
      }
      const existing = host[slotKey] as
        | {
            segments: any[];
            unsubscribe?: () => void;
          }
        | undefined;
      try {
        existing?.unsubscribe?.();
      } catch {
        // A plugin restart invalidates the old coordinator subscription.
      }
      const snapshot = plugin.getMissionRunSnapshot?.() ?? null;
      const segment = {
        index: existing?.segments.length ?? 0,
        armDroppedEventCount: Number.isSafeInteger(snapshot?.droppedEventCount)
          ? snapshot.droppedEventCount
          : null,
        armedWhileRunning: snapshot?.isRunning === true,
        doneIds: [] as string[],
        doneFailedIds: [] as string[],
        startIds: [] as string[],
        rejectedIds: [] as string[],
        errorCodePairs: [] as [string, string][],
        receipts: [] as Record<string, unknown>[],
        receiptsOverflowed: false,
        seenDone: new Set<string>(),
        seenTrace: new Set<string>(),
        seenReceipt: new Set<string>(),
      };
      const state = {
        version: 1,
        segments: [...(existing?.segments ?? []), segment],
        unsubscribe: undefined as (() => void) | undefined,
      };
      host[slotKey] = state;
      const recordErrorCode = (id: string, code: unknown) => {
        if (typeof code === "string" && code.length > 0) {
          segment.errorCodePairs.push([id, code]);
        }
      };
      state.unsubscribe = plugin.subscribeMissionEvents(
        {
          onToolDone: (event: any) => {
            const id = typeof event?.id === "string" ? event.id : "";
            if (!id || segment.seenDone.has(id)) return;
            segment.seenDone.add(id);
            segment.doneIds.push(id);
            if (event?.ok === false) {
              segment.doneFailedIds.push(id);
              recordErrorCode(id, event?.error?.code);
            }
          },
          onTrace: (event: any) => {
            const kind = event?.kind;
            if (kind !== "tool_start" && kind !== "tool_rejected") return;
            const id = typeof event?.id === "string" ? event.id : "";
            const key = `${kind}:${id}`;
            if (!id || segment.seenTrace.has(key)) return;
            segment.seenTrace.add(key);
            if (kind === "tool_start") {
              segment.startIds.push(id);
              return;
            }
            segment.rejectedIds.push(id);
            recordErrorCode(id, event?.error?.code);
          },
          onReceipt: (receipt: any) => {
            const id = typeof receipt?.id === "string" ? receipt.id : null;
            if (id) {
              if (segment.seenReceipt.has(id)) return;
              segment.seenReceipt.add(id);
            }
            if (segment.receipts.length >= receiptsCap) {
              segment.receiptsOverflowed = true;
              return;
            }
            // Delta/commit projection only: no paths, no payload text.
            segment.receipts.push({
              toolName: receipt?.toolName,
              operation: receipt?.operation,
              bytesWritten: receipt?.bytesWritten,
              bytesDeleted: receipt?.bytesDeleted,
              affectedCount: receipt?.affectedCount,
              commitKind: receipt?.commitKind,
              effects:
                receipt?.effects && typeof receipt.effects === "object"
                  ? { changed: receipt.effects.changed }
                  : undefined,
            });
          },
        },
        // Replay recovers the buffered prefix when arming beside an already
        // started run (e.g. re-arming after a mid-mission plugin restart);
        // id de-dup makes it idempotent.
        { replay: true },
      );
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      slotKey: TOOL_CALL_CENSUS_SLOT,
      receiptsCap: RECEIPTS_CAP,
    },
  );
}

/**
 * Read the collector state off the page and summarize it. Never throws: a
 * dead renderer or missing slot degrades to an UNKNOWN summary. The result
 * is also parked module-side for recordToolCallCensusAfterEach.
 */
export async function harvestToolCallCensus(
  page: Page,
): Promise<ToolCallCensusSummaryV1> {
  let summary: ToolCallCensusSummaryV1;
  try {
    const raw = (await page.evaluate((slotKey) => {
      const host = window as typeof window & Record<string, any>;
      const state = host[slotKey];
      if (!state) return null;
      return {
        version: 1,
        segments: state.segments.map((segment: any) => ({
          index: segment.index,
          armDroppedEventCount: segment.armDroppedEventCount,
          armedWhileRunning: segment.armedWhileRunning,
          doneIds: [...segment.doneIds],
          doneFailedIds: [...segment.doneFailedIds],
          startIds: [...segment.startIds],
          rejectedIds: [...segment.rejectedIds],
          errorCodePairs: segment.errorCodePairs.map((pair: unknown[]) => [
            ...pair,
          ]),
          receipts: segment.receipts.map((receipt: object) => ({ ...receipt })),
          receiptsOverflowed: segment.receiptsOverflowed === true,
        })),
      };
    }, TOOL_CALL_CENSUS_SLOT)) as ToolCallCensusRawV1 | null;
    summary = raw
      ? summarizeToolCallCensusV1(raw)
      : emptySummary("unarmed", 0);
  } catch {
    summary = emptySummary("harvest_failed", 0);
  }
  lastHarvestedCensus = summary;
  activeCensusPage = null;
  return summary;
}

/** The last harvested summary, if any (cleared by consumeToolCallCensus). */
export function peekToolCallCensus(): ToolCallCensusSummaryV1 | null {
  return lastHarvestedCensus;
}

/**
 * Pure reducer from raw page state to the summary. Exported for unit tests;
 * contains every judgment the census makes.
 */
export function summarizeToolCallCensusV1(
  raw: ToolCallCensusRawV1,
): ToolCallCensusSummaryV1 {
  const segments = Array.isArray(raw?.segments) ? raw.segments : [];
  if (segments.length === 0) return emptySummary("unarmed", 0);
  // A segment is lossy only when arming happened MID-RUN after the replay
  // buffer had already dropped events: a continuously armed subscriber
  // receives every live event, so drops that happen later never lose data.
  const lossy = segments.some(
    (segment) =>
      segment.receiptsOverflowed ||
      (segment.armedWhileRunning &&
        (segment.armDroppedEventCount === null ||
          segment.armDroppedEventCount > 0)),
  );

  let observed = 0;
  let executed = 0;
  let refused = 0;
  let failed = 0;
  const receipts: CensusReceiptProjectionV1[] = [];
  const bucketRegexes = TOOL_REFUSAL_MARKER_BUCKETS.map(
    ([key, source]) => [key, new RegExp(source, "iu")] as const,
  );
  const buckets: Record<string, number> = Object.fromEntries(
    TOOL_REFUSAL_MARKER_BUCKETS.map(([key]) => [key, 0]),
  );
  const unbucketed = new Map<string, number>();
  let unbucketedCodeOverflow = 0;

  for (const segment of segments) {
    const doneIds = new Set(segment.doneIds);
    // A tool_rejected trace whose id extends an onToolDone id (e.g.
    // "5:0:append_to_current_file:graph-rejected" beside
    // "5:0:append_to_current_file") is the SAME logical call reported on both
    // streams — the main-loop authority rejection emits both. Count it once.
    const standaloneRejected = segment.rejectedIds.filter(
      (id) => !hasDonePrefix(id, doneIds),
    );
    observed += segment.doneIds.length + standaloneRejected.length;
    executed += segment.startIds.length;
    refused += standaloneRejected.length;
    failed += segment.doneFailedIds.length + standaloneRejected.length;
    receipts.push(...segment.receipts);

    const countedErrorIds = new Set<string>();
    for (const [id, code] of segment.errorCodePairs) {
      // Same prefix rule: an error code recorded from the rejected stream is
      // skipped when its call was already counted through onToolDone.
      const viaRejectedDuplicate =
        segment.rejectedIds.includes(id) &&
        hasDonePrefix(id, doneIds) &&
        !segment.doneFailedIds.includes(id);
      if (viaRejectedDuplicate || countedErrorIds.has(id)) continue;
      countedErrorIds.add(id);
      const bucket = bucketRegexes.find(([, regex]) => regex.test(code));
      if (bucket) {
        buckets[bucket[0]] += 1;
      } else if (unbucketed.has(code)) {
        unbucketed.set(code, (unbucketed.get(code) ?? 0) + 1);
      } else if (unbucketed.size < MAX_UNBUCKETED_CODES) {
        unbucketed.set(code, 1);
      } else {
        unbucketedCodeOverflow += 1;
      }
    }
  }

  let vacuous = 0;
  let intentionalNoOp = 0;
  let receiptsUnknown = 0;
  for (const receipt of receipts) {
    const verdict = classifyToolReceiptWork(receipt);
    if (verdict === "vacuous") vacuous += 1;
    else if (verdict === "intentional_no_op") intentionalNoOp += 1;
    else if (verdict === "unknown") receiptsUnknown += 1;
  }

  if (lossy) {
    return {
      ...emptySummary("lossy", segments.length),
      atLeast: { observed, failed },
    };
  }
  return {
    version: 1,
    coverage: "complete",
    observed,
    executed,
    refused,
    failed,
    succeeded: Math.max(0, observed - failed - vacuous),
    vacuous,
    intentionalNoOp,
    receiptsUnknown,
    buckets,
    unbucketedCodes: Object.fromEntries(unbucketed),
    unbucketedCodeOverflow,
    atLeast: null,
    segments: segments.length,
  };
}

function hasDonePrefix(rejectedId: string, doneIds: ReadonlySet<string>): boolean {
  if (doneIds.has(rejectedId)) return true;
  for (
    let cut = rejectedId.lastIndexOf(":");
    cut > 0;
    cut = rejectedId.lastIndexOf(":", cut - 1)
  ) {
    if (doneIds.has(rejectedId.slice(0, cut))) return true;
  }
  return false;
}

function emptySummary(
  coverage: ToolCallCensusCoverage,
  segments: number,
): ToolCallCensusSummaryV1 {
  return {
    version: 1,
    coverage,
    observed: null,
    executed: null,
    refused: null,
    failed: null,
    succeeded: null,
    vacuous: null,
    intentionalNoOp: null,
    receiptsUnknown: null,
    buckets: null,
    unbucketedCodes: {},
    unbucketedCodeOverflow: 0,
    atLeast: null,
    segments,
  };
}

/**
 * Annotate the current test with the harvested census. Consumes the parked
 * summary so a later test whose harness never armed cannot inherit it.
 */
export function recordToolCallCensus(
  testInfo: TestInfo,
  summary: ToolCallCensusSummaryV1,
): void {
  testInfo.annotations.push({
    type: DAILY_USE_TOOL_CENSUS_ANNOTATION,
    description: JSON.stringify(summary),
  });
}

/**
 * Register a per-spec afterEach that records whatever census the harness
 * harvested at close — with a direct-harvest fallback for tests that never
 * reached close (timeouts). Two lines in a spec:
 *
 *   import { recordToolCallCensusAfterEach } from "./fixtures/toolCallCensus";
 *   recordToolCallCensusAfterEach();
 */
export function recordToolCallCensusAfterEach(): void {
  test.afterEach(async ({}, testInfo) => {
    let summary = lastHarvestedCensus;
    if (!summary && activeCensusPage && !activeCensusPage.isClosed()) {
      summary = await harvestToolCallCensus(activeCensusPage);
    }
    lastHarvestedCensus = null;
    activeCensusPage = null;
    recordToolCallCensus(testInfo, summary ?? emptySummary("unarmed", 0));
  });
}
