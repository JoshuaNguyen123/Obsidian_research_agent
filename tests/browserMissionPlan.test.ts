// COMP-4: a browser ask plans its own page open.
//
// `browser_open_page` is an execution-effect tool (action "execute"), and the mission graph only holds the tool nodes the host plans:
// the web ladder for a web-evidence ask, the note nodes for a note-output ask, and `selectExplicitEffectfulGraphTools`, which plans an
// effectful tool only when every token of its descriptor's action is in the prompt. So an ask to open a page and read it planned
// `web_search` + `web_fetch` and never the open, and the frontier (ready nodes plus read-effect envelope tools) offered
// `browser_observe` / `browser_extract_markdown` on a blank page. These tests read the planned graph the real runner builds.
import assert from "node:assert/strict";
import test from "node:test";

import { runAgentMission } from "../src/AgentRunner";
import { plannedBrowserNavigationToolNamesV1 } from "../src/agent/browserMissionPlan";
import type { ModelChatRequest, ModelChatResponse, ModelClient } from "../src/model/types";
import { canonicalMissionGraphId } from "../src/agent/missionGraphIds";
import { readMissionGraphStoreRecord } from "../src/agent/missionGraphStore";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { ToolExecutionContext } from "../src/tools/types";
import { createVaultContext, withOpenPageAsRead } from "./helpers/browserMissionHarness";

const OWNER_ASK =
  "Use the browser to open the page https://example.com/ and tell me the heading shown on it. Only look at the page: do not follow links or enter anything.";
const GOLDEN_ASK = "Open https://example.com in the browser and observe it.";

interface PlannedGraph {
  nodeIds: string[];
  /** Each planned node's prerequisites, read back from the persisted graph. */
  dependencies: Record<string, string[]>;
  frontier: string[];
  allowedToolNames: string[];
  stopped: string | null;
}

/** Runs the real runner for one step over the real registry (browser tools on) and reads the graph it planned. */
async function plan(prompt: string, options: { note?: boolean; registryEffects?: "read"; browserToolsEnabled?: boolean } = {}): Promise<PlannedGraph> {
  const registry = createDefaultToolRegistry({
    optionalCapabilities: { code: false, integrations: false, companion: true },
  });
  const requests: ModelChatRequest[] = [];
  const respond = async (request: ModelChatRequest): Promise<ModelChatResponse> => {
    requests.push(request);
    return { message: { role: "assistant", content: "Done." }, toolCalls: [] };
  };
  const model: ModelClient = { chat: respond, streamChat: respond } as ModelClient;
  const traces: Array<{ id: string; message?: string; outputPreview?: unknown }> = [];
  let allowedToolNames: string[] = [];
  let runId = "";
  let stopped: string | null = null;
  const toolContext = createVaultContext({ note: options.note === true, browserToolsEnabled: options.browserToolsEnabled ?? true });
  try {
    await runAgentMission({
      prompt,
      modelClient: model,
      toolRegistry: options.registryEffects === "read" ? withOpenPageAsRead(registry) : registry,
      toolContext,
      enableStreaming: false,
      maxSteps: 1,
      events: {
        onRunConfig: (event) => { allowedToolNames = [...event.allowedToolNames]; runId = event.runId; },
        onTrace: (event) => { traces.push({ id: event.id, message: event.message, outputPreview: event.outputPreview }); },
      },
    });
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
  }
  const record = runId ? await readMissionGraphStoreRecord(toolContext, canonicalMissionGraphId(runId)).catch(() => null) : null;
  const dependencies = Object.fromEntries(
    Object.entries((record as { record?: { graph?: { nodes?: Record<string, { dependencyIds?: string[] }> } } } | null)?.record?.graph?.nodes ?? {}).map(([id, node]) => [id, [...(node.dependencyIds ?? [])]]),
  );
  const authority = traces.find((trace) => trace.id === "mission-graph-authority");
  const nodeIds = ((authority?.outputPreview as { nodeIds?: string[] } | undefined)?.nodeIds ?? []).filter((id) => id !== "final");
  const frontier = (traces.find((trace) => trace.id === "mission-graph-tool-frontier-1")?.message ?? "")
    .replace("MissionGraph frontier tools: ", "").split(", ").filter(Boolean);
  return { nodeIds, dependencies, frontier, allowedToolNames, stopped };
}

const toolOf = (nodeId: string): string => nodeId.replace(/^tool-\d+-/u, "");

