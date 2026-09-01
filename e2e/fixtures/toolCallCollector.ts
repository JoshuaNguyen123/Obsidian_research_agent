import type { Page, TestInfo } from "@playwright/test";
import { test } from "@playwright/test";

import { DAILY_USE_TOOL_OUTCOMES_ANNOTATION } from "./dailyUseAcceptance";
import {
  foldToolCallOutcomesV1,
  mergeToolCallOutcomeCountsV1,
  unknownToolCallOutcomeCountsV1,
  type ToolCallOutcomeCountsV1,
  type ToolCallOutcomeEventV1,
} from "./toolCallOutcomes";

/**
 * The single instrumentation seam that makes tool-call success computable in
 * EVERY real-AI lane, not just daily-use-compound.
 *
 * Division of labour, deliberately:
 *   - the PAGE side is a dumb collector. It subscribes to the plugin's mission
 *     events, normalizes each one into `ToolCallOutcomeEventV1`, and pushes it
 *     into a slot. It never counts, never classifies, never decides.
 *   - the NODE side folds those events with `foldToolCallOutcomesV1`
 *     (e2e/fixtures/toolCallOutcomes.ts), the counting primitive that is
 *     unit-tested in tests/toolCallOutcomes.test.ts.
 * There is deliberately NO second fold, NO second bucket vocabulary and NO
 * second receipt classifier in this file: a second authority for "how many
 * tool calls succeeded" is the exact deadlock shape this repo keeps paying for.
 *
 * Honesty contract. A count this collector cannot PROVE complete is reported
 * as null — unknown, never zero:
 *   - never armed (no `startRealAiHarness`, or a relaunched process whose
 *     renderer took the slot with it)  -> unobserved, all null;
 *   - harvest threw (dead renderer, closed page)                -> all null;
 *   - armed mid-run after the replay buffer had already dropped -> lossy, all
 *     headline counts null with lower bounds parked in `atLeast`;
 *   - event/receipt overflow in one segment                     -> lossy.
 * A wiring bug therefore costs a row of MISSING data, never a row of FALSE
 * data.
 *
 * Segments and the interrupted-continuation lane. `restartCorePlugin` disables
 * and re-enables the plugin mid-mission, which destroys the coordinator and
 * with it our subscription. Each (re-)arm opens a new SEGMENT; every segment
 * is folded on its own and the folds are merged with
 * `mergeToolCallOutcomeCountsV1`. That is why counting survives the restart:
 *   - segment 0 saw every event live up to the disable;
 *   - segment 1 arms with `replay: true` against the NEW coordinator, whose
 *     buffer starts at the resumed run, so replay supplies the prefix between
 *     enable and re-arm;
 *   - a segment that cannot prove that (already running at arm time AND the
 *     buffer had already dropped, or dropped-count unknown) is LOSSY, and one
 *     lossy segment degrades the whole merged answer to UNKNOWN.
 * Folding per segment rather than concatenating events is also what keeps the
 * restart honest across id reuse: a resumed run may re-issue `step:index:name`
 * ids, and a single fold would silently collapse two real calls into one.
 */

/** Page-global slot holding the collector state. */
export const TOOL_CALL_COLLECTOR_SLOT = "__agenticToolCallCollectorV1";

/** Core plugin id, inlined so this fixture stays importable page-side-free. */
const NATIVE_CORE_PLUGIN_ID = "agentic-researcher";

/**
 * Per-segment event cap. Far above any real lane (a 24-step run offering 7
 * tools per step tops out near 170 calls ~ 700 events); crossing it means the
 * capture is no longer trustworthy, so the segment is marked lossy instead of
 * silently truncated.
 */
export const TOOL_CALL_COLLECTOR_EVENT_CAP = 5_000;

/**
 * Hard bound on the harvest round-trip. The harness harvests inside
 * nativeObsidianHarness's 5s `beforeClose` budget, and a hook that overruns it
 * makes `close()` THROW — which would turn a passing lane red because of its
 * own instrumentation. Instrumentation must never be able to fail a lane, so a
 * slow harvest gives up and reports unknown instead.
 */
const HARVEST_TIMEOUT_MS = 2_000;

/** Raw page-side state for one arm generation. */
export interface ToolCallCollectorSegmentV1 {
  /** Monotonic arm generation, 0-based. */
  index: number;
  /** `droppedEventCount` reported by getMissionRunSnapshot() at arm time. */
  armDroppedEventCount: number | null;
  /** True when a mission was already running when this segment armed. */
  armedWhileRunning: boolean;
  /** True when the segment stopped recording because it hit the cap. */
  overflowed: boolean;
  events: ToolCallOutcomeEventV1[];
}

