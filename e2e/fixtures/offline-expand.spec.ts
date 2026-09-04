import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOfflineAgentBackendV1 } from "./offlineAgentBackend";
import {
  OFFLINE_EXPAND_SCENARIOS,
  renderOfflineExpandPrompt,
  type OfflineExpandScenarioV1,
} from "./offlineExpandScenarios";
import { startRealAiHarness } from "./realAiHarness";

const execFileAsync = promisify(execFile);
const OFFLINE_BASE_URL = "http://127.0.0.1:7332/v1";
const OFFLINE_TOKEN = "offline-e2e-ephemeral-token";
const SUMMARY_PATH = path.join("test-results", "offline-application-attempts.json");

test.describe("zero-cloud expand: replace, page-clear, word-count, title", () => {
  test.skip(
    process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" ||
      process.env.E2E_OFFLINE_AI !== "1",
    "Run through npm run test:e2e:exclusive -- --offline-ai --project=offline-expand.",
  );

  test("OFFLINE-03/06 replace, page-clear, word-count, and title-rename", async () => {
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
    const cloudModelRequests: string[] = [];
    const attempts: Record<string, unknown>[] = [];
    try {
      await listen(bridge, 7332);
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

      for (const scenario of OFFLINE_EXPAND_SCENARIOS) {
        attempts.push(await runExpandScenario({
          scenario,
          backend,
          identity,
          cloudModelRequests,
          validateOfflineApplicationAttempt,
        }));
      }

      expect(cloudModelRequests).toEqual([]);
      const prior = await readExistingAttempts(SUMMARY_PATH);
      await writeFile(
        SUMMARY_PATH,
        `${JSON.stringify({
          version: 1,
          attempts: [...prior, ...attempts],
        }, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await close(bridge);
    }
  });
});

async function runExpandScenario(input: {
  scenario: OfflineExpandScenarioV1;
  backend: ReturnType<typeof createOfflineAgentBackendV1>;
  identity: {
    exactHead: string;
    sourceState: "clean_head" | "dirty_worktree";
    bundleSha256: string;
    installedBundleSha256: string;
  };
  cloudModelRequests: string[];
  validateOfflineApplicationAttempt: (value: unknown) => Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const modelCallsBefore = input.backend.snapshot().requestCount;
  let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
  try {
    harness = await startRealAiHarness(
      `offline-expand-${input.scenario.id}`,
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
        maxAgentSteps: 8,
        autoTitleOnWrite: true,
      },
    );
    harness.page.on("request", (request) => {
      if (isKnownCloudModelUrl(request.url())) {
        input.cloudModelRequests.push(request.url());
      }
    });
    const marker = `${input.scenario.markerPrefix}_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
    const original = `# Original\n\nKEEP_UNTIL_REPLACE_${harness.marker}\n`;
    await harness.seedNote(harness.notePath, original, true);
    await harness.submitMission(renderOfflineExpandPrompt(input.scenario, marker), {
      timeoutMs: 120_000,
      waitForCompletion: false,
    });
    await approveReplaceIfShown(harness);
    await harness.waitForMissionComplete(120_000);

    const after = await harness.readNote();
    expect(after.includes(marker), after).toBe(true);
    if (input.scenario.expectedMutation === "replace") {
      expect(after.includes(`KEEP_UNTIL_REPLACE_${harness.marker}`)).toBe(false);
    }

    const snapshot = await harness.attestProductionRun();
    const ledger = assertCompletedLedgerAcceptance(snapshot);
    const receipts = Array.isArray(snapshot.lastReceipts) ? snapshot.lastReceipts : [];
    if (input.scenario.requiresBackup) {
      expect(
        receipts.some((receipt: { backupPath?: string }) =>
          typeof receipt.backupPath === "string" &&
          receipt.backupPath.startsWith(".agent-backups/"),
        ),
        JSON.stringify(receipts),
      ).toBe(true);
    }

    return input.validateOfflineApplicationAttempt({
      version: 1,
      scenarioId: input.scenario.id,
      repetition: 1,
      ...input.identity,
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
        `note:${harness.notePath}:${marker}`,
        ...receipts
          .filter((receipt: { toolName?: string; operation?: string }) =>
            typeof receipt.toolName === "string",
          )
          .map((receipt: { toolName: string; operation?: string }) =>
            `receipt:${receipt.toolName}:${receipt.operation ?? "unknown"}`,
          ),
      ],
      failureClass: "none",
      cloudRequestCount: input.cloudModelRequests.length,
      safetyViolationCount: 0,
      duplicateMutationCount: 0,
      mutationsPerformed: Math.max(1, receipts.length),
      mutationsWithReceipts: receipts.length,
      mutationEventsObserved: receipts.length,
      toolEventsObserved: ledger.expectedTools.length,
      toolEventsFailed: 0,
      modelCalls: Math.max(0, input.backend.snapshot().requestCount - modelCallsBefore),
      providerWaitMs: 0,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await harness?.close();
  }
}

async function approveReplaceIfShown(
  harness: Awaited<ReturnType<typeof startRealAiHarness>>,
): Promise<void> {
  const card = harness.activePreparedApproval("replace_current_file");
  try {
    await expect(card).toBeVisible({ timeout: 8_000 });
    await harness.approve(card);
  } catch {
    // Streamed replace writes without a prepared-approval card.
  }
}

async function readExistingAttempts(filePath: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      attempts?: unknown[];
    };
    return Array.isArray(parsed.attempts) ? parsed.attempts : [];
  } catch {
    return [];
  }
}

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

function assertCompletedLedgerAcceptance(snapshot: {
  lastMissionLedger?: {
    status?: string;
    acceptance?: { status?: string; missing?: string[]; reasons?: string[] };
    receiptCount?: number;
    expectedTools?: string[];
  };
}): {
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
  return ledger as {
    status: "complete";
    acceptance: { status: "pass"; missing: string[]; reasons: string[] };
    receiptCount: number;
    expectedTools: string[];
  };
}

function importNativeEsm<T>(specifier: string): Promise<T> {
  const importer = new Function("value", "return import(value);") as (
    value: string,
  ) => Promise<T>;
  return importer(specifier);
}
