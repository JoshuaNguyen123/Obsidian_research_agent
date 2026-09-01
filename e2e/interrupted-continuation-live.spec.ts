import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import {
  peekToolCallCollector,
  peekToolCallCollectorDiagnosticsV1,
  recordToolCallOutcomesAfterEach,
} from "./fixtures/toolCallCollector";

// Counting survives this lane's mid-mission restartCorePlugin: the harness
// re-arms a new collector segment after the plugin comes back, each segment is
// folded on its own, and a segment that cannot prove it saw the resumed run's
// prefix makes the whole answer UNKNOWN rather than a short count.
recordToolCallOutcomesAfterEach();

/**
 * Interrupt-and-COMPLETE continuation proof.
 *
 * The soak's restart-resume test proves a committed write is not replayed; this
 * lane proves the stronger daily-use contract: a mission killed mid-flight,
 * resumed with `continue run <id>`, FINISHES the remaining work. The mission is
 * two ordered appends with distinct markers so the interruption point is
 * observable from the note file alone:
 *   - restart before part A landed  -> resume must deliver A and B
 *   - restart after A, before B     -> resume must deliver exactly B
 * If both parts land before the restart fires, the interruption window was
 * missed and the lane fails with a distinct process-class message (retry the
 * attempt; it is not a product verdict).
 */