export interface ToolCallCollectorRawV1 {
  version: 1;
  segments: ToolCallCollectorSegmentV1[];
}

export interface ToolCallCollectorDiagnosticV1 {
  segmentIndex: number;
  kind: ToolCallOutcomeEventV1["kind"];
  /** Receipt ids are omitted; call ids contain only run/step/index/tool identity. */
  id: string | null;
  toolName: string | null;
  errorCode: string | null;
  ok: boolean | null;
  operation: string | null;
}

/**
 * Fold raw collector state into outcome counts. PURE — this is the whole
 * Node-side judgment surface of the collector, and every branch of it is
 * exercised by tests/toolCallCollector.test.ts.
 */
export function summarizeCollectedToolCallsV1(
  raw: ToolCallCollectorRawV1 | null | undefined,
): ToolCallOutcomeCountsV1 {
  const segments = Array.isArray(raw?.segments) ? raw!.segments : [];
  if (segments.length === 0) return unknownToolCallOutcomeCountsV1("unobserved");
  let merged: ToolCallOutcomeCountsV1 | null = null;
  for (const segment of segments) {
    const events = Array.isArray(segment?.events) ? segment.events : [];
    // A segment is lossy when it cannot account for the run's prefix: it armed
    // beside an already-running mission whose buffer had already dropped
    // events (or would not say), or it stopped recording at the cap. A
    // continuously subscribed segment receives every live event, so drops that
    // happen AFTER arming lose nothing.
    const lossy =
      segment?.overflowed === true ||
      (segment?.armedWhileRunning === true &&
        (segment.armDroppedEventCount === null ||
          segment.armDroppedEventCount > 0));
    const folded = foldToolCallOutcomesV1(
      events,
      lossy ? { coverage: "lossy" } : {},
    );
    merged = merged ? mergeToolCallOutcomeCountsV1(merged, folded) : folded;
  }
  return merged ?? unknownToolCallOutcomeCountsV1("unobserved");
}

/**
 * Pages this collector is currently armed on. A test that TIMES OUT never
 * reaches `harness.close()`, so the afterEach hook harvests straight from the
 * still-open page rather than losing the run.
 */
const armedPages = new Set<Page>();
/**
 * Harvests awaiting a record, keyed by the test that took them.
 *
 * Keyed, NOT a flat list: Playwright reuses a worker across spec files, and
 * `startRealAiHarness` arms for EVERY lane — including the many specs that do
 * not register the recorder. A flat accumulator would let one spec's harvest be
 * annotated onto a LATER spec's first test, which is a wrong number, the one
 * outcome this seam exists to prevent. An entry nobody records is dropped,
 * never inherited.
 */
const harvestsByTest = new Map<string, ToolCallOutcomeCountsV1[]>();
/** Bound on abandoned entries from specs that never registered the recorder. */
const MAX_RETAINED_TEST_HARVESTS = 64;

/**
 * Identity of the test currently executing, or null outside one. Playwright
 * throws from `test.info()` when there is no active test — exactly the case
 * where a harvest must not be attributed to anybody.
 */
function currentTestKey(): string | null {
  try {
    const info = test.info();
    return `${info.testId}:${info.repeatEachIndex}:${info.retry}`;
  } catch {
    return null;
  }
}

/**
 * Install (or re-install) the page-side collector. Idempotent per generation:
 * re-arming unsubscribes the previous subscription and opens a NEW segment, so
 * a mid-mission `restartCorePlugin` continues counting instead of going blind.
 *
 * Never throws when the subscription is unavailable: an un-armable page must
 * cost a row of unknown, not a lane failure the product did not cause.
 */