function assertOpensBeforeReads(graph: PlannedGraph, label: string): void {
  const tools = graph.nodeIds.map(toolOf);
  const open = tools.indexOf("browser_open_page");
  assert.ok(open >= 0, `${label}: a browser_open_page node is planned: ${JSON.stringify(graph.nodeIds)}`);
  for (const read of ["browser_extract_markdown", "browser_observe", "browser_screenshot"]) {
    const index = tools.indexOf(read);
    if (index >= 0) assert.ok(open < index, `${label}: the open comes before ${read}: ${JSON.stringify(graph.nodeIds)}`);
  }
  assert.equal(tools.includes("web_search"), false, `${label}: no web search ladder for a browser-only ask: ${JSON.stringify(graph.nodeIds)}`);
  assert.equal(tools.includes("web_fetch"), false, `${label}: no web fetch ladder for a browser-only ask: ${JSON.stringify(graph.nodeIds)}`);
}

test("the owner's ask plans the page open, then the page's text, with no web ladder", async () => {
  const graph = await plan(OWNER_ASK);
  assertOpensBeforeReads(graph, "no note open");
  assert.ok(graph.nodeIds.map(toolOf).includes("browser_extract_markdown"), `the page's text is planned: ${JSON.stringify(graph.nodeIds)}`);
});

test("the owner's ask with a note open plans the same page open", async () => {
  const graph = await plan(OWNER_ASK, { note: true });
  assertOpensBeforeReads(graph, "note open");
});

test("the core's golden browser ask plans the page open before the reads", async () => {
  const graph = await plan(GOLDEN_ASK);
  assertOpensBeforeReads(graph, "golden ask");
});

test("the page's text waits for the page open, whatever effect the registry reports for the open", async () => {
  // The desktop host reports the open as a read so it is reachable; two reads are not ordered by their effect, so the graph orders them.
  for (const effects of [undefined, "read" as const]) {
    const label = `registry effect ${effects ?? "execution"}`;
    const graph = await plan(GOLDEN_ASK, { registryEffects: effects });
    const open = graph.nodeIds.find((id) => toolOf(id) === "browser_open_page");
    const text = graph.nodeIds.find((id) => toolOf(id) === "browser_extract_markdown");
    assert.ok(open && text, `${label}: both are planned: ${JSON.stringify(graph.nodeIds)}`);
    assert.deepEqual(graph.dependencies[open!] ?? ["?"], [], `${label}: the open waits for nothing: ${JSON.stringify(graph.dependencies)}`);
    assert.ok((graph.dependencies[text!] ?? []).includes(open!), `${label}: the text waits for the open: ${JSON.stringify(graph.dependencies)}`);
    assert.ok(graph.frontier.includes("browser_open_page"), `${label}: the open is on the step-1 frontier: ${JSON.stringify(graph.frontier)}`);
  }
});

test("asks without a browser or without a page address keep their plan", async () => {
  // A web question with a URL but no browser words keeps the web ladder; a browser ask with no address has nothing to open.
  const web = await plan("Fetch https://example.com/ and summarize what it says, citing the source.");
  assert.equal(web.nodeIds.map(toolOf).includes("browser_open_page"), false, JSON.stringify(web.nodeIds));
  assert.ok(web.nodeIds.map(toolOf).includes("web_fetch"), JSON.stringify(web.nodeIds));
  const noAddress = await plan("Use the browser to look at the documentation site and tell me what it covers.");
  assert.equal(noAddress.nodeIds.map(toolOf).includes("browser_open_page"), false, JSON.stringify(noAddress.nodeIds));
  // An ask that also wants web research keeps its ladder beside the open.
  const both = await plan("Open https://example.com/ in the browser, then research the web for sources about it and cite them.");
  assert.ok(both.nodeIds.map(toolOf).includes("web_search"), JSON.stringify(both.nodeIds));
});

test("with browser tools off in settings an ask that mentions the browser keeps the web ladder it had", async () => {
  // The safety policy refuses every browser call while the setting is off, so planning an open there would strand the run.
  const graph = await plan(OWNER_ASK, { browserToolsEnabled: false });
  const tools = graph.nodeIds.map(toolOf);
  assert.equal(tools.includes("browser_open_page"), false, JSON.stringify(graph.nodeIds));
  assert.ok(tools.includes("web_fetch"), JSON.stringify(graph.nodeIds));
});

test("the planner names the open and the read for a browser ask with an address, and nothing else", () => {
  assert.deepEqual(plannedBrowserNavigationToolNamesV1(OWNER_ASK), ["browser_open_page", "browser_extract_markdown"]);
  assert.deepEqual(plannedBrowserNavigationToolNamesV1(GOLDEN_ASK), ["browser_open_page", "browser_extract_markdown"]);
  assert.deepEqual(plannedBrowserNavigationToolNamesV1("Fetch https://example.com/ and summarize it."), []);
  assert.deepEqual(plannedBrowserNavigationToolNamesV1("Use the browser to look at the docs site."), []);
  assert.deepEqual(plannedBrowserNavigationToolNamesV1("Do not use the web. Open https://example.com/ in the browser."), []);
});
