import { expect, test } from "@playwright/test";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createOfflineAgentBackendV1, OFFLINE_CONTRADICTED_CLAIM_V1 } from "./offlineAgentBackend";
import {
  OFFLINE_DECISION_TOKEN_V1,
  startOfflineDecisionServerV1,
  type OfflineDecisionScriptV1,
  type OfflineDecisionServerV1,
} from "./offlineDecisionServer";
import { startRealAiHarness } from "./realAiHarness";
import {
  beginOfflineAttempt,
  observeOfflineTools,
  readOfflineBuildIdentity,
  readOfflineToolCounts,
  saveOfflineProbe,
} from "./offlineEvidence";

/*
 * Jev decisions in the installed plugin, zero-cloud. The model is the offline
 * agent bridge on 7331; the decision model is a loopback stand-in for
 * OpenRouter's alpha decisions endpoint, reached through the plugin's own
 * transport by `decisionEndpointOverride`; web search and fetch are served
 * inside the page. The harness promotion seam lets Enabled act; without it
 * both components would run in Shadow.
 *
 * Non-gating: every journey is recorded as a probe under
 * docs/eval/offline-attempt-history, never as a required offline scenario.
 */

const OFFLINE_BASE_URL = "http://127.0.0.1:7331/v1";
const OFFLINE_TOKEN = "offline-e2e-ephemeral-token";
const DECISION_PORT = 7333;

const MCP_PASSAGES = [
  "MCP servers expose tools and resources through a standard protocol.",
  "Clients discover the approved server capabilities.",
];
const ROME_PASSAGES = [
  "Economic strain from debasement of the currency weakened the late empire.",
  "The Western Roman Empire ended in 476 when Odoacer deposed Romulus Augustulus.",
];

const judgeProprietary: OfflineDecisionScriptV1["claim"] = (text) =>
  /proprietary closed/u.test(text)
    ? { verdict: "contradicted", probability: 0.97 }
    : { verdict: "supported", probability: 0.95 };

interface JourneyResult {
  note: string;
  chat: string[];
  traces: Array<{ id: string; kind: string; message: string; outputPreview: any }>;
  ledger: any;
  receipts: string[];
  stopReason: string | null;
  backend: ReturnType<ReturnType<typeof createOfflineAgentBackendV1>["snapshot"]>;
  decisionRequests: OfflineDecisionServerV1["requests"];
  cloudRequests: string[];
}

