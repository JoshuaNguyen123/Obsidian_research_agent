// COMP-4: a browser ask completes through its planned page open (a scripted model, a stubbed companion service, no real browser).
//
// browserMissionPlan.test.ts reads the planned graph; this runs the mission through it: the model opens the page, reads its text and
// answers, and the run ends `final` without a web search or fetch owed (the page's text pays the evidence its address implies). The
// companion service is a `fetch` stub behind a real bootstrap credential, so the core's own client, safety policy and attestation run.
// The ask names no note: a prompt that says "the page" and "the heading" is also read as a note title ask, which is a separate gap.
import assert from "node:assert/strict";
import test from "node:test";

import { runAgentMission } from "../src/AgentRunner";
import { ApprovalBroker } from "../src/agent/approvalBroker";
import { createSessionBootstrapTokenLeaseV1 } from "../packages/headless-runtime/src/backgroundContinuation";
import { installCompanionBootstrapSessionV1 } from "../packages/headless-runtime/src/companionCredentialSession";
import type { ModelChatRequest, ModelChatResponse, ModelClient } from "../src/model/types";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { createVaultContext, withOpenPageAsRead } from "./helpers/browserMissionHarness";

const BASE_URL = "http://127.0.0.1:8765";
const ASK = "Open https://example.com/ in the browser and read what it says.";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;

interface Outcome {
  tools: string[];
  companionCalls: string[];
  approvals: string[];
  stopReason: string | undefined;
  finalText: string;
}

async function runBrowserMission(options: { openAsRead: boolean }): Promise<Outcome> {
  const uninstall = installCompanionBootstrapSessionV1({
    version: 1,
    baseUrl: BASE_URL,
    credential: createSessionBootstrapTokenLeaseV1("t".repeat(32)),
    connectedAt: new Date(0).toISOString(),
  });
  const realFetch = globalThis.fetch;
  const companionCalls: string[] = [];
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    companionCalls.push(path);
    if (path === "/health") return reply({ ok: true, service: "companion", browserReady: true, memoryReady: true });
    if (path === "/browser/open" || path === "/browser/observe") {
      return reply({ url: "https://example.com/", title: "Example Domain", visibleText: "Example Domain", visibleTextSummary: "Example Domain", screenshotPath: "", candidates: [], pageStateHints: [], observedAt: new Date(0).toISOString(), observationFingerprint: FINGERPRINT });
    }
    if (path === "/browser/extract_markdown") {
      return reply({ url: "https://example.com/", title: "Example Domain", markdown: "# Example Domain\n\nThis domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission." });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const registry = createDefaultToolRegistry({ optionalCapabilities: { code: false, integrations: false, companion: true } });
  const broker = new ApprovalBroker();
  const approvals: string[] = [];
  const tools: string[] = [];
  let agentSteps = 0;
  let stopReason: string | undefined;
  let finalText = "";
  const respond = async (request: ModelChatRequest): Promise<ModelChatResponse> => {
    if (request.format) return { message: { role: "assistant", content: "{}" }, toolCalls: [] };
    agentSteps += 1;
    if (agentSteps === 1) {
      return { message: { role: "assistant", content: "" }, toolCalls: [{ id: "open-1", name: "browser_open_page", arguments: { url: "https://example.com/" } }] };
    }
    if (agentSteps === 2) {
      return { message: { role: "assistant", content: "" }, toolCalls: [{ id: "read-1", name: "browser_extract_markdown", arguments: {} }] };
    }
    return { message: { role: "assistant", content: "The page's heading is Example Domain." }, toolCalls: [] };
  };
  const model: ModelClient = { chat: respond, streamChat: respond } as ModelClient;
  try {
    await runAgentMission({
      prompt: ASK,
      modelClient: model,
      toolRegistry: options.openAsRead ? withOpenPageAsRead(registry) : registry,
      toolContext: createVaultContext({ note: false, browserToolsEnabled: true }),
      enableStreaming: false,
      maxSteps: 12,
      approvalBroker: broker,
      events: {
        onApprovalRequest: (request) => { approvals.push(request.toolName); broker.resolve(request.id, "approved"); },
        onToolDone: (event) => { if (event.name) tools.push(event.name); },
        onAssistantDelta: (delta) => { finalText += delta; },
        onFinalDelta: (delta) => { finalText += delta; },
        onRunComplete: (event) => { stopReason = event.stopReason; },
      },
    });
  } finally {
    globalThis.fetch = realFetch;
    uninstall();
  }
  return { tools, companionCalls, approvals, stopReason, finalText };
}

test("a browser ask opens its page, reads it and ends final, with the core's own descriptor for the open", async () => {
  const outcome = await runBrowserMission({ openAsRead: false });
  assert.deepEqual(outcome.tools.filter((name) => name.startsWith("browser_")), ["browser_open_page", "browser_extract_markdown"], JSON.stringify(outcome));
  assert.ok(outcome.companionCalls.includes("/browser/open"), JSON.stringify(outcome));
  assert.equal(outcome.tools.includes("web_search") || outcome.tools.includes("web_fetch"), false, JSON.stringify(outcome));
  assert.equal(outcome.stopReason, "final", JSON.stringify(outcome));
  assert.ok(outcome.finalText.includes("Example Domain"), JSON.stringify(outcome));
});

test("the same ask ends the same way when the host reports the open as a read", async () => {
  const outcome = await runBrowserMission({ openAsRead: true });
  assert.deepEqual(outcome.tools.filter((name) => name.startsWith("browser_")), ["browser_open_page", "browser_extract_markdown"], JSON.stringify(outcome));
  assert.equal(outcome.approvals.includes("browser_open_page"), false, JSON.stringify(outcome));
  assert.equal(outcome.tools.includes("web_search") || outcome.tools.includes("web_fetch"), false, JSON.stringify(outcome));
  assert.equal(outcome.stopReason, "final", JSON.stringify(outcome));
  assert.ok(outcome.finalText.includes("Example Domain"), JSON.stringify(outcome));
});