test.describe("interrupted continuation", () => {
  test.describe.configure({ mode: "default", timeout: 1_500_000, retries: 0 });

  test("INTERRUPT-01 a mission killed mid-flight resumes and completes the remaining work", async ({}, testInfo) => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("interrupted-continuation", {}, {
        autoContinueLongRuns: false,
      });
      const markerA = `${harness.marker}A1`;
      const markerB = `${harness.marker}B2`;
      await harness.submitMission(
        `Perform exactly two ordered durable appends to the current note, then finish. ` +
          `First append exactly one line containing ${markerA} and verify that write. ` +
          `Then append exactly one separate line containing ${markerB} and verify that write. ` +
          `Two appends total, in that order. This task needs no web, memory, or vault research.`,
        { waitForCompletion: false },
      );

      const readRunSnapshot = () =>
        harness!.page.evaluate((pluginId) => {
          const plugin = (window as typeof window & { app?: any }).app?.plugins
            ?.plugins?.[pluginId];
          const snapshot = plugin?.getMissionRunSnapshot?.();
          const appendNodes = Object.values(
            snapshot?.lastMissionGraph?.nodes ?? {},
          ).filter(
            (node: any) =>
              Array.isArray(node?.allowedTools) &&
              node.allowedTools.includes("append_to_current_file"),
          );
          return {
            runId: typeof snapshot?.runId === "string" ? snapshot.runId : null,
            isRunning: snapshot?.isRunning === true,
            state: typeof snapshot?.state === "string" ? snapshot.state : null,
            appendNodeStatuses: appendNodes.map((node: any) => node.status),
            appendReceiptCount: Array.isArray(snapshot?.lastReceipts)
              ? snapshot.lastReceipts.filter(
                  (receipt: any) => receipt?.operation === "append",
                ).length
              : 0,
          };
        }, NATIVE_CORE_PLUGIN_ID);

      // Capture the live run identity before interrupting anything.
      let runId: string | null = null;
      await expect
        .poll(async () => {
          const snapshot = await readRunSnapshot();
          if (snapshot.runId) runId = snapshot.runId;
          return snapshot.runId;
        }, { timeout: 120_000, message: "the submitted mission must publish a run id" })
        .toMatch(/^run-/u);

      // Wait for a DURABLE interruption window: a persisted two-append graph
      // before either receipt, part A committed with B pending, or a bounded
      // pre-planning flight. Polling only the note every two seconds raced the
      // provider's fast two-call batch and mislabeled a completed old segment
      // as "pre-first-write".
      const submittedAtMs = Date.now();
      let interruptWindow: "pre-first-write" | "between-writes" | null = null;
      await expect
        .poll(
          async () => {
            const note = await readFile(harness!.noteFilePath, "utf8").catch(() => "");
            const hasA = note.includes(markerA);
            const hasB = note.includes(markerB);
            const snapshot = await readRunSnapshot();
            if (hasA && hasB || snapshot.appendReceiptCount >= 2) return "missed";
            if (hasA || snapshot.appendReceiptCount === 1) {
              interruptWindow = "between-writes";
              return "ready";
            }
            if (
              snapshot.appendNodeStatuses.length >= 2 &&
              snapshot.appendNodeStatuses.every(
                (status) => status !== "complete" && status !== "cancelled",
              )
            ) {
              interruptWindow = "pre-first-write";
              return "ready";
            }
            if (Date.now() - submittedAtMs > 30_000) {
              interruptWindow = "pre-first-write";
              return "ready";
            }
            return "waiting";
          },
          { timeout: 480_000, intervals: [100] },
        )
        .not.toBe("waiting");
      if (interruptWindow === null) {
        throw new Error(
          "process:interrupt_window_missed — both appends landed before the restart; rerun the attempt.",
        );
      }

      // Kill the plugin mid-flight and resume the same run.
      await harness.restartCorePlugin();
      const postRestartNote = await readFile(harness.noteFilePath, "utf8");
      const postRestartHasA = postRestartNote.includes(markerA);
      const postRestartHasB = postRestartNote.includes(markerB);
      if (postRestartHasA && postRestartHasB) {
        throw new Error(
          "process:interrupt_window_missed — both appends settled in the old coordinator before restart completed; rerun the attempt.",
        );
      }
      if (postRestartHasB && !postRestartHasA) {
        throw new Error(
          "product:ordered_append_invariant — part B landed before part A during shutdown.",
        );
      }
      interruptWindow = postRestartHasA ? "between-writes" : "pre-first-write";
      expect(runId).toMatch(/^run-/u);
      await harness.submitMission(`continue run ${runId}`, { waitForCompletion: false });
      await harness.approveUntilMissionComplete(900_000);

      const note = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({
        allowVerifiedNoModelResume: true,
      });
      const safeState = JSON.stringify({
        interruptWindow,
        complete: snapshot.lastComplete,
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        receipts: snapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation,
          toolName: receipt.toolName,
          hasReadback: Boolean(receipt.readback),
        })),
        providerUsage: snapshot.providerUsage,
      });

      // The ordered append graph is authority-complete. Resume must expose
      // only its one ready append at a time; capability reads previously
      // widened this to 15 tools and GLM Flash chose read_current_file twice,
      // tripping the production no-progress circuit with part B still owed.
      expect(
        snapshot.lastComplete?.autonomyStats?.toolsOffered?.max,
        safeState,
      ).toBeLessThanOrEqual(1);
      expect(snapshot.lastComplete?.autoContinueReason, safeState).not.toBe(
        "no_progress",
      );

      // The remaining work completed: both parts exactly once — the resumed
      // segment neither replayed a committed append nor abandoned a pending one.
      expect(note.split(markerA).length - 1, safeState).toBe(1);
      expect(note.split(markerB).length - 1, safeState).toBe(1);
      const appendReceipts = snapshot.lastReceipts.filter(
        (receipt: any) => receipt.operation === "append",
      );
      expect(appendReceipts.length, safeState).toBe(2);
      expect(
        appendReceipts.every(
          (receipt: any) =>
            (typeof receipt.bytesWritten === "number" &&
              receipt.bytesWritten > 0) ||
            receipt.effects?.changed === true,
        ),
        safeState,
      ).toBe(true);
      expect(
        snapshot.lastMissionLedger?.acceptance?.status,
        safeState,
      ).toBe("pass");
      expect(snapshot.lastMissionLedger?.runId, safeState).toBe(runId);
      expect(snapshot.lastMissionScorecard, safeState).toBeTruthy();
      expect(snapshot.lastMissionScorecard?.acceptancePassed, safeState).toBe(true);

      // A green end state is not enough: the pre-fix run reached both markers
      // through one successful append after four rejected calls. Require two
      // real write successes and zero failures across both restart segments.
      const toolOutcomes = await peekToolCallCollector(harness.page);
      const collectorDiagnostics =
        await peekToolCallCollectorDiagnosticsV1(harness.page);
      const toolOutcomeEvidence = JSON.stringify({
        interruptWindow,
        toolOutcomes,
        collectorDiagnostics,
        // Sanitized coordinator attestations only: these expose the projected
        // tool names and rejected step/name, never provider payloads, note
        // content, paths, or credentials. Aggregate-only failures previously
        // could not distinguish a projection miss from a graph-sequencing bug.
        diagnostics: (snapshot.diagnosticAttestations ?? [])
          .filter(
            (item: any) =>
              /^agent-step-response-/u.test(item?.id ?? "") ||
              /^mission-graph-tool-frontier-/u.test(item?.id ?? "") ||
              /^ordered-current-note-append-frontier-projection-/u.test(
                item?.id ?? "",
              ) ||
              /:(?:graph-)?rejected$/u.test(item?.id ?? ""),
          )
          .map((item: any) => ({
            id: item.id,
            kind: item.kind,
            step: item.step,
            toolName: item.toolName,
            message: item.message,
            errorCode: item.errorCode,
          })),
        configuredAllowedTools: snapshot.lastConfig?.allowedToolNames ?? null,
        graph: Object.values(snapshot.lastMissionGraph?.nodes ?? {}).map(
          (node: any) => ({
            id: node.id,
            status: node.status,
            allowedTools: node.allowedTools,
            attempts: node.retries?.attempts ?? 0,
            evidenceKinds: Array.isArray(node.evidence)
              ? node.evidence.map((item: any) => item.kind)
              : [],
            verificationStatus: node.verification?.status ?? null,
            blockerCode: node.blocker?.code ?? null,
          }),
        ),
      });
      expect(toolOutcomes.coverage, toolOutcomeEvidence).toBe("complete");
      expect(toolOutcomes.succeededWithWork, toolOutcomeEvidence).toBe(2);
      expect(toolOutcomes.failed, toolOutcomeEvidence).toBe(0);
      expect(toolOutcomes.vacuous, toolOutcomeEvidence).toBe(0);
      await recordDailyUseAcceptance(
        testInfo,
        "INTERRUPT-01",
        {
          artifacts: ["vault:ordered_two_part_writeback"],
          proofs: [
            "restart:midflight",
            "restart:no_replay",
            "order:preserved",
            "receipt:two_appends",
            "graph:terminal",
            "tool_calls:complete_zero_failure",
          ],
          approvals: [],
          bindings: ["binding:resume_same_run"],
          cleanup: [],
        },
        {
          modelCalls: snapshot.providerUsage.modelCallCount,
          toolCalls: toolOutcomes.attempted ?? 0,
          continuations: 1,
          missionScorecard: snapshot.lastMissionScorecard,
          toolCallsAttempted: toolOutcomes.attempted,
          toolCallsFailed: toolOutcomes.failed,
          toolCallsVacuous: toolOutcomes.vacuous,
          toolCallsIntentionalNoOp: toolOutcomes.intentionalNoOp,
          refusalBuckets: toolOutcomes.failureBuckets,
        },
        { requireComplete: true },
      );
    } finally {
      await harness?.close();
    }
  });
});