async function runJevJourney(input: {
  label: string;
  scenarioId: string;
  decisionMode: "off" | "shadow" | "enabled";
  script: OfflineDecisionScriptV1;
  prompt: (marker: string) => string;
  markerPrefix: string;
  passages: string[];
  seedNote: string;
}): Promise<JourneyResult> {
  const backend = createOfflineAgentBackendV1();
  const { createAgentBridgeServer } = await importNativeEsm<{
    createAgentBridgeServer(options: { token: string; backend: typeof backend }): Server;
  }>(pathToFileURL(path.resolve("scripts", "agent-bridge.mjs")).href);
  const bridge = createAgentBridgeServer({ token: OFFLINE_TOKEN, backend });
  const decisions = await startOfflineDecisionServerV1(DECISION_PORT);
  decisions.script(input.script);
  const identity = await readOfflineBuildIdentity();
  const attempt = beginOfflineAttempt(identity, input.scenarioId);
  const startedAt = Date.now();
  const cloudRequests: string[] = [];
  let harness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
  await saveOfflineProbe(attempt);
  try {
    await listen(bridge, 7331);
    harness = await startRealAiHarness(input.label, {
      baseUrl: OFFLINE_BASE_URL,
      model: "offline-scripted-v1",
      missionTimeoutMs: 180_000,
      firstChunkTimeoutMs: 30_000,
      completionTimeoutMs: 180_000,
    }, {
      modelRouterEnabled: false,
      modelRouterMode: "off",
      semanticIndexEnabled: false,
      researchMemoryEnabled: false,
      enableStreaming: false,
      maxAgentSteps: 8,
      decisionModelMode: input.decisionMode,
      decisionEndpointOverride: decisions.url,
      decisionE2EHarnessPromotion: true,
      // Plaintext here is migrated into SecretStorage on load; teardown
      // discards the reference the lane created.
      decisionApiKey: OFFLINE_DECISION_TOKEN_V1,
    });
    harness.page.on("request", (request) => {
      if (/^https?:\/\/(?:[^/]*\.)?(?:openrouter\.ai|ollama\.com|api\.openai\.com)\//u.test(request.url())) {
        cloudRequests.push(request.url());
      }
    });
    await observeOfflineTools(harness.page);
    await harness.seedNote(harness.notePath, input.seedNote, true);
    const settingsState = await harness.page.evaluate(() => {
      const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
      return {
        mode: plugin.settings.decisionModelMode,
        endpoint: plugin.settings.decisionEndpointOverride,
        hasKey: Boolean(plugin.settings.decisionApiKey),
      };
    });
    expect(settingsState).toEqual({ mode: input.decisionMode, endpoint: decisions.url, hasKey: true });
    await harness.page.evaluate(({ fixtureId, passages }) => {
      const plugin = (window as any).app.plugins.plugins["agentic-researcher"];
      const original = plugin.createToolExecutionContext;
      const urls = [`https://one.example/jev/${fixtureId}`, `https://two.example/jev/${fixtureId}`];
      plugin.createToolExecutionContext = function (...args: any[]) {
        const context = original.apply(this, args);
        const transport = context.httpTransport;
        context.httpTransport = async (request: any) => {
          if (request.url.endsWith("/web_search")) {
            return {
              status: 200,
              headers: {},
              json: { results: urls.map((url, index) => ({ url, title: `Source ${index + 1}`, snippet: passages[index] })) },
            };
          }
          if (request.url.endsWith("/web_fetch")) {
            const url = JSON.parse(String(request.body)).url;
            const index = urls.indexOf(url);
            if (index < 0) throw new Error("Unowned Jev fixture URL.");
            return { status: 200, headers: {}, json: { url, title: `Source ${index + 1}`, content: passages[index], links: [] } };
          }
          if (urls.some((url) => request.url.startsWith(url))) return { status: 200, headers: {} };
          return transport(request);
        };
        return context;
      };
    }, { fixtureId: attempt.attemptId, passages: input.passages });

    const marker = `${input.markerPrefix}_${attempt.attemptId.replace(/-/gu, "")}`;
    await harness.submitMission(input.prompt(marker), { timeoutMs: 180_000 });
    const observed = await harness.page.evaluate(async () => {
      const app = (window as any).app;
      const plugin = app.plugins.plugins["agentic-researcher"];
      const traces: any[] = [];
      const unsubscribe = plugin.subscribeMissionEvents({ onTrace: (event: any) => traces.push(event) }, { replay: true });
      unsubscribe();
      const snapshot = plugin.getMissionRunSnapshot?.() ?? null;
      const runId = typeof snapshot?.runId === "string" ? snapshot.runId : "";
      const safeRunId = runId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "run";
      const markdown = runId ? await app.vault.adapter.read(`Agent Runs/${safeRunId}.md`).catch(() => "") : "";
      const match = /## Mission Ledger\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
      return {
        traces: traces.map((event) => ({ id: String(event.id ?? ""), kind: String(event.kind ?? ""), message: String(event.message ?? ""), outputPreview: event.outputPreview ?? null })),
        ledger: match ? JSON.parse(match[1]) : null,
        receipts: (snapshot?.lastReceipts ?? []).map((receipt: any) => String(receipt.toolName ?? "")),
        stopReason: snapshot?.lastComplete?.stopReason ?? null,
        chat: Array.from(document.querySelectorAll(".agentic-researcher-log-assistant .agentic-researcher-log-message"))
          .map((element) => element.textContent ?? "").slice(-4),
      };
    });
    const result: JourneyResult = {
      note: await harness.readNote(),
      chat: observed.chat,
      traces: observed.traces,
      ledger: observed.ledger,
      receipts: observed.receipts,
      stopReason: observed.stopReason,
      backend: backend.snapshot(),
      decisionRequests: [...decisions.requests],
      cloudRequests,
    };
    Object.assign(attempt, {
      status: "observed",
      failureClass: "none",
      failureDetail: "",
      stopReason: result.stopReason,
      receipts: result.receipts,
      decisionRequests: result.decisionRequests.map((request) => ({ kind: request.kind, authorized: request.authorized })),
      decisionTraces: result.traces
        .filter((event) => /^(?:decision-|claim-support-)/u.test(event.id))
        .map((event) => ({ id: event.id, message: event.message })),
      claimSupport: result.ledger?.decisions?.claimSupport ?? null,
      decisionRecords: result.ledger?.decisions?.records ?? [],
      backend: result.backend,
      cloudRequestCount: cloudRequests.length,
      ...await readOfflineToolCounts(harness.page),
    });
    return result;
  } catch (error) {
    attempt.failureDetail = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    attempt.durationMs = Date.now() - startedAt;
    await saveOfflineProbe(attempt);
    try {
      await harness?.close();
    } finally {
      await close(bridge);
      await decisions.close();
    }
  }
}

