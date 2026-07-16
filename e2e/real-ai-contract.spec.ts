import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";

test.describe("live provider contract pack", () => {
  test.describe.configure({ mode: "default", timeout: 900_000, retries: 0 });

  test("structured plan reads owned notes before one verified append", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-structured-vault-synthesis");
      const sourceA = `E2E Agent Tests/source-a-${harness.marker}.md`;
      const sourceB = `E2E Agent Tests/source-b-${harness.marker}.md`;
      await harness.seedNote(sourceA, "# Source A\n\nFinding Alpha: retention improved after shorter onboarding.\n");
      await harness.seedNote(sourceB, "# Source B\n\nFinding Beta: errors fell after validation moved before writes.\n");
      const before = await readFile(harness.noteFilePath, "utf8");
      await harness.submitMission(
        `Read the two named vault notes ${sourceA} and ${sourceB}. Synthesize exactly two findings and append them to the current note. Do not replace existing text. Include the marker ${harness.marker}.`,
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      const appendReceipts = snapshot.lastReceipts.filter((receipt: any) => receipt.operation === "append");
      const safeState = {
        complete: snapshot.lastComplete,
        nodes: Object.values(snapshot.lastMissionGraph.nodes).map((node: any) => ({
          id: node.id,
          status: node.status,
          allowedTools: node.allowedTools,
          evidenceCount: node.evidence?.length ?? 0,
          receiptCount: node.receipts?.length ?? 0,
          blocker: node.blocker ?? null,
        })),
        receiptOperations: snapshot.lastReceipts.map((receipt: any) => receipt.operation),
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        blockerCategory: snapshot.lastMissionLedger?.blockerCategory ?? null,
        providerUsage: snapshot.providerUsage,
      };
      expect(appendReceipts, JSON.stringify(safeState)).toHaveLength(1);
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain(harness.marker);
      expect(after).toMatch(/Alpha/iu);
      expect(after).toMatch(/Beta/iu);
      expect(appendReceipts[0]?.readback).toBeTruthy();
      expect(
        Object.values(snapshot.lastMissionGraph.nodes).every(
          (node: any) => node.status === "complete" || node.status === "cancelled",
        ),
        JSON.stringify(safeState),
      ).toBe(true);
    } finally {
      await harness?.close();
    }
  });

  test("DU-02 proof-gated sourced writeback binds owned fetched passages", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-owned-source-writeback");
      await harness.installOwnedWebBackend();
      const before = await readFile(harness.noteFilePath, "utf8");
      await harness.submitMission(
        `Search the web for the owned alpha and beta evidence, fetch both returned sources, verify exactly two finding sentences against the fetched passages, then append a short cited synthesis to the current note. End each finding sentence with the exact source:<id>:passage:<start>-<end> identifier returned by the fetch result that supports it, and use both fetched passage identifiers. Include ${harness.marker}. Do not write before fetch and verification.`,
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      const graphNodes = Object.values(snapshot.lastMissionGraph.nodes) as any[];
      const safeState = {
        complete: snapshot.lastComplete,
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        nodes: graphNodes.map((node) => ({
          id: node.id,
          status: node.status,
          allowedTools: node.allowedTools,
          evidenceKinds: (node.evidence ?? []).map((item: any) => item.kind),
          receiptKinds: (node.receipts ?? []).map((item: any) => item.kind),
          blockerCode: node.blocker?.code ?? null,
        })),
        receiptOperations: snapshot.lastReceipts.map((receipt: any) => receipt.operation),
        missionEvidence: snapshot.missionEvidence,
        diagnostics: snapshot.diagnosticAttestations,
        providerUsage: snapshot.providerUsage,
      };
      expect(after.startsWith(before)).toBe(true);
      expect(after, JSON.stringify(safeState)).toContain(harness.marker);
      expect(
        snapshot.lastReceipts.filter((receipt: any) => receipt.operation === "append"),
        JSON.stringify(safeState),
      ).toHaveLength(1);
      expect(graphNodes.some((node) => node.allowedTools?.includes("web_search"))).toBe(true);
      expect(graphNodes.some((node) => node.allowedTools?.includes("web_fetch"))).toBe(true);
      expect(
        snapshot.missionEvidence.some(
          (item: any) =>
            item.kind === "web_source" &&
            item.usableSource === true &&
            item.parserStatus === "parsed" &&
            Array.isArray(item.passageIds) &&
            item.passageIds.some((id: unknown) =>
              typeof id === "string" &&
              /^source:[a-z0-9-]+:passage:\d+-\d+$/u.test(id),
            ),
        ),
        JSON.stringify(safeState),
      ).toBe(true);
    } finally {
      await harness?.close();
    }
  });

  test("bounded recovery changes action after a retryable owned-source failure", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-bounded-recovery");
      await harness.installOwnedWebBackend({ failFirstFetch: true });
      await harness.submitMission(
        `Research the owned recovery evidence. Search first, fetch a result, and if that source is temporarily unavailable use the alternate returned source. Append only verified findings and include ${harness.marker}.`,
      );
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      const graphText = JSON.stringify(snapshot.lastMissionGraph);
      expect(graphText).toMatch(/retry|replan|alternate|blocked|complete/iu);
      expect(snapshot.providerUsage.modelCallCount).toBeLessThanOrEqual(80);
      expect(snapshot.lastComplete.stopReason === "write_completed" || snapshot.lastComplete.stopReason === "final" || snapshot.lastComplete.stopReason === "budget").toBe(true);
      if (snapshot.lastComplete.stopReason === "budget") {
        expect(snapshot.lastMissionLedger?.blockerCategory).not.toBe("unknown");
      }
    } finally {
      await harness?.close();
    }
  });

  test("whole-note replacement is byte-stable on denial and receipt-backed on approval", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-approval-replacement");
      const original = `# Original\n\nDO_NOT_MUTATE_${harness.marker}\n`;
      await harness.seedNote(harness.notePath, original, true);
      const prompt = `Replace the entire current note with exactly this markdown:\n# Approved Replacement\n\n${harness.marker}\n`;

      await harness.submitMission(prompt, { waitForCompletion: false });
      await harness.page.getByRole("tab", { name: "Run Details" }).click();
      const denied = harness.activePreparedApproval("replace_current_file");
      await expect(denied).toBeVisible({ timeout: harness.config.missionTimeoutMs });
      await expect(denied).toContainText("fingerprint=sha256:");
      expect(await readFile(harness.noteFilePath, "utf8")).toBe(original);
      await harness.deny(denied);
      await harness.waitForMissionComplete();
      expect(await readFile(harness.noteFilePath, "utf8")).toBe(original);

      await harness.submitMission(prompt, { waitForCompletion: false });
      await harness.page.getByRole("tab", { name: "Run Details" }).click();
      const approved = harness.activePreparedApproval("replace_current_file");
      await expect(approved).toBeVisible({ timeout: harness.config.missionTimeoutMs });
      await harness.approve(approved);
      await harness.waitForMissionComplete();
      const content = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      expect(content).toContain("# Approved Replacement");
      expect(content).toContain(harness.marker);
      expect(content).not.toContain("DO_NOT_MUTATE");
      const replacement = snapshot.lastReceipts.find((receipt: any) => receipt.operation === "replace");
      expect(replacement?.backupPath).toMatch(/^\.agent-backups\//u);
      expect(replacement?.readback).toBeTruthy();
    } finally {
      await harness?.close();
    }
  });
});
