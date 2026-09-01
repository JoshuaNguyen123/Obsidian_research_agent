import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import {
  peekToolCallCollector,
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

  test("a mission killed mid-flight resumes and completes the remaining work", async () => {
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
          return {
            runId: typeof snapshot?.runId === "string" ? snapshot.runId : null,
            isRunning: snapshot?.isRunning === true,
            state: typeof snapshot?.state === "string" ? snapshot.state : null,
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

      // Wait for an interruption window: part A committed but B still pending,
      // or 90s of pre-write flight. Both parts landing first = missed window.
      const submittedAtMs = Date.now();
      let interruptWindow: "pre-first-write" | "between-writes" | null = null;
      await expect
        .poll(
          async () => {
            const note = await readFile(harness!.noteFilePath, "utf8").catch(() => "");
            const hasA = note.includes(markerA);
            const hasB = note.includes(markerB);
            if (hasA && hasB) return "missed";
            if (hasA) {
              interruptWindow = "between-writes";
              return "ready";
            }
            if (Date.now() - submittedAtMs > 90_000) {
              interruptWindow = "pre-first-write";
              return "ready";
            }
            return "waiting";
          },
          { timeout: 480_000, intervals: [2_000] },
        )
        .not.toBe("waiting");
      if (interruptWindow === null) {
        throw new Error(
          "process:interrupt_window_missed — both appends landed before the restart; rerun the attempt.",
        );
      }

      // Kill the plugin mid-flight and resume the same run.
      await harness.restartCorePlugin();
      expect(runId).toMatch(/^run-/u);
      await harness.submitMission(`continue run ${runId}`, { waitForCompletion: false });
      await harness.approveUntilMissionComplete(900_000);

      const note = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun();
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

      // A green end state is not enough: the pre-fix run reached both markers
      // through one successful append after four rejected calls. Require two
      // real write successes and zero failures across both restart segments.
      const toolOutcomes = await peekToolCallCollector(harness.page);
      const toolOutcomeEvidence = JSON.stringify({
        interruptWindow,
        toolOutcomes,
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
            blockerCode: node.blocker?.code ?? null,
          }),
        ),
      });
      expect(toolOutcomes.coverage, toolOutcomeEvidence).toBe("complete");
      expect(toolOutcomes.succeededWithWork, toolOutcomeEvidence).toBe(2);
      expect(toolOutcomes.failed, toolOutcomeEvidence).toBe(0);
      expect(toolOutcomes.vacuous, toolOutcomeEvidence).toBe(0);
    } finally {
      await harness?.close();
    }
  });
});