function claimTraces(result: JourneyResult) {
  return result.traces.filter((event) => event.id.startsWith("claim-support-"));
}

const claimPrompt = (marker: string) =>
  `Research MCP servers on the web using two sources and append a concise summary with passage citations to this note. ${marker}`;

test.describe("zero-cloud Jev decisions", () => {
  test.skip(
    process.env.E2E_PLAYWRIGHT_LANE !== "offline-expand" || process.env.E2E_OFFLINE_AI !== "1",
    "Run through npm run test:e2e:exclusive -- --offline-ai --project=offline-expand.",
  );

  test("JEV-01 a paraphrased evidence request reaches tool exposure, research, and writeback only when Enabled", async () => {
    test.setTimeout(600_000);
    const routePrompt = (marker: string) =>
      `Write a short note on why the Roman Empire fell, and back every claim up with what's out there. ${marker}`;
    const off = await runJevJourney({
      label: "jev-route-off",
      scenarioId: "jev-routing-off",
      decisionMode: "off",
      script: { mission: "web_evidence", claim: () => ({ verdict: "supported", probability: 0.95 }) },
      prompt: routePrompt,
      markerPrefix: "OFFLINE_JEVROUTE",
      passages: ROME_PASSAGES,
      seedNote: "Rome note.",
    });
    // Today's path: the wording names no evidence, so nothing asks for it.
    expect(off.decisionRequests).toEqual([]);
    expect(off.backend.offeredToolNames).not.toContain("web_search");
    expect(off.note).toContain("The Roman Empire fell for many reasons");

    const enabled = await runJevJourney({
      label: "jev-route-enabled",
      scenarioId: "jev-routing-enabled",
      decisionMode: "enabled",
      script: { mission: "web_evidence", claim: () => ({ verdict: "supported", probability: 0.95 }) },
      prompt: routePrompt,
      markerPrefix: "OFFLINE_JEVROUTE",
      passages: ROME_PASSAGES,
      seedNote: "Rome note.",
    });
    const missionRequests = enabled.decisionRequests.filter((request) => request.kind === "mission");
    expect(missionRequests).toHaveLength(1);
    expect(missionRequests[0]!.authorized).toBe(true);
    expect(missionRequests[0]!.body.model).toBe("typesafe/jev-1.13");
    expect(enabled.traces.some((event) => /Jev found a request for web evidence the wording did not name/u.test(event.message))).toBe(true);
    expect(enabled.backend.offeredToolNames).toContain("web_search");
    expect(enabled.note).not.toContain("The Roman Empire fell for many reasons");
    expect(enabled.note).toContain("Economic strain from debasement weakened the late empire");
    expect(enabled.receipts).toContain("append_to_current_file");
    const records = enabled.ledger?.decisions?.records ?? [];
    expect(records.some((record: any) => record.component === "mission_routing" && record.outcome === "answered")).toBe(true);
    expect(enabled.cloudRequests).toEqual([]);
  });

  test("JEV-02 a contradicted claim is repaired once, rechecked, and written with its receipt", async () => {
    test.setTimeout(600_000);
    const result = await runJevJourney({
      label: "jev-claim-fix",
      scenarioId: "jev-claim-repaired",
      decisionMode: "enabled",
      script: { mission: "abstain", claim: judgeProprietary },
      prompt: claimPrompt,
      markerPrefix: "OFFLINE_CLAIMCHECK_FIX",
      passages: MCP_PASSAGES,
      seedNote: "MCP note.",
    });
    const rounds = claimTraces(result).filter((event) => /:round-\d+$/u.test(event.id));
    expect(rounds.map((event) => event.outputPreview?.action)).toEqual(["repair", "accept"]);
    expect(result.backend.claimCheck?.repairs).toBe(1);
    expect(result.note).toContain("MCP servers expose tools and resources through a standard protocol");
    expect(result.note).not.toContain("proprietary closed protocol");
    expect(result.note).toContain("Clients discover the approved server capabilities");
    expect(result.receipts).toContain("append_to_current_file");
    expect(result.decisionRequests.filter((request) => request.kind === "claims").length).toBeGreaterThanOrEqual(2);
    const claimSupport = result.ledger?.decisions?.claimSupport;
    expect(claimSupport?.repairsUsed).toBe(1);
    expect(claimSupport?.heldCandidate ?? null).toBeNull();
    expect(result.cloudRequests).toEqual([]);
  });

  test("JEV-03 a claim the repair did not fix holds the draft: no write, a short blocker, the draft on the record", async () => {
    test.setTimeout(600_000);
    const result = await runJevJourney({
      label: "jev-claim-hold",
      scenarioId: "jev-claim-held",
      decisionMode: "enabled",
      script: { mission: "abstain", claim: judgeProprietary },
      prompt: claimPrompt,
      markerPrefix: "OFFLINE_CLAIMCHECK_HOLD",
      passages: MCP_PASSAGES,
      seedNote: "MCP note.",
    });
    expect(result.note).toBe("MCP note.");
    expect(result.receipts).not.toContain("append_to_current_file");
    expect(result.backend.claimCheck?.repairs).toBe(1);
    expect(claimTraces(result).some((event) => event.id.endsWith(":held"))).toBe(true);
    const chat = result.chat.join("\n");
    expect(chat).toContain("Held the draft: 1 claim contradicts its cited source");
    expect(chat).toContain("The note is unchanged.");
    expect(chat).not.toMatch(/source:[a-z0-9]+:passage/u);
    const claimSupport = result.ledger?.decisions?.claimSupport;
    expect(claimSupport?.heldCandidate?.text ?? "").toContain(OFFLINE_CONTRADICTED_CLAIM_V1);
    expect(claimSupport?.repairsUsed).toBe(1);
    expect(claimSupport?.rejections?.[0]?.verdict).toBe("contradicted");
    expect(result.cloudRequests).toEqual([]);
  });

  test("JEV-04 a decision outage is recorded and the existing verification decides", async () => {
    test.setTimeout(600_000);
    const result = await runJevJourney({
      label: "jev-outage",
      scenarioId: "jev-decision-outage",
      decisionMode: "enabled",
      script: { mission: "outage", claim: () => "outage" },
      prompt: claimPrompt,
      markerPrefix: "OFFLINE_CLAIMCHECK_OUTAGE",
      passages: MCP_PASSAGES,
      seedNote: "MCP note.",
    });
    // The draft passed deterministic verification; an unreachable decision
    // model neither blocks it nor pretends to have checked it.
    expect(result.note).toContain(OFFLINE_CONTRADICTED_CLAIM_V1);
    expect(result.receipts).toContain("append_to_current_file");
    expect(claimTraces(result).some((event) => event.id.endsWith(":held"))).toBe(false);
    const unavailable = result.traces.filter((event) => /^decision-call-/u.test(event.id) && /unavailable: provider_unavailable/u.test(event.message));
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect(result.traces.some((event) => event.kind === "tool_result" && /decision/u.test(event.message) && /fail/u.test(event.message))).toBe(false);
    const skipped = result.ledger?.decisions?.claimSupport?.skipped ?? [];
    expect(skipped.length + unavailable.length).toBeGreaterThanOrEqual(1);
    expect(result.cloudRequests).toEqual([]);
  });
});

function importNativeEsm<T>(specifier: string): Promise<T> {
  const importer = new Function("value", "return import(value);") as (value: string) => Promise<T>;
  return importer(specifier);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