export async function armToolCallCollector(page: Page): Promise<void> {
  try {
    const armed = await page.evaluate(
      ({ pluginId, slotKey, eventCap }) => {
        const host = window as typeof window & Record<string, any>;
        const existing = host[slotKey] as
          | { segments: any[]; unsubscribe?: () => void }
          | undefined;
        try {
          existing?.unsubscribe?.();
        } catch {
          // A plugin restart already invalidated the old subscription.
        }
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        if (!plugin?.subscribeMissionEvents) return false;
        const snapshot = plugin.getMissionRunSnapshot?.() ?? null;
        const segment = {
          index: Array.isArray(existing?.segments)
            ? existing!.segments.length
            : 0,
          armDroppedEventCount: Number.isSafeInteger(
            snapshot?.droppedEventCount,
          )
            ? snapshot.droppedEventCount
            : null,
          armedWhileRunning: snapshot?.isRunning === true,
          overflowed: false,
          events: [] as unknown[],
        };
        const state = {
          version: 1,
          segments: [
            ...(Array.isArray(existing?.segments) ? existing!.segments : []),
            segment,
          ],
          unsubscribe: undefined as (() => void) | undefined,
        };
        host[slotKey] = state;

        const text = (value: unknown): string | null =>
          typeof value === "string" && value.length > 0 ? value : null;
        const codeOf = (value: any): string | null =>
          value && typeof value === "object" ? text(value.code) : null;
        const push = (event: unknown): void => {
          if (segment.events.length >= eventCap) {
            segment.overflowed = true;
            return;
          }
          segment.events.push(event);
        };
        state.unsubscribe = plugin.subscribeMissionEvents(
          {
            onTrace: (event: any) => {
              const kind = text(event?.kind);
              const id = text(event?.id);
              if (!id) return;
              if (kind === "tool_start") {
                push({ kind: "tool_start", id, toolName: text(event?.toolName) });
                return;
              }
              if (kind === "tool_result" || kind === "tool_rejected") {
                push({
                  kind,
                  id,
                  toolName: text(event?.toolName),
                  errorCode: codeOf(event?.error),
                });
              }
            },
            onToolDone: (event: any) => {
              const id = text(event?.id);
              if (!id) return;
              push({
                kind: "tool_done",
                id,
                toolName: text(event?.name) ?? text(event?.toolName),
                ok: typeof event?.ok === "boolean" ? event.ok : null,
                errorCode: codeOf(event?.error),
              });
            },
            onReceipt: (receipt: any) => {
              // Delta/commit projection ONLY: no paths, no payload text ever
              // crosses the page boundary.
              push({
                kind: "receipt",
                id: text(receipt?.id),
                toolName: text(receipt?.toolName),
                receipt: {
                  operation: receipt?.operation,
                  bytesWritten: receipt?.bytesWritten,
                  bytesDeleted: receipt?.bytesDeleted,
                  affectedCount: receipt?.affectedCount,
                  commitKind: receipt?.commitKind,
                  ...(receipt?.effects && typeof receipt.effects === "object"
                    ? { effects: { changed: receipt.effects.changed } }
                    : {}),
                },
              });
            },
          },
          // Replay recovers the buffered prefix when arming beside a run that
          // already started (the re-arm after restartCorePlugin). The fold
          // de-duplicates by (kind, id), so replayed and live events merge to
          // one exact count.
          { replay: true },
        );
        return true;
      },
      {
        pluginId: NATIVE_CORE_PLUGIN_ID,
        slotKey: TOOL_CALL_COLLECTOR_SLOT,
        eventCap: TOOL_CALL_COLLECTOR_EVENT_CAP,
      },
    );
    if (armed) armedPages.add(page);
  } catch {
    // An un-armable page simply reports unknown at harvest time.
  }
}

/**
 * Read the collector state off the page, clear the slot, and fold. Never
 * throws: a dead renderer or a missing slot yields an all-null (unknown)
 * result. The fold is parked for `recordToolCallOutcomesAfterEach`.
 */
export async function harvestToolCallCollector(
  page: Page,
): Promise<ToolCallOutcomeCountsV1> {
  let counts: ToolCallOutcomeCountsV1;
  try {
    const raw = await readToolCallCollectorRawV1(page, true);
    counts = summarizeCollectedToolCallsV1(raw);
  } catch {
    // Distinguishable from "never armed" only in intent; both are unknown, and
    // the honest report for both is all-null.
    counts = unknownToolCallOutcomeCountsV1("unobserved");
  }
  armedPages.delete(page);
  // Unknown harvests are parked too: merging one is a no-op, and keeping them
  // makes "the harness ran but proved nothing" visible instead of silent.
  const key = currentTestKey();
  if (key) {
    harvestsByTest.set(key, [...(harvestsByTest.get(key) ?? []), counts]);
    while (harvestsByTest.size > MAX_RETAINED_TEST_HARVESTS) {
      const oldest = harvestsByTest.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      harvestsByTest.delete(oldest);
    }
  }
  return counts;
}

/**
 * Read the current counters without consuming the collector. Live lanes can
 * assert their quantitative tool contract before teardown, while afterEach
 * still harvests the same stream for the durable report.
 */
export async function peekToolCallCollector(
  page: Page,
): Promise<ToolCallOutcomeCountsV1> {
  try {
    return summarizeCollectedToolCallsV1(
      await readToolCallCollectorRawV1(page, false),
    );
  } catch {
    // Instrumentation must never turn product work red merely because the
    // renderer disappeared during diagnosis; unknown is the honest result.
    return unknownToolCallOutcomeCountsV1("unobserved");
  }
}

/**
 * Read a bounded, content-free event projection for failed-lane diagnostics.
 * No arguments, paths, provider payloads, note text, or receipt ids cross the
 * renderer boundary.
 */
