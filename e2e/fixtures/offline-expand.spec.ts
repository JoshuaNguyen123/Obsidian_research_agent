import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createOfflineAgentBackendV1 } from "./offlineAgentBackend";
import {
  OFFLINE_CITATION_REPAIR_SCENARIO,
  OFFLINE_EXPAND_SCENARIOS,
  OFFLINE_RESEARCH_CATALOG_PROBES,
  renderOfflineExpandPrompt,
  type OfflineExpandScenarioV1,
} from "./offlineExpandScenarios";
import { startRealAiHarness } from "./realAiHarness";
import { beginOfflineAttempt, saveOfflineAttempt, observeOfflineTools, readOfflineToolCounts, boundedOfflineRead, readOfflineBuildIdentity, saveOfflineProbe } from "./offlineEvidence";

const execFileAsync = promisify(execFile);
// Must match E2E_OPENAI_COMPATIBLE_BASE_URL, which run-e2e-exclusive.mjs
// pins to 127.0.0.1:7331 for every --offline-ai lane (offline-core uses the
// same port). Standing the bridge up on 7332 left the plugin dialling 7331
// and every mission died on ERR_CONNECTION_REFUSED.
const OFFLINE_BASE_URL = "http://127.0.0.1:7331/v1";
const OFFLINE_TOKEN = "offline-e2e-ephemeral-token";

