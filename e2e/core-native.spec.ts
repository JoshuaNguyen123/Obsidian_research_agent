import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonCanvas } from "../src/design/jsonCanvas";
import {
  evaluateBriefCanvasBinding,
  evaluateTransformerBriefMarkdown,
  evaluateTransformerCanvas,
} from "./fixtures/coreMissionRelevance";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import {
  attachMissionE2EProof,
  sha256Text,
  type MissionE2EProofV1,
} from "./fixtures/missionE2EProof";
import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";

const TRANSFORMER_BRIEF_PROMPT =
  "Can you write me a brief including diagrams, explaining in depth the transformer architecture and its importance?";

test.describe("Core native product health", () => {
  test.describe.configure({ mode: "default", timeout: 900_000, retries: 0 });

  test("CORE-01 exact transformer brief creates a relevant note and Canvas without invented research", async ({}, testInfo) => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "core-transformer-brief",
        {},
        {
          autoTitleOnWrite: true,
          enableStreaming: false,
          thinkingMode: "off",
          orchestratorEnabled: false,
          agenticReflexEnabled: false,
          speechActSemanticRescueMode: "off",
          requestTimeoutMs: 90_000,
          maxRunMinutes: 5,
          maxAgentSteps: 12,
        },
        { placeholderCurrentNote: true },
      );

      const expectedCanvasPath =
        `Designs/e2e-core-transformer-${harness.marker}.canvas`;
      const missionPrompt =
        `${TRANSFORMER_BRIEF_PROMPT} Save the diagram Canvas as ` +
        `\`${expectedCanvasPath}\`.`;
      await harness.submitMission(missionPrompt, {
        timeoutMs: 8 * 60_000,
      });
      const snapshot = await harness.attestProductionRun({
        requireStructuredRouting: true,
      });
      const receipts = Array.isArray(snapshot.lastReceipts)
        ? snapshot.lastReceipts
        : [];
      const graphNodes = Object.values(
        snapshot.lastMissionGraph?.nodes ?? {},
      ) as any[];
      const appendReceipt = receipts.find(
        (receipt: any) =>
          receipt.toolName === "append_to_current_file" &&
          receipt.operation === "append",
      );
      const canvasReceipt = receipts.find(
        (receipt: any) =>
          receipt.toolName === "create_design_canvas" &&
          receipt.operation === "create" &&
          typeof receipt.path === "string" &&
          receipt.path.endsWith(".canvas"),
      );
      const renameReceipt = receipts.find(
        (receipt: any) =>
          receipt.toolName === "rename_current_file" &&
          receipt.operation === "rename_current_file" &&
          typeof receipt.toPath === "string",
      );
      const markdownPath = renameReceipt?.toPath ?? appendReceipt?.path;
      const canvasPath = canvasReceipt?.path;
      const terminalGraph =
        graphNodes.length > 0 &&
        graphNodes.every((node: any) =>
          ["complete", "cancelled"].includes(node.status),
        );
      const graphToolNames = graphNodes.flatMap((node: any) => [
        ...(Array.isArray(node.allowedTools) ? node.allowedTools : []),
        ...(Array.isArray(node.plannedTools) ? node.plannedTools : []),
      ]);
      const noUnrequestedResearch =
        snapshot.lastConfig?.effortDecision?.researchDepth === "none" &&
        !graphToolNames.some((name: unknown) =>
          ["web_search", "web_fetch"].includes(String(name)),
        ) &&
        !snapshot.missionEvidence.some((item: any) =>
          ["web_source", "vault_note"].includes(item?.kind),
        );
      const visibleChatLines = await harness.page
        .locator(".agentic-researcher-log .agentic-researcher-log-message")
        .allTextContents();
      const safeState = {
        runId: snapshot.runId ?? null,
        stopReason: snapshot.lastComplete?.stopReason ?? null,
        acceptance: snapshot.lastMissionLedger?.acceptance?.status ?? null,
        researchDepth:
          snapshot.lastConfig?.effortDecision?.researchDepth ?? null,
        allowedTools: snapshot.lastConfig?.allowedToolNames ?? [],
        receiptKinds: receipts.map((receipt: any) => ({
          toolName: receipt.toolName ?? null,
          operation: receipt.operation ?? null,
          path: receipt.path ?? null,
          toPath: receipt.toPath ?? null,
          readback: receipt.readback?.status ?? null,
        })),
        graphNodes: graphNodes.map((node: any) => ({
          id: node.id,
          status: node.status,
          allowedTools: node.allowedTools,
          blockerCode: node.blocker?.code ?? null,
          blockerMessage: node.blocker?.message ?? null,
        })),
        diagnostics: (snapshot.diagnosticAttestations ?? [])
          .slice(-8)
          .map((item: any) => ({
            kind: item.kind ?? null,
            toolName: item.toolName ?? null,
            code: item.error?.code ?? null,
            message: item.error?.message ?? item.message ?? null,
          })),
        providerUsage: snapshot.providerUsage,
        visibleChatLines,
      };

      await testInfo.attach("native-run-state.json", {
        body: Buffer.from(JSON.stringify(safeState, null, 2), "utf8"),
        contentType: "application/json",
      });
      const stateScreenshotPath = testInfo.outputPath(
        "core-01-transformer-final-state.png",
      );
      await harness.page.screenshot({
        path: stateScreenshotPath,
        fullPage: true,
      });
      await testInfo.attach("core-01-transformer-final-state", {
        path: stateScreenshotPath,
        contentType: "image/png",
      });
      const staleBlockerVisible = await harness.page
        .locator(".agentic-researcher-chat-attention")
        .filter({ hasText: /Blocked|Mission blocked/iu })
        .isVisible()
        .catch(() => false);
      const staleBlockerTranscriptLines = visibleChatLines.filter((line) =>
        /^\s*(?:Blocked|Mission blocked)\b/iu.test(line),
      );

      expect(appendReceipt, JSON.stringify(safeState)).toBeTruthy();
      expect(canvasReceipt, JSON.stringify(safeState)).toBeTruthy();
      expect(typeof markdownPath, JSON.stringify(safeState)).toBe("string");
      expect(typeof canvasPath, JSON.stringify(safeState)).toBe("string");
      expect(canvasPath, JSON.stringify(safeState)).toBe(expectedCanvasPath);
      expect(terminalGraph, JSON.stringify(safeState)).toBe(true);
      expect(noUnrequestedResearch, JSON.stringify(safeState)).toBe(true);
      expect(staleBlockerVisible, JSON.stringify(safeState)).toBe(false);
      expect(
        staleBlockerTranscriptLines,
        JSON.stringify(safeState),
      ).toEqual([]);
      expect(
        snapshot.lastMissionLedger?.acceptance?.status,
        JSON.stringify(safeState),
      ).toBe("pass");
      expect(snapshot.lastMissionScorecard?.acceptancePassed).toBe(true);

      const markdownBytes = await readFile(
        join(harness.vaultRoot, ...String(markdownPath).split("/")),
      );
      const canvasBytes = await readFile(
        join(harness.vaultRoot, ...String(canvasPath).split("/")),
      );
      const markdown = markdownBytes.toString("utf8");
      const canvas = JSON.parse(canvasBytes.toString("utf8")) as JsonCanvas;
      await testInfo.attach("transformer-brief.md", {
        body: markdownBytes,
        contentType: "text/markdown",
      });
      await testInfo.attach("transformer-architecture.canvas.json", {
        body: canvasBytes,
        contentType: "application/json",
      });
      const markdownRelevance = evaluateTransformerBriefMarkdown(markdown);
      const canvasRelevance = evaluateTransformerCanvas(canvas);
      const bindingRelevance = evaluateBriefCanvasBinding(
        markdown,
        String(canvasPath),
      );
      const relevance = [
        markdownRelevance,
        canvasRelevance,
        bindingRelevance,
      ];
      for (const evaluation of relevance) {
        expect(evaluation.passed, JSON.stringify(evaluation)).toBe(true);
      }

      const productionModelCalls = snapshot.modelCallEvidence.filter(
        (item: any) =>
          item.outcome === "success" &&
          item.transportKind === "production" &&
          item.responseChars > 0,
      ).length;
      const proof: MissionE2EProofV1 = {
        version: 1,
        scenarioId: "CORE-01",
        promptSha256: sha256Text(missionPrompt),
        runId: String(snapshot.runId),
        productionModelCalls,
        graphTerminal: terminalGraph,
        noUnrequestedResearch,
        acceptanceStatus:
          snapshot.lastMissionLedger?.acceptance?.status ?? null,
        receipts: receipts.map((receipt: any) => ({
          toolName:
            typeof receipt.toolName === "string" ? receipt.toolName : null,
          operation:
            typeof receipt.operation === "string" ? receipt.operation : null,
          path: typeof receipt.path === "string" ? receipt.path : null,
          toPath:
            typeof receipt.toPath === "string" ? receipt.toPath : null,
          readbackStatus:
            typeof receipt.readback?.status === "string"
              ? receipt.readback.status
              : null,
        })),
        artifacts: [
          {
            kind: "markdown",
            path: String(markdownPath),
            bytes: markdownBytes.byteLength,
            sha256: sha256Text(markdownBytes),
          },
          {
            kind: "canvas",
            path: String(canvasPath),
            bytes: canvasBytes.byteLength,
            sha256: sha256Text(canvasBytes),
          },
        ],
        relevance,
      };
      await attachMissionE2EProof(testInfo, proof);

      const observed = {
        artifacts: [
          "vault:transformer_brief",
          "vault:transformer_canvas",
        ],
        proofs: [
          "model:production_call",
          "route:no_unrequested_research",
          "graph:terminal",
          "receipt:markdown_note",
          "receipt:canvas",
          "relevance:transformer_brief",
          "relevance:transformer_canvas",
        ],
        approvals: [],
        bindings: ["binding:brief_canvas"],
        cleanup: [],
      };
      const counters = harness.readProgressCounters();
      await recordDailyUseAcceptance(
        testInfo,
        "CORE-01",
        observed,
        {
          modelCalls: productionModelCalls,
          toolCalls: receipts.length,
          continuations: counters.continuations,
          approvals: counters.approvals,
          missionScorecard: snapshot.lastMissionScorecard,
        },
        { requireComplete: true },
      );
    } finally {
      await harness?.close();
    }
  });
});