export async function peekToolCallCollectorDiagnosticsV1(
  page: Page,
): Promise<ToolCallCollectorDiagnosticV1[]> {
  try {
    const raw = await readToolCallCollectorRawV1(page, false);
    return (raw?.segments ?? [])
      .flatMap((segment) =>
        segment.events.map((event) => ({
          segmentIndex: segment.index,
          kind: event.kind,
          id: event.kind === "receipt" ? null : event.id,
          toolName: event.toolName,
          errorCode:
            event.kind === "tool_done" ||
            event.kind === "tool_result" ||
            event.kind === "tool_rejected"
              ? event.errorCode
              : null,
          ok: event.kind === "tool_done" ? event.ok : null,
          operation:
            event.kind === "receipt" &&
            typeof event.receipt.operation === "string"
              ? event.receipt.operation
              : null,
        })),
      )
      .slice(-64);
  } catch {
    return [];
  }
}

async function readToolCallCollectorRawV1(
  page: Page,
  consume: boolean,
): Promise<ToolCallCollectorRawV1 | null> {
  return (await withHarvestTimeout(page.evaluate(
    ({ slotKey, consumeSlot }) => {
      const host = window as typeof window & Record<string, any>;
      const state = host[slotKey];
      if (!state || !Array.isArray(state.segments)) return null;
      if (consumeSlot) {
        try {
          state.unsubscribe?.();
        } catch {
          // The events are already copied into the segment arrays.
        }
      }
      const projected = {
        version: 1,
        segments: state.segments.map((segment: any) => ({
          index: segment?.index,
          armDroppedEventCount: Number.isSafeInteger(
            segment?.armDroppedEventCount,
          )
            ? segment.armDroppedEventCount
            : null,
          armedWhileRunning: segment?.armedWhileRunning === true,
          overflowed: segment?.overflowed === true,
          events: Array.isArray(segment?.events)
            ? segment.events.map((event: object) => ({ ...event }))
            : [],
        })),
      };
      if (consumeSlot) delete host[slotKey];
      return projected;
    },
    { slotKey: TOOL_CALL_COLLECTOR_SLOT, consumeSlot: consume },
  ))) as ToolCallCollectorRawV1 | null;
}

/**
 * Merge everything harvested during the current test. A spec may open several
 * harnesses in one test; each contributes its own fold, and the merge sums
 * them (or degrades to unknown when any of them was lossy).
 */
export function collectedToolCallCountsForTestV1(
  harvests: readonly ToolCallOutcomeCountsV1[],
): ToolCallOutcomeCountsV1 {
  return harvests.reduce<ToolCallOutcomeCountsV1>(
    (left, right) => mergeToolCallOutcomeCountsV1(left, right),
    unknownToolCallOutcomeCountsV1("unobserved"),
  );
}

/** Annotate the current test with the folded counts. */
export function recordToolCallOutcomes(
  testInfo: TestInfo,
  counts: ToolCallOutcomeCountsV1,
): void {
  testInfo.annotations.push({
    type: DAILY_USE_TOOL_OUTCOMES_ANNOTATION,
    description: JSON.stringify(counts),
  });
}

/**
 * Register the per-spec afterEach that records whatever the harness harvested
 * at close, with a direct-harvest fallback for tests that never reached close
 * (timeouts, thrown teardown). One line per lane spec:
 *
 *   recordToolCallOutcomesAfterEach();
 *
 * The recorded entry is keyed by THIS test and deleted after recording, so a
 * later test whose harness never armed can never inherit an earlier test's
 * counts — across spec files in a reused worker included.
 */
export function recordToolCallOutcomesAfterEach(): void {
  test.afterEach(async ({}, testInfo) => {
    for (const page of [...armedPages]) {
      if (page.isClosed()) {
        armedPages.delete(page);
        continue;
      }
      // A test that timed out never reached harness.close(); harvest here so
      // the run is reported rather than lost.
      await harvestToolCallCollector(page);
    }
    const key = `${testInfo.testId}:${testInfo.repeatEachIndex}:${testInfo.retry}`;
    const harvests = harvestsByTest.get(key) ?? [];
    harvestsByTest.delete(key);
    armedPages.clear();
    recordToolCallOutcomes(testInfo, collectedToolCallCountsForTestV1(harvests));
  });
}

/**
 * Reject after HARVEST_TIMEOUT_MS so a slow renderer cannot overrun the
 * harness's bounded teardown budget. The caller turns the rejection into an
 * unknown result: missing data, never a failed lane and never a wrong number.
 */
function withHarvestTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("tool-call harvest timed out")),
        HARVEST_TIMEOUT_MS,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Test-only reset of the module-level accumulators. */
export function resetToolCallCollectorStateForTestsV1(): void {
  armedPages.clear();
  harvestsByTest.clear();
}
