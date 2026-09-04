import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOfflineAgentBackendV1 } from "./fixtures/offlineAgentBackend";
import { startRealAiHarness } from "./fixtures/realAiHarness";

const execFileAsync = promisify(execFile);
const OFFLINE_BASE_URL = "http://127.0.0.1:7331/v1";
const OFFLINE_TOKEN = "offline-e2e-ephemeral-token";
const SUMMARY_PATH = path.join("test-results", "offline-application-attempts.json");

test.describe("zero-cloud installed production client", () => {
  test.skip(
    process.env.E2E_PLAYWRIGHT_LANE !== "offline-core" ||
      process.env.E2E_OFFLINE_AI !== "1",
    "Run through npm run test:e2e:offline so the exclusive zero-cloud policy is active.",
  );

  test("OFFLINE-01/02 installed chat and note append use authenticated loopback", async () => {
    const backend = createOfflineAgentBackendV1();
    const { createAgentBridgeServer } = await importNativeEsm<{
      createAgentBridgeServer(options: {
        token: string;
        backend: typeof backend;
      }): Server;
    }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
    const { validateOfflineApplicationAttempt } = await importNativeEsm<{
      validateOfflineApplicationAttempt(value: unknown): Record<string, unknown>;
    }>(pathToFileURL(path.resolve("scripts", "offline-application-attempt.mjs")).href);
    const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
    let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
    const cloudModelRequests: string[] = [];
    const startedAt = Date.now();
    try {
      await listen(bridge, 7331);
      harness = await startRealAiHarness(
        "offline-core",
        {
          baseUrl: OFFLINE_BASE_URL,
          model: "offline-scripted-v1",
          missionTimeoutMs: 120_000,
          firstChunkTimeoutMs: 30_000,
          completionTimeoutMs: 120_000,
        },
        {
          modelRouterEnabled: false,
          modelRouterMode: "off",
          semanticIndexEnabled: false,
          enableStreaming: true,
          streamWritebackMode: "all_current_note_content_writes",
          workingMode: "automatic",
          maxAgentSteps: 6,
        },
      );
      harness.page.on("request", (request) => {
        if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
      });
      const marker = `OFFLINE_CHAT_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
      await harness.submitMission(
        `Answer in chat only with exactly ${marker}. Do not read or write notes and do not use tools.`,
        { timeoutMs: 120_000 },
      );
      await expect(
        harness.page
          .locator(".agentic-researcher-log-assistant .agentic-researcher-log-message")
          .filter({ hasText: marker })
          .last(),
      ).toBeVisible({ timeout: 30_000 });

      const productionState = await harness.page.evaluate(() => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.["agentic-researcher"];
        return {
          provider: plugin?.settings?.modelProvider ?? null,
          baseUrl: plugin?.settings?.openAiCompatibleBaseUrl ?? null,
          model: plugin?.settings?.model ?? null,
          descriptor: plugin?.createModelClient?.()?.descriptor ?? null,
          mockInstalled: Boolean(plugin?.__playwrightE2EMockInstalled),
        };
      });
      expect(productionState).toMatchObject({
        provider: "openai_compatible",
        baseUrl: OFFLINE_BASE_URL,
        model: "offline-scripted-v1",
        descriptor: {
          provider: "openai_compatible",
          model: "offline-scripted-v1",
          transportKind: "production",
        },
        mockInstalled: false,
      });

      const chatCompletedAt = Date.now();
      const chatModelCalls = backend.snapshot().requestCount;
      await harness.close();
      harness = await startRealAiHarness(
        "offline-core-append",
        {
          baseUrl: OFFLINE_BASE_URL,
          model: "offline-scripted-v1",
          missionTimeoutMs: 120_000,
          firstChunkTimeoutMs: 30_000,
          completionTimeoutMs: 120_000,
        },
        {
          modelRouterEnabled: false,
          modelRouterMode: "off",
          semanticIndexEnabled: false,
          enableStreaming: true,
          streamWritebackMode: "all_current_note_content_writes",
          workingMode: "automatic",
          maxAgentSteps: 6,
        },
      );
      harness.page.on("request", (request) => {
        if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
      });
      const beforeAppend = await harness.readNote();
      const appendStartedAt = Date.now();
      const appendMarker = `OFFLINE_APPEND_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
      await harness.submitMission(
        `Append exactly one new line containing ${appendMarker} to the current note. Do not replace existing content and do not use the web.`,
        { timeoutMs: 120_000 },
      );
      const afterAppend = await harness.readNote();
      expect(afterAppend.startsWith(beforeAppend)).toBe(true);
      const appendDebug = await harness.page.evaluate(() => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.["agentic-researcher"];
        const snapshot = plugin?.getMissionRunSnapshot?.() ?? null;
        return {
          status: document.querySelector(".agentic-researcher-status-primary")?.textContent ?? null,
          assistant: Array.from(document.querySelectorAll(
            ".agentic-researcher-log-assistant .agentic-researcher-log-message",
          )).map((element) => element.textContent),
          config: snapshot?.lastConfig
            ? {
                route: snapshot.lastConfig.route ?? null,
                writebackMode: snapshot.lastConfig.writebackMode ?? null,
                noteOutputPlan: snapshot.lastConfig.noteOutputPlan ?? null,
                currentNoteContext: snapshot.lastConfig.currentNoteContext ?? null,
              }
            : null,
          complete: snapshot?.lastComplete ?? null,
          stopReason: snapshot?.lastStopReason ?? null,
          receipts: snapshot?.lastReceipts ?? [],
          tools: snapshot?.lastToolTimeline ?? [],
        };
      });
      expect(
        afterAppend.split(appendMarker),
        JSON.stringify({ appendDebug, bridge: backend.snapshot() }),
      ).toHaveLength(2);

      const appendSnapshot = await harness.attestProductionRun();
      const appendReceipts = (appendSnapshot.lastReceipts ?? []).filter(
        (receipt: any) =>
          receipt.toolName === "append_to_current_file" &&
          receipt.operation === "append" &&
          receipt.path === harness?.notePath,
      );
      expect(appendReceipts).toHaveLength(1);
      expect(appendReceipts[0]?.readback).toBeTruthy();
      const appendLedger = assertCompletedLedgerAcceptance(appendSnapshot);
      expect(appendLedger.receiptCount).toBe(1);

      expect(cloudModelRequests).toEqual([]);
      const bridgeMetrics = backend.snapshot();
      expect(bridgeMetrics.requestCount).toBeGreaterThanOrEqual(3);
      expect(bridgeMetrics.emittedToolCalls).toBeGreaterThanOrEqual(1);

      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
      const { stdout: porcelain } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
      );
      const bundleSha256 = await sha256File(path.resolve("main.js"));
      const installedBundleSha256 = await sha256File(resolveInstalledMainPath());
      const identity = {
        exactHead: stdout.trim(),
        sourceState: porcelain.trim() ? "dirty_worktree" : "clean_head",
        bundleSha256,
        installedBundleSha256,
      } as const;
      expect(installedBundleSha256).toBe(bundleSha256);
      const chatAttempt = validateOfflineApplicationAttempt({
        version: 1,
        scenarioId: "chat_only",
        repetition: 1,
        ...identity,
        status: "passed",
        acceptanceStatus: "not_applicable",
        scorecardAcceptancePassed: false,
        scorecardTotal: null,
        scorecardDimensions: [],
        artifactReadbacks: [`chat:${marker}`],
        failureClass: "none",
        cloudRequestCount: cloudModelRequests.length,
        safetyViolationCount: 0,
        duplicateMutationCount: 0,
        mutationsPerformed: 0,
        mutationsWithReceipts: 0,
        mutationEventsObserved: 0,
        toolEventsObserved: 0,
        toolEventsFailed: 0,
        modelCalls: bridgeMetrics.requestCount,
        providerWaitMs: 0,
        durationMs: chatCompletedAt - startedAt,
      });
      const appendAttempt = validateOfflineApplicationAttempt({
        version: 1,
        scenarioId: "current_note_append",
        repetition: 1,
        ...identity,
        status: "passed",
        acceptanceStatus: "pass",
        scorecardAcceptancePassed: true,
        scorecardTotal: 1,
        scorecardDimensions: [
          { id: "artifact_correctness", score: 1 },
          { id: "receipt_coverage", score: 1 },
          { id: "mutation_uniqueness", score: 1 },
        ],
        artifactReadbacks: [
          `note:${harness.notePath}:${appendMarker}`,
          `receipt:${appendReceipts[0].toolName}:${appendReceipts[0].operation}`,
        ],
        failureClass: "none",
        cloudRequestCount: cloudModelRequests.length,
        safetyViolationCount: 0,
        duplicateMutationCount: 0,
        mutationsPerformed: 1,
        mutationsWithReceipts: appendReceipts.length,
        mutationEventsObserved: 1,
        toolEventsObserved: appendLedger.expectedTools.length,
        toolEventsFailed: 0,
        modelCalls: Math.max(0, bridgeMetrics.requestCount - chatModelCalls),
        providerWaitMs: 0,
        durationMs: Date.now() - appendStartedAt,
      });
      expect(cloudModelRequests).toEqual([]);
      await writeFile(
        SUMMARY_PATH,
        `${JSON.stringify({
          version: 1,
          attempts: [chatAttempt, appendAttempt],
        }, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await harness?.close();
      await close(bridge);
    }
  });
});

function isKnownCloudModelUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "ollama.com" ||
      host === "api.openai.com" ||
      host.endsWith(".openai.azure.com") ||
      host === "openrouter.ai";
  } catch {
    return false;
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function resolveInstalledMainPath(): string {
  const vaultPath = process.env.OBSIDIAN_VAULT?.trim() || path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    "OneDrive",
    "Desktop",
    "test_vault_obsidian_ai",
  );
  return path.join(vaultPath, ".obsidian", "plugins", "agentic-researcher", "main.js");
}

function assertCompletedLedgerAcceptance(snapshot: any): {
  status: "complete";
  acceptance: { status: "pass"; missing: string[]; reasons: string[] };
  receiptCount: number;
  expectedTools: string[];
} {
  const ledger = snapshot?.lastMissionLedger;
  expect(ledger?.status, JSON.stringify(ledger)).toBe("complete");
  expect(ledger?.acceptance?.status).toBe("pass");
  expect(ledger?.acceptance?.missing ?? []).toEqual([]);
  expect(
    (ledger?.acceptance?.reasons ?? []).some(
      (reason: unknown) =>
        typeof reason === "string" && reason.startsWith("failed_tools="),
    ),
  ).toBe(false);
  expect(ledger?.receiptCount).toEqual(expect.any(Number));
  expect(Array.isArray(ledger?.expectedTools)).toBe(true);
  return ledger;
}

/** Playwright loads specs through CJS; keep the production bridge native ESM. */
function importNativeEsm<T>(specifier: string): Promise<T> {
  const importer = new Function("value", "return import(value);") as (
    value: string,
  ) => Promise<T>;
  return importer(specifier);
}
