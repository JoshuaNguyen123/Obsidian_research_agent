import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";

test.describe("real AI autonomy soak", () => {
  test.describe.configure({ mode: "default", timeout: 3_600_000, retries: 0 });

  for (const scenario of [
    {
      name: "deep vault retrieval and semantic expansion",
      setup: async (h: RealAiHarness) => {
        // These prefixes keep the owned fixtures inside the harness's bounded
        // initial semantic-index slice when no compatible index exists yet.
        const sourceA = `E2E Agent Tests/000-deep-a-${h.marker}.md`;
        const sourceB = `E2E Agent Tests/001-deep-b-${h.marker}.md`;
        await h.seedNote(sourceA, `# Deep A\n\nSemantic anchor ${h.marker} alpha.\n`);
        await h.seedNote(sourceB, `# Deep B\n\nSemantic anchor ${h.marker} beta.\n`);
        await h.indexSemanticNotes([sourceA, sourceB]);
      },
      prompt: (h: RealAiHarness) =>
        `Within one bounded mission, investigate my vault for ${h.marker}. Use semantic retrieval, batch-read only the paths returned by semantic retrieval without guessing paths or repeatedly reading one file at a time, and append a grounded synthesis to the current note. Do not use web or memory tools.`,
      requiredTools: ["semantic_search_notes", "append_to_current_file"],
      pluginDataOverrides: { autoContinueLongRuns: false },
    },
    {
      name: "long public-web research and source-cache reuse",
      setup: async () => undefined,
      prompt: (h: RealAiHarness) =>
        `Use only public-web evidence. Search the official Obsidian documentation for current plugin security guidance, fetch one relevant official page, and re-request that exact URL so the source cache can be reused. Append a synthesis with ${h.marker} to the current note using only claims supported by accepted fetched passages, with passage citations, limitations, confidence, and unanswered questions.`,
      requiredTools: ["web_search", "web_fetch", "append_to_current_file"],
      pluginDataOverrides: { autoContinueLongRuns: false },
    },
    {
      name: "generated output with genuine count_words follow-up",
      setup: async () => undefined,
      prompt: (h: RealAiHarness) =>
        `Write approximately 180 words about local-first research workflows to this note, include ${h.marker}, then use count_words to verify the generated note length.`,
      requiredTools: ["count_words", "append_to_current_file"],
      pluginDataOverrides: { autoContinueLongRuns: false },
    },
  ]) {
    test(scenario.name, async () => {
      let harness: RealAiHarness | null = null;
      try {
        harness = await startRealAiHarness(
          `soak-${scenario.name.replace(/\W+/gu, "-")}`,
          {},
          scenario.pluginDataOverrides,
        );
        await scenario.setup(harness);
        const before = await readFile(harness.noteFilePath, "utf8");
        await harness.submitMission(scenario.prompt(harness), {
          waitForCompletion: false,
          timeoutMs: 1_200_000,
        });
        await harness.approveUntilMissionComplete(1_200_000);
        const after = await readFile(harness.noteFilePath, "utf8");
        const snapshot = await harness.attestProductionRun();
        const graphNodes = Object.values(snapshot.lastMissionGraph.nodes) as any[];
        const appendReceipts = snapshot.lastReceipts.filter(
          (receipt: any) => receipt.operation === "append",
        );
        const safeState = JSON.stringify({
          complete: snapshot.lastComplete,
          nodes: graphNodes.map((node) => ({
            id: node.id,
            status: node.status,
            allowedTools: node.allowedTools,
            evidenceKinds: (node.evidence ?? []).map((item: any) => item.kind),
            receiptKinds: (node.receipts ?? []).map((item: any) => item.kind),
            blockerCode: node.blocker?.code ?? null,
          })),
          receiptOperations: snapshot.lastReceipts.map(
            (receipt: any) => receipt.operation,
          ),
          acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
          providerUsage: snapshot.providerUsage,
          diagnostics: snapshot.diagnosticAttestations,
        });
        expect(after.startsWith(before), safeState).toBe(true);
        expect(after, safeState).toContain(harness.marker);
        expect(snapshot.providerUsage.modelCallCount).toBeLessThanOrEqual(128);
        expect(appendReceipts, safeState).toHaveLength(1);
        expect(appendReceipts[0]?.readback, safeState).toBeTruthy();
        for (const toolName of scenario.requiredTools) {
          expect(
            graphNodes.some((node) => node.allowedTools?.includes(toolName)),
            `${toolName}: ${safeState}`,
          ).toBe(true);
        }
      } finally {
        await harness?.close();
      }
    });
  }

  test("restart resume does not replay a committed write", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("soak-restart-resume");
      await harness.submitMission(
        `Append exactly one durable line containing ${harness.marker}, verify that local note write, and finish. This task needs no web, memory, or vault research.`,
        { waitForCompletion: false },
      );
      await harness.approveUntilMissionComplete(1_200_000);
      const once = await readFile(harness.noteFilePath, "utf8");
      const firstSnapshot = await harness.attestProductionRun();
      const firstSafeState = JSON.stringify({
        complete: firstSnapshot.lastComplete,
        graph: firstSnapshot.lastMissionGraph,
        receipts: firstSnapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation,
          toolName: receipt.toolName,
          hasReadback: Boolean(receipt.readback),
        })),
        acceptance: firstSnapshot.lastMissionLedger?.acceptance ?? null,
        providerUsage: firstSnapshot.providerUsage,
        diagnostics: firstSnapshot.diagnosticAttestations,
      });
      expect(once.split(harness.marker), firstSafeState).toHaveLength(2);
      const runId = firstSnapshot.lastConfig?.runId ?? firstSnapshot.runId;
      expect(runId).toMatch(/^run-/u);
      await harness.restartCorePlugin();
      await harness.submitMission(`continue run ${runId}`);
      const resumed = await readFile(harness.noteFilePath, "utf8");
      expect(resumed.split(harness.marker)).toHaveLength(2);
      expect(resumed).toBe(once);
    } finally {
      await harness?.close();
    }
  });

  test("lead researcher orchestration keeps writeback lead-owned", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "soak-lead-researcher",
        {},
        {
          orchestratorEnabled: true,
          orchestratorPreviewEnabled: true,
          orchestratorWorkerMaxSteps: 8,
          orchestratorWorkerMaxToolCalls: 10,
          orchestratorWorkerMaxMinutes: 8,
        },
      );
      await harness.installOwnedWebBackend({ sourceCount: 3 });
      await harness.submitMission(
        `Run deep research as a Lead with a read-only Researcher handoff over the owned sources, then have only the Lead append the verified synthesis with ${harness.marker}.`,
        { timeoutMs: 1_200_000 },
      );
      const snapshot = await harness.attestProductionRun();
      const safeState = JSON.stringify({
        complete: snapshot.lastComplete,
        graph: snapshot.lastMissionGraph,
        receipts: snapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation,
          toolName: receipt.toolName,
          hasReadback: Boolean(receipt.readback),
        })),
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        conflicts: snapshot.redactedEvidenceConflicts ?? [],
        providerUsage: snapshot.providerUsage,
      });
      expect(
        snapshot.lastReceipts.filter((receipt: any) => receipt.operation === "append"),
        safeState,
      ).toHaveLength(1);
      expect(JSON.stringify(snapshot.lastMissionGraph), safeState).toMatch(/lead|research/iu);
    } finally {
      await harness?.close();
    }
  });

  test("approved vault CRUD chain preserves backups and receipts", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("soak-vault-crud");
      const sourcePath = `E2E Agent Tests/crud-source-${harness.marker}.md`;
      const movedPath = `E2E Agent Tests/crud-moved-${harness.marker}.md`;
      await harness.submitMission(
        `Create the exact markdown file ${sourcePath} with content "created ${harness.marker}". Read ${sourcePath}. Replace the entire content of ${sourcePath} with "updated ${harness.marker}". Move ${sourcePath} to ${movedPath}, then trash ${movedPath}. Request approval wherever required and preserve every receipt and readback.`,
        { waitForCompletion: false, timeoutMs: 1_200_000 },
      );
      const approvalCount = await harness.approveUntilMissionComplete(1_200_000);
      const snapshot = await harness.attestProductionRun();
      const safeState = JSON.stringify({
        approvalCount,
        complete: snapshot.lastComplete,
        graph: snapshot.lastMissionGraph,
        receipts: snapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation,
          toolName: receipt.toolName,
          backupPath: receipt.backupPath ?? null,
          hasReadback: Boolean(receipt.readback),
        })),
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
      });
      expect(approvalCount, safeState).toBeGreaterThan(0);
      expect(snapshot.lastReceipts.length, safeState).toBeGreaterThanOrEqual(4);
      expect(snapshot.lastReceipts.some((receipt: any) => receipt.backupPath), safeState).toBe(true);
    } finally {
      await harness?.close();
    }
  });

  test("diagram creation and revision produces structurally verified artifact", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("soak-diagram-revision");
      await harness.seedNote(
        harness.notePath,
        `# Live Provider Contract\n\nOwned live-provider fixture.\n\n## E2E Diagram\n`,
        true,
      );
      await harness.submitMission(
        `In the current note at the exact vault-relative path "${harness.notePath}" under the exact heading "E2E Diagram", create a small Mermaid diagram showing mission plan -> tool -> receipt and include ${harness.marker}. Use that heading as the Mermaid block selector. First read the selector to obtain the current note hash, create the block, read that saved Mermaid block back, then revise the same block in place to add a verification node and read it once more to validate the resulting structure.`,
        { waitForCompletion: false, timeoutMs: 1_200_000 },
      );
      const approvalCount = await harness.approveUntilMissionComplete(1_200_000);
      const snapshot = await harness.attestProductionRun();
      const safeState = JSON.stringify({
        approvalCount,
        complete: snapshot.lastComplete,
        graph: snapshot.lastMissionGraph,
        receipts: snapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation,
          toolName: receipt.toolName,
          hasReadback: Boolean(receipt.readback),
        })),
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        providerUsage: snapshot.providerUsage,
      });
      expect(JSON.stringify(snapshot.lastReceipts), safeState).toMatch(
        /diagram|create|edit|replace|mermaid/iu,
      );
      expect(approvalCount, safeState).toBeGreaterThanOrEqual(2);
    } finally {
      await harness?.close();
    }
  });
});
