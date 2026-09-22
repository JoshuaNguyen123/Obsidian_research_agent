import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOfflineAgentBackendV1 } from "./fixtures/offlineAgentBackend";
import { startRealAiHarness } from "./fixtures/realAiHarness";
import { beginOfflineAttempt, saveOfflineAttempt, observeOfflineTools, readOfflineToolCounts, boundedOfflineRead } from "./fixtures/offlineEvidence";
import { recordToolCallOutcomesAfterEach } from "./fixtures/toolCallCollector";

const execFileAsync = promisify(execFile);
const OFFLINE_BASE_URL = "http://127.0.0.1:7331/v1";
const OFFLINE_TOKEN = "offline-e2e-ephemeral-token";

// Registers the per-test recorder that annotates each result with the tool-call
// outcome counts harvested from the armed collector. `startRealAiHarness` ARMS the
// collector for this lane, but arming alone only buffers calls in the page; without
// this registration nothing harvests or annotates them, so the lane exits green with
// an empty evidence set -- a green that proves nothing. Every other native spec
// registers it at module scope; this lane was the only one that did not.
recordToolCallOutcomesAfterEach();

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
    const identity = await currentBuildIdentity();
    let modelCallsBefore = backend.snapshot().requestCount;
    let attempt = beginOfflineAttempt(identity, "chat_only");
    await saveOfflineAttempt(attempt);
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
      await observeOfflineTools(harness.page);
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
      const chatCounts = await readOfflineToolCounts(harness.page);
      expect(chatCounts).toEqual({ toolEventsObserved: 0, toolEventsFailed: 0 });
      attempt = validateOfflineApplicationAttempt({
        ...attempt, status: "passed", acceptanceStatus: "not_applicable", failureClass: "none", failureDetail: "",
        artifactReadbacks: [`chat:${marker}`], cloudRequestCount: cloudModelRequests.length,
        safetyViolationCount: 0, duplicateMutationCount: 0, mutationsPerformed: 0,
        mutationsWithReceipts: 0, mutationEventsObserved: 0, ...chatCounts,
        modelCalls: chatModelCalls, providerWaitMs: 0, durationMs: chatCompletedAt - startedAt,
      });
      await saveOfflineAttempt(attempt);
      await harness.close();
      harness = null;
      attempt = beginOfflineAttempt(identity, "current_note_append");
      modelCallsBefore = backend.snapshot().requestCount;
      await saveOfflineAttempt(attempt);
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
      await observeOfflineTools(harness.page);
      // Watch the Chat live-run card while the mission runs: it must name the
      // step and the tool being run, not only how much budget was spent.
      await harness.page.evaluate(() => {
        const w = window as any;
        w.__liveRunCardObserved?.observer?.disconnect();
        const observed = {
          steps: [] as string[],
          tools: [] as string[],
          observer: null as MutationObserver | null,
        };
        const read = () => {
          const step =
            document.querySelector('[data-testid="live-run-step"]')?.textContent?.trim() ?? "";
          const tool =
            document.querySelector('[data-testid="live-run-tool"]')?.textContent?.trim() ?? "";
          if (step && observed.steps[observed.steps.length - 1] !== step) observed.steps.push(step);
          if (tool && observed.tools[observed.tools.length - 1] !== tool) observed.tools.push(tool);
        };
        observed.observer = new MutationObserver(read);
        observed.observer.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
        w.__liveRunCardObserved = observed;
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
      const liveRunCard = await harness.page.evaluate(() => {
        const w = window as any;
        w.__liveRunCardObserved?.observer?.disconnect();
        return {
          steps: (w.__liveRunCardObserved?.steps ?? []) as string[],
          tools: (w.__liveRunCardObserved?.tools ?? []) as string[],
        };
      });
      // This mission takes the direct-writeback route (the host streams the
      // append itself, no tool step), so the card names the note stream; a
      // routed run names the tool instead. Either is "what I am doing now".
      expect(
        liveRunCard.tools.some((label) =>
          /^(?:append_to_current_file|writing note)/u.test(label),
        ),
        `live-run card never said what it was doing: ${JSON.stringify(liveRunCard)}`,
      ).toBe(true);
      expect(
        liveRunCard.steps.some((label) => /^\d+ used \(max \d+\)$/u.test(label)),
        `live-run card never showed a step count: ${JSON.stringify(liveRunCard)}`,
      ).toBe(true);
      // Every finished mission ends with one plain-prose account in Chat, the
      // status bar carries the outcome, and the run offers a next step as a
      // chip (the append wrote a note, so "link it" is on the table).
      const missionSummary = harness.page.getByTestId("chat-mission-summary").last();
      await expect(missionSummary).toBeVisible({ timeout: 15_000 });
      await expect(missionSummary).toContainText("What I did:");
      await expect(missionSummary).toContainText("What changed: Appended to");
      await expect(missionSummary).toContainText("What I could not do: Nothing was left undone.");
      await expect(harness.page.getByTestId("agentic-status-bar")).toContainText(
        "Agent: done",
        { timeout: 15_000 },
      );
      const followupChip = harness.page.getByTestId("chat-followup-chip-0");
      await expect(followupChip).toBeVisible({ timeout: 15_000 });
      await expect(followupChip).toHaveAttribute("data-followup-id", "link_related_notes");
      await expect(followupChip).toHaveAttribute("title", /Append only/u);
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
      // The run note carries the same prose account as single-line bullets.
      const runNoteMarkdown = await harness.page.evaluate(async (runId: string) => {
        const app = (window as typeof window & { app?: any }).app;
        return app.vault.adapter.read(`Agent Runs/${runId}.md`);
      }, String(appendSnapshot.lastMissionLedger.runId));
      expect(runNoteMarkdown).toContain("- What I did:");
      expect(runNoteMarkdown).toContain("- What changed:");
      expect(runNoteMarkdown).toContain("- What I could not do:");

      expect(cloudModelRequests).toEqual([]);
      const bridgeMetrics = backend.snapshot();
      expect(bridgeMetrics.requestCount).toBeGreaterThanOrEqual(3);
      expect(bridgeMetrics.emittedToolCalls).toBeGreaterThanOrEqual(1);

      const scorecard = appendSnapshot.lastMissionScorecard;
      attempt = validateOfflineApplicationAttempt({
        ...attempt,
        version: 1,
        scenarioId: "current_note_append",
        repetition: 1,
        ...identity,
        status: "passed",
        acceptanceStatus: "pass",
        scorecardAcceptancePassed: scorecard?.acceptancePassed === true,
        scorecardTotal: typeof scorecard?.total === "number" ? scorecard.total : null,
        scorecardDimensions: (scorecard?.dimensions ?? []).map((dimension: any) => ({ id: dimension.id, score: dimension.score })),
        artifactReadbacks: [
          `note:${harness.notePath}:${appendMarker}`,
          `receipt:${appendReceipts[0].toolName}:${appendReceipts[0].operation}`,
        ],
        failureClass: "none",
        failureDetail: "",
        cloudRequestCount: cloudModelRequests.length,
        safetyViolationCount: 0,
        duplicateMutationCount: 0,
        mutationsPerformed: 1,
        mutationsWithReceipts: appendReceipts.length,
        mutationEventsObserved: 1,
        ...await readOfflineToolCounts(harness.page),
        modelCalls: Math.max(0, bridgeMetrics.requestCount - chatModelCalls),
        providerWaitMs: 0,
        durationMs: Date.now() - appendStartedAt,
      });
      expect(cloudModelRequests).toEqual([]);
      await saveOfflineAttempt(attempt);
    } catch (error) {
      attempt.failureDetail = error instanceof Error ? error.message : String(error);
      if (attempt.status === "passed") attempt.failureClass = "harness:scenario_after_acceptance";
      attempt.status = "failed";
      await saveOfflineAttempt(attempt);
      throw error;
    } finally {
      attempt.durationMs = Date.now() - Date.parse(attempt.startedAt);
      attempt.cloudRequestCount = cloudModelRequests.length;
      attempt.modelCalls = Math.max(0, backend.snapshot().requestCount - modelCallsBefore);
      if (harness) {
        Object.assign(attempt, await readOfflineToolCounts(harness.page));
        await boundedOfflineRead(harness.page.evaluate(() => { (window as any).__offlineUnsubscribe?.(); }));
      }
      await saveOfflineAttempt(attempt);
      await harness?.close();
      await close(bridge);
    }
  });

  test("OFFLINE-03 a transient provider outage recovers without a click", async () => {
    // The backend refuses the mission's own model requests with 503, exactly
    // the shape a cloud provider produces under load — long enough to outlast
    // one whole segment (the router, the planner, and the three streamed
    // writeback attempts each draw one refusal, so five end the first
    // segment). The host must then continue the mission from its durable
    // snapshot on its own and still deliver the append. Seven, not ten: the
    // endpoint breaker opens after five counted failures and a recovery
    // waits out its cooldown, so an outage that also survives the probe
    // would need a third continuation the two-recovery cap does not give —
    // that is the documented ceiling, not what this lane proves.
    const OUTAGE_FAILURES = 7;
    const backend = createOfflineAgentBackendV1();
    const { createAgentBridgeServer } = await importNativeEsm<{
      createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
    }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
    const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
    let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
    const cloudModelRequests: string[] = [];
    try {
      await listen(bridge, 7331);
      harness = await startRealAiHarness(
        "offline-core-recovery",
        {
          baseUrl: OFFLINE_BASE_URL,
          model: "offline-scripted-v1",
          missionTimeoutMs: 240_000,
          firstChunkTimeoutMs: 60_000,
          completionTimeoutMs: 240_000,
        },
        {
          modelRouterEnabled: false,
          modelRouterMode: "off",
          semanticIndexEnabled: false,
          enableStreaming: true,
          streamWritebackMode: "all_current_note_content_writes",
          workingMode: "automatic",
          maxAgentSteps: 6,
          modelFallbackEnabled: false,
        },
      );
      harness.page.on("request", (request) => {
        if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
      });
      await harness.page.evaluate(() => {
        const w = window as any;
        w.__recoveryTraces = [];
        // Every status, trace and completion the run emits, bounded, so a
        // red says what the run did instead of only what it did not.
        w.__recoveryLog = [];
        const clip = (value: unknown) =>
          typeof value === "string" ? value.slice(0, 400) : value ?? null;
        w.__recoveryUnsubscribe?.();
        w.__recoveryUnsubscribe = w.app.plugins.plugins["agentic-researcher"].subscribeMissionEvents(
          {
            onStatus: (message: string) => {
              w.__recoveryLog.push({ status: clip(message) });
            },
            onTrace: (event: any) => {
              if (typeof event?.id === "string" && event.id.startsWith("auto-recovery-")) {
                w.__recoveryTraces.push(event.id);
              }
              w.__recoveryLog.push({
                trace: event?.id ?? null,
                kind: event?.kind ?? null,
                message: clip(event?.message),
                error: event?.error ?? null,
                preview: event?.outputPreview ?? null,
              });
            },
            onRunComplete: (event: any) => {
              w.__recoveryLog.push({
                complete: event?.stopReason ?? null,
                detail: clip(event?.stopDetail),
              });
            },
          },
          { replay: false },
        );
      });
      const beforeAppend = await harness.readNote();
      const appendMarker = `OFFLINE_APPEND_RECOVER_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
      backend.injectTransientOutage(OUTAGE_FAILURES, {
        whenTranscriptIncludes: appendMarker,
      });
      await harness.submitMission(
        `Append exactly one new line containing ${appendMarker} to the current note. Do not replace existing content and do not use the web.`,
        { timeoutMs: 240_000 },
      );
      const afterAppend = await harness.readNote();
      expect(afterAppend.startsWith(beforeAppend)).toBe(true);
      const recovery = await harness.page.evaluate(() => {
        const w = window as any;
        w.__recoveryUnsubscribe?.();
        return {
          traces: (w.__recoveryTraces ?? []) as string[],
          domTrace: Boolean(document.querySelector('[data-trace-id="auto-recovery-1"]')),
          blockedContinue: document.querySelectorAll('[data-testid="chat-blocked-continue"]').length,
          log: ((w.__recoveryLog ?? []) as unknown[]).slice(-80),
        };
      });
      const bridgeMetrics = backend.snapshot();
      // More than one segment's worth of requests was refused, so the first
      // segment really did fail terminally before the recovery started.
      expect(
        bridgeMetrics.outageFailuresServed ?? 0,
        JSON.stringify(bridgeMetrics),
      ).toBeGreaterThanOrEqual(6);
      expect(
        recovery.traces.includes("auto-recovery-1") || recovery.domTrace,
        `the host never recovered on its own: ${JSON.stringify({ recovery, bridgeMetrics })}`,
      ).toBe(true);
      // Recovered, not parked: no Continue button was ever needed.
      expect(
        recovery.blockedContinue,
        `the mission ended on a blocked card after recovering: ${JSON.stringify({ recovery, bridgeMetrics })}`,
      ).toBe(0);
      expect(
        afterAppend.split(appendMarker),
        JSON.stringify({ recovery, bridgeMetrics }),
      ).toHaveLength(2);
      expect(cloudModelRequests).toEqual([]);
    } finally {
      await harness?.close();
      await close(bridge);
    }
  });

  test("OFFLINE-04 a pending frontmatter mission launches from the vault", async () => {
    const backend = createOfflineAgentBackendV1();
    const { createAgentBridgeServer } = await importNativeEsm<{
      createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
    }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
    const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
    let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
    const cloudModelRequests: string[] = [];
    try {
      await listen(bridge, 7331);
      harness = await startRealAiHarness(
        "offline-core-vault-trigger",
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
          vaultTriggersEnabled: true,
        },
      );
      harness.page.on("request", (request) => {
        if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
      });
      const marker = `OFFLINE_APPEND_TRIGGER_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
      const triggerPath = `${path.posix.dirname(harness.notePath)}/Trigger ${harness.marker}.md`;
      const prompt = `Append exactly one new line containing ${marker} to the current note. Do not replace existing content and do not use the web.`;
      // No chat panel involved: the note itself carries the mission.
      await harness.seedNote(
        triggerPath,
        `---\nagent_mission: ${prompt}\nagent_mission_status: pending\n---\n# Trigger note\n`,
        true,
      );
      await expect(
        harness.page
          .locator(".agentic-researcher-log-user .agentic-researcher-log-message")
          .filter({ hasText: marker })
          .last(),
        "the frontmatter mission never launched",
      ).toBeVisible({ timeout: 45_000 });
      await harness.waitForMissionComplete(120_000);
      const readTrigger = () =>
        harness!.page.evaluate(
          async (notePath: string) => (window as any).app.vault.adapter.read(notePath),
          triggerPath,
        );
      const after = await readTrigger();
      // The prompt in the frontmatter names the marker too; the body must
      // carry it exactly once.
      const body = after.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
      expect(body.split(marker), after).toHaveLength(2);
      expect(after).toMatch(/agent_mission_status: done/u);
      expect(after).toMatch(/agent_mission_run_id: /u);
      // A later body edit changes nothing: the status is no longer pending.
      const launchesBefore = await harness.page
        .locator(".agentic-researcher-log-user .agentic-researcher-log-message")
        .filter({ hasText: marker })
        .count();
      await harness.page.evaluate(async (notePath: string) => {
        const app = (window as any).app;
        const file = app.vault.getFileByPath(notePath);
        await app.vault.modify(file, `${await app.vault.read(file)}\nA later edit.\n`);
      }, triggerPath);
      await harness.page.waitForTimeout(4_000);
      const stillIdle = await harness.page.evaluate(() => {
        const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
        return plugin.getMissionRunSnapshot().isRunning === false;
      });
      expect(stillIdle).toBe(true);
      expect(
        await harness.page
          .locator(".agentic-researcher-log-user .agentic-researcher-log-message")
          .filter({ hasText: marker })
          .count(),
      ).toBe(launchesBefore);
      expect(cloudModelRequests).toEqual([]);
    } finally {
      await harness?.close();
      await close(bridge);
    }
  });
});

async function currentBuildIdentity() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  const { stdout: porcelain } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  const bundleSha256 = await sha256File(path.resolve("main.js"));
  const installedBundleSha256 = await sha256File(resolveInstalledMainPath());
  expect(installedBundleSha256).toBe(bundleSha256);
  return { exactHead: stdout.trim(), sourceState: porcelain.trim() ? "dirty_worktree" : "clean_head", bundleSha256, installedBundleSha256 };
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