test.describe("zero-cloud expand: replace, page-clear, word-count, title, research catalog", () => {
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
    const { validateOfflineApplicationAttempt } = await importIsolatedEsm<{
      validateOfflineApplicationAttempt(value: unknown): Record<string, unknown>;
    }>(path.resolve("scripts", "offline-application-attempt.mjs"));
    const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
    const cloudModelRequests: string[] = [];
    const attempts: Record<string, unknown>[] = [];
    try {
      await listen(bridge, 7331);
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

      const failures: unknown[] = [];
      for (const scenario of OFFLINE_EXPAND_SCENARIOS) {
        try { attempts.push(await runExpandScenario({
          scenario,
          backend,
          identity,
          cloudModelRequests,
          validateOfflineApplicationAttempt,
        })); } catch (error) { failures.push(error); }
      }

      expect(cloudModelRequests).toEqual([]);
      if (failures.length) throw new Error(`${failures.length} offline scenarios failed; each attempt was preserved. ${failures.map(String).join("\n")}`);
    } finally {
      await close(bridge);
    }
  });

  test("OFFLINE-07/10 installed catalog offers extract, citation verify, dataset json, and flowchart mermaid", async () => {
    const backend = createOfflineAgentBackendV1();
    const { createAgentBridgeServer } = await importNativeEsm<{
      createAgentBridgeServer(options: {
        token: string;
        backend: typeof backend;
      }): Server;
    }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
    const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
    const missing: string[] = [];
    try {
      await listen(bridge, 7331);
      for (const probe of OFFLINE_RESEARCH_CATALOG_PROBES) {
        const probeAttempt = beginOfflineAttempt(await readOfflineBuildIdentity(), `catalog:${probe.id}`);
        await saveOfflineProbe(probeAttempt);
        const requestsBefore = backend.snapshot().offeredToolsByRequest.length;
        let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
        try {
          harness = await startRealAiHarness(
            `offline-catalog-${probe.id}`,
            {
              baseUrl: OFFLINE_BASE_URL,
              model: "offline-scripted-v1",
              missionTimeoutMs: 90_000,
              firstChunkTimeoutMs: 30_000,
              completionTimeoutMs: 90_000,
            },
            {
              modelRouterEnabled: false,
              modelRouterMode: "off",
              semanticIndexEnabled: false,
              enableStreaming: true,
              streamWritebackMode: "all_current_note_content_writes",
              workingMode: "automatic",
              maxAgentSteps: 4,
            },
          );
          const marker = `${probe.markerPrefix}_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
          backend.setCatalogNotePath(harness.notePath);
          await harness.seedNote(
            harness.notePath,
            `# Catalog probe\n\n${marker}\n`,
            true,
          );
          await harness.submitMission(
            renderOfflineExpandPrompt(
              {
                id: "title_rename_plus_body",
                markerPrefix: probe.markerPrefix,
                title: probe.id,
                prompt: probe.prompt,
                expectedMutation: "append",
                requiresBackup: false,
                expectedTools: [probe.expectedTool],
              },
              marker,
            ),
            { timeoutMs: 90_000, waitForCompletion: probe.expectedTool !== "upsert_mermaid_block" },
          );
          if (probe.expectedTool === "upsert_mermaid_block") {
            await harness.approveUntilMissionComplete(120_000);
            const snapshot = await harness.attestProductionRun();
            const receipt = snapshot.lastReceipts.find((row: any) => row.toolName === "upsert_mermaid_block");
            expect(receipt, JSON.stringify(snapshot.lastComplete)).toBeTruthy();
            expect(receipt.backupPath).toMatch(/^\.agent-backups\//u);
            expect(await readFile(harness.noteFilePath, "utf8")).toContain("Research --> Verify");
            probeAttempt.artifactReadbacks = [`receipt:upsert_mermaid_block:${receipt.path}`, `backup:${receipt.backupPath}`];
          }
          probeAttempt.status = "passed";
        } catch (error) {
          probeAttempt.failureDetail = error instanceof Error ? error.message : String(error);
          missing.push(`${probe.id}: ${probeAttempt.failureDetail}`);
        } finally {
          const offered = backend.snapshot().offeredToolsByRequest.slice(requestsBefore).flat();
          probeAttempt.offeredTools = [...new Set(offered)];
          if (!offered.includes(probe.expectedTool)) probeAttempt.status = "failed";
          probeAttempt.failureClass = probeAttempt.status === "passed" ? "none" : "process:unclassified";
          await saveOfflineProbe(probeAttempt);
          await harness?.close();
        }
        const offered = backend.snapshot().offeredToolsByRequest.slice(requestsBefore).flat();
        const sawExpected =
          offered.includes(probe.expectedTool);
        if (!sawExpected) {
          missing.push(
            `${probe.id}: expected ${probe.expectedTool}; offered=${JSON.stringify(offered)}`,
          );
        }
      }
    } finally {
      await close(bridge);
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  test("installed retrieval cache, atomic conflict, and durable scheduled preflight", async () => {
    test.setTimeout(300_000);
    const probeAttempt = beginOfflineAttempt(await readOfflineBuildIdentity(), "retrieval-and-atomic-conflict");
    await saveOfflineProbe(probeAttempt);
    const backend = createOfflineAgentBackendV1();
    const { createAgentBridgeServer } = await importNativeEsm<{ createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
    const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
    let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
    try {
      await listen(bridge, 7331);
      harness = await startRealAiHarness("offline-cache-conflict", { baseUrl: OFFLINE_BASE_URL, model: "offline-scripted-v1", missionTimeoutMs: 120_000, firstChunkTimeoutMs: 30_000, completionTimeoutMs: 120_000 }, { modelRouterEnabled: false, semanticIndexEnabled: false });
      await harness.seedNote(harness.notePath, "# Original\n", true);
      const result = await harness.page.evaluate(async ({ notePath, marker }) => {
        const app = (window as any).app;
        const plugin = app.plugins.plugins["agentic-researcher"];
        const registry = plugin.createToolRegistry();
        const ctx = plugin.createToolExecutionContext("Research CRDT convergence and append to the current note.");
        ctx.settings = { ...ctx.settings, ollamaBaseUrl: "http://127.0.0.1:7331", ollamaApiKey: "", freeSearchFallbackEnabled: false };
        ctx.rootMissionId = `offline-cache-${marker}`;
        ctx.runId = ctx.rootMissionId;
        ctx.now = () => new Date("2026-09-04T10:00:00Z");
        ctx.getCurrentMarkdownFile = () => app.vault.getFileByPath(notePath);
        const source = `https://offline-${marker.toLowerCase()}.example/crdt`;
        const body = "A state-based G-Counter assigns each replica its own slot and merges by pointwise maximum. Convergence follows because the join is idempotent, commutative, and associative. An observed-remove set records add tags and removes only the tags a replica has observed.";
        let sourceHits = 0;
        let searchHits = 0;
        const createdPaths = new Set<string>();
        ctx.httpTransport = async (request: any) => {
          if (request.url.endsWith("/web_search")) { searchHits++; return { status: 200, headers: {}, json: { results: [{ title: "CRDT", url: source, snippet: body }] } }; }
          const url = JSON.parse(String(request.body ?? "{}")).url;
          if (url === source) { sourceHits++; return { status: 200, headers: {}, json: { title: `Offline ${marker}`, content: body, links: [] } }; }
          return { status: 404, headers: {}, json: {} };
        };
        const execute = async (name: string, args: any) => {
          const result = await registry.execute({ name, arguments: args }, ctx);
          if (result.output?.cachedPath && result.output.cachedPath.endsWith(".md")) createdPaths.add(result.output.cachedPath);
          return result;
        };
        const process = app.vault.process.bind(app.vault);
        try {
          const initial = await execute("web_fetch", { url: source, refresh: true });
          ctx.now = () => new Date("2026-09-04T12:00:00Z");
          const fallback = await execute("web_fetch", { url: "https://unreachable.example/offline", alternate_urls: [source], refresh: true });
          const reusedHits = sourceHits;
          const bypass = await execute("web_fetch", { url: "https://unreachable.example/offline", alternate_urls: [source], max_age_ms: 0 });
          const searchQuery = `CRDT ${marker}`;
          await execute("web_search", { query: searchQuery, refresh: true });
          const searchBefore = searchHits;
          const search = await execute("web_search", { query: searchQuery, refresh: true });
          const verified = await execute("verify_citation", { url: source, quote: "Convergence follows because the join is idempotent, commutative, and associative." });
          app.vault.process = async (file: any, transform: (s: string) => string) => {
            if (file.path === notePath) await app.vault.modify(file, "# Original\nUser edit survives.\n");
            return process(file, transform);
          };
          const conflict = await execute("append_to_current_file", { text: "Agent addition." });
          const observed = await app.vault.read(app.vault.getFileByPath(notePath));
          ctx.getCurrentMarkdownFile = () => null;
          const unbound = await execute("read_current_file", {});
          return { initial: initial.ok, fallback: fallback.output, original: initial.output, bypass: bypass.output, reusedHits, sourceHits, searchCached: search.output?.fromCache, searchExtraHits: searchHits - searchBefore, citationStatus: verified.output?.status, conflictCode: conflict.error?.code, observed, unboundRejected: !unbound.ok };
        } finally {
          app.vault.process = process;
          for (const path of createdPaths) {
            const file = app.vault.getFileByPath(path);
            if (file) await app.vault.trash(file, true);
          }
        }
      }, { notePath: harness.notePath, marker: harness.marker.replace(/[^a-z0-9]/gi, "") });
      expect(result.initial).toBe(true);
      expect(result.fallback.fromCache).toBe(true);
      expect(result.fallback.fetchedAt).toBe(result.original.fetchedAt);
      expect(result.fallback.contentHash).toBe(result.original.contentHash);
      expect(result.reusedHits).toBe(1);
      expect(result.sourceHits).toBe(2);
      expect(result.bypass.fromCache).toBe(false);
      expect(result.searchCached).toBe(true);
      expect(result.searchExtraHits).toBe(0);
      expect(result.citationStatus).toBe("supported");
      expect(result.conflictCode).toBe("vault_write_conflict");
      expect(result.observed).toContain("User edit survives.");
      expect(result.observed).not.toContain("Agent addition.");
      expect(result.unboundRejected).toBe(true);
      const scheduleProof = await harness.page.evaluate(async ({ notePath, marker }) => {
        const app = (window as any).app;
        const plugin = app.plugins.plugins["agentic-researcher"];
        plugin.missionScheduler?.stop();
        const target = notePath.replace(/\.md$/u, "-schedule.md");
        await app.vault.create(target, "# Scheduled output\n");
        let schedule = { id: `offline-schedule-${marker}`, prompt: "Append a bounded summary to the current note.",
          cadence: "hourly", enabled: true, targetNotePath: target, lastRunAt: null, lastRunId: null } as any;
        plugin.settings.scheduledMissions = [schedule];
        const runMission = plugin.runMission;
        let launches = 0;
        let persistedBeforeLaunch = false;
        let isolatedHistory = false;
        let missionId = "";
        let manifestPath = "";
        plugin.runMission = async (_prompt: string, history: unknown[], options: any) => {
          launches++;
          isolatedHistory = history.length === 0;
          missionId = options.durableManifest.missionId;
          const file = app.vault.getMarkdownFiles().find((candidate: any) =>
            candidate.path.startsWith("Agent Runs/Missions/") && candidate.basename === missionId);
          manifestPath = file?.path ?? "";
          persistedBeforeLaunch = Boolean(file && (await app.vault.read(file)).includes(missionId));
          throw Object.assign(new Error("Injected crash after durable dispatch, before launch."), { code: "offline_dispatch_fault" });
        };
        try {
          await Promise.all([plugin.runScheduledMission(schedule), plugin.runScheduledMission(schedule)]);
          const initialOccurrence = schedule.occurrence?.missionId;
          const firstFailure = schedule.occurrence?.failureCode;
          // Deserialize the saved occurrence as startup does, then change a
          // binding before retry. An existing manifest must re-run preflight.
          schedule = JSON.parse(JSON.stringify(schedule));
          plugin.settings.scheduledMissions = [schedule];
          await app.vault.trash(app.vault.getFileByPath(target), true);
          await plugin.runScheduledMission(schedule);
          return { launches, isolatedHistory, persistedBeforeLaunch, firstFailure,
            sameOccurrence: initialOccurrence === schedule.occurrence?.missionId && initialOccurrence === missionId,
            retryFailure: schedule.occurrence?.failureCode, retryPersisted: Boolean(schedule.occurrence?.retryAt) };
        } finally {
          plugin.runMission = runMission;
          plugin.settings.scheduledMissions = [];
          await plugin.saveSettings();
          for (const ownedPath of [target, manifestPath]) {
            const file = ownedPath ? app.vault.getFileByPath(ownedPath) : null;
            if (file) await app.vault.trash(file, true);
          }
        }
      }, { notePath: harness.notePath, marker: harness.marker.replace(/[^a-z0-9]/giu, "") });
      expect(scheduleProof).toEqual({ launches: 1, isolatedHistory: true, persistedBeforeLaunch: true,
        firstFailure: "offline_dispatch_fault", sameOccurrence: true, retryFailure: "scheduled_preflight_blocked", retryPersisted: true });
      const memoryProof = await harness.page.evaluate(async ({ marker }) => {
        const app = (window as any).app;
        const plugin = app.plugins.plugins["agentic-researcher"];
        const registry = plugin.createToolRegistry();
        const context = plugin.createToolExecutionContext("Save this to research memory.");
        context.settings = { ...context.settings, researchMemoryEnabled: true };
        context.runId = `offline-memory-${marker}`;
        context.operationId = "memory-append";
        const call = { name: "append_research_memory", arguments: { topic: `Owned memory ${marker}`, text: `MEMORY_${marker}` } };
        const denied = await registry.execute(call, context);
        const prepared = await registry.prepare(call, context);
        if (!prepared.ok) throw new Error(JSON.stringify(prepared));
        const action = prepared.action;
        const path = action.target.path;
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (!app.vault.getFolderByPath(parent)) await app.vault.createFolder(parent);
        await app.vault.create(path, "Original user content\n");
        const process = app.vault.process.bind(app.vault);
        app.vault.process = async (file: any, transform: (text: string) => string) => {
          if (file.path === path) {
            app.vault.process = process;
            await process(file, (current: string) => `${current}Intervening user edit\n`);
          }
          return process(file, transform);
        };
        const authority = { preparedActionId: action.id, payloadFingerprint: action.payloadFingerprint, grantId: "offline-owned-memory-approval" };
        context.setResearchMemoryIndex = async () => { throw new Error("Injected crash after note mutation, before index persistence"); };
        try {
          const failed = await registry.executePrepared(action, context, authority);
          const written = await app.vault.read(app.vault.getFileByPath(path));
          return { action, authority, written, failed: !failed.ok,
            unpreparedRejected: denied.error?.code === "prepared_action_required",
            preservedEdit: written.startsWith("Original user content\nIntervening user edit\n") };
        } finally { app.vault.process = process; }
      }, { marker: harness.marker.replace(/[^a-z0-9]/giu, "") });
      expect(memoryProof.unpreparedRejected).toBe(true);
      expect(memoryProof.failed).toBe(true);
      expect(memoryProof.preservedEdit).toBe(true);
      // Recreate the installed runtime, losing all process-local dedupe state.
      await harness.relaunch();
      const memoryRecovery = await harness.page.evaluate(async ({ action, authority, written }) => {
        const app = (window as any).app;
        const plugin = app.plugins.plugins["agentic-researcher"];
        const registry = plugin.createToolRegistry();
        const context = plugin.createToolExecutionContext("Save this to research memory.");
        context.settings = { ...context.settings, researchMemoryEnabled: true };
        context.runId = action.runId;
        context.authorizedAction = authority;
        const reconciled = await registry.reconcile(action, context);
        const replay = await registry.executePrepared(action, context, authority);
        const current = await app.vault.read(app.vault.getFileByPath(action.target.path));
        const index = context.getResearchMemoryIndex?.() ?? [];
        return { outcome: reconciled.outcome, commitKind: reconciled.receipt?.commitKind,
          readback: reconciled.receipt?.readback?.status, replayKind: replay.receipt?.commitKind,
          bytesWritten: replay.receipt?.effects?.bytesWritten,
          unchanged: current === written, indexed: index.some((entry: any) => entry.path === action.target.path) };
      }, memoryProof);
      expect(memoryRecovery).toEqual({ outcome: "committed", commitKind: "reconciled", readback: "verified",
        replayKind: "no_op", bytesWritten: 0, unchanged: true, indexed: true });
      probeAttempt.status = "passed";
      probeAttempt.failureClass = "none";
      probeAttempt.observations = { sourceHits: result.sourceHits, searchExtraHits: result.searchExtraHits,
        citationStatus: result.citationStatus, conflictCode: result.conflictCode, unboundRejected: result.unboundRejected, scheduleProof,
        memory: { unpreparedRejected: memoryProof.unpreparedRejected, preservedEdit: memoryProof.preservedEdit, ...memoryRecovery } };
    } catch (error) {
      probeAttempt.failureDetail = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await saveOfflineProbe(probeAttempt);
      await harness?.close();
      await close(bridge);
    }
  });
});

test("installed fresh ordered appends preserve note scope with native heading metadata", async () => {
  test.skip(process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" || process.env.E2E_OFFLINE_AI !== "1", "Requires the offline-expand lane.");
  test.setTimeout(240_000);
  const backend = createOfflineAgentBackendV1();
  const { createAgentBridgeServer } = await importNativeEsm<{
    createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
  }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
  const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
  const attempt = beginOfflineAttempt(await readOfflineBuildIdentity(), "fresh-ordered-appends");
  const startedAt = Date.now();
  const cloudModelRequests: string[] = [];
  let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
  await saveOfflineProbe(attempt);
  try {
    await listen(bridge, 7331);
    harness = await startRealAiHarness("offline-ordered-appends", {
      baseUrl: OFFLINE_BASE_URL, model: "offline-scripted-v1",
      missionTimeoutMs: 120_000, firstChunkTimeoutMs: 30_000, completionTimeoutMs: 120_000,
    }, { autoContinueLongRuns: false, semanticIndexEnabled: false, researchMemoryEnabled: false });
    harness.page.on("request", (request) => {
      if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
    });
    await observeOfflineTools(harness.page);
    const original = "# Existing note\n\nInitial note content.\n\n## Details\n\nPreserve these details.\n";
    await harness.seedNote(harness.notePath, original, true);
    // The original unit fixture had no metadata cache and missed this native
    // path entirely. Require real parsed headings before starting the mission.
    await expect.poll(() => harness!.page.evaluate((notePath) => {
      const app = (window as any).app;
      return app.metadataCache.getFileCache(app.vault.getFileByPath(notePath))?.headings?.map((heading: any) => heading.heading) ?? [];
    }, harness!.notePath)).toEqual(["Existing note", "Details"]);
    const marker = `OFFLINE_ORDERED_${attempt.attemptId.replace(/-/gu, "").toUpperCase()}`;
    const markerA = `${marker}_A1`;
    const markerB = `${marker}_B2`;
    await harness.submitMission("Perform exactly two ordered durable appends to the current note, then finish. " +
      `First append exactly one line containing ${markerA} and verify that write. ` +
      `Then append exactly one separate line containing ${markerB} and verify that write. ` +
      "Two appends total, in that order. This task needs no web, memory, or vault research.", { waitForCompletion: false });
    await harness.approveUntilMissionComplete(120_000, {
      maxContinuations: 0, allowedApprovalToolNames: ["append_to_current_file"], requireExactPreparedActionApproval: true,
    });
    const snapshot = await harness.attestProductionRun();
    const note = await harness.readNote();
    const receipts = snapshot.lastReceipts.filter((receipt: any) => receipt.operation === "append");
    Object.assign(attempt, {
      ...await readOfflineToolCounts(harness.page), backend: backend.snapshot(),
      acceptanceStatus: snapshot.lastMissionLedger?.acceptance?.status ?? null,
      scorecardAcceptancePassed: snapshot.lastMissionScorecard?.acceptancePassed ?? null,
      scorecardTotal: snapshot.lastMissionScorecard?.total ?? null,
      progress: harness.readProgressCounters(),
      delivery: { originalPreserved: note.startsWith(original), firstMarkerCount: note.split(markerA).length - 1,
        secondMarkerCount: note.split(markerB).length - 1, ordered: note.indexOf(markerA) < note.indexOf(markerB),
        receiptCount: receipts.length, uniqueReceiptCount: new Set(receipts.map((receipt: any) => receipt.id)).size },
    });
    await saveOfflineProbe(attempt);
    expect(attempt.delivery).toEqual({ originalPreserved: true, firstMarkerCount: 1, secondMarkerCount: 1,
      ordered: true, receiptCount: 2, uniqueReceiptCount: 2 });
    expect(attempt.toolEventsObserved).toBeGreaterThanOrEqual(2);
    expect(attempt.toolEventsFailed).toBe(0);
    expect(attempt.progress.continuations).toBe(0);
    expect(attempt.acceptanceStatus).toBe("pass");
    expect(attempt.scorecardAcceptancePassed).toBe(true);
    expect(cloudModelRequests).toEqual([]);
    Object.assign(attempt, { status: "passed", failureClass: "none", failureDetail: "" });
  } catch (error) {
    attempt.failureDetail = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    attempt.durationMs = Date.now() - startedAt;
    attempt.cloudRequestCount = cloudModelRequests.length;
    if (harness) Object.assign(attempt, await readOfflineToolCounts(harness.page));
    await saveOfflineProbe(attempt);
    try { await harness?.close(); } finally { await close(bridge); }
  }
});

test("OFFLINE-12 an expired approval parks the run and Continue asks again", async () => {
  test.skip(process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" || process.env.E2E_OFFLINE_AI !== "1", "Requires the offline-expand lane.");
  test.setTimeout(360_000);
  // A whole-note replace needs an approval. Nobody answers it here; the card
  // expires after the configured timeout and the run must PARK as resumable
  // (nothing changed), not fail. Continue then asks again and the approval
  // completes the replace with its backup.
  const scenario = OFFLINE_EXPAND_SCENARIOS.find((entry) => entry.id === "current_note_replace_with_backup");
  expect(scenario).toBeTruthy();
  const backend = createOfflineAgentBackendV1();
  const { createAgentBridgeServer } = await importNativeEsm<{
    createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
  }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
  const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
  const cloudModelRequests: string[] = [];
  let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
  try {
    await listen(bridge, 7331);
    harness = await startRealAiHarness("offline-approval-park", {
      baseUrl: OFFLINE_BASE_URL, model: "offline-scripted-v1",
      missionTimeoutMs: 120_000, firstChunkTimeoutMs: 30_000, completionTimeoutMs: 120_000,
    }, {
      modelRouterEnabled: false, modelRouterMode: "off", semanticIndexEnabled: false,
      enableStreaming: true, streamWritebackMode: "all_current_note_content_writes",
      workingMode: "automatic", maxAgentSteps: 8, autoTitleOnWrite: true,
      approvalTimeoutMs: 5_000,
    });
    harness.page.on("request", (request) => {
      if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
    });
    await observeOfflineTools(harness.page);
    const marker = `${scenario!.markerPrefix}_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
    const original = `# Original\n\nKEEP_UNTIL_REPLACE_${harness.marker}\n`;
    await harness.seedNote(harness.notePath, original, true);
    await harness.submitMission(renderOfflineExpandPrompt(scenario!, marker), {
      timeoutMs: 120_000,
      waitForCompletion: false,
    });
    // The approval card appears, and nobody clicks it.
    await expect(harness.page.getByTestId("chat-approval-approve")).toBeVisible({ timeout: 90_000 });
    const parkedContinue = harness.page.getByTestId("chat-blocked-continue");
    await expect(parkedContinue, "the run did not park after the approval expired").toBeVisible({ timeout: 90_000 });
    await expect(parkedContinue).toBeEnabled({ timeout: 30_000 });
    await expect(
      harness.page.locator(".agentic-researcher-chat-attention-title").filter({ hasText: "Approval expired, run parked" }),
    ).toBeVisible();
    expect(await harness.readNote(), "parking must leave the note untouched").toBe(original);
    await parkedContinue.click();
    // Asked again; this time the approval is granted and the replace lands.
    await harness.approveUntilMissionComplete(180_000);
    const after = await harness.readNote();
    expect(after.includes(marker), after).toBe(true);
    expect(after.includes(`KEEP_UNTIL_REPLACE_${harness.marker}`)).toBe(false);
    const snapshot = await harness.attestProductionRun();
    const receipts = Array.isArray(snapshot.lastReceipts) ? snapshot.lastReceipts : [];
    expect(
      receipts.some((receipt: { backupPath?: string }) =>
        typeof receipt.backupPath === "string" && receipt.backupPath.startsWith(".agent-backups/")),
      JSON.stringify(receipts),
    ).toBe(true);
    assertCompletedLedgerAcceptance(snapshot);
    expect(cloudModelRequests).toEqual([]);
  } finally {
    try { await harness?.close(); } finally { await close(bridge); }
  }
});

test("OFFLINE-13 the installed direct-read transport refuses a name that resolves to loopback", async () => {
  test.skip(process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" || process.env.E2E_OFFLINE_AI !== "1", "Requires the offline-expand lane.");
  test.setTimeout(240_000);
  // The unit tests prove the lookup hook with Node's own http module. What
  // only the installed plugin can prove is that the SAME hook holds inside
  // Obsidian's Electron renderer, through the bundle, from the tool context
  // main.ts actually builds. "localhost" is a name, not a literal, at the hop
  // layer, so the connection's own DNS answer (127.0.0.1) is what refuses it.
  const backend = createOfflineAgentBackendV1();
  const { createAgentBridgeServer } = await importNativeEsm<{
    createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
  }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
  const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
  const { createServer } = await import("node:http");
  let loopbackHits = 0;
  const loopback = createServer((_request, response) => {
    loopbackHits += 1;
    response.end("loopback service that must never be read");
  });
  let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
  try {
    await listen(bridge, 7331);
    await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
    const port = (loopback.address() as { port: number }).port;
    harness = await startRealAiHarness("offline-public-fetch-guard", {
      baseUrl: OFFLINE_BASE_URL, model: "offline-scripted-v1",
      missionTimeoutMs: 120_000, firstChunkTimeoutMs: 30_000, completionTimeoutMs: 120_000,
    }, { modelRouterEnabled: false, semanticIndexEnabled: false });
    const probe = await harness.page.evaluate(async (loopbackPort) => {
      const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
      const ctx = plugin.createToolExecutionContext("public fetch guard probe");
      const hop = ctx.publicFetchTransport;
      if (typeof hop !== "function") return { wired: false };
      try {
        await hop({
          url: `http://localhost:${loopbackPort}/`,
          headers: {},
          timeoutMs: 10_000,
          maxBytes: 1_000,
        });
        return { wired: true, refused: false };
      } catch (error) {
        return {
          wired: true,
          refused: true,
          code: (error as { code?: string }).code ?? null,
          message: String((error as Error).message ?? error),
        };
      }
    }, port);
    expect(probe.wired, "main.ts must hand tools the Node hop transport").toBe(true);
    expect(probe, JSON.stringify(probe)).toMatchObject({ refused: true, code: "resolved_private_address" });
    expect(loopbackHits, "the loopback server must never receive the request").toBe(0);

    const notificationsDefault = await harness.page.evaluate(
      () => (window as any).app.plugins.plugins["agentic-researcher"].settings.desktopNotificationsEnabled,
    );
    expect(notificationsDefault, "away notifications default on in the installed plugin").toBe(true);
  } finally {
    try { await harness?.close(); } finally {
      await close(bridge);
      await close(loopback as unknown as Server);
    }
  }
});

for (const memoryEnabled of [false, true]) test(memoryEnabled
  ? "installed host-planned research memory obtains exact authority after cited research"
  : "OFFLINE-11 verifies a corrected citation draft before requesting more tools", async () => {
  test.skip(process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" || process.env.E2E_OFFLINE_AI !== "1", "Requires the offline-expand lane.");
  test.setTimeout(240_000);
  const backend = createOfflineAgentBackendV1();
  const { createAgentBridgeServer } = await importNativeEsm<{
    createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
  }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
  const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
  let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
  const startedAt = Date.now();
  const cloudModelRequests: string[] = [];
  const identity = await readOfflineBuildIdentity();
  const scenario = OFFLINE_CITATION_REPAIR_SCENARIO;
  const attempt = beginOfflineAttempt(identity, memoryEnabled ? "research-memory-host-scope" : scenario.id);
  const saveAttempt = memoryEnabled ? saveOfflineProbe : saveOfflineAttempt;
  await saveAttempt(attempt);
  try {
    await listen(bridge, 7331);
    harness = await startRealAiHarness("offline-citation-repair", {
      baseUrl: OFFLINE_BASE_URL, model: "offline-scripted-v1",
      missionTimeoutMs: 120_000, firstChunkTimeoutMs: 30_000, completionTimeoutMs: 120_000,
    }, {
      modelRouterEnabled: false, modelRouterMode: "off", semanticIndexEnabled: false,
      // Leave tool budget outside the finalization reserve so the corrected
      // candidate actually exercises admission past citation-gather steering.
      researchMemoryEnabled: memoryEnabled, enableStreaming: false, maxAgentSteps: 8,
      // Exercise the configured host memory save without routing the research
      // answer into this fixture's active note or forbidding memory writes.
      ...(memoryEnabled ? { workingMode: "custom", outputProfile: "chat_first" } : {}),
    });
    harness.page.on("request", (request) => {
      if (isKnownCloudModelUrl(request.url())) cloudModelRequests.push(request.url());
    });
    await observeOfflineTools(harness.page);
    await harness.seedNote(harness.notePath, "Preserve this note during cited chat.", true);
    if (memoryEnabled) {
      const effectiveSettings = await harness.page.evaluate(() => {
        const settings = (window as any).app.plugins.plugins["agentic-researcher"].settings;
        return { workingMode: settings.workingMode, outputProfile: settings.outputProfile,
          researchMemoryEnabled: settings.researchMemoryEnabled, enableStreaming: settings.enableStreaming };
      });
      attempt.effectiveSettings = effectiveSettings;
      await saveAttempt(attempt);
      expect(effectiveSettings).toEqual({ workingMode: "custom", outputProfile: "chat_first",
        researchMemoryEnabled: true, enableStreaming: false });
    }
    await harness.page.evaluate(({ fixtureId }) => {
      const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
      const original = plugin.createToolExecutionContext;
      const createRegistry = plugin.createToolRegistry;
      (window as any).__offlineMemoryAuthority = [];
      plugin.createToolRegistry = function (...args: any[]) {
        const registry = createRegistry.apply(this, args);
        const executePrepared = registry.executePrepared.bind(registry);
        registry.executePrepared = async (action: any, context: any, authority: any) => {
          const result = await executePrepared(action, context, authority);
          if (action.toolName === "append_research_memory") (window as any).__offlineMemoryAuthority.push({
            ok: result.ok, mutationState: result.mutationState, nodeId: context.nodeId,
            actionId: action.id, actionFingerprint: action.payloadFingerprint,
            authorityFingerprint: authority?.payloadFingerprint, grantId: authority?.grantId,
            receipt: result.receipt,
          });
          return result;
        };
        return registry;
      };
      const urls = [`https://one.example/mcp/${fixtureId}`, `https://two.example/mcp/${fixtureId}`];
      const content = "MCP servers expose tools and resources through a standard protocol. Clients discover the approved server capabilities.";
      const alternateContent = "Clients discover the approved server capabilities. MCP servers expose tools and resources through a standard protocol. Discovery lets clients inspect available capabilities before invoking them.";
      plugin.createToolExecutionContext = function (...args: any[]) {
        const context = original.apply(this, args);
        const transport = context.httpTransport;
        context.httpTransport = async (request: any) => {
          if (request.url.endsWith("/web_search")) return {
            status: 200, headers: {}, json: { results: urls.map((url) => ({ url, title: "MCP capabilities", snippet: content })) },
          };
          if (request.url.endsWith("/web_fetch")) {
            const url = JSON.parse(String(request.body)).url;
            if (!urls.includes(url)) throw new Error("Unowned citation fixture URL.");
            return { status: 200, headers: {}, json: { url, title: "MCP capabilities", content: url === urls[0] ? content : alternateContent, links: [] } };
          }
          return transport(request);
        };
        return context;
      };
    }, { fixtureId: attempt.attemptId });
    const marker = `${scenario.markerPrefix}_${attempt.attemptId.replace(/-/gu, "")}`;
    const prompt = scenario.prompt.replace("{marker}", marker);
    await harness.submitMission(memoryEnabled
      ? `${prompt.replace("Answer in chat", "Summarize the sources")} OFFLINE_MEMORY_SAVE`
      : prompt, { timeoutMs: 120_000 });
    const snapshot = await harness.attestProductionRun();
    const traceProof = await harness.page.evaluate(() => {
      const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
      const traces: any[] = [];
      const unsubscribe = plugin.subscribeMissionEvents({ onTrace: (event: any) => traces.push(event) }, { replay: true });
      unsubscribe();
      return {
        errors: Array.from(document.querySelectorAll(".agentic-researcher-log-error .agentic-researcher-log-message"))
          .map((element) => element.textContent ?? "").slice(-8),
        rejected: traces.find((event) => /^final-output-rejected-/u.test(event.id))?.outputPreview,
        admitted: traces.some((event) => /^citation-repair-candidate-admitted-/u.test(event.id)),
        decisions: traces.filter((event) => /^(?:final-output-rejected-|citation-repair-candidate-|agent-step-response-|loop-decision-)/u.test(event.id))
          .map((event) => ({ id: event.id, step: event.step, message: event.message, outputPreview: event.outputPreview })).slice(-20),
      };
    });
    // Keep observed product acceptance and the draft sequence even when a
    // later harness assertion fails; the attempt itself still remains failed.
    Object.assign(attempt, {
      acceptanceStatus: snapshot.lastMissionLedger?.acceptance?.status ?? null,
      scorecardAcceptancePassed: snapshot.lastMissionScorecard?.acceptancePassed ?? null,
      lastComplete: snapshot.lastComplete, acceptance: snapshot.lastMissionLedger?.acceptance,
      memoryProof: await harness.page.evaluate(() => (window as any).__offlineMemoryAuthority ?? []),
      traceProof, backend: backend.snapshot(),
      ...await readOfflineToolCounts(harness.page),
    });
    await saveAttempt(attempt);
    if (memoryEnabled) expect(["final", "write_completed"]).toContain(snapshot.lastComplete?.stopReason);
    else expect(snapshot.lastComplete?.stopReason).toBe("final");
    expect(snapshot.lastMissionLedger?.acceptance?.status).toBe("pass");
    expect(snapshot.lastMissionScorecard?.acceptancePassed).toBe(true);
    const memoryProof = await harness.page.evaluate(() => (window as any).__offlineMemoryAuthority ?? []);
    attempt.memoryProof = memoryProof;
    await saveAttempt(attempt);
    if (memoryEnabled) {
      expect(memoryProof).toHaveLength(1);
      expect(memoryProof[0].ok).toBe(true);
      expect(memoryProof[0].mutationState).toBe("applied");
      expect(memoryProof[0].nodeId).toMatch(/^post-acceptance-tool-\d+-append_research_memory$/u);
      expect(memoryProof[0].grantId).toMatch(/^grant:write-autonomy:/u);
      expect(memoryProof[0].receipt.actionId).toBe(memoryProof[0].actionId);
      expect(memoryProof[0].receipt.payloadFingerprint).toBe(memoryProof[0].actionFingerprint);
      expect(memoryProof[0].authorityFingerprint).toBe(memoryProof[0].actionFingerprint);
      expect(memoryProof[0].receipt.readback.status).toBe("verified");
      expect(snapshot.lastReceipts.filter((receipt: any) => receipt.toolName === "append_research_memory")).toHaveLength(1);
      expect(harness.readProgressCounters().approvals).toBe(0);
      const memoryContent = await harness.page.evaluate(async (path) => {
        const app = (window as any).app;
        return app.vault.read(app.vault.getFileByPath(path));
      }, memoryProof[0].receipt.resource.path);
      expect(memoryContent).toContain("MCP servers");
    } else expect(snapshot.lastReceipts).toEqual([]);
    expect(cloudModelRequests).toEqual([]);
    if (!memoryEnabled) {
      expect(backend.snapshot().citationRepair).toEqual({ unverifiedDrafts: 1, correctedDrafts: 1 });
      expect(backend.snapshot().citationCriticReviews).toBe(1);
    }
    expect(await harness.readNote()).toBe("Preserve this note during cited chat.");
    expect(traceProof.rejected?.candidateExcerpt).toContain("MCP servers expose tools");
    expect(traceProof.rejected?.missing.length).toBeGreaterThan(0);
    expect(traceProof.rejected?.candidateExcerpt).toContain("[unverified — no cited source passage confirms this]");
    expect(traceProof.rejected?.missing.some((key: string) => key.includes("claim:s-15fb002f52"))).toBe(false);
    if (!memoryEnabled) expect(traceProof.admitted).toBe(true);
    Object.assign(attempt, {
      status: "passed", acceptanceStatus: "pass", scorecardAcceptancePassed: true,
      failureClass: "none", failureDetail: "", model: "offline-scripted-v1",
      ...await readOfflineToolCounts(harness.page), traceProof,
      backend: backend.snapshot(), cloudRequestCount: cloudModelRequests.length,
      scorecardTotal: snapshot.lastMissionScorecard.total,
      scorecardDimensions: snapshot.lastMissionScorecard.dimensions.map((dimension: any) => ({ id: dimension.id, score: dimension.score })),
      artifactReadbacks: ["note_unchanged", "rejected_draft_retained", "corrected_draft_verified"],
      safetyViolationCount: 0, duplicateMutationCount: 0,
      mutationsPerformed: memoryProof.length, mutationsWithReceipts: memoryProof.length, mutationEventsObserved: memoryProof.length,
      modelCalls: backend.snapshot().requestCount, providerWaitMs: 0,
    });
  } catch (error) {
    attempt.failureDetail = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    attempt.durationMs = Date.now() - startedAt;
    if (harness) Object.assign(attempt, await readOfflineToolCounts(harness.page));
    await saveAttempt(attempt);
    try { await harness?.close(); } finally { await close(bridge); }
  }
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
  let attempt: Record<string, unknown> = beginOfflineAttempt(input.identity, input.scenario.id);
  await saveOfflineAttempt(attempt);
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
    await observeOfflineTools(harness.page);
    const marker = `${input.scenario.markerPrefix}_${harness.marker.replace(/[^A-Z0-9_]/giu, "_").toUpperCase()}`;
    const original = `# Original\n\nKEEP_UNTIL_REPLACE_${harness.marker}\n`;
    await harness.seedNote(harness.notePath, original, true);
    await harness.submitMission(renderOfflineExpandPrompt(input.scenario, marker), {
      timeoutMs: 120_000,
      waitForCompletion: false,
    });
    if (input.scenario.requiresBackup) await harness.approveUntilMissionComplete(180_000);
    else await harness.waitForMissionComplete(120_000);

    const snapshot = await harness.attestProductionRun();
    const receipts = Array.isArray(snapshot.lastReceipts) ? snapshot.lastReceipts : [];
    const renamed = receipts.find((receipt: any) => receipt.toolName === "rename_current_file");
    const outputPath = renamed?.toPath ?? harness.notePath;
    if (input.scenario.id === "title_rename_plus_body") {
      expect(typeof renamed?.toPath, JSON.stringify(receipts)).toBe("string");
      expect(path.posix.dirname(outputPath)).toBe(path.posix.dirname(harness.notePath));
      expect(path.posix.basename(outputPath)).toBe("Offline Title Brief.md");
    }
    const after = await harness.page.evaluate(async (notePath) => {
      const app = (window as any).app;
      const file = app.vault.getFileByPath(notePath);
      if (!file) throw new Error(`Verified output note missing: ${notePath}`);
      return app.vault.read(file);
    }, outputPath);
    expect(after.includes(marker), after).toBe(true);
    if (input.scenario.expectedMutation === "replace") {
      expect(after.includes(`KEEP_UNTIL_REPLACE_${harness.marker}`)).toBe(false);
    }

    const ledger = assertCompletedLedgerAcceptance(snapshot);
    const counts = await readOfflineToolCounts(harness.page);
    const scorecard = snapshot.lastMissionScorecard;
    if (input.scenario.requiresBackup) {
      expect(
        receipts.some((receipt: { backupPath?: string }) =>
          typeof receipt.backupPath === "string" &&
          receipt.backupPath.startsWith(".agent-backups/"),
        ),
        JSON.stringify(receipts),
      ).toBe(true);
    }

    attempt = input.validateOfflineApplicationAttempt({
      ...attempt,
      version: 1,
      scenarioId: input.scenario.id,
      repetition: 1,
      ...input.identity,
      status: "passed",
      acceptanceStatus: "pass",
      scorecardAcceptancePassed: scorecard?.acceptancePassed === true,
      scorecardTotal: typeof scorecard?.total === "number" ? scorecard.total : null,
      scorecardDimensions: (scorecard?.dimensions ?? []).map((dimension: any) => ({ id: dimension.id, score: dimension.score })),
      artifactReadbacks: [
        `note:${outputPath}:${marker}`,
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
      ...counts,
      modelCalls: Math.max(0, input.backend.snapshot().requestCount - modelCallsBefore),
      providerWaitMs: 0,
      durationMs: Date.now() - startedAt,
    });
    return attempt;
  } catch (error) {
    attempt.failureDetail = error instanceof Error ? error.message : String(error);
    await saveOfflineAttempt(attempt);
    if (harness) {
      const partial = await boundedOfflineRead(harness.attestProductionRun());
      if (partial) attempt.partialRun = partial;
    }
    throw error;
  } finally {
    attempt.durationMs = Date.now() - startedAt;
    attempt.modelCalls = Math.max(0, input.backend.snapshot().requestCount - modelCallsBefore);
    attempt.cloudRequestCount = input.cloudModelRequests.length;
    if (harness) {
      Object.assign(attempt, await readOfflineToolCounts(harness.page));
      await boundedOfflineRead(harness.page.evaluate(() => { (window as any).__offlineUnsubscribe?.(); }));
    }
    await saveOfflineAttempt(attempt);
    await harness?.close();
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

/**
 * Import a self-contained ESM module without Playwright's loader rewriting it.
 *
 * Playwright transforms every project file whose extension it owns, `.mjs`
 * included, and hands Node CommonJS output. Node still treats a `.mjs` URL as
 * ESM, so the transformed body throws `exports is not defined in ES module
 * scope` before a single export is read -- which is why this lane could never
 * start. A `data:` URL carries no file path for the loader to match, so the
 * original source is evaluated as written.
 *
 * Only safe for modules with no imports and no `import.meta`: a data: URL has
 * no base to resolve either against. `offline-application-attempt.mjs`
 * qualifies; `agent-bridge.mjs` does not, and keeps importNativeEsm.
 */
async function importIsolatedEsm<T>(filePath: string): Promise<T> {
  const source = await readFile(filePath, "utf8");
  return importNativeEsm<T>(
    `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`,
  );
}
